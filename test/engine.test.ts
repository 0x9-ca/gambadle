/**
 * The run state machine.
 *
 * The engine is the only place chips, rounds and history are decided, so these
 * tests care less about which game comes up than about the invariants that must
 * hold no matter what: chips equal the starting stack plus the sum of every
 * result, the stack never goes negative, all five rounds are different games, and
 * no transition is reachable out of order.
 */

import { describe, expect, it, vi } from 'vitest';
import {
	type Action,
	GAME_IDS,
	STARTING_CHIPS,
	TOTAL_ROUNDS,
	initialRunState,
	type GameId,
	type RunState,
} from '../shared/protocol';
import { applyAction, chooseGame, defaultWager, totalWagered } from '../worker/engine';
import { gameById } from '../worker/games';
import { GameError } from '../worker/games/types';
import { setSeed } from './helpers/seeded-rng';

vi.mock(import('../worker/rng'), async () => await import('./helpers/seeded-rng'));

/** The most a game can stake: three card poker needs a matching Play bet, Hold'em a Blind and a 4x raise. */
function maxStakeFor(game: GameId, chips: number): number {
	if (game === 'threecard') return Math.floor(chips / 2);
	if (game === 'ultimate') return Math.floor(chips / 6);
	return chips;
}

/** Chips must always equal the opening stack plus everything won and lost. */
function stackIsConsistent(run: RunState): boolean {
	const net = run.history.reduce((sum, r) => sum + r.net, 0);
	return run.chips === STARTING_CHIPS + net;
}

/** Plays whatever game is in progress until it settles. */
function drive(run: RunState): RunState {
	for (let guard = 0; guard < 50; guard++) {
		if (run.phase !== 'in_game' || !run.current) break;
		const legal = gameById(run.current.game).legalActions(run.current.state);
		if (legal.length === 0) break;
		// Insurance is a side decision this generic driver is not testing.
		const pick = legal.includes('NO_INSURANCE') ? 'NO_INSURANCE' : legal[0]!;
		run = applyAction(run, { type: pick } as Action);
	}
	return run;
}

/** One full round: pick a game, wager, play it out. */
function playRound(run: RunState, bet: number): RunState {
	run = applyAction(run, { type: 'BEGIN_ROUND', bet });
	run = applyAction(run, { type: 'WAGER', wager: run.current!.wager });
	return drive(run);
}

/** Plays a whole run, always all-in, and returns it. */
function playToEnd(seed: number): RunState {
	setSeed(seed);
	let run = applyAction(null, { type: 'START' });
	for (let guard = 0; guard < 200 && run.phase !== 'finished'; guard++) {
		if (run.phase === 'betting') {
			run = playRound(run, run.chips);
		} else if (run.phase === 'don_offer') {
			run = applyAction(run, { type: 'DON_DECLINE' });
		}
	}
	return run;
}

// ---------------------------------------------------------------------------

describe('starting a run', () => {
	it('opens with the starting stack on round one', () => {
		const run = applyAction(null, { type: 'START' });
		expect(run.chips).toBe(STARTING_CHIPS);
		expect(run.round).toBe(1);
		expect(run.phase).toBe('betting');
		expect(run.played).toEqual([]);
		expect(run.history).toEqual([]);
		expect(run.endedBy).toBeNull();
	});

	it('discards a run in progress when a new one starts', () => {
		let run = applyAction(null, { type: 'START' });
		run = playRound(run, 100);
		expect(run.chips).not.toBe(STARTING_CHIPS);
		run = applyAction(run, { type: 'START' });
		expect(run).toEqual({ ...initialRunState(), upcoming: run.upcoming });
		expect(run.upcoming).not.toBeNull();
	});

	it('refuses everything but START before a run exists', () => {
		for (const action of [
			{ type: 'BEGIN_ROUND', bet: 10 },
			{ type: 'WAGER', wager: { game: 'coinflip' } },
			{ type: 'HIT' },
			{ type: 'DON_ACCEPT' },
			{ type: 'DON_DECLINE' },
		] as Action[]) {
			expect(() => applyAction(null, action)).toThrow(GameError);
		}
	});

	it('leaves SUBMIT_NAME and ABANDON to the route, which needs the database', () => {
		const run = applyAction(null, { type: 'START' });
		expect(() => applyAction(run, { type: 'SUBMIT_NAME', name: 'someone' })).toThrow(GameError);
		expect(() => applyAction(run, { type: 'ABANDON' })).toThrow(GameError);
	});
});

