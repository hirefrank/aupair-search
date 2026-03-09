import { refreshCognitoIdToken } from "../auth/cognito.js";
import { fetchWithRetry } from "../lib/http.js";
import {
  getByPath,
  isTokenFresh,
  normalizeCountry,
  normalizeName,
  parseJsonSafe
} from "../lib/utils.js";
import type { AdapterRunResult, JsonObject, RankedProfile } from "../types.js";

const DEFAULT_API_BASE =
  "https://4bzk4o198j.execute-api.us-east-1.amazonaws.com/prod/v2/matching/search/au-pairs";

export class CultureCareAdapter {
  private env: NodeJS.ProcessEnv;
  private apiBase: string;
  private pageSize: number;
  private randomSeed: string;
  private resultPath: string;
  private nextTokenPath: string;
  private searchBody: JsonObject | null;
  private cachedBearer: string | null;
  private skipOnAuthError: boolean;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.env = env;
    this.apiBase = env.CULTURECARE_API_BASE || DEFAULT_API_BASE;
    this.pageSize = Number(env.CULTURECARE_PAGE_SIZE || 50);
    this.randomSeed = env.CULTURECARE_RANDOM_SEED || "43774025";
    this.resultPath = env.CULTURECARE_RESULTS_PATH || "items";
    this.nextTokenPath = env.CULTURECARE_NEXT_TOKEN_PATH || "nextToken";
    this.searchBody = this.loadSearchBody();
    this.cachedBearer = null;
    this.skipOnAuthError = String(env.CULTURECARE_SKIP_ON_AUTH_ERROR || "false") === "true";
  }

  enabled(): boolean {
    return this.searchBody !== null;
  }

  private loadSearchBody(): JsonObject | null {
    const raw = this.env.CULTURECARE_SEARCH_BODY_JSON;
    if (raw === undefined || raw === null || raw === "") return null;
    return parseJsonSafe<JsonObject | null>(raw, null);
  }

  private async getBearerToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const { forceRefresh = false } = options;

    const cached = this.cachedBearer;
    if (cached && isTokenFresh(cached, 120)) return cached;

    const direct = this.env.CULTURECARE_BEARER;
    if (!forceRefresh && direct && isTokenFresh(direct, 120)) return direct;

    const refreshToken = this.env.CULTURECARE_REFRESH_TOKEN;
    const clientId = this.env.CULTURECARE_COGNITO_CLIENT_ID || "3jsqobi851prmu958rn4b0t26e";
    const region = this.env.CULTURECARE_COGNITO_REGION || "us-east-1";

    if (!refreshToken) {
      if (direct) {
        return direct;
      }
      throw new Error("No CULTURECARE_BEARER or CULTURECARE_REFRESH_TOKEN found");
    }

    const refreshed = await refreshCognitoIdToken({
      region,
      clientId,
      refreshToken
    });
    this.cachedBearer = refreshed.idToken;
    return refreshed.idToken;
  }

  private async fetchPageWithToken(url: URL, token: string): Promise<JsonObject> {
    const response = await fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
          accept: "application/json"
        },
        body: JSON.stringify(this.searchBody)
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
      throw new Error(`CultureCare HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = (await response.json()) as JsonObject;
    return data;
  }

  private async fetchPage(nextToken: string | null = null): Promise<JsonObject> {
    const bearer = await this.getBearerToken();

    const url = new URL(this.apiBase);
    url.searchParams.set("pageSize", String(this.pageSize));
    url.searchParams.set("randomSeed", this.randomSeed);
    if (nextToken) url.searchParams.set("nextToken", nextToken);

    try {
      return await this.fetchPageWithToken(url, bearer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("HTTP 401")) throw error;
      if (!this.env.CULTURECARE_REFRESH_TOKEN) {
        throw new Error(
          "Culture Care returned 401. Your bearer token is likely expired; set a fresh CULTURECARE_BEARER or CULTURECARE_REFRESH_TOKEN."
        );
      }
      this.cachedBearer = null;
      const refreshedBearer = await this.getBearerToken({ forceRefresh: true });
      return this.fetchPageWithToken(url, refreshedBearer);
    }
  }

  private estimateAge(dateOfBirth: string): number | null {
    const birth = new Date(dateOfBirth);
    if (Number.isNaN(birth.getTime())) return null;
    const now = new Date();
    let age = now.getUTCFullYear() - birth.getUTCFullYear();
    const monthDiff = now.getUTCMonth() - birth.getUTCMonth();
    const dayDiff = now.getUTCDate() - birth.getUTCDate();
    if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;
    return age >= 0 ? age : null;
  }

  private normalize(profile: JsonObject): RankedProfile {
    const age =
      typeof profile.age === "number"
        ? profile.age
        : typeof profile.dateOfBirth === "string"
          ? this.estimateAge(profile.dateOfBirth)
          : null;

    const languages = Array.isArray(profile.languages)
      ? profile.languages
          .map((entry) => {
            if (typeof entry === "string") return entry;
            if (entry && typeof entry === "object") {
              const e = entry as Record<string, unknown>;
              return (
                (typeof e.language === "string" ? e.language : null) ||
                (typeof e.languageName === "string" ? e.languageName : null) ||
                (typeof e.name === "string" ? e.name : null)
              );
            }
            return null;
          })
          .filter((v): v is string => Boolean(v))
      : [];

    const experienceMonths =
      typeof profile.childcareExperienceMonths === "number"
        ? profile.childcareExperienceMonths
        : typeof profile.approvedChildcareHours === "number"
          ? Math.round(profile.approvedChildcareHours / 160)
          : typeof profile.experienceMonths === "number"
            ? profile.experienceMonths
            : null;

    return {
      source: "culturecare",
      id: typeof profile.id === "string" ? profile.id : null,
      name: normalizeName(profile.firstName, profile.lastName, profile.name || profile.auPairName),
      country: normalizeCountry(profile),
      age,
      languages,
      experienceMonths,
      profileUrl: typeof profile.profileUrl === "string" ? profile.profileUrl : null,
      raw: profile
    };
  }

  async run({ maxPages = 200 }: { maxPages?: number } = {}): Promise<AdapterRunResult> {
    if (!this.enabled()) {
      return {
        source: "culturecare",
        profiles: [],
        skipped: true,
        reason: "Missing CULTURECARE_SEARCH_BODY_JSON"
      };
    }

    try {
      const profiles: RankedProfile[] = [];
      let nextToken: string | null = null;
      let pages = 0;

      do {
        const json = await this.fetchPage(nextToken);

        const itemsPrimary = getByPath<unknown[] | null>(json, this.resultPath, null);
        const itemsFallbackA = getByPath<unknown[] | null>(json, "items", null);
        const itemsFallbackB = getByPath<unknown[] | null>(json, "data.auPairs", null);
        const itemsFallbackC = getByPath<unknown[] | null>(json, "auPairs", null);
        const items =
          (Array.isArray(itemsPrimary) ? itemsPrimary : null) ||
          (Array.isArray(itemsFallbackA) ? itemsFallbackA : null) ||
          (Array.isArray(itemsFallbackB) ? itemsFallbackB : null) ||
          (Array.isArray(itemsFallbackC) ? itemsFallbackC : null) ||
          [];

        nextToken =
          getByPath<string | null>(json, this.nextTokenPath, null) ||
          getByPath<string | null>(json, "nextToken", null) ||
          getByPath<string | null>(json, "data.nextToken", null);

        for (const item of items) {
          if (!item || typeof item !== "object") continue;
          profiles.push(this.normalize(item as JsonObject));
        }

        pages += 1;
        if (pages >= maxPages) break;
      } while (nextToken);

      return {
        source: "culturecare",
        profiles,
        skipped: false
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isAuthError = message.includes("401") || message.includes("token") || message.includes("auth");
      if (this.skipOnAuthError && isAuthError) {
        return {
          source: "culturecare",
          profiles: [],
          skipped: true,
          reason: `Skipped due to auth error: ${message}`
        };
      }
      throw error;
    }
  }
}
