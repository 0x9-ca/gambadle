/**
 * Just enough D1 over node:sqlite to run the Worker's routes against the real
 * schema: prepare/bind/first/all/run and batch (as one transaction).
 *
 * Every call yields to the event loop before touching the database, the way a
 * round trip to D1 does, so concurrent requests interleave as they would in
 * production. `onQuery` lets a test act between statements (move the clock,
 * say).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export interface FakeD1 {
	db: D1Database;
	sqlite: DatabaseSync;
	onQuery: ((sql: string) => void) | null;
}

const yieldOnce = () => new Promise<void>((resolve) => setImmediate(resolve));

export function fakeD1(): FakeD1 {
	const sqlite = new DatabaseSync(':memory:');
	const dir = join(import.meta.dirname, '../../migrations');
	for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		sqlite.exec(readFileSync(join(dir, file), 'utf8'));
	}

	const fake: FakeD1 = { db: null as unknown as D1Database, sqlite, onQuery: null };

	const exec = (sql: string, args: unknown[]) => {
		fake.onQuery?.(sql);
		const statement = sqlite.prepare(sql);
		const params = args as SQLInputValue[];
		if (/\bRETURNING\b|^\s*SELECT/i.test(sql)) {
			const results = statement.all(...params).map((row) => ({ ...row }));
			return { results, meta: { changes: 0 } };
		}
		const info = statement.run(...params);
		return { results: [], meta: { changes: Number(info.changes) } };
	};

	const statement = (sql: string, args: unknown[] = []) => ({
		sql,
		args,
		bind: (...bound: unknown[]) => statement(sql, bound),
		first: async () => {
			await yieldOnce();
			return exec(sql, args).results[0] ?? null;
		},
		all: async () => {
			await yieldOnce();
			return exec(sql, args);
		},
		// Writes take a few turns longer than reads, so two requests started
		// together both read before either writes, as a real race would.
		run: async () => {
			for (let i = 0; i < 5; i++) await yieldOnce();
			return exec(sql, args);
		},
	});

	fake.db = {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: { sql: string; args: unknown[] }[]) => {
			await yieldOnce();
			sqlite.exec('BEGIN');
			try {
				const results = statements.map((s) => exec(s.sql, s.args));
				sqlite.exec('COMMIT');
				return results;
			} catch (error) {
				sqlite.exec('ROLLBACK');
				throw error;
			}
		},
	} as unknown as D1Database;
	return fake;
}
