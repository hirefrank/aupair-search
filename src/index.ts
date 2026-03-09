import fs from "node:fs/promises";
import path from "node:path";
import { loadDotEnv } from "./lib/env.js";
import { runSearchPipeline } from "./lib/searchPipeline.js";
import { sendSlackCandidates } from "./lib/slack.js";
import { toCsv, toRunId } from "./lib/utils.js";
import type { SearchBySource } from "./lib/searchPipeline.js";
import type { RankedProfile } from "./types.js";

loadDotEnv();

const OUTPUT_DIR = process.env.OUTPUT_DIR || "output";
const RUNS_DIR = process.env.RUNS_DIR || path.join(OUTPUT_DIR, "runs");
const MAX_PAGES = Number(process.env.MAX_PAGES || 200);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const SLACK_NOTIFY_MAX = Number(process.env.SLACK_NOTIFY_MAX || 25);

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function writeLatestOutputs(
  outputDir: string,
  merged: RankedProfile[],
  bySource: SearchBySource,
  thresholdMatches: RankedProfile[]
): Promise<void> {
  await Promise.all([
    writeJson(path.join(outputDir, "aupairs-merged.json"), merged),
    fs.writeFile(path.join(outputDir, "aupairs-merged.csv"), toCsv(merged)),
    writeJson(path.join(outputDir, "aupairs-by-source.json"), bySource),
    writeJson(path.join(outputDir, "aupairs-threshold-matches.json"), thresholdMatches)
  ]);
}

async function writeRunSnapshot(
  runDir: string,
  merged: RankedProfile[],
  bySource: SearchBySource,
  thresholdMatches: RankedProfile[],
  threshold: number,
  effectiveThreshold: number,
  scoreThresholdApplied: boolean
): Promise<void> {
  await Promise.all([
    writeJson(path.join(runDir, "aupairs-merged.json"), merged),
    fs.writeFile(path.join(runDir, "aupairs-merged.csv"), toCsv(merged)),
    writeJson(path.join(runDir, "aupairs-by-source.json"), bySource),
    writeJson(path.join(runDir, "aupairs-threshold-matches.json"), thresholdMatches),
    writeJson(path.join(runDir, "metadata.json"), {
      generatedAt: new Date().toISOString(),
      totalMerged: merged.length,
      threshold,
      effectiveThreshold,
      scoreThresholdApplied,
      thresholdMatches: thresholdMatches.length,
      matchCriteria: {
        minAge: Number(process.env.MATCH_MIN_AGE || 22),
        requireFemale: String(process.env.MATCH_REQUIRE_FEMALE || "true") === "true",
        minEnglishLevel: Number(process.env.MATCH_MIN_ENGLISH_LEVEL || 6),
        arrivalEarliest: process.env.MATCH_ARRIVAL_EARLIEST || "2026-06-01",
        arrivalLatest: process.env.MATCH_ARRIVAL_LATEST || "2026-07-31"
      },
      cultureCareCount: bySource.culturecare.profiles.length,
      apiaCount: bySource.apia.profiles.length,
      skipped: {
        culturecare: bySource.culturecare.skipped ? bySource.culturecare.reason : null,
        apia: bySource.apia.skipped ? bySource.apia.reason : null
      }
    })
  ]);
}

async function main(): Promise<void> {
  const run = await runSearchPipeline(process.env, { maxPages: MAX_PAGES });

  const runId = toRunId();
  const runDir = path.join(RUNS_DIR, runId);
  await ensureDir(OUTPUT_DIR);
  await ensureDir(RUNS_DIR);
  await ensureDir(runDir);

  await Promise.all([
    writeLatestOutputs(OUTPUT_DIR, run.merged, run.bySource, run.thresholdMatches),
    writeRunSnapshot(
      runDir,
      run.merged,
      run.bySource,
      run.thresholdMatches,
      run.threshold,
      run.effectiveThreshold,
      run.scoreThresholdApplied
    )
  ]);

  console.log(`Done. ${run.merged.length} profiles saved.`);
  const thresholdLabel = run.scoreThresholdApplied ? `${run.effectiveThreshold}` : "0 (preferences not configured)";
  console.log(`Threshold matches (>= ${thresholdLabel}): ${run.thresholdMatches.length}`);
  console.log(`Latest outputs:`);
  console.log(`- ${path.join(OUTPUT_DIR, "aupairs-merged.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "aupairs-merged.csv")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "aupairs-by-source.json")}`);
  console.log(`- ${path.join(OUTPUT_DIR, "aupairs-threshold-matches.json")}`);
  console.log(`Snapshot:`);
  console.log(`- ${runDir}`);

  if (run.bySource.culturecare.skipped) {
    console.log(`Culture Care skipped: ${run.bySource.culturecare.reason}`);
  }
  if (run.bySource.apia.skipped) {
    console.log(`APIA skipped: ${run.bySource.apia.reason}`);
  }

  if (SLACK_WEBHOOK_URL) {
    const sent = await sendSlackCandidates(run.thresholdMatches, {
      webhookUrl: SLACK_WEBHOOK_URL,
      threshold: run.threshold,
      maxProfiles: SLACK_NOTIFY_MAX
    });
    console.log(`Slack notification sent: ${sent.sent} matches (${sent.shown} shown).`);
  } else {
    console.log("Slack webhook not set; skipping Slack notification.");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
