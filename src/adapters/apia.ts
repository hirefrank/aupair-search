import { load } from "cheerio";
import { fetchWithRetry } from "../lib/http.js";
import { createApiaSession } from "../lib/apiaSession.js";
import { sleep } from "../lib/utils.js";
import type { AdapterRunResult, JsonObject, RankedProfile } from "../types.js";

type SnapshotCard = {
  id: string;
  name: string | null;
  age: number | null;
  country: string | null;
  profilePath: string | null;
  nativeLanguage: string | null;
  programStatus: string | null;
  infantQualification: string | null;
  startWindow: string | null;
  imageUrl: string | null;
};

function parseYesNo(value: string | null): boolean | null {
  if (!value) return null;
  if (/^yes$/i.test(value.trim())) return true;
  if (/^no$/i.test(value.trim())) return false;
  return null;
}

function extractField(text: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(
    `${escaped}:\\s*(.+?)(?=\\s(?:Birthdate|Gender Identity|# of Siblings|Driver|Driving Frequency|Driver License Received On|Interests and Hobbies|Swimmer|Smoker|Lived Away From Home|Native Language|Religion|Dietary Restrictions|Pet Allergies|Education and Current Occupation|Occupation|Education|Program Information|Current Status|Arrival Window|Infant Qualified|Childcare Experience|Experienced with|Willing to Care for|ID Number|$))`,
    "i"
  );
  const match = text.match(regex);
  if (!match) return null;
  const value = match[1].trim();
  return value || null;
}

