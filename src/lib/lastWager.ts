/**
 * The last wager placed on each game, remembered on this device so the next
 * round of that game starts from it: side bets keep their size, roulette
 * offers to put the same spread back, and so on.
 *
 * Only a starting point. Amounts are trimmed to what the current bet and stack
 * allow, and the server validates whatever is finally sent.
 */

import { DICE_MAX_TARGET, DICE_MIN_TARGET, UTH_MAX_ANTES } from '../../shared/games';
import type { GameId, RouletteChip, Wager } from '../../shared/protocol';

const KEY = 'gambadle:last-wagers';

type Saved = Partial<Record<GameId, Wager>>;

function load(): Saved {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		return parsed && typeof parsed === 'object' ? (parsed as Saved) : {};
	} catch {
		return {};
	}
}

export function saveWager(wager: Wager): void {
	try {
		localStorage.setItem(KEY, JSON.stringify({ ...load(), [wager.game]: wager }));
	} catch {
		// Storage can be blocked (private mode); the next round just starts fresh.
	}
}

/** A whole number of chips from 0 to `max`, or 0 for anything unusable. */
const chips = (value: unknown, max: number): number =>
	typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), max)) : 0;

/**
 * The remembered wager for `game`, refitted to this round's bet and stack, or
 * null if there is none (roulette is offered separately, see `lastSpread`).
 */
export function restoreWager(game: GameId, bet: number, stack: number): Wager | null {
	const saved = load()[game];
	if (!saved || saved.game !== game) return null;
	switch (saved.game) {
		case 'blackjack': {
			const trilux = chips(saved.trilux, stack - bet);
			return trilux > 0 ? { game: 'blackjack', trilux } : { game: 'blackjack' };
		}
		case 'threecard': {
			const pairPlus = chips(saved.bet?.pairPlus, stack - bet * 2);
			return { game: 'threecard', bet: pairPlus > 0 ? { ante: bet, pairPlus } : { ante: bet } };
		}
		case 'ultimate': {
			const trips = chips(saved.bet?.trips, stack - bet * UTH_MAX_ANTES);
			return { game: 'ultimate', bet: trips > 0 ? { ante: bet, trips } : { ante: bet } };
		}
		case 'baccarat': {
			const main = saved.bet?.main;
			if (main !== 'player' && main !== 'banker' && main !== 'tie') return null;
			const pair = saved.bet.pair;
			const pairAmount = chips(saved.bet.pairAmount ?? bet, stack - bet);
			if ((pair === 'player' || pair === 'banker' || pair === 'either') && pairAmount >= 1) {
				return { game: 'baccarat', bet: { main, pair, pairAmount } };
			}
			return { game: 'baccarat', bet: { main } };
		}
		case 'coinflip': {
			const side = saved.bet?.side;
			return side === 'heads' || side === 'tails' ? { game: 'coinflip', bet: { side } } : null;
		}
		case 'dice': {
			const target = saved.bet?.target;
			if (typeof target !== 'number') return null;
			return {
				game: 'dice',
				bet: { kind: 'roll_under', target: Math.min(Math.max(Math.round(target), DICE_MIN_TARGET), DICE_MAX_TARGET) },
			};
		}
		default:
			return null;
	}
}

/**
 * The last roulette spread, scaled down evenly if it is more than `limit` (a
 * spot that would round to nothing is dropped), or null if there is none.
 */
export function lastSpread(limit: number): RouletteChip[] | null {
	const saved = load().roulette;
	if (!saved || saved.game !== 'roulette' || !Array.isArray(saved.bets)) return null;
	const bets = saved.bets.filter(
		(c): c is RouletteChip => !!c && typeof c.amount === 'number' && c.amount >= 1 && !!c.bet && typeof c.bet.kind === 'string'
	);
	const total = bets.reduce((sum, c) => sum + c.amount, 0);
	if (total < 1 || limit < 1) return null;
	if (total <= limit) return bets;
	const scaled = bets
		.map((c) => ({ ...c, amount: Math.floor((c.amount * limit) / total) }))
		.filter((c) => c.amount >= 1);
	return scaled.length > 0 ? scaled : null;
}
