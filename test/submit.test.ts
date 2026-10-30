/**
 * Score submission: one entry per session per day. The session id outlives the
 * day, so a score submitted yesterday must not block today's.
 */

import { describe, expect, it } from 'vitest';
import { submitScore } from '../worker/db';

interface Row {
	name_key: string;
	day: string;
	run_id: string;
}

/** Just enough D1 for submitScore: a scores table holding (name_key, day, run_id). */
function fakeDb(rows: Row[]): D1Database {
	const statement = (sql: string, args: unknown[] = []) => ({
		bind: (...bound: unknown[]) => statement(sql, bound),
		first: async () => {
			if (sql.includes('run_id = ?1')) {
				// Honour a day condition only if the query has one, as the real table would.
				return rows.find((r) => r.run_id === args[0] && (!sql.includes('day = ?2') || r.day === args[1])) ? { chips: 1 } : null;
			}
			return rows.find((r) => r.day === args[0] && r.name_key === args[1]) ? { id: 1 } : null;
		},
		sql,
		args,
	});
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: { sql: string; args: unknown[] }[]) => {
			const insert = statements.find((s) => s.sql.includes('INSERT INTO scores'))!;
			rows.push({ name_key: insert.args[1] as string, day: insert.args[2] as string, run_id: insert.args[6] as string });
			return [];
		},
	} as unknown as D1Database;
}

const entry = (day: string, name = 'Player') => ({ runId: 'session-1', name, day, chips: 1200, roundsPlayed: 5, bust: false });

describe('submitScore', () => {
	it('accepts a session\'s score on a new day after it submitted on an earlier one', async () => {
		const rows: Row[] = [];
		const db = fakeDb(rows);
		expect(await submitScore(db, entry('2026-10-23'))).toEqual({ ok: true });
		expect(await submitScore(db, entry('2026-10-25'))).toEqual({ ok: true });
		expect(rows).toHaveLength(2);
	});

	it('still refuses a second score from the same session on the same day', async () => {
		const db = fakeDb([]);
		expect(await submitScore(db, entry('2026-10-25'))).toEqual({ ok: true });
		expect(await submitScore(db, entry('2026-10-25', 'Other'))).toEqual({ ok: false, reason: 'already_submitted' });
	});
});
