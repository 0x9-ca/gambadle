/**
 * The daily seed's generator. Its key carries the server secret, so the stream
 * must be deterministic per key without letting a player recover the key.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seededRng, sha256 } from '../worker/seed';

const hex = (words: Uint32Array) => [...words].map((w) => w.toString(16).padStart(8, '0')).join('');

describe('seededRng', () => {
	it('hashes with real SHA-256', () => {
		for (const key of ['', 'a', 'daily-seed|secret|2026-10-03|r1:d0:init', 'x'.repeat(55), 'x'.repeat(60), 'é'.repeat(70)]) {
			for (const counter of [0, 1, 0xdeadbeef]) {
				const bytes = new TextEncoder().encode(key);
				const suffix = Buffer.alloc(4);
				suffix.writeUInt32BE(counter);
				const expected = createHash('sha256').update(bytes).update(suffix).digest('hex');
				expect(hex(sha256(bytes, counter))).toBe(expected);
			}
		}
	});

	it('is deterministic per key, and in [0, 1)', () => {
		const a = seededRng('k');
		const b = seededRng('k');
		const draws = Array.from({ length: 50 }, () => a());
		expect(Array.from({ length: 50 }, () => b())).toEqual(draws);
		expect(draws.every((x) => x >= 0 && x < 1)).toBe(true);
		expect(new Set(draws).size).toBe(50);
	});

	// "costarring" and "liquid" collide under 32-bit FNV-1a, which the old
	// generator folded the key into: two secrets with that collision dealt the
	// same day, i.e. the whole day rested on 32 bits a player could brute-force.
	it('does not collapse the secret into a 32-bit state', () => {
		const first = seededRng('costarring|2026-10-03|game:1');
		const second = seededRng('liquid|2026-10-03|game:1');
		expect([first(), first(), first()]).not.toEqual([second(), second(), second()]);
	});
});
