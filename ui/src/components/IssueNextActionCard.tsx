import {
  AlertTriangle,
  ArrowRight,
  CircleAlert,
  Compass,
  Eye,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticNode,
  IssueBlockerDiagnosticsResponse,
  IssueRecoveryAction,
  IssueScheduledRetry,
  IssueStatus,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import {
  deriveNextAction,
  type NextActionIssueRef,
  type NextActionKind,
  type NextActionSummary,
  type NextActionTone,
} from "../lib/next-action";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";

const TONE_STYLES: Record<
  NextActionTone,
  { container: string; icon: string; badge: string; refChip: string }
> = {
  amber: {
    container:
      "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100",
    icon: "text-amber-600 dark:text-amber-300",
    badge:
      "border-amber-400/70 bg-amber-100/80 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200",
    refChip:
      "border-amber-300/70 bg-background/80 text-amber-950 hover:border-amber-500 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-background/40 dark:text-amber-100 dark:hover:bg-amber-500/15",
  },
  sky: {
    container:
      "border-sky-300/70 bg-sky-50/90 text-sky-950 dark:border-sky-500/40 dark:bg-sky-500/10 dark:text-sky-100",
    icon: "text-sky-600 dark:text-sky-300",
    badge:
      "border-sky-400/70 bg-sky-100/80 text-sky-800 dark:border-sky-500/40 dark:bg-sky-500/15 dark:text-sky-200",
    refChip:
      "border-sky-300/70 bg-background/80 text-sky-950 hover:border-sky-500 hover:bg-sky-100 dark:border-sky-500/40 dark:bg-background/40 dark:text-sky-100 dark:hover:bg-sky-500/15",
  },
  red: {
    container:
      "border-red-300/70 bg-red-50/90 text-red-950 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-100",
    icon: "text-red-600 dark:text-red-300",
    badge:
      "border-red-400/70 bg-red-100/80 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200",
    refChip:
      "border-red-300/70 bg-background/80 text-red-950 hover:border-red-500 hover:bg-red-100 dark:border-red-500/40 dark:bg-background/40 dark:text-red-100 dark:hover:bg-red-500/15",
  },
  emerald: {
    container:
      "border-emerald-300/70 bg-emerald-50/90 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
    icon: "text-emerald-600 dark:text-emerald-300",
    badge:
      "border-emerald-400/70 bg-emerald-100/80 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-200",
    refChip:
      "border-emerald-300/70 bg-background/80 text-emerald-950 hover:border-emerald-500 hover:bg-emerald-100 dark:border-emerald-500/40 dark:bg-background/40 dark:text-emerald-100 dark:hover:bg-emerald-500/15",
  },
  muted: {
    container: "border-border bg-muted/60 text-foreground",
    icon: "text-muted-foreground",
    badge: "border-border bg-muted text-muted-foreground",
    refChip:
      "border-border bg-background/80 text-foreground hover:border-foreground/30 hover:bg-muted",
  },
};

const KIND_ICON: Record<NextActionKind, LucideIcon> = {
  recovery: AlertTriangle,
  scheduled_retry: RefreshCw,
  successful_run_handoff: Compass,
  blocked: AlertTriangle,
  terminal_gate: CircleAlert,
  none: Eye,
};

function RefChip({
  refItem,
  label,
  toneClass,
}: {
  refItem: NextActionIssueRef;
  label: string;
  toneClass: string;
}) {
  const issuePathId = refItem.identifier ?? refItem.id;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-(length:--text-nano) font-medium uppercase tracking-wide opacity-70">
        {label}
      </span>
      <IssueLinkQuicklook
        issuePathId={issuePathId}
        to={createIssueDetailPath(issuePathId)}
        className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs transition-colors hover:underline ${toneClass}`}
      >
        <span>{refItem.identifier ?? refItem.id.slice(0, 8)}</span>
        <span className="max-w-(--sz-18rem) truncate font-sans text-(length:--text-micro) opacity-80">
          {refItem.title}
        </span>
      </IssueLinkQuicklook>
    </span>
  );
}

function TerminalGateRow({
  gates,
  toneClass,
}: {
  gates: IssueBlockerDiagnosticNode[];
  toneClass: string;
}) {
  if (gates.length === 0) return null;
  return (
    <div
      data-testid="issue-next-action-terminal-gates"
      className="flex flex-wrap items-center gap-1.5 pt-0.5"
    >
      <span className="text-xs font-medium opacity-80">Terminal gate</span>
      {gates.map((gate) => {
        const issuePathId = gate.identifier ?? gate.id;
        const flag = gate.flags[0] ?? null;
        const flagLabel =
          flag === "workspace_finalize_pending"
            ? "finalize pending"
            : flag === "cancelled_blocker_in_set"
              ? "cancelled"
              : "done but blocking";
        return (
          <IssueLinkQuicklook
            key={gate.id}
            issuePathId={issuePathId}
            to={createIssueDetailPath(issuePathId)}
            className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs transition-colors hover:underline ${toneClass}`}
          >
            <span>{gate.identifier ?? gate.id.slice(0, 8)}</span>
            <span className="font-sans text-(length:--text-micro) opacity-80">{flagLabel}</span>
          </IssueLinkQuicklook>
        );
      })}
    </div>
  );
}

