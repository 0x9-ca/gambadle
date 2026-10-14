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
- **Games:** blackjack (with the TriLux side bet), roulette, baccarat, coinflip, dice, slots, three card poker, Ultimate Texas Hold'em, Pai Gow Poker, Mega Slots (5×5, 40 lines, ~92% RTP; math in shared/megaslots.ts)

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
- `shared/protocol.ts` — shared API/game types and run model
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

### Blackjack
- Dealer stands on all 17s.
- Dealer hole card and total are hidden until action resolves.
- Blackjack pays 3:2 via integer chips (`Math.floor((stake * 3) / 2)`).

### Dice
- Single wager shape: `{ kind: 'roll_under', target }`.
- Roll is 2d6 (total 2-12); win rule is `total <= target`, priced from exact combination counts.
- Target bounds from `shared/games.ts`.

### Slots
- Board is 3 reels × 3 rows.
- Paylines: top/middle/bottom row matches only.

### Three Card Poker
- Ante controls main stake; play bet matches ante.
- Fold stake is ante (+ pairPlus if present), not ante*2.
- Pair Plus settles independently.

---

### Daily seed (ranked runs)
- A session's first run of the day is ranked and carries `run.seed` (the ET day); every ranked player gets the same games and outcomes. Unranked runs have no seed and use the CSPRNG.
- The engine's `draw(run, label, fn)` wraps each game call in a generator seeded from `secret|day|label` (secret = `daily-seed|SESSION_SECRET`, passed to `applyAction`, never stored on the run). Labels name the draw (`game:<round>`, `r<round>:d<doubles>:init|apply`), so nothing is carried between requests.
- Rules: games must draw randomness only through `worker/rng`, and only in `init` or a single-roll `apply` (card games draw from the shoe shuffled in `init`). A new random draw anywhere else, or one that depends on the player's choices, breaks "same for everyone"; `test/engine.test.ts` ("daily seed") guards this.
- Ranked-ness is decided by the atomic `recordRunStart` count before the run is built.

---

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

# browser smoke test: plays whole runs at phone size until every game has
# come up; fails on page errors, stuck screens or sideways overflow
# (screenshots in test/e2e/output; set CHROMIUM_PATH if needed)
npm run test:e2e

# deploy (typecheck, tests, build, D1 migrations, deploy)
./deploy.sh
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
- Worker route is custom domain `gamba.0x9.ca`.

---

## 9) Agent Workflow Expectations

Before editing:
1. Read relevant shared types/constants first (`shared/protocol.ts`, `shared/games.ts`).
2. Verify server/client assumptions line up.

Before finishing:
1. `npx tsc -b`
2. `npx vitest run`
3. If asked to deploy, `npx wrangler deploy` and report version ID.
