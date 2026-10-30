/**
 * Mega Slots — five reels of five, forty paylines, wilds, scatters, free spins,
 * five spins to a round.
 *
 * The stake is split evenly over `SLOT_SPINS` paid spins (the player picks the
 * bet per spin), each with its own free spins, and the one SPIN deals them all,
 * so the round stays a single roll for the daily seed. Everything below speaks
 * of one spin's bet; the round's return is the sum over the spins divided by
 * their number, which leaves the return per chip as it was for a single spin.
 *
 * A spin stops each reel at a random offset; the window shows five consecutive
 * stops. Each payline pays its best left-to-right run from the first reel:
 * three, four or five of a symbol, with Wild standing in for any paying symbol
 * (a run of wilds alone pays the Wild row if that is worth more). Line pays are
 * multiples of the line bet, the stake divided across the forty lines.
 *
 * Scatters pay anywhere, as multiples of the whole stake, and three or more
 * also award free spins: more spins on the same strips at no cost, every win
 * multiplied. Free spins cannot retrigger. They are all drawn inside the one
 * SPIN, so the round is a single roll (which the daily seed relies on).
 *
 * The return is computed exactly, not sampled, by `exactReturn` below; see
 * test/megaslots.test.ts. The round's total is rounded to the nearest whole chip
 * once, which keeps small bets (a line bet of 1.25 chips, say) on the same
 * return on average; flooring would shave up to a chip off every win.
 */

import {
	MEGA_FREE_MULTIPLIER,
	MEGA_FREE_SPINS,
	MEGA_LINES,
	MEGA_PAYS,
	MEGA_REELS,
	MEGA_ROWS,
	MEGA_SCATTER,
	MEGA_SCATTER_PAYS,
	MEGA_STOPS,
	MEGA_STRIP_COUNTS,
	MEGA_STRIPS,
	MEGA_SYMBOLS,
	MEGA_WILD,
	type MegaSymbol,
} from '../../shared/megaslots';
import { SLOT_SPINS } from '../../shared/games';
import type { Action, GameView, MegaRoundView, MegaSpinView, Wager } from '../../shared/protocol';
import { randomInt } from '../rng';
import { GameError, type GameHandler, type Step } from './types';

/** The best run on one payline, or null. `pay` is in line bets. */
export interface LineHit {
	symbol: MegaSymbol;
	count: number;
	pay: number;
}

const payFor = (symbol: MegaSymbol, count: number): number =>
	count >= 3 ? (MEGA_PAYS[symbol]?.[count - 3] ?? 0) : 0;

/** Evaluates the five symbols a payline crosses, left to right. */
export function lineHit(symbols: readonly MegaSymbol[]): LineHit | null {
	// Leading wilds pay on their own, and also join whatever symbol follows them.
	let wilds = 0;
	while (wilds < symbols.length && symbols[wilds] === MEGA_WILD) wilds++;
	const wildPay = payFor(MEGA_WILD, wilds);

	const base = symbols[wilds];
	let best: LineHit | null = wildPay > 0 ? { symbol: MEGA_WILD, count: wilds, pay: wildPay } : null;
	if (base !== undefined && base !== MEGA_SCATTER) {
		let count = wilds;
		while (count < symbols.length && (symbols[count] === base || symbols[count] === MEGA_WILD)) count++;
		const pay = payFor(base, count);
		if (pay > 0 && (best === null || pay > best.pay)) best = { symbol: base, count, pay };
	}
	return best;
}

/** A stopped spin: the window by reel, top to bottom, and what it pays. */
export interface Spin {
	grid: MegaSymbol[][];
	/** Winning lines by index into MEGA_LINES. */
	hits: { line: number; hit: LineHit }[];
	scatters: number;
	/** Line pays in line bets, summed. */
	linePay: number;
	/** Scatter pay as a multiple of the whole stake. */
	scatterPay: number;
}

export function evaluate(grid: MegaSymbol[][]): Spin {
	const hits: Spin['hits'] = [];
	let linePay = 0;
	MEGA_LINES.forEach((rows, line) => {
		const hit = lineHit(rows.map((row, reel) => grid[reel]![row]!));
		if (hit) {
			hits.push({ line, hit });
			linePay += hit.pay;
		}
	});
	const scatters = grid.flat().filter((s) => s === MEGA_SCATTER).length;
	return { grid, hits, scatters, linePay, scatterPay: MEGA_SCATTER_PAYS[scatters] ?? 0 };
}

/** The window for a set of reel offsets. */
export function windowAt(offsets: readonly number[]): MegaSymbol[][] {
	return offsets.map((offset, reel) =>
		Array.from({ length: MEGA_ROWS }, (_, row) => MEGA_STRIPS[reel]![(offset + row) % MEGA_STOPS]!)
	);
}

function spinOnce(): Spin {
	return evaluate(windowAt(Array.from({ length: MEGA_REELS }, () => randomInt(MEGA_STOPS))));
}

/** A spin's win as a multiple of the whole stake. */
const spinMultiple = (spin: Spin): number => spin.linePay / MEGA_LINES.length + spin.scatterPay;

// ---------------------------------------------------------------------------
// Exact return
// ---------------------------------------------------------------------------

/**
 * The machine's return per chip staked, computed exactly from the strips.
 *
 * - Lines: every reel's stop is uniform and independent, so each cell of the
 *   window is a uniform draw from its reel's strip, and every payline sees the
 *   same distribution. By linearity of expectation the forty lines together
 *   return exactly one line's expected pay (in line bets) per stake, whatever
 *   the correlations between lines. That expectation is summed over all 12^5
 *   symbol combinations a line can show.
 * - Scatters: each reel holds one scatter, so each shows it with probability
 *   5/40 independently, and the count is a sum over the reels.
 * - Free spins: triggered with the probability of 3+ scatters, each worth the
 *   multiplier times a base spin's line and scatter pays (no retrigger).
 */
