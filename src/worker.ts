import { Hono } from "hono";
import { fetchWithRetry } from "./lib/http.js";
import { runSearchPipeline } from "./lib/searchPipeline.js";
import {
  buildCandidateDetailsModal,
  parseCandidateDetailsPayload,
  sendCultureCareAuthAlert,
  sendSlackCandidates
} from "./lib/slack.js";
import type { RankedProfile } from "./types.js";

type Bindings = {
  MATCH_NOTIFICATIONS: {
    get: (key: string) => Promise<string | null>;
    put: (key: string, value: string, options?: { expirationTtl?: number }) => Promise<void>;
  };
  [key: string]: unknown;
};

type SlackBlockAction = {
  action_id?: string;
  value?: string;
};

type SlackActionsPayload = {
  type?: string;
  token?: string;
  trigger_id?: string;
  actions?: SlackBlockAction[];
};

const app = new Hono<{ Bindings: Bindings }>();

function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySlackSignature(
  rawBody: string,
  timestampHeader: string,
  signatureHeader: string,
  signingSecret: string
): Promise<boolean> {
  const timestampSeconds = Number(timestampHeader);
  if (!Number.isFinite(timestampSeconds)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 60 * 5) {
    return false;
  }

  const encoder = new TextEncoder();
  const signingBase = `v0:${timestampHeader}:${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(signingBase));
  const signatureHex = Array.from(new Uint8Array(signatureBuffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const expected = `v0=${signatureHex}`;

  return secureCompare(expected, signatureHeader);
}

async function isAuthorizedSlackAction(
  rawBody: string,
  payload: SlackActionsPayload,
  env: NodeJS.ProcessEnv,
  signatureHeader: string,
  timestampHeader: string
): Promise<boolean> {
  const signingSecret = env.SLACK_SIGNING_SECRET || "";
  if (signingSecret) {
    return verifySlackSignature(rawBody, timestampHeader, signatureHeader, signingSecret);
  }

  const expectedToken = env.SLACK_ACTION_TOKEN || "";
  if (!expectedToken) return false;
  if (typeof payload.token !== "string") return false;
  return secureCompare(payload.token, expectedToken);
}

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toRuntimeEnv(bindings: Bindings): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function notificationKey(profile: RankedProfile): string {
  if (profile.id) return `candidate:${profile.source}:${profile.id.toLowerCase()}`;
  if (profile.profileUrl) return `candidate:${profile.source}:${profile.profileUrl.toLowerCase()}`;
  const name = (profile.name || "unknown").toLowerCase();
  const country = (profile.country || "unknown").toLowerCase();
  return `candidate:${profile.source}:${name}:${country}`;
}

function containsCultureCareAuthError(message: string): boolean {
  return /culture\s*care|cognito|refresh token|bearer|auth|unauthorized|401/i.test(message);
}

async function shouldSendTtlKey(
  store: Bindings["MATCH_NOTIFICATIONS"],
  key: string,
  ttlSeconds: number
): Promise<boolean> {
  const existing = await store.get(key);
  if (existing) return false;
  await store.put(key, new Date().toISOString(), {
    expirationTtl: Math.max(60, ttlSeconds)
  });
  return true;
}

async function maybeSendCultureCareAuthAlert(
  bindings: Bindings,
  env: NodeJS.ProcessEnv,
  errorMessage: string
): Promise<void> {
  if (!containsCultureCareAuthError(errorMessage)) return;

  const webhookUrl = env.SLACK_WEBHOOK_URL || "";
  if (!webhookUrl) return;

  const ttlHours = asNumber(env.AUTH_ALERT_TTL_HOURS, 12);
  const shouldSend = await shouldSendTtlKey(
    bindings.MATCH_NOTIFICATIONS,
    "alert:culturecare-auth",
    ttlHours * 60 * 60
  );
  if (!shouldSend) return;

  const reauthUrl = env.CULTURECARE_REAUTH_URL || "https://hostfamily.culturalcare.com";
  await sendCultureCareAuthAlert({
    webhookUrl,
    reauthUrl,
    errorMessage
  });
}

async function filterAlreadyNotified(
  profiles: RankedProfile[],
  store: Bindings["MATCH_NOTIFICATIONS"]
): Promise<{ fresh: RankedProfile[]; freshKeys: string[] }> {
  const keyed = profiles.map((profile) => ({
    profile,
    key: notificationKey(profile)
  }));

  const existing = await Promise.all(keyed.map((entry) => store.get(entry.key)));
  const fresh: RankedProfile[] = [];
  const freshKeys: string[] = [];

  for (let i = 0; i < keyed.length; i += 1) {
    if (!existing[i]) {
      fresh.push(keyed[i].profile);
      freshKeys.push(keyed[i].key);
    }
  }

  return { fresh, freshKeys };
}

async function markNotified(
  keys: string[],
  store: Bindings["MATCH_NOTIFICATIONS"],
  ttlDays: number
): Promise<void> {
  const expirationTtl = Math.max(1, ttlDays) * 24 * 60 * 60;
  await Promise.all(
    keys.map((key) =>
      store.put(key, new Date().toISOString(), {
        expirationTtl
      })
    )
  );
}

async function runScheduledSearch(bindings: Bindings): Promise<{
  totalProfiles: number;
  threshold: number;
  effectiveThreshold: number;
  scoreThresholdApplied: boolean;
  thresholdMatches: number;
  notifiedMatches: number;
  skippedAsAlreadyNotified: number;
}> {
  const env = toRuntimeEnv(bindings);
  const maxPages = asNumber(env.MAX_PAGES, 200);
  const notifyMax = asNumber(env.SLACK_NOTIFY_MAX, 25);
  const ttlDays = asNumber(env.MATCH_NOTIFIED_TTL_DAYS, 30);
  const skipKvWrites = String(env.SLACK_SKIP_KV_WRITES || "false") === "true";
  const enableDetailsModal = String(env.SLACK_ENABLE_DETAILS_MODAL || "false") === "true";

  let run;
  try {
    run = await runSearchPipeline(env, { maxPages });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await maybeSendCultureCareAuthAlert(bindings, env, message);
    throw error;
  }

  if (run.bySource.culturecare.skipped && run.bySource.culturecare.reason) {
    await maybeSendCultureCareAuthAlert(bindings, env, run.bySource.culturecare.reason);
  }

  const webhookUrl = env.SLACK_WEBHOOK_URL || "";
  let matchesForSlack = run.thresholdMatches;
  let freshKeys: string[] = [];
  let skippedAsAlreadyNotified = 0;

  if (!skipKvWrites) {
    const deduped = await filterAlreadyNotified(run.thresholdMatches, bindings.MATCH_NOTIFICATIONS);
    matchesForSlack = deduped.fresh;
    freshKeys = deduped.freshKeys;
    skippedAsAlreadyNotified = run.thresholdMatches.length - matchesForSlack.length;
  }

  let notifiedMatches = 0;
  if (webhookUrl && matchesForSlack.length > 0) {
    const sent = await sendSlackCandidates(matchesForSlack, {
      webhookUrl,
      threshold: run.effectiveThreshold,
      maxProfiles: notifyMax,
      enableDetailsModal
    });
    notifiedMatches = sent.sent;
    if (!skipKvWrites && freshKeys.length) {
      await markNotified(freshKeys, bindings.MATCH_NOTIFICATIONS, ttlDays);
    }
  }

  return {
    totalProfiles: run.merged.length,
    threshold: run.threshold,
    effectiveThreshold: run.effectiveThreshold,
    scoreThresholdApplied: run.scoreThresholdApplied,
    thresholdMatches: run.thresholdMatches.length,
    notifiedMatches,
    skippedAsAlreadyNotified
  };
}

app.get("/api/health", (c) => {
  return c.json({ ok: true, service: "aupair-search" });
});

app.post("/api/slack/actions", async (c) => {
  const env = toRuntimeEnv(c.env);
  const rawBody = await c.req.text();
  const params = new URLSearchParams(rawBody);
  const payloadText = params.get("payload") || "";

  if (!payloadText) {
    return c.text("Missing Slack payload", 400);
  }

  let payload: SlackActionsPayload;
  try {
    payload = JSON.parse(payloadText) as SlackActionsPayload;
  } catch {
    return c.text("Invalid Slack payload", 400);
  }

  const signatureHeader = c.req.header("x-slack-signature") || "";
  const timestampHeader = c.req.header("x-slack-request-timestamp") || "";
  const authorized = await isAuthorizedSlackAction(
    rawBody,
    payload,
    env,
    signatureHeader,
    timestampHeader
  );

  if (!authorized) {
    return c.text("Unauthorized", 401);
  }

  if (payload.type !== "block_actions" || !Array.isArray(payload.actions) || payload.actions.length === 0) {
    return c.text("");
  }

  const action = payload.actions[0];
  if (action.action_id !== "view_candidate_details") {
    return c.text("");
  }

  const details = parseCandidateDetailsPayload(typeof action.value === "string" ? action.value : "");
  if (!details) {
    return c.text("");
  }

  const triggerId = typeof payload.trigger_id === "string" ? payload.trigger_id : "";
  if (!triggerId) {
    return c.text("");
  }

  const botToken = env.SLACK_BOT_TOKEN || "";
  if (!botToken) {
    console.error("Missing SLACK_BOT_TOKEN for Slack modal actions");
    return c.text("");
  }

  const view = buildCandidateDetailsModal(details);

  try {
    const response = await fetchWithRetry(
      "https://slack.com/api/views.open",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${botToken}`,
          "content-type": "application/json; charset=utf-8"
        },
        body: JSON.stringify({ trigger_id: triggerId, view })
      },
      {
        retries: 2,
        minDelayMs: 250,
        maxDelayMs: 1_000,
        timeoutMs: 8_000
      }
    );

    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || body.ok !== true) {
      console.error("Slack views.open failed", {
        status: response.status,
        error: typeof body.error === "string" ? body.error : "unknown"
      });
    }
  } catch (error) {
    console.error("Slack modal open request failed", error);
  }

  return c.text("");
});

app.post("/api/run-search", async (c) => {
  const expectedToken = typeof c.env.MANUAL_TRIGGER_TOKEN === "string" ? c.env.MANUAL_TRIGGER_TOKEN : "";
  if (!expectedToken) {
    return c.json(
      { ok: false, error: "MANUAL_TRIGGER_TOKEN is not configured for this worker" },
      403
    );
  }

  const authHeader = c.req.header("authorization") || "";
  const provided = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!provided || provided !== expectedToken) {
    return c.json({ ok: false, error: "Unauthorized" }, 401);
  }

  try {
    const summary = await runScheduledSearch(c.env);
    return c.json({ ok: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 500);
  }
});

export default {
  fetch: app.fetch,
  scheduled(_event: unknown, env: Bindings, ctx: { waitUntil: (promise: Promise<unknown>) => void }) {
    const run = runScheduledSearch(env).catch((error: unknown) => {
      console.error("Scheduled search failed", error);
      throw error;
    });
    ctx.waitUntil(run);
  }
};
