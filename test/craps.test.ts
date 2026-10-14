/**
 * Craps: every way a round can end, the odds and Field payouts, validation,
 * and the house edge.
 *
 * The edge is checked exactly, not sampled. A round's outcome depends only on
 * the first roll, then (if a point is set) on whether the point or a seven
 * comes first, so the expected value is a short sum. This test feeds the real
 * handler each of those terminal rolls, reads the payout it computes, and
 * weights it by the exact dice probabilities. The known edges are 1.41% on
 * pass and 1.36% on don't pass, and free odds must add nothing.
 */

import { describe, expect, it, vi } from 'vitest';
import { CRAPS_FIELD, CRAPS_MAX_ODDS, CRAPS_MAX_ROLLS } from '../shared/games';
import type { Action, CrapsBet, GameView } from '../shared/protocol';
import { craps } from '../worker/games/craps';
import { GameError } from '../worker/games/types';
import { setSeed } from './helpers/seeded-rng';

// A fixed seed makes the sampled check below the same on every run.
vi.mock(import('../worker/rng'), async () => await import('./helpers/seeded-rng'));

type V = Extract<GameView, { game: 'craps' }>;
type Step = ReturnType<typeof craps.apply>;

/** Ways to roll each total with two dice. */
const WAYS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };
const POINTS = [4, 5, 6, 8, 9, 10];
/** A pair of dice that makes `total`. */
const dice = (total: number): [number, number] => [Math.ceil(total / 2), total - Math.ceil(total / 2)];

const BET = 60; // divides cleanly for every odds payout (6:5, 3:2, 5:6, 2:3 ...)
const STACK = 100_000;

/** A round whose rolls are exactly `totals`, in order. */
function rigged(totals: number[], bet: CrapsBet = { side: 'pass' }, stake = BET) {
	const step = craps.init(craps.parseWager({ game: 'craps', bet }, stake, STACK), stake, STACK);
	const s = step.state as { rolls: number[] };
	s.rolls = totals.flatMap(dice);
	return s;
}

/** Plays `totals` out, taking `odds` (0, 1 or 2 times the bet) as soon as a point is set. */
function play(totals: number[], bet: CrapsBet = { side: 'pass' }, odds = 0): Step {
	const s = rigged(totals, bet);
	let step: Step = { state: s, view: craps.view(s), outcome: null };
	for (const _ of totals) {
		step = craps.apply(step.state, { type: 'ROLL' });
		if (step.outcome) return step;
		if (odds > 0 && (step.view as V).oddsOffer.length > 0) {
			step = craps.apply(step.state, { type: odds === 1 ? 'BET_1X' : 'BET_2X' });
		}
	}
	return step;
}

const net = (step: Step) => step.outcome!.returned - step.outcome!.stake;

describe('the come-out roll', () => {
	it('pays a pass bet on 7 and 11, loses it on 2, 3 and 12, and sets a point otherwise', () => {
		for (const t of [7, 11]) expect(net(play([t]))).toBe(BET);
		for (const t of [2, 3, 12]) expect(net(play([t]))).toBe(-BET);
		for (const t of POINTS) {
			const step = play([t]);
			expect(step.outcome).toBeNull();
			expect((step.view as V).point).toBe(t);
		}
	});

	it("pays don't pass on 2 and 3, loses it on 7 and 11, and pushes a 12", () => {
		const dp: CrapsBet = { side: 'dontpass' };
		for (const t of [2, 3]) expect(net(play([t], dp))).toBe(BET);
		for (const t of [7, 11]) expect(net(play([t], dp))).toBe(-BET);
		const push = play([12], dp);
		expect(net(push)).toBe(0);
		expect((push.view as V).result).toBe('push');
	});
});

describe('the point', () => {
	it('wins a pass bet when the point repeats and loses it on a seven', () => {
		expect(net(play([6, 4, 9, 6]))).toBe(BET);
		expect(net(play([6, 4, 9, 7]))).toBe(-BET);
		expect(net(play([6, 7]))).toBe(-BET);
	});

	it("reverses it for don't pass", () => {
		const dp: CrapsBet = { side: 'dontpass' };
		expect(net(play([8, 5, 11, 7], dp))).toBe(BET);
		expect(net(play([8, 5, 8], dp))).toBe(-BET);
	});

	it('ignores the other totals while a point is up, including 11 and 12', () => {
		for (const t of [2, 3, 11, 12, 4, 9]) {
			const step = play([6, t]);
			expect(step.outcome).toBeNull();
		}
	});
});

