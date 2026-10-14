/**
 * D1 access.
 *
 * Two tables carry state:
 *   runs        — one row per session, pruned by the cron once its ET day is over
 *   scores      — every submitted entry, kept forever
 *   alltime_best— materialized best per name, kept in step with scores
 */

import type { LeaderboardEntry, LeaderboardView, RunState } from '../shared/protocol';
import type { DailyRow } from './daily';
import type { ResultRow } from './stats';
import { etDay } from './time';

/** Rows shown on either board. */
export const LEADERBOARD_LIMIT = 50;

export interface RunRow {
	id: string;
	day: string;
	phase: string;
	state: string;
	name: string | null;
}

export async function getRun(db: D1Database, id: string): Promise<RunRow | null> {
	return db
		.prepare('SELECT id, day, phase, state, name FROM runs WHERE id = ?1')
		.bind(id)
		.first<RunRow>();
}

export async function putRun(
	db: D1Database,
	row: { id: string; day: string; phase: string; state: RunState; name?: string | null }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO runs (id, day, phase, state, name, created_at, updated_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
			 ON CONFLICT(id) DO UPDATE SET
			   day = excluded.day,
			   phase = excluded.phase,
			   state = excluded.state,
			   name = COALESCE(excluded.name, runs.name),
			   updated_at = excluded.updated_at`
		)
		.bind(row.id, row.day, row.phase, JSON.stringify(row.state), row.name ?? null, Date.now())
		.run();
}

export async function deleteRun(db: D1Database, id: string): Promise<void> {
	await db.prepare('DELETE FROM runs WHERE id = ?1').bind(id).run();
}

/**
 * Housekeeping: drop runs whose ET day has ended.
 *
 * Nothing reads these — a run from a previous day is already void, since the
 * state is only served when its day matches today. They exist purely so a
 * refresh mid-run survives.
 */
export async function pruneStaleRuns(db: D1Database): Promise<number> {
	await db.prepare('DELETE FROM run_starts WHERE day < ?1').bind(etDay()).run();
	const result = await db
		.prepare('DELETE FROM runs WHERE day < ?1')
		.bind(etDay())
		.run();
	return result.meta.changes ?? 0;
}

// ---------------------------------------------------------------------------
// Run results — personal stats
// ---------------------------------------------------------------------------

/** Ranked runs read for one day's comparison. */
const DAILY_LIMIT = 5000;

/** Most recent finished runs read for a player's stats. */
const STATS_LIMIT = 1000;

export async function recordRunResult(
	db: D1Database,
	row: { sessionId: string; day: string; ranked: boolean; chips: number; bust: boolean; rounds: unknown }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO run_results (session_id, day, ranked, chips, bust, rounds, finished_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
		)
		.bind(row.sessionId, row.day, row.ranked ? 1 : 0, row.chips, row.bust ? 1 : 0, JSON.stringify(row.rounds), Date.now())
		.run();
}

/** Every ranked run finished on `day`, for the daily comparison. */
export async function getDailyResults(db: D1Database, day: string): Promise<DailyRow[]> {
	const { results } = await db
		.prepare(
			`SELECT session_id, chips, rounds FROM run_results
			 WHERE day = ?1 AND ranked = 1 ORDER BY finished_at LIMIT ?2`
		)
		.bind(day, DAILY_LIMIT)
		.all<DailyRow>();
	return results;
}

export async function getRunResults(db: D1Database, sessionId: string): Promise<ResultRow[]> {
	const { results } = await db
		.prepare(
			`SELECT day, ranked, chips, bust, rounds, finished_at FROM run_results
			 WHERE session_id = ?1 ORDER BY finished_at DESC LIMIT ?2`
		)
		.bind(sessionId, STATS_LIMIT)
		.all<ResultRow>();
	return results;
}

// ---------------------------------------------------------------------------
// Run starts — one ranked run per session per day
// ---------------------------------------------------------------------------

/** How many runs this session has started today. */
export async function startsToday(db: D1Database, sessionId: string, day: string): Promise<number> {
	const row = await db
		.prepare('SELECT starts FROM run_starts WHERE session_id = ?1 AND day = ?2')
		.bind(sessionId, day)
		.first<{ starts: number }>();
	return row?.starts ?? 0;
}

/** Records a new run and returns how many the session had started before it. */
export async function recordRunStart(db: D1Database, sessionId: string, day: string): Promise<number> {
	const row = await db
		.prepare(
			`INSERT INTO run_starts (session_id, day, starts) VALUES (?1, ?2, 1)
			 ON CONFLICT(session_id, day) DO UPDATE SET starts = starts + 1
			 RETURNING starts`
		)
		.bind(sessionId, day)
		.first<{ starts: number }>();
	return (row?.starts ?? 1) - 1;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface ScoreInput {
	runId: string;
	name: string;
	day: string;
	chips: number;
	roundsPlayed: number;
	bust: boolean;
}

export type SubmitResult =
	| { ok: true }
	| { ok: false; reason: 'already_submitted' | 'name_taken' | 'no_run' };

/**
 * Records a finished run on both leaderboards, atomically.
 *
 * The scores insert and the alltime_best upsert share a transaction, so the
 * materialized all-time board can never drift from the log it summarizes.
 * The conditional `WHERE` on the upsert means achieved_at only advances when
 * the previous best is genuinely beaten.
 *
 * A 0-chip bust is inserted freely — the partial unique index only enforces one
 * entry per name among scores that actually rank.
 */
export async function submitScore(db: D1Database, input: ScoreInput): Promise<SubmitResult> {
	const nameKey = input.name.toLowerCase();

	const existing = await db
		.prepare('SELECT chips FROM scores WHERE run_id = ?1 LIMIT 1')
		.bind(input.runId)
		.first<{ chips: number }>();
	if (existing) return { ok: false, reason: 'already_submitted' };

	if (input.chips > 0) {
		const taken = await db
			.prepare('SELECT id FROM scores WHERE day = ?1 AND name_key = ?2 LIMIT 1')
			.bind(input.day, nameKey)
			.first<{ id: number }>();
		if (taken) return { ok: false, reason: 'name_taken' };
	}

	const now = Date.now();
	const bust = input.bust ? 1 : 0;

	// D1 has no interactive transaction API, so batch the two writes. `batch`
	// runs them in order and rejects the whole batch if either statement fails.
	try {
		await db.batch([
			db
				.prepare(
					`INSERT INTO scores (name, name_key, day, chips, rounds_played, bust, run_id, submitted_at)
					 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
				)
				.bind(
					input.name,
					nameKey,
					input.day,
					input.chips,
					input.roundsPlayed,
					bust,
					input.runId,
					now
				),
			db
				.prepare(
					`INSERT INTO alltime_best (name_key, name, best_day, best_chips, achieved_at)
					 VALUES (?1, ?2, ?3, ?4, ?5)
					 ON CONFLICT(name_key) DO UPDATE SET
					   name = excluded.name,
					   best_day = excluded.best_day,
					   best_chips = excluded.best_chips,
					   achieved_at = excluded.achieved_at
					 WHERE excluded.best_chips > alltime_best.best_chips`
				)
				.bind(nameKey, input.name, input.day, input.chips, now),
		]);
	} catch (error) {
		// The partial unique index on (day, name_key) is the backstop against two
		// concurrent submissions racing for the same name.
		const message = String((error as { message?: unknown })?.message ?? error);
		if (/UNIQUE|constraint/i.test(message)) {
			return { ok: false, reason: 'name_taken' };
		}
		throw error;
	}

	return { ok: true };
}

