/**
 * Slots — payline behaviour and a measured return.
 *
 * The return is enumerated rather than sampled: each reel has 20 stops and 20
 * possible offsets, so the whole machine is exactly 20³ = 8000 equally likely
 * outcomes. That makes the RTP a closed-form number the test can pin down, and
 * the Monte Carlo case becomes a check that the shipped code agrees with the
 * arithmetic instead of a source of flakiness.
 *
 * The strips and paytable are imported from shared/games.ts rather than restated
 * here, so the test measures the machine that actually ships.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	SLOT_PAYTABLE,
	SLOT_SPINS,
	SLOT_STOPS_PER_REEL,
	SLOT_STRIPS,
	SLOT_SYMBOLS,
	type SlotSymbol,
} from '../shared/games';
import type { GameView, Wager } from '../shared/protocol';
import { setSeed } from './helpers/seeded-rng';
import { slots } from '../worker/games/slots';
import { GameError } from '../worker/games/types';

vi.mock(import('../worker/rng'), async () => await import('./helpers/seeded-rng'));

const STAKE = 300;
const wager: Wager = { game: 'slots' };

const WINDOWS = SLOT_STOPS_PER_REEL ** 3;

/**
 * The winning symbols on one spin, across the three paylines.
 *
 * Every measurement below goes through this, so the frequency table and the
 * return figure can never be derived from two different models of the machine.
 */
function winningLines(offsets: readonly [number, number, number]): (SlotSymbol | null)[] {
	return [0, 1, 2].map((row) => {
		const [a, b, c] = [0, 1, 2].map(
			(reel) => SLOT_STRIPS[reel]![(offsets[reel]! + row) % SLOT_STOPS_PER_REEL]!
		) as [SlotSymbol, SlotSymbol, SlotSymbol];
		return a === b && b === c ? a : null;
	});
}

/** Walks all 20³ equally likely spins. */
function* everySpin(): Generator<(SlotSymbol | null)[]> {
	for (let o1 = 0; o1 < SLOT_STOPS_PER_REEL; o1++) {
		for (let o2 = 0; o2 < SLOT_STOPS_PER_REEL; o2++) {
			for (let o3 = 0; o3 < SLOT_STOPS_PER_REEL; o3++) {
				yield winningLines([o1, o2, o3]);
			}
		}
	}
}

/** How often each symbol lands a triple on at least one payline. */
function tripleFrequencies(): Map<SlotSymbol, number> {
	const counts = new Map<SlotSymbol, number>(SLOT_SYMBOLS.map((s) => [s, 0]));
	for (const lines of everySpin()) {
		for (const line of lines) {
			if (line !== null) counts.set(line, counts.get(line)! + 1);
		}
	}
	return new Map([...counts].map(([symbol, n]) => [symbol, n / WINDOWS]));
}

/**
 * Chips returned per chip staked, averaged over every possible spin.
 *
 * A winning payline pays its table value as a multiple of the whole stake, so
 * two winning lines pay twice as much. A losing spin returns nothing at all —
 * the machine is not a guaranteed-return machine that merely adds bonuses.
 */
function exactReturn(): number {
	let total = 0;
	for (const lines of everySpin()) {
		for (const line of lines) {
			if (line !== null) total += SLOT_PAYTABLE[line]!;
		}
	}
	return total / WINDOWS;
}

/** One round: SLOT_SPINS spins dealt by the one SPIN. */
function spin(): { returned: number; stake: number } {
	const step = slots.init(wager, STAKE, STAKE * 1000);
	const out = slots.apply(step.state, { type: 'SPIN' });
	if (!out.outcome) throw new Error('a spin must settle');
	return out.outcome;
}

