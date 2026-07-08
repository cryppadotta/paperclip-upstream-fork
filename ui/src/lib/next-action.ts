import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticNode,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueRelationIssueSummary,
  IssueScheduledRetry,
  IssueStatus,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { deriveActiveRecoveryDisplayState, recoveryChipLabel } from "./recovery-display";
import { blockedReasonLabel } from "./blockedInbox";

/**
 * A single, readable answer to: "what moves this task forward next?"
 *
 * PAP-13005 product rule: every agent-owned non-terminal task, and every task
 * that blocks another, must expose one machine-readable and human-readable
 * next-action truth. This module collapses the various server signals
 * (blocked-inbox attention, active recovery action, scheduled retry,
 * successful-run handoff, and blocker diagnostics) into that single answer so
 * the UI never shows churn without telling the board what happens next.
 */
export type NextActionKind =
  | "recovery"
  | "scheduled_retry"
  | "successful_run_handoff"
  | "blocked"
  | "terminal_gate"
  | "none";

export type NextActionTone = "amber" | "sky" | "red" | "emerald" | "muted";

export interface NextActionIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

export interface NextActionOwner {
  label: string;
  kind: "agent" | "user" | "board" | "external" | "system" | "unknown";
}

export interface NextActionSummary {
  kind: NextActionKind;
  tone: NextActionTone;
  /** Short chip label, e.g. "Recovery needed", "Blocked", "Terminal gate". */
  badge: string;
  /** Plain-language sentence: what moves this forward next. */
  headline: string;
  /** The concrete action the owner should take, if any. */
  action: { label: string; detail: string | null } | null;
  owner: NextActionOwner | null;
  /** The task where the work actually happens next. */
  sourceRef: NextActionIssueRef | null;
  /** The leaf blocker that is ultimately holding the tree. */
  leafRef: NextActionIssueRef | null;
  /** An open recovery task tracking the fix, if any. */
  recoveryRef: NextActionIssueRef | null;
  /** Terminal-gate blockers (done/cancelled but still blocking, or finalize-pending). */
  terminalGates: IssueBlockerDiagnosticNode[];
  recovery: IssueRecoveryAction | null;
  scheduledRetry: IssueScheduledRetry | null;
}

export interface NextActionInput {
  status: IssueStatus;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  scheduledRetry?: IssueScheduledRetry | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  /** Optional richer blocker view from GET /issues/:id/diagnostics/blockers. */
  blockerDiagnostics?: IssueBlockerDiagnosticsResponse | null;
}

function toRef(
  ref:
    | IssueRelationIssueSummary
    | { id: string; identifier: string | null; title: string; status: IssueStatus }
    | null
    | undefined,
): NextActionIssueRef | null {
  if (!ref) return null;
  return {
    id: ref.id,
    identifier: ref.identifier ?? null,
    title: ref.title,
    status: ref.status,
  };
}

function ownerFromInbox(
  owner: IssueBlockedInboxAttention["owner"],
): NextActionOwner | null {
  if (!owner) return null;
  const label = owner.label
    ?? (owner.type === "board"
      ? "Board"
      : owner.type === "external"
        ? "External owner"
        : null);
  if (!label) return null;
  return { label, kind: owner.type };
}

const ACTIVE_RETRY_STATUSES = new Set<IssueScheduledRetry["status"]>([
  "scheduled_retry",
  "queued",
  "running",
]);

/** Terminal-gate flags: a done/cancelled or finalize-pending blocker still holding dependents. */
function terminalGateBlockers(
  diagnostics: IssueBlockerDiagnosticsResponse | null | undefined,
): IssueBlockerDiagnosticNode[] {
  if (!diagnostics) return [];
  return diagnostics.blockers.filter((blocker) =>
    blocker.flags.some(
      (flag) =>
        flag === "done_but_blocking"
        || flag === "workspace_finalize_pending"
        || flag === "cancelled_blocker_in_set",
    ),
  );
}

