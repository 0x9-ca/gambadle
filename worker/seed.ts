import type { Rng } from './rng';

/** Deterministic generator (mulberry32) keyed by an arbitrary string. */
export function seededRng(seed: string): Rng {
	// FNV-1a folds the string into a 32-bit state.
	let state = 2166136261;
	for (let i = 0; i < seed.length; i++) {
		state ^= seed.charCodeAt(i);
		state = Math.imul(state, 16777619);
	}
	state >>>= 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
