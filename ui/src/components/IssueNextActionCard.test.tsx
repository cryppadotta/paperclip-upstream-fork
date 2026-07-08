// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IssueBlockedInboxAttention,
  IssueBlockerDiagnosticsResponse,
} from "@paperclipai/shared";
import { IssueNextActionCard } from "./IssueNextActionCard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

vi.mock("./IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({
    children,
    to,
    ...props
  }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

function render(node: ReactNode) {
  flushSync(() => {
    root.render(node);
  });
}

const attention: IssueBlockedInboxAttention = {
  kind: "blocked",
  state: "needs_attention",
  reason: "blocked_chain_stalled",
  severity: "high",
  stoppedSinceAt: null,
  owner: { type: "agent", agentId: "a1", userId: null, label: "ClaudeCoder" },
  action: { label: "Resolve the stalled review", detail: "Wake QA on PAP-12921." },
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
};

const gateDiagnostics: IssueBlockerDiagnosticsResponse = {
  issue: {
    id: "i1",
    identifier: "PAP-12915",
    title: "Release verify parallel",
    status: "blocked",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
  },
  diagnosis: null,
  readiness: null,
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
      flags: ["workspace_finalize_pending"],
    },
  ],
  omittedUnauthorizedBlockerCount: 0,
  truncated: false,
  caps: { maxBlockers: 50 },
};

describe("IssueNextActionCard", () => {
  it("renders nothing for an on-track task by default", () => {
    render(<IssueNextActionCard status="in_progress" />);
    expect(container.querySelector('[data-testid="issue-next-action-card"]')).toBeNull();
  });

  it("renders a blocked next-action answer with owner and leaf blocker", () => {
    render(<IssueNextActionCard status="blocked" blockedInboxAttention={attention} />);
    const card = container.querySelector('[data-testid="issue-next-action-card"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute("data-next-action-kind")).toBe("blocked");
    expect(container.textContent).toContain("Resolve the stalled review");
    expect(container.textContent).toContain("ClaudeCoder");
    expect(container.textContent).toContain("PAP-12921");
  });

  it("renders a terminal-gate answer from blocker diagnostics", () => {
    render(
      <IssueNextActionCard
        status="blocked"
        blockerDiagnostics={gateDiagnostics}
      />,
    );
    const card = container.querySelector('[data-testid="issue-next-action-card"]');
    expect(card?.getAttribute("data-next-action-kind")).toBe("terminal_gate");
    expect(
      container.querySelector('[data-testid="issue-next-action-terminal-gates"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("workspace finalize gate");
  });

  it("surfaces a diagnostics load failure clearly", () => {
    render(
      <IssueNextActionCard
        status="blocked"
        blockedInboxAttention={attention}
        diagnosticsError="Request failed (500)"
      />,
    );
    const err = container.querySelector('[data-testid="issue-next-action-diagnostics-error"]');
    expect(err).not.toBeNull();
    expect(err?.textContent).toContain("Request failed (500)");
  });
});
