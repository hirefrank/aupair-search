# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

```bash
bun install                        # Install dependencies (Bun only — never npm/pnpm/yarn)
bun run typecheck                  # Primary quality gate (strict TypeScript)
bun test                           # Run all tests
bun test path/to/file.test.ts      # Run single test file
bun run crawl                      # Run local search crawl
bun run worker:dev                 # Cloudflare Worker dev mode
bun run worker:deploy              # Deploy Worker to Cloudflare
bunx wrangler deploy --dry-run     # Verify Worker bundles without deploying
bun run sync:secrets               # Sync secrets to Cloudflare Worker
bun run trigger:search             # Manually trigger the /api/run-search endpoint
```

There is no dedicated linter — `bun run typecheck` is the static quality gate.

## Architecture

Au pair search aggregator that runs as both a local CLI tool and a Cloudflare Worker on a 15-minute cron. It queries multiple au pair agency APIs, scores candidates against configurable preferences, and sends Slack notifications for matches.

### Execution modes

| Mode | Entry point | Trigger | KV dedup |
|------|-------------|---------|----------|
| Local crawl | `src/index.ts` | `bun run crawl` | No |
| Worker cron | `src/worker.ts` | Every 15 min (`wrangler.toml`) | Yes |
| Manual trigger | `src/worker.ts` | `POST /api/run-search` with Bearer token | Yes |

### Data flow

```
Adapters (parallel)  →  Merge & dedupe  →  Score (PREFERENCES_JSON)
    ├ CultureCare          →  Hard filters (age, gender, English, arrival, pets, driving, etc.)
    └ APIA                     →  Maturity gate (optional, for candidates below MATCH_MIN_AGE)
                                    →  Threshold check (MATCH_SCORE_THRESHOLD)
                                        →  KV dedup (Worker only)
                                            →  Slack notifications
```

### Key modules

- **`src/lib/searchPipeline.ts`** — Orchestrator: runs adapters in parallel, merges/dedupes, scores, filters. Core logic shared by all execution modes.
- **`src/adapters/culturecare.ts`** — JSON API adapter using AWS Cognito auth (refresh token → ID token). Paginated with `nextToken`.
- **`src/adapters/apia.ts`** — HTML scraper using Cheerio. Cookie-based session, anti-forgery tokens, POST-based pagination.
- **`src/auth/cognito.ts`** — AWS Cognito `InitiateAuth` for Culture Care token refresh.
- **`src/lib/utils.ts`** — Scoring engine (`scoreProfile`), profile normalization, deduplication, JWT helpers, CSV export.
- **`src/lib/slack.ts`** — Slack Block Kit formatting, optional modal payload building/parsing, auth-expiry alert notifications.
- **`src/lib/http.ts`** — `fetchWithRetry` with exponential backoff, jitter, and `Retry-After` support.
- **`src/worker.ts`** — Hono app with health check, Slack interactivity endpoint (`/api/slack/actions`), manual trigger endpoint, and cron handler. Manages KV-based notification dedup.

### Adapter contract

Both adapters implement `run({ maxPages })` returning `AdapterRunResult { source, profiles: RankedProfile[], skipped, reason? }`. Profiles are normalized to a common `RankedProfile` shape defined in `src/types.ts`. New adapters should follow this pattern.

## Code conventions

Key points:

- ESM imports with `.js` extensions on local imports
- Strict TypeScript; prefer `unknown` over `any`
- Shared types live in `src/types.ts`
- Double quotes, semicolons, guard clauses / early returns
- Import order: built-ins → internal modules → `import type`
- Adapter source keys are stable strings (`"culturecare"`, `"apia"`)

## Environment

Start from `.env.example`. Core secrets: `CULTURECARE_BEARER` and/or `CULTURECARE_REFRESH_TOKEN`, `SLACK_WEBHOOK_URL`, `MANUAL_TRIGGER_TOKEN`.

For Slack modal mode (`SLACK_ENABLE_DETAILS_MODAL=true`), also set:

- `SLACK_BOT_TOKEN`
- `SLACK_SIGNING_SECRET` (recommended)
- `SLACK_ACTION_TOKEN` (legacy fallback only if signing secret is unavailable)

Worker uses Cloudflare bindings (not local `.env` at runtime); the `MATCH_NOTIFICATIONS` KV namespace is required for dedup.

## Validation before handoff

1. `bun run typecheck` must pass
2. Run focused tests if affected
3. `bunx wrangler deploy --dry-run` if Worker code changed
4. Update README.md if env/secrets changed
