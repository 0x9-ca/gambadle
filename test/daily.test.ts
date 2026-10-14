/**
 * The daily comparison: how one player's ranked run stacks up against
 * everyone else's from the same day.
 */

import { describe, expect, it } from 'vitest';
import { summarizeDaily, type DailyRow } from '../worker/daily';

const row = (id: string, chips: number, rounds: object[] | string): DailyRow => ({
	session_id: id,
	chips,
	rounds: typeof rounds === 'string' ? rounds : JSON.stringify(rounds),
});
const round = (game: string, net: number, bet = 100) => ({ game, net, doubles: 0, bet });

describe('summarizeDaily', () => {
	const rows = [
		row('a', 1200, [round('roulette', 200), round('dice', 0), round('slots', -100)]),
		row('b', 800, [round('roulette', -100), round('dice', -50), round('slots', -50)]),
		row('c', 1500, [round('roulette', 300), round('dice', 100), round('slots', 100)]),
		row('d', 1200, [round('roulette', -100), round('dice', 50), round('slots', 100)]),
	];

	it('places a stack among the others, counting a tie as half', () => {
		const view = summarizeDaily(rows, 'a', '2026-10-14');
		expect(view.players).toBe(4);
		// Ahead of b, level with d, behind c: (1 + 0.5 + 0) / 3.
		expect(view.you).toEqual({ chips: 1200, ahead: 0.5 });
		expect(summarizeDaily(rows, 'c', '2026-10-14').you!.ahead).toBe(1);
		expect(summarizeDaily(rows, 'b', '2026-10-14').you!.ahead).toBe(0);
	});

	it('compares each round with the players who got the same game', () => {
		const view = summarizeDaily(rows, 'a', '2026-10-14');
		expect(view.rounds.map((r) => [r.round, r.game, r.players])).toEqual([
			[1, 'roulette', 4],
			[2, 'dice', 4],
			[3, 'slots', 4],
		]);
		const roulette = view.rounds[0]!;
		expect(roulette.winRate).toBe(0.5); // a and c won
		// Net per chip of bet: 2, -1, 3, -1.
		expect(roulette.avgReturn).toBeCloseTo(0.75, 12);
		expect(roulette.you).toEqual({ net: 200, won: true, ret: 2 });
		expect(view.rounds[1]!.you.won).toBe(false); // a push is not a win
		expect(view.rounds[2]!.winRate).toBe(0.5);
	});

	it('leaves out players who were dealt a different game that round', () => {
		const view = summarizeDaily(
			[row('a', 1100, [round('roulette', 100)]), row('b', 900, [round('craps', -100)]), row('c', 1300, [round('roulette', 300)])],
			'a',
			'2026-10-14'
		);
		expect(view.players).toBe(3);
		expect(view.rounds[0]).toMatchObject({ players: 2, winRate: 1 });
	});

	it('only compares rounds the other player also reached', () => {
		const view = summarizeDaily(
			[row('a', 1100, [round('dice', 100), round('slots', 0)]), row('b', 0, [round('dice', -1000)])],
			'a',
			'2026-10-14'
		);
		expect(view.rounds.map((r) => r.players)).toEqual([2, 1]);
		expect(view.you!.ahead).toBe(1);
	});

	it('has nothing to say to a player with no ranked run, and says who is alone', () => {
		expect(summarizeDaily(rows, 'zzz', '2026-10-14')).toEqual({ day: '2026-10-14', players: 4, you: null, rounds: [] });
		expect(summarizeDaily(rows, null, '2026-10-14').you).toBeNull();
		const alone = summarizeDaily([row('a', 1100, [round('dice', 100)])], 'a', '2026-10-14');
		expect(alone.you).toEqual({ chips: 1100, ahead: null });
		expect(alone.rounds[0]).toMatchObject({ players: 1, winRate: 1 });
	});

	it('survives damaged rows and records from before the bet was kept', () => {
		const view = summarizeDaily(
			[
				row('a', 1000, [{ game: 'dice', net: 50, doubles: 0 }]),
				row('b', 900, 'not json'),
				row('c', 950, [{ game: 'dice', net: -50, doubles: 0, bet: 100 }]),
			],
			'a',
			'2026-10-14'
		);
		expect(view.players).toBe(3);
		expect(view.rounds[0]!.players).toBe(2);
		expect(view.rounds[0]!.you.ret).toBeNull();
		// Only c recorded a bet, so the field's average is c's alone.
		expect(view.rounds[0]!.avgReturn).toBeCloseTo(-0.5, 12);
	});

	it('exposes no one else: only counts and averages', () => {
		const text = JSON.stringify(summarizeDaily(rows, 'a', '2026-10-14'));
		for (const id of ['"b"', '"c"', '"d"', 'session']) expect(text).not.toContain(id);
	});
});
