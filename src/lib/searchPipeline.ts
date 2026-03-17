import { CultureCareAdapter } from "../adapters/culturecare.js";
import { ApiaAdapter } from "../adapters/apia.js";
import { dedupeProfiles, parseJsonSafe, scoreProfile } from "./utils.js";
import type { AdapterRunResult, Preferences, RankedProfile } from "../types.js";

export type SearchBySource = {
  culturecare: AdapterRunResult;
  apia: AdapterRunResult;
};

export type SearchRunResult = {
  merged: RankedProfile[];
  bySource: SearchBySource;
  thresholdMatches: RankedProfile[];
  threshold: number;
  effectiveThreshold: number;
  scoreThresholdApplied: boolean;
  preferences: Preferences | null;
};

type MaturityGate = {
  minAge: number;
  minExperienceMonths: number;
  educationKeywords: string[];
  maturityKeywords: string[];
  requiredSignals: number;
};

type MatchCriteria = {
  minAge: number;
  requireFemale: boolean;
  excludedCountries: string[];
  minEnglishLevel: number;
  arrivalEarliest: Date | null;
  arrivalLatest: Date | null;
  childAges: number[];
  requiredPets: string[];
  allowedDrivingFrequencies: string[];
  minDrivingYears: number;
  requireSwimmingSupervision: boolean;
  requireLivedAwayFromHome: boolean;
  maturityGate: MaturityGate | null;
};

type MatchableSource = "culturecare" | "apia";

function asBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function asNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asCsvList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return parsed.length ? parsed : fallback;
}

function asCsvNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length ? parsed : fallback;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed;
}

