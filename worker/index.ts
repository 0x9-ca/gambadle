/**
 * Gambadle Worker.
 *
 * Routes:
 *   GET  /api/state          the current run, or idle
 *   POST /api/action         advance the run by one intent
 *   GET  /api/leaderboard    today's board, or the all-time one
 *
 * Every gameplay decision is made here. The client receives authoritative state
 * and renders it; it never holds chips, cards or randomness of its own.
 *
 * Also handles the scheduled prune (see wrangler.jsonc).
 */

import {
	type Action,
	type ApiError,
	type DailyView,
	type LeaderboardView,
	type RunState,
	type RunView,
	type StatsView,
} from '../shared/protocol';
import {
	deleteRun,
	getDailyResults,
	getLeaderboard,
	getRun,
	getRunResults,
	pruneStaleRuns,
	putRun,
	recordRunResult,
	recordRunStart,
	startsToday,
	submitScore,
} from './db';
import { applyAction, publicRun, totalWagered } from './engine';
import { summarizeDaily } from './daily';
import { roundRecords, summarizeStats } from './stats';
import { GameError } from './games/types';
import {
	newSessionId,
	readSession,
	sessionCookieHeader,
	signCookieValue,
} from './session';
import { etDay, secondsUntilReset } from './time';

/**
 * Attached to Worker-generated responses. The `public/_headers` file covers
 * static assets but is explicitly not applied to responses the Worker produces.
 */
const SECURITY_HEADERS: Record<string, string> = {
	'Cache-Control': 'no-store',
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'strict-origin-when-cross-origin',
	'X-Frame-Options': 'DENY',
};

