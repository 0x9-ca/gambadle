/**
 * The game registry.
 *
 * A run draws five games from this list without repeats, so the order is the
 * only thing the client needs to know about which games exist.
 */

import type { GameId } from '../../shared/protocol';
import { baccarat } from './baccarat';
import { blackjack } from './blackjack';
import { coinflip } from './coinflip';
import { dice } from './dice';
import { GameError, type GameHandler } from './types';
import { threecard } from './threecard';
import { slots } from './slots';
import { roulette } from './roulette';
import { ultimate } from './ultimate';
import { paigow } from './paigow';
import { megaslots } from './megaslots';
import { videopoker } from './videopoker';

export const GAMES: readonly GameHandler[] = [
	blackjack,
	roulette,
	baccarat,
	coinflip,
	dice,
	slots,
	threecard,
	ultimate,
	paigow,
	megaslots,
	videopoker,
];

const BY_ID = new Map<GameId, GameHandler>(GAMES.map((g) => [g.id, g]));

export function gameById(id: GameId): GameHandler {
	const handler = BY_ID.get(id);
	if (!handler) throw new GameError('invalid_action', `unknown game: ${id}`);
	return handler;
}

/** Display names, for the round log and the "next up" teaser. */
export const GAME_TITLES: Record<GameId, string> = Object.fromEntries(
	GAMES.map((g) => [g.id, g.title])
) as Record<GameId, string>;

export { GameError };
export type { GameHandler };