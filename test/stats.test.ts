/**
 * Personal stats: run totals, per-game records and the day streak, computed
 * from the rows the Worker stores when a run finishes.
 */

import { describe, expect, it } from 'vitest';
import { initialRunState, type RoundResult } from '../shared/protocol';
import { dayBefore, type ResultRow, roundRecords, summarizeStats } from '../worker/stats';

const row = (day: string, chips: number, rounds: object[], bust = false): ResultRow => ({
	day,
	ranked: 1,
	chips,
	bust: bust ? 1 : 0,
	rounds: JSON.stringify(rounds),
	finished_at: 0,
});

describe('dayBefore', () => {
	it('crosses month and year ends', () => {
		expect(dayBefore('2026-03-01')).toBe('2026-02-28');
		expect(dayBefore('2028-03-01')).toBe('2028-02-29');
		expect(dayBefore('2027-01-01')).toBe('2026-12-31');
	});
});

describe('roundRecords', () => {
	it('folds a Double or Nothing chain into its round', () => {
		const entry = (round: number, game: RoundResult['game'], net: number, doubled = false): RoundResult => ({
			round,
			game,
			bet: 10,
			returned: 0,
			net,
			doubled,
			detail: '',
			view: null,
		});
		const run = {
			...initialRunState(),
			history: [entry(1, 'dice', 50), entry(1, 'dice', 100, true), entry(1, 'dice', -200, true), entry(2, 'slots', -10)],
		};
		expect(roundRecords(run)).toEqual([
			{ game: 'dice', net: -50, doubles: 2, bet: 10 },
			{ game: 'slots', net: -10, doubles: 0, bet: 10 },
		]);
	});
});

describe('summarizeStats', () => {
	it('is empty before any run is finished', () => {
		expect(summarizeStats([], '2026-10-14')).toEqual({
			runs: 0,
			busts: 0,
			best: null,
			average: null,
			netTotal: 0,
			streak: 0,
			games: [],
		});
	});

	it('totals runs and games', () => {
		const stats = summarizeStats(
			[
				row('2026-10-14', 1500, [{ game: 'dice', net: 200, doubles: 0 }, { game: 'roulette', net: -50, doubles: 0 }]),
				row('2026-10-13', 0, [{ game: 'dice', net: -1000, doubles: 0 }], true),
				row('2026-10-12', 1100, [{ game: 'ultimate', net: 100, doubles: 1 }]),
			],
			'2026-10-14'
		);
		expect(stats.runs).toBe(3);
		expect(stats.busts).toBe(1);
		expect(stats.best).toEqual({ chips: 1500, day: '2026-10-14' });
		expect(stats.average).toBe(867);
		expect(stats.netTotal).toBe(2600 - 3000);
		expect(stats.streak).toBe(3);
		// In the game list's order, not by when they were played.
		expect(stats.games).toEqual([
			{ game: 'roulette', played: 1, won: 0, net: -50 },
			{ game: 'dice', played: 2, won: 1, net: -800 },
			{ game: 'ultimate', played: 1, won: 1, net: 100 },
		]);
	});

	it('keeps a streak alive until a whole day passes without a run', () => {
		const days = (...list: string[]) => list.map((d) => row(d, 1000, []));
		expect(summarizeStats(days('2026-10-13', '2026-10-12'), '2026-10-14').streak).toBe(2);
		expect(summarizeStats(days('2026-10-12', '2026-10-11'), '2026-10-14').streak).toBe(0);
		expect(summarizeStats(days('2026-10-14', '2026-10-14', '2026-10-12'), '2026-10-14').streak).toBe(1);
	});

	it('survives a damaged rounds column and unknown games', () => {
		const stats = summarizeStats(
			[{ ...row('2026-10-14', 900, []), rounds: 'not json' }, row('2026-10-14', 1000, [{ game: 'keno', net: 5, doubles: 0 }])],
			'2026-10-14'
		);
		expect(stats.runs).toBe(2);
		expect(stats.games).toEqual([]);
	});
});
