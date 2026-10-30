/**
 * Browser test of the staging deployment's practice mode, plus the five-spin
 * slot machines (the practice menu is the quick way to get either).
 *
 * Starts the dev server in the `staging` wrangler environment (STAGING=1, its
 * own local D1), then plays one round of every game from the menu: each starts
 * on 1000 chips, resets to 1000 on demand, and nothing is ranked, recorded or
 * shown on a leaderboard. Screenshots go to test/e2e/output-staging.
 *
 *   node test/e2e/staging.mjs      (CHROMIUM_PATH points at a Chromium if the default is wrong)
 */

import { execSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'test', 'e2e', 'output-staging');
const PORT = 5299;
const BASE = `http://localhost:${PORT}`;
const GAMES = {
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
/** A round with free spins can take most of a minute to play out. */
const ROUND_MS = 90_000;

const failures = [];
const fail = (message) => {
	failures.push(message);
	console.log(`FAIL ${message}`);
};
const check = (ok, message) => {
	if (!ok) fail(message);
};

execSync('npx wrangler d1 migrations apply gambadle-staging --local --env staging', { cwd: root, stdio: 'ignore' });
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
	cwd: root,
	env: { ...process.env, CLOUDFLARE_ENV: 'staging' },
	detached: true,
	stdio: ['ignore', 'pipe', 'pipe'],
});
const stopServer = () => {
	try {
		process.kill(-server.pid);
	} catch {
		// Already gone.
	}
};
process.on('exit', stopServer);
await new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('dev server did not start')), 60_000);
	server.stdout.on('data', (chunk) => {
		if (String(chunk).includes(String(PORT))) {
			clearTimeout(timer);
			resolve();
		}
	});
	server.on('exit', (code) => reject(new Error(`dev server exited (${code})`)));
});

const executablePath =
	process.env.CHROMIUM_PATH ??
	join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 760 } });
page.on('pageerror', (error) => fail(`page error: ${error.message}`));
page.on('console', (message) => {
	if (message.type() === 'error') fail(`console error: ${message.text()}`);
});
page.on('response', (response) => {
	if (response.status() === 404) console.log(`  404: ${response.url()}`);
});
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const state = () => page.evaluate(() => fetch('/api/state').then((r) => r.json()));
const post = (action) =>
	page.evaluate(
		(body) => fetch('/api/action', { method: 'POST', body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() })),
		action
	);
/** Waits until the server's run satisfies `ok`: the header lags a result by its reveal, so it cannot say. */
async function waitForRun(ok, what) {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const { run } = await state();
		if (ok(run)) return run;
		await page.waitForTimeout(150);
	}
	fail(`timed out waiting for ${what}`);
	return (await state()).run;
}
const shot = (name) => page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
const pressed = async (label) => {
	await page.locator('button:visible:enabled', { hasText: label }).first().click();
};

const PRIORITY = ['Place', 'Ante', 'Line bet', 'Go to the table', 'Rebet', 'Confirm', 'Spin with', 'No insurance', 'Stand', 'Check', 'Bet 1x', 'Set hand', 'Play', 'Deal', 'Spin', 'Take 2', 'Roll', 'Roll again', 'Draw', 'Flip', 'Keep it'];