/** Guards against a large body being read into memory. Game actions are tiny. */
const MAX_BODY_BYTES = 4096;

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		switch (url.pathname) {
			case '/api/state':
				return handleState(request, env);
			case '/api/action':
				return handleAction(request, env);
			case '/api/leaderboard':
				return handleLeaderboard(request, env);
			case '/api/stats':
				return handleStats(request, env);
			case '/api/daily':
				return handleDaily(request, env);
			default:
				// Static assets are served before the Worker sees them, so anything
				// arriving here is either a stray API path or a client-side route
				// that the SPA shell already covers.
				return new Response('Not found', {
					status: 404,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' },
				});
		}
	},

	/**
	 * Housekeeping. Cron triggers run on UTC, so this deliberately does not try
	 * to fire at midnight America/New_York — the daily reset is implicit and
	 * happens in loadRun when a run's stamped day stops matching today.
	 */
	async scheduled(_controller, env): Promise<void> {
		const removed = await pruneStaleRuns(env.DB);
		console.log(JSON.stringify({ message: 'pruned stale runs', day: etDay(), removed }));
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// GET /api/state
// ---------------------------------------------------------------------------

async function handleState(request: Request, env: Env): Promise<Response> {
	const sessionId = await readSession(request, env.SESSION_SECRET);
	const day = etDay();
	const { run, resetReason } = await loadRun(env, sessionId, day);
	return json({
		...viewOf(env, run, resetReason),
		wagered: run ? totalWagered(run) : 0,
		rankedAvailable: !isStaging(env) && (await rankedAvailable(env, sessionId, day)),
	} satisfies RunView);
}

/**
 * Loads the run for this session and applies the implicit daily reset.
 *
 * A run stamped with a day that is not today is treated as gone. That is the
 * entire daily-reset mechanism: no scheduler, and no DST edge cases.
 *
 * `day` is read once per request and passed everywhere: a request that spans
 * midnight must not load against one day and save against the next, which
 * would carry yesterday's run (and its seed) into today. `version` is the row's
 * `updated_at` (null for no row), for `putRun`'s compare-and-swap.
 */
async function loadRun(
	env: Env,
	sessionId: string | null,
	day: string
): Promise<{ run: RunState | null; resetReason: RunView['resetReason']; version: number | null }> {
	if (!sessionId) return { run: null, resetReason: null, version: null };

	const row = await getRun(env.DB, sessionId);
	if (!row) return { run: null, resetReason: null, version: null };

	if (row.day !== day) {
		// Yesterday's run: the player is back to 1000 chips with nothing open.
		// Drop the row eagerly; the cron would clear it anyway. Only that day's
		// row, so a run this same request goes on to start is never caught by it.
		void deleteRun(env.DB, sessionId, row.day).catch((error: unknown) => {
			console.error(
				JSON.stringify({ message: 'failed to delete voided run', error: String(error) })
			);
		});
		return { run: null, resetReason: 'daily', version: row.updated_at };
	}

	return { run: JSON.parse(row.state) as RunState, resetReason: null, version: row.updated_at };
}

/** A session's first run of the day is the only one that can be ranked. */
async function rankedAvailable(env: Env, sessionId: string | null, day: string): Promise<boolean> {
	return !sessionId || (await startsToday(env.DB, sessionId, day)) === 0;
}

/** Another request changed the run between this one reading and writing it. */
const runChanged = (): Response =>
	json({ error: 'Your run changed in another tab. Refresh to continue.', code: 'illegal_action' } satisfies ApiError, 409);

function viewOf(
	env: Env,
	run: RunState | null,
	resetReason: RunView['resetReason']
): Omit<RunView, 'wagered' | 'rankedAvailable'> {
	return {
		run: publicRun(run),
		resetReason,
		secondsUntilReset: secondsUntilReset(),
		...(isStaging(env) ? { staging: true } : {}),
	};
}

/**
 * The staging deployment (`STAGING` is set in wrangler.jsonc's staging
 * environment only): practice runs of single games, no ranking, no stats, no
 * leaderboard. Nothing it does reaches the production database.
 */
const isStaging = (env: Env): boolean => env.STAGING === '1';

/** Leaderboard, stats and the daily comparison do not exist on staging. */
const notOnStaging = (): Response =>
	json({ error: 'Not available on staging', code: 'invalid_action' } satisfies ApiError, 404);


// ---------------------------------------------------------------------------
// POST /api/action
// ---------------------------------------------------------------------------

async function handleAction(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return json({ error: 'Use POST', code: 'invalid_action' } satisfies ApiError, 405);
	}

	const action = await readAction(request);
	if ('error' in action) return action.error;

	const sessionId = await readSession(request, env.SESSION_SECRET);
	const day = etDay();
	const { run: existing, version } = await loadRun(env, sessionId, day);

	// These two need database access rather than a state transition, so they are
	// handled here instead of in the engine.
	if (isStaging(env) && action.action.type === 'SUBMIT_NAME') return notOnStaging();
	if (action.action.type === 'START_TEST' && !isStaging(env)) {
		return json({ error: 'Practice runs only exist on staging', code: 'invalid_action' } satisfies ApiError, 403);
	}
	if (action.action.type === 'SUBMIT_NAME') {
		return submitName(env, sessionId, existing, version, day, action.action.name);
	}
	if (action.action.type === 'ABANDON') {
		// The session is kept on purpose: clearing it would hand the player a
		// fresh identity, and with it a fresh "first run of the day".
		if (sessionId) await deleteRun(env.DB, sessionId);
		return json({
			...viewOf(env, null, 'replaced'),
			wagered: 0,
			rankedAvailable: !isStaging(env) && (await rankedAvailable(env, sessionId, day)),
		} satisfies RunView);
	}

	if (!existing && action.action.type !== 'START' && action.action.type !== 'START_TEST') {
		return json({ error: 'No run in progress', code: 'no_run' } satisfies ApiError, 409);
	}

	const headers = new Headers();
	// First action of a session, which is always START (or START_TEST on staging).
	// An existing session's cookie is re-sent too, so it never lapses while in use.
	const id = sessionId ?? (await newSessionId());
	headers.append('Set-Cookie', sessionCookieHeader(await signCookieValue(id, env.SESSION_SECRET), isSecure(request)));

	// Only the first run a session starts each day is ranked (starting over
	// mid-run counts as starting another), and that run alone gets the day's
	// shared seed. The count is taken in one atomic upsert *before* the run is
	// built: reading it separately would let two simultaneous STARTs both see
	// zero earlier starts and both come out ranked. START cannot fail in the
	// engine, so recording it first never charges a start for a run not created.
	const ranked =
		action.action.type === 'START' && (await recordRunStart(env.DB, id, day)) === 0;

	let next: RunState;
	try {
		next = applyAction(existing, action.action, ranked ? day : null, `daily-seed|${env.SESSION_SECRET}`);
	} catch (error) {
		if (error instanceof GameError) {
			return json({ error: error.message, code: error.code } satisfies ApiError, 409);
		}
		throw error;
	}
	if (action.action.type === 'START') next.eligible = ranked;

	// Every other action must still be acting on the run it read. A START
	// replaces whatever is there anyway, and is left unguarded so a run start
	// already counted above is never thrown away by a racing request.
	const fresh = action.action.type === 'START' || action.action.type === 'START_TEST';
	const written = await putRun(env.DB, { id, day, phase: next.phase, state: next, name: null }, fresh ? undefined : version);
	if (!written) return runChanged();

	// The run just ended (busted or survived): it counts toward the player's
	// stats exactly once, whether or not a name is ever submitted.
	// Stats are a nicety: failing to record one must not fail the action.
	if (next.phase === 'finished' && existing?.phase !== 'finished' && !next.testGame) {
		try {
			await recordRunResult(env.DB, {
				sessionId: id,
				day,
				ranked: next.eligible !== false,
				chips: next.chips,
				bust: next.endedBy === 'bust',
				rounds: roundRecords(next),
			});
		} catch (error) {
			console.error(JSON.stringify({ message: 'failed to record run result', error: String(error) }));
		}
	}

	return json(
		{
			...viewOf(env, next, null),
			wagered: totalWagered(next),
			rankedAvailable: !isStaging(env) && (await rankedAvailable(env, id, day)),
		} satisfies RunView,
		200,
		headers
	);
}

