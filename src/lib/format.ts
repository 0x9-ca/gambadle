/**
 * Formatting helpers for the client.
 *
 * Mirrors worker/time.ts so the countdown renders identically in both places.
 */

import { type GameId, type RoundResult, type RunState, STARTING_CHIPS } from '../../shared/protocol';

const numberFormat = new Intl.NumberFormat('en-US');

/** 12345 -> "12,345" */
export const formatChips = (n: number): string => numberFormat.format(Math.round(n));

/** Signed, for deltas: +250 / -100 / 0 */
export function formatDelta(n: number): string {
	if (n === 0) return '0';
	return `${n > 0 ? '+' : '−'}${numberFormat.format(Math.abs(n))}`;
}

/** "2026-10-03" -> "Oct 3" */
export function formatDay(day: string): string {
	const [y, m, d] = day.split('-').map(Number);
	if (!y || !m || !d) return day;
	return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		timeZone: 'UTC',
	});
}

/** Seconds as 'H:MM:SS', or 'M:SS' under an hour. */
export function formatCountdown(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor((s % 3600) / 60);
	const seconds = s % 60;
	const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
	return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}
/** Short game names for the round summary and the share text. */
export const SHORT_TITLE: Record<GameId, string> = {
	blackjack: 'Blackjack',
	roulette: 'Roulette',
	baccarat: 'Baccarat',
	coinflip: 'Coin Flip',
	dice: 'Dice',
	slots: 'Slots',
	threecard: 'Three Card',
	ultimate: "Hold'em",
	paigow: 'Pai Gow',
	megaslots: 'Mega Slots',
	videopoker: 'Video Poker',
	craps: 'Craps',
};

export interface RoundSummary {
	round: number;
	game: GameId;
	/** Net across the round, a Double or Nothing chain included. */
	net: number;
	/** How many times the round was doubled. */
	doubles: number;
}

/** One entry per round: a Double or Nothing chain adds history entries but is still one round. */
export function roundsOf(history: readonly RoundResult[]): RoundSummary[] {
	const rounds: RoundSummary[] = [];
	for (const entry of history) {
		const last = rounds[rounds.length - 1];
		if (last && last.round === entry.round) {
			last.net += entry.net;
			last.doubles += 1;
		} else {
			rounds.push({ round: entry.round, game: entry.game, net: entry.net, doubles: 0 });
		}
	}
	return rounds;
}

const square = (net: number): string => (net > 0 ? '🟩' : net < 0 ? '🟥' : '⬜');

/**
 * The text a finished run shares: the day, the final stack, then one line per
 * round. Every ranked player gets the same games each day, so the lines line
 * up with anyone else's share from the same day.
 */
export function shareText(run: RunState, origin: string): string {
	const net = run.chips - STARTING_CHIPS;
	const head = `Gambadle${run.seed ? ` ${formatDay(run.seed)}` : ''}${run.seed && run.eligible !== false ? ' · Daily' : ''}`;
	const lines = roundsOf(run.history).map(
		(r) => `${square(r.net)} ${SHORT_TITLE[r.game]} ${formatDelta(r.net)}${r.doubles > 0 ? ` (doubled${r.doubles > 1 ? ` ×${r.doubles}` : ''})` : ''}`
	);
	return [head, `${formatChips(run.chips)} chips (${formatDelta(net)})${run.endedBy === 'bust' ? ' · busted' : ''}`, ...lines, origin].join('\n');
}
