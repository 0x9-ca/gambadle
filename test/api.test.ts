/**
 * The Worker's routes end to end, against the real schema in node:sqlite.
 *
 * These cover what only shows up with a database in the loop: requests racing
 * on one run, a request that spans midnight, and what the leaderboard records.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialRunState, type LeaderboardView, type RunState, type RunView } from '../shared/protocol';
import { deleteRun, getRun, putRun } from '../worker/db';
import worker from '../worker/index';
import { signCookieValue } from '../worker/session';
import { type FakeD1, fakeD1 } from './helpers/d1';

const SECRET = 'test-secret';
const SESSION = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';

/** 2026-10-03, midday and the last instant in New York (EDT, UTC-4). */
const MIDDAY = new Date('2026-10-03T16:00:00Z');
const LAST_INSTANT = new Date('2026-10-04T03:59:59.990Z');
const NEXT_DAY = new Date('2026-10-04T16:00:00Z');

let d1: FakeD1;
let env: Env;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(MIDDAY);
	d1 = fakeD1();
	env = { DB: d1.db, SESSION_SECRET: SECRET } as unknown as Env;
});

afterEach(() => {
	vi.useRealTimers();
});

async function cookie(id = SESSION): Promise<string> {
	return `gambadle_sid=${encodeURIComponent(await signCookieValue(id, SECRET))}`;
}

