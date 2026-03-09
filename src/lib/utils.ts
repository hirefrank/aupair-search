import type { Preferences, RankedProfile } from "../types.js";

export function getByPath<T>(obj: unknown, path: string, fallback: T): T {
  if (!path) return fallback;
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== "object" || !(key in (cur as Record<string, unknown>))) {
      return fallback;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return (cur as T) ?? fallback;
}

export function parseJsonSafe<T>(value: string | undefined | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function normalizeName(
  firstName: unknown,
  lastName: unknown,
  fallbackName: unknown
): string | null {
  const full = [firstName, lastName]
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .join(" ")
    .trim();
  if (full) return full;
  if (typeof fallbackName === "string" && fallbackName.trim()) return fallbackName.trim();
  return null;
}

export function normalizeCountry(profile: Record<string, unknown>): string | null {
  return (
    (typeof profile.country === "string" ? profile.country : null) ||
    (typeof profile.nationality === "string" ? profile.nationality : null) ||
    (typeof profile.countryOfBirth === "string" ? profile.countryOfBirth : null) ||
    (typeof profile.homeCountry === "string" ? profile.homeCountry : null) ||
    null
  );
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const chunks = token.split(".");
  if (chunks.length < 2) return null;
  const payload = chunks[1].replace(/-/g, "+").replace(/_/g, "/");
  const pad = payload.length % 4;
  const padded = pad === 0 ? payload : payload + "=".repeat(4 - pad);
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function isTokenFresh(token: string, minSeconds = 120): boolean {
  const payload = decodeJwtPayload(token);
  const exp = payload?.exp;
  if (typeof exp !== "number") return false;
  const now = Math.floor(Date.now() / 1000);
  return exp - now > minSeconds;
}

export function csvEscape(value: unknown): string {
  if (value == null) return "";
  const raw = String(value);
  if (/[,"\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function toCsv(rows: RankedProfile[]): string {
  if (!rows.length) return "";
  const headers = [
    "source",
    "id",
    "name",
    "country",
    "age",
    "languages",
    "experienceMonths",
    "profileUrl",
    "score"
  ];
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.source,
        row.id,
        row.name,
        row.country,
        row.age,
        row.languages.join("|"),
        row.experienceMonths,
        row.profileUrl,
        row.score ?? 0
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  return lines.join("\n");
}

export function dedupeProfiles(rows: RankedProfile[]): RankedProfile[] {
  const seen = new Map<string, RankedProfile>();
  for (const row of rows) {
    const key = row.id
      ? `${row.source}:${row.id.toLowerCase()}`
      : `${String(row.profileUrl || "").trim().toLowerCase()}|${String(row.name || "")
          .trim()
          .toLowerCase()}|${String(row.country || "")
          .trim()
          .toLowerCase()}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

function normalizeLowerList(values: string[] | undefined): string[] {
  return (values || []).map((v) => v.toLowerCase().trim()).filter(Boolean);
}

function profileText(profile: RankedProfile): string {
  const raw = profile.raw as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof raw.aboutSelfAndInterests === "string") parts.push(raw.aboutSelfAndInterests);
  if (typeof raw.summaryText === "string") parts.push(raw.summaryText);
  if (raw.detail && typeof raw.detail === "object") {
    const detail = raw.detail as Record<string, unknown>;
    if (typeof detail.summaryText === "string") parts.push(detail.summaryText);
    if (typeof detail.title === "string") parts.push(detail.title);
  }
  return parts.join(" ").toLowerCase();
}

function parseCultureCareDate(rawValue: unknown): Date | null {
  if (typeof rawValue !== "string") return null;
  const dt = new Date(rawValue);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

function parseMonthYear(value: string): Date | null {
  const m = value.match(/^(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, 1));
}

function parseAgency2StartWindow(raw: Record<string, unknown>): { start: Date | null; end: Date | null } {
  const value = typeof raw.startWindow === "string" ? raw.startWindow : null;
  if (!value) return { start: null, end: null };
  const parts = value.split("-").map((x) => x.trim());
  if (parts.length !== 2) return { start: null, end: null };
  return {
    start: parseMonthYear(parts[0]),
    end: parseMonthYear(parts[1])
  };
}

function getStartWindow(profile: RankedProfile): { start: Date | null; end: Date | null } {
  const raw = profile.raw as Record<string, unknown>;
  const ccStart = parseCultureCareDate(raw.earliestTravelDate);
  const ccEnd = parseCultureCareDate(raw.latestTravelDate);
  if (ccStart || ccEnd) {
    return { start: ccStart, end: ccEnd };
  }
  return parseAgency2StartWindow(raw);
}

function hasLanguage(profile: RankedProfile, language: string): boolean | null {
  const target = language.toLowerCase();
  if (profile.languages.length > 0) {
    const langs = profile.languages.map((l) => l.toLowerCase());
    if (langs.includes(target)) return true;
  }

  const raw = profile.raw as Record<string, unknown>;
  const detail = raw.detail && typeof raw.detail === "object" ? (raw.detail as Record<string, unknown>) : null;
  if (detail && typeof detail.nativeLanguage === "string") {
    const nativeLanguage = detail.nativeLanguage.toLowerCase();
    if (nativeLanguage.includes(target)) return true;
  }
  const englishLevel = raw.englishProficiencyLevel;
  if (target === "english" && typeof englishLevel === "string") {
    if (/basic|poor/i.test(englishLevel)) return false;
    return true;
  }

  const text = profileText(profile);
  if (target === "english") {
    if (/fluent english|advanced english|english level|speak english/i.test(text)) return true;
    return null;
  }

  return null;
}

function parseYearsDriving(raw: Record<string, unknown>): number | null {
  const value = typeof raw.yearsDriving === "string" ? raw.yearsDriving : null;
  if (!value) return null;
  if (/5\+/i.test(value)) return 5;
  const m = value.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return Number(m[1]);
  const single = value.match(/(\d+)/);
  return single ? Number(single[1]) : null;
}

function parseYearsFromDate(value: string): number | null {
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return null;
  const now = new Date();
  const years = (now.getTime() - dt.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (!Number.isFinite(years) || years < 0) return null;
  return years;
}

function hasPreferredTrait(profile: RankedProfile, trait: string): boolean {
  const raw = profile.raw as Record<string, unknown>;
  const traitLower = trait.toLowerCase();
  if (Array.isArray(raw.personalityTraits)) {
    const traits = raw.personalityTraits.filter((t): t is string => typeof t === "string");
    if (traits.some((t) => t.toLowerCase().includes(traitLower))) return true;
  }
  const text = profileText(profile);
  return text.includes(traitLower);
}

function isLikelyFemale(profile: RankedProfile): boolean | null {
  const raw = profile.raw as Record<string, unknown>;
  if (typeof raw.genderIdentity === "string") {
    const g = raw.genderIdentity.toLowerCase();
    if (g.startsWith("f")) return true;
    if (g.startsWith("m")) return false;
  }
  const text = profileText(profile);
  if (/\bfemale\b/.test(text)) return true;
  if (/\bmale\b/.test(text)) return false;
  return null;
}

function smokingSignal(profile: RankedProfile): boolean | null {
  const raw = profile.raw as Record<string, unknown>;
  if (raw.detail && typeof raw.detail === "object") {
    const detail = raw.detail as Record<string, unknown>;
    if (typeof detail.smoker === "boolean") {
      return !detail.smoker;
    }
  }
  if (typeof raw.nonSmoker === "boolean") {
    return raw.nonSmoker;
  }
  const text = profileText(profile);
  if (/non[-\s]?smoker|does not smoke/.test(text)) return true;
  if (/smoker|smokes/.test(text)) return false;
  return null;
}

function dogFriendlySignal(profile: RankedProfile): boolean | null {
  const raw = profile.raw as Record<string, unknown>;
  if (raw.detail && typeof raw.detail === "object") {
    const detail = raw.detail as Record<string, unknown>;
    if (typeof detail.petAllergies === "string") {
      const petAllergies = detail.petAllergies.toLowerCase();
      if (petAllergies.includes("none")) return true;
      if (petAllergies.includes("dog")) return false;
    }
  }
  if (Array.isArray(raw.preferredPets)) {
    const pets = raw.preferredPets.filter((p): p is string => typeof p === "string");
    if (pets.some((p) => p.toLowerCase() === "dogs" || p.toLowerCase() === "dog")) return true;
  }
  const text = profileText(profile);
  if (/dog[-\s]?friendly|love dogs|comfortable with dogs|ok with dogs/.test(text)) return true;
  if (/allergic to dogs|not comfortable with dogs/.test(text)) return false;
  return null;
}

export function scoreProfile(profile: RankedProfile, prefs: Preferences | null): number {
  if (!prefs) return 0;
  let score = 0;

  const preferredCountries = normalizeLowerList(prefs.preferredCountries);
  const acceptableCountries = normalizeLowerList(prefs.acceptableCountries);
  const countryValue = profile.country?.toLowerCase() || null;

  if (countryValue && preferredCountries.length && preferredCountries.includes(countryValue)) {
    score += 30;
  } else if (countryValue && acceptableCountries.length && acceptableCountries.includes(countryValue)) {
    score += 15;
  }

  if (typeof profile.age === "number") {
    if (typeof prefs.minAge === "number" && profile.age < prefs.minAge) {
      return -1000;
    }
    if (typeof prefs.maxAge === "number" && profile.age > prefs.maxAge) {
      score -= 20;
    }
    if (typeof prefs.minAge === "number" && typeof prefs.maxAge === "number") {
      if (profile.age >= prefs.minAge && profile.age <= prefs.maxAge) score += 20;
    }
    if (typeof prefs.idealMinAge === "number" && profile.age >= prefs.idealMinAge) {
      score += 10;
    }
  }

  if (prefs.requireFemale) {
    const female = isLikelyFemale(profile);
    if (female === false) return -1000;
    if (female === true) score += 8;
  }

  const requiredLanguages = normalizeLowerList(prefs.requiredLanguages);
  for (const language of requiredLanguages) {
    const signal = hasLanguage(profile, language);
    if (signal === true) {
      score += language === "english" ? 25 : 12;
    } else if (signal === false) {
      score -= language === "english" ? 30 : 10;
    }
  }

  if (typeof prefs.minExperienceMonths === "number") {
    if (typeof profile.experienceMonths === "number") {
      if (profile.experienceMonths >= prefs.minExperienceMonths) {
        score += 20;
      } else {
        score -= 12;
      }
      score += Math.min(20, Math.floor(profile.experienceMonths / 6));
    }
  }

  if (prefs.nonSmokerRequired) {
    const nonSmoker = smokingSignal(profile);
    if (nonSmoker === false) return -1000;
    if (nonSmoker === true) score += 8;
  }

  if (prefs.requiresDogFriendly) {
    const dogFriendly = dogFriendlySignal(profile);
    if (dogFriendly === false) return -1000;
    if (dogFriendly === true) score += 8;
  }

  if (prefs.drivingComfortRequired) {
    const raw = profile.raw as Record<string, unknown>;
    const detail = raw.detail && typeof raw.detail === "object" ? (raw.detail as Record<string, unknown>) : null;

    if (detail && typeof detail.driver === "boolean") {
      if (detail.driver) {
        score += 8;
      } else {
        score -= 20;
      }
    }

    let years = parseYearsDriving(raw);
    if (years === null && detail && typeof detail.driverLicenseReceivedOn === "string") {
      years = parseYearsFromDate(detail.driverLicenseReceivedOn);
    }
    if (years !== null) {
      if (years >= 1) {
        score += 10;
      } else {
        score -= 10;
      }
    }
    const drivingFrequency =
      (typeof raw.drivingFrequency === "string" ? raw.drivingFrequency : "") ||
      (detail && typeof detail.drivingFrequency === "string" ? detail.drivingFrequency : "");
    if (/daily|weekly/i.test(drivingFrequency)) score += 4;
    const text = profileText(profile);
    if (/nervous.*driv|not comfortable driving|no driver.?s license/.test(text)) score -= 15;
  }

  const preferredTraits = normalizeLowerList(prefs.preferredTraits);
  for (const trait of preferredTraits) {
    if (hasPreferredTrait(profile, trait)) score += 6;
  }

  if (prefs.desiredStartEarliest || prefs.desiredStartLatest) {
    const desiredStart = prefs.desiredStartEarliest ? new Date(prefs.desiredStartEarliest) : null;
    const desiredEnd = prefs.desiredStartLatest ? new Date(prefs.desiredStartLatest) : null;
    const window = getStartWindow(profile);
    if (
      desiredStart &&
      desiredEnd &&
      !Number.isNaN(desiredStart.getTime()) &&
      !Number.isNaN(desiredEnd.getTime()) &&
      window.start &&
      window.end
    ) {
      const overlaps = window.start <= desiredEnd && window.end >= desiredStart;
      if (overlaps) {
        score += 15;
      } else {
        score -= 10;
      }
    }
  }

  return score;
}

export function explainProfile(profile: RankedProfile, prefs: Preferences | null): string[] {
  if (!prefs) return ["No preferences configured; score is neutral."];

  const reasons: string[] = [];
  const country = profile.country || "unknown";
  const preferredCountries = normalizeLowerList(prefs.preferredCountries);
  const acceptableCountries = normalizeLowerList(prefs.acceptableCountries);
  const countryValue = profile.country?.toLowerCase() || null;

  if (countryValue && preferredCountries.includes(countryValue)) {
    reasons.push(`Preferred country match (${country}).`);
  } else if (countryValue && acceptableCountries.includes(countryValue)) {
    reasons.push(`Acceptable country match (${country}).`);
  }

  if (typeof profile.age === "number") {
    if (typeof prefs.minAge === "number") {
      reasons.push(
        profile.age >= prefs.minAge
          ? `Meets minimum age (${profile.age} >= ${prefs.minAge}).`
          : `Below minimum age (${profile.age} < ${prefs.minAge}).`
      );
    }
    if (typeof prefs.idealMinAge === "number" && profile.age >= prefs.idealMinAge) {
      reasons.push(`Hits ideal age preference (${profile.age} >= ${prefs.idealMinAge}).`);
    }
  }

  const requiredLanguages = normalizeLowerList(prefs.requiredLanguages);
  for (const language of requiredLanguages) {
    const signal = hasLanguage(profile, language);
    if (signal === true) reasons.push(`Language match: ${language}.`);
    if (signal === false) reasons.push(`Language concern: ${language} not detected.`);
  }

  if (typeof profile.experienceMonths === "number") {
    reasons.push(`Estimated childcare experience: ${profile.experienceMonths} months.`);
    if (typeof prefs.minExperienceMonths === "number") {
      reasons.push(
        profile.experienceMonths >= prefs.minExperienceMonths
          ? `Meets experience target (${profile.experienceMonths} >= ${prefs.minExperienceMonths}).`
          : `Below experience target (${profile.experienceMonths} < ${prefs.minExperienceMonths}).`
      );
    }
  }

  if (prefs.nonSmokerRequired) {
    const nonSmoker = smokingSignal(profile);
    if (nonSmoker === true) reasons.push("Non-smoker signal found.");
    if (nonSmoker === false) reasons.push("Smoking conflict detected.");
  }

  if (prefs.requiresDogFriendly) {
    const dogFriendly = dogFriendlySignal(profile);
    if (dogFriendly === true) reasons.push("Dog-friendly signal found.");
    if (dogFriendly === false) reasons.push("Possible dog-allergy or pet conflict.");
  }

  if (prefs.drivingComfortRequired) {
    const raw = profile.raw as Record<string, unknown>;
    const detail = raw.detail && typeof raw.detail === "object" ? (raw.detail as Record<string, unknown>) : null;
    const years = parseYearsDriving(raw);
    if (years !== null) reasons.push(`Driving experience window starts at ~${years}+ years.`);
    const drivingFrequency =
      (typeof raw.drivingFrequency === "string" ? raw.drivingFrequency : "") ||
      (detail && typeof detail.drivingFrequency === "string" ? detail.drivingFrequency : "");
    if (drivingFrequency) reasons.push(`Driving frequency noted: ${drivingFrequency}.`);
  }

  const preferredTraits = normalizeLowerList(prefs.preferredTraits);
  const matchedTraits = preferredTraits.filter((trait) => hasPreferredTrait(profile, trait));
  if (matchedTraits.length) {
    reasons.push(`Trait matches: ${matchedTraits.join(", ")}.`);
  }

  if (prefs.desiredStartEarliest || prefs.desiredStartLatest) {
    const desiredStart = prefs.desiredStartEarliest ? new Date(prefs.desiredStartEarliest) : null;
    const desiredEnd = prefs.desiredStartLatest ? new Date(prefs.desiredStartLatest) : null;
    const window = getStartWindow(profile);
    if (desiredStart && desiredEnd && window.start && window.end) {
      const overlaps = window.start <= desiredEnd && window.end >= desiredStart;
      reasons.push(
        overlaps
          ? "Start window overlaps your target timeline."
          : "Start window does not overlap your target timeline."
      );
    }
  }

  return reasons.slice(0, 12);
}

export function toRunId(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
