/**
 * Three Card Poker — one hand of three cards from a single 52-card deck.
 *
 * The player pays an ante, sees their hand, then folds or plays an equal Play
 * bet. The dealer qualifies with queen-high or better. A qualified dealer is
 * compared card by card: win pays ante and Play 1:1, tie pushes, loss takes
 * both. An unqualified dealer pays the ante 1:1 and pushes the Play bet.
 *
 * Optional side bets, both decided on the player's three cards alone:
 *   Pair Plus  — pays on hand rank regardless of the dealer. Best odds in the
 *                game at about 7.28% house edge.
 *   Ante Bonus — pays on a straight or better whatever the dealer holds, as
 *                long as the player plays rather than folds.
 */

import { TCP_ANTE_BONUS, TCP_PAIR_PLUS } from '../../shared/games';
import type { Action, GameView, HandView, ThreeCardBet, Wager } from '../../shared/protocol';
import {
	type Card,
	draw,
	isFlush,
	newShoe,
	rankCounts,
	rankName,
	rankWithCount,
	sortedRanks,
	type Shoe,
} from './cards';
import { GameError, type GameHandler, type Step } from './types';

// ---------------------------------------------------------------------------
// Hand ranking
// ---------------------------------------------------------------------------

export type HandCategory =
	| 'royal flush'
	| 'straight flush'
	| 'three of a kind'
	| 'straight'
	| 'flush'
	| 'pair'
	| 'high card';

interface RankedHand {
	category: HandCategory;
	/** Higher is better. Used for comparisons and for the dealer qualification test. */
	score: number;
	/** Short label for the UI, e.g. "Pair of Kings". */
	label: string;
}

/** Three-card straights never wrap, so this handles both the wheel and broadway. */
function threeCardStraightHigh(cards: readonly Card[]): number | null {
	const ranks = sortedRanks(cards); // Ace promoted to 14
	if (ranks.length !== 3) return null;
	if (ranks[0] === ranks[1] || ranks[1] === ranks[2]) return null;
	if (ranks[2] - ranks[0] === 2) return ranks[2]!;
	// A-2-3 wheel only.
	if (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 14) return 5;
	return null;
}

export function rankHand(cards: readonly Card[]): RankedHand {
	const flush = isFlush(cards);
	const straight = threeCardStraightHigh(cards);
	const counts = rankCounts(cards);
	const trips = rankWithCount(counts, 3);
	const pair = rankWithCount(counts, 2);
	const high = sortedRanks(cards)[2]!;

	if (flush && straight !== null) {
		// A-K-Q is the only three-card 14-high straight flush.
		if (straight === 14) {
			return { category: 'royal flush', score: 700, label: 'Royal Flush' };
		}
		return {
			category: 'straight flush',
			score: 600 + straight,
			label: `Straight Flush, ${rankName(straight)} high`,
		};
	}
	if (trips !== null) {
		return {
			category: 'three of a kind',
			score: 500 + trips,
			label: `Three ${rankName(trips)}s`,
		};
	}
	if (straight !== null) {
		return { category: 'straight', score: 400 + straight, label: `${rankName(straight)} high Straight` };
	}
	if (flush) {
		return { category: 'flush', score: 300 + high, label: `${rankName(high)} high Flush` };
	}
	if (pair !== null) {
		return { category: 'pair', score: 200 + pair, label: `Pair of ${rankName(pair)}s` };
	}
	return { category: 'high card', score: high, label: `${rankName(high)} high` };
}

/** Positive if `a` beats `b`; ties are broken card by card, high to low. */
export function compareHands(a: readonly Card[], b: readonly Card[]): number {
	const diff = rankHand(a).score - rankHand(b).score;
	if (diff !== 0) return diff;
	const ra = sortedRanks(a).reverse();
	const rb = sortedRanks(b).reverse();
	for (let i = 0; i < ra.length; i++) {
		if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
	}
	return 0;
}

/** The dealer must hold queen-high or better. Any pair, flush or straight qualifies. */
export function dealerQualifies(hand: RankedHand): boolean {
	return hand.score > 200 || (hand.score < 100 && hand.score >= 12);
}

// ---------------------------------------------------------------------------
// Paytables
// ---------------------------------------------------------------------------

const PAIR_PLUS_PAY = TCP_PAIR_PLUS;
const ANTE_BONUS_PAY = TCP_ANTE_BONUS;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface ThreeCardState {
	bet: number;
	wager: ThreeCardBet;
	shoe: Shoe;
	player: Card[];
	/** Null until the hand is played rather than folded. */
	dealer: Card[] | null;
	folded: boolean;
	done: boolean;
}

function validate(bet: ThreeCardBet, stack: number, ante: number): ThreeCardBet {
	// The engine owns the stake and passes it in as `ante`, so a client cannot
	// re-negotiate the ante via WAGER — it may only add the Pair Plus side bet.
	if (bet.ante !== undefined && bet.ante !== ante) {
		throw new GameError('invalid_wager', 'the ante is set by your bet and cannot be changed');
	}
	if (!Number.isInteger(ante) || ante < 1) {
		throw new GameError('invalid_wager', 'ante must be a positive whole number');
	}
	// Playing costs the ante plus an equal Play bet, so the ante can never be
	// more than half the stack. A Double or Nothing therefore stakes half.
	if (ante * 2 > stack) {
		throw new GameError('invalid_wager', 'ante plus play bet exceeds your stack');
	}
	const normalized: ThreeCardBet = { ante };
	if (bet.pairPlus !== undefined) {
		if (!Number.isInteger(bet.pairPlus) || bet.pairPlus < 0) {
			throw new GameError('invalid_wager', 'pair plus must be a positive whole number');
		}
		if (ante * 2 + bet.pairPlus > stack) {
			throw new GameError('invalid_wager', 'ante, play and pair plus exceed your stack');
		}
		normalized.pairPlus = bet.pairPlus;
	}
	return normalized;
}

