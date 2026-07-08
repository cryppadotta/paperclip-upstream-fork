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
    action: { label: "Resolve the stalled chain", detail: "Wake QA or remove the blocker." },
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
    expect(result.kind).toBe("none");
  });

  it("prioritizes an active recovery action over blocked attention", () => {
    const result = deriveNextAction({
      status: "in_progress",
      activeRecoveryAction: recoveryAction(),
      blockedInboxAttention: inboxAttention(),
    });
    expect(result.kind).toBe("recovery");
    expect(result.headline).toContain("clean isolated workspace");
    expect(result.recovery?.id).toBe("rec-1");
  });

  it("uses the scheduled corrective run when no recovery action is present", () => {
    const result = deriveNextAction({
      status: "in_progress",
      scheduledRetry,
    });
    expect(result.kind).toBe("scheduled_retry");
    expect(result.tone).toBe("sky");
    expect(result.action?.label).toBe("Retry now");
  });

  it("surfaces the successful-run handoff before generic blocked attention", () => {
    const result = deriveNextAction({
      status: "in_progress",
      successfulRunHandoff: {
        state: "required",
        required: true,
        sourceRunId: "run-x",
        correctiveRunId: null,
        assigneeAgentId: "a1",
        detectedProgressSummary: null,
        createdAt: null,
      },
    });
    expect(result.kind).toBe("successful_run_handoff");
    expect(result.action?.label).toBe("Choose a disposition");
  });

  it("collapses blocked-inbox attention into a readable answer with the leaf blocker", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockedInboxAttention: inboxAttention(),
    });
    expect(result.kind).toBe("blocked");
    expect(result.owner?.label).toBe("ClaudeCoder");
    expect(result.leafRef?.identifier).toBe("PAP-12921");
    expect(result.action?.label).toBe("Resolve the stalled chain");
  });

  it("flags a done-but-blocking terminal gate from blocker diagnostics", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockerDiagnostics: blockerDiagnostics(["done_but_blocking"]),
    });
    expect(result.kind).toBe("terminal_gate");
    expect(result.terminalGates).toHaveLength(1);
    expect(result.headline).toContain("done but still blocking");
  });

  it("explains a workspace-finalize-pending gate in plain language", () => {
    const result = deriveNextAction({
      status: "blocked",
      blockedInboxAttention: inboxAttention({ reason: "blocked_chain_stalled" }),
      blockerDiagnostics: blockerDiagnostics(["workspace_finalize_pending"]),
    });
    expect(result.kind).toBe("terminal_gate");
    expect(result.headline).toContain("workspace finalize gate");
  });

  it("returns none when nothing needs attention", () => {
    const result = deriveNextAction({ status: "in_progress" });
    expect(result.kind).toBe("none");
  });
});
