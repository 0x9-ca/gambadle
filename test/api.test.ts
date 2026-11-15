/**
 * The Worker's routes end to end, against the real schema in node:sqlite.
 *
 * These cover what only shows up with a database in the loop: requests racing
 * on one run, a request that spans midnight, and what the leaderboard records.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialRunState, type RunState, type RunView } from '../shared/protocol';
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
async function seedFinishedRun(id: string, history: RunState['history']): Promise<void> {
	const run: RunState = {
		...initialRunState(),
		phase: 'finished',
		endedBy: 'complete',
		chips: 1500,
		round: 5,
		history,
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
