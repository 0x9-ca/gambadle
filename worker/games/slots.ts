/**
 * Slots — three reels, three rows, three paylines (top, middle, bottom), five
 * spins to a round.
 *
 * The stake is split evenly over `SLOT_SPINS` spins (the player picks the bet
 * per spin) and all five are dealt by the one SPIN, so the round stays a single
 * roll for the daily seed. The round's return is the sum of the spins' returns,
 * rounded once to whole chips, which leaves the machine's return per chip as
 * it was for a single spin.
 *
 * On each spin, any payline showing three of a kind pays `SLOT_PAYTABLE[symbol]` times the
 * whole stake, and a losing spin returns nothing. The strips and paytable live
 * in shared/games.ts so the client renders the same table, and
 * `test/slots.test.ts` enumerates every reel window to measure the return — the
 * house edge here is a closed-form number, not a guess.
 *
 * Each reel has its own distribution: reel 1 is heavy on cherries, reel 3 on the
 * big symbols. That is what makes the top payouts land about once in nine hundred
 * spins without needing silly odds on a single reel.
 */

import {
	SLOT_LINES,
	SLOT_PAYTABLE,
	SLOT_SPINS,
	SLOT_STOPS_PER_REEL,
	SLOT_STRIPS,
	SLOT_SYMBOLS,
	type SlotSymbol,
} from '../../shared/games';
import type { Action, GameView, SlotSpinView, Wager } from '../../shared/protocol';
import { randomInt } from '../rng';
import { GameError, type GameHandler, type Step } from './types';

// Widened to an array so it can be indexed by a symbol name; `SLOT_SYMBOLS` is
// declared `as const`, which would make it an unindexable tuple here.
const SYMBOLS: readonly SymbolId[] = SLOT_SYMBOLS;
type SymbolId = SlotSymbol;

const PAYTABLE = SLOT_PAYTABLE;

const REELS = 3;
const ROWS = 3;

/** A stopped reel: three visible symbols, top to bottom. */
interface ReelStop {
	/** Symbol ids by row, rows[0] is the top row. */
	rows: SymbolId[];
	/** Where the reel stopped, purely for the client's spin animation. */
	offset: number;
}

/** One stopped spin. */
interface SpinResult {
	reels: ReelStop[];
	/** Row indices of winning paylines. */
	winningRows: number[];
	/** Returned, as a multiple of this spin's own bet. */
	multiplier: number;
	wins: LineWin[];
}

interface SlotsState {
	bet: number;
	/** Null until the SPIN; then one entry per spin. */
	spins: SpinResult[] | null;
}

function spinReel(reel: number): ReelStop {
	const strip = SLOT_STRIPS[reel]!;
	const offset = randomInt(SLOT_STOPS_PER_REEL);
	// Three neighbouring stops, as on a real machine where the window shows
	// consecutive symbols rather than three independent draws.
	return {
		rows: [0, 1, 2].map((row) => strip[(offset + row) % SLOT_STOPS_PER_REEL]!),
		offset,
	};
}

/** One winning payline. */
interface LineWin {
	row: number;
	symbol: SymbolId;
	/** Return multiple of the line's own stake. */
	pay: number;
}

/** Evaluates a single payline: three matching symbols is the only way to win. */
function evalLine(reels: ReelStop[], row: number): LineWin | null {
	const [a, b, c] = [0, 1, 2].map((reel) => reels[reel]!.rows[row]!) as [
		SymbolId,
		SymbolId,
		SymbolId,
	];
	if (a === b && b === c) return { row, symbol: a, pay: PAYTABLE[a]! };
	return null;
}

function spinOnce(): SpinResult {
	const reels: ReelStop[] = [];
	for (let i = 0; i < REELS; i++) reels.push(spinReel(i));

	const wins: LineWin[] = [];
	for (let row = 0; row < ROWS; row++) {
		const win = evalLine(reels, row);
		if (win) wins.push(win);
	}

	// Every winning line pays the full table value, so two or three lines
	// pay two or three times as much.
	return {
		reels,
		winningRows: wins.map((win) => win.row),
		multiplier: wins.reduce((sum, win) => sum + win.pay, 0),
		wins,
	};
}

/** The round's return as a multiple of the whole stake. */
const totalMultiple = (spins: readonly SpinResult[]): number =>
	spins.reduce((sum, spin) => sum + spin.multiplier, 0) / SLOT_SPINS;

function spinView(spin: SpinResult): SlotSpinView {
	return {
		reels: spin.reels.map((reel) => reel.rows.map((symbol) => SYMBOLS.indexOf(symbol))),
		lines: spin.winningRows,
		win: spin.multiplier,
	};
}

function view(s: SlotsState): GameView {
	return {
		game: 'slots',
		resolved: s.spins !== null,
		spins: (s.spins ?? []).map(spinView),
		perSpin: s.bet / SLOT_SPINS,
		total: totalMultiple(s.spins ?? []),
	};
}

function describeSpins(spins: readonly SpinResult[], returned: number, bet: number): string {
	const winning = spins.filter((spin) => spin.wins.length > 0).length;
	if (winning === 0) return `No paylines in ${SLOT_SPINS} spins`;
	const best = spins.reduce((a, b) => (b.multiplier > a.multiplier ? b : a));
	const top = best.wins.reduce((a, b) => (b.pay > a.pay ? b : a));
	return `${winning} of ${SLOT_SPINS} spins paid, best ${top.symbol} on the ${rowName(top.row)} line — returned ${formatRatio(returned / bet)}× your stake`;
}

/** 2, 0.4 or 12.5 without trailing zeros. */
const formatRatio = (ratio: number): string => ratio.toFixed(2).replace(/\.?0+$/, '');

function rowName(row: number): string {
	return SLOT_LINES[row] ?? `line ${row}`;
}

export const slots: GameHandler = {
	id: 'slots',
	title: 'Slots',

	parseWager(wager: Wager): Wager {
		if (wager.game !== 'slots') throw new GameError('invalid_wager', 'not a slots wager');
		return { game: 'slots' };
	},

	init(_wager: Wager, bet: number): Step {
		const state: SlotsState = { bet, spins: null };
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'SPIN'> {
		const s = state as SlotsState;
		return s.spins === null ? ['SPIN'] : [];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as SlotsState;
		if (action.type !== 'SPIN') {
			throw new GameError('invalid_action', 'slots only accepts SPIN');
		}
		if (s.spins !== null) {
			throw new GameError('illegal_action', 'these reels are already spinning');
		}

		s.spins = Array.from({ length: SLOT_SPINS }, spinOnce);
		const returned = Math.round(s.bet * totalMultiple(s.spins));

		return {
			state: s,
			view: view(s),
			outcome: {
				stake: s.bet,
				returned,
				detail: describeSpins(s.spins, returned, s.bet),
			},
		};
	},

	view,
};