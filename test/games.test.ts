/**
 * The six non-slots games: payout arithmetic, wager validation, and the
 * round-trip through the game interface.
 *
 * Two approaches, chosen per game by how much of the outcome space is knowable:
 *
 *   - Where the game is a single random draw from a small space, the return is
 *     computed exactly by enumerating every outcome. Roulette's 37 numbers, a
 *     hundred-sided die, a coin. No sampling, so no tolerance and no flake.
 *   - Where the outcome space is a shuffled shoe, baccarat is pinned against an
 *     exact enumeration of the eight-deck shoe, because a wrong draw rule moves
 *     its frequencies by whole points. Blackjack and three card poker are
 *     checked per-outcome against the arithmetic the view reports, plus a
 *     measured return in a wide band.
 *
 * The rule throughout: a losing bet must return **zero**. A payout written as
 * `bet * (1 + profit)` hands the stake straight back on a loss and makes the
 * game risk-free — which is exactly what roulette was doing, and nothing about
 * a single losing spin looks wrong until you notice the stack never moves.
 *
 * Every expectation is read off the game's own view or derived from the
 * published paytable rather than restating the settlement code, so a change that
 * moves money has to move it in the view too.
 */

import { describe, expect, it } from 'vitest';
import {
	BACCARAT_ODDS,
	BACCARET_COMMISSION,
	DICE_MAX_TARGET,
	DICE_MIN_TARGET,
	DICE_COMBOS,
	DICE_FACES,
	rollUnderWays,
	TCP_ANTE_BONUS,
	TCP_PAIR_PLUS,
	type TcpRank,
	colorOf,
	rollUnderMultiplier,
} from '../shared/games';
import type {
	RouletteBet,
	Action,
	CardView,
	GameId,
	GameView,
	HandView,
	Wager,
} from '../shared/protocol';
import { fromView, makeCard, type Card, type SuitName } from '../worker/games/cards';
import { GAMES, gameById } from '../worker/games/index';
import { compareHands, rankHand, type HandCategory } from '../worker/games/threecard';
import { GameError, type GameHandler, type Outcome } from '../worker/games/types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** The stake used throughout; payouts are asserted in absolute chips. */
const BET = 100;

/** A stack large enough that no wager is ever rejected for being too big. */
const HUGE_STACK = 1_000_000;

/**
 * Reads a game's own fields off the view.
 *
 * `GameView` is a discriminated union, so narrowing it at each call site would
 * mean a cast per field and a chance to pick the wrong variant. Each test names
 * the variant it asked for instead.
 */
function viewOf<V>(view: GameView): V {
	return view as unknown as V;
}

interface DiceView {
	roll: number;
	dice: number[];
	won: boolean;
}

interface RouletteView {
	number: number;
	color: 'red' | 'black' | 'green';
	won: boolean;
}

interface BaccaratView {
	player: { cards: CardView[]; total: number };
	banker: { cards: CardView[]; total: number };
	outcome: 'player' | 'banker' | 'tie';
	playerPair: boolean;
	bankerPair: boolean;
}

interface BlackjackView {
	player: HandView;
	dealer: HandView;
}

interface ThreeCardView {
	hand: HandView;
	rank: string;
	dealerQualifies: boolean | null;
	folded: boolean;
}

/** Plays one game from a wager to settlement. */
function playOne(
	handler: GameHandler,
	wager: Wager,
	bet = BET,
	stack = HUGE_STACK,
	prefer?: Action['type']
): { outcome: Outcome; state: unknown; view: GameView } {
	const parsed = handler.parseWager(wager, bet, stack);
	let step = handler.init(parsed, bet, stack);
	for (let guard = 0; guard < 40 && !step.outcome; guard++) {
		const legal = handler.legalActions(step.state);
		if (legal.length === 0) break;
		// Insurance is a side decision these generic drivers are not testing.
		const pick =
			prefer && legal.includes(prefer) ? prefer : legal.includes('NO_INSURANCE') ? 'NO_INSURANCE' : legal[0]!;
		step = handler.apply(step.state, { type: pick } as Action);
	}
	if (!step.outcome) throw new Error(`${handler.id} never settled`);
	return { outcome: step.outcome, state: step.state, view: step.view };
}

interface Measurement {
	/** Mean net per unit staked. Negative means the house wins. */
	mean: number;
	/** Standard error of that mean. */
	se: number;
	hands: number;
}

/**
 * Measures the return of a fixed policy over many hands.
 *
 * Reports the standard error rather than a fixed tolerance so the tolerance
 * scales with how much variance the game actually has, instead of being guessed.
 */
function measureReturn(
	handler: GameHandler,
	wager: Wager,
	hands: number,
	bet = BET,
	stack = HUGE_STACK,
	prefer?: Action['type']
): Measurement {
	let net = 0;
	let squared = 0;
	for (let i = 0; i < hands; i++) {
		const { outcome } = playOne(handler, wager, bet, stack, prefer);
		const unit = (outcome.returned - outcome.stake) / bet;
		net += unit;
		squared += unit * unit;
	}
	const mean = net / hands;
	const variance = Math.max(0, squared / hands - mean * mean);
	return { mean, se: Math.sqrt(variance / hands), hands };
}

/**
 * Pins a measured return to a target.
 *
 * The band is a multiple of the standard error so the test is a genuine claim
 * about the expectation rather than a coin flip that happens to pass.
 */
function expectNear(
	measured: Measurement,
	target: number,
	seMultiplier: number,
	label: string
): void {
	process.stdout.write(
		`${label}: ${(measured.mean * 100).toFixed(3)}% +/- ${(measured.se * seMultiplier * 100).toFixed(3)}pp\n`
	);
	expect(Math.abs(measured.mean - target)).toBeLessThan(seMultiplier * measured.se);
}

const RANK_NUMBER: Record<string, number> = {
	A: 1,
	'2': 2,
	'3': 3,
	'4': 4,
	'5': 5,
	'6': 6,
	'7': 7,
	'8': 8,
	'9': 9,
	'10': 10,
	J: 11,
	Q: 12,
	K: 13,
};

/**
 * Builds a card from a rank character and a suit.
 *
 * `makeCard` takes a numeric rank, so the character is mapped here: Ace is 1,
 * and the picture cards sit above 10 where the games expect them.
 */
function card(rank: string, suit: SuitName): Card {
	const numeric = RANK_NUMBER[rank];
	if (numeric === undefined) throw new Error(`unknown rank ${rank}`);
	return makeCard(numeric, suit);
}

/** The category of a three card hand the view is showing. */
function categoryOf(hand: HandView): HandCategory {
	return rankHand(hand.cards.map(fromView)).category;
}

/** The wager the engine falls back on when a client sends nothing usable. */
function defaultWagerFor(game: GameId): Wager {
	switch (game) {
		case 'roulette':
			return rouletteWager({ kind: 'red' });
		case 'baccarat':
			return { game: 'baccarat', bet: { main: 'player' } };
		case 'coinflip':
			return { game: 'coinflip', bet: { side: 'heads' } };
		case 'dice':
			return { game: 'dice', bet: { kind: 'roll_under', target: 5 } };
		case 'threecard':
			return { game: 'threecard', bet: { ante: BET } };
		case 'blackjack':
			return { game: 'blackjack' };
		case 'slots':
			return { game: 'slots' };
		case 'ultimate':
			return { game: 'ultimate', bet: { ante: BET } };
		case 'paigow':
			return { game: 'paigow' };
		case 'megaslots':
			return { game: 'megaslots' };
		case 'videopoker':
			return { game: 'videopoker' };
		case 'craps':
			return { game: 'craps', bet: { side: 'pass' } };
	}
}

// ---------------------------------------------------------------------------
// Roulette
// ---------------------------------------------------------------------------

/** A roulette wager with a single spot, as most of these tests want. */
function rouletteWager(bet: RouletteBet, amount = BET): Wager & { game: 'roulette' } {
	return { game: 'roulette', bets: [{ bet, amount }] };
}

/** The total return multiplier the game owes on `n` (0 on a loss). */

function expectedReturnMultiplier(bet: Wager & { game: 'roulette' }, n: number): number {
	const b = bet.bets[0]!.bet;
	switch (b.kind) {
		case 'straight':
			return n === b.number ? 36 : 0;
		case 'red':
			return colorOf(n) === 'red' ? 2 : 0;
		case 'black':
			return colorOf(n) === 'black' ? 2 : 0;
		case 'odd':
			return n !== 0 && n % 2 === 1 ? 2 : 0;
		case 'even':
			return n !== 0 && n % 2 === 0 ? 2 : 0;
		case 'low':
			return n >= 1 && n <= 18 ? 2 : 0;
		case 'high':
			return n >= 19 && n <= 36 ? 2 : 0;
		case 'dozen':
			return n !== 0 && Math.floor((n - 1) / 12) + 1 === b.dozen ? 3 : 0;
		case 'column':
			return n !== 0 && ((n - 1) % 3) + 1 === b.column ? 3 : 0;
	}
}

