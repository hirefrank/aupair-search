import { fetchWithRetry } from "./http.js";
import type { RankedProfile } from "../types.js";

type SlackNotifyOptions = {
  webhookUrl: string;
  threshold: number;
  maxProfiles: number;
  enableDetailsModal?: boolean;
};

type SlackNotifyResult = {
  sent: number;
  shown: number;
};

type SlackAuthAlertOptions = {
  webhookUrl: string;
  reauthUrl: string;
  errorMessage: string;
};

type SlackPayload = {
  text: string;
  blocks?: unknown[];
};

type SlackCandidateDetails = {
  version: 1;
  source: string;
  candidateId: string;
  name: string;
  country: string;
  age: string;
  experience: string;
  english: string;
  arrival: string;
  availability: string;
  score: string;
  currentLocation: string;
  auPairNumber: string;
  childcareHours: string;
  yearsDriving: string;
  drivingFrequency: string;
  preferredAges: string;
  childrenCapacity: string;
  about: string;
  personality: string;
  food: string;
  profileUrl: string;
};

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 1) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 1)}...`;
}

function stringifyDetailValue(value: unknown, fallback = "-"): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || fallback;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    const out = value
      .map((entry) => {
        if (entry === null || entry === undefined) return "";
        if (typeof entry === "string") return entry.trim();
        if (typeof entry === "number" || typeof entry === "boolean") return String(entry);
        try {
          return JSON.stringify(entry);
        } catch {
          return "";
        }
      })
      .filter(Boolean)
      .join(", ");
    return out || fallback;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function asDetailsString(value: unknown, maxLength: number, fallback = "-"): string {
  return truncateText(stringifyDetailValue(value, fallback), maxLength);
}

function escapedMrkdwn(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safe(value: string | null | undefined, fallback = "Unknown"): string {
  return value && value.trim() ? value.trim() : fallback;
}

function englishLevel(profile: RankedProfile): string {
  const raw = profile.raw as Record<string, unknown>;
  if (typeof raw.englishProficiencyLevel === "string") return raw.englishProficiencyLevel;
  return "Unknown";
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric"
  }).format(parsed);
}

function countryFlag(countryCode: string | null | undefined): string {
  const code = (countryCode || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  const first = code.codePointAt(0);
  const second = code.codePointAt(1);
  if (!first || !second) return "";
  return String.fromCodePoint(127397 + first, 127397 + second);
}

function arrivalWindow(profile: RankedProfile): string {
  const raw = profile.raw as Record<string, unknown>;
  const earliest = typeof raw.earliestTravelDate === "string" ? raw.earliestTravelDate : null;
  const latest = typeof raw.latestTravelDate === "string" ? raw.latestTravelDate : null;
  if (earliest || latest) {
    const from = formatDate(earliest) || "?";
    const to = formatDate(latest) || from;
    return `${from} -> ${to}`;
  }
  if (typeof raw.startWindow === "string" && raw.startWindow.trim()) return raw.startWindow;
  return "Unknown";
}

function availabilityLabel(profile: RankedProfile): string {
  const raw = profile.raw as Record<string, unknown>;
  const chatAvailable = raw.staffInitiatedChatAvailable;
  const subStatus = typeof raw.matchingSubStatus === "string" ? raw.matchingSubStatus : "";

  if (chatAvailable === false) {
    return "Unavailable to chat (hidden)";
  }

  if (subStatus && !/available/i.test(subStatus)) {
    return `${subStatus} (hidden)`;
  }

  return subStatus || "Available";
}

function profilePhotoUrl(profile: RankedProfile): string {
  const raw = profile.raw as Record<string, unknown>;
  const value = typeof raw.profilePictureCfn === "string" ? raw.profilePictureCfn.trim() : "";
  if (!/^https?:\/\//i.test(value)) return "";
  return value;
}

function detailsPayloadWithSizeLimit(payload: SlackCandidateDetails, maxLength = 1_900): SlackCandidateDetails {
  const firstPass: SlackCandidateDetails = {
    ...payload,
    about: truncateText(payload.about, 320),
    personality: truncateText(payload.personality, 140),
    food: truncateText(payload.food, 140),
    currentLocation: truncateText(payload.currentLocation, 120),
    preferredAges: truncateText(payload.preferredAges, 120)
  };

  if (JSON.stringify(firstPass).length <= maxLength) {
    return firstPass;
  }

  const secondPass: SlackCandidateDetails = {
    ...firstPass,
    about: truncateText(firstPass.about, 200),
    personality: "-",
    food: "-",
    currentLocation: "-"
  };

  if (JSON.stringify(secondPass).length <= maxLength) {
    return secondPass;
  }

  return {
    ...secondPass,
    about: "-",
    preferredAges: "-",
    childrenCapacity: "-"
  };
}

function buildCandidateDetailsPayload(profile: RankedProfile, threshold: number): string {
  const raw = profile.raw as Record<string, unknown>;
  const details: SlackCandidateDetails = {
    version: 1,
    source: safe(profile.source, "unknown"),
    candidateId: safe(profile.id, "unknown"),
    name: safe(profile.name, "Unnamed candidate"),
    country: safe(profile.country, "Unknown"),
    age: typeof profile.age === "number" ? `${profile.age} years` : "Unknown",
    experience:
      typeof profile.experienceMonths === "number" ? `${profile.experienceMonths} months` : "Unknown",
    english: englishLevel(profile),
    arrival: arrivalWindow(profile),
    availability: availabilityLabel(profile),
    score: threshold > 0 ? String(profile.score ?? 0) : "Not scored",
    currentLocation: asDetailsString(raw.currentLocation, 120),
    auPairNumber: asDetailsString(raw.auPairNumber, 64),
    childcareHours: asDetailsString(raw.approvedChildcareHours, 64),
    yearsDriving: asDetailsString(raw.yearsDriving, 64),
    drivingFrequency: asDetailsString(raw.drivingFrequency, 80),
    preferredAges: asDetailsString(raw.preferredAges, 120),
    childrenCapacity: asDetailsString(raw.numberOfChildrenCanCareFor, 64),
    about: asDetailsString(raw.aboutSelfAndInterests, 600),
    personality: asDetailsString(raw.personalityTraits, 240),
    food: asDetailsString(raw.foodPreferences, 240),
    profileUrl: typeof profile.profileUrl === "string" ? profile.profileUrl : ""
  };

  return JSON.stringify(detailsPayloadWithSizeLimit(details));
}

export function parseCandidateDetailsPayload(value: string | null | undefined): SlackCandidateDetails | null {
  if (!value) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (typeof obj.name !== "string") return null;

  return {
    version: 1,
    source: typeof obj.source === "string" ? obj.source : "unknown",
    candidateId: typeof obj.candidateId === "string" ? obj.candidateId : "unknown",
    name: obj.name,
    country: typeof obj.country === "string" ? obj.country : "Unknown",
    age: typeof obj.age === "string" ? obj.age : "Unknown",
    experience: typeof obj.experience === "string" ? obj.experience : "Unknown",
    english: typeof obj.english === "string" ? obj.english : "Unknown",
    arrival: typeof obj.arrival === "string" ? obj.arrival : "Unknown",
    availability: typeof obj.availability === "string" ? obj.availability : "Unknown",
    score: typeof obj.score === "string" ? obj.score : "Not scored",
    currentLocation: typeof obj.currentLocation === "string" ? obj.currentLocation : "-",
    auPairNumber: typeof obj.auPairNumber === "string" ? obj.auPairNumber : "-",
    childcareHours: typeof obj.childcareHours === "string" ? obj.childcareHours : "-",
    yearsDriving: typeof obj.yearsDriving === "string" ? obj.yearsDriving : "-",
    drivingFrequency: typeof obj.drivingFrequency === "string" ? obj.drivingFrequency : "-",
    preferredAges: typeof obj.preferredAges === "string" ? obj.preferredAges : "-",
    childrenCapacity: typeof obj.childrenCapacity === "string" ? obj.childrenCapacity : "-",
    about: typeof obj.about === "string" ? obj.about : "-",
    personality: typeof obj.personality === "string" ? obj.personality : "-",
    food: typeof obj.food === "string" ? obj.food : "-",
    profileUrl: typeof obj.profileUrl === "string" ? obj.profileUrl : ""
  };
}

export function buildCandidateDetailsModal(details: ReturnType<typeof parseCandidateDetailsPayload>): Record<string, unknown> {
  const safeDetails =
    details ||
    ({
      version: 1,
      source: "unknown",
      candidateId: "unknown",
      name: "Candidate",
      country: "Unknown",
      age: "Unknown",
      experience: "Unknown",
      english: "Unknown",
      arrival: "Unknown",
      availability: "Unknown",
      score: "Not scored",
      currentLocation: "-",
      auPairNumber: "-",
      childcareHours: "-",
      yearsDriving: "-",
      drivingFrequency: "-",
      preferredAges: "-",
      childrenCapacity: "-",
      about: "-",
      personality: "-",
      food: "-",
      profileUrl: ""
    } as SlackCandidateDetails);

  const blocks: Record<string, unknown>[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapedMrkdwn(safeDetails.name)}*`
      }
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Country*\n${escapedMrkdwn(safeDetails.country)}` },
        { type: "mrkdwn", text: `*Age*\n${escapedMrkdwn(safeDetails.age)}` },
        { type: "mrkdwn", text: `*Experience*\n${escapedMrkdwn(safeDetails.experience)}` },
        { type: "mrkdwn", text: `*English*\n${escapedMrkdwn(safeDetails.english)}` },
        { type: "mrkdwn", text: `*Arrival*\n${escapedMrkdwn(safeDetails.arrival)}` },
        { type: "mrkdwn", text: `*Availability*\n${escapedMrkdwn(safeDetails.availability)}` },
        { type: "mrkdwn", text: `*Score*\n${escapedMrkdwn(safeDetails.score)}` },
        { type: "mrkdwn", text: `*Current Location*\n${escapedMrkdwn(safeDetails.currentLocation)}` }
      ]
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Au Pair Number*\n${escapedMrkdwn(safeDetails.auPairNumber)}` },
        { type: "mrkdwn", text: `*Childcare Hours*\n${escapedMrkdwn(safeDetails.childcareHours)}` },
        { type: "mrkdwn", text: `*Years Driving*\n${escapedMrkdwn(safeDetails.yearsDriving)}` },
        { type: "mrkdwn", text: `*Driving Frequency*\n${escapedMrkdwn(safeDetails.drivingFrequency)}` },
        { type: "mrkdwn", text: `*Preferred Ages*\n${escapedMrkdwn(safeDetails.preferredAges)}` },
        { type: "mrkdwn", text: `*Children Capacity*\n${escapedMrkdwn(safeDetails.childrenCapacity)}` }
      ]
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*About*\n${escapedMrkdwn(safeDetails.about)}`
      }
    }
  ];

  if (safeDetails.personality !== "-") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Personality*\n${escapedMrkdwn(safeDetails.personality)}`
      }
    });
  }

  if (safeDetails.food !== "-") {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Food Preferences*\n${escapedMrkdwn(safeDetails.food)}`
      }
    });
  }

  if (safeDetails.profileUrl) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${safeDetails.profileUrl}|Open full profile in Culture Care>`
      }
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Source: ${escapedMrkdwn(safeDetails.source)} | Candidate ID: ${escapedMrkdwn(safeDetails.candidateId)}`
      }
    ]
  });

  return {
    type: "modal",
    callback_id: "candidate_details_modal",
    title: {
      type: "plain_text",
      text: "Candidate Details"
    },
    close: {
      type: "plain_text",
      text: "Close"
    },
    blocks
  };
}

async function sendSlackPayload(webhookUrl: string, payload: SlackPayload): Promise<void> {
  const response = await fetchWithRetry(
    webhookUrl,
    {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(payload)
    },
    {
      retries: 3,
      minDelayMs: 400,
      maxDelayMs: 5_000,
      timeoutMs: 15_000
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack webhook failed (${response.status}): ${body.slice(0, 300)}`);
  }
}

