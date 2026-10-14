/**
 * Blackjack — six decks, dealer stands on all 17s including soft 17.
 *
 * The dealer shows one up card and holds one face down. The player hits, stands,
 * doubles down or splits, then the dealer plays out and each hand compares.
 * Blackjack pays 3:2, everything else is even money.
 *
 * The round resolves on the deal when it can: a player blackjack settles at
 * once, and so does a dealer blackjack. When the dealer shows an ace the player
 * is first offered insurance (half the bet, paying 2:1) if the stack covers it,
 * and the dealer's hole card is checked straight after the decision. Because the
 * hole card is checked before the player acts, a dealer blackjack can never be
 * found after a double or split.
 *
 * Doubling doubles that hand's bet and takes exactly one card. A split turns a
 * pair (any two 10-value cards count as a pair) into two hands at the original
 * bet each, up to four hands. Split aces get one card apiece and stand, and 21
 * on a split hand is an ordinary 21, not a blackjack.
 *
 * `Outcome` amounts are absolute chips, so each game stores its own bets in
 * state. Doubles and splits put more chips at risk, so the state also keeps the
 * stack it started with to refuse any extra bet the player cannot cover.
 *
 * TriLux is an optional side bet on the poker hand made by the player's first
 * two cards and the dealer's up card (Mini Royal, straight flush, trips,
 * straight or flush). It is decided by the deal alone, so it is settled from
 * the opening cards whatever happens to the hand afterwards.
 */

import type { Action, GameView, HandView, Wager } from '../../shared/protocol';
import { formatOdds } from '../../shared/protocol';
import { TRILUX_LABEL, TRILUX_PAYS } from '../../shared/games';
import { type Card, type Shoe, draw, handTotal, newShoe, toView } from './cards';
import { rankHand } from './threecard';
import { GameError, type GameHandler, type Step } from './types';

const DECKS = 6;
const MAX_HANDS = 4;

interface PlayerHand {
	cards: Card[];
	/** Chips on this hand, doubled if it was doubled down. */
	bet: number;
	doubled: boolean;
	/** Came from a split, so 21 is not a natural. */
	split: boolean;
	/** No further action: stood, doubled, bust or on 21. */
	stood: boolean;
}

interface BlackjackState {
	/** The stake for the opening hand. */
	bet: number;
	/** Chips available when the round began, the ceiling on doubles and splits. */
	stack: number;
	shoe: Shoe;
	hands: PlayerHand[];
	/** Index of the hand awaiting action. */
	active: number;
	dealer: Card[];
	/** False until the dealer has played and the hand is settled. */
	done: boolean;
	/** Whether the hole card is still face down. */
	holeDown: boolean;
	/** Insurance is on offer and the player has not yet answered. */
	insuranceOffer: boolean;
	/** Chips placed on insurance. */
	insurance: number;
	/** Whether the player has made any decision, as opposed to the deal settling itself. */
	acted: boolean;
	/** Chips on the TriLux side bet, 0 if none. Absent on rounds saved before it existed. */
	trilux?: number;
	/** The player's first two cards, kept for TriLux because a split breaks them up. */
	firstTwo?: Card[];
}

/** The TriLux hand from the opening deal: its display name and profit odds, or null. */
export function triluxResult(player: readonly Card[], upCard: Card): { hand: string; pays: number } | null {
	const { category } = rankHand([player[0]!, player[1]!, upCard]);
	const pays = TRILUX_PAYS[category];
	return pays === undefined ? null : { hand: TRILUX_LABEL[category]!, pays };
}

/** The player's first two cards, wherever a split has since moved them. */
function openingCards(s: BlackjackState): Card[] {
	return s.firstTwo ?? [s.hands[0]!.cards[0]!, s.hands[0]!.cards[1]!];
}

function cardValue(card: Card): number {
	return card.rank >= 10 ? 10 : card.rank;
}

function handView(hand: PlayerHand): HandView {
	const { total, isSoft } = handTotal(hand.cards);
	return { cards: hand.cards.map(toView), total, isSoft, bet: hand.bet, doubled: hand.doubled };
}

function dealerView(cards: readonly Card[], holeDown: boolean): HandView {
	if (!holeDown) {
		const { total, isSoft } = handTotal(cards);
		return { cards: cards.map(toView), total, isSoft };
	}
	// Withhold the hole card and every total until the hand is settled, so the
	// payload itself carries nothing the client could display early. The second
	// card is a placeholder face; the client draws it face down.
	return {
		cards: [toView(cards[0]!), { rank: 10, suit: 's' }],
		total: 0,
		isSoft: false,
		hidden: true,
	};
}

function isBlackjack(s: BlackjackState, hand: PlayerHand): boolean {
	return !hand.split && s.hands.length === 1 && hand.cards.length === 2 && handTotal(hand.cards).total === 21;
}

function dealerHasBlackjack(dealer: readonly Card[]): boolean {
	return dealer.length === 2 && handTotal(dealer).total === 21;
}

/** Dealer draws until 17 or more, standing on soft 17 as well. */
function playDealer(shoe: Shoe, dealer: Card[]): Card[] {
	const hand = dealer.slice();
	while (handTotal(hand).total < 17) {
		hand.push(draw(shoe));
	}
	return hand;
}

