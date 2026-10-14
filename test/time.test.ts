/**
 * The ET clock — the whole daily reset hangs off it.
 *
 * The reset is implicit: a run carries the ET day it started on, and any run
 * whose day is not today is void. That only works if `etDayAt` is exactly right,
 * including on the two days a year when New York's clocks move, and if the
 * countdown lands on the real rollover minute rather than 24 hours later.
 */

import { describe, expect, it } from 'vitest';
import {
	ET_TIMEZONE,
	etDayAt,
	formatCountdown,
	msUntilNextEtMidnight,
	secondsUntilReset,
} from '../worker/time';

/** '2026-03-08T07:00:00Z' — midnight ET on the spring-forward day. */
const SPRING_FORWARD_2026 = Date.UTC(2026, 2, 8, 7, 0, 0);
/** '2026-11-01T06:00:00Z' — midnight ET on the fall-back day. */
const FALL_BACK_2026 = Date.UTC(2026, 10, 1, 6, 0, 0);

describe('etDayAt', () => {
	it('reads the ET calendar date, not UTC', () => {
		// 03:30 UTC on the 3rd is still the 2nd in New York.
		expect(etDayAt(Date.UTC(2026, 0, 3, 3, 30))).toBe('2026-01-02');
		expect(etDayAt(Date.UTC(2026, 0, 3, 5, 0))).toBe('2026-01-03');
	});

	it('treats exactly midnight ET as the new day', () => {
		expect(etDayAt(Date.UTC(2026, 5, 15, 4, 0, 0))).toBe('2026-06-15');
		expect(etDayAt(Date.UTC(2026, 5, 15, 3, 59, 59))).toBe('2026-06-14');
	});

	it('rolls over at 05:00 UTC in winter and 04:00 UTC in summer', () => {
		// EST: midnight ET is 05:00 UTC.
		expect(etDayAt(Date.UTC(2027, 0, 10, 4, 59, 59))).toBe('2027-01-09');
		expect(etDayAt(Date.UTC(2027, 0, 10, 5, 0, 0))).toBe('2027-01-10');
		// EDT: midnight ET is 04:00 UTC.
		expect(etDayAt(Date.UTC(2026, 6, 10, 3, 59, 59))).toBe('2026-07-09');
		expect(etDayAt(Date.UTC(2026, 6, 10, 4, 0, 0))).toBe('2026-07-10');
	});

	it('handles the spring-forward day, when the local day is only 23 hours', () => {
		expect(etDayAt(SPRING_FORWARD_2026)).toBe('2026-03-08');
		// 02:00 ET never happens that morning; 06:59 UTC is 01:59 EST.
		expect(etDayAt(Date.UTC(2026, 2, 8, 6, 59))).toBe('2026-03-08');
		// Just before the jump and just after are the same wall-clock minute.
		expect(etDayAt(Date.UTC(2026, 2, 8, 6, 0))).toBe('2026-03-08');
	});

	it('handles the fall-back day, when the local day is 25 hours', () => {
		expect(etDayAt(FALL_BACK_2026)).toBe('2026-11-01');
		// 01:30 ET happens twice; both are the 1st.
		expect(etDayAt(Date.UTC(2026, 10, 1, 5, 30))).toBe('2026-11-01');
		expect(etDayAt(Date.UTC(2026, 10, 1, 6, 30))).toBe('2026-11-01');
	});

	it('pads months and days to two digits so it sorts as text', () => {
		const day = etDayAt(Date.UTC(2026, 8, 3, 12));
		expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(day).toBe('2026-09-03');
	});

	it('produces sortable keys across a year boundary', () => {
		// 19:00 ET on 31 December is still the 31st in New York, five hours
		// after UTC has already rolled over.
		expect(etDayAt(Date.UTC(2027, 0, 1, 0, 0))).toBe('2026-12-31');
		// January is on standard time, so ET midnight is 05:00 UTC.
		expect(etDayAt(Date.UTC(2027, 0, 1, 5, 0))).toBe('2027-01-01');
		expect(etDayAt(Date.UTC(2026, 11, 31, 23, 0))).toBe('2026-12-31');
		expect(etDayAt(Date.UTC(2026, 11, 31, 23, 0)) < etDayAt(Date.UTC(2027, 0, 1, 5, 0))).toBe(true);
	});
});

