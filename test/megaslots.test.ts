/**
 * Mega Slots: the machine's shape, how a payline is read, the exact return,
 * and a sampled check that the shipped game pays what the arithmetic says.
 *
 * The return is exact (see `exactReturn`): every payline sees the same symbol
 * distribution, so forty lines return one line's expected pay per stake, and
 * scatters and free spins follow from one scatter per reel. The sample below
 * then plays the real handler and checks it lands within a few standard errors.
 */

import { describe, expect, it } from 'vitest';
import {
	MEGA_FREE_MULTIPLIER,
	MEGA_FREE_SPINS,
	MEGA_LINES,
	MEGA_REELS,
	MEGA_ROWS,
	MEGA_STOPS,
	MEGA_STRIP_COUNTS,
	MEGA_STRIPS,
	MEGA_SYMBOLS,
	type MegaSymbol,
} from '../shared/megaslots';
import { SLOT_SPINS } from '../shared/games';
import type { GameView } from '../shared/protocol';
import { exactReturn, lineHit, megaslots } from '../worker/games/megaslots';

type V = Extract<GameView, { game: 'megaslots' }>;

describe('Mega Slots machine', () => {
	it('has forty distinct paylines inside the window', () => {
		expect(MEGA_LINES).toHaveLength(40);
		expect(new Set(MEGA_LINES.map((l) => l.join(''))).size).toBe(40);
		for (const line of MEGA_LINES) {
			expect(line).toHaveLength(MEGA_REELS);
			for (const row of line) expect(row >= 0 && row < MEGA_ROWS).toBe(true);
		}
	});

	it('builds each strip from its counts, with at most one scatter and no wild on the end reels', () => {
		MEGA_STRIPS.forEach((strip, reel) => {
			expect(strip).toHaveLength(MEGA_STOPS);
			for (const symbol of MEGA_SYMBOLS) {
				expect(strip.filter((s) => s === symbol).length).toBe(MEGA_STRIP_COUNTS[reel]![symbol]);
			}
			expect(strip.filter((s) => s === 'scatter').length).toBeLessThanOrEqual(1);
		});
		expect(MEGA_STRIP_COUNTS[0]!.wild).toBe(0);
		expect(MEGA_STRIP_COUNTS[4]!.wild).toBe(0);
	});
});

describe('reading a payline', () => {
	const line = (text: string) => lineHit(text.split(' ') as MegaSymbol[]);

	it('pays three, four or five in a row from the first reel only', () => {
		expect(line('ten ten ten king ace')).toEqual({ symbol: 'ten', count: 3, pay: 7 });
		expect(line('king king king king ace')).toEqual({ symbol: 'king', count: 4, pay: 30 });
		expect(line('seven seven seven seven seven')).toEqual({ symbol: 'seven', count: 5, pay: 2000 });
		expect(line('ten ten ace ten ten')).toBeNull();
		expect(line('ace ten ten ten ten')).toBeNull();
	});

	it('lets wild stand in, and pays a run of wilds alone when that is worth more', () => {
		expect(line('queen wild queen jack ten')).toEqual({ symbol: 'queen', count: 3, pay: 9 });
		expect(line('ace wild wild wild ten')).toEqual({ symbol: 'ace', count: 4, pay: 40 });
		// Three wilds (75) beat four tens through them (20).
		expect(line('wild wild wild ten jack')).toEqual({ symbol: 'wild', count: 3, pay: 75 });
		expect(line('wild wild wild seven seven')).toEqual({ symbol: 'seven', count: 5, pay: 2000 });
	});

	it('never lets wild or a line pay through a scatter', () => {
		expect(line('scatter scatter scatter ten ten')).toBeNull();
		expect(line('ten wild scatter ten ten')).toBeNull();
	});
});