// ---------------------------------------------------------------------------

describe('beginning a round', () => {
	it('picks a game the run has not played yet', () => {
		for (let seed = 0; seed < 20; seed++) {
			setSeed(seed);
			let run = applyAction(null, { type: 'START' });
			for (let round = 1; round <= 4; round++) {
				run = applyAction(run, { type: 'BEGIN_ROUND', bet: 10 });
				expect(run.phase).toBe('choosing');
				expect(run.played).not.toContain(run.current!.game);
				run = applyAction(run, { type: 'WAGER', wager: run.current!.wager });
				run = drive(run);
				if (run.phase === 'don_offer') run = applyAction(run, { type: 'DON_DECLINE' });
			}
			expect(new Set(run.played).size).toBe(run.played.length);
			expect(run.played.length).toBeGreaterThanOrEqual(4);
			return;
		}
		throw new Error('unreachable');
	});

	it('holds the bet without dealing, so the game is known before committing', () => {
		const run = applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: 50 });
		expect(run.phase).toBe('choosing');
		expect(run.current!.bet).toBe(50);
		// Nothing is dealt yet, so a player cannot peek before wagering.
		expect(run.current!.view).toBeNull();
		expect(run.current!.state).toBeNull();
		// Chips are untouched until the round actually resolves.
		expect(run.chips).toBe(STARTING_CHIPS);
	});

	it('seeds a usable default wager for every game', () => {
		for (const game of GAME_IDS) {
			const wager = defaultWager(game, 100);
			expect(wager.game).toBe(game);
			// The seeded default must survive the game's own validation.
			expect(() => gameById(game).parseWager(wager, 100, STARTING_CHIPS)).not.toThrow();
		}
	});

	it('rejects bets that are not whole numbers in range', () => {
		const run = initialRunState();
		for (const bet of [0, -5, 1.5, Number.NaN, STARTING_CHIPS + 1, Infinity]) {
			expect(() => applyAction(run, { type: 'BEGIN_ROUND', bet })).toThrow(GameError);
		}
	});

	it('accepts an all-in and a one-chip bet', () => {
		expect(applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: 1 }).current!.bet).toBe(1);
		const allIn = applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: STARTING_CHIPS }).current!;
		expect(allIn.bet).toBe(maxStakeFor(allIn.game, STARTING_CHIPS));
	});

	it('cannot begin a second round while one is open', () => {
		let run = applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: 10 });
		expect(() => applyAction(run, { type: 'BEGIN_ROUND', bet: 10 })).toThrow(GameError);
		run = applyAction(run, { type: 'WAGER', wager: run.current!.wager });
		// A deal that settles on the spot (a blackjack) leaves no round open.
		if (run.phase === 'in_game') {
			expect(() => applyAction(run, { type: 'BEGIN_ROUND', bet: 10 })).toThrow(GameError);
		}
	});
});

// ---------------------------------------------------------------------------

describe('committing a wager', () => {
	it('refuses a wager for a different game than the round drew', () => {
		for (let attempt = 0; attempt < 200; attempt++) {
			setSeed(attempt);
			let run = applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: 10 });
			const wrong = GAME_IDS.find((id) => id !== run.current!.game)!;
			expect(() => applyAction(run, { type: 'WAGER', wager: defaultWager(wrong, 10) })).toThrow(
				GameError
			);
			// The round must be untouched by the rejection.
			expect(run.phase).toBe('choosing');
			return;
		}
		throw new Error('unreachable');
	});

	it('cannot act in a game before the wager is committed', () => {
		const run = applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: 10 });
		for (const action of [{ type: 'HIT' }, { type: 'SPIN' }, { type: 'FLIP' }] as Action[]) {
			expect(() => applyAction(run, action)).toThrow(GameError);
		}
	});
});