export async function sendSlackCandidates(
  matches: RankedProfile[],
  { webhookUrl, threshold, maxProfiles, enableDetailsModal = false }: SlackNotifyOptions
): Promise<SlackNotifyResult> {
  if (!matches.length) {
    return { sent: 0, shown: 0 };
  }

  const shownMatches = matches.slice(0, Math.max(0, maxProfiles));

  for (const profile of shownMatches) {
    const name = safe(profile.name, "Unnamed candidate");
    const age = typeof profile.age === "number" ? `${profile.age}y` : "age ?";
    const countryCode = safe(profile.country, "");
    const flag = countryFlag(countryCode);
    const location = [flag, countryCode].filter(Boolean).join(" ") || "location ?";
    const experience =
      typeof profile.experienceMonths === "number" ? `${profile.experienceMonths}m experience` : "experience ?";
    const scorePart = threshold > 0 ? ` | score ${profile.score ?? 0}` : "";

    const summaryLines = [
      `${location} | ${age} | ${experience}${scorePart}`,
      `English ${englishLevel(profile)} | Arrival ${arrivalWindow(profile)}`,
      availabilityLabel(profile)
    ];

    const actionElements: Record<string, unknown>[] = [];

    if (enableDetailsModal) {
      const detailsValue = buildCandidateDetailsPayload(profile, threshold);
      actionElements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: "View Details"
        },
        action_id: "view_candidate_details",
        value: detailsValue
      });
    }

    if (profile.profileUrl) {
      actionElements.push({
        type: "button",
        text: {
          type: "plain_text",
          text: enableDetailsModal ? "Open Profile" : "View Details"
        },
        url: profile.profileUrl,
        action_id: `open_profile_${profile.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
      });
    }

    const candidatePhotoUrl = profilePhotoUrl(profile);
    const summarySection: Record<string, unknown> = {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${name}*\n${summaryLines.join("\n")}`
      }
    };

    if (candidatePhotoUrl) {
      summarySection.accessory = {
        type: "image",
        image_url: candidatePhotoUrl,
        alt_text: `${name} profile photo`
      };
    }

    const blocks: unknown[] = [summarySection];

    if (actionElements.length > 0) {
      blocks.push({
        type: "actions",
        elements: actionElements
      });
    }

    await sendSlackPayload(webhookUrl, {
      text: `Au pair match: ${name}`,
      blocks
    });
  }

  return {
    sent: shownMatches.length,
    shown: shownMatches.length
  };
}

export async function sendCultureCareAuthAlert({
  webhookUrl,
  reauthUrl,
  errorMessage
}: SlackAuthAlertOptions): Promise<void> {
  await sendSlackPayload(webhookUrl, {
    text: "Culture Care auth expired - reauth required",
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🚨 Culture Care Auth Expired"
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: ":warning: Search could not run because auth looks expired or invalid."
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "Re-auth now"
            },
            style: "primary",
            url: reauthUrl
          }
        ]
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `Last error: ${errorMessage.slice(0, 400)}`
          }
        ]
      }
    ]
  });
}
