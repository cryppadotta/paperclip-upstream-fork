// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  issueStatus: "todo",
  decisionStatus: "open",
  executionStatus: null as string | null,
  chosenOptionId: null as string | null,
  mutate: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({ isPending: false, error: null, mutate: state.mutate }),
  useQuery: ({ queryKey }: { queryKey: readonly string[] }) => queryKey[1] === "detail"
    ? {
        data: {
          id: "decision-1",
          companyId: "company-1",
          originAgentId: "agent-1",
          originIssueId: "origin-1",
          status: state.decisionStatus,
          executionStatus: state.executionStatus,
          chosenOptionId: state.chosenOptionId,
          inputValues: {},
          targetSnapshots: { "target-1": { updatedAt: "2026-07-31T00:00:00.000Z" } },
          options: [{ id: "yes", label: "Yes", effects: [{
            type: "comment_on_issue", targetIssueId: "target-1", staleness: "lenient", bodyMarkdown: "hello",
          }] }],
          executions: [],
        },
        isLoading: false,
        error: null,
      }
    : { data: [], isLoading: false, error: null },
  useQueries: ({ queries }: { queries: Array<{ queryKey: readonly string[] }> }) => queries.map(() => ({
    data: { id: "target-1", identifier: "PAP-1", title: "Target", status: state.issueStatus },
  })),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "PAP" } }),
}));

vi.mock("./DecisionCard", () => ({
  DecisionCard: ({ resolveIssue }: { resolveIssue: (id: string) => { status: string | null } | null }) => (
    <div data-testid="resolved-status">{resolveIssue("target-1")?.status}</div>
  ),
}));

import { DecisionResolver } from "./DecisionResolver";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DecisionResolver", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    state.issueStatus = "todo";
    state.decisionStatus = "open";
    state.executionStatus = null;
    state.chosenOptionId = null;
    state.mutate.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("refreshes resolved target status when an issue query changes", () => {
    const root = createRoot(container);
    flushSync(() => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));
    expect(container.querySelector('[data-testid="resolved-status"]')?.textContent).toBe("todo");

    state.issueStatus = "done";
    flushSync(() => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));
    expect(container.querySelector('[data-testid="resolved-status"]')?.textContent).toBe("done");

    flushSync(() => root.unmount());
  });

  it("resumes a decision left running by an interrupted request", async () => {
    state.decisionStatus = "decided";
    state.executionStatus = "running";
    state.chosenOptionId = "yes";
    const root = createRoot(container);

    flushSync(() => root.render(<DecisionResolver companyId="company-1" decisionId="decision-1" />));

    await vi.waitFor(() => expect(state.mutate).toHaveBeenCalledWith({
      optionId: "yes",
      inputValues: {},
      idempotencyKey: null,
    }));
    flushSync(() => root.unmount());
  });
});
