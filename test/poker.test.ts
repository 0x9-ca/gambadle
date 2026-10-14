/**
 * The poker games added after the first seven: the shared hand evaluator,
 * blackjack's TriLux side bet, Ultimate Texas Hold'em and Pai Gow Poker.
 *
 * Settlement is checked on hand-picked deals (the dealt state is overwritten
 * after `init`), so each payout rule is pinned by an exact case rather than a
 * sample. TriLux's return is enumerated exactly over the six-deck shoe; Pai
 * Gow's is measured, with a band wide enough never to flake.
 */

import { describe, expect, it } from 'vitest';
import { TRILUX_PAYS, UTH_BLIND, UTH_TRIPS } from '../shared/games';
import { type Action, type GameView, initialRunState } from '../shared/protocol';
import { applyAction, publicRun } from '../worker/engine';
import { triluxResult } from '../worker/games/blackjack';
import { type Card, makeCard, SUITS, type SuitName } from '../worker/games/cards';
import { gameById } from '../worker/games/index';
import { houseWay, legalSplits } from '../worker/games/paigow';
import { bestFive, CATEGORY, compareScores, evaluate2, evaluate5, makeJoker } from '../worker/games/poker';
import { GameError } from '../worker/games/types';

const RANKS: Record<string, number> = { A: 1, T: 10, J: 11, Q: 12, K: 13 };

/** Cards from a compact string: "As Kd Th 9c" (rank then suit), "X" for the joker. */
function cards(text: string): Card[] {
	return text.split(/\s+/).map((token) => {
		if (token === 'X') return makeJoker();
		const rank = RANKS[token[0]!] ?? Number(token[0]);
		return makeCard(rank, token[1] as SuitName);
	});
}

const BET = 100;
const HUGE = 1_000_000;

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

describe('poker hand evaluation', () => {
	const cat = (text: string, wheel: 'low' | 'second' = 'low') => evaluate5(cards(text), { wheel }).category;

	it('names every category', () => {
		expect(cat('As Ks Qs Js Ts')).toBe(CATEGORY.straightFlush);
		expect(evaluate5(cards('As Ks Qs Js Ts')).royal).toBe(true);
		expect(cat('9h 8h 7h 6h 5h')).toBe(CATEGORY.straightFlush);
		expect(cat('9h 9d 9s 9c 5h')).toBe(CATEGORY.quads);
		expect(cat('9h 9d 9s 5c 5h')).toBe(CATEGORY.fullHouse);
		expect(cat('Ah 9h 7h 4h 2h')).toBe(CATEGORY.flush);
		expect(cat('Ah 2d 3s 4c 5h')).toBe(CATEGORY.straight);
		expect(cat('9h 9d 9s 5c 4h')).toBe(CATEGORY.trips);
		expect(cat('9h 9d 5s 5c 4h')).toBe(CATEGORY.twoPair);
		expect(cat('9h 9d 6s 5c 4h')).toBe(CATEGORY.pair);
		expect(cat('Kh 9d 6s 5c 4h')).toBe(CATEGORY.highCard);
		expect(cat('Qh Kd As 2c 3h')).toBe(CATEGORY.highCard); // no wrapping
	});

	it('breaks ties on kickers and ranks the wheel per game', () => {
		const score = (text: string, wheel: 'low' | 'second' = 'low') => evaluate5(cards(text), { wheel }).score;
		expect(compareScores(score('9h 9d Ks 5c 4h'), score('9s 9c Qs 5d 4d'))).toBeGreaterThan(0);
		expect(compareScores(score('9h 9d Ks 5c 4h'), score('9s 9c Kd 5d 4d'))).toBe(0);
		// Hold'em: the wheel is the lowest straight. Pai Gow: second only to broadway.
		expect(compareScores(score('Ah 2d 3s 4c 5h'), score('2h 3d 4s 5c 6h'))).toBeLessThan(0);
		expect(compareScores(score('Ah 2d 3s 4c 5h', 'second'), score('9h Kd Qs Jc Th', 'second'))).toBeGreaterThan(0);
		expect(compareScores(score('Ah 2d 3s 4c 5h', 'second'), score('Ah Kd Qs Jc Th', 'second'))).toBeLessThan(0);
	});

	it('plays the best five of seven', () => {
		expect(bestFive(cards('2h 7d 9h Jh Qh Kh 3c')).category).toBe(CATEGORY.flush);
		expect(bestFive(cards('Ah Ad 9h 9s 9c 2d 2c')).label).toBe('9s full of Aces');
	});

	it('uses the joker as an ace or to complete a straight or flush only', () => {
		const jcat = (text: string) => evaluate5(cards(text), { wheel: 'second' });
		expect(jcat('X Ad Ks 7c 4h').label).toBe('Pair of Aces');
		expect(jcat('X 7d 7s 9c 4h').label).toBe('Pair of 7s'); // not trips: the joker is just an ace
		expect(jcat('X 8d 7s 6c 4h').category).toBe(CATEGORY.straight);
		expect(jcat('X 8h 7h 2h 4h').label).toBe('Flush, Ace high');
		expect(jcat('X Kh Qh Jh Th').royal).toBe(true);
		expect(jcat('X As Ad Ah Ac').category).toBe(CATEGORY.fiveAces);
		expect(evaluate2(cards('X As')).label).toBe('Pair of Aces');
		expect(evaluate2(cards('X 9s')).label).toBe('Ace-9');
	});
});

