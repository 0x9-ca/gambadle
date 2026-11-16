/**
 * Dice — one roll of two six-sided dice against a roll-under target.
 *
 * A single wager shape: "will the total come up N or lower?". The target runs
 * 2-9 and the payout is priced from the exact number of two-dice combinations
 * that win (see rollUnderMultiplier in shared/games.ts), less a 3% edge. There
 * is no push. A win's return rounds UP to whole chips (the owner's call), so a
 * small winning bet always shows a profit; see `diceReturn`.
 */

import {
	DICE_MAX_TARGET,
	DICE_MIN_TARGET,
	DICE_COUNT,
	DICE_FACES,
	rollUnderMultiplier,
} from '../../shared/games';
import type { Action, DiceBet, GameView, Wager } from '../../shared/protocol';
import { randomBetween } from '../rng';
import { GameError, type GameHandler, type Step } from './types';

const MIN_TARGET = DICE_MIN_TARGET;
const MAX_TARGET = DICE_MAX_TARGET;

interface DiceState {
	bet: number;
	wager: DiceBet;
	/** Each die's face, so the client can draw both. */
	dice: number[] | null;
	roll: number | null;
}

function validate(bet: DiceBet): DiceBet {
	// A malformed body must be a 4xx, not a TypeError (500).
	if (!bet || typeof bet !== 'object') throw new GameError('invalid_wager', 'missing dice bet');
	const { target } = bet;
	if (!Number.isInteger(target) || target < MIN_TARGET || target > MAX_TARGET) {
		throw new GameError('invalid_wager', `roll-under target must be ${MIN_TARGET}-${MAX_TARGET}`);
	}
	return { kind: 'roll_under', target };
}

/**
 * Chips a winning bet returns, stake included: bet × multiplier rounded up to a
 * whole chip. The multiplier is a whole number of hundredths, so this stays in
 * integers: 100 * 2.32 is 231.99999999999997 in floating point.
 */
export function diceReturn(bet: number, target: number): number {
	const hundredths = Math.round(rollUnderMultiplier(target) * 100);
	return Math.ceil((bet * hundredths) / 100);
}

const chips = (n: number): string => `${n} ${n === 1 ? 'chip' : 'chips'}`;

function view(s: DiceState): GameView {
	return {
		game: 'dice',
		resolved: s.roll !== null,
		roll: s.roll ?? 0,
		dice: s.dice ?? [],
		won: s.roll !== null && s.roll <= s.wager.target,
		target: s.wager.target,
		bet: s.bet,
	};
}

export const dice: GameHandler = {
	id: 'dice',
	title: 'Dice',

	parseWager(wager: Wager): Wager {
		if (wager.game !== 'dice') throw new GameError('invalid_wager', 'not a dice wager');
		return { game: 'dice', bet: validate(wager.bet) };
	},

	init(wager: Wager, bet: number): Step {
		if (wager.game !== 'dice') throw new GameError('invalid_wager', 'not a dice wager');
		const state: DiceState = { bet, wager: validate(wager.bet), dice: null, roll: null };
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'ROLL'> {
		const s = state as DiceState;
		return s.roll === null ? ['ROLL'] : [];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as DiceState;
		if (action.type !== 'ROLL') {
			throw new GameError('invalid_action', 'dice only accepts ROLL');
		}
		if (s.roll !== null) {
			throw new GameError('illegal_action', 'this roll is already done');
		}

		s.dice = Array.from({ length: DICE_COUNT }, () => randomBetween(1, DICE_FACES));
		s.roll = s.dice.reduce((sum, d) => sum + d, 0);
		const { target } = s.wager;
		const needed = `Rolled ${s.roll}, needed ${target} or under`;

		if (s.roll <= target) {
			const returned = diceReturn(s.bet, target);
			const hundredths = Math.round(rollUnderMultiplier(target) * 100);
			const odds = +((hundredths - 100) / 100).toFixed(2);
			const rounded = (s.bet * hundredths) % 100 !== 0 ? ', rounded up' : '';
			return {
				state: s,
				view: view(s),
				outcome: {
					stake: s.bet,
					returned,
					detail: `${needed} — you win ${chips(returned - s.bet)} (pays ${odds}:1${rounded})`,
				},
			};
		}
		return {
			state: s,
			view: view(s),
			outcome: {
				stake: s.bet,
				returned: 0,
				detail: `${needed} — you lose`,
			},
		};
	},

	view,
};
