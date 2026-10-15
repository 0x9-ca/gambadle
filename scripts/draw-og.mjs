// Renders scripts/og.html to the 1200x630 social card (Open Graph and Twitter), public/og.png.
//
// Usage: node scripts/draw-og.mjs [out.png]
//
//   OG_FONTS=<dir holding Roboto-Regular/Medium/Bold/Black/BlackItalic .woff2>
//       renders in Roboto; without it the browser's fallback font is used and the
//       title will not look right.
//   CHROMIUM_PATH=<chromium or headless shell>
//       if the default under ~/.cache/ms-playwright is not where it lives.
//
// Re-run it after changing the page, then commit the PNG.
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] || fileURLToPath(new URL('../public/og.png', import.meta.url));
const executablePath =
	process.env.CHROMIUM_PATH ||
	join(homedir(), '.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell');

const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });

if (process.env.OG_FONTS) {
	const dir = process.env.OG_FONTS;
	const face = (weight, style, file) =>
		`@font-face{font-family:Roboto;font-weight:${weight};font-style:${style};src:url(data:font/woff2;base64,${readFileSync(
			join(dir, file)
		).toString('base64')}) format("woff2")}`;
	const css = [
		face(400, 'normal', 'Roboto-Regular.woff2'),
		face(500, 'normal', 'Roboto-Medium.woff2'),
		face(700, 'normal', 'Roboto-Bold.woff2'),
		face(900, 'normal', 'Roboto-Black.woff2'),
		face(900, 'italic', 'Roboto-BlackItalic.woff2'),
	].join('\n');
	await page.addInitScript((text) => {
		const add = () => {
			const style = document.createElement('style');
			style.textContent = text;
			(document.head || document.documentElement).appendChild(style);
		};
		if (document.documentElement) add();
		else document.addEventListener('DOMContentLoaded', add);
	}, css);
}

page.on('pageerror', (error) => {
	throw error;
});
await page.goto(new URL('./og.html', import.meta.url).href);
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out });
await browser.close();
console.log(`wrote ${out}`);