type ParsedAction = { action: Action } | { error: Response };

async function readAction(request: Request): Promise<ParsedAction> {
	const fail = (message: string, code: ApiError['code'], status: number) =>
		json({ error: message, code } satisfies ApiError, status);

	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		return { error: fail('Body too large', 'invalid_action', 413) };
	}

	let text: string;
	try {
		text = await request.text();
	} catch {
		return { error: fail('Could not read body', 'invalid_action', 400) };
	}
	if (text.length > MAX_BODY_BYTES) {
		return { error: fail('Body too large', 'invalid_action', 413) };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { error: fail('Malformed JSON', 'invalid_action', 400) };
	}

	if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Action).type !== 'string') {
		return { error: fail('Missing action type', 'invalid_action', 400) };
	}
	return { action: parsed as Action };
}

// ---------------------------------------------------------------------------
// Name submission
// ---------------------------------------------------------------------------

const NAME_MIN = 2;
const NAME_MAX = 16;
/** Conservative allowlist: letters, digits, space, and a few separators. */
const NAME_PATTERN = /^[\p{L}\p{N} _.-]{2,16}$/u;

function validateName(raw: unknown): string {
	if (typeof raw !== 'string') {
		throw new GameError('invalid_name', 'Enter a name');
	}
	const name = raw.trim().replace(/\s+/g, ' ');
	if (name.length < NAME_MIN) {
		throw new GameError('invalid_name', `Names need at least ${NAME_MIN} characters`);
	}
	if (name.length > NAME_MAX) {
		throw new GameError('invalid_name', `Names cap at ${NAME_MAX} characters`);
	}
	if (!NAME_PATTERN.test(name)) {
		throw new GameError('invalid_name', 'Letters, numbers, spaces, dots, dashes and underscores only');
	}
	return name;
}

