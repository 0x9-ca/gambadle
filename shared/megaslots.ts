/**
 * Mega Slots — the machine's data: symbols, reel strips, paylines, paytable.
 *
 * Five reels show five symbols each. Forty fixed paylines pay left to right
 * from the first reel, three, four or five in a row. Wild substitutes for any
 * paying symbol; three or more scatters anywhere pay and award free spins.
 *
 * Shared so the client can draw the same symbols, lines and table. The outcome
 * logic lives in worker/games/megaslots.ts, and test/megaslots.test.ts computes
 * the return exactly from these numbers (it is what they were tuned against).
 */

export const MEGA_REELS = 5;
export const MEGA_ROWS = 5;

/** Low symbols are card ranks, as on a real machine; then the premiums; then the specials. */
export const MEGA_SYMBOLS = [
	'ten',
	'jack',
	'queen',
	'king',
	'ace',
	'clover',
	'bell',
	'diamond',
	'crown',
	'seven',
	'wild',
	'scatter',
] as const;
export type MegaSymbol = (typeof MEGA_SYMBOLS)[number];

export const MEGA_WILD: MegaSymbol = 'wild';
export const MEGA_SCATTER: MegaSymbol = 'scatter';

/**
 * Line pays for 3, 4 and 5 in a row, as multiples of the line bet (the stake
 * divided by the 40 lines). Wild pays its own row too, for a line of wilds.
 */
export const MEGA_PAYS: Partial<Record<MegaSymbol, readonly [number, number, number]>> = {
	ten: [7, 20, 75],
	jack: [7, 20, 75],
	queen: [9, 25, 100],
	king: [11, 30, 125],
	ace: [12, 40, 150],
	clover: [15, 60, 250],
	bell: [25, 80, 300],
	diamond: [30, 120, 500],
	crown: [50, 150, 750],
	seven: [75, 400, 2000],
	wild: [75, 400, 5000],
}

/** Scatter pays, as multiples of the whole stake, by how many land anywhere. */
export const MEGA_SCATTER_PAYS: Record<number, number> = { 3: 2, 4: 10, 5: 50 };

/** Three or more scatters award this many free spins, each paying this multiple. */
export const MEGA_FREE_SPINS = 8;
export const MEGA_FREE_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Paylines
// ---------------------------------------------------------------------------

/**
 * Line shapes as row offsets per reel. Each is laid at every starting row it
 * fits on (rows 0-4, top to bottom), which gives the forty lines below.
 */
const SHAPES: readonly (readonly number[])[] = [
	[0, 0, 0, 0, 0], // straight
	[0, 1, 2, 1, 0], // V
	[0, -1, -2, -1, 0], // inverted V
	[0, 1, 0, 1, 0], // zigzag down
	[0, -1, 0, -1, 0], // zigzag up
	[0, 1, 1, 1, 0], // shallow U
	[0, -1, -1, -1, 0], // shallow cap
	[0, 0, 1, 0, 0], // bump
	[0, 0, -1, 0, 0], // dip
	[0, 1, 2, 3, 4], // staircase down
	[0, -1, -2, -3, -4], // staircase up
	[0, 1, 2, 2, 2], // drop and run
];

function buildLines(): number[][] {
	const lines: number[][] = [];
	const seen = new Set<string>();
	for (const shape of SHAPES) {
		for (let start = 0; start < MEGA_ROWS; start++) {
			const line = shape.map((offset) => start + offset);
			if (line.some((row) => row < 0 || row >= MEGA_ROWS)) continue;
			const key = line.join('');
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(line);
		}
	}
	return lines;
}

/** Each payline is the row it crosses on each reel. */
export const MEGA_LINES: readonly (readonly number[])[] = buildLines();

// ---------------------------------------------------------------------------
// Reel strips
// ---------------------------------------------------------------------------

export const MEGA_STOPS = 40;

/**
 * Symbol counts per reel, 40 stops each. Wilds sit on the three middle reels
 * only: none on the first (every line starts there) or the last. One scatter
 * per reel, so a reel can never show two at once.
 *
 * Tuned together with the paytable to an exact 92.05% return: lines 62.2%,
 * scatters 4.2%, free spins 25.6% (triggered once in about 62 spins). See
 * test/megaslots.test.ts.
 */
export const MEGA_STRIP_COUNTS: readonly Record<MegaSymbol, number>[] = [
	{ ten: 7, jack: 7, queen: 6, king: 5, ace: 4, clover: 3, bell: 3, diamond: 2, crown: 1, seven: 1, wild: 0, scatter: 1 },
	{ ten: 6, jack: 6, queen: 5, king: 5, ace: 4, clover: 3, bell: 3, diamond: 2, crown: 1, seven: 1, wild: 3, scatter: 1 },
	{ ten: 6, jack: 6, queen: 5, king: 5, ace: 4, clover: 3, bell: 3, diamond: 2, crown: 1, seven: 1, wild: 3, scatter: 1 },
	{ ten: 6, jack: 6, queen: 5, king: 5, ace: 4, clover: 3, bell: 3, diamond: 2, crown: 1, seven: 1, wild: 3, scatter: 1 },
	{ ten: 7, jack: 7, queen: 6, king: 5, ace: 4, clover: 3, bell: 3, diamond: 2, crown: 1, seven: 1, wild: 0, scatter: 1 },
]

/** The order symbols are dealt onto a strip, cycled so each is spread around the reel. */
const STRIP_ORDER: readonly MegaSymbol[] = [
	'ten', 'king', 'jack', 'clover', 'queen', 'ace', 'bell', 'ten', 'jack', 'diamond',
	'queen', 'king', 'crown', 'ten', 'jack', 'ace', 'seven', 'queen', 'wild', 'bell',
];

function buildStrip(counts: Record<MegaSymbol, number>, rotate: number): MegaSymbol[] {
	const remaining: Record<MegaSymbol, number> = { ...counts, scatter: 0 };
	const strip: MegaSymbol[] = [];
	for (let i = rotate; strip.length < MEGA_STOPS - counts.scatter; i++) {
		const symbol = STRIP_ORDER[i % STRIP_ORDER.length]!;
		if (remaining[symbol] > 0) {
			strip.push(symbol);
			remaining[symbol] -= 1;
		}
		if (i > rotate + 10_000) throw new Error('strip counts do not fit the strip order');
	}
	// The scatter goes in at a fixed position per reel.
	if (counts.scatter > 0) strip.splice((rotate * 7) % MEGA_STOPS, 0, 'scatter');
	if (strip.length !== MEGA_STOPS) throw new Error(`strip has ${strip.length} stops`);
	return strip;
}

export const MEGA_STRIPS: readonly (readonly MegaSymbol[])[] = MEGA_STRIP_COUNTS.map((counts, reel) =>
	buildStrip(counts, reel * 3)
);