describe('roulette', () => {
	const handler = gameById('roulette');

	it('gives every bet the same house edge, because there is one zero', () => {
		// A single-zero wheel returns 36/37 of every stake on any of these bets,
		// so the edge is fixed rather than varying by bet. Enumerated rather than
		// quoted: this is the whole justification for using a European wheel.
		const cases: ReadonlyArray<readonly [Wager & { game: 'roulette' }]> = [
			[rouletteWager({ kind: 'straight', number: 17 })],
			[rouletteWager({ kind: 'red' })],
			[rouletteWager({ kind: 'black' })],
			[rouletteWager({ kind: 'odd' })],
			[rouletteWager({ kind: 'even' })],
			[rouletteWager({ kind: 'low' })],
			[rouletteWager({ kind: 'high' })],
			[rouletteWager({ kind: 'dozen', dozen: 2 })],
			[rouletteWager({ kind: 'column', column: 3 })],
		];
		for (const [wager] of cases) {
			// Net per spin: the profit when the bet lands, minus the stake when it
			// does not. Summing the wins alone ignores every losing number and
			// turns the result positive.
			let net = 0;
			for (let n = 0; n <= 36; n++) net += expectedReturnMultiplier(wager, n) - 1;
			expect(net / 37).toBeCloseTo(-1 / 37, 12);
		}
	});

	it('matches the measured payouts to the numbers on the view', () => {
		const wagers: ReadonlyArray<Wager & { game: 'roulette' }> = [
			rouletteWager({ kind: 'straight', number: 17 }),
			rouletteWager({ kind: 'red' }),
			rouletteWager({ kind: 'black' }),
			rouletteWager({ kind: 'odd' }),
			rouletteWager({ kind: 'even' }),
			rouletteWager({ kind: 'low' }),
			rouletteWager({ kind: 'high' }),
			rouletteWager({ kind: 'dozen', dozen: 2 }),
			rouletteWager({ kind: 'column', column: 3 }),
		];
		for (const wager of wagers) {
			for (let i = 0; i < 400; i++) {
				const { outcome, view } = playOne(handler, wager);
				const v = viewOf<RouletteView>(view);
				const n = v.number;
				expect(n).toBeGreaterThanOrEqual(0);
				expect(n).toBeLessThanOrEqual(36);
				expect(v.color).toBe(colorOf(n));
				// A winning spin returns exactly the odds; a losing one returns
				// nothing at all. The stake is the engine's business, so a loss
				// must not hand any of it back.
				expect(outcome.stake).toBe(BET);
				expect(outcome.returned).toBe(BET * expectedReturnMultiplier(wager, n));
				expect(v.won).toBe(expectedReturnMultiplier(wager, n) > 0);
			}
		}
	});

	it('never returns the stake on a losing spin', () => {
		// The regression this file exists for. A payout of `bet * (1 + profit)`
		// looks correct on every winning spin and quietly refunds the stake on
		// every losing one, which leaves the stack untouched no matter what.
		let sawLoss = false;
		for (let i = 0; i < 2_000; i++) {
			const { outcome, view } = playOne(handler, rouletteWager({ kind: 'red' }));
			if (!viewOf<RouletteView>(view).won) {
				sawLoss = true;
				expect(outcome.returned).toBe(0);
				expect(outcome.returned - outcome.stake).toBe(-BET);
			}
		}
		expect(sawLoss).toBe(true);
	});

	it('rejects numbers and groups outside the wheel', () => {
		// Deliberately out of range, so the wagers are built through a cast: the
		// point is that the game refuses them, not that TypeScript objects.
		const bad: ReadonlyArray<unknown> = [
			{ game: 'roulette', bets: [{ bet: { kind: 'straight', number: 37 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'straight', number: -1 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'straight', number: 1.5 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'dozen', dozen: 0 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'dozen', dozen: 4 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'column', column: 0 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'column', column: 4 }, amount: BET }] },
			{ game: 'roulette', bets: [{ bet: { kind: 'snake' }, amount: BET }] },
		];
		for (const wager of bad) {
			expect(() => handler.parseWager(wager as Wager, BET, HUGE_STACK)).toThrow(GameError);
		}
	});

	describe('multiple spots', () => {
		const spread = (): Wager & { game: 'roulette' } => ({
			game: 'roulette',
			bets: [
				{ bet: { kind: 'red' }, amount: 30 },
				{ bet: { kind: 'straight', number: 17 }, amount: 5 },
				{ bet: { kind: 'dozen', dozen: 2 }, amount: 20 },
			],
		});

		it('stakes the sum of every spot and settles each one on its own', () => {
			const wager = spread();
			for (let i = 0; i < 1_000; i++) {
				const { outcome, view } = playOne(handler, wager, 100, HUGE_STACK);
				const n = viewOf<RouletteView>(view).number;
				const expected = wager.bets.reduce(
					(sum, c) => sum + c.amount * expectedReturnMultiplier({ game: 'roulette', bets: [c] }, n),
					0
				);
				expect(outcome.stake).toBe(55);
				expect(outcome.returned).toBe(expected);
				expect(viewOf<RouletteView>(view).won).toBe(expected > 55);
			}
		});

		it('returns nothing for a losing spot even when another spot wins', () => {
			// Black loses on every red number; the straight on a red 1 wins.
			const wager: Wager = {
				game: 'roulette',
				bets: [
					{ bet: { kind: 'black' }, amount: 10 },
					{ bet: { kind: 'red' }, amount: 10 },
				],
			};
			for (let i = 0; i < 500; i++) {
				const { outcome, view } = playOne(handler, wager, 20, HUGE_STACK);
				const n = viewOf<RouletteView>(view).number;
				// Exactly one of black/red hits on a non-zero number, paying 2x its own chips.
				expect(outcome.returned).toBe(n === 0 ? 0 : 20);
			}
		});

		it('reports the stake to the engine and merges chips on the same spot', () => {
			const parsed = handler.parseWager(
				{
					game: 'roulette',
					bets: [
						{ bet: { kind: 'red' }, amount: 10 },
						{ bet: { kind: 'red' }, amount: 15 },
						{ bet: { kind: 'odd' }, amount: 5 },
					],
				},
				100,
				HUGE_STACK
			);
			expect(parsed).toEqual({
				game: 'roulette',
				bets: [
					{ bet: { kind: 'red' }, amount: 25 },
					{ bet: { kind: 'odd' }, amount: 5 },
				],
			});
			expect(handler.stakeOf!(parsed)).toBe(30);
		});

		it('refuses chips beyond the table limit, empty tables and bad amounts', () => {
			const red = (amount: number) => rouletteWager({ kind: 'red' }, amount);
			expect(() => handler.parseWager(red(101), 100, HUGE_STACK)).toThrow(GameError);
			expect(() => handler.parseWager(red(100), 100, 50)).toThrow(GameError);
			expect(() => handler.parseWager({ game: 'roulette', bets: [] }, 100, HUGE_STACK)).toThrow(GameError);
			for (const amount of [0, -5, 2.5, Number.NaN]) {
				expect(() => handler.parseWager(red(amount), 100, HUGE_STACK)).toThrow(GameError);
			}
			// Two spots that fit individually but not together.
			expect(() =>
				handler.parseWager(
					{ game: 'roulette', bets: [{ bet: { kind: 'red' }, amount: 60 }, { bet: { kind: 'odd' }, amount: 60 }] },
					100,
					HUGE_STACK
				)
			).toThrow(GameError);
		});
	});

	it('only accepts SPIN, and only once', () => {
		const step = handler.init(
			handler.parseWager(rouletteWager({ kind: 'red' }), BET, HUGE_STACK),
			BET,
			HUGE_STACK
		);
		expect(handler.legalActions(step.state)).toEqual(['SPIN']);
		const spun = handler.apply(step.state, { type: 'SPIN' });
		expect(handler.legalActions(spun.state)).toEqual([]);
		expect(() => handler.apply(spun.state, { type: 'SPIN' })).toThrow(GameError);
		expect(() => handler.apply(step.state, { type: 'FLIP' })).toThrow(GameError);
	});
});

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

describe('dice', () => {
	const handler = gameById('dice');

	it('prices every target from the exact 2d6 combination count', () => {
		for (let target = DICE_MIN_TARGET; target <= DICE_MAX_TARGET; target++) {
			const ways = rollUnderWays(target);
			const multiplier = rollUnderMultiplier(target);
			// Return per unit staked over all 36 combinations.
			const edge = 1 - (ways * multiplier) / DICE_COMBOS;
			// A 3% edge, plus whatever truncating to hundredths gives back.
			expect(edge).toBeGreaterThanOrEqual(0.03 - 1e-9);
			expect(edge).toBeLessThan(0.05);
			expect(multiplier).toBeGreaterThan(1);
		}
		expect(rollUnderWays(2)).toBe(1);
		expect(rollUnderWays(7)).toBe(21);
		expect(rollUnderWays(12)).toBe(36);
	});

	it('pays the roll-under multiplier on a win and nothing on a loss', () => {
		const target = 7;
		const multiplier = rollUnderMultiplier(target);
		const hands = 6_000;
		let wins = 0;
		for (let i = 0; i < hands; i++) {
			const { outcome, view } = playOne(handler, {
				game: 'dice',
				bet: { kind: 'roll_under', target },
			});
			const v = viewOf<DiceView>(view);
			expect(v.dice).toHaveLength(2);
			for (const d of v.dice) {
				expect(d).toBeGreaterThanOrEqual(1);
				expect(d).toBeLessThanOrEqual(DICE_FACES);
			}
			expect(v.roll).toBe(v.dice[0]! + v.dice[1]!);
			if (v.won) {
				wins++;
				expect(v.roll).toBeLessThanOrEqual(target);
				expect(outcome.stake).toBe(BET);
				expect(outcome.returned).toBe(Math.floor(BET * multiplier));
			} else {
				expect(v.roll).toBeGreaterThan(target);
				expect(outcome.returned).toBe(0);
			}
		}
		const expected = (hands * rollUnderWays(target)) / DICE_COMBOS;
		expect(Math.abs(wins - expected)).toBeLessThan(expected * 0.2);
	});

	it('never returns the stake on a losing roll', () => {
		let sawLoss = false;
		for (let i = 0; i < 2_000; i++) {
			const { outcome, view } = playOne(handler, {
				game: 'dice',
				bet: { kind: 'roll_under', target: DICE_MIN_TARGET },
			});
			if (!viewOf<DiceView>(view).won) {
				sawLoss = true;
				expect(outcome.returned).toBe(0);
				expect(outcome.returned - outcome.stake).toBe(-BET);
			}
		}
		expect(sawLoss).toBe(true);
	});

	it('rejects targets outside the playable range', () => {
		// 13 would be a legal-looking number that the curve prices badly, and 99
		// is the trap the range exists to avoid: at even money it costs 49%.
		for (const target of [1, 0, -3, DICE_MAX_TARGET + 1, 34, 51, 99, 2.5, Number.NaN]) {
			expect(() =>
				handler.parseWager({ game: 'dice', bet: { kind: 'roll_under', target } }, BET, HUGE_STACK)
			).toThrow(GameError);
		}
	});

	it('accepts the full playable range at both ends', () => {
		for (const target of [DICE_MIN_TARGET, DICE_MAX_TARGET]) {
			expect(
				handler.parseWager({ game: 'dice', bet: { kind: 'roll_under', target } }, BET, HUGE_STACK)
			).toEqual({ game: 'dice', bet: { kind: 'roll_under', target } });
		}
	});

	it('only accepts ROLL, and only once', () => {
		const step = handler.init(
			handler.parseWager(
				{ game: 'dice', bet: { kind: 'roll_under', target: 5 } },
				BET,
				HUGE_STACK
			),
			BET,
			HUGE_STACK
		);
		expect(handler.legalActions(step.state)).toEqual(['ROLL']);
		const rolled = handler.apply(step.state, { type: 'ROLL' });
		expect(handler.legalActions(rolled.state)).toEqual([]);
		expect(() => handler.apply(rolled.state, { type: 'ROLL' })).toThrow(GameError);
		expect(() => handler.apply(step.state, { type: 'SPIN' })).toThrow(GameError);
	});
});