const NO_NEXT_ACTION: NextActionSummary = {
  kind: "none",
  tone: "muted",
  badge: "On track",
  headline: "This task has a live next step.",
  action: null,
  owner: null,
  sourceRef: null,
  leafRef: null,
  recoveryRef: null,
  terminalGates: [],
  recovery: null,
  scheduledRetry: null,
};

function retryScheduleLabel(retry: IssueScheduledRetry): string {
  if (retry.status === "running") return "A corrective run is in progress.";
  if (retry.status === "queued") return "A corrective run is queued.";
  return "A corrective wake is scheduled.";
}

/**
 * Collapse all available next-action signals into a single readable summary.
 * Priority reflects specificity: an explicit recovery action or scheduled
 * corrective run is the most concrete answer, followed by the server's
 * consolidated blocked-inbox attention, then terminal-gate diagnostics.
 */
export function deriveNextAction(input: NextActionInput): NextActionSummary {
  const {
    status,
    blockedInboxAttention,
    activeRecoveryAction,
    scheduledRetry,
    successfulRunHandoff,
    blockerDiagnostics,
  } = input;

  if (status === "done" || status === "cancelled") {
    return NO_NEXT_ACTION;
  }

  const gates = terminalGateBlockers(blockerDiagnostics);

  // 1. An active recovery action is the most concrete next-action truth.
  const recoveryState = activeRecoveryAction
    ? deriveActiveRecoveryDisplayState(activeRecoveryAction)
    : null;
  if (activeRecoveryAction && recoveryState) {
    const tone: NextActionTone =
      recoveryState === "escalated"
        ? "red"
        : recoveryState === "in_progress"
          ? "sky"
          : recoveryState === "observe_only"
            ? "muted"
            : "amber";
    return {
      kind: "recovery",
      tone,
      badge: recoveryChipLabel(recoveryState, activeRecoveryAction.kind),
      // The recovery action's own next-step sentence is the headline; the
      // dedicated recovery card below it carries the resolve/reissue controls,
      // so we intentionally avoid repeating it as a separate action row.
      headline: activeRecoveryAction.nextAction
        || "A recovery action owns the next step for this task.",
      action: null,
      owner: activeRecoveryAction.ownerAgentId
        ? { label: "Assigned agent", kind: "agent" }
        : activeRecoveryAction.ownerType === "board"
          ? { label: "Board", kind: "board" }
          : activeRecoveryAction.ownerType === "user"
            ? { label: "User", kind: "user" }
            : { label: "System", kind: "system" },
      sourceRef: null,
      leafRef: null,
      recoveryRef: null,
      terminalGates: gates,
      recovery: activeRecoveryAction,
      scheduledRetry: scheduledRetry ?? null,
    };
  }

  // 2. A scheduled/queued corrective run is a live wake path.
  if (scheduledRetry && ACTIVE_RETRY_STATUSES.has(scheduledRetry.status)) {
    return {
      kind: "scheduled_retry",
      tone: "sky",
      badge: "Corrective run",
      headline: retryScheduleLabel(scheduledRetry),
      action: scheduledRetry.scheduledRetryReason
        ? { label: "Retry now", detail: scheduledRetry.scheduledRetryReason }
        : { label: "Retry now", detail: null },
      owner: scheduledRetry.agentName
        ? { label: scheduledRetry.agentName, kind: "agent" }
        : { label: "Assigned agent", kind: "agent" },
      sourceRef: null,
      leafRef: null,
      recoveryRef: null,
      terminalGates: gates,
      recovery: null,
      scheduledRetry,
    };
  }

  // 3. A finished run left the task open with no owner for the next action.
  if (successfulRunHandoff?.required) {
    return {
      kind: "successful_run_handoff",
      tone: "amber",
      badge: "Needs disposition",
      headline:
        "A run finished successfully but this task is still open with no next step chosen.",
      action: {
        label: "Choose a disposition",
        detail: "Mark done, send for review, delegate follow-up, or mark blocked with an owner.",
      },
      owner: successfulRunHandoff.assigneeAgentId
        ? { label: "Assigned agent", kind: "agent" }
        : null,
      sourceRef: null,
      leafRef: null,
      recoveryRef: null,
      terminalGates: gates,
      recovery: null,
      scheduledRetry: scheduledRetry ?? null,
    };
  }

  // 4. The server's consolidated blocked-inbox attention answer.
  if (blockedInboxAttention) {
    const attn = blockedInboxAttention;
    const isTerminalGate =
      attn.reason === "blocked_by_cancelled_issue" || gates.length > 0;
    const tone: NextActionTone =
      attn.severity === "critical"
        ? "red"
        : attn.severity === "high"
          ? "amber"
          : attn.state === "external_wait" || attn.state === "awaiting_decision"
            ? "sky"
            : "amber";
    return {
      kind: isTerminalGate ? "terminal_gate" : "blocked",
      tone,
      badge: blockedReasonLabel(attn.reason),
      headline: buildBlockedHeadline(attn, gates),
      action: attn.action
        ? { label: attn.action.label, detail: attn.action.detail }
        : null,
      owner: ownerFromInbox(attn.owner),
      sourceRef: toRef(attn.sourceIssue),
      leafRef: toRef(attn.leafIssue),
      recoveryRef: toRef(attn.recoveryIssue),
      terminalGates: gates,
      recovery: null,
      scheduledRetry: scheduledRetry ?? null,
    };
  }

  // 5. Blocker diagnostics alone can still reveal a terminal gate.
  if (gates.length > 0) {
    return {
      kind: "terminal_gate",
      tone: "amber",
      badge: "Terminal gate",
      headline: buildTerminalGateHeadline(gates),
      action: {
        label: "Resolve the terminal gate",
        detail: "Clear the finalize/cancelled blocker or remove it from the blocker set.",
      },
      owner: null,
      sourceRef: null,
      leafRef: toRef(gates[0]),
      recoveryRef: null,
      terminalGates: gates,
      recovery: null,
      scheduledRetry: scheduledRetry ?? null,
    };
  }

  return NO_NEXT_ACTION;
}