// ---------------------------------------------------------------------------

describe('settling and advancing', () => {
	it('records the result and advances after a loss', () => {
		setSeed(1);
		let run = applyAction(null, { type: 'START' });
		run = playRound(run, 100);
		expect(run.history).toHaveLength(1);
		const [result] = run.history;
		expect(result!.round).toBe(1);
		expect(result!.game).toBeTruthy();
		expect(result!.bet).toBe(100);
		expect(result!.detail.length).toBeGreaterThan(0);
		expect(stackIsConsistent(run)).toBe(true);
	});

	it('keeps the stack equal to the opening stack plus every logged result', () => {
		for (let seed = 0; seed < 60; seed++) {
			const run = playToEnd(seed);
			expect(stackIsConsistent(run)).toBe(true);
			// A result can never return more chips than it logged.
			for (const result of run.history) {
				expect(result.returned).toBeGreaterThanOrEqual(0);
				expect(result.net).toBeLessThanOrEqual(result.returned);
			}
		}
	});

	it('never lets the stack go below zero', () => {
		for (let seed = 0; seed < 60; seed++) {
			const run = playToEnd(seed);
			expect(run.chips).toBeGreaterThanOrEqual(0);
		}
	});

	it('offers a double only after a win', () => {
		for (let seed = 0; seed < 80; seed++) {
			setSeed(seed);
			let run = applyAction(null, { type: 'START' });
			for (let guard = 0; guard < 60 && run.phase !== 'finished'; guard++) {
				if (run.phase === 'betting') {
					const before = run.round;
					run = playRound(run, Math.min(100, run.chips));
					if (run.phase === 'don_offer') {
						// A win is offered a double; a loss moves straight on.
						expect(run.history.at(-1)!.net).toBeGreaterThan(0);
						expect(run.round).toBe(before);
						return;
					}
				} else if (run.phase === 'don_offer') {
					run = applyAction(run, { type: 'DON_DECLINE' });
				}
			}
		}
		throw new Error('expected a double-or-nothing offer');
	});

	it('reports a bust when the stack hits zero', () => {
		for (let seed = 0; seed < 200; seed++) {
			const run = playToEnd(seed);
			if (run.chips === 0) {
				expect(run.phase).toBe('finished');
				expect(run.endedBy).toBe('bust');
				expect(run.current).toBeNull();
				return;
			}
		}
		throw new Error('expected at least one bust');
	});

	it('completes after five rounds without busting', () => {
		for (let seed = 0; seed < 400; seed++) {
			// Bet a chip a time so the run is very unlikely to bust.
			setSeed(seed);
			let run = applyAction(null, { type: 'START' });
			for (let guard = 0; guard < 60 && run.phase !== 'finished'; guard++) {
				if (run.phase === 'betting') run = playRound(run, 1);
				else if (run.phase === 'don_offer') run = applyAction(run, { type: 'DON_DECLINE' });
			}
			if (run.endedBy === 'complete') {
				expect(run.round).toBe(TOTAL_ROUNDS);
				expect(run.phase).toBe('finished');
				expect(run.current).toBeNull();
				expect(new Set(run.played).size).toBe(TOTAL_ROUNDS);
				return;
			}
		}
		throw new Error('expected at least one completed run');
	});

	it('never deals the same game twice in one run', () => {
		for (let seed = 0; seed < 40; seed++) {
			const run = playToEnd(seed);
			expect(new Set(run.played).size).toBe(run.played.length);
			expect(run.played.length).toBeLessThanOrEqual(TOTAL_ROUNDS);
		}
	});
});

// ---------------------------------------------------------------------------