describe('Mega Slots return', () => {
	it('returns about 92% exactly', () => {
		const r = exactReturn();
		process.stdout.write(
			`Mega Slots exact return: ${(r.total * 100).toFixed(2)}% (lines ${(r.lines * 100).toFixed(2)}, scatters ${(r.scatters * 100).toFixed(2)}, free spins ${(r.freeSpins * 100).toFixed(2)}; free spins every ${(1 / r.trigger).toFixed(1)} spins)\n`
		);
		expect(r.total).toBeGreaterThan(0.915);
		expect(r.total).toBeLessThan(0.925);
	});

	it('plays what the arithmetic says', { timeout: 120_000 }, () => {
		const bet = 4000; // large, so whole-chip rounding is negligible
		const rounds = 12_000; // five spins each: the same 60,000 spins as before
		let sum = 0;
		let squares = 0;
		for (let i = 0; i < rounds; i++) {
			const out = megaslots.apply(megaslots.init({ game: 'megaslots' }, bet, bet).state, { type: 'SPIN' }).outcome!;
			const r = out.returned / bet;
			sum += r;
			squares += r * r;
		}
		const mean = sum / rounds;
		const se = Math.sqrt((squares / rounds - mean * mean) / rounds);
		const exact = exactReturn().total;
		process.stdout.write(`Mega Slots sampled: ${(mean * 100).toFixed(2)}% ± ${(se * 100).toFixed(2)} over ${rounds} rounds of ${SLOT_SPINS} spins\n`);
		expect(Math.abs(mean - exact)).toBeLessThan(5 * se);
	});
});

describe('Mega Slots rounds', () => {
	it('starts unspun and settles in one spin', () => {
		const step = megaslots.init({ game: 'megaslots' }, 100, 1000);
		expect(step.view.resolved).toBe(false);
		expect(megaslots.legalActions(step.state)).toEqual(['SPIN']);
		const done = megaslots.apply(step.state, { type: 'SPIN' });
		expect(done.view.resolved).toBe(true);
		expect(done.outcome!.stake).toBe(100);
		expect(megaslots.legalActions(done.state)).toEqual([]);
		expect(() => megaslots.apply(done.state, { type: 'SPIN' })).toThrow();
	});

	it('pays every spin with its free spins at their multiplier, averaged over five and rounded once', () => {
		let found = false;
		for (let i = 0; i < 2000; i++) {
			const done = megaslots.apply(megaslots.init({ game: 'megaslots' }, 250, 1000).state, { type: 'SPIN' });
			const view = done.view as V;
			expect(view.rounds).toHaveLength(SLOT_SPINS);
			expect(view.perSpin).toBe(250 / SLOT_SPINS);
			let sum = 0;
			for (const round of view.rounds) {
				const own = round.base.win + round.free.reduce((acc, s) => acc + s.win * MEGA_FREE_MULTIPLIER, 0);
				expect(round.total).toBeCloseTo(own, 9);
				sum += own;
				// Free spins come only from three or more scatters on the paid spin.
				expect(round.free).toHaveLength(round.base.scatters >= 3 ? MEGA_FREE_SPINS : 0);
				if (round.free.length > 0) found = true;
			}
			expect(view.total).toBeCloseTo(sum / SLOT_SPINS, 9);
			expect(done.outcome!.returned).toBe(Math.round(250 * (sum / SLOT_SPINS)));
			if (view.rounds.some((r) => r.free.length > 0)) expect(done.outcome!.detail).toContain('free spins');
		}
		expect(found).toBe(true);
	});

	it('reports each hit with its line, run and pay', () => {
		for (let i = 0; i < 100; i++) {
			const view = megaslots.apply(megaslots.init({ game: 'megaslots' }, 100, 1000).state, { type: 'SPIN' }).view as V;
			for (const { base } of view.rounds) {
				for (const hit of base.hits) {
					const symbols = MEGA_LINES[hit.line]!.map((row, reel) => MEGA_SYMBOLS[base.grid[reel]![row]!]!);
					expect(lineHit(symbols)).toEqual({ symbol: MEGA_SYMBOLS[hit.symbol], count: hit.count, pay: hit.pay });
				}
			}
		}
	});

	it('shows no spins before the SPIN', () => {
		const view = megaslots.init({ game: 'megaslots' }, 100, 1000).view as V;
		expect(view.rounds).toEqual([]);
		expect(view.perSpin).toBe(100 / SLOT_SPINS);
	});
});
