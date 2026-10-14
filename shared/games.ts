/**
 * Domain constants that both the Worker and the client need.
 *
 * Anything here is presentation-safe: paytables, wheel colours, slider bounds.
 * Outcome *logic* stays in worker/games/ — the client never computes a result,
 * it only renders numbers that the server also computes.
 */

// ---------------------------------------------------------------------------
// Roulette — European single zero
// ---------------------------------------------------------------------------

export const ROULETTE_MAX = 36;

/** The red numbers on a European wheel. Zero is green and not in this set. */
export const ROULETTE_RED: ReadonlySet<number> = new Set([
	1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export type WheelColor = 'red' | 'black' | 'green';

export function colorOf(n: number): WheelColor {
	if (n === 0) return 'green';
	return ROULETTE_RED.has(n) ? 'red' : 'black';
}

// ---------------------------------------------------------------------------
// Dice — two six-sided dice
// ---------------------------------------------------------------------------

export const DICE_COUNT = 2;
export const DICE_FACES = 6;
/** Equally likely (die1, die2) pairs. */
export const DICE_COMBOS = DICE_FACES ** DICE_COUNT;

/**
 * The roll-under target runs 2 to 9. Above that the win chance is so high that
 * the fair price rounds to barely more than the stake, and a whole-chip payout
 * would swallow the whole win on small bets.
 */
export const DICE_MIN_TARGET = 2;
export const DICE_MAX_TARGET = 9;

/** The house keeps this fraction of the fair price. */
const DICE_EDGE = 0.03;

/** How many of the 36 two-dice combinations total `target` or lower. */
export function rollUnderWays(target: number): number {
	let ways = 0;
	for (let a = 1; a <= DICE_FACES; a++) {
		for (let b = 1; b <= DICE_FACES; b++) {
			if (a + b <= target) ways++;
		}
	}
	return ways;
}

/**
 * Total return per unit staked for a 2d6 total of `target` or lower (stake
 * included, so profit odds are this minus one). Priced fairly from the exact
 * combination count, less a 3% edge, truncated to hundredths.
 */
export function rollUnderMultiplier(target: number): number {
	const fair = DICE_COMBOS / rollUnderWays(target);
	return Math.floor(fair * (1 - DICE_EDGE) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * Twelve symbols in four tiers.
 *
 * The count matters more than it looks. With only a handful of symbols on a
 * twenty-stop reel, three-of-a-kind lands every few spins and no paytable can
 * bring the machine near a 90% return. Twelve symbols puts the hit rate at
 * about one spin in twelve, which is what a slot should feel like.
 */
export const SLOT_SYMBOLS = [
	'cherry',
	'lemon',
	'bell',
	'clover',
	'star',
	'diamond',
	'melon',
	'grape',
	'gift',
	'coin',
	'crown',
	'seven',
] as const;
export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

export const SLOT_GLYPH: Record<SlotSymbol, string> = {
	cherry: '🍒',
	lemon: '🍋',
	bell: '🔔',
	clover: '🍀',
	star: '⭐',
	diamond: '💎',
	melon: '🍉',
	grape: '🍇',
	gift: '🎁',
	coin: '🪙',
	crown: '👑',
	seven: '7️⃣',
};

export const SLOT_STOPS_PER_REEL = 20;

/**
 * Per-reel symbol counts, summing to `SLOT_STOPS_PER_REEL` per reel.
 *
 * Deliberately not symmetric, so no two reels are clones of one another.
 */
export const SLOT_STRIP_COUNTS: readonly Record<SlotSymbol, number>[] = [
	{ cherry: 3, lemon: 3, bell: 2, clover: 2, star: 2, diamond: 2, melon: 1, grape: 1, gift: 1, coin: 1, crown: 1, seven: 1 },
	{ cherry: 3, lemon: 2, bell: 3, clover: 2, star: 2, diamond: 1, melon: 2, grape: 1, gift: 1, coin: 1, crown: 1, seven: 1 },
	{ cherry: 2, lemon: 3, bell: 2, clover: 3, star: 1, diamond: 2, melon: 1, grape: 2, gift: 1, coin: 1, crown: 1, seven: 1 },
];

/**
 * The order each reel's symbols are laid down in.
 *
 * Cycling a fixed order is what spaces the symbols evenly around the reel. A
 * strip sorted by symbol — six cherries in a row, then five lemons — puts almost
 * every three-stop window on three identical symbols, which hands out a triple
 * on nearly every spin and blows the paytable apart. Real strips interleave.
 */
export const SLOT_STRIP_ORDERS: readonly (readonly SlotSymbol[])[] = [
	['cherry', 'lemon', 'bell', 'clover', 'star', 'diamond', 'melon', 'grape', 'gift', 'coin', 'crown', 'seven'],
	['clover', 'bell', 'lemon', 'cherry', 'diamond', 'star', 'grape', 'melon', 'coin', 'gift', 'crown', 'seven'],
	['bell', 'clover', 'cherry', 'lemon', 'diamond', 'melon', 'star', 'grape', 'crown', 'coin', 'gift', 'seven'],
];

function buildStrip(
	counts: Record<SlotSymbol, number>,
	order: readonly SlotSymbol[]
): SlotSymbol[] {
	const remaining: Record<SlotSymbol, number> = { ...counts };
	const strip: SlotSymbol[] = [];
	for (let i = 0; strip.length < SLOT_STOPS_PER_REEL; i++) {
		const symbol = order[i % order.length]!;
		if (remaining[symbol] > 0) {
			strip.push(symbol);
			remaining[symbol] -= 1;
		}
	}
	if (strip.length !== SLOT_STOPS_PER_REEL) {
		throw new Error(`reel strip has ${strip.length} stops, expected ${SLOT_STOPS_PER_REEL}`);
	}
	return strip;
}

export const SLOT_STRIPS: readonly (readonly SlotSymbol[])[] = SLOT_STRIP_COUNTS.map((counts, i) =>
	buildStrip(counts, SLOT_STRIP_ORDERS[i]!)
);

/**
 * What a winning payline pays, as a multiple of the **whole stake**.
 *
 * Any payline showing three of a kind pays this much, so two winning lines pay
 * twice it. A value of 2 returns twice the stake, which reads as 1:1 profit.
 *
 * These are return multiples, not profit odds, so displayed odds are one less.
 *
 * `test/slots.test.ts` enumerates all 20³ reel offsets and solves this table for
 * a 90% return, so the numbers are measured rather than picked by feel. The
 * top symbol lands once in 2667 spins, which is where most of the return lives.
 */
export const SLOT_PAYTABLE: Record<SlotSymbol, number> = {
	cherry: 2,
	lemon: 2,
	bell: 3,
	clover: 3,
	star: 9,
	diamond: 9,
	melon: 29,
	grape: 29,
	gift: 116,
	coin: 116,
	crown: 116,
	seven: 1720,
};

/** Payline labels, indexed by row. */
export const SLOT_LINES = ['top', 'middle', 'bottom'] as const;

// ---------------------------------------------------------------------------
// Three Card Poker
// ---------------------------------------------------------------------------

/** A player's three-card hand, best to worst. */
export const TCP_RANKS = [
	'royal flush',
	'straight flush',
	'three of a kind',
	'straight',
	'flush',
	'pair',
	'high card',
] as const;
export type TcpRank = (typeof TCP_RANKS)[number];

/**
 * Profit per unit staked on Pair Plus. Pays on the player's hand alone.
 * -1 means the bet loses outright (nothing is returned, not even the stake).
 */
export const TCP_PAIR_PLUS: Record<TcpRank, number> = {
	// A three-card royal is just the top straight flush at most casinos.
	'royal flush': 40,
	'straight flush': 40,
	'three of a kind': 30,
	straight: 6,
	flush: 3,
	pair: 1,
	'high card': -1,
};

/**
 * Ante Bonus, paid on the player's hand whatever the dealer holds (but not on
 * a fold). A three-card royal pays as a straight flush.
 */
export const TCP_ANTE_BONUS: Partial<Record<TcpRank, number>> = {
	'royal flush': 5,
	'straight flush': 5,
	'three of a kind': 4,
	straight: 1,
};

/** The dealer must hold queen-high or better. */
export const TCP_QUALIFIER = 'Q';

// ---------------------------------------------------------------------------
// Blackjack: TriLux side bet
// ---------------------------------------------------------------------------

/**
 * TriLux, as posted at Tulalip: profit odds on the poker hand made by the
 * player's first two cards and the dealer's up card. Anything else loses. A
 * suited A-K-Q is the "Mini Royal". Keyed by the three card poker hand names.
 */
export const TRILUX_PAYS: Partial<Record<TcpRank, number>> = {
	'royal flush': 100,
	'straight flush': 35,
	'three of a kind': 33,
	straight: 10,
	flush: 5,
};

export const TRILUX_LABEL: Partial<Record<TcpRank, string>> = {
	'royal flush': 'Mini Royal',
	'straight flush': 'Straight Flush',
	'three of a kind': 'Three of a Kind',
	straight: 'Straight',
	flush: 'Flush',
};

// ---------------------------------------------------------------------------
// Ultimate Texas Hold'em
// ---------------------------------------------------------------------------

/** Ante + Blind + the largest raise (4x): the most a hand can put out, in antes. */
export const UTH_MAX_ANTES = 6;

/** Hand names for the two paytables, best first. */
export const UTH_HANDS = [
	'Royal Flush',
	'Straight Flush',
	'Four of a Kind',
	'Full House',
	'Flush',
	'Straight',
	'Three of a Kind',
] as const;
export type UthHand = (typeof UTH_HANDS)[number];

/**
 * Blind bet, paid only when the player wins the hand; a winning hand below a
 * straight pushes it. These are profit odds (Flush is 3:2).
 */
export const UTH_BLIND: Partial<Record<UthHand, number>> = {
	'Royal Flush': 500,
	'Straight Flush': 50,
	'Four of a Kind': 10,
	'Full House': 3,
	Flush: 1.5,
	Straight: 1,
};

/** Trips side bet: pays on the player's final hand whatever the dealer holds, even after a fold. */
export const UTH_TRIPS: Record<UthHand, number> = {
	'Royal Flush': 50,
	'Straight Flush': 40,
	'Four of a Kind': 30,
	'Full House': 8,
	Flush: 6,
	Straight: 5,
	'Three of a Kind': 3,
};

// ---------------------------------------------------------------------------
// Pai Gow Poker
// ---------------------------------------------------------------------------

/** Winning both hands pays even money less this commission. */
export const PAI_GOW_COMMISSION = 0.05;

/** Banker wins less this fraction as commission. */
export const BACCARET_COMMISSION = 0.05;

/**
 * The baccarat paytable, as profit odds per unit staked.
 *
 * The measured frequencies in an eight-deck shoe are Player 44.625%, Banker
 * 45.860%, Tie 9.516%, and either-side pair 14.382% — all pinned down by an
 * exact enumeration in test/games.test.ts rather than copied from a paytable.
 * Player and Banker bets push on a tie, which is what puts their edges near 1%
 * instead of near 10%.
 *
 * Either Pair is the one price that has to move: it lands once in 6.95 hands, so
 * the fair price is about 5:1. Paying 8:1 hands a player 29% of every chip staked
 * on it, which is not a bet worth offering.
 */
export const BACCARAT_ODDS = {
	player: 1,
	banker: 1,
	tie: 8,
	playerPair: 11,
	bankerPair: 11,
	eitherPair: 5,
} as const;
