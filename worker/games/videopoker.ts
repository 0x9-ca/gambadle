/**
 * Video Poker — 8/5 Jacks or Better, one draw.
 *
 * Five cards are dealt from a shuffled 52-card deck. The player keeps any of
 * them and the rest are replaced from the top of the deck, then the final hand
 * pays by VP_PAYS (stake included, so a pair of jacks or better returns the bet).
 *
 * The whole deck is shuffled in `init`, and replacements are simply the next
 * cards in order, so the draw depends on nothing random and the daily seed
 * deals every ranked player the same cards whatever they hold.
 */

import { VP_LABEL, VP_PAYS, type VpKind } from '../../shared/games';
import type { Action, ActionType, GameView, HandView, Wager } from '../../shared/protocol';
import { type Card, type Shoe, SUITS, draw, newShoe, toView } from './cards';
import { GameError, type GameHandler, type Step } from './types';

const BROADWAY = (1 << 1) | (1 << 10) | (1 << 11) | (1 << 12) | (1 << 13);
const COUNTS = new Uint8Array(14);

/**
 * The paying hand in five cards, or null. Ranks are 1-13 (ace is 1) and suits
 * any five equal-or-different numbers. Numbers in and out, no allocation, so
 * the test can run it tens of millions of times to compute the exact return.
 */
export function videoPokerKind(ranks: ArrayLike<number>, suits: ArrayLike<number>): VpKind | null {
	COUNTS.fill(0);
	let mask = 0;
	for (let i = 0; i < 5; i++) {
		COUNTS[ranks[i]!]!++;
		mask |= 1 << ranks[i]!;
	}
	let pairs = 0;
	let highPair = false;
	let three = false;
	let four = false;
	for (let r = 1; r <= 13; r++) {
		const count = COUNTS[r]!;
		if (count === 2) {
			pairs++;
			if (r === 1 || r >= 11) highPair = true;
		} else if (count === 3) three = true;
		else if (count === 4) four = true;
	}

	const flush = suits[0] === suits[1] && suits[1] === suits[2] && suits[2] === suits[3] && suits[3] === suits[4];
	// Five distinct ranks in a row: the lowest set bit times 31 is five bits up
	// (ace counts low here), or exactly the 10-J-Q-K-A broadway.
	const low = mask & -mask;
	const distinct = pairs === 0 && !three && !four;
	const straight = distinct && (mask === BROADWAY || mask === low * 31);

	if (flush && straight) return mask === BROADWAY ? 'royal' : 'straightflush';
	if (four) return 'four';
	if (three && pairs === 1) return 'fullhouse';
	if (flush) return 'flush';
	if (straight) return 'straight';
	if (three) return 'three';
	if (pairs === 2) return 'twopair';
	if (pairs === 1 && highPair) return 'jacks';
	return null;
}

const suitIndex = (card: Card): number => SUITS.indexOf(card.suit);

export function kindOfCards(cards: readonly Card[]): VpKind | null {
	return videoPokerKind(
		cards.map((c) => c.rank),
		cards.map(suitIndex)
	);
}

interface VideoPokerState {
	bet: number;
	shoe: Shoe;
	hand: Card[];
	held: number[];
	drawn: boolean;
}

function handView(cards: readonly Card[]): HandView {
	return { cards: cards.map(toView), total: 0, isSoft: false };
}

function view(s: VideoPokerState): GameView {
	const kind = kindOfCards(s.hand);
	return {
		game: 'videopoker',
		resolved: s.drawn,
		hand: handView(s.hand),
		stage: s.drawn ? 'draw' : 'deal',
		held: s.held,
		kind,
		pays: s.drawn && kind ? VP_PAYS[kind] : 0,
	};
}

export const videopoker: GameHandler = {
	id: 'videopoker',
	title: 'Video Poker',

	parseWager(wager: Wager): Wager {
		if (wager.game !== 'videopoker') throw new GameError('invalid_wager', 'not a video poker wager');
		return { game: 'videopoker' };
	},

	init(_wager: Wager, bet: number): Step {
		const shoe = newShoe(1);
		const state: VideoPokerState = {
			bet,
			shoe,
			hand: [draw(shoe), draw(shoe), draw(shoe), draw(shoe), draw(shoe)],
			held: [],
			drawn: false,
		};
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): ActionType[] {
		return (state as VideoPokerState).drawn ? [] : ['DRAW'];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as VideoPokerState;
		if (action.type !== 'DRAW') throw new GameError('invalid_action', 'video poker only accepts DRAW');
		if (s.drawn) throw new GameError('illegal_action', 'this hand has already been drawn');

		// Omitted means keep nothing, which is what a bare DRAW has always meant.
		const hold = action.hold ?? [];
		if (
			!Array.isArray(hold) ||
			hold.length > 5 ||
			!hold.every((i) => Number.isInteger(i) && i >= 0 && i < 5) ||
			new Set(hold).size !== hold.length
		) {
			throw new GameError('invalid_action', 'hold must list distinct card positions from 0 to 4');
		}

		// Replacements come off the top of the deck in position order.
		for (let i = 0; i < 5; i++) {
			if (!hold.includes(i)) s.hand[i] = draw(s.shoe);
		}
		s.held = [...hold].sort((a, b) => a - b);
		s.drawn = true;

		const kind = kindOfCards(s.hand);
		const multiple = kind ? VP_PAYS[kind] : 0;
		return {
			state: s,
			view: view(s),
			outcome: {
				stake: s.bet,
				returned: s.bet * multiple,
				detail: kind ? `${VP_LABEL[kind]} — pays ${multiple === 1 ? 'your bet back' : `${multiple}×`}` : 'No pair of jacks or better',
			},
		};
	},

	view,
};
