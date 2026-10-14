/**
 * The run engine.
 *
 * A pure state machine over `RunState`: every client intent goes through
 * `applyAction`, and the resulting state is the only source of truth for chips,
 * round and history. The client never computes a payout and never holds a card.
 *
 * Phases:
 *
 *   betting ──BEGIN_ROUND──▶ choosing ──WAGER──▶ in_game ──(settles)──▶ resolved
 *      ▲                                                 ▲                  │
 *      │                                                 └── DON_ACCEPT ────┤
 *      │                                                          ▲          │
 *      │   (loss)                                                 │          │
 *      └──────────────── betting ◀── DON_DECLINE ── don_offer ◀───┴──────────┘
 *                                                                            │
 *   finished ◀── busted (0 chips) or survived round 5 ─────────────────────┘
 *      │
 *      └── SUBMIT_NAME ──▶ submitted
 *
 * `resolved` is a transient display state: the client shows the result and then
 * asks for the next phase, which keeps the "what happened" beat readable.
 */

import { UTH_MAX_ANTES } from '../shared/games';
import {
	type Action,
	GAME_IDS,
	type GameId,
	MIN_BET,
	STARTING_CHIPS,
	TOTAL_ROUNDS,
	type RunState,
	type Wager,
	initialRunState,
} from '../shared/protocol';
import { gameById } from './games';
import { GameError } from './games/types';
import { pick, withRng } from './rng';
import { seededRng } from './seed';

export { initialRunState };

/** Total chips wagered across a run, for the summary screen. */
export function totalWagered(run: RunState): number {
	return run.history.reduce((sum, r) => sum + r.bet, 0);
}

/**
 * The run as the client may see it. A game's state holds the shuffled shoe, the
 * dealer's hole card and any cards not yet revealed, so it never leaves the
 * Worker; the client draws everything from `view`.
 */
export function publicRun(run: RunState | null): RunState | null {
	if (!run?.current || run.current.state === null) return run;
	return { ...run, current: { ...run.current, state: null } };
}

/**
 * Server-side salt for seeded draws, so the day's outcomes cannot be worked out
 * in advance from the (public) date alone. Never stored on the run, because the
 * run is sent to the client. Set only for the duration of one `applyAction`.
 */
let seedSecret = '';

/**
 * Runs one unit of game randomness. A seeded (daily ranked) run derives a fresh
 * generator from the day plus a label naming exactly which draw this is, rather
 * than carrying a stream across requests: runs are persisted and restored, so a
 * stream position would have to be stored, while a label is already implied by
 * the run's own state. Unseeded runs fall straight through to the CSPRNG.
 */
function draw<T>(run: RunState, label: string, fn: () => T): T {
	return run.seed ? withRng(seededRng(`${seedSecret}|${run.seed}|${label}`), fn) : fn();
}

/**
 * The most a game can have at stake, given the stack.
 *
 * Most games can put the whole stack out. Three card poker needs an equal Play
 * bet alongside the ante, so it can only ever commit half — which is why an
 * all-in round that draws three card poker antes half the stack rather than
 * becoming a round the player cannot afford to play. Ultimate Texas Hold'em
 * needs a Blind and room for a 4x raise, so its ante is at most a sixth.
 *
 * The TriLux and Trips side bets are optional and checked like baccarat's.
 *
 * A baccarat pair side bet is optional and defaults off, so it is left out here
 * and checked instead in that game's own `parseWager`, where the wager is known.
 */
function maxStake(game: GameId, chips: number): number {
	if (game === 'threecard') return Math.floor(chips / 2);
	if (game === 'ultimate') return Math.floor(chips / UTH_MAX_ANTES);
	return chips;
}

/** Whether a game can commit anything at all with this stack. */
function canPlay(game: GameId, chips: number): boolean {
	return maxStake(game, chips) >= 1;
}

/**
 * Rewrites a wager so its amounts describe the stake it is about to be played
 * with, rather than the one it was first agreed at.
 *
 * A double replays the *shape* of the wager — same game, same side bets — at a
 * new size. Three card poker pins its ante to the engine's bet, so a retained
 * ante from an earlier, smaller stack has to move with it or the double would be
 * rejected as a mismatched wager. A baccarat pair side bet is trimmed to what
 * the stack can cover, and a Pair Plus is capped to whatever is left of the stack after
 * the ante and its matching play bet.
 *
 * Games whose wagers hold no amounts are returned untouched.
 */
