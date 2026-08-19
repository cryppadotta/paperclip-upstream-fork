import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

type WorktreePortRegistry = {
  version: 1;
  configPaths: string[];
};

const WORKTREE_PORT_REGISTRY_FILE = "worktree-port-reservations.json";
const WORKTREE_PORT_REGISTRY_LOCK_DIR = ".worktree-port-reservations.lock";
const WORKTREE_PORT_REGISTRY_LOCK_STALE_MS = 5_000;
const WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const sleepSyncBuffer = new Int32Array(new SharedArrayBuffer(4));

function resolveRegistryLockPath(homeDir: string): string {
  fs.mkdirSync(homeDir, { recursive: true });
  return path.resolve(homeDir, WORKTREE_PORT_REGISTRY_LOCK_DIR);
}

function removeStaleRegistryLock(lockPath: string): boolean {
  try {
    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    if (ageMs <= WORKTREE_PORT_REGISTRY_LOCK_STALE_MS) return false;
    fs.rmSync(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function acquireRegistryLock(lockPath: string, deadline: number): boolean {
  try {
    fs.mkdirSync(lockPath);
    return true;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    if (code !== "EEXIST") throw error;
    if (removeStaleRegistryLock(lockPath)) return false;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for worktree port reservation lock at ${lockPath}`);
    }
    return false;
  }
}

export function withWorktreePortRegistryLockSync<T>(homeDir: string, run: () => T): T {
  const lockPath = resolveRegistryLockPath(homeDir);
  const deadline = Date.now() + WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS;

  while (!acquireRegistryLock(lockPath, deadline)) {
    Atomics.wait(sleepSyncBuffer, 0, 0, 25);
  }

  try {
    return run();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export async function withWorktreePortRegistryLock<T>(
  homeDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveRegistryLockPath(homeDir);
  const deadline = Date.now() + WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS;

  while (!acquireRegistryLock(lockPath, deadline)) {
    await delay(25);
  }

  try {
    return await run();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
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
