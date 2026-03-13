import { describe, expect, test } from "bun:test";
import { keysToMarkNotified } from "./worker.js";

describe("keysToMarkNotified", () => {
  test("marks only the keys that were actually sent to Slack", () => {
    expect(keysToMarkNotified(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });

  test("returns no keys when nothing was sent", () => {
    expect(keysToMarkNotified(["a", "b", "c"], 0)).toEqual([]);
  });

  test("caps at the available key count", () => {
    expect(keysToMarkNotified(["a", "b"], 5)).toEqual(["a", "b"]);
  });
});
