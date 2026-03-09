import { sleep } from "./utils.js";

export type RetryOptions = {
  retries?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
};

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function parseRetryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (!Number.isNaN(asNumber) && asNumber >= 0) return asNumber * 1000;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function backoffDelay(attempt: number, minDelayMs: number, maxDelayMs: number): number {
  const exp = minDelayMs * 2 ** attempt;
  const jitter = Math.floor(Math.random() * minDelayMs);
  return clamp(exp + jitter, minDelayMs, maxDelayMs);
}

export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  const retries = options.retries ?? 5;
  const minDelayMs = options.minDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 20_000;

  let attempt = 0;
  let lastError: unknown = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal
      });

      if (!RETRYABLE_STATUSES.has(response.status)) {
        return response;
      }

      if (attempt === retries) {
        return response;
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
      const waitMs = retryAfterMs ?? backoffDelay(attempt, minDelayMs, maxDelayMs);
      await sleep(waitMs);
    } catch (error) {
      lastError = error;
      if (attempt === retries) {
        throw error;
      }
      const waitMs = backoffDelay(attempt, minDelayMs, maxDelayMs);
      await sleep(waitMs);
    } finally {
      clearTimeout(timer);
    }

    attempt += 1;
  }

  throw lastError instanceof Error ? lastError : new Error("fetchWithRetry failed");
}
