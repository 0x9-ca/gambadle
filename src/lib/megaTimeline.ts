/**
 * The Mega Slots result sequence, in milliseconds from when the board appears:
 * the base reels stop left to right, then (if won) a free spins banner and each
 * free spin in turn. The board plays it, and the reveal hold waits for its end,
 * so both read the same numbers.
 */

/** When each base reel stops. */
export const baseStop = (reel: number): number => 650 + reel * 230;
/** After the last base reel has landed and settled. */
export const BASE_DONE = 1800;
/** The free spins banner. */
export const BANNER_MS = 1500;
/** One free spin, start to next start. */
export const FREE_SPIN_MS = 1150;
/** When each reel of a free spin stops, from that spin's start. */
export const freeStop = (reel: number): number => 380 + reel * 110;

export function megaEnd(freeSpins: number): number {
	return freeSpins > 0 ? BASE_DONE + BANNER_MS + freeSpins * FREE_SPIN_MS : BASE_DONE;
}

/** What is on screen at time `t`. */
export interface MegaMoment {
	/** -1 for the base spin, else the free spin being shown. */
	spin: number;
	/** Reels that have stopped on the spin being shown. */
	stopped: number;
	/** Showing the free spins banner. */
	banner: boolean;
	/** Free spins fully played so far. */
	freeDone: number;
	done: boolean;
}

export function momentAt(t: number, freeSpins: number): MegaMoment {
	if (t < BASE_DONE || freeSpins === 0) {
		const stopped = [0, 1, 2, 3, 4].filter((reel) => t >= baseStop(reel)).length;
		return { spin: -1, stopped, banner: false, freeDone: 0, done: t >= BASE_DONE };
	}
	const afterBanner = t - BASE_DONE - BANNER_MS;
	if (afterBanner < 0) return { spin: -1, stopped: 5, banner: true, freeDone: 0, done: false };
	const index = Math.min(freeSpins - 1, Math.floor(afterBanner / FREE_SPIN_MS));
	const local = afterBanner - index * FREE_SPIN_MS;
	const stopped = [0, 1, 2, 3, 4].filter((reel) => local >= freeStop(reel)).length;
	const done = t >= megaEnd(freeSpins);
	return { spin: index, stopped, banner: false, freeDone: done ? freeSpins : index + (stopped === 5 ? 1 : 0), done };
}
