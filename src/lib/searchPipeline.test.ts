import { describe, expect, test } from "bun:test";
import { matchesCriteria, matchesWordBoundary, passesMaturityGate, runSearchPipeline } from "./searchPipeline.js";
import type { MaturityGate } from "./searchPipeline.js";
import type { RankedProfile } from "../types.js";

function makeProfile(overrides: Partial<RankedProfile> = {}): RankedProfile {
  return {
    source: "culturecare",
    id: "test-1",
    name: "Test Candidate",
    country: "Germany",
    age: 21,
    languages: ["English"],
    experienceMonths: 24,
    profileUrl: null,
    raw: {},
    ...overrides
  };
}

const defaultGate: MaturityGate = {
  minAge: 21,
  minExperienceMonths: 18,
  educationKeywords: ["university", "college", "bachelor", "master", "degree"],
  maturityKeywords: ["responsible", "independent", "organized", "mature", "reliable", "professional", "dedicated"],
  requiredSignals: 2
};

function defaultCriteria(): Parameters<typeof matchesCriteria>[1] {
  return {
    minAge: 22,
    requireFemale: true,
    minEnglishLevel: 6,
    arrivalEarliest: null,
    arrivalLatest: null,
    childAges: [],
    requiredPets: [],
    allowedDrivingFrequencies: [],
    minDrivingYears: 0,
    requireSwimmingSupervision: false,
    requireLivedAwayFromHome: false,
    maturityGate: null
  };
}

describe("matchesWordBoundary", () => {
  test("matches exact word", () => {
    expect(matchesWordBoundary("she is very mature", "mature")).toBe(true);
  });

  test("does not match substring — immature should not match mature", () => {
    expect(matchesWordBoundary("she is immature", "mature")).toBe(false);
  });

  test("does not match substring — irresponsible should not match responsible", () => {
    expect(matchesWordBoundary("seems irresponsible", "responsible")).toBe(false);
  });

  test("matches word at start of text", () => {
    expect(matchesWordBoundary("responsible and caring", "responsible")).toBe(true);
  });

  test("matches word at end of text", () => {
    expect(matchesWordBoundary("very organized", "organized")).toBe(true);
  });

  test("is case-sensitive (expects lowercased input)", () => {
    expect(matchesWordBoundary("she is Mature", "mature")).toBe(false);
    expect(matchesWordBoundary("she is mature", "mature")).toBe(true);
  });
});

describe("passesMaturityGate", () => {
  test("passes with experience + education (2 signals)", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: { educationLevel: "University" }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(true);
  });

  test("fails with only experience (1 signal, needs 2)", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: { educationLevel: "High School" }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(false);
  });

  test("passes with experience + keyword hits (2 signals)", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: {
        educationLevel: "High School",
        aboutSelfAndInterests: "I am responsible and very organized in my work"
      }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(true);
  });

  test("single keyword match does not trigger signal 3", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: {
        educationLevel: "High School",
        aboutSelfAndInterests: "I am responsible"
      }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(false);
  });

  test("fails with zero signals", () => {
    const profile = makeProfile({
      experienceMonths: 6,
      raw: { educationLevel: "High School" }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(false);
  });

  test("substring 'immature' does not count as keyword match", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: {
        educationLevel: "High School",
        aboutSelfAndInterests: "She seems immature and unprofessional"
      }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(false);
  });

  test("passes with all 3 signals", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: {
        educationLevel: "Bachelor of Education",
        aboutSelfAndInterests: "I am responsible, organized, and dedicated"
      }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(true);
  });

  test("uses APIA detail fields for keyword matching", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: {
        educationLevel: "High School",
        detail: {
          summaryText: "A responsible and reliable candidate who works hard"
        }
      }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(true);
  });

  test("respects requiredSignals threshold of 3", () => {
    const strictGate = { ...defaultGate, requiredSignals: 3 };
    const profile = makeProfile({
      experienceMonths: 24,
      raw: { educationLevel: "University" }
    });
    // Only 2 signals (experience + education), needs 3
    expect(passesMaturityGate(profile, strictGate)).toBe(false);
  });

  test("null experienceMonths treated as 0", () => {
    const profile = makeProfile({
      experienceMonths: null,
      raw: {
        educationLevel: "University",
        aboutSelfAndInterests: "I am responsible and organized"
      }
    });
    // Only education + keywords = 2 signals
    expect(passesMaturityGate(profile, profile.experienceMonths === null ? defaultGate : defaultGate)).toBe(true);
  });

  test("personalityTraits array contributes to keyword matching", () => {
    const profile = makeProfile({
      experienceMonths: 24,
      raw: {
        educationLevel: "High School",
        personalityTraits: ["responsible", "dedicated", "friendly"]
      }
    });
    expect(passesMaturityGate(profile, defaultGate)).toBe(true);
  });
});

describe("matchesCriteria", () => {
  test("keeps CultureCare english filter strict when data is missing", () => {
    const profile = makeProfile({
      age: 22,
      raw: { genderIdentity: "Female" }
    });

    expect(matchesCriteria(profile, defaultCriteria())).toBe(false);
  });

  test("keeps CultureCare swimming and lived-away filters strict when data is missing", () => {
    const profile = makeProfile({
      age: 22,
      raw: {
        genderIdentity: "Female",
        englishProficiencyLevel: "Level 6"
      }
    });

    const criteria = {
      ...defaultCriteria(),
      minEnglishLevel: 6,
      requireSwimmingSupervision: true,
      requireLivedAwayFromHome: true
    };

    expect(matchesCriteria(profile, criteria)).toBe(false);
  });

  test("allows APIA profile to satisfy detail-backed filters", () => {
    const profile = makeProfile({
      source: "apia",
      age: 22,
      raw: {
        detail: {
          genderIdentity: "Female",
          drivingFrequency: "weekly",
          swimmer: "Yes",
          livedAwayFromHome: true,
          driverLicenseReceivedOn: "2020-01-15",
          petAllergies: "none"
        }
      }
    });

    const criteria = {
      ...defaultCriteria(),
      minEnglishLevel: 0,
      requiredPets: ["dogs"],
      allowedDrivingFrequencies: ["weekly"],
      minDrivingYears: 1,
      requireSwimmingSupervision: true,
      requireLivedAwayFromHome: true
    };

    expect(matchesCriteria(profile, criteria)).toBe(true);
  });
});

describe("runSearchPipeline", () => {
  test("skips APIA with a clear reason when detail-backed filters are active and detail fetch is disabled", async () => {
    const run = await runSearchPipeline(
      {
        ENABLE_CULTURECARE: "false",
        ENABLE_APIA: "true",
        APIA_URL: "https://example.com/apia",
        APIA_COOKIE: "session=1",
        APIA_FETCH_DETAILS: "false"
      },
      { maxPages: 1 }
    );

    expect(run.bySource.apia.skipped).toBe(true);
    expect(run.bySource.apia.reason).toContain("APIA_FETCH_DETAILS must be true");
  });
});