function rebaseWager(wager: Wager, stake: number, chips: number): Wager {
	switch (wager.game) {
		case 'roulette': {
			// Scale every spot by the same factor so the spread keeps its shape,
			// then hand any rounding remainder to the biggest spot. A spot that
			// rounds to nothing is dropped.
			const total = wager.bets.reduce((sum, c) => sum + c.amount, 0);
			const scaled = wager.bets.map((c) => ({ ...c, amount: Math.floor((c.amount * stake) / total) }));
			const remainder = stake - scaled.reduce((sum, c) => sum + c.amount, 0);
			const biggest = scaled.reduce((best, c) => (c.amount > best.amount ? c : best), scaled[0]!);
			biggest.amount += remainder;
			return { game: 'roulette', bets: scaled.filter((c) => c.amount > 0) };
		}
		case 'threecard': {
			// The play bet only goes live if the player plays, but the stack has
			// to cover it the moment the wager is committed, so budget for it and
			// cap the retained Pair Plus to whatever is left.
			const room = Math.max(0, chips - stake * 2);
			const pairPlus = Math.min(wager.bet.pairPlus ?? 0, room);
			return pairPlus > 0
				? { game: 'threecard', bet: { ante: stake, pairPlus } }
				: { game: 'threecard', bet: { ante: stake } };
		}
		case 'ultimate': {
			// As for three card poker: the ante follows the stake, and Trips is
			// capped to what is left after the Blind and a 4x raise.
			const room = Math.max(0, chips - stake * UTH_MAX_ANTES);
			const trips = Math.min(wager.bet.trips ?? 0, room);
			return trips > 0 ? { game: 'ultimate', bet: { ante: stake, trips } } : { game: 'ultimate', bet: { ante: stake } };
		}
		case 'blackjack': {
			// TriLux keeps its size, trimmed to what the stack has after the main bet.
			if (!wager.trilux) return wager;
			const trilux = Math.min(wager.trilux, chips - stake);
			return trilux >= 1 ? { game: 'blackjack', trilux } : { game: 'blackjack' };
		}
		case 'baccarat': {
			// Keep the side bet at its chosen size, trimmed to whatever the stack
			// has left after the main bet. A double that cannot cover any of it
			// drops the side bet rather than the main one, since the main bet is
			// what the player is doubling.
			if (wager.bet.pair === undefined) return wager;
			const amount = Math.min(wager.bet.pairAmount ?? stake, chips - stake);
			if (amount < 1) {
				const { pair: _dropped, pairAmount: _amount, ...main } = wager.bet;
				return { game: 'baccarat', bet: main };
			}
			return { game: 'baccarat', bet: { ...wager.bet, pairAmount: amount } };
		}
		default:
			return wager;
	}
}

/**
 * Chooses the next game: uniformly at random from those not yet played, so the
 * five rounds of a run are always five different games.
 *
 * Games this stack is too small to join are left out: three card poker below
 * two chips, and Ultimate Texas Hold'em below six, since their antes need
 * matching bets alongside.
 */
export function chooseGame(played: readonly GameId[], chips?: number): GameId {

	let remaining = GAME_IDS.filter((id) => !played.includes(id));
	// Unreachable while TOTAL_ROUNDS is 5 and there are more games than that, but a run
	// restored from older state could have played them all.
	if (remaining.length === 0) remaining = [...GAME_IDS];
	if (chips !== undefined) {
		const playable = remaining.filter((id) => canPlay(id, chips));
		if (playable.length > 0) remaining = playable;
	}
	return pick(remaining);
}

/** Draws the game for the coming round so the bet screen can name it. */
function queueNextGame(run: RunState): void {
	// Keyed by round alone: the pool is fixed by the (seeded) games already played.
	run.upcoming = draw(run, `game:${run.round}`, () => chooseGame(run.played, run.chips));
}

/** The wager a game starts on when the player accepts the default. */
export function defaultWager(gameId: GameId, bet: number): Wager {
	switch (gameId) {
		case 'roulette':
			// Only a seed: the client builds its own spread, and the whole table
			// limit on red is the same shape every other game starts from.
			return { game: 'roulette', bets: [{ bet: { kind: 'red' }, amount: bet }] };
		case 'baccarat':
			return { game: 'baccarat', bet: { main: 'player' } };
		case 'coinflip':
			return { game: 'coinflip', bet: { side: 'heads' } };
		case 'dice':
			return { game: 'dice', bet: { kind: 'roll_under', target: 5 } };
		case 'threecard':
			// The engine's bet is the ante; the Play bet matches it.
			return { game: 'threecard', bet: { ante: bet } };
		case 'blackjack':
			return { game: 'blackjack' };
		case 'slots':
			return { game: 'slots' };
		case 'ultimate':
			// The engine's bet is the ante; the Blind matches it.
			return { game: 'ultimate', bet: { ante: bet } };
		case 'paigow':
			return { game: 'paigow' };
	}
}

