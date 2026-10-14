/**
 * Video Poker: hand reading, the draw, and the exact return under best play.
 *
 * The return check is the point of the file. It enumerates all 2,598,960
 * five-card hands, and for each of the 32 ways to hold cards the expected pay
 * over every possible draw, then takes the best hold. For 8/5 Jacks or Better
 * with an 800 royal the published figure is 97.30%, so matching it checks the
 * hand evaluator, the pay table and the draw rules against something outside
 * this repository.
 */

import { describe, expect, it } from 'vitest';
import { VP_KINDS, VP_PAYS, type VpKind } from '../shared/games';
import type { Action, GameView } from '../shared/protocol';
import { type Card, makeCard } from '../worker/games/cards';
import { kindOfCards, videopoker, videoPokerKind } from '../worker/games/videopoker';
import { GameError } from '../worker/games/types';

type V = Extract<GameView, { game: 'videopoker' }>;

const RANKS: Record<string, number> = { A: 1, T: 10, J: 11, Q: 12, K: 13 };
const cards = (text: string): Card[] =>
	text.split(/\s+/).map((t) => makeCard(RANKS[t[0]!] ?? Number(t[0]), t[1] as 's' | 'h' | 'd' | 'c'));
const kind = (text: string) => kindOfCards(cards(text));

describe('reading a hand', () => {
	it('names every paying hand', () => {
		expect(kind('Ah Kh Qh Jh Th')).toBe('royal');
		expect(kind('9h 8h 7h 6h 5h')).toBe('straightflush');
		expect(kind('Ah 2h 3h 4h 5h')).toBe('straightflush'); // the wheel
		expect(kind('9h 9d 9s 9c 5h')).toBe('four');
		expect(kind('9h 9d 9s 5c 5h')).toBe('fullhouse');
		expect(kind('Ah 9h 7h 4h 2h')).toBe('flush');
		expect(kind('Ah 2d 3s 4c 5h')).toBe('straight');
		expect(kind('Td Jd Qs Kc Ah')).toBe('straight'); // broadway, not suited
		expect(kind('9h 9d 9s 5c 4h')).toBe('three');
		expect(kind('9h 9d 5s 5c 4h')).toBe('twopair');
		expect(kind('Jh Jd 6s 5c 4h')).toBe('jacks');
		expect(kind('Ah Ad 6s 5c 4h')).toBe('jacks');
	});

	it('pays nothing for a low pair, high cards, or a straight that wraps', () => {
		expect(kind('Th Td 6s 5c 4h')).toBeNull();
		expect(kind('Ah Kd 6s 5c 4h')).toBeNull();
		expect(kind('Qh Kd As 2c 3h')).toBeNull();
		expect(kind('Kh Ad 2s 3c 4h')).toBeNull();
	});

	it('pays the table, best first, with the jacks-or-better pair returning the bet', () => {
		const pays = VP_KINDS.map((k) => VP_PAYS[k]);
		expect([...pays].sort((a, b) => b - a)).toEqual(pays);
		expect(VP_PAYS.jacks).toBe(1);
	});
});

