import { describe, expect, test } from "bun:test";
import { getApiaCookieVerificationToken, getApiaPageVerificationToken } from "./lib/apiaFavorites.js";
import {
  containsApiaAuthError,
  containsCultureCareAuthError,
  keysToMarkNotified
} from "./worker.js";

describe("auth error classification", () => {
  test("matches CultureCare-specific auth errors without matching generic APIA failures", () => {
    expect(containsCultureCareAuthError("CultureCare auth error: HTTP 401")).toBe(true);
    expect(containsCultureCareAuthError("APIA auth error: unauthorized")).toBe(false);
  });

  test("matches APIA-specific auth errors when the provider name is present", () => {
    expect(containsApiaAuthError("APIA auth error: Could not find paginate anti-forgery token")).toBe(true);
    expect(containsApiaAuthError("CultureCare auth error: unauthorized")).toBe(false);
  });
});

describe("keysToMarkNotified", () => {
  test("only marks keys for the matches actually sent", () => {
    expect(keysToMarkNotified(["a", "b", "c"], 2)).toEqual(["a", "b"]);
    expect(keysToMarkNotified(["a", "b", "c"], 0)).toEqual([]);
  });
  test("caps at the available key count", () => {
    expect(keysToMarkNotified(["a", "b"], 5)).toEqual(["a", "b"]);
  });
});

describe("APIA verification tokens", () => {
  test("reads the anti-forgery token from the cookie header", () => {
    expect(getApiaCookieVerificationToken("foo=1; __RequestVerificationToken=abc123; bar=2")).toBe("abc123");
  });

  test("returns null when the token cookie is missing", () => {
    expect(getApiaCookieVerificationToken("foo=1; bar=2")).toBeNull();
  });

  test("reads the anti-forgery token from the APIA page html", () => {
    const html = '<form id="searchForm"><input name="__RequestVerificationToken" value="page-token-123" /></form>';
    expect(getApiaPageVerificationToken(html)).toBe("page-token-123");
  });
});
