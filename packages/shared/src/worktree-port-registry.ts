import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

type WorktreePortRegistry = {
  version: 1;
  configPaths: string[];
};

const WORKTREE_PORT_REGISTRY_FILE = "worktree-port-reservations.json";
const WORKTREE_PORT_REGISTRY_LOCK_DIR = ".worktree-port-reservations.lock";
const WORKTREE_PORT_REGISTRY_LOCK_OWNER_FILE = "owner.json";
const WORKTREE_PORT_REGISTRY_LOCK_STALE_MS = 5_000;
const WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const WORKTREE_PORT_REGISTRY_LOCK_HEARTBEAT_MS = 1_000;
const sleepSyncBuffer = new Int32Array(new SharedArrayBuffer(4));

type RegistryLockOwner = {
  version: 1;
  pid: number;
  token: string;
};

type RegistryLockLease = {
  token: string;
  worker: Worker;
  control: Int32Array;
};

const REGISTRY_LOCK_HEARTBEAT_SOURCE = `
const fs = require("node:fs");
const path = require("node:path");
const { workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.control);
const ownerPath = path.join(workerData.lockPath, workerData.ownerFile);
function touchOwnedLock() {
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    if (owner.token !== workerData.token) return false;
    const now = new Date();
    fs.utimesSync(workerData.lockPath, now, now);
    return true;
  } catch {
    return false;
  }
}
if (touchOwnedLock()) {
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
  while (Atomics.load(control, 1) === 0) {
    Atomics.wait(control, 1, 0, workerData.heartbeatMs);
    if (Atomics.load(control, 1) !== 0 || !touchOwnedLock()) break;
  }
}
Atomics.store(control, 0, 2);
Atomics.notify(control, 0);
`;

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

function startRegistryLockHeartbeat(lockPath: string, token: string): RegistryLockLease {
  const control = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(REGISTRY_LOCK_HEARTBEAT_SOURCE, {
    eval: true,
    workerData: {
      control: control.buffer,
      heartbeatMs: WORKTREE_PORT_REGISTRY_LOCK_HEARTBEAT_MS,
      lockPath,
      ownerFile: WORKTREE_PORT_REGISTRY_LOCK_OWNER_FILE,
      token,
    },
  });
  Atomics.wait(control, 0, 0, 2_000);
  if (Atomics.load(control, 0) !== 1) {
    void worker.terminate();
    throw new Error(`Failed to start worktree port reservation lock heartbeat at ${lockPath}`);
  }
  return { token, worker, control };
}

function stopRegistryLockHeartbeat(lease: RegistryLockLease): void {
  Atomics.store(lease.control, 1, 1);
  Atomics.notify(lease.control, 1);
  if (Atomics.load(lease.control, 0) === 1) {
    Atomics.wait(lease.control, 0, 1, 2_000);
  }
  void lease.worker.terminate();
}

function acquireRegistryLock(lockPath: string, deadline: number): RegistryLockLease | null {
  try {
    fs.mkdirSync(lockPath);
    const token = `${process.pid}-${randomUUID()}`;
    try {
      const owner: RegistryLockOwner = {
        version: 1,
        pid: process.pid,
        token,
      };
      fs.writeFileSync(
        path.join(lockPath, WORKTREE_PORT_REGISTRY_LOCK_OWNER_FILE),
        `${JSON.stringify(owner)}\n`,
        { mode: 0o600 },
      );
      return startRegistryLockHeartbeat(lockPath, token);
    } catch (error) {
      fs.rmSync(lockPath, { recursive: true, force: true });
      throw error;
    }
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

function releaseRegistryLock(lockPath: string, lease: RegistryLockLease): void {
  stopRegistryLockHeartbeat(lease);
  const owner = readRegistryLockOwner(lockPath);
  if (owner?.token !== lease.token) {
    return;
  }
  fs.rmSync(lockPath, { recursive: true, force: true });
}

export function withWorktreePortRegistryLockSync<T>(homeDir: string, run: () => T): T {
  const lockPath = resolveRegistryLockPath(homeDir);
  const deadline = Date.now() + WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS;
  let lease: RegistryLockLease | null = null;

  while (!(lease = acquireRegistryLock(lockPath, deadline))) {
    Atomics.wait(sleepSyncBuffer, 0, 0, 25);
  }

  try {
    return run();
  } finally {
    releaseRegistryLock(lockPath, lease);
  }
}

export async function withWorktreePortRegistryLock<T>(
  homeDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockPath = resolveRegistryLockPath(homeDir);
  const deadline = Date.now() + WORKTREE_PORT_REGISTRY_LOCK_TIMEOUT_MS;
  let lease: RegistryLockLease | null = null;

  while (!(lease = acquireRegistryLock(lockPath, deadline))) {
    await delay(25);
  }

  try {
    return await run();
  } finally {
    releaseRegistryLock(lockPath, lease);
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