interface ScoreRow {
	name: string;
	chips: number;
	day: string;
	/** Null on the all-time board, which records only a bankroll. */
	rounds_played: number | null;
	bust: number | null;
	achieved_at: number;
}

/**
 * Today's board, or the all-time board.
 *
 * Both are indexed top-N lookups: today reads idx_scores_day_chips, all-time
 * reads idx_alltime_best_chips. Neither degrades as history accumulates.
 */
export async function getLeaderboard(
	db: D1Database,
	scope: 'today' | 'alltime',
	playerName: string | null
): Promise<LeaderboardView> {
	const day = etDay();

	const rows =
		scope === 'today'
			? await db
					.prepare(
						`SELECT name, chips, day,
						        rounds_played, bust, submitted_at AS achieved_at
						 FROM scores WHERE day = ?1
						 ORDER BY chips DESC, submitted_at ASC LIMIT ?2`
					)
					.bind(day, LEADERBOARD_LIMIT)
					.all<ScoreRow>()
			: await db
					.prepare(
						`SELECT name, best_chips AS chips, best_day AS day,
						        NULL AS rounds_played, NULL AS bust, achieved_at
						 FROM alltime_best
						 ORDER BY best_chips DESC, achieved_at ASC LIMIT ?1`
					)
					.bind(LEADERBOARD_LIMIT)
					.all<ScoreRow>();

	const entries: LeaderboardEntry[] = (rows.results ?? []).map((row, index) => ({
		rank: index + 1,
		name: row.name,
		chips: row.chips,
		day: row.day,
		rounds: row.rounds_played ?? undefined,
		bust: row.bust === 1,
		achievedAt: row.achieved_at,
	}));

	return { scope, day, entries, you: findYou(entries, playerName) };
}

function findYou(entries: LeaderboardEntry[], playerName: string | null): LeaderboardEntry | null {
	if (!playerName) return null;
	const key = playerName.toLowerCase();
	return entries.find((e) => e.name.toLowerCase() === key) ?? null;
}