function committed(s: BlackjackState): number {
	return s.hands.reduce((sum, h) => sum + h.bet, s.insurance + (s.trilux ?? 0));
}

/** Insurance costs half the bet and is only offered if the stack can cover it. */
function insuranceCost(s: BlackjackState): number {
	const cost = Math.floor(s.bet / 2);
	return cost >= 1 && s.stack - committed(s) >= cost ? cost : 0;
}

function canDouble(s: BlackjackState): boolean {
	if (s.done) return false;
	const hand = s.hands[s.active];
	if (!hand || hand.cards.length !== 2 || handTotal(hand.cards).total >= 21) return false;
	return s.stack - committed(s) >= hand.bet;
}

function canSplit(s: BlackjackState): boolean {
	if (s.done || s.hands.length >= MAX_HANDS) return false;
	const hand = s.hands[s.active];
	if (!hand || hand.cards.length !== 2) return false;
	if (cardValue(hand.cards[0]!) !== cardValue(hand.cards[1]!)) return false;
	return s.stack - committed(s) >= hand.bet;
}

/**
 * Moves to the next hand that still needs a decision, and finishes the round
 * when there is none.
 */
function advance(s: BlackjackState): Step {
	while (s.active < s.hands.length && s.hands[s.active]!.stood) s.active++;
	if (s.active >= s.hands.length) {
		s.active = s.hands.length - 1;
		return finish(s);
	}
	return { state: s, view: view(s), outcome: null };
}

/** One hand against the dealer: the chips at risk and the chips coming back. */
function settleHand(s: BlackjackState, hand: PlayerHand): { stake: number; returned: number; note: string } {
	const playerBJ = isBlackjack(s, hand);
	const dealerBJ = dealerHasBlackjack(s.dealer);
	const bet = hand.bet;

	if (playerBJ && dealerBJ) return { stake: bet, returned: bet, note: 'Both blackjack — push' };
	if (playerBJ) {
		// 3:2 on an even-money bet. Round down the fraction to keep integers.
		const profit = Math.floor((bet * 3) / 2);
		return { stake: bet, returned: bet + profit, note: `Blackjack! Pays ${formatOdds(1.5)}` };
	}
	// A dealer blackjack is found before the player acts, so only the opening
	// bet is ever on the table here.
	if (dealerBJ) return { stake: bet, returned: 0, note: 'Dealer blackjack' };

	const playerTotal = handTotal(hand.cards).total;
	const dealerTotal = handTotal(s.dealer).total;

	if (playerTotal > 21) return { stake: bet, returned: 0, note: 'Bust — the dealer wins' };
	if (dealerTotal > 21) return { stake: bet, returned: bet * 2, note: 'Dealer busts' };
	if (playerTotal > dealerTotal) return { stake: bet, returned: bet * 2, note: `You win with ${playerTotal}` };
	if (playerTotal < dealerTotal) return { stake: bet, returned: 0, note: `Dealer wins with ${dealerTotal}` };
	return { stake: bet, returned: bet, note: `Push at ${playerTotal}` };
}

/** Plays the dealer out if needed and settles every hand. */
function finish(s: BlackjackState): Step {
	s.done = true;
	s.holeDown = false;
	// The dealer only draws if some hand is still live: a bust or a natural
	// ends the hand before the dealer draws, which saves a few cards.
	const live = s.hands.some(
		(h) => handTotal(h.cards).total <= 21 && !isBlackjack(s, h)
	);
	if (live) s.dealer = playDealer(s.shoe, s.dealer);

	const results = s.hands.map((h) => settleHand(s, h));
	let stake = results.reduce((sum, r) => sum + r.stake, s.insurance);
	let returned = results.reduce((sum, r) => sum + r.returned, 0);
	let detail =
		results.length === 1
			? results[0]!.note
			: results.map((r, i) => `Hand ${i + 1}: ${r.note}`).join('; ');

	const trilux = s.trilux ?? 0;
	if (trilux > 0) {
		stake += trilux;
		const hit = triluxResult(openingCards(s), s.dealer[0]!);
		if (hit) {
			returned += trilux * (1 + hit.pays);
			detail += ` — TriLux ${hit.hand} pays ${hit.pays}:1`;
		} else {
			detail += ' — TriLux lost';
		}
	}

	if (s.insurance > 0) {
		// Insurance pays 2:1 when the dealer has blackjack and is lost otherwise.
		if (dealerHasBlackjack(s.dealer)) {
			returned += s.insurance * 3;
			detail += ' — insurance pays 2:1';
		} else {
			detail += ' — insurance lost';
		}
	}

	return { state: s, view: view(s), outcome: { stake, returned, detail } };
}

function view(s: BlackjackState): GameView {
	const hands = s.hands.map(handView);
	return {
		game: 'blackjack',
		resolved: s.done,
		player: hands[s.active] ?? hands[0]!,
		hands,
		active: s.active,
		canDouble: canDouble(s),
		canSplit: canSplit(s),
		insuranceOffer: s.insuranceOffer ? insuranceCost(s) : null,
		insured: s.insurance,
		opening: s.done && !s.acted,
		dealer: dealerView(s.dealer, s.holeDown),
		trilux: triluxView(s),
	};
}

