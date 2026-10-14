/**
 * Five-card poker hand evaluation, shared by Ultimate Texas Hold'em (best five
 * of seven) and Pai Gow Poker (a five-card and a two-card hand, with a joker).
 *
 * A hand's strength is a score array — category first, then tiebreak ranks —
 * compared element by element, so two hands of the same category are ordered
 * by their own cards without a separate tiebreak routine per category.
 */

import { type Card, makeCard, SUITS } from './cards';

/** Ranks are poker values here: 2-14, Ace high. */
export const CATEGORY = {
	highCard: 0,
	pair: 1,
	twoPair: 2,
	trips: 3,
	straight: 4,
	flush: 5,
	fullHouse: 6,
	quads: 7,
	straightFlush: 8,
	/** Four aces and the joker; Pai Gow's top hand. */
	fiveAces: 9,
} as const;

export interface PokerHand {
	/** Category, then tiebreak ranks, compared lexicographically. */
	score: number[];
	category: number;
	/** True for an ace-high straight flush. */
	royal: boolean;
	label: string;
}

/** The joker is the one card with rank 0. Only Pai Gow deals it. */
export const JOKER_RANK = 0;
export const isJoker = (card: Card): boolean => card.rank === JOKER_RANK;
export const makeJoker = (): Card => ({ id: 52, rank: JOKER_RANK, suit: 's' });

const value = (card: Card): number => (card.rank === 1 ? 14 : card.rank);

const NAMES: Record<number, [string, string]> = {
	2: ['2', '2s'],
	3: ['3', '3s'],
	4: ['4', '4s'],
	5: ['5', '5s'],
	6: ['6', '6s'],
	7: ['7', '7s'],
	8: ['8', '8s'],
	9: ['9', '9s'],
	10: ['10', '10s'],
	11: ['Jack', 'Jacks'],
	12: ['Queen', 'Queens'],
	13: ['King', 'Kings'],
	14: ['Ace', 'Aces'],
};
const one = (rank: number): string => NAMES[Math.floor(rank)]![0];
const many = (rank: number): string => NAMES[Math.floor(rank)]![1];

/** Positive if `a` is the stronger score. */
export function compareScores(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) return a[i]! - b[i]!;
	}
	return 0;
}

export interface EvalOptions {
	/**
	 * Where A-2-3-4-5 sits among straights. Hold'em ranks it lowest; most Pai
	 * Gow tables rank it second only to A-K-Q-J-10.
	 */
	wheel: 'low' | 'second';
}

/** Evaluates exactly five natural cards (no joker). */
function evalNatural(cards: readonly Card[], opts: EvalOptions): PokerHand {
	const ranks = cards.map(value).sort((a, b) => b - a);
	const counts = new Map<number, number>();
	for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
	// Groups by size, then rank: [[3, K], [2, 4]] for kings full of fours.
	const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
	const flush = cards.every((c) => c.suit === cards[0]!.suit);

	let straightTop: number | null = null;
	if (counts.size === 5) {
		if (ranks[0]! - ranks[4]! === 4) straightTop = ranks[0]!;
		else if (ranks[0] === 14 && ranks[1] === 5) straightTop = opts.wheel === 'second' ? 13.5 : 5;
	}
	const straightName = (top: number) => (top === 13.5 || top === 5 ? '5 high' : `${one(top)} high`);

	if (groups[0]![1] === 5) {
		return { score: [CATEGORY.fiveAces, 14], category: CATEGORY.fiveAces, royal: false, label: 'Five Aces' };
	}
	if (straightTop !== null && flush) {
		const royal = straightTop === 14;
		return {
			score: [CATEGORY.straightFlush, straightTop],
			category: CATEGORY.straightFlush,
			royal,
			label: royal ? 'Royal Flush' : `Straight Flush, ${straightName(straightTop)}`,
		};
	}
	const [g0, g1] = groups as [[number, number], [number, number] | undefined];
	const rest = groups.map(([r]) => r);
	if (g0[1] === 4) {
		return { score: [CATEGORY.quads, ...rest], category: CATEGORY.quads, royal: false, label: `Four ${many(g0[0])}` };
	}
	if (g0[1] === 3 && g1?.[1] === 2) {
		return {
			score: [CATEGORY.fullHouse, ...rest],
			category: CATEGORY.fullHouse,
			royal: false,
			label: `${many(g0[0])} full of ${many(g1[0])}`,
		};
	}
	if (flush) {
		return { score: [CATEGORY.flush, ...ranks], category: CATEGORY.flush, royal: false, label: `Flush, ${one(ranks[0]!)} high` };
	}
	if (straightTop !== null) {
		return {
			score: [CATEGORY.straight, straightTop],
			category: CATEGORY.straight,
			royal: false,
			label: `Straight, ${straightName(straightTop)}`,
		};
	}
	if (g0[1] === 3) {
		return { score: [CATEGORY.trips, ...rest], category: CATEGORY.trips, royal: false, label: `Three ${many(g0[0])}` };
	}
	if (g0[1] === 2 && g1?.[1] === 2) {
		return {
			score: [CATEGORY.twoPair, ...rest],
			category: CATEGORY.twoPair,
			royal: false,
			label: `Two Pair, ${many(g0[0])} and ${many(g1[0])}`,
		};
	}
	if (g0[1] === 2) {
		return { score: [CATEGORY.pair, ...rest], category: CATEGORY.pair, royal: false, label: `Pair of ${many(g0[0])}` };
	}
	return { score: [CATEGORY.highCard, ...ranks], category: CATEGORY.highCard, royal: false, label: `${one(ranks[0]!)} high` };
}

