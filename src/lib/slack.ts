import { fetchWithRetry } from "./http.js";
import type { RankedProfile } from "../types.js";

type SlackNotifyOptions = {
  webhookUrl: string;
  threshold: number;
  maxProfiles: number;
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
  { webhookUrl, threshold, maxProfiles }: SlackNotifyOptions
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

    const scoreLabel = threshold > 0 ? `*Score:* ${profile.score ?? 0}\n` : "";

    const blocks: unknown[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${name}*\n${summaryLines.join("\n")}\n${scoreLabel}*Details:* Open the full profile for complete candidate information.`
        },
        ...(profile.profileUrl
          ? {
              accessory: {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "View Full Profile"
                },
                url: profile.profileUrl,
                action_id: `open_profile_${profile.id || name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
              }
            }
          : {})
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
