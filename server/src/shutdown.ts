type HotRestartShutdownPreparation = {
  skipDrain: boolean;
};

const COORDINATED_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignalTarget = {
  rawListeners(eventName: string): Function[];
  removeListener(eventName: string, listener: (...args: any[]) => void): unknown;
};

type EmbeddedPostgresStopTarget = {
  stop(): Promise<void>;
};

type StopManagedEmbeddedPostgresInput = {
  instance: EmbeddedPostgresStopTarget | null;
  adoptedPid: number | null;
  readRunningPid: () => number | null;
  isExpectedProcess: (pid: number) => boolean;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  timeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Stop the embedded cluster even when this server adopted a postmaster left
 * behind by a crash-restarted predecessor. `embedded-postgres.stop()` only
 * acts on a child spawned by the current JS object, so adopted clusters must
 * be signalled explicitly after re-validating the data directory's pid file.
 */
export async function stopManagedEmbeddedPostgres(
  input: StopManagedEmbeddedPostgresInput,
): Promise<void> {
  if (input.instance) {
    await input.instance.stop();
    return;
  }

  if (input.adoptedPid === null) return;

  const currentPid = input.readRunningPid();
  if (currentPid === null) return;
  if (currentPid !== input.adoptedPid) {
    throw new Error(
      `Refusing to stop embedded PostgreSQL: adopted pid ${input.adoptedPid} ` +
        `no longer matches postmaster.pid (${currentPid})`,
    );
  }
  if (!input.isExpectedProcess(currentPid)) {
    throw new Error(
      `Refusing to stop embedded PostgreSQL: pid ${currentPid} no longer matches ` +
        "the managed postmaster command",
    );
  }

  const signalProcess = input.signalProcess ?? process.kill.bind(process);
  try {
    signalProcess(input.adoptedPid, "SIGINT");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }

  const timeoutMs = input.timeoutMs ?? 30_000;
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (input.readRunningPid() !== null) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for adopted embedded PostgreSQL pid ${input.adoptedPid} to stop`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Some dependencies eagerly install process signal handlers as an import side
 * effect. Paperclip must remain the sole owner of SIGINT/SIGTERM ordering: its
 * handler first snapshots live heartbeat runs and only then stops embedded
 * infrastructure. Remove only listeners added by the supplied import, while
 * preserving every listener that was already registered.
 */
export async function loadWithoutCoordinatedShutdownSignalHooks<T>(
  load: () => Promise<T>,
  signalTarget: ShutdownSignalTarget = process,
) {
  const listenersBeforeLoad = new Map(
    COORDINATED_SHUTDOWN_SIGNALS.map((signal) => [
      signal,
      signalTarget.rawListeners(signal),
    ]),
  );

  let loaded: T;
  try {
    loaded = await load();
  } finally {
    for (const signal of COORDINATED_SHUTDOWN_SIGNALS) {
      const remainingBeforeLoad = [...(listenersBeforeLoad.get(signal) ?? [])];
      for (const listener of signalTarget.rawListeners(signal)) {
        const existingIndex = remainingBeforeLoad.indexOf(listener);
        if (existingIndex >= 0) {
          remainingBeforeLoad.splice(existingIndex, 1);
          continue;
        }
        signalTarget.removeListener(signal, listener as (...args: any[]) => void);
      }
    }
  }

  return loaded;
}

export async function coordinateHeartbeatSchedulerShutdown<
  TPreparation extends HotRestartShutdownPreparation,
>(input: {
  signal: "SIGINT" | "SIGTERM";
  prepareHotRestartShutdown: ((signal: "SIGINT" | "SIGTERM") => Promise<TPreparation>) | null;
  waitForHeartbeatSchedulerIdle: () => Promise<void>;
}): Promise<{
  hotRestart: TPreparation | null;
  preparationError: unknown;
  waitedForSchedulerIdle: boolean;
}> {
  let hotRestart: TPreparation | null = null;
  let preparationError: unknown = null;

  // The signal handler stops the scheduler before entering this coordinator.
  // Quiesce any callback that was already in flight before querying running
  // rows for the shutdown snapshot, otherwise a late queue claim can create a
  // run that is absent from both the snapshot and the selective drain set.
  await input.waitForHeartbeatSchedulerIdle();

  if (input.prepareHotRestartShutdown) {
    try {
      hotRestart = await input.prepareHotRestartShutdown(input.signal);
    } catch (err) {
      preparationError = err;
    }
  }

  return {
    hotRestart,
    preparationError,
    waitedForSchedulerIdle: true,
  };
}
