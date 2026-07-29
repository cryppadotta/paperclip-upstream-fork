import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptedCandidates,
  classify,
  decodeJwtPayload,
  normalizeApiBase,
} from "./garden-inbox.mjs";

const now = new Date("2026-07-29T00:00:00.000Z");

function issue(overrides = {}) {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    title: "Example",
    status: "done",
    updatedAt: "2025-01-01T00:00:00.000Z",
    blockedBy: [],
    ...overrides,
  };
}

function workspace(overrides = {}) {
  return {
    gone: false,
    error: null,
    status: "active",
    branchCommitAt: "2025-01-01T00:00:00.000Z",
    readiness: {
      git: { isMergedIntoBase: false, aheadCount: 0 },
      linkedIssues: [{ isTerminal: true }],
    },
    ...overrides,
  };
}

test("classifies each archive and keep condition into one bucket", () => {
  const merged = workspace({
    readiness: {
      git: { isMergedIntoBase: true, aheadCount: 0 },
      linkedIssues: [{ isTerminal: true }],
    },
  });
  assert.equal(classify(issue(), merged, 60, now).bucket, "A");
  assert.equal(classify(issue(), workspace(), 60, now).bucket, "B");
  assert.equal(classify(issue(), workspace({
    readiness: {
      git: { isMergedIntoBase: false, aheadCount: 2 },
      linkedIssues: [{ isTerminal: true }],
    },
  }), 60, now).bucket, "C");
  assert.equal(classify(issue({ status: "in_progress" }), workspace(), 60, now).bucket, "D");
});

test("keeps candidates when workspace safety inspection fails", () => {
  const result = classify(issue(), workspace({ error: "503 Service Unavailable", readiness: null }), 60, now);
  assert.equal(result.bucket, "D");
  assert.equal(result.reason.code, "workspace_inspection_failed");
});

test("returns only accepted options from the originating scan", () => {
  const candidate = { issueId: "issue-1", bucket: "A" };
  const scan = { scanId: "scan-1" };
  const interaction = {
    id: "interaction-1",
    kind: "request_checkbox_confirmation",
    idempotencyKey: "garden-inbox:scan-1:1:1",
    status: "accepted",
    payload: { options: [{ id: "issue-1" }] },
    result: { outcome: "accepted", selectedOptionIds: ["issue-1"] },
  };
  assert.deepEqual(acceptedCandidates(interaction, scan, new Map([[candidate.issueId, candidate]])), [candidate]);
});

test("rejects selected ids that were not offered", () => {
  const scan = { scanId: "scan-1" };
  const interaction = {
    id: "interaction-1",
    kind: "request_checkbox_confirmation",
    idempotencyKey: "garden-inbox:scan-1:1:1",
    status: "accepted",
    payload: { options: [{ id: "issue-1" }] },
    result: { outcome: "accepted", selectedOptionIds: ["issue-2"] },
  };
  assert.throws(
    () => acceptedCandidates(interaction, scan, new Map()),
    /was not an option in the interaction/,
  );
});

test("decodes the responsible user and normalizes API URLs locally", () => {
  const payload = Buffer.from(JSON.stringify({ responsible_user_id: "user-1" })).toString("base64url");
  assert.equal(decodeJwtPayload(`header.${payload}.signature`).responsible_user_id, "user-1");
  assert.equal(normalizeApiBase("https://paperclip.example/api/"), "https://paperclip.example");
});