/**
 * Advances the run by one client intent and returns the new state.
 *
 * Throws GameError for anything invalid; the caller turns that into a 4xx.
 * SUBMIT_NAME and ABANDON are handled by the route because they need database
 * access, not just a state transition.
 */
export function applyAction(
	run: RunState | null,
	action: Action,
	seed: string | null = null,
	secret = ''
): RunState {
	seedSecret = secret;
	try {
		return applyActionUnsalted(run, action, seed);
	} finally {
		seedSecret = '';
	}
}

function applyActionUnsalted(run: RunState | null, action: Action, seed: string | null): RunState {
	if (action.type === 'START') {
		// Starting over mid-run is allowed and silently discards the old one.
		// `seed` is only passed for a ranked run; see RunState.seed.
		const fresh = initialRunState();
		fresh.seed = seed;
		queueNextGame(fresh);
		return fresh;
	}

	if (run === null) {
		throw new GameError('no_run', 'start a run first');
	}

	const next = structuredClone(run);

	switch (action.type) {
		case 'BEGIN_ROUND':
			return beginRound(next, action.bet);
		case 'WAGER':
			return commitWager(next, action.wager);
		case 'DON_ACCEPT':
			return acceptDouble(next);
		case 'DON_DECLINE':
			return declineDouble(next);
		case 'SUBMIT_NAME':
		case 'ABANDON':
			throw new GameError('invalid_action', `${action.type} is handled outside the engine`);
		default:
			return playGameAction(next, action);
	}
}

// ---------------------------------------------------------------------------
// Round lifecycle
// ---------------------------------------------------------------------------

/**
 * Picks the game for the round and holds the bet, but does not deal yet.
 *
 * Splitting this from WAGER means the player learns which game they drew before
 * committing to a wager type, so there is exactly one deal per round.
 */
function beginRound(run: RunState, bet: number): RunState {
	if (run.phase !== 'betting') {
		throw new GameError('illegal_action', `cannot begin a round from phase ${run.phase}`);
	}
	if (!Number.isInteger(bet) || bet < MIN_BET) {
		throw new GameError('invalid_bet', `bet must be a whole number of at least ${MIN_BET}`);
	}
	if (bet > run.chips) {
		throw new GameError('invalid_bet', 'bet exceeds your stack');
	}

	// Runs saved before `upcoming` existed have none queued, so draw now.
	const game = run.upcoming ?? draw(run, `game:${run.round}`, () => chooseGame(run.played, run.chips));
	run.upcoming = null;
	// Three card poker needs a matching Play bet, so an all-in round antes half
	// the stack (a sixth for Ultimate Texas Hold'em). The wager screen shows the real ante before the player commits,
	// so the reduction is visible rather than a surprise.
	const stake = Math.min(bet, maxStake(game, run.chips));
	run.current = {
		game,
		bet: stake,
		wager: defaultWager(game, stake),
		doubles: 0,
		state: null,
		view: null,
	};
	run.phase = 'choosing';
	return run;
}

/** Validates the chosen wager, then deals. Moves the round into `in_game`. */
function commitWager(run: RunState, wager: Wager): RunState {
	if (run.phase !== 'choosing' || !run.current) {
		throw new GameError('illegal_action', 'no round awaiting a wager');
	}
	if (wager.game !== run.current.game) {
		throw new GameError('invalid_wager', 'wager does not match the round game');
	}

	const handler = gameById(run.current.game);
	// For roulette the bet taken at BEGIN_ROUND is only the table limit; the
	// stake is whatever the player actually spread across the spots.
	const normalized = handler.parseWager(wager, run.current.bet, run.chips);
	run.current.bet = handler.stakeOf?.(normalized) ?? run.current.bet;
	const bet = run.current.bet;
	const step = draw(run, `r${run.round}:d0:init`, () => handler.init(normalized, bet, run.chips));

	run.current.wager = normalized;
	run.current.state = step.state;
	run.current.view = step.view;
	run.phase = 'in_game';

	// A game can resolve without any player action.
	if (step.outcome) settleRound(run, step.outcome);
	return run;
}

