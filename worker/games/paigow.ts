/**
 * Pai Gow Poker — seven cards from a 53-card deck (one joker).
 *
 * The player splits seven cards into a five-card high hand and a two-card low
 * hand; the high hand must outrank the low hand. The dealer does the same by
 * the house way. Each hand is compared with the dealer's matching hand, and an
 * exact tie ("copy") goes to the dealer:
 *   - win both: even money less 5% commission;
 *   - win one: push;
 *   - lose both: the bet is lost.
 *
 * The joker counts as an ace, or as any card completing a straight, flush or
 * straight flush. A-2-3-4-5 is the second-highest straight, and four aces with
 * the joker ("five aces") is the top hand.
 *
 * Both sevens are dealt in `init`, so the deal does not depend on how the player
 * sets their hand. The dealer's cards stay out of the view until the hand ends.
 */

import { PAI_GOW_COMMISSION } from '../../shared/games';
import type { Action, ActionType, GameView, HandView, PaiGowSplit, Wager } from '../../shared/protocol';
import { shuffle } from '../rng';
import { type Card, makeCard, SUITS, toView } from './cards';
import { CATEGORY, combinations, compareScores, evaluate2, evaluate5, isJoker, makeJoker, type PokerHand } from './poker';
import { GameError, type GameHandler, type Step } from './types';

const OPTS = { wheel: 'second' } as const;

interface PaiGowState {
	bet: number;
	player: Card[];
	dealer: Card[];
	/** Indices of the player's low hand, once set. */
	low: number[] | null;
	/** Indices of the dealer's low hand, set by the house way when the hand is played. */
	dealerLow?: number[];
	done: boolean;
}

interface Split {
	/** Indices into the seven cards. */
	low: [number, number];
	high: PokerHand;
	lowHand: PokerHand;
}

/** Poker value of a card for grouping, with the joker as an ace. */
const value = (card: Card): number => (isJoker(card) || card.rank === 1 ? 14 : card.rank);

/**
 * A split is legal when the low hand does not outrank the high hand. Scores
 * compare category first, then cards from the top, which is how a two-card
 * hand is held against a five-card one.
 */
function isLegal(high: PokerHand, low: PokerHand): boolean {
	return compareScores(high.score, low.score) >= 0;
}

function splitOf(cards: readonly Card[], low: [number, number]): Split {
	const highCards = cards.filter((_, i) => i !== low[0] && i !== low[1]);
	return {
		low,
		high: evaluate5(highCards, OPTS),
		lowHand: evaluate2([cards[low[0]]!, cards[low[1]]!]),
	};
}

/** Every legal way to set seven cards. There is always at least one. */
export function legalSplits(cards: readonly Card[]): Split[] {
	const indices = cards.map((_, i) => i);
	return combinations(indices, 2)
		.map((pair) => splitOf(cards, pair as [number, number]))
		.filter((split) => isLegal(split.high, split.lowHand));
}

/** The split with the strongest low hand, then the strongest high hand. */
function bestLow(splits: readonly Split[]): Split | null {
	let best: Split | null = null;
	for (const split of splits) {
		if (
			best === null ||
			compareScores(split.lowHand.score, best.lowHand.score) > 0 ||
			(compareScores(split.lowHand.score, best.lowHand.score) === 0 &&
				compareScores(split.high.score, best.high.score) > 0)
		) {
			best = split;
		}
	}
	return best;
}

/**
 * A simplified house way, used for the dealer and offered to the player.
 *
 * Every rule below is "keep this much in the high hand, then make the low hand
 * as strong as possible", so each is a filter on the legal splits followed by
 * `bestLow`. It follows the common Las Vegas way for the hands that matter:
 *   - no pair: highest card high, next two low;
 *   - one pair: pair high;
 *   - two pair: split them (lower pair low), except small pairs (tens or under)
 *     with an ace to play in the low hand, which stay together;
 *   - three pair: the highest pair goes low;
 *   - trips: kept high, except three aces, which split to a pair high and an ace low;
 *   - straights and flushes: kept, with the best low hand left over, unless
 *     two pair or better can be played instead (then the pair rules apply);
 *     with one pair, the pair goes low behind the straight or flush if it can;
 *   - full house: split, the pair low; quads: kept if sixes or under, or if
 *     there is a pair to play low, else split into two pairs;
 *   - five aces: kept.
 */
