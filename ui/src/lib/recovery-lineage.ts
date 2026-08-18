import type { IssueRecoveryAction } from "@paperclipai/shared";
import { formatMonitorOffset } from "./issue-monitor";

/**
 * Which bounded retry budget the server is currently spending on a recovery action.
 *
 * The owner-sticky contract keeps one recovery-action row per source issue and rewrites
 * its `wakePolicy` as the action moves between budgets: the original owner's repair
 * attempts, then a manager's path-repair attempts, then the board. The policy type is
 * therefore the canonical lane signal — every surface reads the same stored value rather
 * than re-deriving liveness on its own.
 */
export type RecoveryRetryLane = "source_owner" | "recovery_owner" | "board";

export interface RecoveryRetryLineage {
  lane: RecoveryRetryLane;
  /** Attempts already spent in the current lane. 0 before the first attempt is scheduled. */
  attempt: number;
  maxAttempts: number | null;
  attemptsRemaining: number | null;
  /** The lane has no attempts left (always true once the board owns the action). */
  exhausted: boolean;
  /** When the stored next attempt is due, as an ISO string. Null once a lane is exhausted. */
  nextRetryAt: string | null;
  /** The run the server parked for the next attempt, when it recorded one. */
  scheduledRunId: string | null;
  /** The agent the stored attempt will wake. */
  retryAgentId: string | null;
  /** The server recorded that this lane does not move the source deliverable. */
  preservesSourceAssignee: boolean;
  /** Attempts the original owner spent before the manager lane opened. */
  sourceAttempt: number | null;
  sourceMaxAttempts: number | null;
  /**
   * A stored retry the server will run without anyone intervening. This — not the mere
   * existence of an open recovery action — is what keeps a surface quiet.
   */
  hasDurablePath: boolean;
}

const SOURCE_LANE_POLICY = "bounded_owner_disposition_repair";
const RECOVERY_LANE_POLICY = "bounded_recovery_owner";
const BOARD_LANE_POLICY = "board_escalation";

export type RecoveryLineageInput = Pick<IssueRecoveryAction, "wakePolicy"> &
  Partial<Pick<IssueRecoveryAction, "evidence" | "attemptCount" | "maxAttempts" | "timeoutAt">>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 0 ? floored : null;
}

function asIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Read the bounded retry lineage the server stored on a recovery action, or null when the
 * action does not carry one (older kinds, or a board escalation that is not part of the
 * owner-sticky contract).
 */
export function readRecoveryRetryLineage(
  action: RecoveryLineageInput,
): RecoveryRetryLineage | null {
  const policy = asRecord(action.wakePolicy);
  if (!policy) return null;
  const type = asNonEmptyString(policy.type);
  const preservesSourceAssignee = policy.preservesSourceAssignee === true;
  const evidence = asRecord(action.evidence) ?? {};
  const evidenceSourceAttempt = asCount(evidence.sourceAttemptCount);
  const evidenceSourceMaxAttempts = asCount(evidence.sourceMaxAttempts);

  let lane: RecoveryRetryLane;
  if (type === SOURCE_LANE_POLICY) lane = "source_owner";
  else if (type === RECOVERY_LANE_POLICY) lane = "recovery_owner";
  else if (
    type === BOARD_LANE_POLICY &&
    (preservesSourceAssignee || evidenceSourceMaxAttempts !== null)
  ) {
    lane = "board";
  } else return null;

  const attempt = asCount(policy.attempt) ?? asCount(action.attemptCount) ?? 0;
  const maxAttempts = asCount(policy.maxAttempts) ?? asCount(action.maxAttempts);
  const scheduledRunId = asNonEmptyString(policy.scheduledRunId);
  const storedRetryAt = asIsoDate(policy.retryAt) ?? asIsoDate(action.timeoutAt);
  const exhausted = lane === "board" || (maxAttempts !== null && attempt >= maxAttempts);
  const nextRetryAt = exhausted ? null : storedRetryAt;

  return {
    lane,
    attempt,
    maxAttempts,
    attemptsRemaining: maxAttempts === null ? null : Math.max(0, maxAttempts - attempt),
    exhausted,
    nextRetryAt,
    scheduledRunId,
    retryAgentId: asNonEmptyString(policy.retryAgentId) ?? asNonEmptyString(policy.ownerAgentId),
    preservesSourceAssignee: preservesSourceAssignee || lane === "source_owner",
    sourceAttempt: lane === "source_owner" ? attempt : evidenceSourceAttempt,
    sourceMaxAttempts: lane === "source_owner" ? maxAttempts : evidenceSourceMaxAttempts,
    hasDurablePath: !exhausted && (nextRetryAt !== null || scheduledRunId !== null),
  };
}

/** "Attempt 2 of 5", or null when the server did not record a bounded budget. */
export function formatRecoveryAttemptLabel(lineage: RecoveryRetryLineage): string | null {
  if (lineage.maxAttempts === null) return null;
  return `Attempt ${Math.min(lineage.attempt, lineage.maxAttempts)} of ${lineage.maxAttempts}`;
}

/** "in 3m" / "now" / "3m ago" for the stored next attempt, or null when none is stored. */
export function formatRecoveryRetryOffset(lineage: RecoveryRetryLineage): string | null {
  if (!lineage.nextRetryAt) return null;
  try {
    return formatMonitorOffset(lineage.nextRetryAt);
  } catch {
    return null;
  }
}

/**
 * One compact sentence fragment shared by the card and the blocker chips so every surface
 * reports the same attempt count and due time.
 */
export function formatRecoveryLineageSummary(lineage: RecoveryRetryLineage): string | null {
  const parts: string[] = [];
  const attempt = formatRecoveryAttemptLabel(lineage);
  if (attempt) parts.push(attempt);
  const offset = formatRecoveryRetryOffset(lineage);
  if (offset) parts.push(offset === "now" ? "next try now" : `next try ${offset}`);
  else if (lineage.exhausted) parts.push("retries used up");
  return parts.length > 0 ? parts.join(" · ") : null;
}
