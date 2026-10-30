/**
 * The three-reel Slots result sequence, in milliseconds from when the board
 * appears: the round's spins one after another, each with its reels stopping
 * left to right and a beat to read the lines. The board plays it and the reveal
 * hold waits for its end, so both read the same numbers.
 */

/** When each reel comes to rest within a spin; left to right. */
export const SLOT_REEL_STOPS = [400, 650, 900];
/** One spin, start to next start. */
export const SLOT_SPIN_MS = 1400;

export const slotsEnd = (spins: number): number => spins * SLOT_SPIN_MS;
