import { fetchWithRetry } from "./http.js";
import type { RankedProfile } from "../types.js";

type SlackNotifyOptions = {
  webhookUrl: string;
  threshold: number;
  maxProfiles: number;
  singleMessageMode?: boolean;
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

const PRIORITY_RAW_KEYS = [
  "matchingSubStatus",
  "staffInitiatedChatAvailable",
  "earliestTravelDate",
  "latestTravelDate",
  "englishProficiencyLevel",
  "approvedChildcareHours",
  "yearsDriving",
  "drivingFrequency",
  "preferredAges",
  "numberOfChildrenCanCareFor",
  "aboutSelfAndInterests"
];

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
    day: "numeric",
    year: "numeric"
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

function countryFlagToken(countryCode: string | null | undefined): string {
  const code = (countryCode || "").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return "";
  return `:flag-${code}:`;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
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

function formatRawValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value
      .map((entry) => {
        if (entry === null || entry === undefined) return "null";
        if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
          return String(entry);
        }
        return JSON.stringify(entry);
      })
      .join(", ");
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function splitLongText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];
  const out: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    out.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }
  if (remaining.length) out.push(remaining);
  return out;
}

function chunkLines(lines: string[], maxBlockLength: number): string[] {
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    const lineParts = splitLongText(line, maxBlockLength);
    for (const part of lineParts) {
      const addition = current ? `\n${part}` : part;
      if ((current + addition).length > maxBlockLength) {
        if (current) chunks.push(current);
        current = part;
      } else {
        current += addition;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (s) => s.toUpperCase());
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

function orderedRawKeys(raw: Record<string, unknown>): string[] {
  const keys = Object.keys(raw);
  const selectedPriority = PRIORITY_RAW_KEYS.filter((key) => key in raw);
  const rest = keys.filter((key) => !selectedPriority.includes(key)).sort((a, b) => a.localeCompare(b));
  return [...selectedPriority, ...rest];
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
  { webhookUrl, threshold, maxProfiles, singleMessageMode = false }: SlackNotifyOptions
): Promise<SlackNotifyResult> {
  if (!matches.length) {
    return { sent: 0, shown: 0 };
  }

  if (singleMessageMode) {
    const profile = matches[0];
    const raw = profile.raw as Record<string, unknown>;
    const name = safe(profile.name, "Unnamed candidate");
    const age = typeof profile.age === "number" ? `${profile.age}y` : "age ?";
    const countryCode = safe(profile.country, "").toUpperCase();
    const flagToken = countryFlagToken(countryCode);
    const location = [flagToken, countryCode].filter(Boolean).join(" ") || "location ?";
    const experience =
      typeof profile.experienceMonths === "number" ? `${profile.experienceMonths}m experience` : "experience ?";

    const summaryLines = [
      `${location} | ${age} | ${experience}`,
      `English ${englishLevel(profile)} | Arrival ${arrivalWindow(profile)}`,
      `Au Pair Number: ${typeof raw.auPairNumber === "string" && raw.auPairNumber.trim() ? raw.auPairNumber.trim() : "-"}`,
      "--"
    ];

    const detailLines: string[] = [
      `Approved Childcare Hours: ${formatRawValue(raw.approvedChildcareHours)}`,
      `Years Driving: ${formatRawValue(raw.yearsDriving)}`,
      `Driving Frequency: ${formatRawValue(raw.drivingFrequency)}`,
      `Preferred Ages: ${formatRawValue(raw.preferredAges)}`,
      `Number Of Children Can Care For: ${formatRawValue(raw.numberOfChildrenCanCareFor)}`,
      `About Self And Interests: ${formatRawValue(raw.aboutSelfAndInterests)}`,
      `Creativity Interests: ${formatRawValue(raw.creativityInterests)}`,
      `Current Location: ${formatRawValue(raw.currentLocation)}`,
      `Food Preferences: ${formatRawValue(raw.foodPreferences)}`,
      `Gender Identity: ${formatRawValue(raw.genderIdentity)}`,
      `Home Country: ${formatRawValue(raw.homeCountry)}`,
      `Personality Traits: ${formatRawValue(raw.personalityTraits)}`,
      `Relaxing Interests: ${formatRawValue(raw.relaxingInterests)}`,
      `Social Interests: ${formatRawValue(raw.socialInterests)}`,
      `Sport Interests: ${formatRawValue(raw.sportInterests)}`
    ];

    const detailChunks = chunkLines(detailLines, 2_800);
    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}*\n${summaryLines.join("\n")}`
        }
      },
      {
        type: "divider"
      }
    ];

    const imageUrl = typeof raw.profilePictureCfn === "string" ? raw.profilePictureCfn : null;
    if (imageUrl) {
      blocks.push({
        type: "image",
        image_url: imageUrl,
        alt_text: `${name} profile picture`
      });
    }

    for (const chunk of detailChunks) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: chunk
        }
      });
    }

    if (profile.profileUrl) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `<${profile.profileUrl}|Open in Culture Care>`
        }
      });
    }

    await sendSlackPayload(webhookUrl, {
      text: `Au pair match: ${name}`,
      blocks
    });

    return {
      sent: 1,
      shown: 1
    };
  }

  for (const profile of matches) {
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

    const raw = profile.raw as Record<string, unknown>;
    const detailLines = orderedRawKeys(raw).map((key) => `*${humanizeKey(key)}:* ${formatRawValue(raw[key])}`);
    const detailChunks = chunkLines(detailLines, 2_800);

    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}*\n${summaryLines.join("\n")}`
        },
        ...(profile.profileUrl
          ? {
              accessory: {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "Bookmark"
                },
                url: profile.profileUrl,
                action_id: `bookmark_${profile.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
              }
            }
          : {})
      },
      {
        type: "divider"
      }
    ];

    if (!profile.profileUrl) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Direct profile link unavailable"
          }
        ]
      });
    }

    for (const chunk of detailChunks) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: chunk
        }
      });
    }

    await sendSlackPayload(webhookUrl, {
      text: `Au pair match: ${name}`,
      blocks
    });
  }

  return {
    sent: matches.length,
    shown: matches.length
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
