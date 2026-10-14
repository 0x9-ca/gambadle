/**
 * The wire contract between the React client and the Worker.
 *
 * Both sides import from here so the action union and the state shape can never
 * drift. The client is a pure function of `RunView`: it holds no chips, no cards
 * and no randomness, which is what makes the leaderboard trustworthy.
 */

// ---------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------

export const GAME_IDS = [
	'blackjack',
	'roulette',
	'baccarat',
	'coinflip',
	'dice',
	'slots',
	'threecard',
	'ultimate',
	'paigow',
] as const;

export type GameId = (typeof GAME_IDS)[number];

export const TOTAL_ROUNDS = 5;
export const STARTING_CHIPS = 1000;
export const MIN_BET = 1;

/**
 * Games with nothing to choose before playing — the stake is the whole wager.
 * The client confirms these immediately on entering `choosing`.
 */
export const GAMES_WITHOUT_WAGER_CHOICE: readonly GameId[] = ['slots', 'paigow'];

/** Formats a payout ratio like `3:2` for display. */
export function formatOdds(multiplier: number): string {
	// Reduce to the nearest common ratio so 1.5 reads as "3:2" rather than "1.5:1".
	const table: Array<[number, string]> = [
		[40, '40:1'],
		[35, '35:1'],
		[17, '17:1'],
		[11, '11:1'],
		[10, '10:1'],
		[8, '8:1'],
		[5, '5:1'],
		[4, '4:1'],
		[3, '3:1'],
		[2, '2:1'],
		[1.5, '3:2'],
		[1, '1:1'],
	];
	for (const [value, label] of table) {
		if (Math.abs(multiplier - 1 - value) < 1e-9) return label;
	}
	return `${multiplier}:1`;
}

// ---------------------------------------------------------------------------
// Cards — shared representation so the client can render without game knowledge
// ---------------------------------------------------------------------------

export type Suit = 's' | 'h' | 'd' | 'c';

export interface CardView {
	/** Rank 1-13, where 1 is Ace. */
	rank: number;
	suit: Suit;
}

export const SUIT_GLYPH: Record<Suit, string> = {
	s: '♠',
	h: '♥',
	d: '♦',
	c: '♣',
};

export const RANK_LABEL: Record<number, string> = {
	/** The joker, dealt only in Pai Gow Poker. */
	0: 'Joker',
	1: 'A',
	2: '2',
	3: '3',
	4: '4',
	5: '5',
	6: '6',
	7: '7',
	8: '8',
	9: '9',
	10: '10',
	11: 'J',
	12: 'Q',
	13: 'K',
};

export function cardLabel(card: CardView): string {
	if (card.rank === 0) return 'Joker';
	return `${RANK_LABEL[card.rank]}${SUIT_GLYPH[card.suit]}`;
}

// ---------------------------------------------------------------------------
// Wagers — the player's choice of how to stake, made before any randomness
// ---------------------------------------------------------------------------

export type RouletteBet =
	| { kind: 'straight'; number: number }
	| { kind: 'red' }
	| { kind: 'black' }
	| { kind: 'odd' }
	| { kind: 'even' }
	| { kind: 'low' }
	| { kind: 'high' }
	| { kind: 'dozen'; dozen: 1 | 2 | 3 }
	| { kind: 'column'; column: 1 | 2 | 3 };

/** Chips on one spot. A roulette wager is any number of these on different spots. */
export interface RouletteChip {
	bet: RouletteBet;
	amount: number;
}

export type BaccaratBet = {
	main: 'player' | 'banker' | 'tie';
	/** Optional pair side bet on the same deal. */
	pair?: 'player' | 'banker' | 'either';
	/** Chips on the pair side bet. Defaults to matching the main bet. */
	pairAmount?: number;
};

/** One wager shape: a roll of two six-sided dice that comes in under `target`. */
export type DiceBet = { kind: 'roll_under'; target: number };

export type CoinFlipBet = { side: 'heads' | 'tails' };

/** Ultimate Texas Hold'em: the Blind always matches the ante. */
export type UltimateBet = {
	ante: number;
	/** Optional Trips side bet. */
	trips?: number;
};

export type ThreeCardBet = {
	ante: number;
	/** Optional Pair Plus side bet. */
	pairPlus?: number;
};

/**
 * A wager is tagged by game so the engine can dispatch to the right module and
 * the client can render the right picker without a parallel lookup table.
 */
export type Wager =
	/** `trilux` is the optional TriLux side bet on the first two cards and the dealer's up card. */
	| { game: 'blackjack'; trilux?: number }
	| { game: 'roulette'; bets: RouletteChip[] }
	| { game: 'baccarat'; bet: BaccaratBet }
	| { game: 'coinflip'; bet: CoinFlipBet }
	| { game: 'dice'; bet: DiceBet }
	| { game: 'slots' }
	| { game: 'threecard'; bet: ThreeCardBet }
	| { game: 'ultimate'; bet: UltimateBet }
	| { game: 'paigow' };

export type AnyGameState = unknown;

// ---------------------------------------------------------------------------
// In-game view — a game-specific payload describing what to draw
// ---------------------------------------------------------------------------