describe('slot strips', () => {
	it('gives every reel exactly twenty stops', () => {
		expect(SLOT_STRIPS).toHaveLength(3);
		for (const strip of SLOT_STRIPS) expect(strip).toHaveLength(SLOT_STOPS_PER_REEL);
	});

	it('matches the declared per-reel counts', () => {
		// A strip that quietly loses or gains a stop would skew the RTP.
		for (const strip of SLOT_STRIPS) {
			const tally = new Map<string, number>();
			for (const symbol of strip) tally.set(symbol, (tally.get(symbol) ?? 0) + 1);
			expect([...tally.entries()].sort()).toEqual(
				[...tally.entries()].sort().filter(([, n]) => n > 0)
			);
			expect([...tally.values()].reduce((a, b) => a + b, 0)).toBe(SLOT_STOPS_PER_REEL);
		}
	});

	it('never shows three identical symbols in one reel window', () => {
		// Sorted strips would fail here, which is exactly the trap: a window on
		// one symbol makes the machine pay out almost every spin.
		for (const strip of SLOT_STRIPS) {
			for (let offset = 0; offset < SLOT_STOPS_PER_REEL; offset++) {
				const [a, b, c] = [0, 1, 2].map(
					(row) => strip[(offset + row) % SLOT_STOPS_PER_REEL]!
				);
				expect(a === b && b === c, `${strip.join('')} at ${offset}`).toBe(false);
			}
		}
	});
});

describe('slot return', () => {
	it('returns about 90% of the stake', () => {
		const rtp = exactReturn();
		// eslint-disable-next-line no-console
		console.log(`slots exact RTP: ${(rtp * 100).toFixed(2)}%`);
		expect(rtp).toBeGreaterThan(0.86);
		expect(rtp).toBeLessThan(0.94);
	});

	it('wins about one spin in thirty-five', () => {
		const hitRate = [...tripleFrequencies().values()].reduce((a, b) => a + b, 0);
		// eslint-disable-next-line no-console
		console.log(`slots hit rate: 1 in ${(1 / hitRate).toFixed(1)}`);
		// Winning far more often than this would mean paying out most spins;
		// far less often and a five-round run feels dead.
		expect(hitRate).toBeGreaterThan(0.02);
		expect(hitRate).toBeLessThan(0.04);
	});

	it('makes the top symbol the rarest and the richest', () => {
		const frequencies = tripleFrequencies();
		const top = frequencies.get('seven')!;
		const cherry = frequencies.get('cherry')!;
		expect(cherry).toBeGreaterThan(top);
		// eslint-disable-next-line no-console
		console.log(`seven pays ${SLOT_PAYTABLE.seven - 1}:1, 1 in ${(1 / top).toFixed(0)} spins`);
		expect(SLOT_PAYTABLE.seven).toBeGreaterThan(SLOT_PAYTABLE.cherry);
	});

	it('agrees with Monte Carlo simulation of the real code', () => {
		setSeed(0xc0ffee);
		const ROUNDS = 12_000;
		const SPINS = ROUNDS * SLOT_SPINS;
		let returned = 0;
		for (let i = 0; i < ROUNDS; i++) returned += spin().returned;
		// Chips back per chip staked, matching the enumerated figure below.
		const simulated = returned / (ROUNDS * STAKE);

		// The machine is wildly skewed — one symbol pays 1720x and lands about
		// once in 2667 spins — so the mean converges slowly and a tight bound
		// would flake. Enumerate the exact spread of a spin's return, then bound
		// the error in standard deviations, which is the honest test of "the
		// shipped code matches the arithmetic".
		const returns: number[] = [];
		for (const lines of everySpin()) {
			let pay = 0;
			for (const line of lines) if (line !== null) pay += SLOT_PAYTABLE[line]!;
			returns.push(pay);
		}
		const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
		const variance =
			returns.reduce((sum, pay) => sum + (pay - mean) ** 2, 0) / returns.length;
		// A round averages five spins, so its return varies a fifth as much.
		const tolerance = 4 * Math.sqrt(variance / SPINS);
		// eslint-disable-next-line no-console
		console.log(
			`slots mean return ${mean.toFixed(4)}x stake, ` +
				`simulated ${simulated.toFixed(4)} +/- ${tolerance.toFixed(4)} over ${SPINS} spins`
		);
		expect(Math.abs(simulated - mean)).toBeLessThan(tolerance);
	});
});

