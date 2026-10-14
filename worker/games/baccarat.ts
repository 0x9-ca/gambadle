/**
 * Baccarat — eight decks, standard punto banco.
 *
 * Two cards each to Player and Banker. A total of 8 or 9 on either opening hand
 * is a natural and ends the coup immediately — nobody draws a third card.
 * Otherwise Player draws on 0-5 and stands on 6 and above, and Banker follows
 * the tableau, which depends on what Player drew.
 *
 * Payouts: Player 1:1, Banker 1:1 less 5% commission, Tie 8:1, P/B pair 11:1,
 * Either Pair 5:1. Player and Banker bets push on a tie. Measured over an
 * exact enumeration of the shoe those prices come out at 1.24%, 1.06% and 14.4%
 * house edge, with 10.36% on the pair side bets — see BACCARAT_ODDS.
 *
 * When the opening four cards leave nothing to decide (a natural on either side,
 * or both hands standing on 6 or 7) the coup is settled by the deal itself and
 * there is no Deal step. Otherwise the player presses Deal to see the third cards.
 *
 * Player may take a main bet plus one optional pair side bet on the same deal,
 * sized independently of the main bet.
 */

import { BACCARAT_ODDS, BACCARET_COMMISSION } from '../../shared/games';
import type { Action, BaccaratBet, GameView, HandView, Wager } from '../../shared/protocol';
import { type Card, type Shoe, draw, newShoe, toView } from './cards';
import { GameError, type GameHandler, type Step } from './types';

const DECKS = 8;
/** A 5% cut of a winning banker bet, rounded up to a whole chip. */
const BANKER_COMMISSION = BACCARET_COMMISSION;

interface BaccaratState {
	bet: number;
	wager: BaccaratBet;
	shoe: Shoe;
	player: Card[];
	banker: Card[];
	playerPair: boolean;
	bankerPair: boolean;
	done: boolean;
	/** Whether the player pressed Deal, as opposed to the deal settling the coup. Absent on older states. */
	acted?: boolean;
}

/**
 * Baccarat hand total: Aces are one, 2-9 are face value, and 10/J/Q/K are worth
 * nothing. Totals run 0-9, because only the last digit of the sum ever counts.
 *
 * This is deliberately not `handTotal` from ./cards, which is blackjack's rule
 * where a face card is worth ten. Reusing it here made every two-card hand read
 * ten high and shifted the whole outcome distribution.
 */
function handTotal(cards: readonly Card[]): number {
	let total = 0;
	for (const card of cards) total += drawValue(card);
	while (total > 9) total -= 10;
	return total;
}

function handView(cards: readonly Card[]): HandView {
	// A hand total in baccarat has no soft form: an ace is always one.
	return { cards: cards.map(toView), total: handTotal(cards), isSoft: false };
}

/**
 * The value of a Player third card for the Banker's draw decision:
 * Ace counts 1, 2-9 count face value, and 10/J/Q/K count 0 ("no draw").
 */
function drawValue(card: Card): number {
	if (card.rank === 1) return 1;
	return card.rank >= 10 ? 0 : card.rank;
}

/** An opening total of 8 or 9 is a natural and ends the coup at once. */
function isNatural(total: number): boolean {
	return total >= 8;
}

/**
 * Decides whether Player draws a third card.
 *
 * Player stands on 6 and above, which includes the naturals — though a natural
 * ends the coup before this is ever consulted.
 */
function shouldPlayerDraw(playerTotal: number): boolean {
	return playerTotal <= 5;
}

/**
 * Decides whether Banker draws a third card, by the standard punto banco
 * tableau.
 *
 * When Player stood, Banker has no third card to consult and simply follows
 * Player's own rule: draw on 0-5, stand on 6 and up.
 *
 * When Player did draw, the decision keys off the value of that card, where a
 * 10/J/Q/K counts as 0. Note the two rows that are easy to get wrong: on a 3 the
 * banker draws unless Player drew exactly an 8, and on a 6 the banker draws on a
 * 6 *or* a 7, not just a 7.
 */