export interface HandView {
	cards: CardView[];
	/** Best total, already accounting for Ace as 1 or 11. */
	total: number;
	isSoft: boolean;
	/** True when the last card is face down; `total` is then meaningless. */
	hidden?: boolean;
	/** Chips on this hand, set for blackjack where hands carry separate bets. */
	bet?: number;
	/** True once this hand was doubled down. */
	doubled?: boolean;
}

/**
 * A game's renderable state.
 *
 * Every variant carries `resolved`, set by the server. The client must never
 * infer it from the contents of the view — a roulette ball landing on 0 looks
 * identical to an unspun wheel otherwise.
 */
export interface GameViewBase {
	/** True once the outcome is fixed and no further game actions are legal. */
	resolved: boolean;
}

export type GameView = GameViewBase &
	(
		| {
				game: 'blackjack';
				/** The hand currently being played (the last one once resolved). */
				player: HandView;
				/** Every player hand; more than one after a split. */
				hands: HandView[];
				/** Index into `hands` of the hand awaiting action. */
				active: number;
				canDouble: boolean;
				canSplit: boolean;
				/** Cost of insurance while it is on offer (dealer shows an ace), else null. */
				insuranceOffer: number | null;
				/** Chips placed on insurance, 0 if none. */
				insured: number;
				/** True when the round ended on the deal itself, before the player decided anything. */
				opening: boolean;
				dealer: HandView;
				/**
				 * The TriLux side bet, settled on the deal: chips on it, the poker hand
				 * it made (null if none), and the profit odds paid (0 on a loss).
				 */
				trilux: { bet: number; hand: string | null; pays: number } | null;
		  }
		| { game: 'roulette'; number: number; color: 'red' | 'black' | 'green'; won: boolean }
		| {
				game: 'baccarat';
				player: HandView;
				banker: HandView;
				outcome: 'player' | 'banker' | 'tie';
				playerPair: boolean;
				bankerPair: boolean;
		  }
		| { game: 'coinflip'; result: 'heads' | 'tails'; won: boolean }
		| { game: 'dice'; roll: number; dice: number[]; won: boolean }
		| {
				game: 'slots';
				/** Symbol indices by reel, three rows each. */
				reels: number[][];
				/** Row indices of winning paylines. */
				lines: number[];
				/** Profit multiplier summed across paylines. */
				win: number;
		  }
		| {
				game: 'threecard';
				hand: HandView;
				rank: string;
				/** The dealer's hand and rank, shown once the player has played. Null otherwise. */
				dealer: HandView | null;
				dealerRank: string | null;
				dealerQualifies: boolean | null;
				folded: boolean;
		  }
		| {
				game: 'ultimate';
				hand: HandView;
				/** Community cards revealed so far: none, the flop, then all five. */
				board: HandView;
				stage: 'preflop' | 'flop' | 'river' | 'showdown';
				/** Raises open to the player right now, as multiples of the ante. */
				raises: number[];
				/** Chips on the Play bet, 0 until the player raises. */
				play: number;
				/** The player's best hand with the cards showing. */
				rank: string;
				/** Shown only at showdown. */
				dealer: HandView | null;
				dealerRank: string | null;
				dealerQualifies: boolean | null;
				folded: boolean;
		  }
		| {
				game: 'paigow';
				/** The player's seven cards, in a fixed order the SET_HAND indices refer to. */
				hand: HandView;
				/** Indices into `hand` the house way would put in the low hand. */
				houseWay: number[];
				/**
				 * Every legal way to set the hand, with both hands named, so the board
				 * can name a split as it is picked without ranking hands itself. A pick
				 * missing from this list would put the low hand above the high hand.
				 * Empty once the hand is played.
				 */
				splits: { low: number[]; highRank: string; lowRank: string }[];
				/** Set once the hand is played. */
				player: PaiGowSplit | null;
				dealer: PaiGowSplit | null;
				/** Per hand: 1 player wins, -1 dealer wins (ties go to the dealer). */
				results: { high: 1 | -1; low: 1 | -1 } | null;
		  }
	);

/** A Pai Gow seven split into a five-card high hand and a two-card low hand. */
export interface PaiGowSplit {
	high: HandView;
	low: HandView;
	highRank: string;
	lowRank: string;
}

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

export type Phase =
	/** No round open, waiting for a bet. */
	| 'betting'
	/** A game has been chosen for this round; the player is picking how to wager. */
	| 'choosing'
	/** The round is live and accepting game actions. */
	| 'in_game'
	/** A winning round with rounds left — doubling is on the table. */
	| 'don_offer'
	/** Run over, waiting for a name. */
	| 'finished'
	/** On the leaderboard. */
	| 'submitted';

export interface RoundResult {
	round: number;
	game: GameId;
	bet: number;
	/** Total returned to the player, stake included. 0 means a total loss. */
	returned: number;
	net: number;
	/** True when this round was played as a Double or Nothing. */
	doubled: boolean;
	/** Player-facing summary, e.g. "Blackjack! 3:2". */
	detail: string;
	/** The finished board, so the result screen can show how the round ended. */
	view: GameView | null;
}

