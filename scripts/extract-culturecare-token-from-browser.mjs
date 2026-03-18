#!/usr/bin/env bun

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const JWT_REGEX = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function exists(dirPath) {
  try {
    await fs.access(dirPath);
    return true;
  } catch {
    return false;
  }
}

async function listProfileDirs(rootDir) {
  if (!(await exists(rootDir))) return [];
  const out = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "Default" || entry.name.startsWith("Profile ")) {
      out.push(path.join(rootDir, entry.name));
    }
  }
  return out;
}

async function collectLevelDbFiles(dirPath) {
  if (!(await exists(dirPath))) return [];
  const out = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectLevelDbFiles(full);
      out.push(...nested);
      continue;
    }
    if (/\.(ldb|log|sst)$/i.test(entry.name) || /^MANIFEST/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function chooseRoots() {
  const browser = (process.env.CULTURECARE_BROWSER || "auto").toLowerCase();
  const home = os.homedir();
  const chromeRoot = path.join(home, ".config", "google-chrome");
  const chromiumRoot = path.join(home, ".config", "chromium");

  if (browser === "chrome") return [chromeRoot];
  if (browser === "chromium") return [chromiumRoot];
  return [chromeRoot, chromiumRoot];
}

async function buildProfileCandidates() {
  const explicit = (process.env.CULTURECARE_BROWSER_PROFILE_DIR || "").trim();
  if (explicit) return [explicit];

  const roots = chooseRoots();
  const profiles = [];
  for (const root of roots) {
    const listed = await listProfileDirs(root);
    profiles.push(...listed);
  }
  return profiles;
}

function extractJwtCandidatesFromBytes(bytes) {
  const decoded = [bytes.toString("utf8"), bytes.toString("latin1"), bytes.toString("utf16le")];
  const out = new Set();

  for (const text of decoded) {
    const normalized = text.replace(/\u0000/g, "");
    const tokens = normalized.match(JWT_REGEX) || [];
    for (const token of tokens) {
      out.add(token);
    }
  }

  return [...out];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractRefreshCandidatesFromBytes(bytes, clientId) {
  const decoded = [bytes.toString("utf8"), bytes.toString("latin1"), bytes.toString("utf16le")];
  const out = new Set();

  const keySpecificPattern = new RegExp(
    `${escapeRegex(clientId)}\\.refreshToken[^A-Za-z0-9_-]*(eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]*\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+)`,
    "g"
  );

  const patterns = [
    /refreshToken["\s:=]+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g,
    /\.refreshToken["\s:=]+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g
  ];

  for (const text of decoded) {
    const normalized = text.replace(/\u0000/g, "");

    for (const match of normalized.matchAll(keySpecificPattern)) {
      const token = (match[1] || "").trim();
      if (token.length >= 30) {
        out.add(token);
      }
    }

    for (const regex of patterns) {
      for (const match of normalized.matchAll(regex)) {
        const token = (match[1] || "").trim();
        if (token.length >= 30) {
          out.add(token);
        }
      }
    }
  }

  return [...out];
}

function tokenLooksCultureCare(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.token_use !== "id" && payload.token_use !== "access") return false;
  if (typeof payload.exp !== "number") return false;
  if (typeof payload.iss === "string" && payload.iss.includes("cognito-idp")) return true;
  return typeof payload.aud === "string";
}

async function main() {
  const clientId = process.env.CULTURECARE_COGNITO_CLIENT_ID || "3jsqobi851prmu958rn4b0t26e";
  const profiles = await buildProfileCandidates();
  const now = Math.floor(Date.now() / 1000);
  const seen = new Set();
  const matches = [];

  for (const profileDir of profiles) {
    const localStorageDir = path.join(profileDir, "Local Storage", "leveldb");
    const sessionStorageDir = path.join(profileDir, "Session Storage");
    const indexedDbRoot = path.join(profileDir, "IndexedDB");

    const files = [];
    files.push(...(await collectLevelDbFiles(localStorageDir)));
    files.push(...(await collectLevelDbFiles(sessionStorageDir)));

    if (await exists(indexedDbRoot)) {
      const idbEntries = await fs.readdir(indexedDbRoot, { withFileTypes: true });
      for (const entry of idbEntries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.endsWith(".indexeddb.leveldb")) continue;
        files.push(...(await collectLevelDbFiles(path.join(indexedDbRoot, entry.name))));
      }
    }

    for (const filePath of files) {
      let bytes;
      try {
        bytes = await fs.readFile(filePath);
      } catch {
        continue;
      }

      const tokens = extractJwtCandidatesFromBytes(bytes);
      for (const token of tokens) {
        if (seen.has(token)) continue;
        seen.add(token);
        const payload = decodeJwtPayload(token);
        if (!tokenLooksCultureCare(payload)) continue;
        if (payload.exp <= now + 30) continue;
        matches.push({
          token,
          exp: payload.exp,
          tokenUse: payload.token_use,
          profileDir,
          filePath
        });
      }
    }
  }

  if (!matches.length) {
    throw new Error("No fresh Culture Care bearer token found in Chrome/Chromium profiles");
  }

  matches.sort((a, b) => b.exp - a.exp);
  const bestAccess = matches.find((match) => match.tokenUse === "access") || null;
  const bestId = matches.find((match) => match.tokenUse === "id") || null;
  const best = bestAccess || bestId || matches[0];

  let refreshToken = null;
  try {
    const bestBytes = await fs.readFile(best.filePath);
    const refreshCandidates = extractRefreshCandidatesFromBytes(bestBytes, clientId);
    if (refreshCandidates.length > 0) {
      refreshCandidates.sort((a, b) => b.length - a.length);
      refreshToken = refreshCandidates[0];
    }
  } catch {
    refreshToken = null;
  }

  process.stdout.write(
    JSON.stringify({
      bearer: best.token,
      idToken: bestId?.token || null,
      refreshToken,
      meta: {
        tokenUse: best.tokenUse,
        expiresAt: new Date(best.exp * 1000).toISOString(),
        profileDir: best.profileDir,
        sourceFile: best.filePath
      }
    })
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Token extraction failed: ${message}`);
  process.exit(1);
});
