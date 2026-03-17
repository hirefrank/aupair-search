#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const APIA_URL = process.env.APIA_BROWSER_URL || "https://my.aupairinamerica.com/AuPair/Index";
const APIA_HOST = new URL(APIA_URL).hostname;

function chromiumTimeToUnixMs(value) {
  if (typeof value !== "number" || value <= 0) return null;
  return Math.round(value / 1000 - 11644473600000);
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function chooseBrowserConfigs() {
  const browser = (process.env.APIA_BROWSER || "auto").toLowerCase();
  const home = os.homedir();
  const configs = [
    {
      name: "chromium",
      appName: "chromium",
      root: path.join(home, ".config", "chromium")
    },
    {
      name: "chrome",
      appName: "google-chrome",
      root: path.join(home, ".config", "google-chrome")
    }
  ];

  if (browser === "chromium") return [configs[0]];
  if (browser === "chrome") return [configs[1]];
  return configs;
}

async function listProfileDirs(rootDir) {
  if (!(await exists(rootDir))) return [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile ")))
    .map((entry) => path.join(rootDir, entry.name));
}

async function buildProfileCandidates() {
  const explicit = (process.env.APIA_BROWSER_PROFILE_DIR || "").trim();
  if (explicit) {
    return [{ profileDir: explicit, browserName: "explicit", appName: process.env.APIA_BROWSER_APP_NAME || "chromium" }];
  }

  const profiles = [];
  for (const config of chooseBrowserConfigs()) {
    for (const profileDir of await listProfileDirs(config.root)) {
      profiles.push({ profileDir, browserName: config.name, appName: config.appName });
    }
  }
  return profiles;
}

function safeStoragePassword(appName) {
  const proc = Bun.spawnSync(["secret-tool", "lookup", "application", appName], {
    stdout: "pipe",
    stderr: "ignore"
  });
  if (proc.exitCode !== 0) return null;
  const password = proc.stdout.toString().trim();
  return password || null;
}

function decryptCookieValue(encryptedValue, hostKey, dbVersion, password) {
  const buffer = Buffer.isBuffer(encryptedValue)
    ? encryptedValue
    : encryptedValue instanceof Uint8Array
      ? Buffer.from(encryptedValue)
      : Buffer.alloc(0);

  if (buffer.length === 0) return "";

  const prefix = buffer.subarray(0, 3).toString("utf8");
  if (prefix !== "v10" && prefix !== "v11") {
    return buffer.toString("utf8");
  }

  if (!password) {
    throw new Error(`No safe-storage password available to decrypt ${hostKey} cookies`);
  }

  const key = pbkdf2Sync(password, "saltysalt", 1, 16, "sha1");
  const iv = Buffer.alloc(16, " ");
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  let plaintext = Buffer.concat([decipher.update(buffer.subarray(3)), decipher.final()]);

  if (dbVersion >= 24 && plaintext.length > 32) {
    const hostDigest = createHash("sha256").update(hostKey).digest();
    if (plaintext.subarray(0, 32).equals(hostDigest)) {
      plaintext = plaintext.subarray(32);
    }
  }

  return plaintext.toString("utf8");
}

function cookieMatchesHost(hostKey, targetHost) {
  if (hostKey === targetHost) return true;
  if (!hostKey.startsWith(".")) return false;
  return targetHost === hostKey.slice(1) || targetHost.endsWith(hostKey);
}

function chooseCookieRows(rows) {
  const deduped = new Map();

  for (const row of rows) {
    const current = deduped.get(row.name);
    if (!current) {
      deduped.set(row.name, row);
      continue;
    }

    const currentSpecificity = current.host_key === APIA_HOST ? 2 : current.host_key.startsWith(".") ? 1 : 0;
    const rowSpecificity = row.host_key === APIA_HOST ? 2 : row.host_key.startsWith(".") ? 1 : 0;

    if (rowSpecificity > currentSpecificity || row.last_access_utc > current.last_access_utc) {
      deduped.set(row.name, row);
    }
  }

  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readCookiesFromProfile(profile) {
  const cookiesPath = path.join(profile.profileDir, "Cookies");
  if (!(await exists(cookiesPath))) return null;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "apia-cookies-"));
  const tempDb = path.join(tempDir, "Cookies.sqlite");

  try {
    await fs.copyFile(cookiesPath, tempDb);
    const db = new Database(tempDb, { readonly: true, create: false });
    const metaVersion = Number(db.query("select value from meta where key = 'version'").get()?.value || 0);
    const rows = db
      .query(
        "select host_key, name, value, encrypted_value, path, expires_utc, last_access_utc from cookies where host_key like ?"
      )
      .all("%aupairinamerica.com")
      .filter((row) => cookieMatchesHost(row.host_key, APIA_HOST));
    db.close();

    const password = safeStoragePassword(profile.appName);
    const now = Date.now();
    const cookieRows = chooseCookieRows(
      rows
        .filter((row) => {
          const expiresAt = chromiumTimeToUnixMs(row.expires_utc);
          return expiresAt === null || expiresAt > now;
        })
        .map((row) => ({
          ...row,
          decrypted: typeof row.value === "string" && row.value ? row.value : decryptCookieValue(row.encrypted_value, row.host_key, metaVersion, password)
        }))
        .filter((row) => row.decrypted)
    );

    if (cookieRows.length === 0) return null;

    const cookieHeader = cookieRows.map((row) => `${row.name}=${row.decrypted}`).join("; ");
    const requiredNames = ["HFPortalprodSessionId", "HFPortalprodAuth", "__RequestVerificationToken"];
    const names = cookieRows.map((row) => row.name);
    const hasRequired = requiredNames.every((name) => names.includes(name));
    const freshness = Math.max(...cookieRows.map((row) => row.last_access_utc || 0));

    return {
      browserName: profile.browserName,
      profileDir: profile.profileDir,
      cookie: cookieHeader,
      cookieNames: names,
      hasRequired,
      freshness
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const profiles = await buildProfileCandidates();
  const results = [];

  for (const profile of profiles) {
    try {
      const extracted = await readCookiesFromProfile(profile);
      if (extracted) results.push(extracted);
    } catch {
      continue;
    }
  }

  if (results.length === 0) {
    throw new Error("No APIA cookies found in Chrome/Chromium profiles");
  }

  results.sort((a, b) => {
    if (Number(b.hasRequired) !== Number(a.hasRequired)) {
      return Number(b.hasRequired) - Number(a.hasRequired);
    }
    return b.freshness - a.freshness;
  });

  const best = results[0];
  process.stdout.write(
    JSON.stringify({
      url: APIA_URL,
      cookie: best.cookie,
      meta: {
        browserName: best.browserName,
        profileDir: best.profileDir,
        cookieNames: best.cookieNames,
        hasRequired: best.hasRequired
      }
    })
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`APIA cookie extraction failed: ${message}`);
  process.exit(1);
});
