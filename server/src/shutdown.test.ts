import { EventEmitter } from "node:events";
import { loadEmbeddedPostgresCtor } from "@paperclipai/db";
import { describe, expect, it, vi } from "vitest";
import {
  coordinateHeartbeatSchedulerShutdown,
  loadWithoutCoordinatedShutdownSignalHooks,
  stopManagedEmbeddedPostgres,
} from "./shutdown.js";

describe("stopManagedEmbeddedPostgres", () => {
  it("stops a cluster started by the current server through its instance", async () => {
    const stop = vi.fn(async () => undefined);
    const signalProcess = vi.fn();

    await stopManagedEmbeddedPostgres({
      instance: { stop },
      adoptedPid: null,
      readRunningPid: () => null,
      isExpectedProcess: () => false,
      signalProcess,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("stops an adopted crash-surviving postmaster", async () => {
    let runningPid: number | null = 4242;
    const signalProcess = vi.fn(() => {
      runningPid = null;
    });

    await stopManagedEmbeddedPostgres({
      instance: null,
      adoptedPid: 4242,
      readRunningPid: () => runningPid,
      isExpectedProcess: (pid) => pid === 4242,
      signalProcess,
      pollIntervalMs: 0,
    });

    expect(signalProcess).toHaveBeenCalledWith(4242, "SIGINT");
  });

  it("refuses to signal a pid that no longer matches the managed cluster", async () => {
    const signalProcess = vi.fn();

    await expect(stopManagedEmbeddedPostgres({
      instance: null,
      adoptedPid: 4242,
      readRunningPid: () => 5252,
      isExpectedProcess: () => true,
      signalProcess,
    })).rejects.toThrow("no longer matches postmaster.pid (5252)");
    expect(signalProcess).not.toHaveBeenCalled();
  });

  it("refuses a reused pid whose command no longer identifies the postmaster", async () => {
    const signalProcess = vi.fn();

    await expect(stopManagedEmbeddedPostgres({
      instance: null,
      adoptedPid: 4242,
      readRunningPid: () => 4242,
      isExpectedProcess: () => false,
      signalProcess,
    })).rejects.toThrow("no longer matches the managed postmaster command");
    expect(signalProcess).not.toHaveBeenCalled();
  });
});

describe("loadWithoutCoordinatedShutdownSignalHooks", () => {
  it("removes the eager signal handlers from the real embedded-postgres import", async () => {
    const before = {
      SIGINT: process.rawListeners("SIGINT"),
      SIGTERM: process.rawListeners("SIGTERM"),
    };
    await loadWithoutCoordinatedShutdownSignalHooks(() => loadEmbeddedPostgresCtor());

    expect(process.rawListeners("SIGINT")).toEqual(before.SIGINT);
    expect(process.rawListeners("SIGTERM")).toEqual(before.SIGTERM);
  });

  it("keeps the database available for a marker-backed SIGTERM snapshot", async () => {
    const signalTarget = new EventEmitter();
    const preexistingSignalListener = vi.fn();
    signalTarget.on("SIGTERM", preexistingSignalListener);

    let databaseAvailable = true;
    const embeddedPostgresExitHook = vi.fn(() => {
      databaseAvailable = false;
    });
    await loadWithoutCoordinatedShutdownSignalHooks(
      async () => {
        signalTarget.on("SIGINT", embeddedPostgresExitHook);
        signalTarget.on("SIGTERM", embeddedPostgresExitHook);
        return { default: class EmbeddedPostgres {} };
      },
      signalTarget,
    );

    let shutdown: Promise<unknown> | null = null;
    let snapshotCaptured = false;
    signalTarget.once("SIGTERM", () => {
      shutdown = coordinateHeartbeatSchedulerShutdown({
        signal: "SIGTERM",
        prepareHotRestartShutdown: async () => {
          // This models the real failure path: a valid intent exists, and the
          // snapshot must query embedded PostgreSQL after SIGTERM is delivered.
          expect(databaseAvailable).toBe(true);
          snapshotCaptured = true;
          return { mode: "hot_restart" as const, skipDrain: true };
        },
        waitForHeartbeatSchedulerIdle: vi.fn(async () => undefined),
      });
    });

    signalTarget.emit("SIGTERM");
    await shutdown;

    expect(preexistingSignalListener).toHaveBeenCalledOnce();
    expect(embeddedPostgresExitHook).not.toHaveBeenCalled();
    expect(snapshotCaptured).toBe(true);
  });
});

describe("coordinateHeartbeatSchedulerShutdown", () => {
  it("quiesces active scheduler work before capturing a hot-restart snapshot", async () => {
    let snapshotCaptured = false;
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        snapshotCaptured = true;
        return { mode: "prepared" as const, skipDrain: true };
      }),
      waitForHeartbeatSchedulerIdle,
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(snapshotCaptured).toBe(false);
    releaseScheduler();

    const result = await shutdown;
    expect(snapshotCaptured).toBe(true);
    expect(result).toEqual({
      hotRestart: { mode: "prepared", skipDrain: true },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("quiesces scheduler work before selecting server-stdio runs to drain", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "acp_drain_required" as const,
        skipDrain: false,
        drainRunIds: ["acp-run"],
      })),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: {
        mode: "acp_drain_required",
        skipDrain: false,
        drainRunIds: ["acp-run"],
      },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("preserves the scheduler idle wait for normal graceful shutdown", async () => {
    let releaseScheduler!: () => void;
    const schedulerIdle = new Promise<void>((resolve) => {
      releaseScheduler = resolve;
    });
    const waitForHeartbeatSchedulerIdle = vi.fn(() => schedulerIdle);
    let settled = false;

    const shutdown = coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => ({
        mode: "not_requested" as const,
        skipDrain: false,
      })),
      waitForHeartbeatSchedulerIdle,
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    releaseScheduler();

    await expect(shutdown).resolves.toEqual({
      hotRestart: { mode: "not_requested", skipDrain: false },
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("waits for scheduler idle when hot-restart preparation is unavailable", async () => {
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: null,
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError: null,
      waitedForSchedulerIdle: true,
    });
  });

  it("falls back to the scheduler idle wait when hot-restart preparation fails", async () => {
    const preparationError = new Error("snapshot failed");
    const waitForHeartbeatSchedulerIdle = vi.fn(async () => undefined);

    const result = await coordinateHeartbeatSchedulerShutdown({
      signal: "SIGTERM",
      prepareHotRestartShutdown: vi.fn(async () => {
        throw preparationError;
      }),
      waitForHeartbeatSchedulerIdle,
    });

    expect(waitForHeartbeatSchedulerIdle).toHaveBeenCalledOnce();
    expect(result).toEqual({
      hotRestart: null,
      preparationError,
      waitedForSchedulerIdle: true,
    });
  });
});
