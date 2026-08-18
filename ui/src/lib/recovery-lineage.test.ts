import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatRecoveryAttemptLabel,
  formatRecoveryLineageSummary,
  formatRecoveryRetryOffset,
  readRecoveryRetryLineage,
  type RecoveryLineageInput,
} from "./recovery-lineage";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function at(offsetMs: number) {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function sourceLaneAction(overrides: Partial<RecoveryLineageInput> = {}): RecoveryLineageInput {
  return {
    wakePolicy: {
      type: "bounded_owner_disposition_repair",
      retryAgentId: "agent-owner",
      attempt: 2,
      maxAttempts: 5,
      baseBackoffMs: 60_000,
      jitterMs: 3_000,
      retryAt: at(3 * 60_000),
      scheduledRunId: "run-2",
    },
    evidence: {},
    attemptCount: 2,
    maxAttempts: 5,
    timeoutAt: at(3 * 60_000),
    ...overrides,
  };
}

function recoveryLaneAction(overrides: Partial<RecoveryLineageInput> = {}): RecoveryLineageInput {
  return {
    wakePolicy: {
      type: "bounded_recovery_owner",
      ownerAgentId: "agent-manager",
      attempt: 1,
      maxAttempts: 3,
      retryAt: at(60_000),
      scheduledRunId: "run-9",
      preservesSourceAssignee: true,
    },
    evidence: { sourceAttemptCount: 5, sourceMaxAttempts: 5 },
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: at(60_000),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("readRecoveryRetryLineage", () => {
  it("returns null when the action carries no bounded lineage", () => {
    expect(readRecoveryRetryLineage({ wakePolicy: null })).toBeNull();
    expect(readRecoveryRetryLineage({ wakePolicy: { type: "wake_owner" } })).toBeNull();
    expect(readRecoveryRetryLineage({ wakePolicy: { type: "monitor" } })).toBeNull();
  });

  it("reads the source-owner lane with its stored attempt and due time", () => {
    const lineage = readRecoveryRetryLineage(sourceLaneAction());
    expect(lineage).not.toBeNull();
    expect(lineage!.lane).toBe("source_owner");
    expect(lineage!.attempt).toBe(2);
    expect(lineage!.maxAttempts).toBe(5);
    expect(lineage!.attemptsRemaining).toBe(3);
    expect(lineage!.exhausted).toBe(false);
    expect(lineage!.nextRetryAt).toBe(at(3 * 60_000));
    expect(lineage!.retryAgentId).toBe("agent-owner");
    expect(lineage!.hasDurablePath).toBe(true);
    // The source lane is the original owner retrying itself, so it reports itself as
    // preserving the deliverable even without an explicit policy flag.
    expect(lineage!.preservesSourceAssignee).toBe(true);
    expect(lineage!.sourceAttempt).toBe(2);
    expect(lineage!.sourceMaxAttempts).toBe(5);
  });

  it("marks a source lane with no attempts left as exhausted and drops its stale due time", () => {
    const lineage = readRecoveryRetryLineage(
      sourceLaneAction({
        wakePolicy: {
          type: "bounded_owner_disposition_repair",
          attempt: 5,
          maxAttempts: 5,
          retryAt: at(-60_000),
        },
      }),
    );
    expect(lineage!.exhausted).toBe(true);
    expect(lineage!.attemptsRemaining).toBe(0);
    expect(lineage!.nextRetryAt).toBeNull();
    expect(lineage!.hasDurablePath).toBe(false);
  });

  it("reads the manager lane and keeps the source lane's spent attempts from evidence", () => {
    const lineage = readRecoveryRetryLineage(recoveryLaneAction());
    expect(lineage!.lane).toBe("recovery_owner");
    expect(lineage!.attempt).toBe(1);
    expect(lineage!.maxAttempts).toBe(3);
    expect(lineage!.retryAgentId).toBe("agent-manager");
    expect(lineage!.preservesSourceAssignee).toBe(true);
    expect(lineage!.sourceAttempt).toBe(5);
    expect(lineage!.sourceMaxAttempts).toBe(5);
    expect(lineage!.hasDurablePath).toBe(true);
  });

  it("treats a board escalation from this contract as an exhausted lane", () => {
    const lineage = readRecoveryRetryLineage({
      wakePolicy: {
        type: "board_escalation",
        reason: "recovery_owner_retry_exhausted",
        attempt: 3,
        maxAttempts: 3,
        preservesSourceAssignee: true,
      },
      evidence: { sourceAttemptCount: 5, sourceMaxAttempts: 5 },
    });
    expect(lineage!.lane).toBe("board");
    expect(lineage!.exhausted).toBe(true);
    expect(lineage!.nextRetryAt).toBeNull();
    expect(lineage!.hasDurablePath).toBe(false);
    expect(lineage!.sourceMaxAttempts).toBe(5);
  });

  it("ignores an unrelated board escalation that is not part of the owner-sticky contract", () => {
    expect(
      readRecoveryRetryLineage({
        wakePolicy: { type: "board_escalation", reason: "provider_quota" },
        evidence: {},
      }),
    ).toBeNull();
  });

  it("falls back to the action's own attempt fields when the policy omits them", () => {
    const lineage = readRecoveryRetryLineage({
      wakePolicy: { type: "bounded_owner_disposition_repair" },
      attemptCount: 3,
      maxAttempts: 5,
      timeoutAt: at(120_000),
    });
    expect(lineage!.attempt).toBe(3);
    expect(lineage!.maxAttempts).toBe(5);
    expect(lineage!.nextRetryAt).toBe(at(120_000));
  });

  it("reports no durable path when nothing is scheduled yet", () => {
    const lineage = readRecoveryRetryLineage({
      wakePolicy: {
        type: "bounded_owner_disposition_repair",
        retryAgentId: "agent-owner",
        attempt: 1,
        maxAttempts: 5,
      },
    });
    expect(lineage!.exhausted).toBe(false);
    expect(lineage!.hasDurablePath).toBe(false);
  });

  it("ignores an unparseable stored due time", () => {
    const lineage = readRecoveryRetryLineage({
      wakePolicy: {
        type: "bounded_owner_disposition_repair",
        attempt: 1,
        maxAttempts: 5,
        retryAt: "not-a-date",
      },
    });
    expect(lineage!.nextRetryAt).toBeNull();
  });
});

describe("recovery lineage formatting", () => {
  it("formats the attempt budget", () => {
    expect(formatRecoveryAttemptLabel(readRecoveryRetryLineage(sourceLaneAction())!)).toBe(
      "Attempt 2 of 5",
    );
  });

  it("clamps a spent attempt count to the budget", () => {
    const lineage = readRecoveryRetryLineage(
      sourceLaneAction({
        wakePolicy: { type: "bounded_owner_disposition_repair", attempt: 6, maxAttempts: 5 },
      }),
    )!;
    expect(formatRecoveryAttemptLabel(lineage)).toBe("Attempt 5 of 5");
  });

  it("formats the next due time relative to now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lineage = readRecoveryRetryLineage(sourceLaneAction())!;
    expect(formatRecoveryRetryOffset(lineage)).toBe("in 3m");
    expect(formatRecoveryLineageSummary(lineage)).toBe("Attempt 2 of 5 · next try in 3m");
  });

  it("says retries are used up when a lane is exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const lineage = readRecoveryRetryLineage({
      wakePolicy: {
        type: "board_escalation",
        reason: "recovery_owner_retry_exhausted",
        attempt: 3,
        maxAttempts: 3,
        preservesSourceAssignee: true,
      },
    })!;
    expect(formatRecoveryRetryOffset(lineage)).toBeNull();
    expect(formatRecoveryLineageSummary(lineage)).toBe("Attempt 3 of 3 · retries used up");
  });
});
