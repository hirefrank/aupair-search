import { describe, expect, test } from "bun:test";
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
});