// ---------------------------------------------------------------------------
// TriLux
// ---------------------------------------------------------------------------

describe('blackjack TriLux', () => {
	it('pays the posted table on the first two cards and the up card', () => {
		const hit = (a: string, up: string) => triluxResult(cards(a), cards(up)[0]!);
		expect(hit('As Ks', 'Qs')).toEqual({ hand: 'Mini Royal', pays: 100 });
		expect(hit('9s Ts', 'Js')).toEqual({ hand: 'Straight Flush', pays: 35 });
		expect(hit('7s 7d', '7h')).toEqual({ hand: 'Three of a Kind', pays: 33 });
		expect(hit('7s 7s', '7s')).toEqual({ hand: 'Three of a Kind', pays: 33 }); // suited trips, six decks
		expect(hit('As 2d', '3h')).toEqual({ hand: 'Straight', pays: 10 });
		expect(hit('2h 9h', 'Kh')).toEqual({ hand: 'Flush', pays: 5 });
		expect(hit('Ks Kd', '2h')).toBeNull(); // a pair pays nothing
		expect(hit('Qs Ks', '2s')).toEqual({ hand: 'Flush', pays: 5 }); // Q-K-2 does not wrap
	});

	it('has an exact house edge of about 4.4% on six decks', () => {
		const deck = SUITS.flatMap((s) => Array.from({ length: 13 }, (_, i) => makeCard(i + 1, s)));
		const decks = 6;
		let ev = 0;
		let ways = 0;
		for (let a = 0; a < 52; a++) {
			for (let b = 0; b < 52; b++) {
				for (let c = 0; c < 52; c++) {
					// Ordered draws without replacement from six copies of each card.
					const w = decks * (decks - (a === b ? 1 : 0)) * (decks - (c === a ? 1 : 0) - (c === b ? 1 : 0));
					const hit = triluxResult([deck[a]!, deck[b]!], deck[c]!);
					ev += w * (hit ? hit.pays : -1);
					ways += w;
				}
			}
		}
		const edge = -ev / ways;
		process.stdout.write(`TriLux six-deck house edge: ${(edge * 100).toFixed(3)}%\n`);
		expect(edge).toBeGreaterThan(0.04);
		expect(edge).toBeLessThan(0.05);
	});

	const handler = gameById('blackjack');

	/** A blackjack round with the opening deal replaced. */
	/** A blackjack round with the opening deal replaced, waiting on the player. */
	function rigged(player: string, dealer: string, trilux: number, stack = HUGE, bet = BET) {
		const wager = handler.parseWager({ game: 'blackjack', trilux }, bet, stack);
		const s = handler.init(wager, bet, stack).state as Record<string, unknown>;
		// The random deal may have settled on the spot; reset it to an open hand.
		Object.assign(s, {
			hands: [{ cards: cards(player), bet, doubled: false, split: false, stood: false }],
			firstTwo: cards(player),
			dealer: cards(dealer),
			active: 0,
			done: false,
			holeDown: true,
			insuranceOffer: false,
			insurance: 0,
			acted: false,
		});
		return s;
	}

	it('settles with the hand, adding its stake and payout to the outcome', () => {
		// 9-T-J suited straight flush, then the player stands on 19 against 20.
		const s = rigged('9s Ts', 'Js Kd', 10);
		const out = handler.apply(s, { type: 'STAND' });
		expect(out.outcome!.stake).toBe(BET + 10);
		expect(out.outcome!.returned).toBe(10 * (1 + TRILUX_PAYS['straight flush']!));
		expect(out.outcome!.detail).toContain('TriLux Straight Flush pays 35:1');
		const view = out.view as Extract<GameView, { game: 'blackjack' }>;
		expect(view.trilux).toEqual({ bet: 10, hand: 'Straight Flush', pays: 35 });
	});

	it('loses the side bet on no hand, and keeps the opening cards after a split', () => {
		const s = rigged('8s 8d', '2c Kd', 10);
		const split = handler.apply(s, { type: 'SPLIT' });
		const view = split.view as Extract<GameView, { game: 'blackjack' }>;
		expect(view.trilux).toEqual({ bet: 10, hand: null, pays: 0 });
		let step = split;
		while (!step.outcome) step = handler.apply(step.state, { type: 'STAND' });
		expect(step.outcome.detail).toContain('TriLux lost');
		expect(step.outcome.stake).toBe(BET * 2 + 10);
	});

	it('rejects a TriLux the stack cannot cover, and counts it against doubles', () => {
		expect(() => handler.parseWager({ game: 'blackjack', trilux: 51 }, 50, 100)).toThrow(GameError);
		expect(() => handler.parseWager({ game: 'blackjack', trilux: 1.5 }, 50, 100)).toThrow(GameError);
		expect(handler.parseWager({ game: 'blackjack', trilux: 0 }, 50, 100)).toEqual({ game: 'blackjack' });
		// 100 stack, 50 bet, 50 TriLux: nothing left to double with.
		const s = rigged('5s 6d', '9c 7d', 50, 100, 50);
		expect(handler.legalActions(s)).not.toContain('DOUBLE');
	});
});

