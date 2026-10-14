/**
 * A drop-in, deterministic replacement for `worker/rng`.
 *
 * Installed with `vi.mock`, so every game draws from this instead of the real
 * CSPRNG. Same API surface as the real module, plus `setSeed` so a failing case
 * can be reproduced exactly.
 *
 * The algorithm is mulberry32 — small, fast, and well distributed enough for
 * payout simulation.
 */

let state = 0;

export function setSeed(seed: number): void {
	state = seed >>> 0;
}

/** Uniform float in [0, 1). */
function next(): number {
	state = (state + 0x6d2b79f5) >>> 0;
	let t = state;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export type Rng = () => number;

let override: Rng | null = null;

export const random: Rng = () => (override ?? next)();

export function withRng<T>(rng: Rng, fn: () => T): T {
	const previous = override;
	override = rng;
	try {
		return fn();
	} finally {
		override = previous;
	}
}

export { seededRng } from '../../worker/seed';

export function randomInt(max: number): number {
	return Math.floor(random() * max);
}

export function randomBetween(min: number, max: number): number {
	return min + randomInt(max - min + 1);
}

export function chance(p: number): boolean {
	return random() < p;
}

export function shuffle<T>(items: readonly T[]): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

export function pick<T>(items: readonly T[]): T {
	if (items.length === 0) throw new Error('pick() called on an empty list');
	return items[randomInt(items.length)]!;
}