describe('msUntilNextEtMidnight', () => {
	it('is short just before the rollover', () => {
		// Midnight ET is 04:00 UTC in summer.
		const at = new Date(Date.UTC(2026, 5, 15, 3, 45));
		expect(msUntilNextEtMidnight(at)).toBe(15 * 60_000);
	});

	it('is long just after it', () => {
		const at = new Date(Date.UTC(2026, 5, 15, 4, 1));
		expect(msUntilNextEtMidnight(at)).toBe(24 * 3_600_000 - 60_000);
	});

	it('measures a 23-hour day on the spring-forward date', () => {
		// Local midnight on 8 March 2026, the day the clocks go forward. An hour
		// of it does not exist, so the next midnight is only 23 hours away.
		const at = new Date(Date.UTC(2026, 2, 8, 5, 0));
		expect(msUntilNextEtMidnight(at)).toBe(23 * 3_600_000);
	});

	it('measures a 25-hour day on the fall-back date', () => {
		// Local midnight on 1 November 2026, the day an hour repeats.
		const at = new Date(Date.UTC(2026, 10, 1, 4, 0));
		expect(msUntilNextEtMidnight(at)).toBe(25 * 3_600_000);
	});

	it('always lands within a minute of the true rollover', () => {
		// Sweep the whole year at an awkward interval and check the countdown
		// never drifts more than the minute the search resolves to.
		const start = Date.UTC(2026, 0, 1, 0, 0);
		for (let ms = start; ms < start + 366 * 24 * 3_600_000; ms += 97 * 60_000) {
			const now = new Date(ms);
			const remaining = msUntilNextEtMidnight(now);
			const atRollover = new Date(ms + remaining);
			expect(etDayAt(atRollover.getTime())).not.toBe(etDayAt(ms));
			// One minute earlier must still be the same day, so the search has
			// not overshot past the boundary.
			expect(etDayAt(atRollover.getTime() - 60_000)).toBe(etDayAt(ms));
		}
	});

	it('is positive everywhere in the year', () => {
		const start = Date.UTC(2026, 0, 1, 0, 0);
		for (let ms = start; ms < start + 366 * 24 * 3_600_000; ms += 61 * 60_000) {
			expect(msUntilNextEtMidnight(new Date(ms))).toBeGreaterThan(0);
		}
	});
});

describe('secondsUntilReset', () => {
	it('never reports zero while the day has not yet rolled over', () => {
		// The countdown is what the client shows, so it must not read zero
		// before the reset actually happens.
		const start = Date.UTC(2026, 5, 14, 4, 0);
		for (let ms = start; ms < start + 24 * 3_600_000; ms += 997 * 1000) {
			const now = new Date(ms);
			const seconds = secondsUntilReset(now);
			expect(seconds).toBeGreaterThan(0);
			expect(etDayAt(ms + seconds * 1000)).not.toBe(etDayAt(ms));
		}
	});

	it('rounds up rather than truncating', () => {
		// Whatever the sub-second remainder, the countdown must not land early.
		for (const ms of [1, 250, 500, 750, 999]) {
			const now = new Date(Date.UTC(2026, 5, 15, 3, 0) + ms);
			const seconds = secondsUntilReset(now);
			expect(etDayAt(now.getTime() + (seconds - 1) * 1000)).toBe(etDayAt(now.getTime()));
		}
	});
});

describe('formatCountdown', () => {
	it('drops the hour when there is none', () => {
		expect(formatCountdown(59)).toBe('0:59');
		expect(formatCountdown(600)).toBe('10:00');
		expect(formatCountdown(3599)).toBe('59:59');
	});

	it('keeps the hour when there is one', () => {
		expect(formatCountdown(3600)).toBe('1:00:00');
		expect(formatCountdown(3661)).toBe('1:01:01');
		expect(formatCountdown(86_399)).toBe('23:59:59');
	});

	it('clamps nonsense to zero rather than rendering a negative clock', () => {
		expect(formatCountdown(-5)).toBe('0:00');
		expect(formatCountdown(0)).toBe('0:00');
	});
});

describe('the zone itself', () => {
	it('is America/New_York', () => {
		expect(ET_TIMEZONE).toBe('America/New_York');
	});
});