describe('Video Poker round', () => {
	/** A round with the shoe replaced: the dealt hand first, then the draw cards in order. */
	function rigged(hand: string, next: string, bet = 100) {
		const step = videopoker.init({ game: 'videopoker' }, bet, 1000);
		const s = step.state as { shoe: { cards: Card[]; pos: number }; hand: Card[] };
		s.hand = cards(hand);
		s.shoe = { cards: cards(next), pos: 0 };
		return s;
	}
	const draw = (s: unknown, hold?: number[]) => videopoker.apply(s, { type: 'DRAW', hold } as Action);

	it('deals five cards, hides the rest, and draws once', () => {
		const step = videopoker.init({ game: 'videopoker' }, 100, 1000);
		const view = step.view as V;
		expect(view.hand.cards).toHaveLength(5);
		expect(view.stage).toBe('deal');
		expect(view.resolved).toBe(false);
		expect(videopoker.legalActions(step.state)).toEqual(['DRAW']);
		const done = draw(step.state, [0, 1]);
		expect(done.view.resolved).toBe(true);
		expect(videopoker.legalActions(done.state)).toEqual([]);
		expect(() => draw(done.state, [])).toThrow(GameError);
	});

	it('replaces only the cards not held, from the top of the deck in order', () => {
		const s = rigged('Jh 2d 3s 9c 5h', 'Jd 8h Kc 4d 6s');
		const done = draw(s, [0, 3]);
		const view = done.view as V;
		expect(view.held).toEqual([0, 3]);
		// Positions 1, 2 and 4 take the first three cards off the deck.
		expect(view.hand.cards.map((c) => `${c.rank}${c.suit}`)).toEqual(['11h', '11d', '8h', '9c', '13c']);
		expect(done.outcome!.returned).toBe(100); // a pair of jacks gives the bet back
	});

	it('pays the table on the final hand, stake included', () => {
		const flush = draw(rigged('Ah 9h 2d 4h 7h', '3h 8s 5c Kd Qs'), [0, 1, 3, 4]).outcome!;
		expect(flush.returned).toBe(100 * VP_PAYS.flush);
		const royal = draw(rigged('Ah Kh Qh Jh 2d', 'Th 5c 6s 7d 8c'), [0, 1, 2, 3]).outcome!;
		expect(royal.returned).toBe(100 * VP_PAYS.royal);
		const miss = draw(rigged('Ah Kd 7s 4c 2h', '3d 9c 5s Js 8h'), [0]).outcome!;
		expect(miss.returned).toBe(0);
		expect(miss.stake).toBe(100);
	});

	it('treats a bare DRAW as holding nothing and rejects bad holds', () => {
		const s = rigged('Jh Jd 3s 9c 5h', 'Ac Kc Qc Jc Tc');
		expect((draw(s).view as V).held).toEqual([]);
		for (const hold of [[5], [-1], [1, 1], [0, 1, 2, 3, 4, 0], [1.5], 'no' as unknown as number[]]) {
			const fresh = rigged('Jh Jd 3s 9c 5h', 'Ac Kc Qc Jc Tc');
			expect(() => draw(fresh, hold)).toThrow(GameError);
		}
	});

	it('shows the paying hand on the deal and the final pay after the draw', () => {
		const s = rigged('Jh Jd 3s 9c 5h', '2c 4c 6c 7d 8d');
		const before = videopoker.view(s) as V;
		expect(before.kind).toBe('jacks');
		expect(before.pays).toBe(0); // nothing is paid before the draw
		const after = draw(s, [0, 1]).view as V;
		expect(after.pays).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// The exact return
// ---------------------------------------------------------------------------

/**
 * Expected return per chip over every hand, taking the best hold for each.
 *
 * The draw comes from the 47 cards that were not dealt, so a discarded card can
 * never come back. That makes the value of a hold depend on the whole hand, not
 * just the cards kept. Enumerating 47-card draws for every hand and hold would
 * take days, so this uses inclusion-exclusion instead. With G(X) the total pay
 * over every way to complete a held set X into five cards from the whole deck
 * (which does depend only on X, and is computed once per distinct X),
 *
 *     total pay of holding H from this hand = sum over X with H <= X <= hand
 *                                              of (-1)^(|X|-|H|) * G(X)
 *
 * because the draws that would pull a discarded card back in are exactly the
 * ones counted by the larger sets. Over the five dealt cards that is a
 * superset Moebius transform. Dividing by the number of 47-card draws gives
 * each hold's expected pay.
 */
function optimalReturn(): number {
	const rank = (card: number) => (card >> 2) + 1;
	const suit = (card: number) => card & 3;
	const payOf = (kind: VpKind | null) => (kind ? VP_PAYS[kind] : 0);
	const ranks = [0, 0, 0, 0, 0];
	const suits = [0, 0, 0, 0, 0];

	// G(X): total pay over every completion of the held set `held` from all other cards.
	const completionsPay = (held: number[]): number => {
		const heldSet = new Set(held);
		const rest: number[] = [];
		for (let c = 0; c < 52; c++) if (!heldSet.has(c)) rest.push(c);
		held.forEach((c, i) => {
			ranks[i] = rank(c);
			suits[i] = suit(c);
		});
		let total = 0;
		const fill = (slot: number, from: number) => {
			if (slot === 5) {
				total += payOf(videoPokerKind(ranks, suits));
				return;
			}
			for (let i = from; i < rest.length - (4 - slot); i++) {
				ranks[slot] = rank(rest[i]!);
				suits[slot] = suit(rest[i]!);
				fill(slot + 1, i + 1);
			}
		};
		fill(held.length, 0);
		return total;
	};

	// Ways to draw 5 - k cards from the 47 not dealt.
	const draws = [1, 47, 1081, 16215, 178365, 1533939].reverse(); // by number held, 0..5
	const popcount = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);

	const cache = new Map<number, number>();
	const POW = Array.from({ length: 52 }, (_, i) => 2 ** i);
	const hand = [0, 0, 0, 0, 0];
	const keys = new Float64Array(32);
	const holds = new Array<number[]>(32);
	const g = new Float64Array(32);
	const heldCount = Array.from({ length: 32 }, (_, m) => popcount(m));
	let sum = 0;
	let hands = 0;

	for (let a = 0; a < 48; a++)
		for (let b = a + 1; b < 49; b++)
			for (let c = b + 1; c < 50; c++)
				for (let d = c + 1; d < 51; d++)
					for (let e = d + 1; e < 52; e++) {
						hand[0] = a;
						hand[1] = b;
						hand[2] = c;
						hand[3] = d;
						hand[4] = e;
						keys[0] = 0;
						holds[0] = [];
						for (let mask = 0; mask < 32; mask++) {
							if (mask > 0) {
								const low = 31 - Math.clz32(mask & -mask);
								const prev = mask & (mask - 1);
								keys[mask] = keys[prev]! + POW[hand[low]!]!;
								holds[mask] = [...holds[prev]!, hand[low]!];
							}
							let total = cache.get(keys[mask]!);
							if (total === undefined) {
								total = completionsPay(holds[mask]!.slice().sort((x, y) => x - y));
								cache.set(keys[mask]!, total);
							}
							g[mask] = total;
						}
						// Superset Moebius transform: g[H] becomes the total pay of holding H.
						for (let bit = 1; bit < 32; bit <<= 1) {
							for (let mask = 0; mask < 32; mask++) {
								if (!(mask & bit)) g[mask]! -= g[mask | bit]!;
							}
						}
						let best = -1;
						for (let mask = 0; mask < 32; mask++) {
							const value = g[mask]! / draws[heldCount[mask]!]!;
							if (value > best) best = value;
						}
						sum += best;
						hands++;
					}
	expect(hands).toBe(2_598_960);
	return sum / hands;
}

describe('Video Poker return', () => {
	it('returns 97.30% under the best play (the published figure for 8/5 Jacks or Better)', { timeout: 300_000 }, () => {
		const started = Date.now();
		const rtp = optimalReturn();
		process.stdout.write(
			`Video Poker optimal return: ${(rtp * 100).toFixed(3)}% (${((Date.now() - started) / 1000).toFixed(1)}s)\n`
		);
		expect(rtp).toBeGreaterThan(0.9729);
		expect(rtp).toBeLessThan(0.9731);
	});
});