function shouldBankerDraw(
	bankerTotal: number,
	playerDrew: boolean,
	playerThird: number | null
): boolean {
	if (bankerTotal >= 7) return false;
	if (!playerDrew) return bankerTotal <= 5;
	if (bankerTotal <= 2) return true;
	if (bankerTotal === 3) return playerThird !== 8;
	if (bankerTotal === 4) return playerThird !== null && playerThird >= 2 && playerThird <= 7;
	if (bankerTotal === 5) return playerThird !== null && playerThird >= 4 && playerThird <= 7;
	if (bankerTotal === 6) return playerThird === 6 || playerThird === 7;
	return false;
}

/**
 * Whether a third card can still be drawn: not after a natural, and not when
 * Player stands (6 or 7) and Banker stands with it, since Banker then follows
 * Player's own rule. When this is false the opening four cards settle the coup.
 */
function hasDraw(player: readonly Card[], banker: readonly Card[]): boolean {
	const playerTotal = handTotal(player);
	const bankerTotal = handTotal(banker);
	if (isNatural(playerTotal) || isNatural(bankerTotal)) return false;
	return shouldPlayerDraw(playerTotal) || shouldBankerDraw(bankerTotal, false, null);
}

function validate(bet: BaccaratBet): BaccaratBet {
	if (bet.main !== 'player' && bet.main !== 'banker' && bet.main !== 'tie') {
		throw new GameError('invalid_wager', 'main bet must be player, banker or tie');
	}
	const normalized: BaccaratBet = { main: bet.main };
	if (bet.pair !== undefined) {
		if (bet.pair !== 'player' && bet.pair !== 'banker' && bet.pair !== 'either') {
			throw new GameError('invalid_wager', 'pair bet must be player, banker or either');
		}
		normalized.pair = bet.pair;
	}
	return normalized;
}

function view(s: BaccaratState): GameView {
	const playerTotal = handTotal(s.player);
	const bankerTotal = handTotal(s.banker);
	return {
		game: 'baccarat',
		resolved: s.done,
		player: handView(s.player),
		banker: handView(s.banker),
		outcome: playerTotal === bankerTotal ? 'tie' : playerTotal > bankerTotal ? 'player' : 'banker',
		playerPair: s.playerPair,
		bankerPair: s.bankerPair,
		opening: s.done && !s.acted,
	};
}

export const baccarat: GameHandler = {
	id: 'baccarat',
	title: 'Baccarat',

	parseWager(wager: Wager, bet: number, stack: number): Wager {
		if (wager.game !== 'baccarat') {
			throw new GameError('invalid_wager', 'not a baccarat wager');
		}
		const normalized = validate(wager.bet);
		if (normalized.pair !== undefined) {
			// The side bet is sized separately and defaults to matching the main bet.
			const amount = wager.bet.pairAmount ?? bet;
			if (!Number.isInteger(amount) || amount < 1) {
				throw new GameError('invalid_wager', 'pair side bet must be a whole number of chips');
			}
			// The stack has to cover both. Checked here because the engine commits
			// the wager before anything is dealt, which is the only point the engine
			// can still refuse it.
			if (bet + amount > stack) {
				throw new GameError('invalid_wager', 'main bet and pair side bet exceed your stack');
			}
			normalized.pairAmount = amount;
		}
		return { game: 'baccarat', bet: normalized };
	},

	init(wager: Wager, bet: number): Step {
		if (wager.game !== 'baccarat') {
			throw new GameError('invalid_wager', 'not a baccarat wager');
		}
		const shoe = newShoe(DECKS);
		const state: BaccaratState = {
			bet,
			wager: wager.bet,
			shoe,
			// Player is dealt first, then Banker — the real dealing order.
			player: [draw(shoe), draw(shoe)],
			banker: [draw(shoe), draw(shoe)],
			playerPair: false,
			bankerPair: false,
			done: false,
		};

		// Pairs are read off the opening two cards only.
		state.playerPair = state.player[0]!.rank === state.player[1]!.rank;
		state.bankerPair = state.banker[0]!.rank === state.banker[1]!.rank;

		// Nothing left to decide: settle now rather than ask for a pointless Deal.
		// The cards drawn are the same either way, so the game is unchanged.
		if (!hasDraw(state.player, state.banker)) {
			state.done = true;
			return settle(state);
		}

		return { state, view: view(state), outcome: null };
	},

	legalActions(state: unknown): Array<'DEAL'> {
		const s = state as BaccaratState;
		return s.done ? [] : ['DEAL'];
	},

	apply(state: unknown, action: Action): Step {
		const s = state as BaccaratState;
		if (action.type !== 'DEAL') {
			throw new GameError('invalid_action', 'baccarat only accepts DEAL');
		}
		if (s.done) {
			throw new GameError('illegal_action', 'this hand is already dealt');
		}
		s.done = true;
		s.acted = true;

		// Third cards are drawn here rather than in init(), so the player sees
		// the opening two and gets a beat before the hand resolves.
		//
		// A natural on either side ends the coup immediately. This is not a
		// shortcut: a natural is worth about a third of all hands, and leaving it
		// out was enough on its own to turn a Banker-favoured game into a
		// Player-favoured one.
		const openingPlayer = handTotal(s.player);
		const openingBanker = handTotal(s.banker);
		if (isNatural(openingPlayer) || isNatural(openingBanker)) {
			return settle(s);
		}

		let playerThird: number | null = null;
		if (shouldPlayerDraw(handTotal(s.player))) {
			const card = draw(s.shoe);
			playerThird = drawValue(card);
			s.player.push(card);
		}
		if (shouldBankerDraw(handTotal(s.banker), playerThird !== null, playerThird)) {
			s.banker.push(draw(s.shoe));
		}

		return settle(s);
	},

	view,
};