function parseMonthYear(value: string): Date | null {
  const match = value.match(/^(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const year = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

function parseDrivingYears(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (raw.includes("less than 1")) return 0;

  const plusMatch = raw.match(/(\d+)\s*\+\s*years?/i);
  if (plusMatch) return Number(plusMatch[1]);

  const rangeMatch = raw.match(/(\d+)\s*[-–]\s*(\d+)\s*years?/i);
  if (rangeMatch) return Number(rangeMatch[1]);

  const singleMatch = raw.match(/(\d+)\s*years?/i);
  if (singleMatch) return Number(singleMatch[1]);

  return null;
}

function preferredAgeIncludes(childAge: number, rangeLabel: string): boolean {
  const raw = rangeLabel.trim().toLowerCase();
  if (!raw) return false;

  const rangeMatch = raw.match(/(\d+)\s*[-–]\s*(\d+)/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    return childAge >= min && childAge <= max;
  }

  const plusMatch = raw.match(/(\d+)\s*\+/);
  if (plusMatch) {
    return childAge >= Number(plusMatch[1]);
  }

  const underMatch = raw.match(/under\s*(\d+)/);
  if (underMatch) {
    return childAge < Number(underMatch[1]);
  }

  const exactMatch = raw.match(/^(\d+)\s*years?/);
  if (exactMatch) {
    return childAge === Number(exactMatch[1]);
  }

  return false;
}

function rawDetail(profile: RankedProfile): Record<string, unknown> | null {
  const raw = profile.raw as Record<string, unknown>;
  if (raw.detail && typeof raw.detail === "object") return raw.detail as Record<string, unknown>;
  return null;
}

function rawField(profile: RankedProfile, field: string): unknown {
  const raw = profile.raw as Record<string, unknown>;
  if (raw[field] !== undefined) return raw[field];
  const detail = rawDetail(profile);
  if (detail && detail[field] !== undefined) return detail[field];
  return undefined;
}

function rawStringField(profile: RankedProfile, field: string): string {
  const value = rawField(profile, field);
  return typeof value === "string" ? value : "";
}

function rawBooleanField(profile: RankedProfile, field: string): boolean | null {
  const value = rawField(profile, field);
  return typeof value === "boolean" ? value : null;
}

function sourceOf(profile: RankedProfile): MatchableSource {
  return profile.source === "apia" ? "apia" : "culturecare";
}

function apiaNeedsDetailFetch(criteria: MatchCriteria): boolean {
  return (
    criteria.requireFemale ||
    criteria.requiredPets.length > 0 ||
    criteria.allowedDrivingFrequencies.length > 0 ||
    criteria.minDrivingYears > 0 ||
    criteria.requireSwimmingSupervision ||
    criteria.requireLivedAwayFromHome
  );
}

function getEnglishLevel(profile: RankedProfile): number | null {
  const english = rawStringField(profile, "englishProficiencyLevel");
  if (!english) return null;
  const match = english.match(/level\s*(\d+)/i);
  if (!match) return null;
  const level = Number(match[1]);
  return Number.isFinite(level) ? level : null;
}

function isLikelyFemale(profile: RankedProfile): boolean {
  const gender = rawStringField(profile, "genderIdentity");
  if (gender) return gender.trim().toLowerCase().startsWith("f");
  return false;
}

function getArrivalWindow(profile: RankedProfile): { start: Date | null; end: Date | null } {
  const raw = profile.raw as Record<string, unknown>;

  const ccStart = typeof raw.earliestTravelDate === "string" ? parseDate(raw.earliestTravelDate) : null;
  const ccEnd = typeof raw.latestTravelDate === "string" ? parseDate(raw.latestTravelDate) : null;
  if (ccStart || ccEnd) {
    return {
      start: ccStart,
      end: ccEnd || ccStart
    };
  }

  const startWindow = typeof raw.startWindow === "string" ? raw.startWindow : "";
  const parts = startWindow.split("-").map((part) => part.trim());
  if (parts.length === 2) {
    return {
      start: parseMonthYear(parts[0]),
      end: parseMonthYear(parts[1])
    };
  }

  return { start: null, end: null };
}

function profileTextLower(profile: RankedProfile): string {
  const raw = profile.raw as Record<string, unknown>;
  const parts: string[] = [];
  // CultureCare fields
  if (typeof raw.aboutSelfAndInterests === "string") parts.push(raw.aboutSelfAndInterests);
  if (typeof raw.summaryText === "string") parts.push(raw.summaryText);
  if (Array.isArray(raw.personalityTraits)) {
    for (const trait of raw.personalityTraits) {
      if (typeof trait === "string") parts.push(trait);
    }
  }
  // APIA detail fields
  if (raw.detail && typeof raw.detail === "object") {
    const detail = raw.detail as Record<string, unknown>;
    if (typeof detail.summaryText === "string") parts.push(detail.summaryText);
    if (typeof detail.title === "string") parts.push(detail.title);
  }
  return parts.join(" ").toLowerCase();
}

/** @internal Exported for testing */
export function matchesWordBoundary(text: string, keyword: string): boolean {
  const pattern = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  return pattern.test(text);
}

/** @internal Exported for testing */
export { type MaturityGate };

/** @internal Exported for testing */
export function passesMaturityGate(profile: RankedProfile, gate: MaturityGate): boolean {
  const raw = profile.raw as Record<string, unknown>;
  let signals = 0;

  // Signal 1: Sufficient childcare experience
  const experienceMonths = typeof profile.experienceMonths === "number" ? profile.experienceMonths : 0;
  if (experienceMonths >= gate.minExperienceMonths) signals++;

  // Signal 2: Education level suggests college/university
  const education = typeof raw.educationLevel === "string" ? raw.educationLevel.toLowerCase() : "";
  if (gate.educationKeywords.some((kw) => education.includes(kw))) signals++;

  // Signal 3: Profile text or traits contain maturity keywords (require 2+ matches)
  const text = profileTextLower(profile);
  const keywordHits = gate.maturityKeywords.filter((kw) => matchesWordBoundary(text, kw)).length;
  if (keywordHits >= 2) signals++;

  return signals >= gate.requiredSignals;
}

/** @internal Exported for testing */
export function passesAgeCriteria(
  profile: RankedProfile,
  criteria: Pick<MatchCriteria, "minAge" | "maturityGate">
): boolean {
  if (typeof profile.age !== "number") return false;
  if (profile.age < (criteria.maturityGate?.minAge ?? criteria.minAge)) return false;
  if (profile.age < criteria.minAge) {
    return criteria.maturityGate ? passesMaturityGate(profile, criteria.maturityGate) : false;
  }
  return true;
}

/** @internal Exported for testing */
export function matchesCriteria(profile: RankedProfile, criteria: MatchCriteria): boolean {
  const raw = profile.raw as Record<string, unknown>;
  const source = sourceOf(profile);

  if (!passesAgeCriteria(profile, criteria)) return false;

  const femaleOk = !criteria.requireFemale || isLikelyFemale(profile);
  if (!femaleOk) return false;

  const country = typeof profile.country === "string" ? profile.country.trim().toLowerCase() : "";
  if (country && criteria.excludedCountries.includes(country)) return false;

  if (criteria.minEnglishLevel > 0) {
    const level = getEnglishLevel(profile);
    if (source === "culturecare") {
      if (level === null || level < criteria.minEnglishLevel) return false;
    } else if (level !== null && level < criteria.minEnglishLevel) {
      return false;
    }
  }

  if (criteria.arrivalEarliest || criteria.arrivalLatest) {
    const window = getArrivalWindow(profile);
    if (!window.start || !window.end) return false;
    if (criteria.arrivalEarliest && window.end < criteria.arrivalEarliest) return false;
    if (criteria.arrivalLatest && window.start > criteria.arrivalLatest) return false;
  }

  if (criteria.childAges.length > 0) {
    const rawPreferred = rawField(profile, "preferredAges");
    const preferredAges = Array.isArray(rawPreferred)
      ? rawPreferred.filter((item): item is string => typeof item === "string")
      : [];
    if (source === "culturecare" && preferredAges.length === 0) return false;
    if (preferredAges.length > 0) {
      const childAgesOk = criteria.childAges.every((childAge) =>
        preferredAges.some((rangeLabel) => preferredAgeIncludes(childAge, rangeLabel))
      );
      if (!childAgesOk) return false;
    }
  }

  if (criteria.requiredPets.length > 0) {
    const rawPets = rawField(profile, "preferredPets");
    if (Array.isArray(rawPets)) {
      const pets = rawPets
        .map((pet) => (typeof pet === "string" ? pet.trim().toLowerCase() : ""))
        .filter(Boolean);
      const petsOk = criteria.requiredPets.every((requiredPet) => pets.includes(requiredPet));
      if (!petsOk) return false;
    } else if (source === "culturecare") {
      return false;
    }

    const detail = rawDetail(profile);
    if (detail && typeof detail.petAllergies === "string") {
      const allergies = detail.petAllergies.toLowerCase();
      if (criteria.requiredPets.includes("dogs") && allergies.includes("dog")) return false;
    }
  }

  if (criteria.allowedDrivingFrequencies.length > 0) {
    const drivingFrequency = rawStringField(profile, "drivingFrequency").trim().toLowerCase();
    if (source === "culturecare" && !drivingFrequency) return false;
    if (source === "apia") {
      const canDrive = rawBooleanField(profile, "driver");
      if (canDrive === false) return false;
    } else if (drivingFrequency) {
      const frequencyOk = criteria.allowedDrivingFrequencies.includes(drivingFrequency);
      if (!frequencyOk) return false;
    }
  }

  if (criteria.minDrivingYears > 0) {
    let yearsDriving = parseDrivingYears(rawField(profile, "yearsDriving"));
    if (yearsDriving === null) {
      const detail = rawDetail(profile);
      if (detail && typeof detail.driverLicenseReceivedOn === "string") {
        const dt = new Date(detail.driverLicenseReceivedOn);
        if (Number.isFinite(dt.getTime())) {
          yearsDriving = Math.floor((Date.now() - dt.getTime()) / (1000 * 60 * 60 * 24 * 365.25));
        }
      }
    }
    if (source === "culturecare" && yearsDriving === null) return false;
    if (yearsDriving !== null && yearsDriving < criteria.minDrivingYears) return false;
  }

  if (criteria.requireSwimmingSupervision) {
    const ccSwim = rawField(profile, "okToSuperviseSwimmingChildren");
    if (ccSwim === false) return false;
    if (ccSwim === undefined) {
      const detail = rawDetail(profile);
      if (detail && typeof detail.swimmer === "string") {
        if (/^no$/i.test(detail.swimmer.trim())) return false;
      } else if (source === "culturecare") {
        return false;
      }
    } else if (ccSwim !== true && source === "culturecare") {
      return false;
    }
  }

  if (criteria.requireLivedAwayFromHome) {
    const livedAway = rawField(profile, "livedAwayFromHome");
    if (livedAway === false) return false;
    if (source === "culturecare" && livedAway !== true) return false;
  }

  return true;
}

function rankProfiles(profiles: RankedProfile[], prefs: Preferences | null): RankedProfile[] {
  const ranked = profiles.map((profile) => ({
    ...profile,
    score: scoreProfile(profile, prefs)
  }));
  ranked.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return ranked;
}

function skippedResult(source: string, reason: string): AdapterRunResult {
  return {
    source,
    profiles: [],
    skipped: true,
    reason
  };
}

export async function runSearchPipeline(
  env: NodeJS.ProcessEnv = process.env,
  options: { maxPages?: number } = {}
): Promise<SearchRunResult> {
  const maxPages = options.maxPages ?? asNumber(env.MAX_PAGES, 200);
  const prefs = parseJsonSafe<Preferences | null>(env.PREFERENCES_JSON, null);
  const threshold = asNumber(env.MATCH_SCORE_THRESHOLD, 0);
  const mainMinAge = asNumber(env.MATCH_MIN_AGE, 22);
  const maturityMinAge = asNumber(env.MATCH_MIN_AGE_MATURE, 0);
  const maturityGate: MaturityGate | null =
    maturityMinAge > 0 && maturityMinAge < mainMinAge
      ? {
          minAge: maturityMinAge,
          minExperienceMonths: asNumber(env.MATCH_MATURITY_MIN_EXPERIENCE_MONTHS, 18),
          educationKeywords: asCsvList(env.MATCH_MATURITY_EDUCATION_KEYWORDS, [
            "university",
            "college",
            "bachelor",
            "master",
            "degree"
          ]),
          maturityKeywords: asCsvList(env.MATCH_MATURITY_KEYWORDS, [
            "responsible",
            "independent",
            "organized",
            "mature",
            "reliable",
            "professional",
            "dedicated"
          ]),
          requiredSignals: Math.max(1, asNumber(env.MATCH_MATURITY_REQUIRED_SIGNALS, 2))
        }
      : null;

  const criteria: MatchCriteria = {
    minAge: mainMinAge,
    requireFemale: asBoolean(env.MATCH_REQUIRE_FEMALE, true),
    excludedCountries: asCsvList(env.MATCH_EXCLUDED_COUNTRIES, []),
    minEnglishLevel: asNumber(env.MATCH_MIN_ENGLISH_LEVEL, 6),
    arrivalEarliest: parseDate(env.MATCH_ARRIVAL_EARLIEST || "2026-06-01"),
    arrivalLatest: parseDate(env.MATCH_ARRIVAL_LATEST || "2026-07-31"),
    childAges: asCsvNumberList(env.MATCH_CHILD_AGES, [3, 5]),
    requiredPets: asCsvList(env.MATCH_REQUIRED_PETS, ["dogs"]),
    allowedDrivingFrequencies: asCsvList(env.MATCH_ALLOWED_DRIVING_FREQUENCIES, ["daily", "weekly"]),
    minDrivingYears: asNumber(env.MATCH_MIN_DRIVING_YEARS, 1),
    requireSwimmingSupervision: asBoolean(env.MATCH_REQUIRE_SWIMMING_SUPERVISION, true),
    requireLivedAwayFromHome: asBoolean(env.MATCH_REQUIRE_LIVED_AWAY_FROM_HOME, true),
    maturityGate
  };

  const cultureCare = new CultureCareAdapter(env);
  const apia = new ApiaAdapter(env);

  const enableCultureCare = asBoolean(env.ENABLE_CULTURECARE, true);
  const enableApia = asBoolean(env.ENABLE_APIA, false);
  const apiaFetchDetails = asBoolean(env.APIA_FETCH_DETAILS, true);

  const [cultureCareResult, apiaResult] = await Promise.all([
    enableCultureCare
      ? cultureCare.run({ maxPages })
      : Promise.resolve(skippedResult("culturecare", "Disabled via ENABLE_CULTURECARE")),
    !enableApia
      ? Promise.resolve(skippedResult("apia", "Disabled via ENABLE_APIA"))
      : !apiaFetchDetails && apiaNeedsDetailFetch(criteria)
        ? Promise.resolve(
            skippedResult(
              "apia",
              "APIA_FETCH_DETAILS must be true when APIA is enabled with female, pets, driving, swimming, or lived-away hard filters."
            )
          )
        : apia.run({ maxPages })
  ]);

  const merged = rankProfiles(dedupeProfiles([...cultureCareResult.profiles, ...apiaResult.profiles]), prefs);

  const scoreThresholdApplied = prefs !== null;
  const effectiveThreshold = scoreThresholdApplied ? threshold : 0;

  const thresholdMatches = merged.filter(
    (profile) => (profile.score ?? 0) >= effectiveThreshold && matchesCriteria(profile, criteria)
  );

  return {
    merged,
    bySource: {
      culturecare: cultureCareResult,
      apia: apiaResult
    },
    thresholdMatches,
    threshold,
    effectiveThreshold,
    scoreThresholdApplied,
    preferences: prefs
  };
}
