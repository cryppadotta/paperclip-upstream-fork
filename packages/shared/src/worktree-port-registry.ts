import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

type WorktreePortRegistry = {
  version: 1;
  configPaths: string[];
};

const WORKTREE_PORT_REGISTRY_FILE = "worktree-port-reservations.json";
const WORKTREE_PORT_REGISTRY_LOCK_DIR = ".worktree-port-reservations.lock";
const WORKTREE_PORT_REGISTRY_LOCK_OWNER_FILE = "owner.json";
const WORKTREE_PORT_REGISTRY_LOCK_STALE_MS = 5_000;
const WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const sleepSyncBuffer = new Int32Array(new SharedArrayBuffer(4));

type RegistryLockOwner = {
  version: 1;
  pid: number;
  processIdentity: string;
  token: string;
};

function resolveRegistryLockPath(homeDir: string): string {
  fs.mkdirSync(homeDir, { recursive: true });
  return path.resolve(homeDir, WORKTREE_PORT_REGISTRY_LOCK_DIR);
}

function readRegistryLockOwner(lockPath: string): RegistryLockOwner | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(lockPath, WORKTREE_PORT_REGISTRY_LOCK_OWNER_FILE), "utf8"),
    ) as Partial<RegistryLockOwner>;
    if (
      parsed.version !== 1
      || !Number.isInteger(parsed.pid)
      || (parsed.pid ?? 0) <= 0
      || typeof parsed.processIdentity !== "string"
      || parsed.processIdentity.length === 0
      || typeof parsed.token !== "string"
      || parsed.token.length === 0
    ) {
      return null;
    }
    return parsed as RegistryLockOwner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function readProcessIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return null;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      if (!startTicks) return null;
      const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      return bootId ? `linux:${bootId}:${startTicks}` : null;
    } catch {
      return null;
    }
  }

  try {
    if (process.platform === "win32") {
      const ticks = execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf8", windowsHide: true }).trim();
      return ticks ? `win32:${ticks}` : null;
    }
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    return startedAt ? `${process.platform}:${startedAt}` : null;
  } catch {
    return null;
  }
}

function removeStaleRegistryLock(lockPath: string): boolean {
  try {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs <= WORKTREE_PORT_REGISTRY_LOCK_STALE_MS) return false;
    const owner = readRegistryLockOwner(lockPath);
    if (owner && isProcessAlive(owner.pid)) {
      const currentIdentity = readProcessIdentity(owner.pid);
      if (owner.processIdentity === currentIdentity) {
        return false;
      }
    }
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function acquireRegistryLock(lockPath: string, deadline: number): string | null {
  try {
    fs.mkdirSync(lockPath);
    const token = `${process.pid}-${randomUUID()}`;
    try {
      const processIdentity = readProcessIdentity(process.pid);
      if (!processIdentity) {
        throw new Error("Cannot determine worktree port reservation lock owner identity");
      }
      const owner: RegistryLockOwner = {
        version: 1,
        pid: process.pid,
        processIdentity,
        token,
      };
      fs.writeFileSync(
        path.join(lockPath, WORKTREE_PORT_REGISTRY_LOCK_OWNER_FILE),
        `${JSON.stringify(owner)}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
    return token;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code !== "EEXIST") throw error;
    if (removeStaleRegistryLock(lockPath)) return null;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for worktree port reservation lock at ${lockPath}`);
    }
    return null;
  }
}

function releaseRegistryLock(lockPath: string, token: string): void {
  const owner = readRegistryLockOwner(lockPath);
  if (owner?.token !== token) {
    return;
  }
  fs.rmSync(lockPath, { recursive: true, force: true });
}

export function withWorktreePortRegistryLockSync<T>(homeDir: string, run: () => T): T {
  const lockPath = resolveRegistryLockPath(homeDir);
  const deadline = Date.now() + WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS;
  let token: string | null = null;

  while (!(token = acquireRegistryLock(lockPath, deadline))) {
    Atomics.wait(sleepSyncBuffer, 0, 0, 25);
  }

  try {
    return run();
  } finally {
    releaseRegistryLock(lockPath, token);
  }
}

export async function withWorktreePortRegistryLock<T>(
  homeDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveRegistryLockPath(homeDir);
  const deadline = Date.now() + WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS;
  let token: string | null = null;

  while (!(token = acquireRegistryLock(lockPath, deadline))) {
    await delay(25);
  }

  try {
    return await run();
  } finally {
    releaseRegistryLock(lockPath, token);
  }
}

export function readWorktreePortRegistry(homeDir: string): Set<string> {
  const registryPath = path.resolve(homeDir, WORKTREE_PORT_REGISTRY_FILE);
  if (!fs.existsSync(registryPath)) return new Set();

  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as Partial<WorktreePortRegistry>;
    if (parsed.version !== 1 || !Array.isArray(parsed.configPaths)) return new Set();
    return new Set(
      parsed.configPaths
        .filter((configPath): configPath is string => typeof configPath === "string" && configPath.length > 0)
        .map((configPath) => path.resolve(configPath)),
    );
  } catch {
    return new Set();
  }
}

export function writeWorktreePortRegistry(homeDir: string, configPaths: Iterable<string>): void {
  fs.mkdirSync(homeDir, { recursive: true });
  const registryPath = path.resolve(homeDir, WORKTREE_PORT_REGISTRY_FILE);
  const persistedPaths = Array.from(new Set(Array.from(configPaths, (configPath) => path.resolve(configPath))))
    .filter((configPath) => fs.existsSync(configPath))
    .sort();
  const registry: WorktreePortRegistry = {
    version: 1,
    configPaths: persistedPaths,
  };
  const temporaryPath = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, registryPath);
}