// ---------------------------------------------------------------------------
// Coin flip
// ---------------------------------------------------------------------------

describe('coin flip', () => {
	const handler = gameById('coinflip');

	it('returns exactly twice the stake on a win and nothing on a loss', () => {
		for (const side of ['heads', 'tails'] as const) {
			let wins = 0;
			let losses = 0;
			for (let i = 0; i < 4_000; i++) {
				const { outcome, view } = playOne(handler, { game: 'coinflip', bet: { side } });
				const v = viewOf<{ result: 'heads' | 'tails'; won: boolean }>(view);
				expect(['heads', 'tails']).toContain(v.result);
				expect(v.won).toBe(v.result === side);
				expect(outcome.stake).toBe(BET);
				if (v.won) {
					wins++;
					expect(outcome.returned).toBe(BET * 2);
				} else {
					losses++;
					expect(outcome.returned).toBe(0);
				}
			}
			expect(wins).toBeGreaterThan(1_700);
			expect(losses).toBeGreaterThan(1_700);
		}
	});

	it('is an even bet, so neither side is worth more', () => {
		for (const side of ['heads', 'tails'] as const) {
			expectNear(
				measureReturn(handler, { game: 'coinflip', bet: { side } }, 20_000),
				0,
				5,
				`coinflip ${side}`
			);
		}
	});

	it('rejects a side that is not a side', () => {
		for (const side of ['Heads', 'up', '', null, 1]) {
			expect(() =>
				handler.parseWager(
					{ game: 'coinflip', bet: { side } } as unknown as Wager,
					BET,
					HUGE_STACK
				)
			).toThrow(GameError);
		}
	});
});

// ---------------------------------------------------------------------------
// Blackjack
// ---------------------------------------------------------------------------

/**
 * What the game must return, derived only from the totals the view reports.
 *
 * This is the whole blackjack payout in one function, written against the casino
 * rules rather than the game's code, so it can be asserted over every hand the
 * game actually produces.
 */
function blackjackReturn(v: BlackjackView, bet: number): number {
	const player = v.player;
	const dealer = v.dealer;
	const playerNatural = player.total === 21 && player.cards.length === 2;
	const dealerNatural = dealer.total === 21 && dealer.cards.length === 2;

	if (playerNatural && dealerNatural) return bet;
	if (playerNatural) return bet + Math.floor((bet * 3) / 2);
	if (player.total > 21) return 0;
	// A dealer blackjack beats any player 21 that is not itself a natural.
	if (dealerNatural) return 0;
	if (dealer.total > 21) return bet * 2;
	if (player.total > dealer.total) return bet * 2;
	if (player.total < dealer.total) return 0;
	return bet;
}

/** The player's decision under a fixed rule, for comparing policies. */
type Policy = (player: HandView, dealerUpCard: number) => 'HIT' | 'STAND';

const dealerUpValue = (dealer: HandView): number => {
	const rank = dealer.cards[0]?.rank ?? 10;
	return rank === 1 ? 11 : rank > 10 ? 10 : rank;
};

/** Hits to 17 and stands, the classic simple strategy. */
const standOn17: Policy = (player) => (player.total >= 17 ? 'STAND' : 'HIT');

/** Stands immediately, which is a deliberately poor policy. */
const alwaysStand: Policy = () => 'STAND';

function playByPolicy(
	handler: GameHandler,
	bet: number,
	stack: number,
	policy: Policy
): Outcome {
	let step = handler.init({ game: 'blackjack' }, bet, stack);
	for (let guard = 0; guard < 12 && !step.outcome; guard++) {
		if (handler.legalActions(step.state).includes('NO_INSURANCE')) {
			step = handler.apply(step.state, { type: 'NO_INSURANCE' });
			continue;
		}
		const v = viewOf<BlackjackView>(step.view);
		const choice = policy(v.player, dealerUpValue(v.dealer));
		step = handler.apply(step.state, { type: choice });
	}
	if (!step.outcome) throw new Error('blackjack never settled');
	return step.outcome;
}

function measurePolicy(policy: Policy, hands: number, bet = BET): Measurement {
	let net = 0;
	let squared = 0;
	for (let i = 0; i < hands; i++) {
		const outcome = playByPolicy(gameById('blackjack'), bet, HUGE_STACK, policy);
		const unit = (outcome.returned - outcome.stake) / bet;
		net += unit;
		squared += unit * unit;
	}
	const mean = net / hands;
	const variance = Math.max(0, squared / hands - mean * mean);
	return { mean, se: Math.sqrt(variance / hands), hands };
}

/** Blackjack total of raw state cards, for the tests that look behind the view. */
const handTotalOf = (cards: Card[]): number => {
	let total = 0;
	let aces = 0;
	for (const card of cards) {
		if (card.rank === 1) {
			aces++;
			total += 11;
		} else total += card.rank >= 10 ? 10 : card.rank;
	}
	while (total > 21 && aces-- > 0) total -= 10;
	return total;
};

