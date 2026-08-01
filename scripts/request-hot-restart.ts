#!/usr/bin/env -S node --import tsx
import { eq } from "drizzle-orm";
import { createDb, heartbeatRuns } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import {
  resolveHotRestartIntentPath,
  writeHotRestartIntent,
} from "../server/src/services/hot-restart.js";

function usage(): never {
  console.error([
    "Usage: tsx scripts/request-hot-restart.ts --server-pid <pid> [--drain-required]",
    "",
    "Writes an instance-scoped hot-restart intent plus a legacy home-root handoff marker.",
  ].join("\n"));
  process.exit(2);
}

function readArgs(argv: string[]) {
  let serverPid: number | null = null;
  let drainRequired = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server-pid") {
      const raw = argv[index + 1];
      if (!raw) usage();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) usage();
      serverPid = parsed;
      index += 1;
      continue;
    }
    if (arg === "--drain-required") {
      drainRequired = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") usage();
    console.error(`Unknown argument: ${arg}`);
    usage();
  }

  if (!serverPid) usage();
  return { serverPid, drainRequired };
}

function normalizeApiBase(raw: string | undefined) {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "").replace(/\/api$/, "");
}

async function readPreviousServerVersion() {
  const apiBase = normalizeApiBase(process.env.PAPERCLIP_API_URL);
  if (!apiBase) return null;
  try {
    const response = await fetch(`${apiBase}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = await response.json() as Record<string, unknown>;
    return typeof body.serverVersion === "string"
      ? body.serverVersion
      : typeof body.version === "string"
        ? body.version
        : null;
  } catch {
    return null;
  }
}

async function readPreflightActiveRunIds() {
  const config = loadConfig();
  const dbUrl = process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  try {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "running"));
    return rows.map((row) => row.id);
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

const { serverPid, drainRequired } = readArgs(process.argv.slice(2));
const preflightActiveRunIds = drainRequired ? [] : await readPreflightActiveRunIds();
const intent = await writeHotRestartIntent({
  previousServerPid: serverPid,
  previousServerVersion: await readPreviousServerVersion(),
  drainRequired,
  requestedByRunId: process.env.PAPERCLIP_RUN_ID?.trim() || null,
  preflightActiveRunIds,
});

console.log(JSON.stringify({
  status: "hot_restart_intent_written",
  intentPath: resolveHotRestartIntentPath(),
  previousServerPid: intent.previousServerPid,
  previousServerVersion: intent.previousServerVersion,
  drainRequired: intent.drainRequired,
  preflightActiveRunIds: intent.preflightActiveRunIds,
}, null, 2));