export function houseWay(cards: readonly Card[]): [number, number] {
	const splits = legalSplits(cards);
	const atLeast = (category: number) => splits.filter((s) => s.high.category >= category);
	const choose = (...candidates: Split[][]): [number, number] => {
		for (const list of candidates) {
			const best = bestLow(list);
			if (best) return best.low;
		}
		return bestLow(splits)!.low;
	};

	const counts = new Map<number, number>();
	for (const c of cards) counts.set(value(c), (counts.get(value(c)) ?? 0) + 1);
	const ranksWith = (n: number) => [...counts].filter(([, k]) => k === n).map(([r]) => r).sort((a, b) => b - a);
	const quads = ranksWith(4);
	const trips = ranksWith(3);
	const pairs = ranksWith(2);
	const best = Math.max(...splits.map((s) => s.high.category));

	if (best === CATEGORY.fiveAces || counts.get(14) === 5) return choose(atLeast(CATEGORY.fiveAces));

	if (quads.length > 0) {
		const q = quads[0]!;
		const hasAce = counts.get(14) === 1;
		if (q <= 6 || pairs.length > 0 || trips.length > 0 || (q <= 10 && hasAce)) {
			return choose(atLeast(CATEGORY.quads));
		}
		// Split the quads: a pair in each hand.
		return choose(splits.filter((s) => s.lowHand.category === CATEGORY.pair));
	}

	// Full house (trips with a pair, or two sets of trips): trips high, best pair low.
	if (trips.length > 0 && (pairs.length > 0 || trips.length > 1)) {
		return choose(splits.filter((s) => s.high.category >= CATEGORY.trips && s.lowHand.category === CATEGORY.pair), atLeast(CATEGORY.trips));
	}

	// Two or three pair play by the pair rules even when a straight or flush is
	// there; one pair or none keeps the straight or flush.
	const straightOrFlush = best >= CATEGORY.straight && best <= CATEGORY.straightFlush;
	if (straightOrFlush && trips.length === 0 && pairs.length < 2) {
		return choose(
			splits.filter((s) => s.high.category >= CATEGORY.straight && s.lowHand.category === CATEGORY.pair),
			atLeast(CATEGORY.straight)
		);
	}

	if (trips.length > 0) {
		if (straightOrFlush) return choose(atLeast(CATEGORY.straight));
		// Three aces split: a pair of aces high and an ace low.
		if (trips[0] === 14) return choose(atLeast(CATEGORY.pair));
		return choose(atLeast(CATEGORY.trips));
	}

	if (pairs.length >= 3) return choose(atLeast(CATEGORY.twoPair));

	if (pairs.length === 2) {
		const aceSingle = counts.get(14) === 1;
		if (pairs[0]! <= 10 && aceSingle) return choose(atLeast(CATEGORY.twoPair));
		return choose(splits.filter((s) => s.lowHand.category === CATEGORY.pair && s.high.category >= CATEGORY.pair));
	}

	if (pairs.length === 1) return choose(atLeast(CATEGORY.pair));

	return choose(splits);
}

function handView(cards: readonly Card[]): HandView {
	return { cards: cards.map(toView), total: 0, isSoft: false };
}

function splitView(cards: readonly Card[], low: readonly number[]): PaiGowSplit {
	const highCards = cards.filter((_, i) => !low.includes(i));
	const lowCards = low.map((i) => cards[i]!);
	return {
		high: handView(highCards),
		low: handView(lowCards),
		highRank: evaluate5(highCards, OPTS).label,
		lowRank: evaluate2(lowCards).label,
	};
}

