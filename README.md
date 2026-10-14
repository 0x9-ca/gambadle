# Gambadle

Browser-based gambling minigame built on Cloudflare Workers.

- 5-round runs
- Server-authoritative game logic
- Daily reset + leaderboard

## Agent docs

If you are an automated coding agent (or onboarding one), read these first:

- [`AGENTS.md`](./AGENTS.md) — full architecture, invariants, workflow, and test/deploy expectations
- [`CLAUDE.md`](./CLAUDE.md) — concise execution checklist and high-risk areas

## Local checks

```bash
npx tsc -b
npx vitest run
```
