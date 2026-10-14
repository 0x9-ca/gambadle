/**
 * Roulette — European single zero, numbers 0-36.
 *
 * The single zero halves the house edge versus the American wheel, from 5.26%
 * to 2.70%, which is the version a player should be given.
 *
 * Supported bets, with their payouts:
 *   straight (35:1), red/black/odd/even/low/high (1:1), dozen and column (2:1).
 * Splits, streets and corner bets are left out to keep the felt readable.
 *
 * A wager is any number of chips on different spots, each a whole number of
 * chips and each settled on its own. The round's stake is their sum, and a
 * losing spot returns nothing even when another spot on the same spin wins.
 */

import type { Action, GameView, RouletteBet, RouletteChip, Wager } from '../../shared/protocol';
import { randomInt } from '../rng';
import { GameError, type GameHandler, type Step } from './types';

const MAX_NUMBER = 36;

/** Red numbers on a European wheel. Zero is green and not in this set. */
const RED = new Set([
	1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const colorOf = (n: number): 'red' | 'black' | 'green' =>
	n === 0 ? 'green' : RED.has(n) ? 'red' : 'black';

/** Most distinct spots on one spin; the felt has 49 and nobody needs them all. */
const MAX_SPOTS = 49;

interface RouletteState {
	/** Total chips across every spot. */
	bet: number;
	chips: RouletteChip[];
	number: number | null;
}

function validate(bet: RouletteBet): RouletteBet {
	switch (bet.kind) {
		case 'straight': {
			const { number } = bet;
			if (!Number.isInteger(number) || number < 0 || number > MAX_NUMBER) {
				throw new GameError('invalid_wager', `straight bet must be 0-${MAX_NUMBER}`);
			}
			return { kind: 'straight', number };
		}
		case 'red':
		case 'black':
		case 'odd':
		case 'even':
		case 'low':
		case 'high':
			return { kind: bet.kind };
		case 'dozen': {
			const { dozen } = bet;
			if (dozen !== 1 && dozen !== 2 && dozen !== 3) {
				throw new GameError('invalid_wager', 'dozen must be 1, 2 or 3');
			}
			return { kind: 'dozen', dozen };
		}
		case 'column': {
			const { column } = bet;
			if (column !== 1 && column !== 2 && column !== 3) {
				throw new GameError('invalid_wager', 'column must be 1, 2 or 3');
			}
			return { kind: 'column', column };
		}
		default:
			throw new GameError('invalid_wager', 'unknown roulette bet');
	}
}

/**
 * Returns the profit multiplier, or 0 for a loss.
 * A 1:1 bet returns 1, a 2:1 bet returns 2, a 35:1 bet returns 35.
 */
function profitMultiplier(wager: RouletteBet, n: number): number {
	const color = colorOf(n);
	switch (wager.kind) {
		case 'straight':
			return n === wager.number ? 35 : 0;
		case 'red':
			return color === 'red' ? 1 : 0;
		case 'black':
			return color === 'black' ? 1 : 0;
		case 'odd':
			return n !== 0 && n % 2 === 1 ? 1 : 0;
		case 'even':
			return n !== 0 && n % 2 === 0 ? 1 : 0;
		case 'low':
			return n >= 1 && n <= 18 ? 1 : 0;
		case 'high':
			return n >= 19 && n <= 36 ? 1 : 0;
		case 'dozen': {
			if (n === 0) return 0;
			const dozen = Math.floor((n - 1) / 12) + 1;
			return dozen === wager.dozen ? 2 : 0;
		}
		case 'column': {
			if (n === 0) return 0;
			// Column 1 is 1,4,7..., i.e. numbers where (n-1) % 3 === 0.
			const column = ((n - 1) % 3) + 1;
			return column === wager.column ? 2 : 0;
		}
	}
}

function describe(wager: RouletteBet): string {
	switch (wager.kind) {
		case 'straight':
			return `straight up on ${wager.number}`;
		case 'dozen':
			return `${wager.dozen === 1 ? '1st' : wager.dozen === 2 ? '2nd' : '3rd'} dozen`;
		case 'column':
			return `column ${wager.column}`;
		default:
			return wager.kind;
	}
}

function view(s: RouletteState): GameView {
	const n = s.number ?? 0;
	return {
		game: 'roulette',
		resolved: s.number !== null,
		number: n,
		color: colorOf(n),
		won: s.number !== null && settle(s.chips, n).returned > s.bet,
	};
}

/** Settles every spot against a number. */
function settle(chips: readonly RouletteChip[], n: number): { returned: number; won: RouletteChip[]; lost: RouletteChip[] } {
	let returned = 0;
	const won: RouletteChip[] = [];
	const lost: RouletteChip[] = [];
	for (const chip of chips) {
		const profit = profitMultiplier(chip.bet, n);
		if (profit > 0) {
			// `profit` is profit odds (1 for even-money, 35 for straight-up), so a
			// winning spot returns its stake plus profit while a loss returns nothing.
			returned += chip.amount * (1 + profit);
			won.push(chip);
		} else {
			lost.push(chip);
		}
	}
	return { returned, won, lost };
}

const spots = (chips: readonly RouletteChip[]): string =>
	chips.map((c) => `${describe(c.bet)} (${c.amount})`).join(', ');

/** Validates every spot and merges chips placed on the same spot. */
function normalize(chips: unknown): RouletteChip[] {
	if (!Array.isArray(chips) || chips.length === 0) {
		throw new GameError('invalid_wager', 'place at least one chip');
	}
	const merged = new Map<string, RouletteChip>();
	for (const raw of chips as RouletteChip[]) {
		if (!raw || typeof raw !== 'object') throw new GameError('invalid_wager', 'bad roulette chip');
		const bet = validate(raw.bet);
		if (!Number.isInteger(raw.amount) || raw.amount < 1) {
			throw new GameError('invalid_wager', 'each spot needs a whole number of chips');
		}
		const key = JSON.stringify(bet);
		const existing = merged.get(key);
		if (existing) existing.amount += raw.amount;
		else merged.set(key, { bet, amount: raw.amount });
	}
	if (merged.size > MAX_SPOTS) throw new GameError('invalid_wager', 'too many spots');
	return [...merged.values()];
}

const totalOf = (chips: readonly RouletteChip[]): number => chips.reduce((sum, c) => sum + c.amount, 0);

export const roulette: GameHandler = {
	id: 'roulette',
	title: 'Roulette',

	/** `bet` is the table limit: the most the player may spread over the spots. */
	parseWager(wager: Wager, bet: number, stack: number): Wager {
		if (wager.game !== 'roulette') {
			throw new GameError('invalid_wager', 'not a roulette wager');
		}
		const chips = normalize(wager.bets);
		if (totalOf(chips) > Math.min(bet, stack)) {
			throw new GameError('invalid_wager', 'chips placed exceed the amount you brought to the table');
		}
		return { game: 'roulette', bets: chips };
	},

	stakeOf(wager: Wager): number {
		return wager.game === 'roulette' ? totalOf(wager.bets) : 0;
	},

	init(wager: Wager): Step {
		if (wager.game !== 'roulette') {
			throw new GameError('invalid_wager', 'not a roulette wager');
		}
		const chips = normalize(wager.bets);
		const state: RouletteState = { bet: totalOf(chips), chips, number: null };
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'SPIN'> {
		const s = state as RouletteState;
		return s.number === null ? ['SPIN'] : [];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as RouletteState;
		if (action.type !== 'SPIN') {
			throw new GameError('invalid_action', 'roulette only accepts SPIN');
		}
		if (s.number !== null) {
			throw new GameError('illegal_action', 'this spin is already done');
		}

		s.number = randomInt(MAX_NUMBER + 1);
		const { returned, won, lost } = settle(s.chips, s.number);
		const head = `${s.number} ${colorOf(s.number)}`;
		const parts: string[] = [];
		if (won.length > 0) parts.push(`${spots(won)} won`);
		if (lost.length > 0) parts.push(`${spots(lost)} lost`);

		return {
			state: s,
			view: view(s),
			outcome: { stake: s.bet, returned, detail: `${head} — ${parts.join('; ')}` },
		};
	},

	view,
};