export interface IssueNextActionCardProps {
  status: IssueStatus;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  scheduledRetry?: IssueScheduledRetry | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  blockerDiagnostics?: IssueBlockerDiagnosticsResponse | null;
  /** Error from loading blocker diagnostics; surfaced so failures are visible. */
  diagnosticsError?: string | null;
  /** Render even when there is no special next action (kind "none"). */
  showWhenOnTrack?: boolean;
  className?: string;
}

/**
 * A consolidated, plain-language "what moves this forward next" card.
 *
 * PAP-13005 Phase 5 — reads the existing diagnostic/attention shape and renders
 * one readable next-action answer for issue detail, subtree, and run surfaces.
 */
export function IssueNextActionCard({
  status,
  blockedInboxAttention,
  activeRecoveryAction,
  scheduledRetry,
  successfulRunHandoff,
  blockerDiagnostics,
  diagnosticsError,
  showWhenOnTrack = false,
  className,
}: IssueNextActionCardProps) {
  const summary: NextActionSummary = deriveNextAction({
    status,
    blockedInboxAttention,
    activeRecoveryAction,
    scheduledRetry,
    successfulRunHandoff,
    blockerDiagnostics,
  });

  if (summary.kind === "none" && !showWhenOnTrack && !diagnosticsError) {
    return null;
  }

  const tone = TONE_STYLES[summary.tone];
  const Icon = KIND_ICON[summary.kind];

  return (
    <div
      data-testid="issue-next-action-card"
      data-next-action-kind={summary.kind}
      data-next-action-tone={summary.tone}
      className={`rounded-md border px-3 py-2.5 text-sm shadow-sm ${tone.container} ${className ?? ""}`}
    >
      <div className="flex items-start gap-2">
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone.icon}`} aria-hidden />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-(length:--text-nano) font-semibold uppercase tracking-wide opacity-70">
              Next action
            </span>
            <span
              className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-(length:--text-nano) font-medium ${tone.badge}`}
            >
              {summary.badge}
            </span>
          </div>

          <p className="font-medium leading-5">{summary.headline}</p>

          {summary.action ? (
            <p className="flex items-start gap-1.5 text-xs leading-5 opacity-90">
              <ArrowRight className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>
                <span className="font-medium">{summary.action.label}</span>
                {summary.action.detail ? <> — {summary.action.detail}</> : null}
              </span>
            </p>
          ) : null}

          {summary.owner ? (
            <p className="text-xs leading-5 opacity-80">
              Owner: <span className="font-medium">{summary.owner.label}</span>
            </p>
          ) : null}

          {summary.scheduledRetry?.status === "running" ? (
            <p className="flex items-center gap-1.5 text-xs leading-5 opacity-80">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
              Corrective run in progress
            </p>
          ) : null}

          {(summary.sourceRef || summary.leafRef || summary.recoveryRef) ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5">
              {summary.sourceRef ? (
                <RefChip refItem={summary.sourceRef} label="Work happens on" toneClass={tone.refChip} />
              ) : null}
              {summary.leafRef ? (
                <RefChip refItem={summary.leafRef} label="Waiting on" toneClass={tone.refChip} />
              ) : null}
              {summary.recoveryRef ? (
                <RefChip refItem={summary.recoveryRef} label="Recovery" toneClass={tone.refChip} />
              ) : null}
            </div>
          ) : null}

          <TerminalGateRow gates={summary.terminalGates} toneClass={tone.refChip} />

          {diagnosticsError ? (
            <p
              data-testid="issue-next-action-diagnostics-error"
              className="mt-1 rounded-md border border-red-300/70 bg-red-50/80 px-2 py-1 text-xs leading-5 text-red-800 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200"
            >
              Couldn&apos;t load full blocker diagnostics: {diagnosticsError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