describe('roulette table', () => {
	/** Forces a roulette round by retrying seeds until one is drawn. */
	function roulettePending(): RunState {
		for (let seed = 0; seed < 300; seed++) {
			setSeed(seed);
			const run = applyAction(applyAction(null, { type: 'START' }), { type: 'BEGIN_ROUND', bet: 1000 });
			if (run.current!.game === 'roulette') return run;
			// Fresh START each time re-queues the game.
		}
		throw new Error('no roulette draw in 300 seeds');
	}

	it('takes the bet as a table limit and stakes what is actually placed', () => {
		const run = roulettePending();
		expect(run.current!.bet).toBe(1000);
		const placed = applyAction(run, {
			type: 'WAGER',
			wager: {
				game: 'roulette',
				bets: [
					{ bet: { kind: 'red' }, amount: 30 },
					{ bet: { kind: 'straight', number: 7 }, amount: 20 },
				],
			},
		});
		expect(placed.current!.bet).toBe(50);
		const spun = applyAction(placed, { type: 'SPIN' });
		expect(spun.history[spun.history.length - 1]!.bet).toBe(50);
		expect(stackIsConsistent(spun)).toBe(true);
	});

	it('refuses more chips than the table limit', () => {
		const run = roulettePending();
		expect(() =>
			applyAction(run, {
				type: 'WAGER',
				wager: { game: 'roulette', bets: [{ bet: { kind: 'red' }, amount: 1001 }] },
			})
		).toThrow(GameError);
	});
});

describe('round result', () => {
	it('keeps the finished board in history for the result screen', () => {
		setSeed(1);
		let run = applyAction(null, { type: 'START' });
		run = playRound(run, 10);
		const last = run.history[run.history.length - 1]!;
		expect(last.view).not.toBeNull();
		expect(last.view!.resolved).toBe(true);
		expect(last.view!.game).toBe(last.game);
	});
});

describe('game reveal', () => {
	it('names the next game before any chips are bet, and plays that game', () => {
		const run = applyAction(null, { type: 'START' });
		const named = run.upcoming!;
		expect(named).not.toBeNull();
		expect(applyAction(run, { type: 'BEGIN_ROUND', bet: 10 }).current!.game).toBe(named);
	});
});

