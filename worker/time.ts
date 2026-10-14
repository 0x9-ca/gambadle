/**
 * America/New_York day arithmetic.
 *
 * The whole daily-reset mechanism rests on this module. A run is stamped with
 * the ET day it started on; when that day no longer matches "today", the run is
 * simply void. That makes the reset implicit — it happens the moment a player
 * returns after midnight, with no scheduler involved and no DST edge cases.
 */

export const ET_TIMEZONE = 'America/New_York';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Formatters are cached: constructing an Intl.DateTimeFormat is far more
 * expensive than calling format(), and this runs on every request.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-CA', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		formatters.set(timeZone, f);
	}
	return f;
}

interface DayParts {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/** Calendar fields for an instant, as seen in America/New_York. */
function partsAt(instantMs: number): DayParts {
	const parts = formatterFor(ET_TIMEZONE).formatToParts(new Date(instantMs));
	const get = (type: Intl.DateTimeFormatPartTypes): number => {
		const found = parts.find((p) => p.type === type);
		return found ? Number(found.value) : 0;
	};
	return {
		year: get('year'),
		month: get('month'),
		day: get('day'),
		// '24' is emitted for midnight under some hour cycles; normalise it.
		hour: get('hour') % 24,
		minute: get('minute'),
		second: get('second'),
	};
}

/**
 * The current calendar date in America/New_York, as 'YYYY-MM-DD'.
 *
 * `en-CA` formats dates as YYYY-MM-DD, which sorts lexicographically and is
 * directly usable as a SQLite TEXT key.
 */
export function etDay(now: Date = new Date()): string {
	return etDayAt(now.getTime());
}

export function etDayAt(instantMs: number): string {
	const p = partsAt(instantMs);
	return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * Milliseconds until the next midnight in America/New_York.
 *
 * Midnight ET is 04:00 UTC under daylight saving and 05:00 UTC otherwise, and
 * on the two transition days per year the local day is 23 or 25 hours long. So
 * the remaining time cannot be derived from a fixed 24-hour day.
 *
 * Instead: hop forward an hour at a time (at most 26 hops) to bracket the hour
 * containing the rollover, then binary-search that hour down to the minute.
 * Costs ~30 format calls instead of scanning all 1440 minutes.
 */
export function msUntilNextEtMidnight(now: Date = new Date()): number {
	const start = now.getTime();
	const startDay = etDayAt(start);

	// Phase 1: find the hour boundary that crosses into the next ET day.
	let low = start;
	let high = start;
	let found = false;
	for (let i = 1; i <= 26; i++) {
		high = start + i * HOUR_MS;
		if (etDayAt(high) !== startDay) {
			found = true;
			break;
		}
		low = high;
	}
	if (!found) return HOUR_MS;

	// Phase 2: binary search [low, high] to the minute.
	while (high - low > MINUTE_MS) {
		const mid = low + Math.floor((high - low) / 2 / MINUTE_MS) * MINUTE_MS;
		if (mid <= low) break; // guard against stalling on a sub-minute interval
		if (etDayAt(mid) !== startDay) {
			high = mid;
		} else {
			low = mid;
		}
	}
	return high - start;
}

export function secondsUntilReset(now: Date = new Date()): number {
	return Math.max(0, Math.ceil(msUntilNextEtMidnight(now) / 1000));
}

/** Formats a duration in seconds as 'H:MM:SS', or 'M:SS' under an hour. */
export function formatCountdown(totalSeconds: number): string {
	const s = Math.max(0, Math.floor(totalSeconds));
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor((s % 3600) / 60);
	const seconds = s % 60;
	const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
	return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}