// ---------------------------------------------------------------------------
// Ultimate Texas Hold'em
// ---------------------------------------------------------------------------

describe("Ultimate Texas Hold'em", () => {
	const handler = gameById('ultimate');
	type V = Extract<GameView, { game: 'ultimate' }>;

	function rigged(player: string, board: string, dealer: string, trips = 0) {
		const step = handler.init(handler.parseWager({ game: 'ultimate', bet: { ante: BET, trips } }, BET, HUGE), BET, HUGE);
		const s = step.state as { player: Card[]; board: Card[]; dealer: Card[] };
		s.player = cards(player);
		s.board = cards(board);
		s.dealer = cards(dealer);
		return s;
	}
	const play = (s: unknown, ...actions: Action['type'][]) => {
		let step = { state: s, view: handler.view(s), outcome: null } as ReturnType<typeof handler.apply>;
		for (const type of actions) step = handler.apply(step.state, { type } as Action);
		return step;
	};

	it('reveals the board by stage and the dealer only at showdown', () => {
		const s = rigged('As Kd', '2c 7h 9s Jd 3c', 'Qs Qh');
		let step = play(s);
		expect((step.view as V).board.cards).toHaveLength(0);
		expect((step.view as V).dealer).toBeNull();
		expect(handler.legalActions(step.state)).toEqual(['CHECK', 'BET_4X', 'BET_3X']);
		step = play(step.state, 'CHECK');
		expect((step.view as V).board.cards).toHaveLength(3);
		expect(handler.legalActions(step.state)).toEqual(['CHECK', 'BET_2X']);
		step = play(step.state, 'CHECK');
		expect((step.view as V).board.cards).toHaveLength(5);
		expect((step.view as V).dealer).toBeNull();
		expect(handler.legalActions(step.state)).toEqual(['BET_1X', 'FOLD']);
		expect(() => handler.apply(step.state, { type: 'CHECK' })).toThrow(GameError);
		step = play(step.state, 'BET_1X');
		expect((step.view as V).dealer!.cards).toHaveLength(2);
		expect(handler.legalActions(step.state)).toEqual([]);
	});

	it('pays Play and Ante 1:1 and the Blind by its table on a straight', () => {
		// Player: 9-high straight. Dealer: pair of queens (qualifies).
		const out = play(rigged('5s 6d', '7c 8h 9s Kd 2c', 'Qs Qh'), 'BET_4X').outcome!;
		expect(out.stake).toBe(BET * 6);
		expect(out.returned).toBe(BET * 4 * 2 + BET * 2 + BET * (1 + UTH_BLIND.Straight!));
	});

	it('pays the Blind 3:2 on a flush, rounding down', () => {
		const step = handler.init({ game: 'ultimate', bet: { ante: 3 } }, 3, HUGE);
		const s = step.state as { player: Card[]; board: Card[]; dealer: Card[] };
		s.player = cards('2h 9h');
		s.board = cards('Kh 4h 7h Qc 3d');
		s.dealer = cards('Qs Qd');
		const out = play(s, 'BET_3X').outcome!;
		// Play 9 → 18, ante 3 → 6, blind 3 at 3:2 → 3 + 4.
		expect(out.returned).toBe(18 + 6 + 3 + 4);
	});

	it('pushes the Blind on a win below a straight, and the Ante when the dealer does not qualify', () => {
		// Player: pair of aces. Dealer: king high (no qualify).
		const out = play(rigged('As Ad', '2c 7h 9s Jd 3c', 'Ks 4h'), 'BET_4X').outcome!;
		expect(out.returned).toBe(BET * 4 * 2 + BET + BET);
		expect(out.detail).toContain('dealer does not qualify');
	});

	it('loses everything to a better hand, but a non-qualifying dealer still pushes the ante', () => {
		const lost = play(rigged('2s 4d', '7c 8h 9s Kd Jc', 'Qs Qh'), 'CHECK', 'CHECK', 'BET_1X').outcome!;
		expect(lost.stake).toBe(BET * 3);
		expect(lost.returned).toBe(0);
		// Player 2-4 against a dealer Q-high that does not qualify: board K-J-9-8-7 plays K-high for both,
		// dealer's queen kicker wins, and the ante pushes.
		const pushedAnte = play(rigged('2s 4d', '7c 8h 9s Kd Jc', 'Qs 3h'), 'CHECK', 'CHECK', 'BET_1X').outcome!;
		expect(pushedAnte.returned).toBe(BET);
	});

	it('pushes everything on a tie', () => {
		// The board plays for both: a broadway straight.
		const out = play(rigged('2s 3d', 'Ac Kh Qs Jd Tc', '4s 5h'), 'BET_4X').outcome!;
		expect(out.returned).toBe(out.stake);
	});

	it('pays Trips on the final hand even after a fold, and loses Ante and Blind', () => {
		const out = play(rigged('9s 9d', '9c 2h 5s Kd 3c', 'Qs Qh', 10), 'CHECK', 'CHECK', 'FOLD').outcome!;
		expect(out.stake).toBe(BET * 2 + 10);
		expect(out.returned).toBe(10 * (1 + UTH_TRIPS['Three of a Kind']));
	});

	it('needs the stack to cover ante, blind and a 4x raise', () => {
		expect(() => handler.parseWager({ game: 'ultimate', bet: { ante: 17 } }, 17, 100)).toThrow(GameError);
		expect(handler.parseWager({ game: 'ultimate', bet: { ante: 16 } }, 16, 100)).toEqual({ game: 'ultimate', bet: { ante: 16 } });
		expect(() => handler.parseWager({ game: 'ultimate', bet: { ante: 16, trips: 5 } }, 16, 100)).toThrow(GameError);
		expect(() => handler.parseWager({ game: 'ultimate', bet: { ante: 20 } }, 16, HUGE)).toThrow(GameError);
	});
});

