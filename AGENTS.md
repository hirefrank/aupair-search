# AGENTS.md

## Purpose
This guide is for coding agents working in this repository.
Use it as the default operating manual unless the user explicitly overrides it.

## Project Snapshot
- Runtime: Bun + TypeScript (ESM).
- Package manager: Bun only.
- Main crawl entrypoint: `src/index.ts`.
- Shared search pipeline: `src/lib/searchPipeline.ts`.
- Cloudflare Worker entrypoint: `src/worker.ts`.
- Adapters: `src/adapters/`.
- Shared types: `src/types.ts`.
- Generated outputs: `output/`.

## Tooling Policy
- Always use Bun commands for install/run/test/typecheck.
- Do not use `npm`, `pnpm`, or `yarn`.
- `scripts/require-bun.mjs` enforces this policy.

## Build, Lint, and Test Commands

### Install
```bash
bun install
```

### Build
There is no separate app build script for Node runtime.
The practical build gate is TypeScript checking.

```bash
bun run typecheck
```

Cloudflare bundle check (no deploy):
```bash
bunx wrangler deploy --dry-run
```

### Lint
There is currently no dedicated lint script.
Treat `bun run typecheck` as the static quality gate.

### Tests
Run all tests:
```bash
bun test
```

Run tests via package script:
```bash
bun run test
```

Run a single test file:
```bash
bun test path/to/file.test.ts
```

Run a single test by name pattern:
```bash
bun test --test-name-pattern "your test name"
```

Run one test in one file:
```bash
bun test path/to/file.test.ts --test-name-pattern "your test name"
```

## Operational Commands

Run crawl locally:
```bash
bun run crawl
```

Worker dev/deploy flow:
```bash
bun run worker:dev
bun run worker:deploy
```

Sync Culture Care + Slack secrets to Worker:
```bash
bun run sync:secrets
```

## Cloudflare Worker Notes
- `wrangler.toml` defines cron triggers and env vars.
- Worker scheduled runs execute search + threshold filtering + Slack notify.
- `MATCH_NOTIFICATIONS` KV binding is required for deduping Slack alerts.
- Manual endpoint: `POST /api/run-search` with `Authorization: Bearer <MANUAL_TRIGGER_TOKEN>`.

## Environment and Secrets
- Start from `.env.example`.
- Never commit `.env`.
- Treat these as secrets: `CULTURECARE_BEARER`, `CULTURECARE_REFRESH_TOKEN`, `SLACK_WEBHOOK_URL`, `MANUAL_TRIGGER_TOKEN`.
- Do not print secrets in logs, diffs, or comments.
- If exposure happens, rotate immediately.

## Data and Output Hygiene
- `output/` is generated; do not hand-edit artifacts.
- Prefer rerunning scripts over manual result edits.
- Keep output schema backward compatible when practical.

## Code Style Guidelines

### General
- Language: strict TypeScript.
- Prefer small, composable functions.
- Use guard clauses and early returns.
- Keep side effects localized (I/O, network, env access).

### Imports
- Use ESM imports only.
- Use `.js` in local import specifiers.
- Order imports as: built-ins, internal modules, then `import type`.
- Avoid unused imports.

### Types
- Prefer explicit types on public functions and complex values.
- Prefer `unknown` over `any`, then narrow.
- Keep shared contracts in `src/types.ts`.
- Add dedicated local types for API payloads and normalized entities.

### Naming
- PascalCase: classes, types, interfaces.
- camelCase: functions, variables, params.
- UPPER_SNAKE_CASE: module-level constants.
- Keep adapter source keys stable (`culturecare`, `apia`).

### Formatting
- Follow existing conventions in touched files.
- Use double quotes and semicolons.
- Keep functions focused; extract helpers for repeated logic.

### Error Handling
- Throw `Error` with actionable context.
- Include status codes and short body snippets for HTTP failures.
- Never silently swallow failures.
- Use retry/backoff only for transient network/HTTP conditions.

### Concurrency
- Use `Promise.all` only for independent operations.
- Avoid unbounded parallelism for API-heavy loops.
- Respect external rate limits.

## Change Discipline
- Make minimal, targeted edits.
- Do not refactor unrelated code in the same patch.
- Preserve existing behavior unless requested otherwise.
- Keep inactive adapters present unless user asks to remove them.

## Validation Checklist Before Handoff
1. Run `bun run typecheck`.
2. Run focused tests if tests are affected.
3. If Worker code changed, run `bunx wrangler deploy --dry-run` when possible.
4. Document any required env/secrets updates in `README.md`.

## Cursor/Copilot Rules Audit
- Checked `.cursor/rules/`: not present.
- Checked `.cursorrules`: not present.
- Checked `.github/copilot-instructions.md`: not present.

## If You Are Blocked
- First inspect existing code patterns and env templates.
- If still blocked by missing secret or irreversible choice, ask one precise question.
