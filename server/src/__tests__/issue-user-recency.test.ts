import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  companies,
  createDb,
  heartbeatRuns,
  issueApprovals,
  issueThreadInteractions,
  issueUserRecency,
  issues,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.js";
import { errorHandler } from "../middleware/index.js";
import { recentIssueRoutes } from "../routes/recent-issues.js";
import {
  issueRecencyKindForActivity,
  issueUserRecencyService,
  recordIssueUserRecency,
} from "../services/issue-user-recency.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("issueRecencyKindForActivity", () => {
  it.each([
    ["issue.created", "issue", {}, "created"],
    ["issue.comment_added", "issue", {}, "commented"],
    ["issue.thread_interaction_accepted", "issue", {}, "interaction"],
    ["issue.thread_interaction_rejected", "issue", {}, "interaction"],
    ["issue.thread_interaction_answered", "issue", {}, "interaction"],
    ["issue.thread_interaction_item_verdicts_submitted", "issue", {}, "interaction"],
    ["issue.updated", "issue", { changes: { status: { from: "todo", to: "done" } } }, "edited"],
    ["issue.document_updated", "issue", {}, "document"],
    ["approval.approved", "approval", {}, "approval"],
  ])("maps qualifying user activity %s", (action, entityType, details, expected) => {
    expect(issueRecencyKindForActivity({ actorType: "user", action, entityType, details })).toBe(expected);
  });

  it("excludes agent, inbound/system, view, and unrelated field activity", () => {
    expect(issueRecencyKindForActivity({ actorType: "agent", action: "issue.comment_added", entityType: "issue" })).toBeNull();
    expect(issueRecencyKindForActivity({ actorType: "system", action: "issue.comment_added", entityType: "issue" })).toBeNull();
    expect(issueRecencyKindForActivity({ actorType: "user", action: "issue.read_marked", entityType: "issue" })).toBeNull();
    expect(issueRecencyKindForActivity({
      actorType: "user",
      action: "issue.updated",
      entityType: "issue",
      details: { changes: { description: { from: "a", to: "b" } } },
    })).toBeNull();
  });
});

