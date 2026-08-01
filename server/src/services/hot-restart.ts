import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";

export const HOT_RESTART_INTENT_FILENAME = "hot-restart-intent.json";
export const HOT_RESTART_REPORT_FILENAME = "hot-restart-report.json";

export type HotRestartIntentRun = {
  runId: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  status: string;
  processPid: number | null;
  processGroupId: number | null;
  issueId: string | null;
};

export type HotRestartIntent = {
  version: 1;
  requestedAt: string;
  previousServerPid: number;
  previousServerVersion: string | null;
  drainRequired: boolean;
  requestedByRunId: string | null;
  preflightActiveRunIds: string[];
  shutdownSnapshot?: {
    capturedAt: string;
    signal: "SIGINT" | "SIGTERM";
    activeRuns: HotRestartIntentRun[];
  };
};

export type HotRestartReportRun = HotRestartIntentRun & {
  classification:
    | "adopted"
    | "finalized_while_down"
    | "lost"
    | "skipped";
  reason: string;
};

export type HotRestartReport = {
  version: 1;
  requestedAt: string;
  completedAt: string;
  drainRequired: boolean;
  previousServerPid: number;
  newServerPid: number;
  previousServerVersion: string | null;
  newServerVersion: string;
  adoptedRunIds: string[];
  finalizedWhileDownRunIds: string[];
  lostRunIds: string[];
  skippedRunIds: string[];
  runs: HotRestartReportRun[];
};

function resolveHotRestartPath(filename: string, homeDir?: string) {
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), filename);
}

function resolveLegacyHotRestartPath(filename: string, homeDir?: string) {
  return path.join(resolvePaperclipHomeDir(homeDir), filename);
}

export function resolveHotRestartIntentPath(homeDir?: string) {
  return resolveHotRestartPath(HOT_RESTART_INTENT_FILENAME, homeDir);
}

export function resolveLegacyHotRestartIntentPath(homeDir?: string) {
  return resolveLegacyHotRestartPath(HOT_RESTART_INTENT_FILENAME, homeDir);
}

export function resolveHotRestartReportPath(homeDir?: string) {
  return resolveHotRestartPath(HOT_RESTART_REPORT_FILENAME, homeDir);
}

async function writeJsonFileAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

async function writeJsonFileExclusiveAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.link(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(asString).filter((entry): entry is string => entry !== null))];
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function isSameHotRestartRequest(left: HotRestartIntent, right: HotRestartIntent) {
  return left.requestedAt === right.requestedAt
    && left.previousServerPid === right.previousServerPid
    && left.drainRequired === right.drainRequired
    && left.requestedByRunId === right.requestedByRunId;
}

function parseRun(value: unknown): HotRestartIntentRun | null {
  if (!isRecord(value)) return null;
  const runId = asString(value.runId);
  const companyId = asString(value.companyId);
  const agentId = asString(value.agentId);
  const adapterType = asString(value.adapterType);
  const status = asString(value.status);
  if (!runId || !companyId || !agentId || !adapterType || !status) return null;
  return {
    runId,
    companyId,
    agentId,
    adapterType,
    status,
    processPid: asNumber(value.processPid),
    processGroupId: asNumber(value.processGroupId),
    issueId: asString(value.issueId),
  };
}

export function parseHotRestartIntent(value: unknown): HotRestartIntent | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const requestedAt = asString(value.requestedAt);
  const previousServerPid = asNumber(value.previousServerPid);
  if (!requestedAt || !previousServerPid) return null;

  const intent: HotRestartIntent = {
    version: 1,
    requestedAt,
    previousServerPid,
    previousServerVersion: asString(value.previousServerVersion),
    drainRequired: asBoolean(value.drainRequired),
    requestedByRunId: asString(value.requestedByRunId),
    preflightActiveRunIds: asStringArray(value.preflightActiveRunIds),
  };

  const snapshot = isRecord(value.shutdownSnapshot) ? value.shutdownSnapshot : null;
  const signal = snapshot?.signal === "SIGINT" || snapshot?.signal === "SIGTERM"
    ? snapshot.signal
    : null;
  const capturedAt = asString(snapshot?.capturedAt);
  const activeRuns = Array.isArray(snapshot?.activeRuns)
    ? snapshot.activeRuns.map(parseRun).filter((run): run is HotRestartIntentRun => run !== null)
    : [];
  if (signal && capturedAt) {
    intent.shutdownSnapshot = { capturedAt, signal, activeRuns };
  }

  return intent;
}

