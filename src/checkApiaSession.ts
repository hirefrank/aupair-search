import { load } from "cheerio";
import { loadDotEnv } from "./lib/env.js";
import { fetchWithRetry } from "./lib/http.js";

loadDotEnv();

const apiaBaseUrl = process.env.APIA_URL_OVERRIDE || process.env.APIA_URL || "";
const apiaCookie = process.env.APIA_COOKIE_OVERRIDE || process.env.APIA_COOKIE || "";
const apiaUserAgent =
  process.env.APIA_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function fail(message: string): never {
  console.error(`APIA check failed: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  if (!apiaBaseUrl) {
    fail("APIA_URL is missing");
  }
  if (!apiaCookie) {
    fail("APIA_COOKIE is missing");
  }

  const response = await fetchWithRetry(
    apiaBaseUrl,
    {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        "user-agent": apiaUserAgent,
        cookie: apiaCookie
      }
    },
    {
      retries: 3,
      minDelayMs: 400,
      maxDelayMs: 4_000,
      timeoutMs: 20_000
    }
  );

  if (!response.ok) {
    const text = await response.text();
    fail(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const html = await response.text();
  const $ = load(html);

  const hasPaginateForm = $("#paginateForm").length > 0;
  const hasSearchForm = $("#searchForm").length > 0;
  const logoutLinkCount = $("a[href*='Logout.aspx']").length;
  const snapshotCount = $(".snapshot-div").length;
  const searchToken = $("#searchForm input[name='__RequestVerificationToken']").attr("value") || null;
  const paginateToken = $("#paginateForm input[name='__RequestVerificationToken']").attr("value") || null;

  console.log("APIA session check");
  console.log(`- URL: ${apiaBaseUrl}`);
  console.log(`- HTTP: ${response.status}`);
  console.log(`- hasSearchForm: ${hasSearchForm}`);
  console.log(`- hasPaginateForm: ${hasPaginateForm}`);
  console.log(`- logoutLinks: ${logoutLinkCount}`);
  console.log(`- snapshotCardsOnPage: ${snapshotCount}`);
  console.log(`- searchFormToken: ${searchToken ? "present" : "missing"}`);
  console.log(`- paginateFormToken: ${paginateToken ? "present" : "missing"}`);

  if (!hasSearchForm || !hasPaginateForm) {
    fail("Portal forms not found. Session is likely expired or redirected.");
  }
  if (!searchToken || !paginateToken) {
    fail("Anti-forgery token missing. Session may be invalid.");
  }

  console.log("APIA session looks valid.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(message);
});
