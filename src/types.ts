export type JsonObject = Record<string, unknown>;

export type RankedProfile = {
  source: string;
  id: string | null;
  name: string | null;
  country: string | null;
  age: number | null;
  languages: string[];
  experienceMonths: number | null;
  profileUrl: string | null;
  raw: JsonObject;
  score?: number;
};

export type AdapterRunResult = {
  source: string;
  profiles: RankedProfile[];
  skipped: boolean;
  reason?: string;
  errorCode?: string;
};

export type Preferences = {
  preferredCountries?: string[];
  acceptableCountries?: string[];
  minAge?: number;
  maxAge?: number;
  idealMinAge?: number;
  requiredLanguages?: string[];
  minExperienceMonths?: number;
  requireFemale?: boolean;
  nonSmokerRequired?: boolean;
  requiresDogFriendly?: boolean;
  drivingComfortRequired?: boolean;
  preferredTraits?: string[];
  desiredStartEarliest?: string;
  desiredStartLatest?: string;
};

export type AnalyzeOutput = {
  generatedAt: string;
  sourceFile: string;
  totalProfiles: number;
  preferences: Preferences | null;
  topProfiles: RankedProfile[];
  allProfiles: RankedProfile[];
};
