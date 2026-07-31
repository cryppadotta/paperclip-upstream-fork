import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionBundleHeader, decisionHistoryQueryEnabled } from "./WhatNeedsMe";

describe("WhatNeedsMe decision history", () => {
  it("defers terminal-history queries until their curtain opens", () => {
    expect(decisionHistoryQueryEnabled("company-1", false)).toBe(false);
    expect(decisionHistoryQueryEnabled("company-1", true)).toBe(true);
    expect(decisionHistoryQueryEnabled(null, true)).toBe(false);
  });

  it("labels general bundles as decisions instead of cleanups", () => {
    const single = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose a route" originIssue={null} count={1} />,
    );
    const multiple = renderToStaticMarkup(
      <DecisionBundleHeader agentName="Planner" title="Choose routes" originIssue={null} count={2} />,
    );

    expect(single).toContain("Planner proposed 1 decision");
    expect(multiple).toContain("Planner proposed 2 decisions");
    expect(single).not.toContain("cleanup");
    expect(multiple).not.toContain("cleanup");
  });
});