/** Routes an action belonging to the game currently in play. */
function playGameAction(run: RunState, action: Action): RunState {
	if (run.phase !== 'in_game' || !run.current) {
		throw new GameError('illegal_action', 'no round in progress');
	}

	const handler = gameById(run.current.game);
	const legal = handler.legalActions(run.current.state);
	if (!legal.includes(action.type)) {
		throw new GameError(
			'illegal_action',
			`${action.type} is not legal here; expected ${legal.join(', ') || 'nothing'}`
		);
	}

	// One draw per apply is enough: only single-action games (roulette, dice,
	// slots, coinflip) roll here, and card games draw from the shoe already
	// shuffled in init. Baccarat/blackjack draw from that shoe too, so the
	// label needn't count actions.
	const { state, doubles } = run.current;
	const step = draw(run, `r${run.round}:d${doubles}:apply`, () => handler.apply(state!, action));
	run.current.state = step.state;
	run.current.view = step.view;

	if (step.outcome) settleRound(run, step.outcome);
	return run;
}

/**
 * The last round's result is shown from `history` whenever there is no active
 * round, so there is no separate "resolved" phase to step out of.
 */

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/**
 * Applies a game's result to the stack and decides what happens next.
 *
 * `chips` is never allowed below 0: a game returning less than its stake is a
 * loss, and 0 chips ends the run.
 */
function settleRound(
	run: RunState,
	outcome: { stake: number; returned: number; detail: string }
): void {
	const current = run.current;
	if (!current) throw new GameError('illegal_action', 'nothing to settle');

	run.chips = Math.max(0, run.chips - outcome.stake + outcome.returned);

	run.played.push(current.game);
	run.history.push({
		round: run.round,
		game: current.game,
		bet: current.bet,
		returned: outcome.returned,
		net: outcome.returned - outcome.stake,
		doubled: current.doubles > 0,
		detail: outcome.detail,
		view: current.view,
	});

	const won = outcome.returned > outcome.stake;
	const lastRound = run.round >= TOTAL_ROUNDS;

	if (run.chips === 0) {
		run.current = null;
		run.phase = 'finished';
		run.endedBy = 'bust';
	} else if (lastRound) {
		run.current = null;
		run.phase = 'finished';
		run.endedBy = 'complete';
	} else if (won) {
		// Keep game and wager so a double can replay the exact same bet. The
		// offer risks everything this game paid back — original bet plus winnings —
		// so `bet` is rewritten to that amount here, where the UI can show it and
		// `acceptDouble` can play it. Capped by what the game can commit from the
		// stack (three card poker needs a matching play bet).
		run.current = {
			game: current.game,
			wager: current.wager,
			bet: Math.max(1, Math.min(outcome.returned, maxStake(current.game, run.chips))),
			doubles: current.doubles,
			state: null,
			view: current.view,
		};
		run.phase = 'don_offer';
	} else {
		run.current = null;
		run.phase = 'betting';
		run.round += 1;
		queueNextGame(run);
	}
}

// ---------------------------------------------------------------------------
// Double or Nothing
// ---------------------------------------------------------------------------

/**
 * Re-plays the last round's game and wager, risking everything that game just
 * paid back: the original bet plus the winnings (bet 100, win 100, risk 200).
 * Not the whole stack, so chips from other rounds stay safe.
 *
 * Unlimited within a round, as chosen. Each acceptance appends to history, so
 * the round log shows the whole chain rather than hiding it.
 */
function acceptDouble(run: RunState): RunState {
	if (run.phase !== 'don_offer' || !run.current) {
		throw new GameError('illegal_action', 'no double or nothing on offer');
	}
	const { game, wager, doubles } = run.current;
	const handler = gameById(game);
	// `settleRound` already set `bet` to the amount on offer (the last payout,
	// capped to what the game can commit), so a chain keeps compounding it.
	const stake = Math.max(1, Math.min(run.current.bet, maxStake(game, run.chips)));

	// The stack is what bounds the wager, so it is passed as the available
	// stack to both validation and init.
	const normalized = handler.parseWager(rebaseWager(wager, stake, run.chips), stake, run.chips);
	const step = draw(run, `r${run.round}:d${doubles + 1}:init`, () =>
		handler.init(normalized, stake, run.chips)
	);

	run.current = {
		game,
		wager: normalized,
		bet: stake,
		doubles: doubles + 1,
		state: step.state,
		view: step.view,
	};
	run.phase = 'in_game';

	if (step.outcome) settleRound(run, step.outcome);
	return run;
}

/** Banks the winnings and moves to the next round. */
function declineDouble(run: RunState): RunState {
	if (run.phase !== 'don_offer') {
		throw new GameError('illegal_action', 'no double or nothing on offer');
	}
	run.current = null;
	run.phase = 'betting';
	run.round += 1;
	queueNextGame(run);
	return run;
}

export { MIN_BET, STARTING_CHIPS, TOTAL_ROUNDS };