export function exactReturn(): { lines: number; scatters: number; freeSpins: number; trigger: number; total: number } {
	const probs = MEGA_STRIP_COUNTS.map((counts) =>
		MEGA_SYMBOLS.map((symbol) => [symbol, counts[symbol] / MEGA_STOPS] as const).filter(([, p]) => p > 0)
	);
	let lines = 0;
	const walk = (reel: number, symbols: MegaSymbol[], p: number) => {
		if (reel === MEGA_REELS) {
			lines += p * (lineHit(symbols)?.pay ?? 0);
			return;
		}
		for (const [symbol, q] of probs[reel]!) walk(reel + 1, [...symbols, symbol], p * q);
	};
	walk(0, [], 1);

	// Distribution of the scatter count across the reels.
	let dist = [1];
	for (const counts of MEGA_STRIP_COUNTS) {
		const p = (counts.scatter * MEGA_ROWS) / MEGA_STOPS;
		const next = new Array(dist.length + 1).fill(0) as number[];
		dist.forEach((q, k) => {
			next[k] += q * (1 - p);
			next[k + 1] += q * p;
		});
		dist = next;
	}
	const scatters = dist.reduce((sum, q, k) => sum + q * (MEGA_SCATTER_PAYS[k] ?? 0), 0);
	const trigger = dist.slice(3).reduce((a, b) => a + b, 0);
	const freeSpins = trigger * MEGA_FREE_SPINS * MEGA_FREE_MULTIPLIER * (lines + scatters);

	return { lines, scatters, freeSpins, trigger, total: lines + scatters + freeSpins };
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

/** A paid spin and the free spins it won. */
interface MegaRound {
	base: Spin;
	free: Spin[];
}

interface MegaState {
	bet: number;
	/** Null until the SPIN; then one entry per paid spin. */
	rounds: MegaRound[] | null;
}

function spinView(spin: Spin): MegaSpinView {
	return {
		grid: spin.grid.map((reel) => reel.map((symbol) => MEGA_SYMBOLS.indexOf(symbol))),
		hits: spin.hits.map(({ line, hit }) => ({ line, symbol: MEGA_SYMBOLS.indexOf(hit.symbol), count: hit.count, pay: hit.pay })),
		scatters: spin.scatters,
		win: spinMultiple(spin),
	};
}

/** One paid spin's win as a multiple of its own bet: the spin plus its free spins at their multiplier. */
const roundMultiple = (round: MegaRound): number =>
	spinMultiple(round.base) + round.free.reduce((sum, spin) => sum + spinMultiple(spin) * MEGA_FREE_MULTIPLIER, 0);

/** Total win as a multiple of the whole stake. */
const totalMultiple = (rounds: readonly MegaRound[]): number =>
	rounds.reduce((sum, round) => sum + roundMultiple(round), 0) / SLOT_SPINS;

function roundView(round: MegaRound): MegaRoundView {
	return { base: spinView(round.base), free: round.free.map(spinView), total: roundMultiple(round) };
}

function view(s: MegaState): GameView {
	return {
		game: 'megaslots',
		resolved: s.rounds !== null,
		rounds: (s.rounds ?? []).map(roundView),
		perSpin: s.bet / SLOT_SPINS,
		total: totalMultiple(s.rounds ?? []),
	};
}

function describe(rounds: readonly MegaRound[], returned: number, bet: number): string {
	const lined = rounds.filter((r) => r.base.hits.length > 0).length;
	const bonuses = rounds.filter((r) => r.free.length > 0).length;
	const parts: string[] = [];
	if (lined > 0) parts.push(`${lined} of ${SLOT_SPINS} spins paid on lines`);
	if (bonuses > 0) parts.push(`${bonuses} free spins bonus${bonuses === 1 ? '' : 'es'} at ×${MEGA_FREE_MULTIPLIER}`);
	if (parts.length === 0 && returned === 0) return 'No win';
	const ratio = returned / bet;
	const shown = `pays ${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(2).replace(/\.?0+$/, '')}× your bet`;
	return parts.length > 0 ? `${parts.join(', ')} — ${shown}` : `Scatters — ${shown}`;
}

export const megaslots: GameHandler = {
	id: 'megaslots',
	title: 'Mega Slots',

	parseWager(wager: Wager): Wager {
		if (wager.game !== 'megaslots') throw new GameError('invalid_wager', 'not a Mega Slots wager');
		return { game: 'megaslots' };
	},

	init(_wager: Wager, bet: number): Step {
		const state: MegaState = { bet, rounds: null };
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'SPIN'> {
		return (state as MegaState).rounds === null ? ['SPIN'] : [];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as MegaState;
		if (action.type !== 'SPIN') throw new GameError('invalid_action', 'Mega Slots only accepts SPIN');
		if (s.rounds !== null) throw new GameError('illegal_action', 'these reels have already spun');

		s.rounds = Array.from({ length: SLOT_SPINS }, () => {
			const base = spinOnce();
			const free: Spin[] = [];
			if (base.scatters >= 3) {
				for (let i = 0; i < MEGA_FREE_SPINS; i++) free.push(spinOnce());
			}
			return { base, free };
		});
		// Rounded once for the whole round, so small line wins still add up.
		const returned = Math.round(s.bet * totalMultiple(s.rounds));
		return {
			state: s,
			view: view(s),
			outcome: { stake: s.bet, returned, detail: describe(s.rounds, returned, s.bet) },
		};
	},

	view,
};