async function readHotRestartIntentAtPath(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseHotRestartIntent(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readHotRestartIntent(homeDir?: string) {
  const instanceIntent = await readHotRestartIntentAtPath(resolveHotRestartIntentPath(homeDir));
  let legacyIntent: HotRestartIntent | null;
  try {
    legacyIntent = await readHotRestartIntentAtPath(resolveLegacyHotRestartIntentPath(homeDir));
  } catch (error) {
    if (instanceIntent) return instanceIntent;
    throw error;
  }

  if (!instanceIntent) {
    // The home-root marker predates instances. Only the default instance may
    // consume it without an instance-root request to correlate against.
    return resolvePaperclipInstanceId() === "default" ? legacyIntent : null;
  }
  if (!legacyIntent || !isSameHotRestartRequest(instanceIntent, legacyIntent)) {
    return instanceIntent;
  }

  // A pre-instance server rewrites only the legacy marker when it captures
  // its shutdown snapshot. Preserve the instance-scoped request fields while
  // importing that snapshot only after the immutable request identity matches.
  return legacyIntent.shutdownSnapshot
    ? { ...instanceIntent, shutdownSnapshot: legacyIntent.shutdownSnapshot }
    : instanceIntent;
}

export function findMissingHotRestartSnapshotRunIds(intent: HotRestartIntent) {
  const snapshotRunIds = new Set(intent.shutdownSnapshot?.activeRuns.map((run) => run.runId) ?? []);
  return intent.preflightActiveRunIds.filter((runId) => !snapshotRunIds.has(runId));
}

export async function writeHotRestartIntent(input: {
  previousServerPid: number;
  previousServerVersion?: string | null;
  drainRequired?: boolean;
  requestedByRunId?: string | null;
  preflightActiveRunIds?: string[];
  requestedAt?: Date;
  homeDir?: string;
}) {
  const intent: HotRestartIntent = {
    version: 1,
    requestedAt: (input.requestedAt ?? new Date()).toISOString(),
    previousServerPid: input.previousServerPid,
    previousServerVersion: input.previousServerVersion ?? null,
    drainRequired: input.drainRequired ?? false,
    requestedByRunId: input.requestedByRunId ?? null,
    preflightActiveRunIds: asStringArray(input.preflightActiveRunIds),
  };
  const instancePath = resolveHotRestartIntentPath(input.homeDir);
  const legacyPath = resolveLegacyHotRestartIntentPath(input.homeDir);
  // The legacy location is shared by every instance under PAPERCLIP_HOME.
  // Claim it without replacement so concurrent staged restarts fail closed
  // instead of making the first old server consume another instance's PID.
  await claimLegacyHotRestartIntent(legacyPath, intent);
  try {
    await writeJsonFileAtomic(instancePath, intent);
  } catch (error) {
    await removeMatchingHotRestartIntent(legacyPath, intent).catch(() => undefined);
    throw error;
  }
  return intent;
}

export async function writeHotRestartShutdownSnapshot(input: {
  intent: HotRestartIntent;
  signal: "SIGINT" | "SIGTERM";
  activeRuns: HotRestartIntentRun[];
  capturedAt?: Date;
  homeDir?: string;
}) {
  const updated: HotRestartIntent = {
    ...input.intent,
    shutdownSnapshot: {
      capturedAt: (input.capturedAt ?? new Date()).toISOString(),
      signal: input.signal,
      activeRuns: input.activeRuns,
    },
  };
  await writeJsonFileAtomic(resolveHotRestartIntentPath(input.homeDir), updated);
  const legacyPath = resolveLegacyHotRestartIntentPath(input.homeDir);
  const legacyIntent = await readHotRestartIntentAtPath(legacyPath).catch(() => null);
  if (legacyIntent && isSameHotRestartRequest(legacyIntent, input.intent)) {
    await writeJsonFileAtomic(legacyPath, updated);
  }
  return updated;
}

export async function writeHotRestartReport(report: HotRestartReport, homeDir?: string) {
  await writeJsonFileAtomic(resolveHotRestartReportPath(homeDir), report);
  return report;
}

async function removeMatchingHotRestartIntent(filePath: string, expected?: HotRestartIntent) {
  try {
    if (expected) {
      const current = await readHotRestartIntentAtPath(filePath);
      if (!current || !isSameHotRestartRequest(current, expected)) return;
    }
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function claimLegacyHotRestartIntent(filePath: string, intent: HotRestartIntent) {
  try {
    await writeJsonFileExclusiveAtomic(filePath, intent);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const existing = await readHotRestartIntentAtPath(filePath).catch(() => null);
    if (!existing || isProcessAlive(existing.previousServerPid)) throw error;

    // An interrupted restart can leave the shared claim behind after its
    // target server exits. Remove only that exact abandoned request, then
    // compete normally for a fresh exclusive claim.
    await removeMatchingHotRestartIntent(filePath, existing);
    await writeJsonFileExclusiveAtomic(filePath, intent);
  }
}

export async function removeHotRestartIntent(homeDir?: string, expected?: HotRestartIntent) {
  await Promise.all([
    removeMatchingHotRestartIntent(resolveHotRestartIntentPath(homeDir), expected),
    removeMatchingHotRestartIntent(resolveLegacyHotRestartIntentPath(homeDir), expected),
  ]);
}

export function shouldHonorHotRestartIntentForProcess(
  intent: HotRestartIntent,
  pid = process.pid,
) {
  return !intent.drainRequired && intent.previousServerPid === pid;
}
