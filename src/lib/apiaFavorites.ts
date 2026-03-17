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
export function getApiaCookieVerificationToken(cookieHeader: string): string | null {
  return readCookieValue(cookieHeader, "__RequestVerificationToken");
}

/** @internal Exported for testing */
export function getApiaPageVerificationToken(html: string): string | null {
  const searchFormMatch = html.match(
    /id="searchForm"[\s\S]*?name="__RequestVerificationToken"[^>]*value="([^"]+)"/i
  );
  if (searchFormMatch) return searchFormMatch[1];

  const anyFormMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i);
  return anyFormMatch ? anyFormMatch[1] : null;
}

export async function favoriteApiaCandidate(params: {
  apId: string;
  cookie: string;
  baseUrl: string;
  userAgent?: string;
}): Promise<FavoriteResult> {
  const cookieToken = getApiaCookieVerificationToken(params.cookie);
  if (!cookieToken) {
    return { ok: false, error: "Missing APIA __RequestVerificationToken in cookie" };
  }

  const baseUrl = new URL(params.baseUrl);
  const pageResponse = await fetchWithRetry(
    params.baseUrl,
    {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        cookie: params.cookie,
        "user-agent": params.userAgent || DEFAULT_APIA_USER_AGENT
      }
    },
    {
      retries: 2,
      minDelayMs: 300,
      maxDelayMs: 3_000,
      timeoutMs: 10_000
    }
  );
  const pageHtml = await pageResponse.text();
  const token = getApiaPageVerificationToken(pageHtml);
  if (!token) {
    return { ok: false, error: "Missing APIA page verification token" };
  }

  const favoriteUrl = new URL(`/aupair/AddFavorite?aupairId=${encodeURIComponent(params.apId)}`, baseUrl);
  const body = new URLSearchParams({
    aupairId: params.apId,
    __RequestVerificationToken: token
  });

  const response = await fetchWithRetry(
    favoriteUrl.toString(),
    {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        cookie: params.cookie,
        origin: baseUrl.origin,
        referer: params.baseUrl,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
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

  if (/Au Pair in America Host Family - Login|Host Family Login/i.test(responseText)) {
    return { ok: false, error: "APIA session appears expired" };
  }

  return { ok: true };
}
