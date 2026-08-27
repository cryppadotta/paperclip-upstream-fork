// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AttentionFeed, RecentIssue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./ui/tooltip";
import { SidebarRecentIssues } from "./SidebarRecentIssues";

vi.mock("@/lib/router", () => ({
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
    collapsed: false,
    peeking: false,
  }),
}));

const recentIssue = (overrides: Partial<RecentIssue> = {}): RecentIssue => ({
  id: "issue-1",
  identifier: "PAP-1",
  title: "First task",
  status: "in_progress",
  kind: "commented",
  lastInteractedAt: "2026-08-27T13:00:00.000Z",
  hasActiveRun: false,
  needsAttention: false,
  ...overrides,
});

const emptyAttentionFeed: AttentionFeed = {
  companyId: "company-1",
  generatedAt: "2026-08-27T15:00:00.000Z",
  totalCount: 0,
  deskBadgeCount: 0,
  nextCursor: null,
  countsBySourceKind: {} as AttentionFeed["countsBySourceKind"],
  items: [],
};

describe("SidebarRecentIssues", () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderRecent(props: React.ComponentProps<typeof SidebarRecentIssues>) {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <SidebarRecentIssues {...props} />
        </TooltipProvider>,
      );
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders nothing for an empty recent list", () => {
    renderRecent({ issues: [], liveIssueIds: new Set() });
    expect(container.innerHTML).toBe("");
  });

  it("uses endpoint decorations initially and exposes text equivalents", () => {
    renderRecent({
      issues: [recentIssue({ hasActiveRun: true, needsAttention: true })],
      liveIssueIds: undefined,
    });

    expect(container.textContent).toContain("Needs you");
    expect(container.querySelector('[aria-label="Live run"]')).not.toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-1");
  });

  it("keeps server order stable when live and attention decorations change", () => {
    const issues = [
      recentIssue({ id: "issue-1", identifier: "PAP-1", title: "Newest" }),
      recentIssue({ id: "issue-2", identifier: "PAP-2", title: "Older" }),
    ];
    renderRecent({ issues, liveIssueIds: new Set(["issue-2"]), attentionFeed: emptyAttentionFeed });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Newest", "Olderlive"]);

    renderRecent({ issues, liveIssueIds: new Set(["issue-1"]), attentionFeed: emptyAttentionFeed });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Newestlive", "Older"]);
  });

  it("dims terminal rows and safely truncates hostile titles", () => {
    const hostileTitle = `${"Long title ".repeat(30)}😀 שלום <script>alert(1)</script> \"quoted\"`;
    renderRecent({
      issues: [recentIssue({ title: hostileTitle, status: "done" })],
      liveIssueIds: new Set(),
      attentionFeed: emptyAttentionFeed,
    });

    const title = [...container.querySelectorAll("span")].find((node) => node.textContent === hostileTitle);
    expect(title?.className).toContain("truncate");
    expect(title?.className).toContain("text-muted-foreground");
    expect(title?.closest("a")?.className).toContain("min-w-0");
    expect(document.querySelector("script")).toBeNull();
  });
});
