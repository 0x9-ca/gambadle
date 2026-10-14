/**
 * Browser smoke test: plays whole runs through the real app, at phone size.
 *
 * Starts the Vite dev server (which runs the Worker and a local D1 through the
 * Cloudflare plugin), then drives headless Chromium the way a player would,
 * clicking through every screen until each game has come up at least once.
 * A game counts as covered once a round of it has been played to the end.
 * It fails on:
 *   - any page error or console error;
 *   - a screen with nothing to press for too long (a stuck flow);
 *   - a page wider than the phone (something overflowing sideways);
 *   - a game never coming up within the run budget.
 * One screenshot per distinct screen goes to test/e2e/output (git-ignored).
 *
 * Usage: npm run test:e2e
 * CHROMIUM_PATH points at a Chromium or headless shell if the default is wrong.
 */

import { spawn, execSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'test', 'e2e', 'output');
const PORT = 5298;
const BASE = `http://localhost:${PORT}`;
const MAX_RUNS = 25;
/** How long a screen may offer nothing to press: a reveal plays out first, and a Mega Slots free-spin round takes about 13 seconds. */
const STUCK_MS = 16_000;
const GAMES = ['blackjack', 'roulette', 'baccarat', 'coinflip', 'dice', 'slots', 'threecard', 'ultimate', 'paigow', 'megaslots', 'videopoker', 'craps'];

const failures = [];
const fail = (message) => {
	failures.push(message);
	console.log(`FAIL ${message}`);
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

execSync('npx wrangler d1 migrations apply gambadle --local', { cwd: root, stdio: 'ignore' });
const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
	cwd: root,
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

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

const executablePath =
	process.env.CHROMIUM_PATH ??
	join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 390, height: 640 } });
page.on('pageerror', (error) => fail(`page error: ${error.message}`));
page.on('console', (message) => {
	if (message.type() === 'error') fail(`console error: ${message.text()}`);
});

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await page.goto(BASE);
await page.waitForSelector('.panel');

/** Buttons a player would press next, best first. */
const PRIORITY = [
	'Start an unranked run',
	'Start a run',
	'Play again',
	'Place',
	'Ante',
	'Line bet',
	'Go to the table',
	'Rebet',
	'Confirm',
	'Spin with',
	'No insurance',
	'Stand',
	'Check',
	'Bet 1x',
	'Set hand',
	'Play',
	'Deal',
	'Spin',
	'Take 2',
	'Roll',
	'Roll again',
	'Draw',
	'Flip',
	'Keep it',
	'Start over instead',
];

const seenGames = new Set();
// The daily comparison should show on a ranked run's end screen (the first run of the session).
let sawDaily = false;
const seenScreens = new Set();
let shots = 0;
let runsStarted = 0;
let lastProgress = Date.now();
let lastPhase;

const state = () => page.evaluate(() => fetch('/api/state').then((r) => r.json()));

while (runsStarted <= MAX_RUNS && seenGames.size < GAMES.length) {
	const view = await state();
	const run = view.run;
	// A game counts once a round of it has been played to the end.
	for (const entry of run?.history ?? []) seenGames.add(entry.game);

	// Roulette's table: place a chip on red unless a spread is already down.
	if ((await page.locator('.roulette-grid').count()) > 0 && (await page.locator('.spot-row').count()) === 0) {
		const rebet = page.locator('button:visible', { hasText: 'Rebet' });
		if ((await rebet.count()) > 0) await rebet.first().click();
		else await page.locator('.choice:visible', { hasText: 'Red' }).first().click();
	}

	const buttons = page.locator('button:visible:enabled');
	const texts = (await buttons.allTextContents()).map((t) => t.trim());
	const index = PRIORITY.map((want) => texts.findIndex((t) => t.startsWith(want))).find((i) => i >= 0);

	if (index === undefined) {
		if (Date.now() - lastProgress > STUCK_MS) {
			fail(`stuck: nothing to press (phase ${run?.phase}, game ${run?.current?.game ?? run?.upcoming}, buttons: ${texts.join(' | ')})`);
			await page.screenshot({ path: join(out, 'stuck.png'), fullPage: true });
			break;
		}
		await page.waitForTimeout(250);
		continue;
	}

	// One screenshot per distinct screen, after its animations have settled.
	const key = `${run?.phase}:${run?.current?.game ?? run?.upcoming ?? 'none'}:${texts.join(',')}`;
	if (!seenScreens.has(key)) {
		seenScreens.add(key);
		await page.waitForTimeout(1200);
		// A new screen starts at the top (read before the screenshot, which can move the page): the long ones (the roulette table) leave the page
		// scrolled down, and the board would otherwise sit above the top edge.
		if (run?.phase !== lastPhase) {
			const scrolled = await page.evaluate(() => Math.round(window.scrollY));
			if (lastPhase !== undefined && scrolled > 2) fail(`a new screen opened scrolled ${scrolled}px down (${key})`);
			lastPhase = run?.phase;
		}
		await page.screenshot({
			path: join(out, `${String(shots++).padStart(3, '0')}-${run?.current?.game ?? run?.upcoming ?? 'home'}.png`),
			fullPage: true,
		});
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
		if (overflow > 1) fail(`page is ${overflow}px wider than the screen (${key})`);
	}

	// Looked for after the screen has settled: the panel loads on its own.
	if (!sawDaily && (await page.locator('.daily').count()) > 0) {
		sawDaily = true;
		await page.locator('.daily').screenshot({ path: join(out, 'daily.png') });
	}

	const label = texts[index];
	if (label.startsWith('Start a') || label.startsWith('Play again')) runsStarted++;
	await buttons.nth(index).click();
	lastProgress = Date.now();
	await page.waitForTimeout(150);
}

// After a finished run the player's stats panel should be there, and open.
await page.waitForTimeout(1500);
if ((await page.locator('.stats').count()) === 0) {
	fail('no stats panel after finishing runs');
} else {
	await page.locator('.stats__summary').click();
	await page.waitForTimeout(300);
	if ((await page.locator('.stats__games tbody tr').count()) === 0) fail('stats panel lists no games');
	await page.locator('.stats').screenshot({ path: join(out, 'stats.png') });
}

if (!sawDaily) fail('the daily comparison never showed on a ranked run\'s end screen');
const daily = await page.evaluate(() => fetch('/api/daily').then((r) => r.json()));
if (!daily.you || daily.rounds.length === 0) fail(`/api/daily had no ranked run for this player: ${JSON.stringify(daily)}`);

for (const game of GAMES) {
	if (!seenGames.has(game)) fail(`${game} never came up in ${MAX_RUNS} runs`);
}

await browser.close();
stopServer();

console.log(
	`${failures.length === 0 ? 'PASS' : 'FAIL'}: ${runsStarted} runs, ${seenGames.size}/${GAMES.length} games, ${seenScreens.size} screens, ${failures.length} failures`
);
process.exit(failures.length === 0 ? 0 : 1);