async function submitName(
	env: Env,
	sessionId: string | null,
	run: RunState | null,
	version: number | null,
	day: string,
	rawName: unknown
): Promise<Response> {
	let name: string;
	try {
		name = validateName(rawName);
	} catch (error) {
		if (error instanceof GameError) {
			return json({ error: error.message, code: error.code } satisfies ApiError, 400);
		}
		throw error;
	}

	if (!run || !sessionId) {
		return json({ error: 'No run to submit', code: 'no_run' } satisfies ApiError, 409);
	}
	if (run.eligible === false) {
		return json(
			{ error: 'Only your first run of the day can go on the leaderboard', code: 'not_eligible' } satisfies ApiError,
			409
		);
	}
	if (run.phase !== 'finished') {
		return json({ error: 'Your run is not over yet', code: 'invalid_action' } satisfies ApiError, 409);
	}

	const result = await submitScore(env.DB, {
		runId: sessionId,
		name,
		day,
		chips: run.chips,
		// Rounds, not history entries: each Double or Nothing adds an entry to the
		// same round, so a five-round run with doubles would read "7 rounds".
		roundsPlayed: new Set(run.history.map((entry) => entry.round)).size,
		bust: run.endedBy === 'bust',
	});

	if (!result.ok) {
		const message =
			result.reason === 'name_taken'
				? 'That name is already on today’s board'
				: 'You have already submitted a score today';
		return json({ error: message, code: result.reason } satisfies ApiError, 409);
	}

	const submitted: RunState = { ...run, phase: 'submitted', current: null };
	// The score stands either way; if another request replaced the run meanwhile
	// (a START from another tab), that newer run is kept rather than overwritten.
	await putRun(env.DB, { id: sessionId, day, phase: 'submitted', state: submitted, name }, version);

	return json({
		...viewOf(env, submitted, null),
		wagered: totalWagered(submitted),
		rankedAvailable: false,
	} satisfies RunView);
}

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// ---------------------------------------------------------------------------

async function handleLeaderboard(request: Request, env: Env): Promise<Response> {
	if (isStaging(env)) return notOnStaging();
	const scope = new URL(request.url).searchParams.get('scope') === 'alltime' ? 'alltime' : 'today';

	const sessionId = await readSession(request, env.SESSION_SECRET);
	const row = sessionId ? await getRun(env.DB, sessionId) : null;
	// Names are unique per day only, so a name from an earlier day's run would
	// mark whoever holds it today as "you".
	const name = row && (scope === 'alltime' || row.day === etDay()) ? row.name : null;

	const view: LeaderboardView = await getLeaderboard(env.DB, scope, name);
	return json(view);
}

// ---------------------------------------------------------------------------
// GET /api/stats
// ---------------------------------------------------------------------------

async function handleStats(request: Request, env: Env): Promise<Response> {
	if (isStaging(env)) return notOnStaging();
	const sessionId = await readSession(request, env.SESSION_SECRET);
	const rows = sessionId ? await getRunResults(env.DB, sessionId) : [];
	return json(summarizeStats(rows, etDay()) satisfies StatsView);
}

// ---------------------------------------------------------------------------
// GET /api/daily
// ---------------------------------------------------------------------------

async function handleDaily(request: Request, env: Env): Promise<Response> {
	if (isStaging(env)) return notOnStaging();
	const sessionId = await readSession(request, env.SESSION_SECRET);
	const day = etDay();
	const rows = await getDailyResults(env.DB, day);
	return json(summarizeDaily(rows, sessionId, day) satisfies DailyView);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200, extra?: Headers): Response {
	const headers = new Headers(extra);
	for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
		if (!headers.has(key)) headers.set(key, value);
	}
	// Set by hand rather than via Response.json() so extra headers survive.
	if (!headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json; charset=utf-8');
	}
	return new Response(JSON.stringify(body), { status, headers });
}

/** Cookies are marked Secure only where the request actually arrived over TLS. */
function isSecure(request: Request): boolean {
	return new URL(request.url).protocol === 'https:';
}