async function call(path: string, body?: unknown, id = SESSION): Promise<Response> {
	const request = new Request(`https://gamba.test${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { Cookie: await cookie(id), 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return worker.fetch(request as never, env);
}

const action = (body: unknown, id = SESSION) => call('/api/action', body, id);

/** A finished ranked run saved straight into the table. */
async function seedFinishedRun(id: string, history: RunState['history'], extra: Partial<RunState> = {}): Promise<void> {
	const run: RunState = {
		...initialRunState(),
		phase: 'finished',
		endedBy: 'complete',
		chips: 1500,
		round: 5,
		history,
		...extra,
	};
	await putRun(d1.db, { id, day: '2026-10-03', phase: run.phase, state: run, name: null });
}

const entry = (round: number): RunState['history'][number] => ({
	round,
	game: 'coinflip',
	bet: 100,
	returned: 200,
	net: 100,
	doubled: false,
	detail: 'Heads',
	view: null,
});

describe('requests racing on one run', () => {
	it('lets only one of two simultaneous actions through', async () => {
		expect((await action({ type: 'START' })).status).toBe(200);
		const [a, b] = await Promise.all([
			action({ type: 'BEGIN_ROUND', bet: 10 }),
			action({ type: 'BEGIN_ROUND', bet: 10 }),
		]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		const state = (await (await call('/api/state')).json()) as RunView;
		expect(state.run?.phase).toBe('choosing');
	});

	it('records one score when one session submits two names at once', async () => {
		await seedFinishedRun(SESSION, [entry(1)]);
		const [a, b] = await Promise.all([
			action({ type: 'SUBMIT_NAME', name: 'Alice' }),
			action({ type: 'SUBMIT_NAME', name: 'Bobby' }),
		]);
		expect([a.status, b.status].sort()).toEqual([200, 409]);
		const scores = d1.sqlite.prepare('SELECT name FROM scores').all();
		const best = d1.sqlite.prepare('SELECT name FROM alltime_best').all();
		expect(scores).toHaveLength(1);
		expect(best).toHaveLength(1);
		expect(best[0]!.name).toBe(scores[0]!.name);
	});
});

describe('the day boundary', () => {
	it('does not carry a run into the next day when a request spans midnight', async () => {
		vi.setSystemTime(LAST_INSTANT);
		expect((await action({ type: 'START' })).status).toBe(200);
		// Midnight passes while the run is being read.
		d1.onQuery = (sql) => {
			if (sql.includes('FROM runs WHERE id')) vi.setSystemTime(NEXT_DAY);
		};
		await action({ type: 'BEGIN_ROUND', bet: 10 });
		d1.onQuery = null;
		const state = (await (await call('/api/state')).json()) as RunView;
		expect(state.run).toBeNull();
		expect(state.resetReason).toBe('daily');
	});

	it('voids only the stale day\'s row, never a newer one', async () => {
		await putRun(d1.db, { id: SESSION, day: '2026-10-03', phase: 'betting', state: initialRunState() });
		await deleteRun(d1.db, SESSION, '2026-10-02');
		expect(await getRun(d1.db, SESSION)).not.toBeNull();
	});

	it('does not mark a stranger with yesterday\'s name as you, or carry the name into today', async () => {
		vi.setSystemTime(new Date('2026-10-02T16:00:00Z'));
		await putRun(d1.db, { id: SESSION, day: '2026-10-02', phase: 'submitted', state: initialRunState(), name: 'Bob' });
		vi.setSystemTime(MIDDAY);
		// Someone else is Bob today.
		await seedFinishedRun(OTHER, [entry(1)]);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Bob' }, OTHER)).status).toBe(200);

		const board = (await (await call('/api/leaderboard?scope=today')).json()) as { you: unknown };
		expect(board.you).toBeNull();

		await putRun(d1.db, { id: SESSION, day: '2026-10-03', phase: 'betting', state: initialRunState(), name: null });
		expect((await getRun(d1.db, SESSION))?.name).toBeNull();
	});
});

describe('the leaderboard', () => {
	it('counts rounds, not Double or Nothing links, as rounds played', async () => {
		await seedFinishedRun(SESSION, [entry(1), { ...entry(1), doubled: true }, entry(2)]);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Alice' })).status).toBe(200);
		const row = d1.sqlite.prepare('SELECT rounds_played FROM scores').get();
		expect(row?.rounds_played).toBe(2);
	});
});

describe('leaderboard ties', () => {
	const THIRD = '00000000-0000-4000-8000-000000000003';
	const board = async (scope: 'today' | 'alltime') =>
		((await (await call(`/api/leaderboard?scope=${scope}`)).json()) as LeaderboardView).entries.map((e) => [e.rank, e.name]);

	it('ranks equal stacks by who finished first, not who submitted first', async () => {
		const t = MIDDAY.getTime();
		// Bob finished first but submits last; Cara finished last and submits first.
		await seedFinishedRun(SESSION, [entry(1)], { finishedAt: t - 3000 });
		await seedFinishedRun(OTHER, [entry(1)], { finishedAt: t - 2000 });
		await seedFinishedRun(THIRD, [entry(1)], { finishedAt: t - 1000 });
		vi.setSystemTime(t + 1000);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Cara' }, THIRD)).status).toBe(200);
		vi.setSystemTime(t + 2000);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Abe' }, OTHER)).status).toBe(200);
		vi.setSystemTime(t + 3000);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Bob' })).status).toBe(200);
		const expected = [
			[1, 'Bob'],
			[2, 'Abe'],
			[3, 'Cara'],
		];
		expect(await board('today')).toEqual(expected);
		expect(await board('alltime')).toEqual(expected);
	});

	it('stamps the finish time when a played run ends, and keeps it through a later submit', async () => {
		// The last round, one coin flip from the end of the run, win or lose.
		const run: RunState = { ...initialRunState(), round: 5, upcoming: 'coinflip', played: ['dice', 'slots', 'craps', 'roulette'] };
		await putRun(d1.db, { id: SESSION, day: '2026-10-03', phase: run.phase, state: run, name: null });
		expect((await action({ type: 'BEGIN_ROUND', bet: 10 })).status).toBe(200);
		const choosing = (await (await call('/api/state')).json()) as RunView;
		expect((await action({ type: 'WAGER', wager: choosing.run!.current!.wager })).status).toBe(200);
		const done = (await (await action({ type: 'FLIP' })).json()) as RunView;
		expect(done.run?.phase).toBe('finished');
		expect(done.run?.finishedAt).toBe(MIDDAY.getTime());
		expect(d1.sqlite.prepare('SELECT finished_at FROM run_results').get()?.finished_at).toBe(MIDDAY.getTime());

		vi.setSystemTime(MIDDAY.getTime() + 60_000);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Dee' })).status).toBe(200);
		expect({ ...d1.sqlite.prepare('SELECT finished_at, submitted_at FROM scores').get() }).toEqual({
			finished_at: MIDDAY.getTime(),
			submitted_at: MIDDAY.getTime() + 60_000,
		});
	});

	it('falls back to the recorded run result for a run saved before the stamp', async () => {
		await seedFinishedRun(SESSION, [entry(1)]);
		d1.sqlite
			.prepare('INSERT INTO run_results (session_id, day, ranked, chips, bust, rounds, finished_at) VALUES (?, ?, 1, 1500, 0, ?, ?)')
			.run(SESSION, '2026-10-03', '[]', 1234);
		expect((await action({ type: 'SUBMIT_NAME', name: 'Eve' })).status).toBe(200);
		expect(d1.sqlite.prepare('SELECT finished_at FROM scores').get()?.finished_at).toBe(1234);
		expect(d1.sqlite.prepare('SELECT achieved_at FROM alltime_best').get()?.achieved_at).toBe(1234);
	});
});

describe('the session cookie', () => {
	it('treats a mangled cookie as no session rather than failing', async () => {
		const request = new Request('https://gamba.test/api/state', { headers: { Cookie: 'gambadle_sid=%E0%A4%A' } });
		const response = await worker.fetch(request as never, env);
		expect(response.status).toBe(200);
	});

	// The session carries the one-ranked-run-a-day rule and the stats streak,
	// so it has to outlive the day, and keep going while the player plays.
	it('lasts beyond a day and is renewed on every action', async () => {
		const maxAge = (response: Response) => Number(/Max-Age=(\d+)/.exec(response.headers.get('Set-Cookie') ?? '')?.[1] ?? 0);
		const start = await action({ type: 'START' });
		expect(maxAge(start)).toBeGreaterThan(7 * 86_400);
		const next = await action({ type: 'BEGIN_ROUND', bet: 10 });
		expect(next.headers.get('Set-Cookie')).toContain(encodeURIComponent(await signCookieValue(SESSION, SECRET)));
		expect(maxAge(next)).toBeGreaterThan(7 * 86_400);
	});
});

describe('migration 0005 (score finish times)', () => {
	it('backfills from the ranked run result, else from submitted_at, and moves the all-time record with it', async () => {
		const { DatabaseSync } = await import('node:sqlite');
		const { readdirSync, readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const dir = join(import.meta.dirname, '../migrations');
		const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
		const db = new DatabaseSync(':memory:');
		for (const file of files.filter((f) => f < '0005')) db.exec(readFileSync(join(dir, file), 'utf8'));

		const score = db.prepare(
			`INSERT INTO scores (name, name_key, day, chips, rounds_played, bust, run_id, submitted_at) VALUES (?, ?, '2026-10-03', 1500, 5, 0, ?, ?)`
		);
		score.run('Ann', 'ann', 'a', 900);
		score.run('Ben', 'ben', 'b', 800);
		db.prepare(`INSERT INTO run_results (session_id, day, ranked, chips, bust, rounds, finished_at) VALUES ('a', '2026-10-03', 1, 1500, 0, '[]', 500)`).run();
		// An unranked result is never the submitted run.
		db.prepare(`INSERT INTO run_results (session_id, day, ranked, chips, bust, rounds, finished_at) VALUES ('b', '2026-10-03', 0, 1500, 0, '[]', 100)`).run();
		db.prepare(`INSERT INTO alltime_best (name_key, name, best_day, best_chips, achieved_at) VALUES ('ann', 'Ann', '2026-10-03', 1500, 900)`).run();

		db.exec(readFileSync(join(dir, files.find((f) => f.startsWith('0005'))!), 'utf8'));
		expect(db.prepare('SELECT run_id, finished_at FROM scores ORDER BY run_id').all().map((r) => ({ ...r }))).toEqual([
			{ run_id: 'a', finished_at: 500 },
			{ run_id: 'b', finished_at: 800 },
		]);
		expect(db.prepare('SELECT achieved_at FROM alltime_best').get()?.achieved_at).toBe(500);
	});
});