/** Presses whatever comes next until one more round has settled; resolves to the run. */
async function playOneRound() {
	const before = (await state()).run.history.length;
	const deadline = Date.now() + ROUND_MS;
	while (Date.now() < deadline) {
		const run = (await state()).run;
		if (run.history.length > before && ['betting', 'don_offer', 'finished'].includes(run.phase)) return run;
		if ((await page.locator('.roulette-grid').count()) > 0 && (await page.locator('.spot-row').count()) === 0) {
			const rebet = page.locator('button:visible', { hasText: 'Rebet' });
			if ((await rebet.count()) > 0) await rebet.first().click();
			else await page.locator('.choice:visible', { hasText: 'Red' }).first().click();
		}
		const buttons = page.locator('button:visible:enabled');
		const texts = (await buttons.allTextContents()).map((t) => t.trim());
		const index = PRIORITY.map((want) => texts.findIndex((t) => t.startsWith(want))).find((i) => i >= 0);
		if (index === undefined) await page.waitForTimeout(250);
		else {
			await buttons.nth(index).click();
			await page.waitForTimeout(150);
		}
	}
	fail('a round never settled');
	return (await state()).run;
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

await page.goto(BASE);
await page.waitForSelector('h1:has-text("Gambadle staging")');
check((await page.locator('h1', { hasText: 'Gambadle staging' }).count()) === 1, 'the practice menu is the start screen');
check((await page.locator('.choice').count()) === Object.keys(GAMES).length, 'the menu lists every game');
check((await page.locator('.stats, .leaderboard').count()) === 0, 'no stats or leaderboard panel on staging');
check((await page.locator('.topbar__tag', { hasText: 'Staging' }).count()) === 1, 'the header says Staging');
await shot('menu');

const first = await state();
check(first.staging === true && first.rankedAvailable === false, '/api/state reports staging and nothing ranked');
for (const path of ['/api/leaderboard', '/api/stats', '/api/daily']) {
	// Through the request API, not the page, so the expected 404 is not a console error.
	const status = (await page.request.get(BASE + path)).status();
	check(status === 404, `${path} is not available on staging (got ${status})`);
}

// ---------------------------------------------------------------------------
// Every game, from a fresh 1000
// ---------------------------------------------------------------------------

for (const [game, label] of Object.entries(GAMES)) {
	await page.locator('.choice', { hasText: new RegExp(`^${label}$`) }).click();
	let run = await waitForRun((r) => r?.testGame === game, `${game} to start`);
	check(run.testGame === game && run.chips === 1000 && run.upcoming === game, `${game}: starts on 1000 chips with that game`);
	check(run.eligible === false && !run.seed, `${game}: not ranked or seeded`);
	check((await page.locator('.pips').count()) === 0, `${game}: no round pips in practice`);

	if (game === 'slots' || game === 'megaslots') {
		// The bet is per spin; the stake is five times it.
		const field = page.locator('input[aria-label="Bet per spin"]');
		check((await field.count()) === 1, `${game}: asks for the bet per spin`);
		await field.fill('7');
		await field.blur();
		await page.locator('button', { hasText: 'Place 7 a spin · 35 chips in all' }).waitFor({ timeout: 3000 }).catch(() => fail(`${game}: button does not state 7 a spin and 35 in all`));
		await shot(`${game}-bet`);
		await pressed('Place 7 a spin');
		await page.waitForFunction(() => /\d spins at/.test(document.body.textContent ?? ''));
		run = (await state()).run;
		check(run.current?.bet === 35, `${game}: the stake is five times the bet per spin (got ${run.current?.bet})`);
		await shot(`${game}-ready`);
	}

	run = await playOneRound();
	check(run.history.length === 1 && run.history[0].game === game, `${game}: one round recorded`);
	check(run.chips === 1000 + run.history[0].net, `${game}: the stack follows the result`);
	if (game === 'slots' || game === 'megaslots') {
		check(run.history[0].bet === 35, `${game}: the round staked 35`);
		const view = run.history[0].view;
		const spins = game === 'slots' ? view.spins : view.rounds;
		check(spins.length === 5 && view.perSpin === 7, `${game}: five spins at 7`);
		// Midway through the reveal the board is still on an early spin.
		await page.waitForTimeout(500);
		await shot(`${game}-reveal`);
		await page.waitForSelector('.result__headline', { timeout: ROUND_MS });
		await shot(`${game}-result`);
	}

	// Reset: back to 1000 on the same game, history gone.
	await page.locator('button', { hasText: 'Reset to 1,000' }).first().click();
	run = await waitForRun((r) => r?.history.length === 0, `${game} to reset`);
	check(run.chips === 1000 && run.history.length === 0 && run.testGame === game, `${game}: reset returns to 1000 on the same game`);

	// Change game: back to the menu.
	await page.locator('button', { hasText: 'Change game' }).first().click();
	await page.waitForSelector('h1:has-text("Gambadle staging")');
	check((await state()).run === null, `${game}: changing game clears the run`);
}

// ---------------------------------------------------------------------------
// Staging refuses what it does not do
// ---------------------------------------------------------------------------

await page.locator('.choice', { hasText: /^Dice$/ }).click();
await waitForRun((r) => r?.testGame === 'dice', 'dice to start');
const cookies = await page.context().cookies();
const submit = await page.request.post(BASE + '/api/action', {
	data: { type: 'SUBMIT_NAME', name: 'testuser' },
	headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') },
});
check(submit.status() === 404, `names cannot be submitted on staging (got ${submit.status()})`);

const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check(overflow <= 1, `page is ${overflow}px wider than the screen`);

await browser.close();
stopServer();
console.log(`${failures.length === 0 ? 'PASS' : 'FAIL'}: ${Object.keys(GAMES).length} games, ${failures.length} failures`);
process.exit(failures.length === 0 ? 0 : 1);