describe('free odds', () => {
	// Pass odds pay true odds: 2:1 on 4/10, 3:2 on 5/9, 6:5 on 6/8. Laid against, the reverse.
	const passPays: Record<number, [number, number]> = { 4: [2, 1], 10: [2, 1], 5: [3, 2], 9: [3, 2], 6: [6, 5], 8: [6, 5] };

	it('pays pass odds at true odds on top of the line bet, at both sizes', () => {
		for (const p of POINTS) {
			for (const odds of [1, 2]) {
				const [win, per] = passPays[p]!;
				const step = play([p, p], { side: 'pass' }, odds);
				expect(step.outcome!.stake).toBe(BET * (1 + odds));
				expect(net(step)).toBe(BET + (BET * odds * win) / per);
			}
		}
	});

	it('loses the odds with the line on a seven', () => {
		const step = play([5, 7], { side: 'pass' }, 2);
		expect(net(step)).toBe(-BET * 3);
	});

	it("pays don't pass odds the reverse way when the seven comes", () => {
		const lay: Record<number, [number, number]> = { 4: [1, 2], 10: [1, 2], 5: [2, 3], 9: [2, 3], 6: [5, 6], 8: [5, 6] };
		for (const p of POINTS) {
			for (const odds of [1, 2]) {
				const [win, per] = lay[p]!;
				const step = play([p, 7], { side: 'dontpass' }, odds);
				expect(net(step)).toBe(BET + (BET * odds * win) / per);
			}
		}
		// And loses them when the point is made.
		expect(net(play([6, 6], { side: 'dontpass' }, 2))).toBe(-BET * 3);
	});

	it('is offered only once a point is set, once, and never after the round ends', () => {
		const s = rigged([6, 3, 6]);
		expect(craps.legalActions(s)).toEqual(['ROLL']);
		expect(() => craps.apply(s, { type: 'BET_1X' })).toThrow(GameError);
		let step = craps.apply(s, { type: 'ROLL' });
		expect(craps.legalActions(step.state)).toEqual(['ROLL', 'BET_1X', 'BET_2X']);
		expect((step.view as V).oddsOffer).toEqual([
			{ multiple: 1, chips: BET },
			{ multiple: 2, chips: BET * 2 },
		]);
		step = craps.apply(step.state, { type: 'BET_2X' });
		expect(craps.legalActions(step.state)).toEqual(['ROLL']);
		expect((step.view as V).odds).toBe(BET * 2);
		expect((step.view as V).oddsOffer).toEqual([]);
		expect(() => craps.apply(step.state, { type: 'BET_1X' })).toThrow(GameError);
		step = craps.apply(step.state, { type: 'ROLL' });
		step = craps.apply(step.state, { type: 'ROLL' });
		expect(craps.legalActions(step.state)).toEqual([]);
		expect(() => craps.apply(step.state, { type: 'ROLL' })).toThrow(GameError);
	});

	it('rounds an odd odds profit down to whole chips', () => {
		// 6:5 on a 7-chip odds bet is 8.4 chips of profit.
		const step = craps.init({ game: 'craps', bet: { side: 'pass' } }, 7, STACK);
		(step.state as { rolls: number[] }).rolls = [6, 8, 6].flatMap(dice);
		let cur: Step = craps.apply(step.state, { type: 'ROLL' });
		cur = craps.apply(cur.state, { type: 'BET_1X' });
		cur = craps.apply(cur.state, { type: 'ROLL' });
		cur = craps.apply(cur.state, { type: 'ROLL' });
		expect(cur.outcome!.stake).toBe(14);
		expect(cur.outcome!.returned).toBe(14 + 7 + 8);
	});
});

describe('the Field bet', () => {
	const field = (first: number, bet: CrapsBet = { side: 'pass', field: 10 }) => play([first, 7], bet);

	it('is decided by the first roll alone', () => {
		for (const t of [3, 4, 9, 10, 11]) {
			const step = field(t);
			expect((step.view as V).field).toEqual({ bet: 10, won: true, pays: 1 });
		}
		expect((field(2).view as V).field).toMatchObject({ won: true, pays: CRAPS_FIELD[2] });
		expect((field(12).view as V).field).toMatchObject({ won: true, pays: CRAPS_FIELD[12] });
		for (const t of [5, 6, 7, 8]) expect((field(t).view as V).field).toEqual({ bet: 10, won: false, pays: 0 });
	});

	it('pays 2:1 on 2 and 3:1 on 12, and loses on 7 even when the line wins', () => {
		// 2 loses the pass line (-60) but wins the Field (+20).
		expect(net(play([2], { side: 'pass', field: 10 }))).toBe(-BET + 20);
		expect(net(play([12], { side: 'pass', field: 10 }))).toBe(-BET + 30);
		// 7 wins the pass line (+60) but loses the Field (-10).
		expect(net(play([7], { side: 'pass', field: 10 }))).toBe(BET - 10);
	});

	it('is not decided again by later rolls', () => {
		const step = play([5, 2, 3, 5], { side: 'pass', field: 10 });
		expect((step.view as V).field).toMatchObject({ won: false });
		expect(step.outcome!.stake).toBe(BET + 10);
		expect(net(step)).toBe(BET - 10);
	});

	it('has the 2.78% edge of a field that pays 3:1 on twelve', () => {
		let ev = 0;
		for (let t = 2; t <= 12; t++) ev += (WAYS[t]! / 36) * (CRAPS_FIELD[t] ?? -1);
		expect(ev).toBeCloseTo(-1 / 36, 12);
	});
});