describe('blackjack', () => {
	const handler = gameById('blackjack');

	it('returns exactly the casino payout for every hand it deals', () => {
		// Driven by two opposing policies so the sample covers player busts,
		// dealer busts, naturals, pushes and every ordering of the two hands.
		for (const policy of [standOn17, alwaysStand]) {
			for (let i = 0; i < 1_200; i++) {
				const step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
				let current = step;
				for (let guard = 0; guard < 12 && !current.outcome; guard++) {
					if (handler.legalActions(current.state).includes('NO_INSURANCE')) {
						current = handler.apply(current.state, { type: 'NO_INSURANCE' });
						continue;
					}
					const v = viewOf<BlackjackView>(current.view);
					current = handler.apply(current.state, {
						type: policy(v.player, dealerUpValue(v.dealer)),
					});
				}
				const outcome = current.outcome;
				if (!outcome) throw new Error('blackjack never settled');
				const final = viewOf<BlackjackView>(current.view);
				expect(outcome.stake).toBe(BET);
				expect(outcome.returned).toBe(blackjackReturn(final, BET));
			}
		}
	});

	it('hides the hole card and sends no dealer total while it is down', () => {
		// Some deals settle at once (naturals); look at one that is still in play.
		let step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
		while (step.outcome) step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
		const v = viewOf<BlackjackView>(step.view);
		expect(v.dealer.cards.length).toBe(2);
		expect(v.dealer.hidden).toBe(true);
		// No value of any kind leaves the server before the hand resolves.
		expect(v.dealer.total).toBe(0);
		expect(step.outcome).toBeNull();
	});

	describe('double and split', () => {
		const c = (rank: number) => makeCard(rank, 's');
		/** A round with a stacked deal, so the decision under test is certain. */
		function stacked(player: number[], dealer: number[], next: number[], stack = HUGE_STACK) {
			const step = handler.init({ game: 'blackjack' }, BET, stack);
			const s = step.state as any;
			// init may already have settled or offered insurance on its random deal;
			// put the round back to a plain mid-hand state before stacking it.
			s.done = false;
			s.holeDown = true;
			s.insuranceOffer = false;
			s.insurance = 0;
			s.acted = false;
			s.hands[0].stood = false;
			s.hands[0].cards = player.map(c);
			s.dealer = dealer.map(c);
			// Replace the head of the shoe so upcoming draws are known.
			s.shoe.cards.splice(s.shoe.pos, next.length, ...next.map(c));
			return s;
		}

		it('shows one dealer card up and none of its value', () => {
			// Some deals settle at once (naturals); look at one that is still in play.
			let step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
			while (step.outcome) step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
			const v = viewOf<BlackjackView>(step.view);
			expect(v.dealer.cards).toHaveLength(2);
			expect(v.dealer.hidden).toBe(true);
			expect(v.dealer.total).toBe(0);
		});

		it('doubles the bet, takes one card and stands', () => {
			const s = stacked([5, 6], [10, 7], [10]);
			expect(handler.legalActions(s)).toContain('DOUBLE');
			const step = handler.apply(s, { type: 'DOUBLE' });
			// 5+6+10 = 21 beats 17.
			expect(step.outcome).toEqual({ stake: BET * 2, returned: BET * 4, detail: 'You win with 21' });
		});

		it('refuses a double the stack cannot cover', () => {
			const s = stacked([5, 6], [10, 7], [10], BET);
			expect(handler.legalActions(s)).not.toContain('DOUBLE');
			expect(() => handler.apply(s, { type: 'DOUBLE' })).toThrow(GameError);
		});

		it('only offers a double on the first two cards', () => {
			const s = stacked([2, 3], [10, 7], [2, 9]);
			handler.apply(s, { type: 'HIT' });
			expect(handler.legalActions(s)).not.toContain('DOUBLE');
		});

		it('splits a pair into two hands at the original bet each', () => {
			const s = stacked([8, 8], [10, 7], [3, 10, 10, 10]);
			expect(handler.legalActions(s)).toContain('SPLIT');
			let step = handler.apply(s, { type: 'SPLIT' });
			expect(viewOf<{ hands: unknown[] }>(step.view).hands).toHaveLength(2);
			expect(step.outcome).toBeNull();
			step = handler.apply(s, { type: 'STAND' }); // 8+3 = 11 stands
			step = handler.apply(s, { type: 'STAND' }); // 8+10 = 18 stands
			// Dealer 17 beats 11, loses to 18.
			expect(step.outcome!.stake).toBe(BET * 2);
			expect(step.outcome!.returned).toBe(BET * 2);
		});

		it('splits two different ten-value cards, and refuses an unequal pair', () => {
			expect(handler.legalActions(stacked([10, 13], [10, 7], [2, 3]))).toContain('SPLIT');
			expect(handler.legalActions(stacked([10, 9], [10, 7], [2, 3]))).not.toContain('SPLIT');
		});

		it('refuses a split the stack cannot cover', () => {
			expect(handler.legalActions(stacked([8, 8], [10, 7], [3, 4], BET))).not.toContain('SPLIT');
		});

		it('gives split aces one card each and treats 21 as ordinary', () => {
			const s = stacked([1, 1], [10, 7], [10, 10]);
			const step = handler.apply(s, { type: 'SPLIT' });
			// Both hands are 21 after one card and neither is a natural: 1:1.
			expect(step.outcome).toEqual({ stake: BET * 2, returned: BET * 4, detail: 'Hand 1: You win with 21; Hand 2: You win with 21' });
		});

		it('offers insurance on an ace, and pays 2:1 when the dealer has blackjack', () => {
			const s = stacked([10, 9], [1, 13], []);
			s.insuranceOffer = true;
			expect(handler.legalActions(s)).toEqual(['INSURE', 'NO_INSURANCE']);
			expect(viewOf<BlackjackView & { insuranceOffer: number }>(handler.view(s)).insuranceOffer).toBe(BET / 2);
			const step = handler.apply(s, { type: 'INSURE' });
			// Main bet lost, insurance (half the bet) pays 2:1: stake 150, returned 150.
			expect(step.outcome).toMatchObject({ stake: BET + BET / 2, returned: (BET / 2) * 3 });
			expect(viewOf<BlackjackView>(step.view).dealer.hidden).toBeUndefined();
		});

		it('resolves a dealer blackjack at once when insurance is declined', () => {
			const s = stacked([10, 9], [1, 13], []);
			s.insuranceOffer = true;
			const step = handler.apply(s, { type: 'NO_INSURANCE' });
			expect(step.outcome).toMatchObject({ stake: BET, returned: 0, detail: 'Dealer blackjack' });
		});

		it('loses the insurance and carries on when the dealer has no blackjack', () => {
			const s = stacked([10, 9], [1, 6], []);
			s.insuranceOffer = true;
			let step = handler.apply(s, { type: 'INSURE' });
			expect(step.outcome).toBeNull();
			expect(handler.legalActions(s)).toContain('HIT');
			step = handler.apply(s, { type: 'STAND' });
			// 19 beats the dealer's soft 17; the insurance half-bet is lost.
			expect(step.outcome!.stake).toBe(BET + BET / 2);
			expect(step.outcome!.returned).toBe(BET * 2);
			expect(step.outcome!.detail).toContain('insurance lost');
		});

		it('settles on the deal: naturals, and dealer blackjack with no ace showing', () => {
			let playerBJ = 0;
			let dealerBJ = 0;
			let offers = 0;
			for (let i = 0; i < 20_000; i++) {
				const step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
				const v = viewOf<BlackjackView & { insuranceOffer: number | null; opening: boolean }>(step.view);
				const s = step.state as any;
				const dealerNatural = s.dealer.length === 2 && handTotalOf(s.dealer) === 21;
				const playerNatural = handTotalOf(s.hands[0].cards) === 21;
				if (playerNatural) {
					playerBJ++;
					expect(step.outcome).not.toBeNull();
					expect(v.opening).toBe(true);
				} else if (v.insuranceOffer !== null) {
					offers++;
					expect(s.dealer[0].rank).toBe(1);
					expect(step.outcome).toBeNull();
				} else if (dealerNatural) {
					dealerBJ++;
					// A ten up (or an unaffordable ace) never lets the hand play on.
					expect(step.outcome).toMatchObject({ stake: BET, returned: 0 });
				} else {
					expect(step.outcome).toBeNull();
				}
			}
			expect(playerBJ).toBeGreaterThan(300);
			expect(dealerBJ).toBeGreaterThan(300);
			expect(offers).toBeGreaterThan(300);
		}, 30_000);

		it('does not offer insurance the stack cannot cover', () => {
			for (let i = 0; i < 3_000; i++) {
				const step = handler.init({ game: 'blackjack' }, BET, BET);
				expect(viewOf<{ insuranceOffer: number | null }>(step.view).insuranceOffer).toBeNull();
			}
		});
	});

	it('pays 3:2 on a natural and pushes on a mutual natural, resolving on the deal', () => {
		let naturals = 0;
		let mutual = 0;
		for (let i = 0; i < 6_000; i++) {
			const step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
			const v = viewOf<BlackjackView>(step.view);
			const playerNatural = v.player.total === 21 && v.player.cards.length === 2;
			if (!playerNatural) continue;
			// No decision is asked for: the hand is over as soon as it is dealt.
			const outcome = step.outcome!;
			expect(outcome).not.toBeNull();
			expect(handler.legalActions(step.state)).toEqual([]);
			const dealerNatural = v.dealer.total === 21 && v.dealer.cards.length === 2;
			naturals++;
			if (dealerNatural) {
				mutual++;
				expect(outcome.returned).toBe(BET);
			} else {
				expect(outcome.returned).toBe(BET + Math.floor((BET * 3) / 2));
			}
		}
		// A natural lands on roughly one hand in twenty-two.
		expect(naturals).toBeGreaterThan(180);
		expect(mutual).toBeGreaterThan(2);
	}, 12_000);

	it('costs the player money, and less when it plays a real strategy', () => {
		const hands = 10_000;
		const smart = measurePolicy(standOn17, hands);
		const naive = measurePolicy(alwaysStand, hands);
		process.stdout.write(
			`blackjack stand-on-17: ${(smart.mean * 100).toFixed(3)}% ` +
				`+/-${(smart.se * 5 * 100).toFixed(3)}pp   ` +
				`always-stand: ${(naive.mean * 100).toFixed(3)}% +/-${(naive.se * 5 * 100).toFixed(3)}pp\n`
		);
		// The house edge is thin but real. Six decks against a dealer who stands on
		// all 17s is well under 2%, so this pins the sign and the magnitude without
		// quoting a remembered figure: a mis-priced payout or a wrong dealer rule
		// moves this by whole points, not tenths.
		expect(smart.mean).toBeLessThan(0);
		expect(smart.mean).toBeGreaterThan(-0.09);
		// Standing on everything loses to every dealer 17-21, so a strategy has to
		// beat it comfortably.
		expect(smart.mean).toBeGreaterThan(naive.mean + 0.02);
	}, 20_000);

	it('always offers HIT and STAND, and nothing once the hand settles', () => {
		// Skip deals that settle at once or open on an insurance offer.
		let step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
		while (step.outcome || handler.legalActions(step.state).includes('INSURE')) {
			step = handler.init({ game: 'blackjack' }, BET, HUGE_STACK);
		}
		expect(handler.legalActions(step.state)).toEqual(expect.arrayContaining(['HIT', 'STAND']));
		const done = handler.apply(step.state, { type: 'STAND' });
		expect(handler.legalActions(done.state)).toEqual([]);
		expect(() => handler.apply(done.state, { type: 'HIT' })).toThrow(GameError);
		expect(() => handler.apply(step.state, { type: 'ROLL' })).toThrow(GameError);
	}, 12_000);
});

// ---------------------------------------------------------------------------
// Baccarat
// ---------------------------------------------------------------------------

