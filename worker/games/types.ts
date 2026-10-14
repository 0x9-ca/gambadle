/**
 * The contract every minigame implements.
 *
 * The engine in ../engine.ts drives every game through this one interface,
 * so adding an eighth game means writing a single module and registering it.
 *
 * Two rules keep the leaderboard honest:
 *   1. Every outcome is computed here, server-side, from the engine's RNG.
 *   2. `apply` only accepts actions that `legalActions` listed for the current
 *      state, so a client cannot skip a step or replay one.
 */

import type { Action, ActionType, GameId, GameView, Wager } from '../../shared/protocol';

/** Thrown for anything the player did wrong; surfaced as a 4xx, never a 500. */
export class GameError extends Error {
	readonly code:
		| 'invalid_action'
		| 'illegal_action'
		| 'invalid_bet'
		| 'invalid_wager'
		| 'invalid_name'
		| 'already_submitted'
		| 'name_taken'
		| 'no_run';

	constructor(
		code: GameError['code'],
		message: string
	) {
		super(message);
		this.name = 'GameError';
		this.code = code;
	}
}

/** The result of a round, once it can no longer change. */
export interface Outcome {
	/**
	 * Chips removed from the stack. Usually the bet; three card poker returns
	 * only the ante when the player folds, since the play bet was never live.
	 */
	stake: number;
	/** Chips credited back, inclusive of the stake. 0 means the stake was lost. */
	returned: number;
	/** Player-facing summary, e.g. "Blackjack, 3:2". */
	detail: string;
}

export interface Step {
	state: unknown;
	view: GameView;
	/** Set when the round is over. The engine settles from this. */
	outcome: Outcome | null;
}

export interface GameHandler {
	readonly id: GameId;
	/** Display name, also used by the client's round log. */
	readonly title: string;

	/**
	 * Validates a client-supplied wager and returns a normalized copy. Throws
	 * GameError('invalid_wager') if the shape or values are wrong.
	 *
	 * `bet` is the stake the client asked for; games that need it to be a
	 * specific size relative to the stack (three card poker doubles the ante)
	 * validate it here.
	 */
	parseWager(wager: Wager, bet: number, stack: number): Wager;

	/**
	 * Builds the opening state for a round. Any randomness needed before the
	 * first decision (an opening deal, say) happens here.
	 *
	 * All randomness comes from ../rng, which wraps crypto.getRandomValues (or,
	 * for the daily ranked run, a day-seeded generator the engine installs).
	 * There is no Rng parameter on purpose: one entry point means there is a
	 * single place to audit that no game reaches for Math.random().
	 */
	init(wager: Wager, bet: number, stack: number): Step;

	/**
	 * The chips a wager puts at risk, for games where the wager itself sets the
	 * stake (roulette, spread over many spots). The engine records this as the
	 * round's bet. Games with a fixed stake leave it out.
	 */
	stakeOf?(wager: Wager): number;

	/** The actions the client may legally send from this state. */
	legalActions(state: unknown): ActionType[];

	/** Applies one action, advancing the round. */
	apply(state: unknown, action: Action): Step;

	/** Renders the current state for the client. */
	view(state: unknown): GameView;
}