describe('house edge', () => {
	/**
	 * Expected net chips per chip of line bet, from the handler's own payouts.
	 * `odds` is how many times the line bet is taken in odds once a point is set.
	 */
	function edge(side: 'pass' | 'dontpass', odds: number): number {
		let ev = 0;
		for (let t = 2; t <= 12; t++) {
			const p = WAYS[t]! / 36;
			if (!POINTS.includes(t)) {
				ev += p * (net(play([t], { side })) / BET);
				continue;
			}
			// A point: it repeats before a seven with probability w(t) / (w(t) + 6).
			const made = WAYS[t]! / (WAYS[t]! + 6);
			ev += p * (made * (net(play([t, t], { side }, odds)) / BET) + (1 - made) * (net(play([t, 7], { side }, odds)) / BET));
		}
		return ev;
	}

	it('is 1.41% on pass whatever the odds', () => {
		for (const odds of [0, 1, 2]) expect(edge('pass', odds)).toBeCloseTo(-7 / 495, 12);
	});

	it("is 1.36% on don't pass whatever the odds", () => {
		for (const odds of [0, 1, 2]) expect(edge('dontpass', odds)).toBeCloseTo(-27 / 1980, 12);
	});

	it('agrees with the known win probabilities', () => {
		let pass = 0;
		for (let t = 2; t <= 12; t++) {
			const p = WAYS[t]! / 36;
			if (t === 7 || t === 11) pass += p;
			else if (POINTS.includes(t)) pass += p * (WAYS[t]! / (WAYS[t]! + 6));
		}
		expect(pass).toBeCloseTo(244 / 495, 12);
	});

	it('plays out near the exact edge when rolled for real', () => {
		setSeed(7);
		const rounds = 40_000;
		let sum = 0;
		let squares = 0;
		for (let i = 0; i < rounds; i++) {
			let step: Step = craps.init({ game: 'craps', bet: { side: 'pass' } }, BET, STACK);
			step = { ...step, outcome: null };
			for (let guard = 0; guard < 1000 && !step.outcome; guard++) {
				const legal = craps.legalActions(step.state);
				step = craps.apply(step.state, { type: legal.includes('BET_2X') ? 'BET_2X' : 'ROLL' });
			}
			const unit = net(step) / BET;
			sum += unit;
			squares += unit * unit;
		}
		const mean = sum / rounds;
		const se = Math.sqrt((squares / rounds - mean * mean) / rounds);
		process.stdout.write(`Craps pass with 2x odds sampled: ${(mean * 100).toFixed(2)}% ± ${(se * 100).toFixed(2)} (exact -1.41%)\n`);
		expect(Math.abs(mean + 7 / 495)).toBeLessThan(5 * se);
	});
});

describe('the wager', () => {
	it('needs the stack to cover the line bet and its room for odds', () => {
		const stake = 100;
		const reserve = stake * (1 + CRAPS_MAX_ODDS);
		expect(() => craps.parseWager({ game: 'craps', bet: { side: 'pass' } }, stake, reserve - 1)).toThrow(GameError);
		expect(craps.parseWager({ game: 'craps', bet: { side: 'pass' } }, stake, reserve)).toEqual({
			game: 'craps',
			bet: { side: 'pass' },
		});
		expect(() => craps.parseWager({ game: 'craps', bet: { side: 'pass', field: 1 } }, stake, reserve)).toThrow(GameError);
		expect(craps.parseWager({ game: 'craps', bet: { side: 'dontpass', field: 5 } }, stake, reserve + 5)).toEqual({
			game: 'craps',
			bet: { side: 'dontpass', field: 5 },
		});
	});

	it('rejects a bad side or Field amount', () => {
		for (const bet of [{ side: 'come' }, { side: 'pass', field: -1 }, { side: 'pass', field: 1.5 }, undefined]) {
			expect(() => craps.parseWager({ game: 'craps', bet: bet as CrapsBet }, 10, STACK)).toThrow(GameError);
		}
	});
});

describe('the rolls', () => {
	it('are dealt up front and never shown early', () => {
		const step = craps.init({ game: 'craps', bet: { side: 'pass' } }, BET, STACK);
		expect((step.view as V).rolls).toEqual([]);
		const state = step.state as { rolls: number[] };
		expect(state.rolls).toHaveLength(2 * CRAPS_MAX_ROLLS);
		// Dice only make totals from 2 to 12.
		const totals = new Array<number>(13).fill(0);
		for (let i = 0; i < 200; i++) totals[(state.rolls[2 * (i % CRAPS_MAX_ROLLS)] ?? 0) + (state.rolls[2 * (i % CRAPS_MAX_ROLLS) + 1] ?? 0)]!++;
		expect(totals[1]).toBe(0);
		expect(state.rolls.every((d) => Number.isInteger(d) && d >= 1 && d <= 6)).toBe(true);
		const next = craps.apply(step.state, { type: 'ROLL' });
		expect((next.view as V).rolls).toHaveLength(1);
	});

	it('hand every stake back if they ever ran out', () => {
		const s = rigged([5, 6, 6, 6]);
		(s as unknown as { taken: number }).taken = CRAPS_MAX_ROLLS;
		const step = craps.apply(s, { type: 'ROLL' } as Action);
		expect(step.outcome!.returned).toBe(step.outcome!.stake);
	});
});