describe('baccarat', () => {
	const handler = gameById('baccarat');

	it('deals the opening two cards to both sides before anything is resolved', () => {
		const step = handler.init(
			handler.parseWager({ game: 'baccarat', bet: { main: 'player' } }, BET, HUGE_STACK),
			BET,
			HUGE_STACK
		);
		const v = viewOf<BaccaratView>(step.view);
		expect(v.player.cards.length).toBe(2);
		expect(v.banker.cards.length).toBe(2);
		expect(step.outcome).toBeNull();
		expect(handler.legalActions(step.state)).toEqual(['DEAL']);
	});

	it('stops the coup on a natural, so nobody ever draws a third card', () => {
		// An opening 8 or 9 on either hand ends the hand immediately. This is worth
		// about a third of all hands, so a version without it looks plausible hand
		// by hand and is measurably wrong in aggregate.
		const hands = 1_200;
		let naturals = 0;
		for (let i = 0; i < hands; i++) {
			const { view } = playOne(handler, { game: 'baccarat', bet: { main: 'player' } });
			const v = viewOf<BaccaratView>(view);
			// Neither side ever holds more than three cards.
			expect(v.player.cards.length).toBeLessThanOrEqual(3);
			expect(v.banker.cards.length).toBeLessThanOrEqual(3);
			const playerNatural = v.player.cards.length === 2 && v.player.total >= 8;
			const bankerNatural = v.banker.cards.length === 2 && v.banker.total >= 8;
			if (playerNatural || bankerNatural) {
				naturals++;
				// Nobody drew, on either side.
				expect(v.player.cards.length).toBe(2);
				expect(v.banker.cards.length).toBe(2);
			}
		}
		expect(naturals / hands).toBeGreaterThan(0.25);
		expect(naturals / hands).toBeLessThan(0.45);
	});

	it('makes Banker the favourite', () => {
		// Banker draws on 0-2 always and on 3 almost always, which is what leaves
		// it ahead of Player once ties are set aside. A banker that fell through to
		// the tableau when Player stood left Player ahead by a full point.
		let player = 0;
		let banker = 0;
		let tie = 0;
		const hands = 12_000;
		for (let i = 0; i < hands; i++) {
			const { view } = playOne(handler, { game: 'baccarat', bet: { main: 'player' } });
			const outcome = viewOf<BaccaratView>(view).outcome;
			if (outcome === 'player') player++;
			else if (outcome === 'banker') banker++;
			else tie++;
		}
		process.stdout.write(
			`baccarat: player ${(player / hands).toFixed(5)} banker ${(banker / hands).toFixed(5)} ` +
				`tie ${(tie / hands).toFixed(5)}\n`
		);
		// In expectation Banker is ahead, but this hand count can still cross by a
		// few dozen either way; the exact-model test below pins the sign.
		expect(Math.abs(banker - player)).toBeLessThan(500);
		expect(tie / hands).toBeGreaterThan(0.085);
		expect(tie / hands).toBeLessThan(0.105);
	}, 12_000);

	it('pushes Player and Banker on a tie instead of charging a full loss', () => {
		// Ties land about one time in ten. Charging a full loss on them would take
		// the edge on those bets from roughly 1% to roughly 10%.
		let pushes = 0;
		for (let i = 0; i < 3_000; i++) {
			const { outcome, view } = playOne(handler, { game: 'baccarat', bet: { main: 'player' } });
			const v = viewOf<BaccaratView>(view);
			if (v.outcome !== 'tie') continue;
			pushes++;
			// The stake is handed straight back: a push is neither a win nor a loss.
			expect(outcome.returned).toBe(BET);
			expect(outcome.returned - outcome.stake).toBe(0);
		}
		expect(pushes).toBeGreaterThan(200);
	}, 12_000);

	it('rounds the commission up so small banker bets never beat the house', () => {
		// Flooring the 5% commission charges nothing on bets under 20 chips, which
		// makes Banker a positive-expectation bet. Ceiling it keeps whole chips and
		// keeps the edge with the house at every stake.
		for (const bet of [1, 5, 10, 19, 20, 21, 100]) {
			for (let i = 0; i < 300; i++) {
				const { outcome, view } = playOne(handler, { game: 'baccarat', bet: { main: 'banker' } }, bet, HUGE_STACK);
				expect(Number.isInteger(outcome.returned)).toBe(true);
				if (viewOf<BaccaratView>(view).outcome === 'banker') {
					expect(outcome.returned).toBe(bet * 2 - Math.ceil(bet * BACCARET_COMMISSION));
				}
			}
		}
		// Where the commission does bite, the edge is back.
		// The true return is about -1%, but a sample this size swings by a couple of
		// points either way, so the claim is bounded by the standard error like the
		// other measured returns rather than by a fixed line a lucky run can cross.
		const measured = measureReturn(handler, { game: 'baccarat', bet: { main: 'banker' } }, 5_000, 100);
		expect(measured.mean).toBeLessThan(0.02 + 4 * measured.se);
	}, 30_000);

	it('stakes the pair side bet to match the main bet', () => {
		// The pair bet is a second stake on the same deal, so taking it has to
		// appear in the round's stake as well as in the settlement. Reporting only
		// the main bet would let a player stake Pair Plus for free.
		for (let i = 0; i < 1_000; i++) {
			const { outcome, view } = playOne(
				handler,
				{ game: 'baccarat', bet: { main: 'player', pair: 'either' } }
			);
			const v = viewOf<BaccaratView>(view);
			const pairHit = v.playerPair || v.bankerPair;
			const mainReturn =
				v.outcome === 'player' ? BET * 2 : v.outcome === 'tie' ? BET : 0;
			const pairReturn = pairHit ? BET * (1 + BACCARAT_ODDS.eitherPair) : 0;
			expect(outcome.stake).toBe(BET * 2);
			expect(outcome.returned).toBe(mainReturn + pairReturn);
		}
	});

	it('refuses a pair side bet the stack cannot cover', () => {
		// Two stakes, one stack. This has to be caught before a card is dealt,
		// because the engine commits the wager first and that is the only point it
		// can still refuse.
		expect(() =>
			handler.parseWager({ game: 'baccarat', bet: { main: 'player', pair: 'either' } }, 60, 100)
		).toThrow(GameError);
		// Exactly two stakes is fine.
		expect(
			handler.parseWager({ game: 'baccarat', bet: { main: 'player', pair: 'either' } }, 50, 100)
		).toEqual({ game: 'baccarat', bet: { main: 'player', pair: 'either', pairAmount: 50 } });
	});

	it('sizes the pair side bet independently of the main bet', () => {
		const wager = { game: 'baccarat', bet: { main: 'player', pair: 'either', pairAmount: 7 } } as const;
		expect(handler.parseWager(wager, 50, 100)).toEqual(wager);
		// Main plus side bet must fit the stack, and the side bet is whole chips.
		expect(() => handler.parseWager({ ...wager, bet: { ...wager.bet, pairAmount: 51 } }, 50, 100)).toThrow(GameError);
		for (const pairAmount of [0, -1, 2.5, Number.NaN]) {
			expect(() => handler.parseWager({ ...wager, bet: { ...wager.bet, pairAmount } }, 50, 100)).toThrow(GameError);
		}
		for (let i = 0; i < 500; i++) {
			const { outcome, view } = playOne(handler, wager);
			const v = viewOf<BaccaratView>(view);
			const mainReturn = v.outcome === 'player' ? BET * 2 : v.outcome === 'tie' ? BET : 0;
			const pairReturn = v.playerPair || v.bankerPair ? 7 * (1 + BACCARAT_ODDS.eitherPair) : 0;
			expect(outcome.stake).toBe(BET + 7);
			expect(outcome.returned).toBe(mainReturn + pairReturn);
		}
	});

	it('rejects a main bet or pair bet that is not one', () => {
		for (const bet of [
			{ main: 'Player' },
			{ main: 'tie', pair: 'both' },
			{ main: 'player', pair: 'any' },
		]) {
			expect(() =>
				handler.parseWager({ game: 'baccarat', bet } as unknown as Wager, BET, HUGE_STACK)
			).toThrow(GameError);
		}
	});

	it('only accepts DEAL, and only once', () => {
		const step = handler.init(
			handler.parseWager({ game: 'baccarat', bet: { main: 'player' } }, BET, HUGE_STACK),
			BET,
			HUGE_STACK
		);
		const done = handler.apply(step.state, { type: 'DEAL' });
		expect(handler.legalActions(done.state)).toEqual([]);
		expect(() => handler.apply(done.state, { type: 'DEAL' })).toThrow(GameError);
		expect(() => handler.apply(step.state, { type: 'ROLL' })).toThrow(GameError);
	});
});

/**
 * An independent model of the baccarat shoe, used to pin the frequencies the game
 * is expected to produce.
 *
 * The deal is a rank-level search over an eight-deck shoe with the standard
 * rules: a natural ends the coup, Player draws on 0-5, and Banker follows the
 * tableau.
 *
 * Each hand is weighted by how many cards it actually dealt. A hand that stops at
 * four cards is one specific four-card draw, worth 1/(416)_4, while a six-card hand
 * is worth 1/(416)_6 — counting every leaf once would over-value the short hands
 * by a factor of about 410 and quietly distort every frequency below. The
 * `total` assertion is the check that the weighting is right.
 */
