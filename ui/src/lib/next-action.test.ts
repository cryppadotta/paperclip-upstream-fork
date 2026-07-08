import { describe, expect, it } from "vitest";
import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import { deriveNextAction } from "./next-action";

function inboxAttention(
  overrides: Partial<IssueBlockedInboxAttention> = {},
): IssueBlockedInboxAttention {
  return {
    kind: "blocked",
    state: "needs_attention",
    reason: "blocked_chain_stalled",
    severity: "medium",
    stoppedSinceAt: null,
    owner: { type: "agent", agentId: "a1", userId: null, label: "ClaudeCoder" },
    action: { label: "resolve the stalled chain", detail: "Wake QA or remove the blocker." },
    sourceIssue: null,
    leafIssue: {
      id: "leaf-1",
      identifier: "PAP-12921",
      title: "QA release verification",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: "qa-1",
      assigneeUserId: null,
    },
    recoveryIssue: null,
    approvalId: null,
    interactionId: null,
    sampleIssueIdentifier: null,
    redaction: { externalDetailsRedacted: false, secretFieldsOmitted: true },
    ...overrides,
  };
}

function recoveryAction(overrides: Partial<IssueRecoveryAction> = {}): IssueRecoveryAction {
  return {
    id: "rec-1",
    companyId: "c1",
    sourceIssueId: "i1",
    recoveryIssueId: "rec-issue-1",
    kind: "workspace_validation",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "a1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "workspace_divergence",
    fingerprint: "fp",
    evidence: {},
    nextAction: "Reissue the task in a clean isolated workspace.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: 3,
    timeoutAt: null,
    lastAttemptAt: null,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
    ...overrides,
  };
}

const scheduledRetry: IssueScheduledRetry = {
  runId: "run-1",
  status: "scheduled_retry",
  agentId: "a1",
  agentName: "ClaudeCoder",
  retryOfRunId: "run-0",
  scheduledRetryAt: "2026-07-08T00:10:00.000Z",
  scheduledRetryAttempt: 2,
  scheduledRetryReason: "transient_failure",
  retryExhaustedReason: null,
  error: null,
  errorCode: null,
};

function blockerDiagnostics(
  flags: IssueBlockerDiagnosticsResponse["blockers"][number]["flags"],
): IssueBlockerDiagnosticsResponse {
  return {
    issue: {
      id: "i1",
      identifier: "PAP-12915",
      title: "Release verify parallel",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: null,
      assigneeUserId: null,
    },
    diagnosis: "Blocked by a done task that still gates dependents.",
    readiness: {
      allBlockersDone: true,
      isDependencyReady: false,
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerCount: 1,
    },
    blockers: [
      {
        id: "b1",
        identifier: "PAP-12920",
        title: "Release verify child",
        status: "done",
        priority: "medium",
        assigneeAgentId: null,
        assigneeUserId: null,
        isUnresolved: false,
        isDependencyReady: false,
        isPendingFinalize: true,
        flags,
      },
    ],
    omittedUnauthorizedBlockerCount: 0,
    truncated: false,
    caps: { maxBlockers: 50 },
  };
}

describe("deriveNextAction", () => {
  it("returns none for terminal tasks", () => {
    const result = deriveNextAction({
      status: "done",
      blockedInboxAttention: inboxAttention(),
      activeRecoveryAction: recoveryAction(),
    });
    expect(result.lane).toBe("none");
  });

  it("puts a live run in Working now ahead of everything", () => {
    const result = deriveNextAction({
      status: "in_progress",
      hasLiveRun: true,
      activeRecoveryAction: recoveryAction(),
    });
    expect(result.lane).toBe("working_now");
    expect(result.live).toBe(true);
    expect(result.resolvedFrom).toBe("live_run");
  });

  it("treats a scheduled corrective wake as Working now (queued)", () => {
    const result = deriveNextAction({ status: "in_progress", scheduledRetry });
    expect(result.lane).toBe("working_now");
    expect(result.statement).toContain("Queued to wake");
    expect(result.resolvedFrom).toContain("scheduled_retry");
  });

  it("routes an active recovery action to the Recovery lane with attempt count", () => {
    const result = deriveNextAction({
      status: "in_progress",
      activeRecoveryAction: recoveryAction(),
      blockedInboxAttention: inboxAttention(),
    });
    expect(result.lane).toBe("recovery");
    expect(result.statement).toContain("clean isolated workspace");
    expect(result.why).toContain("attempt 1/3");
    expect(result.primaryControl?.kind).toBe("open_recovery");
  });

  it("flags escalated recovery as recovery debt", () => {
    const result = deriveNextAction({
      status: "blocked",
      activeRecoveryAction: recoveryAction({ status: "escalated" }),
    });
    expect(result.lane).toBe("recovery");
    expect(result.recoveryDebt).toBe(true);
    expect(result.laneLabel).toBe("Recovery debt");
    expect(result.primaryControl?.kind).toBe("assign_worker");
  });

  it("routes a board owner to Waiting on a decision", () => {
    const result = deriveNextAction({
      status: "in_review",
      blockedInboxAttention: inboxAttention({
        state: "awaiting_decision",
        reason: "pending_board_decision",
        owner: { type: "board", agentId: null, userId: null, label: "Board" },
        action: { label: "accept or reject the plan", detail: null },
        leafIssue: null,
      }),
    });
    expect(result.lane).toBe("waiting_decision");
    expect(result.owner?.label).toBe("Board");
    expect(result.statement).toContain("Waiting for Board");
  });

  it("routes a needs-attention blocker chain to Blocked by real work", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockedInboxAttention: inboxAttention(),
    });
    expect(result.lane).toBe("blocked_real_work");
    expect(result.terminalGate).toBe(false);
    expect(result.references.some((r) => r.ref.identifier === "PAP-12921")).toBe(true);
  });

  it("marks a workspace-finalize gate as a terminal-gate blocked variant", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockedInboxAttention: inboxAttention(),
      blockerDiagnostics: blockerDiagnostics(["workspace_finalize_pending"]),
    });
    expect(result.lane).toBe("blocked_real_work");
    expect(result.terminalGate).toBe(true);
    expect(result.statement).toContain("Done");
    expect(
      result.references.some((r) => r.gate === "gate: workspace_finalize_pending"),
    ).toBe(true);
  });

  it("reveals a terminal gate from blocker diagnostics alone", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockerDiagnostics: blockerDiagnostics(["done_but_blocking"]),
    });
    expect(result.lane).toBe("blocked_real_work");
    expect(result.terminalGate).toBe(true);
    expect(result.terminalGates).toHaveLength(1);
  });

  it("returns none when nothing needs attention", () => {
    const result = deriveNextAction({ status: "in_progress" });
    expect(result.lane).toBe("none");
  });
});
