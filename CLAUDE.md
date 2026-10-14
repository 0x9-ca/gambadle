# CLAUDE.md

Guidance for Claude (or any LLM agent) working in this repo.

For full project details, read **AGENTS.md** first. This file is a concise execution checklist.

---

## Quick Rules

1. **Server is authoritative.** Never move game logic into client code.
2. **Honor shared contracts.** Start from `shared/protocol.ts` + `shared/games.ts` before edits.
3. **Preserve chip accounting semantics.** `returned` includes stake on wins/pushes.
4. **Do not regress hidden info.** Dealer hole-card value must remain hidden pre-resolution.
5. **Keep the daily seed deterministic.** Ranked runs draw only via `worker/rng` in `init`/single-roll `apply`; see AGENTS.md "Daily seed".
6. **Run full validation before done.**

---

## Required Validation

```bash
npx tsc -b
npx vitest run
```

If deploying:

```bash
npx wrangler deploy
```

Report deployed Version ID.

---

## High-Risk Areas

- `worker/engine.ts` (phase transitions, DoN, settlement)
- `worker/games/baccarat.ts` (draw table, naturals, push behavior)
- `worker/games/roulette.ts` (loss must return 0)
- `worker/games/blackjack.ts` (hole-card visibility)
- `worker/games/slots.ts` + `src/components/boards.tsx` (3-reel rendering and paylines)

---

## UI Contract Notes

- UI renders exactly what server sends.
- `view.resolved` is canonical for “done”.
- In `choosing` phase, game identity should be visible before auto-confirm actions proceed.

---

## Style Expectations

- Tabs, single quotes, TS strictness.
- Add comments for rationale/edge cases, not obvious code.
- Keep patches minimal and local.
