// The monitor scheduler is part of the heartbeat service contract, but its
// behavior-focused suite predates the heartbeat coverage gate's filename
// convention. Import it here so those integration scenarios participate in the
// focused heartbeat coverage run as well as the normal server test run.
import "../__tests__/issue-monitor-scheduler.test.js";

import { describe, expect, it } from "vitest";
import {
  heartbeatDateValue,
  latestHeartbeatDate,
  redactHeartbeatProgressSummaryCandidate,
  requireIssueMonitorDispatchTarget,
  truncateHeartbeatAgentErrorReason,
} from "./heartbeat.js";

describe("heartbeat monitor and retry pure guards", () => {
  it("requires a concrete monitor dispatch target", () => {
    expect(requireIssueMonitorDispatchTarget("agent-1")).toBe("agent-1");
    expect(() => requireIssueMonitorDispatchTarget(null)).toThrow("Issue monitor has no agent target");
  });

  it("normalizes valid heartbeat dates and rejects invalid or unsupported values", () => {
    const valid = new Date("2026-08-01T00:00:00.000Z");

    expect(heartbeatDateValue(valid)).toBe(valid);
    expect(heartbeatDateValue(new Date(Number.NaN))).toBeNull();
    expect(heartbeatDateValue("2026-08-02T00:00:00.000Z")?.toISOString()).toBe(
      "2026-08-02T00:00:00.000Z",
    );
    expect(heartbeatDateValue(0)?.toISOString()).toBe("1970-01-01T00:00:00.000Z");
    expect(heartbeatDateValue("not-a-date")).toBeNull();
    expect(heartbeatDateValue({})).toBeNull();
  });

  it("selects the latest valid heartbeat date", () => {
    expect(latestHeartbeatDate(null, "not-a-date")).toBeNull();
    expect(
      latestHeartbeatDate(
        "2026-08-01T00:00:00.000Z",
        new Date("2026-08-03T00:00:00.000Z"),
        "2026-08-02T00:00:00.000Z",
      )?.toISOString(),
    ).toBe("2026-08-03T00:00:00.000Z");
  });

  it("normalizes agent error reasons", () => {
    expect(truncateHeartbeatAgentErrorReason(null)).toBeNull();
    expect(truncateHeartbeatAgentErrorReason("   ")).toBeNull();
    expect(truncateHeartbeatAgentErrorReason(" failure ")).toBe("failure");
    expect(truncateHeartbeatAgentErrorReason("x".repeat(501))).toBe(`${"x".repeat(499)}…`);
  });

  it("handles absent and present successful-run progress candidates", () => {
    expect(redactHeartbeatProgressSummaryCandidate(undefined)).toBeNull();
    expect(redactHeartbeatProgressSummaryCandidate("  made   progress  ")).toBe("made progress");
  });
});