function enumerateBaccarat(): {
	player: number;
	banker: number;
	tie: number;
	playerPair: number;
	bankerPair: number;
	eitherPair: number;
	total: number;
} {
	const RANKS = 13;
	const PER_RANK = 32; // eight decks, four suits
	const SHOE = 416;

	/** Baccarat totals: aces and tens are worth 1 and 0, so rank >= 10 adds nothing. */
	const totalOf = (ranks: readonly number[]): number => {
		let t = 0;
		for (const r of ranks) if (r < 10) t += r;
		while (t > 9) t -= 10;
		return t;
	};
	const drawValue = (r: number): number => (r === 1 ? 1 : r >= 10 ? 0 : r);

	/** The standard tableau: does Banker draw, given their total and Player's third card? */
	const bankerDraws = (bankerTotal: number, playerThird: number | null): boolean => {
		if (bankerTotal >= 7) return false;
		// With no Player third card to consult, Banker follows Player's own rule.
		if (playerThird === null) return bankerTotal <= 5;
		if (bankerTotal <= 2) return true;
		if (bankerTotal === 3) return playerThird !== 8;
		if (bankerTotal === 4) return playerThird >= 2 && playerThird <= 7;
		if (bankerTotal === 5) return playerThird >= 4 && playerThird <= 7;
		if (bankerTotal === 6) return playerThird === 6 || playerThird === 7;
		return false;
	};

	/** (416)_k, the number of ordered physical draws of length k. */
	const falling = [1];
	for (let k = 1; k <= 6; k++) falling.push(falling[k - 1]! * (SHOE - (k - 1)));

	const used = new Array<number>(RANKS + 1).fill(0);
	const player: number[] = [];
	const banker: number[] = [];

	// Tallied per hand length, since each length carries its own weight.
	const rows = [4, 5, 6].map((k) => ({
		k,
		weight: 0,
		player: 0,
		banker: 0,
		tie: 0,
		playerPair: 0,
		bankerPair: 0,
	}));

	function tally(weight: number): void {
		const row = rows[player.length + banker.length - 4]!;
		row.weight += weight;
		if (player[0] === player[1]) row.playerPair += weight;
		if (banker[0] === banker[1]) row.bankerPair += weight;
		const p = totalOf(player);
		const b = totalOf(banker);
		if (p > b) row.player += weight;
		else if (p < b) row.banker += weight;
		else row.tie += weight;
	}

	function finishBanker(weight: number): void {
		const playerThird = player.length === 3 ? drawValue(player[2]!) : null;
		if (!bankerDraws(totalOf(banker), playerThird)) {
			tally(weight);
			return;
		}
		for (let r = 1; r <= RANKS; r++) {
			const left = PER_RANK - used[r]!;
			if (left <= 0) continue;
			used[r]!++;
			banker.push(r);
			tally(weight * left);
			banker.pop();
			used[r]!--;
		}
	}

	function open(pos: number, weight: number): void {
		if (pos === 4) {
			// A natural on either side ends the coup before anything is drawn.
			if (totalOf(player) >= 8 || totalOf(banker) >= 8) {
				tally(weight);
				return;
			}
			if (totalOf(player) <= 5) {
				for (let r = 1; r <= RANKS; r++) {
					const left = PER_RANK - used[r]!;
					if (left <= 0) continue;
					used[r]!++;
					player.push(r);
					finishBanker(weight * left);
					player.pop();
					used[r]!--;
				}
				return;
			}
			finishBanker(weight);
			return;
		}
		const hand = pos < 2 ? player : banker;
		for (let r = 1; r <= RANKS; r++) {
			const left = PER_RANK - used[r]!;
			if (left <= 0) continue;
			used[r]!++;
			hand.push(r);
			open(pos + 1, weight * left);
			hand.pop();
			used[r]!--;
		}
	}

	open(0, 1);

	const out = {
		player: 0,
		banker: 0,
		tie: 0,
		playerPair: 0,
		bankerPair: 0,
		eitherPair: 0,
		total: 0,
	};
	for (const row of rows) {
		const w = falling[row.k]!;
		out.player += row.player / w;
		out.banker += row.banker / w;
		out.tie += row.tie / w;
		out.playerPair += row.playerPair / w;
		out.bankerPair += row.bankerPair / w;
		out.total += row.weight / w;
	}
	out.eitherPair = out.playerPair + out.bankerPair - out.playerPair * out.bankerPair;
	return out;
}

/** The standard punto banco tableau, exposed so the game can be checked against it. */
function bankerTableau(bankerTotal: number, playerThird: number): boolean {
	if (bankerTotal >= 7) return false;
	if (bankerTotal <= 2) return true;
	if (bankerTotal === 3) return playerThird !== 8;
	if (bankerTotal === 4) return playerThird >= 2 && playerThird <= 7;
	if (bankerTotal === 5) return playerThird >= 4 && playerThird <= 7;
	if (bankerTotal === 6) return playerThird === 6 || playerThird === 7;
	return false;
}

