/**
 * How long each game's result board takes to play out, in seconds.
 *
 * Everything that would give the outcome away (the verdict, the header's chip
 * count, the round pips, a Double or Nothing offer) waits this long after a
 * round settles, so the reveal is watched rather than spoiled.
 */

import type { GameId, RoundResult } from '../../shared/protocol';

const REVEAL_SECONDS: Record<GameId, number> = {
	blackjack: 1.4,
	roulette: 3.1,
	baccarat: 1,
	coinflip: 1,
	dice: 1,
	slots: 1.8,
	threecard: 0.6,
	ultimate: 0.6,
	paigow: 0.8,
};

export function revealSeconds(result: RoundResult | null): number {
	return result?.view ? REVEAL_SECONDS[result.game] : 0;
}