describeEmbeddedPostgres("issue user recency persistence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: Db;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-user-recency-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueUserRecency);
    await db.delete(issueApprovals);
    await db.delete(issueThreadInteractions);
    await db.delete(approvals);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  async function seedCompany(prefix: string) {
    const id = randomUUID();
    await db.insert(companies).values({ id, name: prefix, issuePrefix: prefix });
    return id;
  }

  async function seedIssue(companyId: string, title: string, identifier: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, title, identifier, status: "todo", priority: "medium" });
    return id;
  }

  it("upserts every qualifying user write while excluding agent and inbound activity", async () => {
    const companyId = await seedCompany("RQA");
    const userId = "user-a";
    const actions = [
      ["issue.created", "created", "issue", {}],
      ["issue.comment_added", "commented", "issue", {}],
      ["issue.thread_interaction_answered", "interaction", "issue", {}],
      ["issue.updated", "edited", "issue", { changes: { title: { from: "a", to: "b" } } }],
      ["issue.document_updated", "document", "issue", {}],
    ] as const;
    const expected = new Map<string, string>();
    for (let index = 0; index < actions.length; index += 1) {
      const [action, kind, entityType, details] = actions[index]!;
      const issueId = await seedIssue(companyId, kind, `RQA-${index + 1}`);
      expected.set(issueId, kind);
      await logActivity(db, { companyId, actorType: "user", actorId: userId, action, entityType, entityId: issueId, details });
    }

    const approvalIssueId = await seedIssue(companyId, "approval", "RQA-6");
    const [approval] = await db.insert(approvals).values({
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: {},
    }).returning();
    await db.insert(issueApprovals).values({ companyId, issueId: approvalIssueId, approvalId: approval!.id });
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: userId,
      action: "approval.approved",
      entityType: "approval",
      entityId: approval!.id,
    });
    expected.set(approvalIssueId, "approval");

    const excludedIssueId = await seedIssue(companyId, "excluded", "RQA-7");
    await logActivity(db, { companyId, actorType: "agent", actorId: randomUUID(), action: "issue.comment_added", entityType: "issue", entityId: excludedIssueId });
    await logActivity(db, { companyId, actorType: "system", actorId: "inbound", action: "issue.updated", entityType: "issue", entityId: excludedIssueId, details: { status: "done" } });
    await logActivity(db, { companyId, actorType: "user", actorId: userId, action: "issue.read_marked", entityType: "issue", entityId: excludedIssueId });

    const rows = await db.select().from(issueUserRecency).orderBy(asc(issueUserRecency.issueId));
    expect(rows).toHaveLength(expected.size);
    expect(new Map(rows.map((row) => [row.issueId, row.kind]))).toEqual(expected);
  });

  it("enforces company scope, the 30-day window, hard cap, ordering, and decorations", async () => {
    const companyId = await seedCompany("RQB");
    const otherCompanyId = await seedCompany("RQC");
    const userId = "user-a";
    const now = new Date("2026-08-27T12:00:00.000Z");
    const issueIds: string[] = [];
    for (let index = 0; index < 27; index += 1) {
      const issueId = await seedIssue(companyId, `Recent ${index}`, `RQB-${index + 1}`);
      issueIds.push(issueId);
      await recordIssueUserRecency(db, {
        companyId,
        userId,
        issueIds: [issueId],
        kind: "edited",
        interactedAt: new Date(now.getTime() - index * 60_000),
      });
    }
    const oldIssueId = await seedIssue(companyId, "Old", "RQB-28");
    await recordIssueUserRecency(db, { companyId, userId, issueIds: [oldIssueId], kind: "commented", interactedAt: new Date("2026-07-01T00:00:00.000Z") });
    const harnessIssueId = await seedIssue(companyId, "Internal harness", "RQB-29");
    await db.update(issues).set({ harnessKind: "skill_test" }).where(eq(issues.id, harnessIssueId));
    await recordIssueUserRecency(db, { companyId, userId, issueIds: [harnessIssueId], kind: "edited", interactedAt: now });
    const otherIssueId = await seedIssue(otherCompanyId, "Other company", "RQC-1");
    await recordIssueUserRecency(db, { companyId: otherCompanyId, userId, issueIds: [otherIssueId], kind: "edited", interactedAt: now });

    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Runner", role: "engineer", adapterType: "process", adapterConfig: {} });
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "running", contextSnapshot: { issueId: issueIds[0] } }).returning();
    await db.update(issues).set({ executionRunId: run!.id }).where(eq(issues.id, issueIds[0]!));
    await db.insert(issueThreadInteractions).values({
      companyId,
      issueId: issueIds[0]!,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Confirm" },
      createdByAgentId: agentId,
    });

    const rows = await issueUserRecencyService(db).listRecentIssues(companyId, userId, 100, now);
    expect(rows).toHaveLength(25);
    expect(rows.map((row) => row.id)).toEqual(issueIds.slice(0, 25));
    expect(rows.some((row) => [oldIssueId, harnessIssueId, otherIssueId].includes(row.id))).toBe(false);
    expect(rows[0]).toMatchObject({ hasActiveRun: true, needsAttention: true });
  });

  it("serves the current board user's company-scoped list and validates limit", async () => {
    const companyId = await seedCompany("RQD");
    const issueId = await seedIssue(companyId, "Current", "RQD-1");
    await recordIssueUserRecency(db, { companyId, userId: "user-a", issueIds: [issueId], kind: "commented" });
    const app = express();
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "user-a",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "viewer", status: "active" }],
      };
      next();
    });
    app.use("/api", recentIssueRoutes(db));
    app.use(errorHandler);

    const ok = await request(app).get(`/api/companies/${companyId}/users/me/recent-issues?limit=25`);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual([expect.objectContaining({ id: issueId, kind: "commented" })]);
    expect((await request(app).get(`/api/companies/${companyId}/users/me/recent-issues?limit=0`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${randomUUID()}/users/me/recent-issues`)).status).toBe(403);
  });
});