function settle(s: BaccaratState): Step {
	const playerTotal = handTotal(s.player);
	const bankerTotal = handTotal(s.banker);
	const result: 'player' | 'banker' | 'tie' =
		playerTotal === bankerTotal ? 'tie' : playerTotal > bankerTotal ? 'player' : 'banker';

	// The pair side bet is a second stake on the table, so both have to be
	// reported as at risk.
	const stake = s.bet;
	const pairBet = s.wager.pair === undefined ? 0 : (s.wager.pairAmount ?? stake);
	const totalStake = stake + pairBet;

	let returned = 0;
	const notes: string[] = [];

	// Main bet. Player and Banker push on a tie; the Tie bet loses on either side
	// winning. Pushing is what keeps their house edge near 1% — charging a full
	// loss on ties would roughly triple it, because ties land once in ten hands.
	switch (s.wager.main) {
		case 'player':
			if (result === 'tie') {
				returned += stake;
				notes.push('Tie — push');
			} else if (result === 'player') {
				returned += stake * (1 + BACCARAT_ODDS.player);
				notes.push('Player wins');
			}
			break;
		case 'banker':
			if (result === 'tie') {
				returned += stake;
				notes.push('Tie — push');
			} else if (result === 'banker') {
				// Commission rounds up: rounding down charges nothing on bets under 20
				// chips, which turns Banker (about 1% house edge) into a player edge.
				const profit = Math.floor(stake * BACCARAT_ODDS.banker) - Math.ceil(stake * BANKER_COMMISSION);
				returned += stake + profit;
				notes.push('Banker wins less 5% commission');
			}
			break;
		case 'tie':
			if (result === 'tie') {
				returned += stake * (1 + BACCARAT_ODDS.tie);
				notes.push(`Tie pays ${BACCARAT_ODDS.tie}:1`);
			}
			break;
	}

	// Optional pair side bet, decided on the original two cards only, so it
	// settles independently of the main bet and of any push.
	if (s.wager.pair !== undefined) {
		const p = s.wager.pair;
		const hit =
			p === 'player' ? s.playerPair : p === 'banker' ? s.bankerPair : s.playerPair || s.bankerPair;
		if (hit) {
			const odds =
				p === 'either' ? BACCARAT_ODDS.eitherPair : p === 'player' ? BACCARAT_ODDS.playerPair : BACCARAT_ODDS.bankerPair;
			returned += pairBet * (1 + odds);
			notes.push(`${p === 'either' ? 'Either pair' : `${p} pair`} pays ${odds}:1`);
		}
	}

	const outcomeLabel =
		result === 'tie' ? `Tie ${playerTotal}` : `${result === 'player' ? 'Player' : 'Banker'} ${Math.max(playerTotal, bankerTotal)}`;

	return {
		state: s,
		view: view(s),
		outcome: {
			stake: totalStake,
			returned,
			detail: notes.length > 0 ? `${outcomeLabel} — ${notes.join(', ')}` : outcomeLabel,
		},
	};
}