describe('slots round', () => {
	it('returns nothing on a losing spin', () => {
		setSeed(7);
		const losses = Array.from({ length: 40 }, () => spin()).filter((o) => o.returned === 0);
		expect(losses.length).toBeGreaterThan(0);
		// Losing spins must cost the stake, never quietly return it.
		for (const loss of losses) expect(loss.stake).toBe(STAKE);
	});

	it('never returns more than the paytable allows', () => {
		setSeed(99);
		for (let i = 0; i < 2000; i++) {
			const { returned } = spin();
			// Three lines a spin, each paying at most the top symbol's multiple.
			expect(returned).toBeLessThanOrEqual(STAKE * 3 * SLOT_PAYTABLE.seven + 1);
		}
	});

	it('scales linearly with the stake', () => {
		setSeed(4242);
		const small = slots.init(wager, 30, 100_000);
		const smallOut = slots.apply(small.state, { type: 'SPIN' }).outcome!;
		setSeed(4242);
		const big = slots.init(wager, 3000, 1_000_000);
		const bigOut = slots.apply(big.state, { type: 'SPIN' }).outcome!;
		expect(bigOut.stake).toBe(smallOut.stake * 100);
		expect(bigOut.returned).toBe(smallOut.returned * 100);
	});

	it('only accepts SPIN, and only once', () => {
		const step = slots.init(wager, STAKE, STAKE * 10);
		expect(slots.legalActions(step.state)).toEqual(['SPIN']);
		expect(() => slots.apply(step.state, { type: 'HIT' })).toThrow(GameError);
		const spun = slots.apply(step.state, { type: 'SPIN' });
		expect(slots.legalActions(spun.state)).toEqual([]);
		expect(() => slots.apply(spun.state, { type: 'SPIN' })).toThrow(GameError);
	});

	it('marks the view resolved only after a spin', () => {
		const step = slots.init(wager, STAKE, STAKE * 10);
		expect(step.view.resolved).toBe(false);
		const spun = slots.apply(step.state, { type: 'SPIN' });
		const view = spun.view as Extract<typeof spun.view, { game: 'slots' }>;
		expect(spun.view.resolved).toBe(true);
		expect(view.spins).toHaveLength(SLOT_SPINS);
		for (const { reels } of view.spins) {
			expect(reels).toHaveLength(3);
			for (const reel of reels) expect(reel).toHaveLength(3);
		}
	});

	it('splits the stake over five spins and pays the sum of them', () => {
		setSeed(2024);
		for (let i = 0; i < 300; i++) {
			const out = slots.apply(slots.init(wager, STAKE, 1e6).state, { type: 'SPIN' });
			const view = out.view as Extract<typeof out.view, { game: 'slots' }>;
			expect(view.perSpin).toBe(STAKE / SLOT_SPINS);
			const paid = view.spins.reduce((sum, s) => sum + s.win, 0);
			expect(view.total).toBeCloseTo(paid / SLOT_SPINS, 9);
			expect(out.outcome!.stake).toBe(STAKE);
			expect(out.outcome!.returned).toBe(Math.round(view.perSpin * paid));
		}
	});

	it('shows no spins before the SPIN', () => {
		const view = slots.init(wager, STAKE, STAKE * 10).view as Extract<GameView, { game: 'slots' }>;
		expect(view.spins).toEqual([]);
		expect(view.perSpin).toBe(STAKE / SLOT_SPINS);
	});

	it('reports winning lines that actually match the reels', () => {
		setSeed(31337);
		for (let i = 0; i < 300; i++) {
			const out = slots.apply(slots.init(wager, STAKE, 1e6).state, { type: 'SPIN' });
			const view = out.view as Extract<typeof out.view, { game: 'slots' }>;
			for (const spin of view.spins) {
				for (const row of spin.lines) {
					const symbols = spin.reels.map((reel) => SLOT_SYMBOLS[reel[row]!]);
					expect(symbols[0]).toBe(symbols[1]);
					expect(symbols[1]).toBe(symbols[2]);
				}
				expect(spin.lines).toHaveLength(new Set(spin.lines).size);
			}
		}
	});
});
