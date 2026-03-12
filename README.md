# aupair-search

Culture Care-first au pair search automation on Cloudflare Workers.

It runs every 15 minutes, finds candidates that match your criteria, and sends compact Slack notifications.
It deduplicates via KV so the same candidate is not sent twice.

## What it does

- Runs scheduled search on Cloudflare Worker cron (`*/15 * * * *`).
- Uses Culture Care by default (`ENABLE_CULTURECARE=true`).
- Keeps APIA adapter available but disabled by default (`ENABLE_APIA=false`).
- Applies score threshold plus hard filters:
  - minimum age
  - female-only
  - minimum English level
  - arrival date window
- Sends Slack Block Kit notifications with concise candidate summaries.
- Includes a `View Details` button that opens the full profile link.
- Optional: in-Slack `View Details` modal via Slack interactivity when enabled.
- When modal mode is enabled, also includes an `Open Profile` button.
- Sends auth-expiry Slack alert with reauth button when Culture Care auth fails.

## Required stack

- Bun
- Cloudflare Wrangler

This repo is Bun-only. Do not use npm/pnpm/yarn.

## Setup

```bash
cp .env.example .env
bun install
```

Set required values in `.env`:

- `CULTURECARE_REFRESH_TOKEN` (recommended) and/or `CULTURECARE_BEARER`
- `SLACK_WEBHOOK_URL`
- `SLACK_ENABLE_DETAILS_MODAL` (`true` only if you want in-Slack modal details)
- `SLACK_BOT_TOKEN` (required when `SLACK_ENABLE_DETAILS_MODAL=true`)
- `SLACK_SIGNING_SECRET` (required when `SLACK_ENABLE_DETAILS_MODAL=true`)
- `SLACK_ACTION_TOKEN` (optional legacy fallback only if you cannot use signing secret)
- `MANUAL_TRIGGER_TOKEN` (random secret string)

Then sync secrets to Cloudflare:

```bash
bun run sync:secrets
```

`sync:secrets` will automatically try to extract a fresh Culture Care bearer token from your local Chrome/Chromium profile when `CULTURECARE_BEARER` is not already set.

## Deploy

1. Create a KV namespace for notification/bookmark state.
2. Put its ID into `wrangler.toml` under `[[kv_namespaces]]`.
3. Deploy:

```bash
bun run worker:deploy
```

## Commands

- `bun run crawl` - local search run (writes output files).
- `bun run check:apia` - verify APIA cookie/session.
- `bun run sync:secrets` - push secrets from `.env` to Worker.
- `bun run trigger:search` - manually call `/api/run-search`.
- `bun run worker:dev` - remote Worker dev.
- `bun run worker:deploy` - deploy Worker.
- `bun run typecheck` - TypeScript check.
- `bun test` - run tests.

## Match filters

Configured with env vars (defaults currently set to your request):

- `MATCH_SCORE_THRESHOLD=60`
- `MATCH_MIN_AGE=22`
- `MATCH_MIN_AGE_MATURE=21` (optional maturity gate — allows candidates this age if they pass maturity checks; set to `0` or omit to disable)
- `MATCH_REQUIRE_FEMALE=true`
- `MATCH_MIN_ENGLISH_LEVEL=6`
- `MATCH_ARRIVAL_EARLIEST=2026-06-01`
- `MATCH_ARRIVAL_LATEST=2026-07-31`
- `MATCH_CHILD_AGES=3,5` (post-filter against Culture Care `Preferred Ages`)
- `MATCH_REQUIRED_PETS=dogs`
- `MATCH_ALLOWED_DRIVING_FREQUENCIES=daily,weekly`
- `MATCH_MIN_DRIVING_YEARS=1`
- `MATCH_REQUIRE_SWIMMING_SUPERVISION=true`
- `MATCH_REQUIRE_LIVED_AWAY_FROM_HOME=true`

## Slack app setup (modal mode)

If you only want profile links in Slack cards, keep `SLACK_ENABLE_DETAILS_MODAL=false` and skip this section.

If you want the in-Slack `View Details` modal:

1. Create a Slack app in your workspace.
2. Enable **Incoming Webhooks** and add one webhook URL to the target channel.
3. In **OAuth & Permissions**, add bot scope `commands`, then install/reinstall the app.
4. Copy **Bot User OAuth Token** to `SLACK_BOT_TOKEN`.
5. In **Basic Information**, copy **Signing Secret** to `SLACK_SIGNING_SECRET`.
6. In **Interactivity & Shortcuts**, enable interactivity and set Request URL to:
   - `https://<your-worker-domain>/api/slack/actions`
7. Set `SLACK_ENABLE_DETAILS_MODAL=true`, then run `bun run sync:secrets` and `bun run worker:deploy`.

## Slack quick actions

Candidate Slack cards include:

- `View Details` to open the direct profile URL
- Optional in-Slack modal details plus `Open Profile` button (requires `SLACK_ENABLE_DETAILS_MODAL=true`)

To enable in-Slack modal details, set `SLACK_ENABLE_DETAILS_MODAL=true` and configure Slack app interactivity to point to:

- `POST /api/slack/actions` on your Worker base URL

## Worker endpoints

- `GET /api/health`
- `POST /api/slack/actions` (Slack interactivity endpoint)
- `POST /api/run-search` (`Authorization: Bearer <MANUAL_TRIGGER_TOKEN>`)

## Secret sync cron (local)

Optional local cron for rotating tokens into Worker secrets:

```bash
0 */2 * * * CLOUDFLARE_ACCOUNT_ID=<your-account-id> /path/to/bun --cwd /path/to/aupair-search run sync:secrets
```

## Security

- Never commit `.env`.
- Rotate leaked webhook URLs/tokens immediately.
- Keep `MANUAL_TRIGGER_TOKEN` secret.