function extractChildcareHours(text: string): number | null {
  const patterns = [
    /childcare\s+experience\s+hours\s*:\s*([\d,\.]+)/i,
    /approved\s+childcare\s+hours\s*:\s*([\d,\.]+)/i,
    /total\s+childcare\s+hours\s*:\s*([\d,\.]+)/i,
    /([\d,\.]+)\s+hours\s+of\s+childcare/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const parsed = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function cleanApiaField(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value
    .replace(/\s+(Swimming Level|English Proficiency Test Score)\b[\s\S]*$/i, "")
    .replace(/\s+The match term is[\s\S]*$/i, "")
    .trim();
  return trimmed || null;
}

function extractEnglishLevel(text: string): string | null {
  const match = text.match(/English Proficiency Test Score\s+.*? scored the ([A-Za-z ]+?) level\b/i);
  return match ? match[1].trim() : null;
}

export class ApiaAdapter {
  private baseUrl: string;
  private cookie: string;
  private userAgent: string;
  private email: string;
  private password: string;
  private skipOnAuthError: boolean;
  private clearFilters: boolean;
  private fetchDetailPages: boolean;
  private detailConcurrency: number;
  private sessionCookie: string | null = null;
  private sessionPromise: Promise<string> | null = null;

  constructor(private env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = env.APIA_URL_OVERRIDE || env.APIA_URL || "";
    this.cookie = env.APIA_COOKIE_OVERRIDE || env.APIA_COOKIE || "";
    this.userAgent =
      env.APIA_USER_AGENT ||
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
    this.email = env.APIA_EMAIL || "";
    this.password = env.APIA_PASSWORD || "";
    this.skipOnAuthError = String(env.APIA_SKIP_ON_AUTH_ERROR || "true") === "true";
    this.clearFilters = String(env.APIA_CLEAR_FILTERS || "true") === "true";
    this.fetchDetailPages = String(env.APIA_FETCH_DETAILS || "false") === "true";
    this.detailConcurrency = Number(env.APIA_DETAIL_CONCURRENCY || 4);
  }

  enabled(): boolean {
    return !!this.baseUrl;
  }

  private async getSessionCookie(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.sessionCookie) return this.sessionCookie;
    if (!forceRefresh && this.sessionPromise) return this.sessionPromise;

    const promise = createApiaSession({
      baseUrl: this.baseUrl,
      userAgent: this.userAgent,
      cookie: this.cookie,
      email: this.email,
      password: this.password
    });

    this.sessionPromise = promise;
    try {
      this.sessionCookie = await promise;
      return this.sessionCookie;
    } finally {
      this.sessionPromise = null;
    }
  }

  private commonHeaders(cookie: string, referer?: string): Record<string, string> {
    const headers: Record<string, string> = {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "user-agent": this.userAgent
    };
    if (cookie) headers.cookie = cookie;
    if (referer) headers.referer = referer;
    return headers;
  }

  private async fetchHtml(url: string, init: RequestInit = {}): Promise<string> {
    const cookie = await this.getSessionCookie();
    const response = await fetchWithRetry(
      url,
      {
        ...init,
        headers: {
          ...this.commonHeaders(cookie, typeof init.referrer === "string" ? init.referrer : undefined),
          ...(init.headers as Record<string, string> | undefined)
        }
      },
      {
        retries: 5,
        minDelayMs: 500,
        maxDelayMs: 10_000,
        timeoutMs: 20_000
      }
    );

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`APIA HTTP ${response.status}: ${text.slice(0, 500)}`);
      }

    const html = await response.text();
    if (this.isLikelyLoggedOut(html) && (this.email || this.password)) {
      const refreshedCookie = await this.getSessionCookie(true);
      const retried = await fetchWithRetry(
        url,
        {
          ...init,
          headers: {
            ...this.commonHeaders(refreshedCookie, typeof init.referrer === "string" ? init.referrer : undefined),
            ...(init.headers as Record<string, string> | undefined)
          }
        },
        {
          retries: 2,
          minDelayMs: 500,
          maxDelayMs: 10_000,
          timeoutMs: 20_000
        }
      );
      if (!retried.ok) {
        const text = await retried.text();
        throw new Error(`APIA HTTP ${retried.status}: ${text.slice(0, 500)}`);
      }
      return retried.text();
    }

    return html;
  }

  private isLikelyLoggedOut(html: string): boolean {
    const hasResultsForm = /id="paginateForm"/i.test(html);
    const hasLogoutLink = /Logout\.aspx/i.test(html);
    return !hasResultsForm && !hasLogoutLink;
  }

  private extractAntiForgeryTokenFromForm(html: string, formId: string): string | null {
    const $ = load(html);
    const token = $(`#${formId} input[name="__RequestVerificationToken"]`).attr("value");
    return token || null;
  }

  private extractTotalPages(html: string): number {
    const $ = load(html);
    const optionCount = $("#CurrentIndex option").length;
    if (optionCount > 0) return optionCount;
    const text = $.root().text();
    const match = text.match(/\bof\s+(\d+)\b/i);
    if (!match) return 1;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private extractSelectedValue(html: string, selectId: string, fallback: string): string {
    const $ = load(html);
    const selected = $(`#${selectId} option[selected]`).attr("value");
    if (selected) return selected;
    const first = $(`#${selectId} option`).first().attr("value");
    return first || fallback;
  }

  private extractCards(html: string, base: URL): SnapshotCard[] {
    const $ = load(html);
    const cards: SnapshotCard[] = [];

    $(".snapshot-div").each((_idx, elem) => {
      const container = $(elem);
      const idAttr = container.attr("id") || "";
      if (!/^\d+$/.test(idAttr)) return;

      const snapshotDetails = container.find(".snapshot-bar-details").first().text().trim();
      const detailsMatch = snapshotDetails.match(/^(.*)\s+(\d+),\s*(.+)$/);
      const name = detailsMatch ? detailsMatch[1].trim() : snapshotDetails || null;
      const age = detailsMatch ? Number(detailsMatch[2]) : null;
      const country = detailsMatch ? detailsMatch[3].trim() : null;

      const profileHref =
        container.find(".snapshot-details-profile").first().attr("href") ||
        container.find(".snapshot-bar a").first().attr("data-transfer") ||
        null;

      const qualificationLines = container
        .find(".snapshot-qualifications > div")
        .map((_i, el) => $(el).text().trim())
        .get()
        .filter(Boolean);

      const nativeLanguageLine = qualificationLines.find((line) => line.startsWith("Native Language:"));
      const startLine = qualificationLines.find((line) => line.startsWith("Start:"));

      const imageUrl = container.find(".snapshot-pic img").first().attr("src") || null;

      cards.push({
        id: idAttr,
        name,
        age: Number.isFinite(age) ? age : null,
        country,
        profilePath: profileHref ? new URL(profileHref, base).toString() : null,
        nativeLanguage: nativeLanguageLine ? nativeLanguageLine.replace(/^Native Language:\s*/i, "") : null,
        programStatus: qualificationLines[0] || null,
        infantQualification: qualificationLines[1] || null,
        startWindow: startLine ? startLine.replace(/^Start:\s*/i, "") : null,
        imageUrl
      });
    });

    return cards;
  }

  private toRankedProfile(card: SnapshotCard, detail: JsonObject | null): RankedProfile {
    const detailHours = detail && typeof detail.childcareHours === "number" ? detail.childcareHours : null;
    const detailNativeLanguage = detail && typeof detail.nativeLanguage === "string" ? detail.nativeLanguage : null;
    return {
      source: "apia",
      id: card.id,
      name: card.name,
      country: card.country,
      age: card.age,
      languages: detailNativeLanguage
        ? [detailNativeLanguage]
        : card.nativeLanguage
          ? [card.nativeLanguage]
          : [],
      experienceMonths: detailHours ? Math.round(detailHours / 160) : null,
      profileUrl: card.profilePath,
      raw: {
        ...card,
        detail
      }
    };
  }

  private parseDetailHtml(html: string): JsonObject {
    const $ = load(html);
    const title = $("title").first().text().trim() || null;
    const bodyText =
      $("main").text().replace(/\s+/g, " ").trim() ||
      $("body").text().replace(/\s+/g, " ").trim();

    const smokerValue = extractField(bodyText, "Smoker");
    const driverValue = extractField(bodyText, "Driver");
    const drivingFrequency = extractField(bodyText, "Driving Frequency");
    const driverLicenseReceivedOn = extractField(bodyText, "Driver License Received On");
    const nativeLanguage = extractField(bodyText, "Native Language");
    const genderIdentity = extractField(bodyText, "Gender Identity");
    const petAllergies = extractField(bodyText, "Pet Allergies");
    const swimmer = extractField(bodyText, "Swimmer");
    const livedAwayFromHome = extractField(bodyText, "Lived Away From Home");
    const infantQualified = extractField(bodyText, "Infant Qualified");
    const arrivalWindow = extractField(bodyText, "Arrival Window");
    const childcareHours = extractChildcareHours(bodyText);
    const englishProficiencyLevel = extractEnglishLevel(bodyText);

    return {
      title,
      summaryText: bodyText.slice(0, 6000),
      smoker: parseYesNo(smokerValue),
      driver: parseYesNo(driverValue),
      drivingFrequency,
      driverLicenseReceivedOn,
      nativeLanguage: cleanApiaField(nativeLanguage),
      genderIdentity,
      petAllergies,
      swimmer,
      livedAwayFromHome: parseYesNo(livedAwayFromHome),
      infantQualified: parseYesNo(infantQualified),
      arrivalWindow: cleanApiaField(arrivalWindow),
      childcareHours,
      englishProficiencyLevel
    };
  }

  private async fetchDetails(cards: SnapshotCard[]): Promise<Map<string, JsonObject>> {
    const out = new Map<string, JsonObject>();
    if (!this.fetchDetailPages) return out;

    let index = 0;
    const workers = Array.from({ length: Math.max(1, this.detailConcurrency) }, async () => {
      while (index < cards.length) {
        const current = cards[index];
        index += 1;
        if (!current.profilePath) continue;
        try {
          const html = await this.fetchHtml(current.profilePath, {
            method: "GET",
            referrer: this.baseUrl
          });
          out.set(current.id, this.parseDetailHtml(html));
          await sleep(120);
        } catch {
          out.set(current.id, {
            detailError: true
          });
        }
      }
    });

    await Promise.all(workers);
    return out;
  }

  private async clearSearchFilters(currentHtml: string, pageUrl: URL): Promise<string> {
    if (!this.clearFilters) return currentHtml;

    const token = this.extractAntiForgeryTokenFromForm(currentHtml, "searchForm");
    if (!token) return currentHtml;

    const body = new URLSearchParams();
    body.set("__RequestVerificationToken", token);

    const clearUrl = new URL("/AuPair/ClearFilterData", pageUrl).toString();
    const html = await this.fetchHtml(clearUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: body.toString(),
      referrer: pageUrl.toString()
    });
    return html;
  }

  private async fetchPageByIndex(
    pageUrl: URL,
    currentHtml: string,
    pageIndex: number
  ): Promise<string> {
    const token = this.extractAntiForgeryTokenFromForm(currentHtml, "paginateForm");
    if (!token) {
      throw new Error("Could not find paginate anti-forgery token");
    }

    const pageSize = this.extractSelectedValue(currentHtml, "PageSize", "100");
    const sortLogic = this.extractSelectedValue(currentHtml, "SortLogic", "No Sorting");

    const body = new URLSearchParams();
    body.set("__RequestVerificationToken", token);
    body.set("CurrentIndex", String(pageIndex));
    body.set("PageSize", pageSize);
    body.set("SortLogic", sortLogic);

    const paginateUrl = new URL("/AuPair/PaginateData", pageUrl).toString();
    const html = await this.fetchHtml(paginateUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8"
      },
      body: body.toString(),
      referrer: pageUrl.toString()
    });

    return html;
  }

  async run({ maxPages = 200 }: { maxPages?: number } = {}): Promise<AdapterRunResult> {
    if (!this.enabled()) {
      return {
        source: "apia",
        profiles: [],
        skipped: true,
        reason: "Missing APIA_URL"
      };
    }

    if (!this.cookie) {
      return {
        source: "apia",
        profiles: [],
        skipped: true,
        reason: "Missing APIA_COOKIE"
      };
    }

    try {
      const pageUrl = new URL(this.baseUrl);
      let html = await this.fetchHtml(pageUrl.toString(), { method: "GET" });
      if (this.isLikelyLoggedOut(html)) {
        throw new Error("APIA session appears logged out or unauthorized");
      }

      html = await this.clearSearchFilters(html, pageUrl);
      if (this.isLikelyLoggedOut(html)) {
        throw new Error("APIA session appears logged out after clear-filter request");
      }

      const allCards: SnapshotCard[] = [];
      const firstPageCards = this.extractCards(html, pageUrl);
      allCards.push(...firstPageCards);

      const totalPages = Math.min(this.extractTotalPages(html), maxPages);
      let currentHtml = html;

      for (let pageIndex = 2; pageIndex <= totalPages; pageIndex += 1) {
        currentHtml = await this.fetchPageByIndex(pageUrl, currentHtml, pageIndex);
        const cards = this.extractCards(currentHtml, pageUrl);
        allCards.push(...cards);
      }

      const details = await this.fetchDetails(allCards);
      const profiles = allCards.map((card) => this.toRankedProfile(card, details.get(card.id) || null));

      return {
        source: "apia",
        profiles,
        skipped: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuthError = /unauthorized|logged out|401|forgery token/i.test(message);
      if (this.skipOnAuthError && isAuthError) {
        return {
          source: "apia",
          profiles: [],
          skipped: true,
          reason: `Skipped due to auth error: ${message}`,
          errorCode: "apia_auth"
        };
      }
      if (isAuthError) {
        throw new Error(`APIA auth error: ${message}`);
      }
      throw error;
    }
  }
}
