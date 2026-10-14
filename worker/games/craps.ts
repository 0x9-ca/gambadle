/**
 * Craps — one pass or don't pass bet played through, with free odds.
 *
 * The shooter rolls two dice. On the come-out roll a pass bet wins on 7 or 11
 * and loses on 2, 3 or 12; any other total becomes the point, and the shooter
 * keeps rolling until the point comes (pass wins) or a 7 (pass loses). A don't
 * pass bet is the opposite, except that a come-out 12 is a push ("bar 12").
 * House edge: 1.41% on pass, 1.36% on don't pass.
 *
 * Once a point is set the player may back the line bet with odds, up to
 * CRAPS_MAX_ODDS times the bet, at true odds, so the odds carry no edge. Odds
 * win whole chips only (6:5 on an odd amount rounds the profit down).
 *
 * An optional Field bet is settled by the first roll alone.
 *
 * Every roll is drawn in `init`, not in `apply`: each action runs under the
 * same seeded generator, so rolling inside `apply` would deal the same roll
 * every time. The rolls so far are all the view ever shows.
 */

import {
	CRAPS_FIELD,
	CRAPS_LAY_ODDS,
	CRAPS_MAX_ODDS,
	CRAPS_MAX_ROLLS,
	CRAPS_PASS_ODDS,
} from '../../shared/games';
import type { Action, ActionType, CrapsBet, GameView, Wager } from '../../shared/protocol';
import { randomInt } from '../rng';
import { GameError, type GameHandler, type Step } from './types';

interface CrapsState {
	bet: number;
	side: 'pass' | 'dontpass';
	field: number;
	/** Two dice per roll, flat. */
	rolls: number[];
	taken: number;
	point: number | null;
	odds: number;
	shown: { dice: [number, number]; total: number }[];
	fieldResult: { won: boolean; pays: number } | null;
	result: 'win' | 'lose' | 'push' | null;
	done: boolean;
}

type LineResult = 'win' | 'lose' | 'push';

/** All the rolls the round could use, two dice each, one draw per roll (36 equal outcomes). */
function dealRolls(): number[] {
	const rolls: number[] = [];
	for (let i = 0; i < CRAPS_MAX_ROLLS; i++) {
		const r = randomInt(36);
		rolls.push(Math.floor(r / 6) + 1, (r % 6) + 1);
	}
	return rolls;
}

function validate(bet: CrapsBet, stake: number, stack: number): CrapsBet {
	if (!bet || (bet.side !== 'pass' && bet.side !== 'dontpass')) {
		throw new GameError('invalid_wager', 'bet on the pass line or the don\'t pass bar');
	}
	if (!Number.isInteger(stake) || stake < 1) {
		throw new GameError('invalid_wager', 'the line bet must be a positive whole number');
	}
	// Odds are optional, but the stack must cover the most they could add, so
	// taking them can never put the player over what they have.
	const reserve = stake * (1 + CRAPS_MAX_ODDS);
	if (reserve > stack) {
		throw new GameError('invalid_wager', 'your line bet and its odds exceed your stack');
	}
	const normalized: CrapsBet = { side: bet.side };
	if (bet.field !== undefined && bet.field !== 0) {
		if (!Number.isInteger(bet.field) || bet.field < 0) {
			throw new GameError('invalid_wager', 'the Field bet must be a whole number of chips');
		}
		if (reserve + bet.field > stack) {
			throw new GameError('invalid_wager', 'your bets, odds and Field exceed your stack');
		}
		normalized.field = bet.field;
	}
	return normalized;
}

const ratioOf = (s: CrapsState, point: number): readonly [number, number] =>
	(s.side === 'pass' ? CRAPS_PASS_ODDS : CRAPS_LAY_ODDS)[point]!;

function view(s: CrapsState): GameView {
	const offer = s.point !== null && s.odds === 0 && !s.done;
	return {
		game: 'craps',
		resolved: s.done,
		side: s.side,
		point: s.point,
		rolls: s.shown,
		odds: s.odds,
		oddsOffer: offer
			? Array.from({ length: CRAPS_MAX_ODDS }, (_, i) => ({ multiple: i + 1, chips: s.bet * (i + 1) }))
			: [],
		oddsRatio: s.point !== null ? [...ratioOf(s, s.point)] as [number, number] : null,
		field: s.field > 0 ? { bet: s.field, won: s.fieldResult ? s.fieldResult.won : null, pays: s.fieldResult?.pays ?? 0 } : null,
		result: s.result,
	};
}

