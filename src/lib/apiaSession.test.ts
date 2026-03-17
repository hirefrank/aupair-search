import { describe, expect, test } from "bun:test";
import { hasValidApiaPortalForms, parseLoginForm } from "./apiaSession.js";

describe("parseLoginForm", () => {
  test("extracts login action and anti-forgery token", () => {
    const html = `
      <form action="/login/Index?ReturnUrl=%2fHome%2fIndex" method="post">
        <input name="__RequestVerificationToken" type="hidden" value="token-123" />
      </form>
    `;

    expect(parseLoginForm(html)).toEqual({
      action: "/login/Index?ReturnUrl=%2fHome%2fIndex",
      token: "token-123"
    });
  });
});

describe("hasValidApiaPortalForms", () => {
  test("accepts html with both portal forms", () => {
    expect(hasValidApiaPortalForms('<form id="searchForm"></form><form id="paginateForm"></form>')).toBe(true);
  });

  test("rejects login page html", () => {
    expect(hasValidApiaPortalForms("<title>Host Family Login</title><form id='searchForm'></form>")).toBe(false);
  });
});