function buildBlockedHeadline(
  attn: IssueBlockedInboxAttention,
  gates: IssueBlockerDiagnosticNode[],
): string {
  if (gates.length > 0) {
    return buildTerminalGateHeadline(gates);
  }
  const leaf = attn.leafIssue?.identifier ?? attn.leafIssue?.title;
  const ownerLabel = attn.owner?.label ?? null;
  switch (attn.state) {
    case "awaiting_decision":
      return ownerLabel
        ? `Waiting on ${ownerLabel} to decide.`
        : "Waiting on a decision to move forward.";
    case "external_wait":
      return ownerLabel
        ? `Waiting on ${ownerLabel} outside Paperclip.`
        : "Waiting on an external owner.";
    case "recovery_open":
      return "A recovery task is tracking the fix that moves this forward.";
    case "missing_disposition":
      return "This task needs a disposition to move forward.";
    case "needs_attention":
    default:
      return leaf
        ? `Ultimately waiting on ${leaf}; it has no live next step yet.`
        : "This blocked chain has no live next step yet.";
  }
}

function buildTerminalGateHeadline(gates: IssueBlockerDiagnosticNode[]): string {
  const first = gates[0];
  const id = first?.identifier ?? first?.title ?? "a blocker";
  if (first?.flags.includes("workspace_finalize_pending")) {
    return `${id} is done but its workspace finalize gate still blocks this task.`;
  }
  if (first?.flags.includes("cancelled_blocker_in_set")) {
    return `${id} is cancelled but still listed as a blocker; it will never resolve on its own.`;
  }
  return `${id} is done but still blocking this task; its post-run gate needs recovery.`;
}