const pointName = (n: number) => String(n);

/** Settles the round given how the line bet ended. */
function settle(s: CrapsState, line: LineResult, why: string): Step {
	s.done = true;
	s.result = line;
	let returned = 0;
	const notes = [why];

	if (line === 'win') returned += s.bet * 2;
	else if (line === 'push') returned += s.bet;

	if (s.odds > 0) {
		const [win, per] = ratioOf(s, s.point!);
		if (line === 'win') {
			const profit = Math.floor((s.odds * win) / per);
			returned += s.odds + profit;
			notes.push(`odds pay ${win}:${per}`);
		} else if (line === 'push') {
			returned += s.odds;
		} else {
			notes.push('odds lost');
		}
	}

	if (s.field > 0) {
		if (s.fieldResult?.won) {
			returned += s.field * (1 + s.fieldResult.pays);
			notes.push(`Field pays ${s.fieldResult.pays}:1`);
		} else {
			notes.push('Field lost');
		}
	}

	return {
		state: s,
		view: view(s),
		outcome: { stake: s.bet + s.odds + s.field, returned, detail: notes.join(' — ') },
	};
}

export const craps: GameHandler = {
	id: 'craps',
	title: 'Craps',

	parseWager(wager: Wager, bet: number, stack: number): Wager {
		if (wager.game !== 'craps') throw new GameError('invalid_wager', 'not a craps wager');
		return { game: 'craps', bet: validate(wager.bet, bet, stack) };
	},

	init(wager: Wager, bet: number, stack: number): Step {
		if (wager.game !== 'craps') throw new GameError('invalid_wager', 'not a craps wager');
		const normalized = validate(wager.bet, bet, stack);
		const state: CrapsState = {
			bet,
			side: normalized.side,
			field: normalized.field ?? 0,
			rolls: dealRolls(),
			taken: 0,
			point: null,
			odds: 0,
			shown: [],
			fieldResult: null,
			result: null,
			done: false,
		};
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): ActionType[] {
		const s = state as CrapsState;
		if (s.done) return [];
		// Rolling comes first, so a bare "take the first action" always plays on.
		if (s.point !== null && s.odds === 0) return ['ROLL', 'BET_1X', 'BET_2X'];
		return ['ROLL'];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as CrapsState;
		if (s.done) throw new GameError('illegal_action', 'this round is already settled');
		const legal = craps.legalActions(s);
		if (!legal.includes(action.type)) {
			throw new GameError('illegal_action', `${action.type} is not legal here; expected ${legal.join(', ')}`);
		}

		if (action.type === 'BET_1X' || action.type === 'BET_2X') {
			s.odds = s.bet * (action.type === 'BET_1X' ? 1 : 2);
			return { state: s, view: view(s), outcome: null };
		}

		// If the dealt rolls ever ran out, hand every stake back rather than guess.
		if (s.taken >= CRAPS_MAX_ROLLS) {
			return settle(s, 'push', 'The table closed — bets returned');
		}
		const d1 = s.rolls[2 * s.taken]!;
		const d2 = s.rolls[2 * s.taken + 1]!;
		s.taken++;
		const total = d1 + d2;
		s.shown.push({ dice: [d1, d2], total });
		const pass = s.side === 'pass';

		if (s.point === null) {
			// The Field is decided by the first roll alone, whatever the line does.
			if (s.field > 0) {
				const pays = CRAPS_FIELD[total];
				s.fieldResult = pays !== undefined ? { won: true, pays } : { won: false, pays: 0 };
			}
			if (total === 7 || total === 11) return settle(s, pass ? 'win' : 'lose', `${total} on the come-out`);
			if (total === 2 || total === 3) return settle(s, pass ? 'lose' : 'win', `${total} on the come-out`);
			if (total === 12) return settle(s, pass ? 'lose' : 'push', '12 on the come-out');
			s.point = total;
			return { state: s, view: view(s), outcome: null };
		}

		if (total === s.point) return settle(s, pass ? 'win' : 'lose', `Point ${pointName(s.point)} made`);
		if (total === 7) return settle(s, pass ? 'lose' : 'win', `Seven out after point ${pointName(s.point)}`);
		return { state: s, view: view(s), outcome: null };
	},

	view,
};
