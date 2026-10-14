/**
 * Ultimate Texas Hold'em — one hand against the dealer from a single deck.
 *
 * The player posts an Ante and an equal Blind (and optionally Trips), then gets
 * two hole cards. Before the flop they may raise 4x or 3x the ante; after the
 * flop, 2x; after the turn and river, 1x or fold. Raising ends the betting at
 * once, and the player may only raise once. Best five of seven cards plays.
 *
 * Settlement:
 *   - The dealer qualifies with a pair or better. If not, the Ante pushes.
 *   - Player wins: Play pays 1:1, Ante 1:1 (if the dealer qualifies), Blind per
 *     the Blind paytable for a straight or better, else the Blind pushes.
 *   - Tie: everything pushes. Loss or fold: Ante, Blind and Play are lost
 *     (a non-qualifying dealer still pushes the Ante on a showdown loss).
 *   - Trips pays on the player's final hand whatever happens, even on a fold.
 *
 * Every card (hole cards, board, dealer) is dealt in `init`, so the deal does
 * not depend on the player's choices (the daily seed needs that); the view only
 * reveals what the stage allows, and the run's state never reaches the client.
 */

import { UTH_BLIND, UTH_MAX_ANTES, UTH_TRIPS, type UthHand } from '../../shared/games';
import type { Action, ActionType, GameView, HandView, UltimateBet, Wager } from '../../shared/protocol';
import { type Card, draw, newShoe, toView } from './cards';
import { bestFive, CATEGORY, compareScores, type PokerHand } from './poker';
import { GameError, type GameHandler, type Step } from './types';

type Stage = 'preflop' | 'flop' | 'river' | 'showdown';

interface UltimateState {
	/** The ante; the Blind matches it. */
	bet: number;
	trips: number;
	player: Card[];
	board: Card[];
	dealer: Card[];
	stage: Stage;
	/** Chips on the Play bet. */
	play: number;
	folded: boolean;
}

/** The paytable name of a hand, or null below three of a kind. */
export function paytableHand(hand: PokerHand): UthHand | null {
	switch (hand.category) {
		case CATEGORY.straightFlush:
			return hand.royal ? 'Royal Flush' : 'Straight Flush';
		case CATEGORY.quads:
			return 'Four of a Kind';
		case CATEGORY.fullHouse:
			return 'Full House';
		case CATEGORY.flush:
			return 'Flush';
		case CATEGORY.straight:
			return 'Straight';
		case CATEGORY.trips:
			return 'Three of a Kind';
		default:
			return null;
	}
}

const RAISES: Record<Exclude<Stage, 'showdown'>, Array<'BET_4X' | 'BET_3X' | 'BET_2X' | 'BET_1X'>> = {
	preflop: ['BET_4X', 'BET_3X'],
	flop: ['BET_2X'],
	river: ['BET_1X'],
};
const MULTIPLE = { BET_4X: 4, BET_3X: 3, BET_2X: 2, BET_1X: 1 } as const;

function validate(bet: UltimateBet, stack: number, ante: number): UltimateBet {
	// The engine owns the stake; a WAGER may only add the Trips side bet.
	if (bet.ante !== undefined && bet.ante !== ante) {
		throw new GameError('invalid_wager', 'the ante is set by your bet and cannot be changed');
	}
	if (!Number.isInteger(ante) || ante < 1) {
		throw new GameError('invalid_wager', 'ante must be a positive whole number');
	}
	// Ante, Blind and a 4x raise must all be covered before the cards come out.
	if (ante * UTH_MAX_ANTES > stack) {
		throw new GameError('invalid_wager', 'ante, blind and a 4x raise exceed your stack');
	}
	const normalized: UltimateBet = { ante };
	if (bet.trips !== undefined && bet.trips !== 0) {
		if (!Number.isInteger(bet.trips) || bet.trips < 0) {
			throw new GameError('invalid_wager', 'Trips must be a whole number of chips');
		}
		if (ante * UTH_MAX_ANTES + bet.trips > stack) {
			throw new GameError('invalid_wager', 'your bets and Trips exceed your stack');
		}
		normalized.trips = bet.trips;
	}
	return normalized;
}

const cardsView = (cards: readonly Card[]): HandView => ({ cards: cards.map(toView), total: 0, isSoft: false });

function shownBoard(s: UltimateState): Card[] {
	switch (s.stage) {
		case 'preflop':
			return [];
		case 'flop':
			return s.board.slice(0, 3);
		default:
			return s.board;
	}
}

