/**
 * Dice — one roll of two six-sided dice against a roll-under target.
 *
 * A single wager shape: "will the total come up N or lower?". The target runs
 * 2-9 and the payout is priced from the exact number of two-dice combinations
 * that win (see rollUnderMultiplier in shared/games.ts), less a 3% edge. There
 * is no push.
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
	const { target } = bet;
	if (!Number.isInteger(target) || target < MIN_TARGET || target > MAX_TARGET) {
		throw new GameError('invalid_wager', `roll-under target must be ${MIN_TARGET}-${MAX_TARGET}`);
	}
	return { kind: 'roll_under', target };
}

function view(s: DiceState): GameView {
	return {
		game: 'dice',
		resolved: s.roll !== null,
		roll: s.roll ?? 0,
		dice: s.dice ?? [],
		won: s.roll !== null && s.roll <= s.wager.target,
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
		const total = rollUnderMultiplier(target);

		if (s.roll <= target) {
			// `total` already includes the stake, so this is the whole payout.
			return {
				state: s,
				view: view(s),
				outcome: {
					stake: s.bet,
					// Fractional multipliers are truncated to whole chips.
					returned: Math.floor(s.bet * total),
					detail: `${s.roll} is ${target} or lower — pays ${+(total - 1).toFixed(2)}:1`,
				},
			};
		}
		return {
			state: s,
			view: view(s),
			outcome: {
				stake: s.bet,
				returned: 0,
				detail: `${s.roll} is above ${target}`,
			},
		};
	},

	view,
};