/** Per hand: 1 if the player's hand beats the dealer's, -1 otherwise (copies go to the dealer). */
function results(s: PaiGowState): { high: 1 | -1; low: 1 | -1 } {
	const player = splitOf(s.player, s.low as [number, number]);
	const dealer = splitOf(s.dealer, dealerLow(s));
	return {
		high: compareScores(player.high.score, dealer.high.score) > 0 ? 1 : -1,
		low: compareScores(player.lowHand.score, dealer.lowHand.score) > 0 ? 1 : -1,
	};
}

const dealerLow = (s: PaiGowState): [number, number] => (s.dealerLow ?? houseWay(s.dealer)) as [number, number];

function view(s: PaiGowState): GameView {
	return {
		game: 'paigow',
		resolved: s.done,
		hand: handView(s.player),
		// Only a hint while the hand is being set; afterwards it is the hand played.
		houseWay: s.low ?? houseWay(s.player),
		splits: s.done
			? []
			: legalSplits(s.player).map((split) => ({
					low: split.low,
					highRank: split.high.label,
					lowRank: split.lowHand.label,
				})),
		player: s.low ? splitView(s.player, s.low) : null,
		dealer: s.done ? splitView(s.dealer, dealerLow(s)) : null,
		results: s.done ? results(s) : null,
	};
}

/** A fresh 53-card deck: one of each card plus the joker. */
function newDeck(): Card[] {
	const cards: Card[] = [makeJoker()];
	for (const suit of SUITS) for (let rank = 1; rank <= 13; rank++) cards.push(makeCard(rank, suit));
	return shuffle(cards);
}

function settle(s: PaiGowState, low: [number, number]): Step {
	const split = splitOf(s.player, low);
	if (!isLegal(split.high, split.lowHand)) {
		throw new GameError('illegal_action', 'your two-card hand cannot outrank your five-card hand');
	}
	s.low = [...low].sort((a, b) => a - b);
	s.dealerLow = houseWay(s.dealer);
	s.done = true;
	const r = results(s);
	const v = splitView(s.player, s.low);
	const d = splitView(s.dealer, s.dealerLow);
	const vs = `${v.highRank} / ${v.lowRank} against ${d.highRank} / ${d.lowRank}`;
	let returned: number;
	let detail: string;
	if (r.high === 1 && r.low === 1) {
		// Even money less commission, rounded down to whole chips.
		returned = s.bet + Math.floor(s.bet * (1 - PAI_GOW_COMMISSION));
		detail = `Won both hands, less 5% — ${vs}`;
	} else if (r.high === -1 && r.low === -1) {
		returned = 0;
		detail = `Lost both hands — ${vs}`;
	} else {
		returned = s.bet;
		detail = `Push, one hand each — ${vs}`;
	}
	return { state: s, view: view(s), outcome: { stake: s.bet, returned, detail } };
}

export const paigow: GameHandler = {
	id: 'paigow',
	title: 'Pai Gow Poker',

	parseWager(wager: Wager): Wager {
		if (wager.game !== 'paigow') throw new GameError('invalid_wager', 'not a Pai Gow Poker wager');
		return { game: 'paigow' };
	},

	init(_wager: Wager, bet: number): Step {
		const deck = newDeck();
		const state: PaiGowState = {
			bet,
			player: deck.slice(0, 7),
			dealer: deck.slice(7, 14),
			low: null,
			done: false,
		};
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): ActionType[] {
		return (state as PaiGowState).done ? [] : ['HOUSE_WAY', 'SET_HAND'];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as PaiGowState;
		if (s.done) throw new GameError('illegal_action', 'this hand is already finished');
		if (action.type === 'HOUSE_WAY') return settle(s, houseWay(s.player));
		if (action.type === 'SET_HAND') {
			const low = action.low;
			if (
				!Array.isArray(low) ||
				low.length !== 2 ||
				!low.every((i) => Number.isInteger(i) && i >= 0 && i < s.player.length) ||
				low[0] === low[1]
			) {
				throw new GameError('invalid_action', 'choose two different cards for the low hand');
			}
			return settle(s, [low[0]!, low[1]!]);
		}
		throw new GameError('invalid_action', 'Pai Gow Poker accepts SET_HAND or HOUSE_WAY');
	},

	view,
};