describe('double or nothing', () => {
	/**
	 * Reaches a genuine win so the offer is real rather than hand-built.
	 *
	 * Scans seeds rather than betting big, since the odds of a win depend on
	 * which game gets dealt and that is not fixed across seeds.
	 */
	function reachOffer(): RunState {
		for (let seed = 0; seed < 200; seed++) {
			setSeed(seed);
			let run = applyAction(null, { type: 'START' });
			for (let guard = 0; guard < 30 && run.phase !== 'finished'; guard++) {
				if (run.phase === 'betting') {
					run = playRound(run, Math.min(50, run.chips));
					if (run.phase === 'don_offer') return run;
				} else if (run.phase === 'don_offer') {
					run = applyAction(run, { type: 'DON_DECLINE' });
				}
			}
		}
		throw new Error('no win found in 200 seeds');
	}

	/**
	 * An offer and its accepted double, where the double is still in play. A game
	 * that settles on the deal (a blackjack) can end the double on the spot, which
	 * is correct but leaves nothing to inspect.
	 */
	function reachLiveDouble(): { offer: RunState; doubled: RunState } {
		for (let attempt = 0; attempt < 100; attempt++) {
			const offer = reachOffer();
			const doubled = applyAction(offer, { type: 'DON_ACCEPT' });
			if (doubled.phase === 'in_game') return { offer, doubled };
		}
		throw new Error('no live double found');
	}

	it('replays the same game and wager, risking the bet plus the winnings', () => {
		const { offer, doubled } = reachLiveDouble();
		const game = offer.current!.game;
		const wager = offer.current!.wager;
		const stack = offer.chips;

		expect(doubled.current!.game).toBe(game);
		// Everything the last game paid back goes out: bet 100, win 100, risk 200.
		const paidBack = offer.history[offer.history.length - 1]!.returned;
		expect(offer.current!.bet).toBe(Math.min(paidBack, maxStakeFor(game, stack)));
		expect(doubled.current!.bet).toBe(offer.current!.bet);
		expect(doubled.current!.doubles).toBe(1);
		expect(doubled.current!.wager.game).toBe(game);
		// The retained wager keeps the same shape, so a repeat double replays
		// exactly what the player agreed to.
		const doubledBetKeys =
			'bet' in doubled.current!.wager ? Object.keys(doubled.current!.wager.bet).sort() : [];
		const wagerBetKeys = 'bet' in wager ? Object.keys(wager.bet).sort() : [];
		expect(doubledBetKeys).toEqual(wagerBetKeys);
	});

	it('chains without limit and logs every link', () => {
		let run = reachOffer();
		const before = run.history.length;
		let links = 0;
		while (run.phase === 'don_offer' && links < 25) {
			run = applyAction(run, { type: 'DON_ACCEPT' });
			// A double that settles on the deal and loses moves straight on to betting.
			expect(['in_game', 'don_offer', 'finished', 'betting']).toContain(run.phase);
			run = drive(run);
			links++;
		}
		// Every acceptance is in the log rather than hidden behind the last one.
		expect(run.history.length).toBe(before + links);
		expect(run.history.filter((r) => r.doubled).length).toBe(links);
		expect(stackIsConsistent(run)).toBe(true);
	});

	it('keeps the stack consistent through a chain of doubles', () => {
		for (let seed = 0; seed < 25; seed++) {
			setSeed(seed);
			let run = applyAction(null, { type: 'START' });
			for (let guard = 0; guard < 80 && run.phase !== 'finished'; guard++) {
				if (run.phase === 'betting') run = playRound(run, Math.min(20, run.chips));
				else if (run.phase === 'don_offer') run = applyAction(run, { type: 'DON_ACCEPT' });
				expect(stackIsConsistent(run)).toBe(true);
				expect(run.chips).toBeGreaterThanOrEqual(0);
			}
		}
	});

	it('banks the winnings and moves on when declined', () => {
		const offer = reachOffer();
		const banked = applyAction(offer, { type: 'DON_DECLINE' });
		expect(banked.phase).toBe('betting');
		expect(banked.round).toBe(offer.round + 1);
		expect(banked.chips).toBe(offer.chips);
		expect(banked.current).toBeNull();
	});

	it('does not count a double as a new round', () => {
		const { offer, doubled } = reachLiveDouble();
		expect(doubled.round).toBe(offer.round);
	});

	it('cannot be accepted or declined at the wrong time', () => {
		const run = applyAction(initialRunState(), { type: 'BEGIN_ROUND', bet: 10 });
		expect(() => applyAction(run, { type: 'DON_ACCEPT' })).toThrow(GameError);
		expect(() => applyAction(run, { type: 'DON_DECLINE' })).toThrow(GameError);
	});

	it('cannot be accepted once the run is over', () => {
		for (let seed = 0; seed < 200; seed++) {
			const run = playToEnd(seed);
			if (run.phase === 'finished') {
				expect(() => applyAction(run, { type: 'DON_ACCEPT' })).toThrow(GameError);
				return;
			}
		}
		throw new Error('expected a finished run');
	});
});

// ---------------------------------------------------------------------------

describe('chooseGame', () => {
	it('only ever returns a game that has not been played', () => {
		for (let attempt = 0; attempt < 500; attempt++) {
			const played = GAME_IDS.slice(0, 5);
			expect(played).not.toContain(chooseGame(played));
		}
	});

	it('deals five different games in a run', () => {
		for (let attempt = 0; attempt < 200; attempt++) {
			const picked: GameId[] = [];
			let list: GameId[] = [];
			for (let i = 0; i < TOTAL_ROUNDS; i++) {
				const game = chooseGame(list);
				picked.push(game);
				list = [...list, game];
			}
			expect(new Set(picked).size).toBe(TOTAL_ROUNDS);
		}
	});

	it('falls back rather than throwing when everything has been played', () => {
		expect(GAME_IDS).toContain(chooseGame([...GAME_IDS]));
	});
});

// ---------------------------------------------------------------------------

