/**
 * Personal stats: what a player's finished runs add up to.
 *
 * Pure, so it can be tested without D1; the route feeds it the session's rows.
 */

import { GAME_IDS, type GameId, type RunState, STARTING_CHIPS, type StatsView } from '../shared/protocol';

/** One round of a finished run, a Double or Nothing chain folded in. */
export interface RoundRecord {
	game: GameId;
	net: number;
	doubles: number;
}

export interface ResultRow {
	day: string;
	ranked: number;
	chips: number;
	bust: number;
	rounds: string;
	finished_at: number;
}

/** The rounds of a run, one record each. */
export function roundRecords(run: RunState): RoundRecord[] {
	const rounds: (RoundRecord & { round: number })[] = [];
	for (const entry of run.history) {
		const last = rounds[rounds.length - 1];
		if (last && last.round === entry.round) {
			last.net += entry.net;
			last.doubles += 1;
		} else {
			rounds.push({ round: entry.round, game: entry.game, net: entry.net, doubles: 0 });
		}
	}
	return rounds.map(({ game, net, doubles }) => ({ game, net, doubles }));
}

/** The ET day before `day` ('2026-03-01' -> '2026-02-28'). */
export function dayBefore(day: string): string {
	const [y, m, d] = day.split('-').map(Number) as [number, number, number];
	return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/**
 * Summarizes a player's finished runs. The day streak counts consecutive ET
 * days with a finished run, ending today, or yesterday if today has none yet
 * (a streak is not broken until a whole day passes without a run).
 */
export function summarizeStats(rows: readonly ResultRow[], today: string): StatsView {
	const games = new Map<GameId, { played: number; won: number; net: number }>();
	let best: StatsView['best'] = null;
	let total = 0;
	let busts = 0;

	for (const row of rows) {
		total += row.chips;
		if (row.bust) busts++;
		if (!best || row.chips > best.chips) best = { chips: row.chips, day: row.day };
		let rounds: RoundRecord[] = [];
		try {
			rounds = JSON.parse(row.rounds) as RoundRecord[];
		} catch {
			// A damaged row still counts toward the run totals.
		}
		for (const r of rounds) {
			if (!GAME_IDS.includes(r.game)) continue;
			const g = games.get(r.game) ?? { played: 0, won: 0, net: 0 };
			g.played++;
			if (r.net > 0) g.won++;
			g.net += r.net;
			games.set(r.game, g);
		}
	}

	const days = new Set(rows.map((r) => r.day));
	let streak = 0;
	let cursor = days.has(today) ? today : dayBefore(today);
	while (days.has(cursor)) {
		streak++;
		cursor = dayBefore(cursor);
	}

	return {
		runs: rows.length,
		busts,
		best,
		average: rows.length > 0 ? Math.round(total / rows.length) : null,
		netTotal: total - rows.length * STARTING_CHIPS,
		streak,
		games: GAME_IDS.filter((id) => games.has(id)).map((id) => ({ game: id, ...games.get(id)! })),
	};
}