function handView(cards: readonly Card[]): HandView {
	// Three cards never total more than 33, but the shared helper still needs
	// a total; sum them with aces as 1 since a three-card ace is always 1 here.
	const total = cards.reduce((sum, c) => sum + (c.rank === 1 ? 1 : c.rank >= 11 ? 10 : c.rank), 0);
	return { cards: cards.map((c) => ({ rank: c.rank, suit: c.suit })), total, isSoft: false };
}

function view(s: ThreeCardState): GameView {
	const hand = rankHand(s.player);
	return {
		game: 'threecard',
		resolved: s.done,
		hand: handView(s.player),
		rank: hand.label,
		dealer: s.dealer ? handView(s.dealer) : null,
		dealerRank: s.dealer ? rankHand(s.dealer).label : null,
		// The dealer is only revealed once the player has committed.
		dealerQualifies: s.folded ? null : s.done && s.dealer ? dealerQualifies(rankHand(s.dealer)) : null,
		folded: s.folded,
	};
}

export const threecard: GameHandler = {
	id: 'threecard',
	title: 'Three Card Poker',

	parseWager(wager: Wager, bet: number, stack: number): Wager {
		if (wager.game !== 'threecard') {
			throw new GameError('invalid_wager', 'not a three card poker wager');
		}
		return { game: 'threecard', bet: validate(wager.bet, stack, bet) };
	},

	init(wager: Wager, bet: number, stack: number): Step {
		if (wager.game !== 'threecard') {
			throw new GameError('invalid_wager', 'not a three card poker wager');
		}
		// Already validated by parseWager; re-check cheaply so init is safe to
		// call directly (as the engine does for a Double or Nothing).
		const normalized = validate(wager.bet, stack, bet);

		// A single deck, shuffled.
		const shoe = newShoe(1);
		const player: Card[] = [draw(shoe), draw(shoe), draw(shoe)];

		const state: ThreeCardState = {
			bet,
			wager: normalized,
			shoe,
			player,
			dealer: null,
			folded: false,
			done: false,
		};
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'FOLD' | 'PLAY'> {
		const s = state as ThreeCardState;
		return s.done ? [] : ['FOLD', 'PLAY'];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as ThreeCardState;
		if (action.type !== 'FOLD' && action.type !== 'PLAY') {
			throw new GameError('invalid_action', 'three card poker only accepts FOLD or PLAY');
		}
		if (s.done) {
			throw new GameError('illegal_action', 'this hand is already finished');
		}
		s.done = true;

		// Pair Plus pays on the player's hand either way, so it settles first.
		const hand = rankHand(s.player);
		let returned = 0;
		const notes: string[] = [];

		const pairPlus = s.wager.pairPlus ?? 0;
		if (pairPlus > 0) {
			const profit = pairPlus * PAIR_PLUS_PAY[hand.category];
			returned += pairPlus + profit;
			notes.push(`Pair Plus ${hand.category} ${PAIR_PLUS_PAY[hand.category]}:1`);
		}

		const ante = s.bet;
		// The main wager is the ante plus an equal Play bet. Pair Plus settled
		// independently above, so it must not be folded into any of these
		// figures — it is only added to the round's total stake.
		const mainStake = ante * 2;
		const stake = mainStake + pairPlus;

		if (action.type === 'FOLD') {
			s.folded = true;
			// Folding forfeits the ante (and with it any Ante Bonus). The Play bet
			// was never live, so only the ante and Pair Plus were at risk.
			return {
				state: s,
				view: view(s),
				outcome: {
					stake: ante + pairPlus,
					returned,
					detail: notes.length > 0 ? `Folded — ${notes.join(', ')}` : 'Folded',
				},
			};
		}

		s.dealer = [draw(s.shoe), draw(s.shoe), draw(s.shoe)];
		const dealerHand = rankHand(s.dealer);
		const dealerHandText = dealerHand.label;

		// The Ante Bonus pays on the player's hand alone, win, lose or bluff.
		const bonus = ANTE_BONUS_PAY[hand.category];
		if (bonus !== undefined) {
			returned += ante * bonus;
			notes.push(`Ante Bonus ${hand.category} ${bonus}:1`);
		}

		if (!dealerQualifies(dealerHand)) {
			// Dealer does not qualify: the ante wins 1:1 and the Play bet pushes.
			returned += ante * 2 + ante;
			notes.push(`Dealer ${dealerHandText} — no qualify, ante pays 1:1, play pushes`);
		} else {
			notes.push(`Dealer ${dealerHandText}`);
			const cmp = compareHands(s.player, s.dealer);
			if (cmp > 0) {
				// Both ante and Play pay 1:1.
				returned += mainStake * 2;
				notes.push(`${hand.label} beats it`);
			} else if (cmp === 0) {
				returned += mainStake;
				notes.push('Tie — bets returned');
			} else {
				notes.push(`${dealerHand.label} wins`);
			}
		}

		return {
			state: s,
			view: view(s),
			outcome: {
				stake,
				returned,
				detail: notes.join(', '),
			},
		};
	},

	view,
};

// ---------------------------------------------------------------------------
// Exported tables
// ---------------------------------------------------------------------------

/** Exposed so the client can render the paytable. */
export const threeCardTables = {
	pairPlus: PAIR_PLUS_PAY,
	anteBonus: ANTE_BONUS_PAY,
} as const;