/** Every card the joker could stand in for. */
const ALL_CARDS: readonly Card[] = SUITS.flatMap((suit) =>
	Array.from({ length: 13 }, (_, i) => makeCard(i + 1, suit))
);

/**
 * Evaluates five cards. A joker (Pai Gow only) counts as an ace, or as any card
 * that completes a straight, flush or straight flush.
 */
export function evaluate5(cards: readonly Card[], opts: EvalOptions = { wheel: 'low' }): PokerHand {
	if (cards.length !== 5) throw new Error(`evaluate5 needs five cards, got ${cards.length}`);
	const jokerAt = cards.findIndex(isJoker);
	if (jokerAt < 0) return evalNatural(cards, opts);
	const others = cards.filter((_, i) => i !== jokerAt);

	let best: PokerHand | null = null;
	for (const stand of ALL_CARDS) {
		const hand = evalNatural([...others, stand], opts);
		const asAce = stand.rank === 1;
		const completes =
			hand.category === CATEGORY.straight || hand.category === CATEGORY.flush || hand.category === CATEGORY.straightFlush;
		if (!asAce && !completes) continue;
		// The stand-in carries a suit, so an ace that also completes a flush is
		// found here too. One that duplicates a held card is fine: it only counts
		// as an ace or inside a straight or flush, which is what the joker may do.
		if (best === null || compareScores(hand.score, best.score) > 0) best = hand;
	}
	return best!;
}

/** All k-element subsets of `items`, by index order. */
export function combinations<T>(items: readonly T[], k: number): T[][] {
	const out: T[][] = [];
	const pick = (start: number, chosen: T[]) => {
		if (chosen.length === k) {
			out.push(chosen.slice());
			return;
		}
		for (let i = start; i <= items.length - (k - chosen.length); i++) {
			chosen.push(items[i]!);
			pick(i + 1, chosen);
			chosen.pop();
		}
	};
	pick(0, []);
	return out;
}

/** The best five-card hand from any number of cards (seven in Hold'em). */
export function bestFive(cards: readonly Card[], opts: EvalOptions = { wheel: 'low' }): PokerHand & { cards: Card[] } {
	let best: (PokerHand & { cards: Card[] }) | null = null;
	for (const five of combinations(cards, 5)) {
		const hand = evaluate5(five, opts);
		if (best === null || compareScores(hand.score, best.score) > 0) best = { ...hand, cards: five };
	}
	return best!;
}

/** A two-card Pai Gow low hand: a pair or two high cards. The joker is an ace. */
export function evaluate2(cards: readonly Card[]): PokerHand {
	const ranks = cards.map((c) => (isJoker(c) ? 14 : value(c))).sort((a, b) => b - a);
	if (ranks[0] === ranks[1]) {
		return { score: [CATEGORY.pair, ranks[0]!], category: CATEGORY.pair, royal: false, label: `Pair of ${many(ranks[0]!)}` };
	}
	return {
		score: [CATEGORY.highCard, ...ranks],
		category: CATEGORY.highCard,
		royal: false,
		label: `${one(ranks[0]!)}-${one(ranks[1]!)}`,
	};
}
