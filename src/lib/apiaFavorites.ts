import { fetchWithRetry } from "./http.js";

type FavoriteResult = {
  ok: boolean;
  error?: string;
};

const DEFAULT_APIA_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function readCookieValue(cookieHeader: string, name: string): string | null {
  const parts = cookieHeader.split(/;\s*/);
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    if (part.slice(0, idx) !== name) continue;
    return part.slice(idx + 1);
  }
  return null;
}

/** @internal Exported for testing */
export function getApiaRequestVerificationToken(cookieHeader: string): string | null {
  return readCookieValue(cookieHeader, "__RequestVerificationToken");
}

export async function favoriteApiaCandidate(params: {
  apId: string;
  cookie: string;
  baseUrl: string;
  userAgent?: string;
}): Promise<FavoriteResult> {
  const token = getApiaRequestVerificationToken(params.cookie);
  if (!token) {
    return { ok: false, error: "Missing APIA __RequestVerificationToken in cookie" };
  }

  const baseUrl = new URL(params.baseUrl);
  const favoriteUrl = new URL(`/aupair/AddFavorite?aupairId=${encodeURIComponent(params.apId)}`, baseUrl);
  const body = new URLSearchParams({
    __RequestVerificationToken: token
  });

  const response = await fetchWithRetry(
    favoriteUrl.toString(),
    {
      method: "POST",
      headers: {
        accept: "text/html, */*; q=0.1",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: params.cookie,
        origin: baseUrl.origin,
        referer: params.baseUrl,
        "user-agent": params.userAgent || DEFAULT_APIA_USER_AGENT,
        "x-requested-with": "XMLHttpRequest"
      },
      body: body.toString()
    },
    {
      retries: 2,
      minDelayMs: 300,
      maxDelayMs: 3_000,
      timeoutMs: 10_000
    }
  );

  const responseText = await response.text();
  if (!response.ok) {
    return { ok: false, error: `HTTP ${response.status}` };
  }

  if (/login|sign in|logged out|unauthorized/i.test(responseText)) {
    return { ok: false, error: "APIA session appears expired" };
  }

  return { ok: true };
}