describe('totalWagered', () => {
	it('sums every bet in the log, doubles included', () => {
		const run = playToEnd(3);
		expect(totalWagered(run)).toBe(run.history.reduce((sum, r) => sum + r.bet, 0));
		expect(totalWagered(initialRunState())).toBe(0);
	});
});

describe('daily seed', () => {
	const play = (ambient: number, seed: string | null, secret = '') => {
		setSeed(ambient);
		const act = (run: RunState | null, action: Action) => applyAction(run, action, null, secret);
		let run = applyAction(null, { type: 'START' }, seed, secret);
		for (let guard = 0; guard < 200 && run.phase !== 'finished'; guard++) {
			if (run.phase === 'betting') {
				run = act(run, { type: 'BEGIN_ROUND', bet: 10 });
				run = act(run, { type: 'WAGER', wager: run.current!.wager });
			} else if (run.phase === 'in_game') {
				const legal = gameById(run.current!.game).legalActions(run.current!.state);
				run = act(run, { type: legal.includes('NO_INSURANCE') ? 'NO_INSURANCE' : legal[0]! } as Action);
			} else if (run.phase === 'don_offer') run = act(run, { type: 'DON_DECLINE' });
			else break;
		}
		return run.history.map((r) => [r.game, r.net, r.detail]);
	};

	it('deals every ranked player the same run, whatever the ambient randomness', () => {
		expect(play(1, '2026-10-03', 's')).toEqual(play(999, '2026-10-03', 's'));
	});

	it('differs between days', () => {
		expect(play(1, '2026-10-03', 's')).not.toEqual(play(1, '2026-10-04', 's'));
	});

	it('cannot be predicted from the date without the server secret', () => {
		expect(play(1, '2026-10-03', 's')).not.toEqual(play(1, '2026-10-03', 'other'));
	});

	it('leaves unseeded runs random', () => {
		expect(play(1, null)).not.toEqual(play(999, null));
	});

	// Guards the "same for everyone" promise against a new random draw that
	// depends on what the player does: two players who choose differently must
	// still see identical deals, and identical rolls for single-roll games.
	it('draws the same deals and rolls whatever the player chooses', () => {
		const SINGLE_ROLL = ['roulette', 'dice', 'slots', 'coinflip'];
		const trace = (pickAction: (legal: string[]) => string, ambient: number) => {
			setSeed(ambient);
			const deals: string[] = [];
			const rolls: string[] = [];
			const act = (run: RunState | null, action: Action) => applyAction(run, action, null, 's');
			let run = applyAction(null, { type: 'START' }, '2026-10-03', 's');
			for (let guard = 0; guard < 200 && run.phase !== 'finished'; guard++) {
				if (run.phase === 'betting') {
					run = act(run, { type: 'BEGIN_ROUND', bet: 10 });
					run = act(run, { type: 'WAGER', wager: run.current!.wager });
					deals.push(`${run.current?.game}:${JSON.stringify(run.current?.state ?? null)}`);
				} else if (run.phase === 'in_game') {
					const legal = gameById(run.current!.game).legalActions(run.current!.state);
					const type = pickAction(legal);
					// Pai Gow's SET_HAND names the low hand; play the one the view suggests.
					const view = run.current!.view as { houseWay?: number[] };
					run = act(run, (type === 'SET_HAND' ? { type, low: view.houseWay } : { type }) as Action);
				} else if (run.phase === 'don_offer') run = act(run, { type: 'DON_DECLINE' });
				else break;
			}
			for (const r of run.history) {
				if (SINGLE_ROLL.includes(r.game)) rolls.push(`${r.game}:${JSON.stringify(r.view)}`);
			}
			return { deals, rolls };
		};
		const first = trace((legal) => legal[0]!, 1);
		const last = trace((legal) => legal[legal.length - 1]!, 2);
		const n = Math.min(first.deals.length, last.deals.length);
		expect(n).toBeGreaterThan(0);
		expect(last.deals.slice(0, n)).toEqual(first.deals.slice(0, n));
		const m = Math.min(first.rolls.length, last.rolls.length);
		expect(last.rolls.slice(0, m)).toEqual(first.rolls.slice(0, m));
	});
});