/** The up card is always showing, so TriLux can be shown from the deal on. */
function triluxView(s: BlackjackState): Extract<GameView, { game: 'blackjack' }>['trilux'] {
	const bet = s.trilux ?? 0;
	if (bet <= 0) return null;
	const hit = triluxResult(openingCards(s), s.dealer[0]!);
	return { bet, hand: hit?.hand ?? null, pays: hit?.pays ?? 0 };
}

export const blackjack: GameHandler = {
	id: 'blackjack',
	title: 'Blackjack',

	parseWager(wager: Wager, bet: number, stack: number): Wager {
		if (wager.game !== 'blackjack') {
			throw new GameError('invalid_wager', 'not a blackjack wager');
		}
		if (wager.trilux === undefined || wager.trilux === 0) return { game: 'blackjack' };
		if (!Number.isInteger(wager.trilux) || wager.trilux < 0) {
			throw new GameError('invalid_wager', 'TriLux must be a whole number of chips');
		}
		if (bet + wager.trilux > stack) {
			throw new GameError('invalid_wager', 'your bet and TriLux exceed your stack');
		}
		return { game: 'blackjack', trilux: wager.trilux };
	},

	init(wager: Wager, bet: number, stack: number): Step {
		const trilux = wager.game === 'blackjack' ? (wager.trilux ?? 0) : 0;
		const shoe = newShoe(DECKS);
		const state: BlackjackState = {
			bet,
			stack,
			shoe,
			hands: [{ cards: [draw(shoe), draw(shoe)], bet, doubled: false, split: false, stood: false }],
			active: 0,
			dealer: [draw(shoe), draw(shoe)],
			done: false,
			holeDown: true,
			insuranceOffer: false,
			insurance: 0,
			acted: false,
			trilux,
		};
		state.firstTwo = state.hands[0]!.cards.slice();

		// Resolve on the deal where the result is already decided.
		if (isBlackjack(state, state.hands[0]!)) return finish(state);
		if (state.dealer[0]!.rank === 1 && insuranceCost(state) > 0) {
			// Ace up: ask about insurance before the hole card is checked.
			state.insuranceOffer = true;
			return { state, view: view(state), outcome: null };
		}
		if (dealerHasBlackjack(state.dealer)) return finish(state);
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT' | 'INSURE' | 'NO_INSURANCE'> {
		const s = state as BlackjackState;
		if (s.done) return [];
		if (s.insuranceOffer) return ['INSURE', 'NO_INSURANCE'];
		const actions: Array<'HIT' | 'STAND' | 'DOUBLE' | 'SPLIT'> = ['HIT', 'STAND'];
		if (canDouble(s)) actions.push('DOUBLE');
		if (canSplit(s)) actions.push('SPLIT');
		return actions;
	},

	apply(state: unknown, action: Action): Step {
		const s = state as BlackjackState;
		if (s.done) {
			throw new GameError('illegal_action', 'this hand is already settled');
		}
		const hand = s.hands[s.active]!;
		s.acted = true;

		if (s.insuranceOffer) {
			if (action.type !== 'INSURE' && action.type !== 'NO_INSURANCE') {
				throw new GameError('illegal_action', 'answer the insurance offer first');
			}
			if (action.type === 'INSURE') s.insurance = insuranceCost(s);
			s.insuranceOffer = false;
			// The hole card is checked as soon as insurance is settled.
			if (dealerHasBlackjack(s.dealer)) return finish(s);
			return { state: s, view: view(s), outcome: null };
		}

		switch (action.type) {
			case 'HIT':
				hand.cards.push(draw(s.shoe));
				// 21 or bust ends the hand; 21 is not a natural unless it arrived
				// on the first two cards.
				if (handTotal(hand.cards).total >= 21) hand.stood = true;
				return advance(s);

			case 'STAND':
				hand.stood = true;
				return advance(s);

			case 'DOUBLE':
				if (!canDouble(s)) throw new GameError('illegal_action', 'cannot double this hand');
				hand.bet *= 2;
				hand.doubled = true;
				hand.cards.push(draw(s.shoe));
				hand.stood = true;
				return advance(s);

			case 'SPLIT': {
				if (!canSplit(s)) throw new GameError('illegal_action', 'cannot split this hand');
				const [first, second] = hand.cards as [Card, Card];
				const aces = first.rank === 1;
				const make = (card: Card): PlayerHand => ({
					cards: [card, draw(s.shoe)],
					bet: hand.bet,
					doubled: false,
					split: true,
					// Split aces take one card each and stand.
					stood: aces,
				});
				const left = make(first);
				const right = make(second);
				for (const h of [left, right]) {
					if (handTotal(h.cards).total >= 21) h.stood = true;
				}
				s.hands.splice(s.active, 1, left, right);
				return advance(s);
			}
		}

		throw new GameError('invalid_action', 'blackjack accepts HIT, STAND, DOUBLE, SPLIT or insurance while it is offered');
	},

	view,
};
