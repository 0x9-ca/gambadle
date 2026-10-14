/**
 * Coin flip — a single 1:1 wager on heads or tails.
 *
 * The simplest game in the rotation, and the reference implementation for the
 * "one action then done" shape that dice, roulette and slots also follow.
 */

import type { Action, GameView, Wager } from '../../shared/protocol';
import { random } from '../rng';
import { GameError, type GameHandler, type Step } from './types';

interface CoinFlipState {
	bet: number;
	side: 'heads' | 'tails';
	result: 'heads' | 'tails' | null;
}

function view(s: CoinFlipState): GameView {
	return {
		game: 'coinflip',
		resolved: s.result !== null,
		result: s.result ?? 'heads',
		won: s.result === s.side,
	};
}

export const coinflip: GameHandler = {
	id: 'coinflip',
	title: 'Coin Flip',

	parseWager(wager: Wager): Wager {
		if (wager.game !== 'coinflip') {
			throw new GameError('invalid_wager', 'not a coin flip wager');
		}
		const { side } = wager.bet;
		if (side !== 'heads' && side !== 'tails') {
			throw new GameError('invalid_wager', 'side must be heads or tails');
		}
		return { game: 'coinflip', bet: { side } };
	},

	init(wager: Wager, bet: number): Step {
		if (wager.game !== 'coinflip') {
			throw new GameError('invalid_wager', 'not a coin flip wager');
		}
		const state: CoinFlipState = { bet, side: wager.bet.side, result: null };
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'FLIP'> {
		const s = state as CoinFlipState;
		return s.result === null ? ['FLIP'] : [];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as CoinFlipState;
		if (action.type !== 'FLIP') {
			throw new GameError('invalid_action', 'coin flip only accepts FLIP');
		}
		if (s.result !== null) {
			throw new GameError('illegal_action', 'this flip is already done');
		}

		s.result = random() < 0.5 ? 'heads' : 'tails';
		const won = s.result === s.side;
		return {
			state: s,
			view: view(s),
			outcome: {
				stake: s.bet,
				returned: won ? s.bet * 2 : 0,
				detail: `${s.result === 'heads' ? 'Heads' : 'Tails'} — ${won ? 'you win' : 'you lose'}`,
			},
		};
	},

	view,
};