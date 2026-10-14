/**
 * Cards, shoes and hand evaluation.
 *
 * Shared by blackjack, baccarat and three card poker so the deck construction,
 * the Ace handling and the total calculation are written once.
 */

import type { CardView, Suit } from '../../shared/protocol';
import { randomInt, shuffle } from '../rng';

export type SuitName = Suit;

export interface Card extends CardView {
	/** 0-51 index, useful as a compact stable identity. */
	readonly id: number;
}

export const SUITS: readonly SuitName[] = ['s', 'h', 'd', 'c'];

export function makeCard(rank: number, suit: SuitName): Card {
	// rank is 1-13, suit is 0-3 => id is 0-51
	return { id: (rank - 1) * 4 + SUITS.indexOf(suit), rank, suit };
}

/** Builds a freshly shuffled shoe of `decks` 52-card decks. */
export function makeShoe(decks: number): Card[] {
	const cards: Card[] = [];
	for (let d = 0; d < decks; d++) {
		for (let s = 0; s < 4; s++) {
			for (let r = 1; r <= 13; r++) {
				cards.push(makeCard(r, SUITS[s]!));
			}
		}
	}
	return shuffle(cards);
}

export const isRed = (card: Card): boolean => card.suit === 'h' || card.suit === 'd';

export function isFaceCard(card: Card): boolean {
	return card.rank >= 11;
}

export function isAce(card: Card): boolean {
	return card.rank === 1;
}

/** Dealer position labels used in the protocol. */
export const DEALER = 'dealer' as const;
export const PLAYER = 'player' as const;

// ---------------------------------------------------------------------------
// Shoe with a draw position
// ---------------------------------------------------------------------------

/**
 * A shuffled deck plus a cursor. Cards are drawn from the front of the array.
 * Serialized as `{ cards, pos }`.
 */
export interface Shoe {
	cards: Card[];
	pos: number;
}

export function newShoe(decks: number): Shoe {
	return { cards: makeShoe(decks), pos: 0 };
}

export function draw(shoe: Shoe): Card {
	if (shoe.pos >= shoe.cards.length) {
		throw new Error('shoe exhausted');
	}
	return shoe.cards[shoe.pos++]!;
}

export function shoeRemaining(shoe: Shoe): number {
	return shoe.cards.length - shoe.pos;
}

// ---------------------------------------------------------------------------
// Hand totals
// ---------------------------------------------------------------------------

/**
 * Best total for a hand, counting Aces as 11 when that does not bust, else 1.
 * `isSoft` reports whether an Ace is still being counted as 11.
 */
export function handTotal(cards: readonly Card[]): { total: number; isSoft: boolean } {
	let total = 0;
	let aces = 0;
	for (const card of cards) {
		if (card.rank === 1) {
			aces++;
			total += 11;
		} else if (card.rank >= 11) {
			total += 10;
		} else {
			total += card.rank;
		}
	}
	// Promote one Ace from 1 to 11 at a time while it does not bust.
	while (total > 21 && aces > 0) {
		total -= 10;
		aces--;
	}
	return { total, isSoft: aces > 0 };
}

/** Ranks sorted ascending, with Aces promoted to 14 — the usual poker ordering. */
export function sortedRanks(cards: readonly Card[]): number[] {
	return cards
		.map((c) => (c.rank === 1 ? 14 : c.rank))
		.sort((a, b) => a - b);
}

export function isFlush(cards: readonly Card[]): boolean {
	return cards.length > 0 && cards.every((c) => c.suit === cards[0]!.suit);
}

/**
 * A straight, honouring the wheel (A-2-3-4-5). Wrapping is not allowed —
 * Q-K-A-2 is not a straight. Returns the high card, or null.
 *
 * Note that `sortedRanks` promotes an Ace to 14, so the wheel arrives as
 * [2,3,4,5,14] and 10-J-Q-K-A arrives as [10,11,12,13,14].
 */
export function straightHigh(cards: readonly Card[]): number | null {
	if (cards.length !== 5) return null;
	const unique = Array.from(new Set(sortedRanks(cards)));
	if (unique.length !== 5) return null; // a duplicate rank rules out a straight

	// Wheel: A-2-3-4-5, high card 5.
	if (unique[4] === 14 && unique[0] === 2) {
		return unique[1] === 3 && unique[2] === 4 && unique[3] === 5 ? 5 : null;
	}
	// Everything else, including the broadway 10-J-Q-K-A.
	return unique[4]! - unique[0] === 4 ? unique[4]! : null;
}

/** Frequency map of ranks, for pair / three-of-a-kind detection. */
export function rankCounts(cards: readonly Card[]): Map<number, number> {
	const counts = new Map<number, number>();
	for (const card of cards) {
		counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
	}
	return counts;
}

/** The rank value that appears `n` times, preferring the highest such rank. */
export function rankWithCount(counts: Map<number, number>, n: number): number | null {
	let best: number | null = null;
	for (const [rank, count] of counts) {
		if (count !== n) continue;
		const effective = rank === 1 ? 14 : rank;
		if (best === null || effective > best) best = effective;
	}
	return best;
}

export function rankName(rank: number): string {
	const names: Record<number, string> = {
		1: 'A',
		2: '2',
		3: '3',
		4: '4',
		5: '5',
		6: '6',
		7: '7',
		8: '8',
		9: '9',
		10: '10',
		11: 'J',
		12: 'Q',
		13: 'K',
		14: 'A',
	};
	return names[rank] ?? String(rank);
}

/** Renders a hand as a compact human string, e.g. "A♠ K♥". */
export function describeHand(cards: readonly Card[]): string {
	return cards
		.map((c) => `${rankName(c.rank)}${({ s: '♠', h: '♥', d: '♦', c: '♣' } as const)[c.suit]}`)
		.join(' ');
}

/**
 * Maps an internal card id back into a protocol card, dropping the id so the
 * serialized game state stays as small as it needs to be.
 */
export function toView(card: Card): CardView {
	return { rank: card.rank, suit: card.suit };
}

/** Reads a card back out of serialized state. */
export function fromView(view: CardView): Card {
	return makeCard(view.rank, view.suit);
}

/** Restores a serialized shoe. */
export function reviveShoe(raw: unknown): Shoe {
	const shoe = raw as Shoe;
	if (!shoe || !Array.isArray(shoe.cards) || typeof shoe.pos !== 'number') {
		throw new Error('corrupt shoe in stored state');
	}
	return shoe;
}

export { randomInt };