import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueAccessGrants,
  issueReferenceMentions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
type Db = ReturnType<typeof createDb>;

function boardActor(companyId: string, userId: string): Express.Request["actor"] {
  return {
    type: "board",
    userId,
    companyIds: [companyId],
    source: "session",
    isInstanceAdmin: false,
  };
}

function agentActor(companyId: string, agentId: string): Express.Request["actor"] {
  return { type: "agent", agentId, companyId, runId: null, source: "agent_jwt" };
}

async function createApp(db: Db, actor: Express.Request["actor"]) {
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, {} as any));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describeEmbeddedPostgres.sequential("issue access grant and locked edge routes", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousPrivacyMode = process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-access-grants-");
    db = createDb(tempDb.connectionString);
    process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = "enforce";
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueReferenceMentions);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(issueAccessGrants);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(authUsers);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (previousPrivacyMode === undefined) delete process.env.PAPERCLIP_ISSUE_PRIVACY_MODE;
    else process.env.PAPERCLIP_ISSUE_PRIVACY_MODE = previousPrivacyMode;
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const ownerId = `owner-${randomUUID()}`;
    const memberId = `member-${randomUUID()}`;
    const sharedUserId = `shared-${randomUUID()}`;
    const now = new Date();
    await db.insert(companies).values({
      id: companyId,
      name: "Private issue grants",
      issuePrefix: `P${randomUUID().replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values([
      { id: ownerId, name: "Olivia Owner", email: `${ownerId}@example.test`, createdAt: now, updatedAt: now },
      { id: memberId, name: "Nora Nonreader", email: `${memberId}@example.test`, createdAt: now, updatedAt: now },
      {
        id: sharedUserId,
        name: "Uma User",
        email: `${sharedUserId}@example.test`,
        image: "https://example.test/uma.png",
        createdAt: now,
        updatedAt: now,
      },
    ]);
    await db.insert(companyMemberships).values([ownerId, memberId, sharedUserId].map((principalId) => ({
      companyId,
      principalType: "user",
      principalId,
      status: "active",
      membershipRole: "operator",
    })));
    const [assignedAgent, sharedAgent] = await db.insert(agents).values([
      {
        companyId,
        name: "Assigned Agent",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        companyId,
        name: "Private Helper",
        role: "engineer",
        status: "active",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {
          authorizationPolicy: {
            agentVisibility: { mode: "private", hiddenFromDefaultDirectory: true },
          },
        },
      },
    ]).returning();
    const privateIssueId = randomUUID();
    await db.insert(issues).values({
      id: privateIssueId,
      companyId,
      identifier: "PRV-1",
      title: "Confidential root",
      status: "backlog",
      priority: "medium",
      visibility: "private",
      privacyRootIssueId: privateIssueId,
      responsibleUserId: ownerId,
      createdByUserId: ownerId,
    });
    const privateChild = await db.insert(issues).values({
      companyId,
      parentId: privateIssueId,
      identifier: "PRV-1A",
      title: "Confidential child",
      status: "backlog",
      priority: "medium",
      visibility: "private",
      privacyRootIssueId: privateIssueId,
      responsibleUserId: ownerId,
      createdByUserId: ownerId,
    }).returning().then((rows) => rows[0]!);
    const openIssue = await db.insert(issues).values({
      companyId,
      identifier: "PRV-2",
      title: "Open issue",
      status: "todo",
      priority: "medium",
      createdByUserId: ownerId,
    }).returning().then((rows) => rows[0]!);
    return {
      companyId,
      ownerId,
      memberId,
      sharedUserId,
      assignedAgent: assignedAgent!,
      sharedAgent: sharedAgent!,
      privateIssueId,
      privateChild,
      openIssue,
    };
  }

  it("auto-grants private-root access on assignment and keeps it sticky until revoke", async () => {
    const fixture = await seedFixture();
    const ownerApp = await createApp(db, boardActor(fixture.companyId, fixture.ownerId));

    const assigned = await request(ownerApp)
      .patch(`/api/issues/${fixture.privateChild.id}`)
      .send({ assigneeAgentId: fixture.assignedAgent.id });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);

    await request(ownerApp)
      .patch(`/api/issues/${fixture.privateChild.id}`)
      .send({ assigneeAgentId: fixture.assignedAgent.id })
      .expect(200);
    await request(ownerApp)
      .patch(`/api/issues/${fixture.privateChild.id}`)
      .send({ assigneeAgentId: null })
      .expect(200);
    const unassignedIssue = await db.select().from(issues).then((rows) => rows.find((row) => row.id === fixture.privateChild.id));
    expect(unassignedIssue?.assigneeAgentId).toBeNull();

    const grants = await db.select().from(issueAccessGrants);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      issueId: fixture.privateIssueId,
      subjectType: "agent",
      subjectId: fixture.assignedAgent.id,
      source: "assignment",
      grantedByUserId: fixture.ownerId,
      revokedAt: null,
    });

    const readableBeforeRevoke = await request(await createApp(
      db,
      agentActor(fixture.companyId, fixture.assignedAgent.id),
    )).get(`/api/issues/${fixture.privateIssueId}`);
    expect(readableBeforeRevoke.status).toBe(200);

    await request(ownerApp)
      .post(`/api/issues/${fixture.privateChild.id}/access-grants/${grants[0]!.id}/revoke`)
      .send({})
      .expect(200);
    const deniedAfterRevoke = await request(await createApp(
      db,
      agentActor(fixture.companyId, fixture.assignedAgent.id),
    )).get(`/api/issues/${fixture.privateIssueId}`);
    expect(deniedAfterRevoke.status).toBe(404);
    expect(deniedAfterRevoke.body.error).toBe("Issue not found");
  }, 20_000);

  it("creates and enriches explicit grants idempotently while rejecting unauthorized and open shares", async () => {
    const fixture = await seedFixture();
    const ownerApp = await createApp(db, boardActor(fixture.companyId, fixture.ownerId));
    const nonreaderApp = await createApp(db, boardActor(fixture.companyId, fixture.memberId));

    await request(nonreaderApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id })
      .expect(404);
    await request(nonreaderApp)
      .patch(`/api/issues/${fixture.privateIssueId}`)
      .send({ assigneeAgentId: fixture.assignedAgent.id })
      .expect(404);
    const openShare = await request(ownerApp)
      .post(`/api/issues/${fixture.openIssue.id}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id });
    expect(openShare.status).toBe(409);
    expect(openShare.body.error).toContain("Open issues");

    const first = await request(ownerApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body).toMatchObject({
      issueId: fixture.privateIssueId,
      source: "explicit",
      subjectDisplayName: "Private Helper",
      subjectInitials: "PH",
      subjectAvatarUrl: null,
      agentVisibility: "private",
    });
    const duplicate = await request(ownerApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "agent", subjectId: fixture.sharedAgent.id });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.id).toBe(first.body.id);

    await request(ownerApp)
      .post(`/api/issues/${fixture.privateIssueId}/access-grants`)
      .send({ subjectType: "user", subjectId: fixture.sharedUserId })
      .expect(201);
    const listed = await request(ownerApp).get(`/api/issues/${fixture.privateIssueId}/access-grants`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual(expect.arrayContaining([
      expect.objectContaining({
        subjectId: fixture.sharedUserId,
        subjectDisplayName: "Uma User",
        subjectAvatarUrl: "https://example.test/uma.png",
        subjectInitials: "UU",
        agentVisibility: null,
      }),
    ]));
    expect(await db.select().from(issueAccessGrants)).toHaveLength(2);
    const createdActivities = await db.select().from(activityLog);
    expect(createdActivities.filter((row) => row.action === "issue_access_grant.created")).toHaveLength(2);
  }, 20_000);

  it("returns exact locked stubs only through visible blocker and mention edges", async () => {
    const fixture = await seedFixture();
    const visibleIssue = await db.insert(issues).values({
      companyId: fixture.companyId,
      identifier: "PRV-3",
      title: "Visible coordination issue",
      description: "Depends on PRV-1",
      status: "blocked",
      priority: "medium",
      createdByUserId: fixture.memberId,
    }).returning().then((rows) => rows[0]!);
    await db.insert(issueRelations).values({
      companyId: fixture.companyId,
      issueId: fixture.privateIssueId,
      relatedIssueId: visibleIssue.id,
      type: "blocks",
    });
    await db.insert(issueReferenceMentions).values({
      companyId: fixture.companyId,
      sourceIssueId: visibleIssue.id,
      targetIssueId: fixture.privateIssueId,
      sourceKind: "description",
      sourceRecordId: null,
      documentKey: null,
      matchedText: "PRV-1",
    });

    const app = await createApp(db, boardActor(fixture.companyId, fixture.memberId));
    const detail = await request(app).get(`/api/issues/${visibleIssue.id}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    const expectedStub = { id: fixture.privateIssueId, identifier: "PRV-1", locked: true };
    expect(detail.body.blockedBy).toEqual([expectedStub]);
    expect(detail.body.relatedWork.outbound[0].issue).toEqual(expectedStub);
    expect(JSON.stringify(detail.body)).not.toContain("Confidential root");

    const direct = await request(app).get(`/api/issues/${fixture.privateIssueId}`);
    expect(direct.status).toBe(404);

    const list = await request(app)
      .get(`/api/companies/${fixture.companyId}/issues?includeBlockedBy=true`);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.map((row: { id: string }) => row.id)).not.toContain(fixture.privateIssueId);
    const visibleRow = list.body.find((row: { id: string }) => row.id === visibleIssue.id);
    expect(visibleRow.blockedBy).toEqual([expectedStub]);

    const search = await request(app)
      .get(`/api/companies/${fixture.companyId}/search?q=Confidential%20root&scope=issues`);
    expect(search.status).toBe(200);
    expect(search.body.results.map((row: { id: string }) => row.id)).not.toContain(fixture.privateIssueId);
  }, 20_000);
});
