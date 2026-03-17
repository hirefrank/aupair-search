import { load } from "cheerio";
import { fetchWithRetry } from "./http.js";

type ApiaSessionOptions = {
  baseUrl: string;
  userAgent: string;
  cookie?: string;
  email?: string;
  password?: string;
};

type CookieJar = Map<string, string>;

const LOGIN_PAGE_URL = "https://my.aupairinamerica.com/login";

function parseCookiePair(setCookie: string): [string, string] | null {
  const pair = setCookie.split(";", 1)[0]?.trim();
  if (!pair) return null;
  const idx = pair.indexOf("=");
  if (idx <= 0) return null;
  return [pair.slice(0, idx), pair.slice(idx + 1)];
}

/** @internal Exported for testing */
export function parseLoginForm(html: string): { action: string; token: string | null } {
  const $ = load(html);
  const form = $("form")
    .toArray()
    .map((element) => $(element))
    .find((candidate) => candidate.find("input[name='UserName']").length > 0 && candidate.find("input[name='Password']").length > 0) ||
    $("form[action='/login'], form[action*='/login/Index']").first();
  const action = form.attr("action") || "/login";
  const token = form.find("input[name='__RequestVerificationToken']").attr("value") || null;
  return { action, token };
}

function cookieHeader(jar: CookieJar, extraCookie = ""): string {
  const out = new Map<string, string>();
  for (const [key, value] of jar) out.set(key, value);
  for (const part of extraCookie.split(/;\s*/)) {
    if (!part) continue;
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    out.set(part.slice(0, idx), part.slice(idx + 1));
  }
  return [...out.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function updateJarFromResponse(jar: CookieJar, response: Response): void {
  const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const setCookie of setCookies) {
    const pair = parseCookiePair(setCookie);
    if (!pair) continue;
    jar.set(pair[0], pair[1]);
  }
}

async function fetchWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit,
  userAgent: string,
  extraCookie = ""
): Promise<Response> {
  const headers = new Headers(init.headers || {});
  if (!headers.has("user-agent")) headers.set("user-agent", userAgent);

  let currentUrl = url;
  let currentInit: RequestInit = { ...init, headers, redirect: "manual" };

  for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
    const requestHeaders = new Headers(currentInit.headers || {});
    const requestCookie = cookieHeader(jar, extraCookie);
    if (requestCookie) {
      requestHeaders.set("cookie", requestCookie);
    } else {
      requestHeaders.delete("cookie");
    }

    const response = await fetchWithRetry(currentUrl, {
      ...currentInit,
      headers: requestHeaders
    }, {
      retries: 3,
      minDelayMs: 300,
      maxDelayMs: 3_000,
      timeoutMs: 20_000
    });

    updateJarFromResponse(jar, response);

    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) return response;

    currentUrl = new URL(location, currentUrl).toString();
    const shouldSwitchToGet = currentInit.method === "POST" && [301, 302, 303].includes(response.status);
    currentInit = {
      method: shouldSwitchToGet ? "GET" : currentInit.method,
      headers: new Headers({
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        referer: currentUrl,
        "user-agent": userAgent
      }),
      redirect: "manual",
      body: shouldSwitchToGet ? undefined : currentInit.body
    };
  }

  throw new Error("APIA login redirect loop exceeded limit");
}

/** @internal Exported for testing */
export function hasValidApiaPortalForms(html: string): boolean {
  return /id="searchForm"/i.test(html) && /id="paginateForm"/i.test(html) && !/Host Family Login/i.test(html);
}

export async function createApiaSession(options: ApiaSessionOptions): Promise<string> {
  const baseUrl = options.baseUrl;
  const email = options.email?.trim() || "";
  const password = options.password || "";
  const fallbackCookie = options.cookie?.trim() || "";

  if (email && password) {
    const jar: CookieJar = new Map();
    const loginPage = await fetchWithJar(
      jar,
      LOGIN_PAGE_URL,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache"
        }
      },
      options.userAgent
    );
    const loginHtml = await loginPage.text();
    const { action, token } = parseLoginForm(loginHtml);
    if (!token) throw new Error("APIA login page anti-forgery token missing");

    const loginUrl = new URL(action, LOGIN_PAGE_URL).toString();
    const body = new URLSearchParams({
      __RequestVerificationToken: token,
      UserName: email,
      Password: password
    });

    const loginResponse = await fetchWithJar(
      jar,
      loginUrl,
      {
        method: "POST",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache",
          "content-type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      },
      options.userAgent
    );
    const loginResultHtml = await loginResponse.text();
    if (/Host Family Login|Username is required|Password is required|invalid/i.test(loginResultHtml)) {
      throw new Error("APIA login failed");
    }

    const portalResponse = await fetchWithJar(
      jar,
      baseUrl,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "cache-control": "no-cache"
        }
      },
      options.userAgent
    );
    const portalHtml = await portalResponse.text();
    if (!hasValidApiaPortalForms(portalHtml)) {
      throw new Error("APIA login succeeded but portal session is not valid");
    }
    return cookieHeader(jar);
  }

  if (fallbackCookie) return fallbackCookie;
  throw new Error("Missing APIA_COOKIE and APIA_EMAIL/APIA_PASSWORD");
}