export interface RunState {
	chips: number;
	round: number;
	phase: Phase;
	/** Game ids already played this run, so all five rounds are distinct. */
	played: GameId[];
	history: RoundResult[];
	/**
	 * The game the next round will be, drawn before the bet so the player knows
	 * what they are staking on. Null whenever a round is open or the run is over.
	 */
	upcoming: GameId | null;
	/**
	 * The round in progress.
	 *
	 * `wager` is always populated: `beginRound` seeds it with the game's
	 * default so the client never has to duplicate engine knowledge. Sending a
	 * `WAGER` replaces it and is also what commits the round.
	 *
	 * `state` and `view` are null during `choosing`, before the wager is
	 * committed, and during `don_offer`, where the wager is retained so a
	 * double can replay exactly the same bet.
	 */
	current: {
		game: GameId;
		wager: Wager;
		bet: number;
		/** Double or Nothing chain count for this round. */
		doubles: number;
		state: AnyGameState | null;
		view: GameView | null;
	} | null;
	/** Set when the run ended, so the UI can distinguish bust from completion. */
	endedBy: 'bust' | 'complete' | null;
	/**
	 * False for any run after a player's first of the day: it plays normally but
	 * can never be submitted to the leaderboard. Absent on runs saved before this
	 * existed, which count as eligible.
	 */
	eligible: boolean;
	/**
	 * Set on the daily ranked run: the ET day every draw is derived from, so all
	 * ranked players get the same games and outcomes. Null/absent means fully
	 * random (unranked runs, and runs saved before this existed).
	 */
	seed?: string | null;
}

export function initialRunState(): RunState {
	return {
		chips: STARTING_CHIPS,
		round: 1,
		phase: 'betting',
		played: [],
		history: [],
		upcoming: null,
		current: null,
		endedBy: null,
		eligible: true,
		seed: null,
	};
}

// ---------------------------------------------------------------------------
// Client → server actions
// ---------------------------------------------------------------------------

export type Action =
	| { type: 'START' }
	| { type: 'BEGIN_ROUND'; bet: number }
	| { type: 'WAGER'; wager: Wager }
	| { type: 'HIT' }
	| { type: 'STAND' }
	| { type: 'DOUBLE' }
	| { type: 'INSURE' }
	| { type: 'NO_INSURANCE' }
	| { type: 'SPLIT' }
	| { type: 'FLIP' }
	| { type: 'ROLL' }
	| { type: 'SPIN' }
	| { type: 'DEAL' }
	| { type: 'FOLD' }
	| { type: 'PLAY' }
	| { type: 'CHECK' }
	| { type: 'BET_4X' }
	| { type: 'BET_3X' }
	| { type: 'BET_2X' }
	| { type: 'BET_1X' }
	| { type: 'HOUSE_WAY' }
	/** Pai Gow: `low` names the two cards (indices into the dealt hand) for the low hand. */
	| { type: 'SET_HAND'; low: number[] }
	| { type: 'DON_ACCEPT' }
	| { type: 'DON_DECLINE' }
	| { type: 'SUBMIT_NAME'; name: string }
	| { type: 'ABANDON' };

export type ActionType = Action['type'];

// ---------------------------------------------------------------------------
// Server → client payloads
// ---------------------------------------------------------------------------

export interface RunView {
	/** The engine state, or null when there is no live run. */
	run: RunState | null;
	/**
	 * Why the run is gone, if it is: a previous day rolled over (the player is
	 * reset to 1000 chips), or a new run replaced it.
	 */
	resetReason: 'daily' | 'replaced' | null;
	/** Seconds until the next America/New_York midnight. */
	secondsUntilReset: number;
	/** Total stakes wagered across the run, for the summary screen. */
	wagered: number;
	/** Whether a run started now could still reach the leaderboard today. */
	rankedAvailable: boolean;
}

export interface LeaderboardEntry {
	rank: number;
	name: string;
	chips: number;
	day: string;
	/** Absent on the all-time board, which records a bankroll but not a run shape. */
	rounds?: number;
	bust?: boolean;
	achievedAt: number;
}

export interface LeaderboardView {
	scope: 'today' | 'alltime';
	day: string;
	entries: LeaderboardEntry[];
	/** Where the requesting player's own name landed, if anywhere in the top N. */
	you: LeaderboardEntry | null;
}

/** A player's own record across every run they have finished. */
export interface StatsView {
	runs: number;
	busts: number;
	best: { chips: number; day: string } | null;
	/** Average finishing stack, or null before any run is finished. */
	average: number | null;
	/** Chips won or lost in total against a fresh stack each run. */
	netTotal: number;
	/** Consecutive ET days with a finished run, up to today or yesterday. */
	streak: number;
	/** Rounds played per game, best-known first by the game list's order. */
	games: { game: GameId; played: number; won: number; net: number }[];
}

export interface ApiError {
	error: string;
	code:
		| 'invalid_action'
		| 'illegal_action'
		| 'invalid_bet'
		| 'invalid_wager'
		| 'already_submitted'
		| 'name_taken'
		| 'invalid_name'
		| 'not_eligible'
		| 'no_run';
}