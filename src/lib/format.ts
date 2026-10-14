/**
 * Formatting helpers for the client.
 *
 * Mirrors worker/time.ts so the countdown renders identically in both places.
 */

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
/** One square per game played: red loss, grey push, green win. */
export function resultSquares(history: readonly { net: number }[]): string {
	return history.map((r) => (r.net > 0 ? '🟩' : r.net < 0 ? '🟥' : '⬜')).join('');
}
