# AGENTS.md

This repo is **Gambadle**: a Cloudflare Worker + React/Vite client for a 5-round gambling minigame run with daily reset and leaderboard.

Use this file as the working contract for any coding agent.

---

## 1) Product/Runtime Snapshot

- **Domain:** `gamba.0x9.ca`
- **Runtime:** Cloudflare Workers
- **DB:** D1 (`env.DB`)
- **Frontend:** React + Vite + TypeScript (`src/`)
- **Server game logic:** `worker/` (authoritative; client is display-only)
- **Games:** blackjack (with the TriLux side bet), roulette, baccarat, coinflip, dice, slots, three card poker, Ultimate Texas Hold'em, Pai Gow Poker, Mega Slots (5×5, 40 lines, ~92% RTP; math in shared/megaslots.ts), Video Poker (8/5 Jacks or Better, 97.30%), Craps (pass/don't pass, free odds, Field)

Core invariant: **all outcomes and chip movements are server-side only**.

---

## 2) Architecture Map

- `worker/index.ts` — HTTP API entrypoint
- `worker/engine.ts` — run state machine (phases, round flow, DoN)
- `worker/games/*.ts` — per-game implementations via shared `GameHandler` contract
- `worker/session.ts` — signed session cookie handling (`gambadle_sid`)
- `worker/time.ts` — ET day logic and reset countdown
- `worker/db.ts` — D1 persistence
- `worker/stats.ts` — personal stats, summarized from `run_results` (one row per finished run, per session)
- `worker/daily.ts` — `GET /api/daily`: today's ranked runs compared (everyone ranked gets the same games and outcomes); aggregates only, never another player's run
- `shared/protocol.ts` — shared API/game types and run model
- `src/components/Practice.tsx` — staging's practice menu / bar (see "Staging")
- `shared/games.ts` — shared constants/paytables/ranges
- `src/components/*` — rendering only; must not invent game state

---

## 3) State/Flow Invariants (Do Not Break)

- Session resume is server-backed; refresh/device switching must keep run state.
- Daily reset is **implicit by ET day mismatch** (not in-memory timers).
- `Outcome` values are absolute chips:
  - `stake` = chips removed
  - `returned` = chips credited back (includes stake on wins/pushes)
- Engine settles as: `chips = chips - stake + returned`.
- `round.history[].net` is source-of-truth delta (`returned - stake`).
- `view.resolved` is server-controlled; client must not infer it.

---

## 4) Critical Game Rules / Historical Footguns

### Roulette
- Payout function returns **profit odds** (`35`, `2`, `1`, or `0`).
- Returned chips on settle must be:
  - win: `bet * (1 + profitOdds)`
  - loss: `0`

### Baccarat
- Uses baccarat totals (A=1, 2-9 face, 10/J/Q/K=0), modulo 10.
- Naturals (8/9 opening) end coup immediately.
- Player/Banker bets **push on tie**.
- Banker draw table must match punto banco rules.
- Either Pair odds are intentionally `5:1`.
- A coup with nothing left to decide (a natural, or both hands standing on 6/7) settles inside `init`, with no `DEAL` step; the view's `opening` flag tells the board to deal all four cards in. Any other coup waits for `DEAL`.

### Blackjack
- Dealer stands on all 17s.
- Dealer hole card and total are hidden until action resolves.
- Blackjack pays 3:2 via integer chips (`Math.floor((stake * 3) / 2)`).

### Dice
- Single wager shape: `{ kind: 'roll_under', target }`.
- Roll is 2d6 (total 2-12); win rule is `total <= target`, priced from exact combination counts.
- Target bounds from `shared/games.ts`.

### Slots and Mega Slots
- A round is five spins (`SLOT_SPINS`), all dealt by the one `SPIN` (so the round is still a single roll for the daily seed). The player picks the bet **per spin** on the bet screen; the engine's stake is five times it, so a slot stake is always a multiple of five (`fitStake`/`slotStake`: rounded down, at least 5, which is also why `canPlay` needs 5 chips). Double or Nothing offers a multiple of five too. The return is the sum of the spins divided by five, rounded once; the per-chip RTP is unchanged (`test/slots.test.ts`, `test/megaslots.test.ts`).
- Slots: board is 3 reels × 3 rows; paylines: top/middle/bottom row matches only. Mega Slots: each of the five paid spins carries its own free spins.
- The view is `spins` (slots) / `rounds` (Mega Slots) plus `perSpin` and `total`; the boards play the spins one after another from `lib/slotsTimeline.ts` / `lib/megaTimeline.ts`, which `lib/reveal.ts` also reads.

### Three Card Poker
- Ante controls main stake; play bet matches ante.
- Fold stake is ante (+ pairPlus if present), not ante*2.
- Pair Plus settles independently.

---

