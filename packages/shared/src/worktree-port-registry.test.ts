import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { withWorktreePortRegistryLock } from "./worktree-port-registry.js";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-port-registry-lock-"));
  temporaryRoots.push(root);
  return root;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("worktree port registry lock", () => {
  it("does not reclaim an old lock while its owner process is alive", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    const firstEntered = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;

    const first = withWorktreePortRegistryLock(homeDir, async () => {
      const oldTimestamp = new Date(Date.now() - 10_000);
      fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withWorktreePortRegistryLock(homeDir, async () => {
      secondEntered = true;
    });
    await delay(100);

    expect(secondEntered).toBe(false);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });

  it("reclaims an old lock after its owner process exits", async () => {
    const homeDir = makeTemporaryRoot();
    const lockPath = path.join(homeDir, ".worktree-port-reservations.lock");
    fs.mkdirSync(lockPath);
    fs.writeFileSync(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ version: 1, pid: 2_147_483_647, token: "dead-owner" })}\n`,
    );
    const oldTimestamp = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, oldTimestamp, oldTimestamp);

    let entered = false;
    await withWorktreePortRegistryLock(homeDir, async () => {
      entered = true;
    });

    expect(entered).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