// ---------------------------------------------------------------------------
// Pai Gow Poker
// ---------------------------------------------------------------------------

describe('Pai Gow Poker', () => {
	const handler = gameById('paigow');
	type V = Extract<GameView, { game: 'paigow' }>;

	function rigged(player: string, dealer: string) {
		const step = handler.init({ game: 'paigow' }, BET, HUGE);
		const s = step.state as { player: Card[]; dealer: Card[] };
		s.player = cards(player);
		s.dealer = cards(dealer);
		return s;
	}
	/** The ranks of the two low-hand cards the house way picks (suits do not matter here). */
	const lowOf = (text: string) => {
		const tokens = text.split(/\s+/);
		return houseWay(cards(text))
			.map((i) => tokens[i]![0])
			.sort()
			.join(' ');
	};

	it('deals seven cards each and hides the dealer until the hand is set', () => {
		const step = handler.init({ game: 'paigow' }, BET, HUGE);
		const view = step.view as V;
		expect(view.hand.cards).toHaveLength(7);
		expect(view.dealer).toBeNull();
		expect(view.houseWay).toHaveLength(2);
		const done = handler.apply(step.state, { type: 'HOUSE_WAY' });
		expect((done.view as V).dealer!.high.cards).toHaveLength(5);
		expect(handler.legalActions(done.state)).toEqual([]);
	});

	it('refuses a low hand that outranks the high hand, and malformed picks', () => {
		// Putting the aces low leaves king high in the five-card hand.
		const s = rigged('As Ad Kc 9h 7s 4d 2c', '3s 5d 8c Th Js Qd 6c');
		expect(() => handler.apply(s, { type: 'SET_HAND', low: [0, 1] })).toThrow(GameError);
		expect(() => handler.apply(s, { type: 'SET_HAND', low: [2, 2] })).toThrow(GameError);
		expect(() => handler.apply(s, { type: 'SET_HAND', low: [2, 9] })).toThrow(GameError);
		expect(() => handler.apply(s, { type: 'SET_HAND', low: [2] })).toThrow(GameError);
		expect(handler.apply(s, { type: 'SET_HAND', low: [2, 3] }).outcome).not.toBeNull();
	});

	it('sets hands the house way', () => {
		expect(lowOf('As Kd 9c 7h 5s 4d 2c')).toBe('9 K'); // no pair: ace high, next two low
		expect(lowOf('9s 9d Kc Qh 5s 4d 2c')).toBe('K Q'); // one pair stays high
		expect(lowOf('Ks Kd 5c 5h Qs 4d 2c')).toBe('5 5'); // two pair split
		expect(lowOf('6s 6d 5c 5h As 4d 2c')).toBe('4 A'); // small two pair with an ace: together
		expect(lowOf('Ks Kd 5c 5h 9s 9d 2c')).toBe('K K'); // three pair: highest low
		expect(lowOf('9s 9d 9c 5h 5s Kd 2c')).toBe('5 5'); // full house: pair low
		expect(lowOf('As Ad Ac 8h 6s 4d 2c')).toBe('8 A'); // three aces: one goes low
		expect(lowOf('Ts 9d 8c 7h 6s Kd Qc')).toBe('K Q'); // straight kept
		expect(lowOf('Ts 9d 8c 7h 6s Kd Kc')).toBe('K K'); // straight high, its spare pair low
		expect(lowOf('Th 2h Ts As 2s Js 7s')).toBe('A J'); // two pair beats keeping the flush
		expect(lowOf('X As Ad Ah Ac Kd Qc')).toBe('K Q'); // five aces kept
	});


	it('always leaves at least one legal split', () => {
		for (let i = 0; i < 300; i++) {
			const step = handler.init({ game: 'paigow' }, BET, HUGE);
			const s = step.state as { player: Card[] };
			expect(legalSplits(s.player).length).toBeGreaterThan(0);
		}
	});

	it('pays 1:1 less 5% for both hands, pushes on one each, and gives copies to the dealer', () => {
		const dealer = '3s 5d 8c Th 2s 4h 7c'; // house way: T-high / 8-7
		const both = handler.apply(rigged('As Ad Kc Kh 9s 4d 2c', dealer), { type: 'SET_HAND', low: [2, 3] }).outcome!;
		expect(both.returned).toBe(BET + 95);
		// Win the high hand, lose the low: push.
		const split = handler.apply(rigged('As Ad Kc 5h 9s 4d 2c', dealer), { type: 'SET_HAND', low: [5, 6] }).outcome!;
		expect(split.returned).toBe(BET);
		// Identical low hands (8-7 each): the copy goes to the dealer, so winning the high is only a push.
		const copy = handler.apply(rigged('As Ad 8h 7s 5c 4d 2c', dealer), { type: 'SET_HAND', low: [2, 3] });
		expect((copy.view as V).results).toEqual({ high: 1, low: -1 });
		expect(copy.outcome!.returned).toBe(BET);
	});

	it('returns a little under even over many hands played the house way', { timeout: 60_000 }, () => {
		let net = 0;
		const hands = 4000;
		for (let i = 0; i < hands; i++) {
			const step = handler.init({ game: 'paigow' }, BET, HUGE);
			const out = handler.apply(step.state, { type: 'HOUSE_WAY' }).outcome!;
			net += (out.returned - out.stake) / BET;
		}
		const mean = net / hands;
		process.stdout.write(`Pai Gow house way return: ${(mean * 100).toFixed(2)}%\n`);
		// Most hands push, so the standard error here is about 1%.
		expect(mean).toBeLessThan(0.02);
		expect(mean).toBeGreaterThan(-0.08);
	});
});

// ---------------------------------------------------------------------------
// The engine with the new games
// ---------------------------------------------------------------------------

describe('engine', () => {
	it('never sends a game state (the shoe, hole cards) to the client', () => {
		let run = { ...initialRunState(), upcoming: 'blackjack' as const };
		run = applyAction(run, { type: 'BEGIN_ROUND', bet: 10 }) as typeof run;
		run = applyAction(run, { type: 'WAGER', wager: { game: 'blackjack' } }) as typeof run;
		if (run.phase === 'in_game') {
			expect(run.current!.state).not.toBeNull();
			const sent = publicRun(run)!;
			expect(sent.current!.state).toBeNull();
			expect(sent.current!.view).toEqual(run.current!.view);
			expect(JSON.stringify(sent)).not.toContain('shoe');
		}
		expect(publicRun(null)).toBeNull();
	});

	it("antes a sixth of the stack on an all-in Hold'em round", () => {
		const run = applyAction({ ...initialRunState(), upcoming: 'ultimate' }, { type: 'BEGIN_ROUND', bet: 1000 });
		expect(run.current!.bet).toBe(166);
		expect(run.current!.wager).toEqual({ game: 'ultimate', bet: { ante: 166 } });
	});
});
