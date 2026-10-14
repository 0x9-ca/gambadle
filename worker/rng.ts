/**
 * Randomness helpers.
 *
 * Everything the game does that could be gamed goes through here, so there is a
 * single place to audit. `Math.random()` is never used anywhere in this project —
 * it is not cryptographically secure and its output is predictable.
 *
 * The one deliberate exception to "unpredictable" is the daily ranked run, which
 * must deal every player the same games. The engine wraps each game call in
 * `withRng(seededRng(...), ...)` (see ./seed); everything else keeps drawing from the CSPRNG.
 */

export type Rng = () => number;

const csprng: Rng = () => {
	const buf = new Uint32Array(1);
	crypto.getRandomValues(buf);
	// Divide by 2^32 to map into [0, 1).
	return buf[0] / 4294967296;
};

/**
 * Set only for the duration of a synchronous `withRng` call. Workers run one
 * request at a time per isolate and the callback never awaits, so nothing else
 * can observe it.
 */
let override: Rng | null = null;

/** Uniform float in [0, 1). */
export const random: Rng = () => (override ?? csprng)();

/** Runs `fn` with every draw taken from `rng` instead of the CSPRNG. */
export function withRng<T>(rng: Rng, fn: () => T): T {
	const previous = override;
	override = rng;
	try {
		return fn();
	} finally {
		override = previous;
	}
}

/** Uniform integer in [0, max). */
export function randomInt(max: number): number {
	return Math.floor(random() * max);
}

/** Uniform integer in [min, max], inclusive on both ends. */
export function randomBetween(min: number, max: number): number {
	return min + randomInt(max - min + 1);
}

/** True with probability `p`. */
export function chance(p: number): boolean {
	return random() < p;
}

/**
 * Fisher-Yates shuffle. Returns a new array; the input is not mutated.
 */
export function shuffle<T>(items: readonly T[]): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		const tmp = out[i];
		out[i] = out[j];
		out[j] = tmp;
	}
	return out;
}

/** Picks one element uniformly. Throws on an empty list. */
export function pick<T>(items: readonly T[]): T {
	if (items.length === 0) throw new Error('pick() called with an empty list');
	return items[randomInt(items.length)]!;
}