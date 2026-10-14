/**
 * When each card of a hand lands, in one place.
 *
 * The cards animate from this plan, and the text that would give a result away
 * (a hand's name, a total, a tick or a cross) waits for the same moment, so the
 * two cannot drift apart. Durations match `.card--deal` and `.card--flip`.
 */

export type CardMotion = 'deal' | 'flip' | 'still';

export const DEAL_MS = 350;
export const FLIP_MS = 450;

/**
 * How card `index` of a hand arrives. `still` is how many leading cards the
 * player has already seen; `flip` is the index of a card turned over rather than
 * dealt (a dealer's hole card).
 */
export function cardPlan(index: number, still = 0, flip = -1): { motion: CardMotion; delay: number } {
	if (index === flip) return { motion: 'flip', delay: 600 };
	if (index < still) return { motion: 'still', delay: 0 };
	// Cards dealt before the one that turns over land first.
	if (flip >= 0 && index < flip) return { motion: 'deal', delay: index * 150 };
	// New cards on a result board arrive one after another, after any flip.
	if (still > 0 || flip >= 0) {
		return { motion: 'deal', delay: (flip >= 0 ? 900 : 0) + Math.max(0, index - Math.max(still, flip + 1)) * 250 };
	}
	// An opening deal: the first two cards of a hand land in quick sequence,
	// while a later hit arrives at once.
	return { motion: 'deal', delay: index < 2 ? index * 150 : 0 };
}

/** Milliseconds until the last card of a hand has landed (0 if none are animated). */
export function handDoneMs(count: number, still = 0, flip = -1): number {
	let done = 0;
	for (let i = 0; i < count; i++) {
		const { motion, delay } = cardPlan(i, still, flip);
		if (motion !== 'still') done = Math.max(done, delay + (motion === 'flip' ? FLIP_MS : DEAL_MS));
	}
	return done;
}