/** The player's best hand from what is showing; just the hole cards before the flop. */
function shownRank(s: UltimateState): string {
	const cards = [...s.player, ...shownBoard(s)];
	if (cards.length >= 5) return bestFive(cards).label;
	const [a, b] = cards.map((c) => (c.rank === 1 ? 14 : c.rank)).sort((x, y) => y - x) as [number, number];
	const name = (r: number) => ({ 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack' })[r] ?? String(r);
	return a === b ? `Pocket ${name(a)}s` : `${name(a)}-${name(b)}`;
}

function view(s: UltimateState): GameView {
	const showdown = s.stage === 'showdown';
	const dealerHand = showdown ? bestFive([...s.dealer, ...s.board]) : null;
	return {
		game: 'ultimate',
		resolved: showdown,
		hand: cardsView(s.player),
		board: cardsView(shownBoard(s)),
		stage: s.stage,
		raises: s.stage === 'showdown' ? [] : RAISES[s.stage].map((a) => MULTIPLE[a]),
		play: s.play,
		rank: shownRank(s),
		dealer: showdown ? cardsView(s.dealer) : null,
		dealerRank: dealerHand?.label ?? null,
		dealerQualifies: dealerHand ? dealerHand.category >= CATEGORY.pair : null,
		folded: s.folded,
	};
}

/** Settles every bet once the betting is over (a raise, or a fold on the river). */
function settle(s: UltimateState): Step {
	s.stage = 'showdown';
	const ante = s.bet;
	const blind = s.bet;
	const player = bestFive([...s.player, ...s.board]);
	const notes: string[] = [];
	let returned = 0;

	if (s.trips > 0) {
		const name = paytableHand(player);
		if (name) {
			returned += s.trips * (1 + UTH_TRIPS[name]);
			notes.push(`Trips ${name} pays ${UTH_TRIPS[name]}:1`);
		} else {
			notes.push('Trips lost');
		}
	}

	const stake = ante + blind + s.play + s.trips;
	if (s.folded) {
		notes.unshift(`Folded with ${player.label}`);
		return { state: s, view: view(s), outcome: { stake, returned, detail: notes.join(' — ') } };
	}

	const dealer = bestFive([...s.dealer, ...s.board]);
	const qualifies = dealer.category >= CATEGORY.pair;
	const cmp = compareScores(player.score, dealer.score);
	// Same hand name on both sides means the kickers decided it.
	const versus = (winner: string, loser: string) =>
		winner === loser ? `${winner}, better kicker` : `${winner} beats ${loser}`;
	let headline: string;

	if (cmp > 0) {
		returned += s.play * 2;
		returned += qualifies ? ante * 2 : ante;
		const name = paytableHand(player);
		const blindPays = name ? UTH_BLIND[name] : undefined;
		// Flush pays 3:2 on the Blind, so whole chips round the fraction down.
		returned += blindPays !== undefined ? blind + Math.floor(blind * blindPays) : blind;
		headline = versus(player.label, dealer.label);
		if (!qualifies) headline += ' — dealer does not qualify, ante pushes';
		if (blindPays !== undefined) headline += ` — Blind pays ${blindPays === 1.5 ? '3:2' : `${blindPays}:1`}`;
	} else if (cmp === 0) {
		returned += ante + blind + s.play;
		headline = `Tie at ${player.label} — bets pushed`;
	} else {
		// A dealer who fails to qualify still pushes the ante, even on a loss.
		if (!qualifies) returned += ante;
		headline = `Dealer: ${versus(dealer.label, player.label)}`;
		if (!qualifies) headline += ' — ante pushes';
	}
	notes.unshift(headline);
	return { state: s, view: view(s), outcome: { stake, returned, detail: notes.join(' — ') } };
}

export const ultimate: GameHandler = {
	id: 'ultimate',
	title: "Ultimate Texas Hold'em",

	parseWager(wager: Wager, bet: number, stack: number): Wager {
		if (wager.game !== 'ultimate') {
			throw new GameError('invalid_wager', "not an Ultimate Texas Hold'em wager");
		}
		return { game: 'ultimate', bet: validate(wager.bet, stack, bet) };
	},

	init(wager: Wager, bet: number, stack: number): Step {
		if (wager.game !== 'ultimate') {
			throw new GameError('invalid_wager', "not an Ultimate Texas Hold'em wager");
		}
		const normalized = validate(wager.bet, stack, bet);
		const shoe = newShoe(1);
		const player = [draw(shoe), draw(shoe)];
		const dealer = [draw(shoe), draw(shoe)];
		const board = [draw(shoe), draw(shoe), draw(shoe), draw(shoe), draw(shoe)];
		const state: UltimateState = {
			bet,
			trips: normalized.trips ?? 0,
			player,
			board,
			dealer,
			stage: 'preflop',
			play: 0,
			folded: false,
		};
		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): ActionType[] {
		const s = state as UltimateState;
		switch (s.stage) {
			case 'preflop':
				return ['CHECK', 'BET_4X', 'BET_3X'];
			case 'flop':
				return ['CHECK', 'BET_2X'];
			case 'river':
				// Raise first so a generic driver plays the hand out rather than folding.
				return ['BET_1X', 'FOLD'];
			default:
				return [];
		}
	},

	apply(state: unknown, action: Action): Step {
		const s = state as UltimateState;
		if (s.stage === 'showdown') {
			throw new GameError('illegal_action', 'this hand is already finished');
		}
		const legal = ultimate.legalActions(s);
		if (!legal.includes(action.type)) {
			throw new GameError('illegal_action', `${action.type} is not legal ${s.stage === 'preflop' ? 'before the flop' : s.stage === 'flop' ? 'on the flop' : 'on the river'}`);
		}
		switch (action.type) {
			case 'CHECK':
				s.stage = s.stage === 'preflop' ? 'flop' : 'river';
				return { state: s, view: view(s), outcome: null };
			case 'FOLD':
				s.folded = true;
				return settle(s);
			case 'BET_4X':
			case 'BET_3X':
			case 'BET_2X':
			case 'BET_1X':
				s.play = s.bet * MULTIPLE[action.type];
				return settle(s);
			default:
				throw new GameError('invalid_action', "Ultimate Texas Hold'em accepts CHECK, a raise, or FOLD on the river");
		}
	},

	view,
};
