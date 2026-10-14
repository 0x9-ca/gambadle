/**
 * How long each game's result board takes to play out, in seconds.
 *
 * Everything that would give the outcome away (the verdict, the header's chip
 * count, the round pips, a Double or Nothing offer) waits this long after a
 * round settles, so the reveal is watched rather than spoiled.
 */

import type { GameId, RoundResult } from '../../shared/protocol';
import { BASE_DONE, megaEnd } from './megaTimeline';

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
	megaslots: BASE_DONE / 1000,
	videopoker: 1.2,
	// The dice tumble for 0.9s and then settle for about 0.35s.
	craps: 1.3,
};

export function revealSeconds(result: RoundResult | null): number {
	if (!result?.view) return 0;
	// Mega Slots plays its free spins on the result board, so it takes as long as they do.
	if (result.view.game === 'megaslots') return megaEnd(result.view.free.length) / 1000 + 0.2;
	return REVEAL_SECONDS[result.game];
}
