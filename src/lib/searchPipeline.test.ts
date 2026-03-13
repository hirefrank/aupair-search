import { describe, expect, test } from "bun:test";
import { matchesWordBoundary, passesAgeCriteria, passesMaturityGate } from "./searchPipeline.js";
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

describe("passesAgeCriteria", () => {
  test("rejects candidates below the maturity gate minimum age", () => {
    const profile = makeProfile({
      age: 20,
      experienceMonths: 36,
      raw: {
        educationLevel: "University",
        aboutSelfAndInterests: "I am responsible, organized, and dedicated"
      }
    });

    expect(passesAgeCriteria(profile, { minAge: 22, maturityGate: defaultGate })).toBe(false);
  });

  test("requires the maturity gate for candidates below the main minimum age", () => {
    const profile = makeProfile({
      age: 21,
      experienceMonths: 24,
      raw: {
        educationLevel: "High School",
        aboutSelfAndInterests: "I am responsible and organized"
      }
    });

    expect(passesAgeCriteria(profile, { minAge: 22, maturityGate: defaultGate })).toBe(true);
  });

  test("rejects below-min-age candidates that do not meet the maturity gate", () => {
    const profile = makeProfile({
      age: 21,
      experienceMonths: 12,
      raw: {
        educationLevel: "High School",
        aboutSelfAndInterests: "I am friendly and caring"
      }
    });

    expect(passesAgeCriteria(profile, { minAge: 22, maturityGate: defaultGate })).toBe(false);
  });

  test("does not require the maturity gate once the main minimum age is met", () => {
    const profile = makeProfile({
      age: 22,
      experienceMonths: 0,
      raw: {
        educationLevel: "High School",
        aboutSelfAndInterests: "I am friendly and caring"
      }
    });

    expect(passesAgeCriteria(profile, { minAge: 22, maturityGate: defaultGate })).toBe(true);
  });

  test("rejects below-min-age candidates when the maturity gate is disabled", () => {
    const profile = makeProfile({
      age: 21,
      experienceMonths: 24,
      raw: {
        educationLevel: "University",
        aboutSelfAndInterests: "I am responsible and organized"
      }
    });

    expect(passesAgeCriteria(profile, { minAge: 22, maturityGate: null })).toBe(false);
  });
});