### Craps
- Multi-roll, but every roll is dealt in `init` (`CRAPS_MAX_ROLLS`), because each action runs under the *same* seeded generator: rolling inside `apply` would deal the identical roll every time. The view only ever shows the rolls taken so far.
- `stake` = line bet + odds + Field. The stack must cover the most odds could add at deal time (`CRAPS_MAX_ODDS`), so an all-in round bets a third of the stack. Odds profit rounds down to whole chips; `test/craps.test.ts` computes the house edge exactly (1.41% pass, 1.36% don't pass, odds add none).

### Video Poker
- 8/5 Jacks or Better. The whole deck is shuffled in `init` and replacements are the next cards in order, so the hold choice never changes what is dealt. `VP_PAYS` are total returns (a pair of jacks returns the bet). `test/videopoker.test.ts` enumerates every hand and hold (about 27 s) and must land on the published 97.30%.

### Daily seed (ranked runs)
- A session's first run of the day is ranked and carries `run.seed` (the ET day); every ranked player gets the same games and outcomes. Unranked runs have no seed and use the CSPRNG.
- The engine's `draw(run, label, fn)` wraps each game call in a generator seeded from `secret|day|label` (secret = `daily-seed|SESSION_SECRET`, passed to `applyAction`, never stored on the run). Labels name the draw (`game:<round>`, `r<round>:d<doubles>:init|apply`), so nothing is carried between requests.
- Rules: games must draw randomness only through `worker/rng`, and only in `init` or a single-roll `apply` (card games draw from the shoe shuffled in `init`). A new random draw anywhere else, or one that depends on the player's choices, breaks "same for everyone"; `test/engine.test.ts` ("daily seed") guards this.
- Ranked-ness is decided by the atomic `recordRunStart` count before the run is built.

---

## 4b) Staging (https://gamba-stg.0x9.ca)

- A separate Worker (`gambadle-staging`), D1 database (`gambadle-staging`) and `SESSION_SECRET`, defined as `env.staging` in `wrangler.jsonc` (`STAGING=1`). Production data is never touched.
- It plays **practice runs**: `START_TEST {game}` (refused with 403 unless `STAGING`) starts a run with `run.testGame`, 1000 chips, no seed, not eligible. The engine keeps queuing that one game, has no last round (it ends only when the stack can't open the game) and keeps just the newest board in `history`. "Reset" is `START_TEST` again, "Change game" is `ABANDON`.
- No ranking, stats or leaderboard: `/api/leaderboard`, `/api/stats`, `/api/daily` and `SUBMIT_NAME` answer 404, no run result is recorded, and the client (`RunView.staging`) hides those panels and the round pips.
- `./deploy-staging.sh` builds with `CLOUDFLARE_ENV=staging` and deploys. `npm run test:e2e:staging` plays a round of every game against a local staging build.

## 5) Style / Conventions

- TypeScript with tabs and single quotes.
- Keep comments focused on **why**, not obvious mechanics.
- Prefer small pure helpers over branching in UI components.
- Keep client as a projection of server state.

---

## 6) Commands

```bash
# typecheck
npx tsc -b

# tests
npx vitest run

# regenerate the link-preview image (public/og.png) after editing scripts/og.html;
# OG_FONTS = a dir of Roboto .woff2 files (Regular/Medium/Bold/Black/BlackItalic), else a fallback font is used
OG_FONTS=<dir> node scripts/draw-og.mjs

# browser smoke test: plays whole runs at phone size until every game has
# come up; fails on page errors, stuck screens or sideways overflow
# (screenshots in test/e2e/output; set CHROMIUM_PATH if needed)
npm run test:e2e

# deploy (typecheck, tests, build, D1 migrations, deploy)
./deploy.sh

# staging site (practice mode); same steps, own Worker and database
./deploy-staging.sh
npm run test:e2e:staging
```

If modifying game math/state transitions, run full tests, not a subset.

---

## 7) Testing Guidance

- `test/games.test.ts` is the broad payout/rules safety net.
- `test/engine.test.ts` checks state machine and run invariants.
- `test/slots.test.ts` includes exact-enumeration RTP checks.
- `test/time.test.ts` covers ET reset/countdown behavior.

When changing payouts/rules, update tests to match explicit product decisions; do not “tune until green” without understanding expected math.

---

## 8) Deployment Notes

- Wrangler deploy uses redirected config from `.wrangler/deploy/config.json`.
- Assets are built from `dist/client`.
- Worker route is custom domain `gamba.0x9.ca` (staging: `gamba-stg.0x9.ca`).

---

## 9) Agent Workflow Expectations

Before editing:
1. Read relevant shared types/constants first (`shared/protocol.ts`, `shared/games.ts`).
2. Verify server/client assumptions line up.

Before finishing:
1. `npx tsc -b`
2. `npx vitest run`
3. If asked to deploy, `npx wrangler deploy` and report version ID.
