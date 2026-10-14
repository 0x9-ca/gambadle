/**
 * Today's comparison between ranked players, from the rows run_results keeps.
 *
 * Pure, so it can be tested without D1. Only aggregates leave here: no session
 * id, and nothing about any one other player.
 */

import { GAME_IDS, type DailyView } from '../shared/protocol';
import type { RoundRecord } from './stats';

export interface DailyRow {
	session_id: string;
	chips: number;
	rounds: string;
}

function parseRounds(text: string): RoundRecord[] {
	try {
		const parsed: unknown = JSON.parse(text);
		return Array.isArray(parsed) ? (parsed as RoundRecord[]) : [];
	} catch {
		// A damaged row still counts as a player, just one with no rounds.
		return [];
	}
}

/** Net per chip of bet, or null when the round carries no usable bet. */
const returnOf = (r: RoundRecord | undefined): number | null =>
	r && typeof r.bet === 'number' && r.bet > 0 ? r.net / r.bet : null;

export function summarizeDaily(rows: readonly DailyRow[], sessionId: string | null, day: string): DailyView {
	const parsed = rows.map((row) => ({ id: row.session_id, chips: row.chips, rounds: parseRounds(row.rounds) }));
	const mine = sessionId ? parsed.find((p) => p.id === sessionId) : undefined;
	if (!mine) return { day, players: rows.length, you: null, rounds: [] };

	const others = parsed.filter((p) => p !== mine);
	const ahead =
		others.length === 0
			? null
			: others.reduce((sum, p) => sum + (mine.chips > p.chips ? 1 : mine.chips === p.chips ? 0.5 : 0), 0) /
				others.length;

	const rounds: DailyView['rounds'] = [];
	mine.rounds.forEach((own, index) => {
		if (!GAME_IDS.includes(own.game)) return;
		// Everyone is dealt the same game in the same round, except when a small
		// stack rules a game out, so only compare players who got this one.
		const same = parsed.map((p) => p.rounds[index]).filter((r): r is RoundRecord => r !== undefined && r.game === own.game);
		const returns = same.map(returnOf).filter((r): r is number => r !== null);
		rounds.push({
			round: index + 1,
			game: own.game,
			players: same.length,
			winRate: same.filter((r) => r.net > 0).length / same.length,
			avgReturn: returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null,
			you: { net: own.net, won: own.net > 0, ret: returnOf(own) },
		});
	});

	return { day, players: rows.length, you: { chips: mine.chips, ahead }, rounds };
}