describe('baccarat against an exact model of the shoe', () => {
	const model = enumerateBaccarat();

	it('weights the enumeration so the probabilities sum to one', () => {
		// If this drifts, every frequency below is off by a constant factor and the
		// comparison to the game means nothing.
		expect(model.total).toBeCloseTo(1, 10);
	});

	it('produces the outcome split the paytable is built around', () => {
		process.stdout.write(
			`exact model: player ${model.player.toFixed(5)} banker ${model.banker.toFixed(5)} ` +
				`tie ${model.tie.toFixed(5)} pair ${model.playerPair.toFixed(5)} ` +
				`either pair ${model.eitherPair.toFixed(5)}\n`
		);
		// Banker wins more often than Player.
		expect(model.banker).toBeGreaterThan(model.player);
		// A tie lands a shade under one time in ten.
		expect(model.tie).toBeGreaterThan(0.09);
		expect(model.tie).toBeLessThan(0.1);
		// A pair is worth about a fourteenth of hands.
		expect(model.playerPair).toBeGreaterThan(0.07);
		expect(model.playerPair).toBeLessThan(0.08);
		expect(model.eitherPair).toBeGreaterThan(0.14);
		expect(model.eitherPair).toBeLessThan(0.15);
	});

	it('gives every wager a house edge, and no wager a player edge', () => {
		// Player and Banker push on a tie, so their edges are the difference
		// between their win rates. Everything else loses outright.
		const pushesOnTie = (qWin: number, qLose: number, odds = 1) => qWin * odds - qLose;
		const losesOnTie = (q: number, odds: number, commission = 0) =>
			q * (odds - commission) - (1 - q);

		expect(pushesOnTie(model.player, model.banker)).toBeLessThan(0);
		expect(
			pushesOnTie(model.banker, model.player, 1 - BACCARET_COMMISSION)
		).toBeLessThan(0);
		expect(losesOnTie(model.tie, BACCARAT_ODDS.tie)).toBeLessThan(0);
		expect(losesOnTie(model.playerPair, BACCARAT_ODDS.playerPair)).toBeLessThan(0);
		expect(losesOnTie(model.bankerPair, BACCARAT_ODDS.bankerPair)).toBeLessThan(0);
		expect(losesOnTie(model.eitherPair, BACCARAT_ODDS.eitherPair)).toBeLessThan(0);
	});

	it('prices Either Pair at 5:1 rather than the 8:1 it once paid', () => {
		const q = model.eitherPair;
		expect(BACCARAT_ODDS.eitherPair).toBe(5);
		// At 8:1 the bet was worth more than a quarter of every chip staked on it,
		// which is the whole reason the price moved.
		expect(q * 8 - (1 - q)).toBeGreaterThan(0.25);
		expect(q * BACCARAT_ODDS.eitherPair - (1 - q)).toBeLessThan(0);
	});

	it('matches the game within sampling error', () => {
		const handler = gameById('baccarat');
		const hands = 4_000;
		let player = 0;
		let banker = 0;
		let tie = 0;
		for (let i = 0; i < hands; i++) {
			const { view } = playOne(handler, { game: 'baccarat', bet: { main: 'player' } });
			const outcome = viewOf<BaccaratView>(view).outcome;
			if (outcome === 'player') player++;
			else if (outcome === 'banker') banker++;
			else tie++;
		}
		// Five standard errors is a generous band, but a wrong draw rule moves
		// these by whole points, so nothing subtle can hide inside it.
		const within = (measured: number, exact: number) =>
			Math.abs(measured / hands - exact) < 7 / Math.sqrt(hands);
		expect(within(player, model.player)).toBe(true);
		expect(within(banker, model.banker)).toBe(true);
		expect(within(tie, model.tie)).toBe(true);
	}, 12_000);

	it('agrees with the tableau the game is meant to implement', () => {
		// The banker draw rule is the easiest thing in the game to get subtly
		// wrong, and the enumeration above assumes this exact table. If the two
		// ever disagree the model is measuring a different game than the one
		// shipped, so they are spelled out here side by side.
		// Banker 6 draws only on a Player third card of 6 or 7.
		expect(bankerTableau(6, 5)).toBe(false);
		expect(bankerTableau(6, 6)).toBe(true);
		expect(bankerTableau(6, 7)).toBe(true);
		expect(bankerTableau(6, 8)).toBe(false);
		// Banker 3 stands on an 8, everything else draws.
		expect(bankerTableau(3, 8)).toBe(false);
		expect(bankerTableau(3, 7)).toBe(true);
		// Banker 4 and 5 draw in the middle of the range.
		expect(bankerTableau(4, 1)).toBe(false);
		expect(bankerTableau(4, 7)).toBe(true);
		expect(bankerTableau(5, 3)).toBe(false);
		expect(bankerTableau(5, 4)).toBe(true);
		// Banker stands on 7 and above whatever Player did.
		expect(bankerTableau(7, 2)).toBe(false);
		expect(bankerTableau(9, 2)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Three Card Poker
// ---------------------------------------------------------------------------

/** A three card wager, optionally with a Pair Plus side bet. */
function tcpWager(pairPlus?: number): Wager {
	return {
		game: 'threecard',
		bet: pairPlus === undefined ? { ante: BET } : { ante: BET, pairPlus },
	};
}

/** What Pair Plus owes on a hand, from the shared paytable. */
const pairPlusReturn = (category: HandCategory, pairPlus: number): number =>
	pairPlus > 0 ? pairPlus * (1 + TCP_PAIR_PLUS[category as TcpRank]) : 0;

describe('three card poker', () => {
	const handler = () => gameById('threecard');

	it('ranks every category below the one above it', () => {
		// One representative hand per category, in the order the paytable assumes.
		const hands: ReadonlyArray<readonly [readonly [string, SuitName][], HandCategory]> = [
			[[['A', 's'], ['K', 's'], ['Q', 's']], 'royal flush'],
			[[['5', 'h'], ['4', 'h'], ['3', 'h']], 'straight flush'],
			[[['7', 's'], ['7', 'h'], ['7', 'd']], 'three of a kind'],
			[[['9', 's'], ['8', 'h'], ['7', 'd']], 'straight'],
			[[['A', 'd'], ['J', 'd'], ['7', 'd']], 'flush'],
			[[['K', 's'], ['K', 'h'], ['4', 'd']], 'pair'],
			[[['A', 's'], ['9', 'h'], ['5', 'd']], 'high card'],
		];
		let previous = Number.POSITIVE_INFINITY;
		for (const [ranks, expected] of hands) {
			const scored = rankHand(ranks.map(([r, s]) => card(r, s)));
			expect(scored.category).toBe(expected);
			expect(scored.score).toBeLessThan(previous);
			previous = scored.score;
		}
		// Every category in the paytable is reachable and nothing is missing.
		expect(new Set(hands.map(([, c]) => c)).size).toBe(7);
	});

	it('scores a wheel as five-high, not a wrap around to ace-high', () => {
		const wheel = rankHand([card('A', 's'), card('2', 'h'), card('3', 'd')]);
		expect(wheel.category).toBe('straight');
		expect(wheel.label).toBe('5 high Straight');
		// In this game's ranking the wheel is treated as five-high, so it beats
		// 2-3-4 and loses to broadway.
		const six = rankHand([card('2', 's'), card('3', 'h'), card('4', 'd')]);
		expect(wheel.score).toBeGreaterThan(six.score);
		// And Q-K-A broadway is the highest, below the royal flush only in flushes.
		const broadway = rankHand([card('A', 's'), card('K', 'h'), card('Q', 'd')]);
		expect(broadway.category).toBe('straight');
	});

	it('prefers a pair of kings over a pair of threes', () => {
		expect(rankHand([card('K', 's'), card('K', 'h'), card('3', 'd')]).score).toBeGreaterThan(
			rankHand([card('3', 's'), card('3', 'h'), card('9', 'd')]).score
		);
		// The kicker is irrelevant, so two pairs of the same rank score equally.
		expect(rankHand([card('K', 's'), card('K', 'h'), card('2', 'd')]).score).toBe(
			rankHand([card('K', 'c'), card('K', 'd'), card('A', 's')]).score
		);
	});

	it('prefers a straight flush over a plain flush of the same cards', () => {
		const straightFlush = rankHand([card('5', 's'), card('4', 's'), card('3', 's')]);
		const flush = rankHand([card('A', 'h'), card('J', 'h'), card('7', 'h')]);
		expect(straightFlush.category).toBe('straight flush');
		expect(straightFlush.score).toBeGreaterThan(flush.score);
	});

	it('prefers three of a kind over a straight of the same rank', () => {
		const trips = rankHand([card('7', 's'), card('7', 'h'), card('7', 'd')]);
		const straight = rankHand([card('7', 's'), card('8', 'h'), card('9', 'd')]);
		expect(trips.category).toBe('three of a kind');
		expect(trips.score).toBeGreaterThan(straight.score);
	});

	it('loses the whole Pair Plus bet on a high card hand', () => {
		// Regression: a losing Pair Plus used to hand back the stake (or more).
		expect(TCP_PAIR_PLUS['high card']).toBe(-1);
		expect(pairPlusReturn('high card', 24)).toBe(0);
		let seen = 0;
		for (let i = 0; i < 5_000; i++) {
			const { outcome, view } = playOne(handler(), tcpWager(24), BET, BET * 2 + 24, 'FOLD');
			if (categoryOf(viewOf<ThreeCardView>(view).hand) !== 'high card') continue;
			seen++;
			expect(outcome.stake).toBe(BET + 24);
			expect(outcome.returned).toBe(0);
		}
		expect(seen).toBeGreaterThan(0);
	});

	it('breaks ties card by card and uses the standard paytables', () => {
		const hand = (...c: [string, SuitName][]) => c.map(([r, su]) => card(r, su));
		const kk5 = hand(['K', 's'], ['K', 'h'], ['5', 'd']);
		const kk3 = hand(['K', 'c'], ['K', 'd'], ['3', 's']);
		expect(compareHands(kk5, kk3)).toBeGreaterThan(0);
		expect(compareHands(kk3, kk5)).toBeLessThan(0);
		const a94 = hand(['A', 's'], ['9', 'h'], ['4', 'd']);
		const a83 = hand(['A', 'c'], ['8', 'd'], ['3', 's']);
		expect(compareHands(a94, a83)).toBeGreaterThan(0);
		expect(compareHands(a94, hand(['A', 'h'], ['9', 'c'], ['4', 's']))).toBe(0);
		expect(TCP_PAIR_PLUS).toMatchObject({ 'straight flush': 40, 'three of a kind': 30, straight: 6, flush: 3, pair: 1 });
		expect(TCP_ANTE_BONUS).toMatchObject({ 'straight flush': 5, 'three of a kind': 4, straight: 1 });
	});

	it('has exactly the seven published categories, and no four of a kind', () => {
		const categories = Object.keys(TCP_PAIR_PLUS) as TcpRank[];
		expect(categories.sort()).toEqual([
			'flush',
			'high card',
			'pair',
			'royal flush',
			'straight',
			'straight flush',
			'three of a kind',
		]);
		expect(categories).not.toContain('four of a kind' as never);
	});

	it('qualifies the dealer from queen-high upward', () => {
		const qualifies = (ranks: readonly [string, SuitName][]) => {
			const scored = rankHand(ranks.map(([r, s]) => card(r, s)));
			// The rule is score > 200 (a pair or better) or a queen-high hand.
			return scored.score > 200 || (scored.score < 100 && scored.score >= 12);
		};
		expect(qualifies([['Q', 's'], ['9', 'h'], ['4', 'd']])).toBe(true);
		expect(qualifies([['K', 's'], ['7', 'h'], ['2', 'd']])).toBe(true);
		expect(qualifies([['A', 's'], ['2', 'h'], ['3', 'd']])).toBe(true);
		expect(qualifies([['J', 's'], ['9', 'h'], ['4', 'd']])).toBe(false);
		expect(qualifies([['9', 's'], ['7', 'h'], ['2', 'd']])).toBe(false);
	});

	it('charges the ante and its matching play bet when the hand is played', () => {
		for (let i = 0; i < 1_000; i++) {
			const { outcome } = playOne(handler(), tcpWager(), BET, BET * 2, 'PLAY');
			expect(outcome.stake).toBe(BET * 2);
		}
	});

	it('charges only the ante on a plain fold, because the play bet was never live', () => {
		for (let i = 0; i < 500; i++) {
			const { outcome, view } = playOne(handler(), tcpWager(), BET, BET * 2, 'FOLD');
			expect(viewOf<ThreeCardView>(view).folded).toBe(true);
			expect(viewOf<ThreeCardView>(view).dealerQualifies).toBeNull();
			expect(outcome.stake).toBe(BET);
			// Folding always loses the ante, so the round can never be a win.
			expect(outcome.returned).toBe(0);
		}
	});

	it('charges the ante and Pair Plus on a fold, never the play bet', () => {
		// The case a fold is easiest to get wrong: Pair Plus settles independently
		// of the fold, so it was still at risk and belongs in the stake, while the
		// play bet was never live and must not be counted. Reporting only the ante
		// would let a player stake Pair Plus for free.
		const pairPlus = 40;
		for (let i = 0; i < 1_000; i++) {
			const { outcome, view } = playOne(
				handler(),
				tcpWager(pairPlus),
				BET,
				BET * 2 + pairPlus,
				'FOLD'
			);
			const v = viewOf<ThreeCardView>(view);
			expect(outcome.stake).toBe(BET + pairPlus);
			// A fold's only possible payout is Pair Plus, at its own odds.
			expect(outcome.returned).toBe(pairPlusReturn(categoryOf(v.hand), pairPlus));
		}
	});

	it('pays the ante 1:1 and pushes the play bet when the dealer does not qualify', () => {
		let bluffs = 0;
		const hands = 20_000;
		for (let i = 0; i < hands; i++) {
			const step = handler().init(
				handler().parseWager(tcpWager(), BET, BET * 2),
				BET,
				BET * 2
			);
			const done = handler().apply(step.state, { type: 'PLAY' });
			const v = viewOf<ThreeCardView>(done.view);
			if (v.dealerQualifies !== false) continue;
			bluffs++;
			const category = categoryOf(v.hand);
			// Ante pays 1:1, play pushes (3x ante back), plus the Ante Bonus on a
			// straight or better. The player is never worse off for a bluff.
			const bonus = TCP_ANTE_BONUS[category as TcpRank];
			expect(done.outcome!.returned).toBe(BET * 3 + (bonus === undefined ? 0 : BET * bonus));
			expect(done.outcome!.returned).toBeGreaterThanOrEqual(BET * 3);
		}
		// The dealer qualifies on queen high or better, which is around 30% of
		// three card hands.
		expect(bluffs / hands).toBeGreaterThan(0.25);
		expect(bluffs / hands).toBeLessThan(0.4);
	});

	it('never folds the Player hand up to the play bet', () => {
		// On a fold the dealer is never dealt and never qualifies, so the view has
		// to say so rather than leaving a stale qualification in place.
		for (let i = 0; i < 2_000; i++) {
			const { view } = playOne(handler(), tcpWager(), BET, BET * 2, 'FOLD');
			const v = viewOf<ThreeCardView>(view);
			expect(v.folded).toBe(true);
			expect(v.dealerQualifies).toBeNull();
		}
	});

	it('never doubles the Pair Plus when the main bet wins', () => {
		// Pair Plus pays its own odds and is independent of the main result, so
		// whatever the main bet did, the Pair Plus contribution to the payout is
		// exactly its own odds and no more.
		const pairPlus = 10;
		for (let i = 0; i < 10_000; i++) {
			const { outcome, view } = playOne(
				handler(),
				tcpWager(pairPlus),
				BET,
				BET * 2 + pairPlus,
				'PLAY'
			);
			const v = viewOf<ThreeCardView>(view);
			const category = categoryOf(v.hand);
			const pairReturn = pairPlusReturn(category, pairPlus);
			expect(outcome.stake).toBe(BET * 2 + pairPlus);

			// Split the payout into the two independent wagers and rebuild what the
			// main bet alone owes from the published tables.
			const bonus = TCP_ANTE_BONUS[category as TcpRank];
			const bonusReturn = bonus === undefined ? 0 : BET * bonus;
			let mainReturn: number;
			if (v.dealerQualifies === false) {
				mainReturn = BET * 3;
			} else if (v.dealerQualifies === null) {
				continue; // folded, covered above
			} else {
				// Either a doubled main stake, a returned main stake, or nothing,
				// depending on which hand was better. The view does not expose the
				// dealer's hand, so only the bounds are checkable here.
				mainReturn = outcome.returned - pairReturn - bonusReturn;
				expect(mainReturn).toBeGreaterThanOrEqual(0);
				expect(mainReturn).toBeLessThanOrEqual(BET * 2 * 2);
			}
			expect(outcome.returned).toBe(pairReturn + bonusReturn + mainReturn);
		}
	});

	it('refuses a hand the stack cannot cover', () => {
		// Playing costs the ante plus an equal Play bet, so the ante can never be
		// more than half the stack.
		expect(() => handler().parseWager({ game: 'threecard', bet: { ante: 60 } }, 60, 100)).toThrow(GameError);
		expect(handler().parseWager({ game: 'threecard', bet: { ante: 50 } }, 50, 100)).toEqual({ game: 'threecard', bet: { ante: 50 } });
		// Pair Plus has to fit alongside both of those.
		expect(() => handler().parseWager(tcpWager(10), 50, 100)).toThrow(GameError);
	});

	it('will not let a client re-negotiate the ante', () => {
		// The engine owns the stake, so the ante in the wager has to match the bet
		// or the WAGER step would be a way to change how much is at stake.
		expect(() =>
			handler().parseWager({ game: 'threecard', bet: { ante: 10 } }, BET, HUGE_STACK)
		).toThrow(GameError);
	});

	it('costs the player money for playing, and exactly the ante for folding', () => {
		// Folding always loses the ante, so that return is pinned exactly rather
		// than measured. Playing every hand is the greedy policy and costs more,
		// which is the interesting comparison.
		const hands = 20_000;
		const folded = measureReturn(handler(), tcpWager(), hands, BET, BET * 2, 'FOLD');
		expect(folded.mean).toBeCloseTo(-1, 6);

		const played = measureReturn(handler(), tcpWager(), hands, BET, BET * 2, 'PLAY');
		process.stdout.write(
			`three card poker play-every-hand: ${(played.mean * 100).toFixed(3)}% ` +
				`+/-${(played.se * 5 * 100).toFixed(3)}pp\n`
		);
		expect(played.mean).toBeLessThan(0);
		expect(played.mean).toBeGreaterThan(-0.45);
	});

	it('only accepts PLAY or FOLD, and only once', () => {
		const step = handler().init(
			handler().parseWager(tcpWager(), BET, BET * 2),
			BET,
			BET * 2
		);
		expect(handler().legalActions(step.state)).toEqual(['FOLD', 'PLAY']);
		const done = handler().apply(step.state, { type: 'PLAY' });
		expect(handler().legalActions(done.state)).toEqual([]);
		expect(() => handler().apply(done.state, { type: 'FOLD' })).toThrow(GameError);
		expect(() => handler().apply(step.state, { type: 'HIT' })).toThrow(GameError);
	});
});

// ---------------------------------------------------------------------------
// The game interface
// ---------------------------------------------------------------------------

describe('the game interface', () => {
	it('registers all twelve games under distinct ids and titles', () => {
		expect(GAMES.map((g) => g.id).sort()).toEqual([
			'baccarat',
			'blackjack',
			'coinflip',
			'craps',
			'dice',
			'megaslots',
			'paigow',
			'roulette',
			'slots',
			'threecard',
			'ultimate',
			'videopoker',
		]);
		expect(new Set(GAMES.map((g) => g.title)).size).toBe(GAMES.length);
	});

	it('starts every game unsettled and settles it exactly once', () => {
		for (const handler of GAMES) {
			const wager = defaultWagerFor(handler.id);
			const stack = handler.id === 'threecard' ? BET * 2 : HUGE_STACK;
			const bet = handler.id === 'threecard' ? BET : BET;
			let step = handler.init(handler.parseWager(wager, bet, stack), bet, stack);
			// Blackjack (a natural) and baccarat (a natural, or both hands standing)
			// can settle on the deal itself, so deal again until a hand opens.
			for (let i = 0; i < 50 && (handler.id === 'blackjack' || handler.id === 'baccarat') && step.outcome; i++) {
				step = handler.init(handler.parseWager(wager, bet, stack), bet, stack);
			}
			expect(step.outcome).toBeNull();

			const legal = handler.legalActions(step.state);
			expect(legal.length).toBeGreaterThan(0);
			const first = handler.apply(step.state, { type: legal[0]! } as Action);
			// Whether it settled or not, the view has to say which it is. The client
			// is forbidden from guessing from the contents.
			expect(typeof first.view.resolved).toBe('boolean');
			// An unspun wheel and an unrolled die look identical to their settled
			// selves, so resolved is the only thing telling them apart.
			if (!first.outcome) expect(first.view.resolved).toBe(false);
			else expect(first.view.resolved).toBe(true);
		}
	});

	it('takes the stake from the caller, so doubling doubles the stake shape', () => {
		// Two independent rounds cannot be expected to return the same result, but
		// the stake shape must still scale with the caller's bet in every game.
		for (const handler of GAMES) {
			if (handler.id === 'threecard') continue;
			const wager = defaultWagerFor(handler.id);
			let sawWin = false;
			let sawLoss = false;
			for (let i = 0; i < 400 && !(sawWin && sawLoss); i++) {
				// A roulette wager carries its own amount, so size it to the bet.
				// Hold'em's ante is pinned to the bet, so it moves with it.
				const wagerFor = (bet: number): Wager =>
					handler.id === 'roulette'
						? rouletteWager({ kind: 'red' }, bet)
						: handler.id === 'ultimate'
							? { game: 'ultimate', bet: { ante: bet } }
							: wager;
				const small = playOne(handler, wagerFor(10), 10, HUGE_STACK);
				const large = playOne(handler, wagerFor(20), 20, HUGE_STACK);
				expect(large.outcome.stake).toBe(small.outcome.stake * 2);
				if (small.outcome.returned === 0) sawLoss = true;
				else sawWin = true;
			}
			expect(sawWin, `${handler.id} produced no win`).toBe(true);
			expect(sawLoss, `${handler.id} produced no loss`).toBe(true);
		}
	});

	it('rejects a wager belonging to a different game', () => {
		for (const handler of GAMES) {
			if (handler.id === 'slots') continue; // slots takes no wager
			const foreign = defaultWagerFor(
				handler.id === 'blackjack' ? 'roulette' : 'blackjack'
			);
			expect(() => handler.parseWager(foreign, BET, HUGE_STACK)).toThrow(GameError);
		}
	});
});

describe('three card poker dealer reveal', () => {
	const handler = gameById('threecard');

	it('shows the dealer hand and rank once the player plays, and never before or on a fold', () => {
		type V = { dealer: { cards: unknown[] } | null; dealerRank: string | null };
		const wager = { game: 'threecard', bet: { ante: BET } } as const;
		const fresh = handler.init(wager, BET, HUGE_STACK);
		expect(viewOf<V>(fresh.view).dealer).toBeNull();

		const played = handler.apply(handler.init(wager, BET, HUGE_STACK).state, { type: 'PLAY' });
		const pv = viewOf<V>(played.view);
		expect(pv.dealer!.cards).toHaveLength(3);
		expect(pv.dealerRank).toEqual(expect.any(String));

		const folded = handler.apply(handler.init(wager, BET, HUGE_STACK).state, { type: 'FOLD' });
		expect(viewOf<V>(folded.view).dealer).toBeNull();
	});
});

describe('baccarat deal step', () => {
	const handler = gameById('baccarat');
	const wager = { game: 'baccarat', bet: { main: 'player' } } as const;
	type Opening = BaccaratView & { opening: boolean; resolved: boolean };

	it('settles on the deal when there is a natural or both hands stand, and asks for Deal otherwise', () => {
		let settled = 0;
		let waiting = 0;
		for (let i = 0; i < 3_000; i++) {
			const step = handler.init(handler.parseWager(wager, BET, HUGE_STACK), BET, HUGE_STACK);
			const v = viewOf<Opening>(step.view);
			const p = v.player.total;
			const b = v.banker.total;
			const natural = p >= 8 || b >= 8;
			const bothStand = p >= 6 && b >= 6;
			if (natural || bothStand) {
				settled++;
				// No third card, no Deal button, and the result is already in.
				expect(step.outcome).not.toBeNull();
				expect(v.resolved).toBe(true);
				expect(v.opening).toBe(true);
				expect(v.player.cards).toHaveLength(2);
				expect(v.banker.cards).toHaveLength(2);
				expect(handler.legalActions(step.state)).toEqual([]);
				expect(() => handler.apply(step.state, { type: 'DEAL' })).toThrow(GameError);
			} else {
				waiting++;
				expect(step.outcome).toBeNull();
				expect(v.resolved).toBe(false);
				expect(handler.legalActions(step.state)).toEqual(['DEAL']);
				// Pressing Deal still draws, and it is not an opening settle.
				const done = handler.apply(step.state, { type: 'DEAL' });
				expect(viewOf<Opening>(done.view).opening).toBe(false);
				expect(done.outcome).not.toBeNull();
			}
		}
		// Both paths are common (about 45% and 55% of coups), so neither is untested.
		expect(settled).toBeGreaterThan(900);
		expect(waiting).toBeGreaterThan(900);
	});

	it('pays a settled-on-the-deal coup the same as a dealt one', () => {
		// Every settled coup returns a real outcome: the stake went on the table and is accounted for.
		for (let i = 0; i < 500; i++) {
			const step = handler.init(handler.parseWager(wager, BET, HUGE_STACK), BET, HUGE_STACK);
			if (!step.outcome) continue;
			expect(step.outcome.stake).toBe(BET);
			const { outcome } = viewOf<BaccaratView>(step.view);
			if (outcome === 'player') expect(step.outcome.returned).toBe(BET * 2);
			else if (outcome === 'tie') expect(step.outcome.returned).toBe(BET); // player bets push on a tie
			else expect(step.outcome.returned).toBe(0);
		}
	});
});
