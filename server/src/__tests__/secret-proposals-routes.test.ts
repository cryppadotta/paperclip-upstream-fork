import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecretBindings,
  companySecretProposals,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { conflict } from "../errors.js";
import { errorHandler } from "../middleware/error-handler.js";
import { secretRoutes } from "../routes/secrets.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { secretService } from "../services/secrets.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("secret proposal routes", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-secret-proposals-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("secret-proposal-routes");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(companySecretProposals);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const heartbeatRunId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Secret proposals",
      issuePrefix: `P${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Proposer",
      role: "engineer",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    await db.insert(heartbeatRuns).values({
      id: heartbeatRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs credential",
      identifier: "SEC-1",
      status: "in_progress",
      executionRunId: heartbeatRunId,
    });
    return { companyId, agentId, heartbeatRunId, issueId };
  }

  function createAgentApp(
    fixture: Awaited<ReturnType<typeof seedRun>>,
    source: "agent_jwt" | "agent_key" = "agent_jwt",
    keyScope: { kind: "standard" } | { kind: "task_bridge"; parentIssueId: string } = { kind: "standard" },
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent",
        agentId: fixture.agentId,
        companyId: fixture.companyId,
        runId: fixture.heartbeatRunId,
        source,
        keyScope,
      };
      next();
    });
    app.use("/api", secretRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function createBoardApp(
    fixture: Awaited<ReturnType<typeof seedRun>>,
    options?: { admin?: boolean; heartbeat?: IssueAssignmentWakeupDeps },
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board",
        userId: "board-user",
        companyIds: [fixture.companyId],
        source: options?.admin === false ? "session" : "local_implicit",
        memberships: options?.admin === false
          ? [{ companyId: fixture.companyId, status: "active", membershipRole: "member" }]
          : undefined,
      };
      next();
    });
    app.use("/api", secretRoutes(db, options?.heartbeat ? { heartbeat: options.heartbeat } : undefined));
    app.use(errorHandler);
    return app;
  }

  it("requires company admin access to reject secret proposals", async () => {
    const fixture = await seedRun();
    const proposed = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/reject/token", value: "reject-secret", justification: "Needed" });

    const rejected = await request(createBoardApp(fixture, { admin: false }))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${proposed.body.id}/reject`)
      .send({ reason: "Not approved" });

    expect(rejected.status).toBe(403);
    expect(await db.select().from(companySecretProposals).where(eq(companySecretProposals.id, proposed.body.id)))
      .toEqual([expect.objectContaining({ status: "pending", valueCiphertext: expect.any(Object) })]);
  });

  it("keeps committed approve and reject responses successful when resolution wakeup fails", async () => {
    const fixture = await seedRun();
    await db.update(issues)
      .set({ assigneeAgentId: fixture.agentId })
      .where(eq(issues.id, fixture.issueId));
    const wakeup = vi.fn().mockRejectedValue(new Error("wakeup queue unavailable"));
    const boardApp = createBoardApp(fixture, { heartbeat: { wakeup } });

    const approvedProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/notification/approve",
        value: "approval-value",
        justification: "Needed by task",
      });
    const approved = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${approvedProposal.body.id}/approve`)
      .send({});

    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");

    const rejectedProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/notification/reject",
        value: "rejection-value",
        justification: "Needed by task",
      });
    const rejected = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${rejectedProposal.body.id}/reject`)
      .send({ reason: "No longer needed" });

    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(await db.select().from(companySecretProposals)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: approvedProposal.body.id, status: "approved", valueCiphertext: null }),
      expect.objectContaining({ id: rejectedProposal.body.id, status: "rejected", valueCiphertext: null }),
    ]));
    expect(await db.select().from(issueComments)).toHaveLength(2);
  });

  it("requires agent JWT and atomically cascade-approves a secret plus binding with dual audits", async () => {
    const fixture = await seedRun();
    const denied = await request(createAgentApp(fixture, "agent_key"))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/vendor/token", value: "top-secret", justification: "Needed by task" });
    expect(denied.status).toBe(403);
    const scopedDenied = await request(createAgentApp(
      fixture,
      "agent_jwt",
      { kind: "task_bridge", parentIssueId: fixture.issueId },
    )).post("/api/agents/me/secret-proposals").send({
      kind: "secret",
      name: "dev/vendor/token",
      value: "top-secret",
      justification: "Needed by task",
    });
    expect(scopedDenied.status).toBe(403);

    const secretResponse = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/vendor/token",
        key: "VENDOR_TOKEN",
        value: "top-secret",
        justification: "Needed by task",
      });
    expect(secretResponse.status).toBe(201);
    expect(JSON.stringify(secretResponse.body)).not.toContain("top-secret");
    expect(secretResponse.body).not.toHaveProperty("valueFingerprintSha256");
    const [registeredRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.heartbeatRunId));
    expect(JSON.stringify(registeredRun.contextSnapshot)).not.toContain("top-secret");
    expect(registeredRun.contextSnapshot).toMatchObject({
      paperclipSecretRedactions: [expect.objectContaining({ fingerprintSha256: expect.any(String), material: expect.any(Object) })],
    });

    const bindingResponse = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretResponse.body.id,
        configPath: "env.VENDOR_TOKEN",
        justification: "Inject for the task",
      });
    expect(bindingResponse.status).toBe(201);

    const agentApprovalDenied = await request(createAgentApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretResponse.body.id}/approve`)
      .send({});
    expect(agentApprovalDenied.status).toBe(403);
    expect(await db.select().from(companySecrets)).toHaveLength(0);

    const prerequisite = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingResponse.body.id}/approve`)
      .send({});
    expect(prerequisite.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);

    const approved = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingResponse.body.id}/approve`)
      .send({ cascade: true });
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({
      status: "approved",
      appliedBindingConfigPath: "env.VENDOR_TOKEN",
      viewerCanApprove: false,
    });

    const proposalRows = await db.select().from(companySecretProposals);
    expect(proposalRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secretResponse.body.id, status: "approved", valueCiphertext: null }),
      expect.objectContaining({ id: bindingResponse.body.id, status: "approved" }),
    ]));
    const [secret] = await db.select().from(companySecrets);
    expect(secret).toMatchObject({
      name: "dev/vendor/token",
      key: "vendor_token",
      createdByAgentId: fixture.agentId,
      createdByUserId: "board-user",
    });
    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({ secretId: secret.id, targetId: fixture.agentId, configPath: "env.VENDOR_TOKEN" }),
    ]);
    const [agent] = await db.select().from(agents);
    expect(agent.adapterConfig).toMatchObject({
      env: { VENDOR_TOKEN: { type: "secret_ref", secretId: secret.id, version: "latest" } },
    });
    const actions = (await db.select().from(activityLog)).map((row) => row.action);
    expect(actions.filter((action) => action === "secret.proposal.approved")).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(["secret.proposal.created", "secret.created", "agent.updated"]));
    expect(await db.select().from(issueComments)).toEqual([
      expect.objectContaining({ issueId: fixture.issueId, authorUserId: "board-user" }),
    ]);
  });

  it("approves a binding without cascade after its secret proposal was approved separately", async () => {
    const fixture = await seedRun();
    const agentApp = createAgentApp(fixture);
    const boardApp = createBoardApp(fixture);
    const secretProposal = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/sequential/token",
        value: "sequential-secret",
        justification: "Approve this first",
      });
    expect(secretProposal.status).toBe(201);

    const bindingProposal = await request(agentApp)
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.SEQUENTIAL_TOKEN",
        justification: "Bind after separate approval",
      });
    expect(bindingProposal.status).toBe(201);

    const approvedSecret = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretProposal.body.id}/approve`)
      .send({});
    expect(approvedSecret.status).toBe(200);
    expect(approvedSecret.body).toMatchObject({ status: "approved", createdSecretId: expect.any(String) });

    const approvedBinding = await request(boardApp)
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({});
    expect(approvedBinding.status).toBe(200);
    expect(approvedBinding.body).toMatchObject({
      status: "approved",
      appliedBindingConfigPath: "env.SEQUENTIAL_TOKEN",
    });
    expect(await db.select().from(companySecrets)).toHaveLength(1);
    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({
        secretId: approvedSecret.body.createdSecretId,
        targetId: fixture.agentId,
        configPath: "env.SEQUENTIAL_TOKEN",
      }),
    ]);
  });

  it("serializes proposal quotas and exposes bounded list pagination", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/quota/source",
      key: "QUOTA_SOURCE",
      provider: "local_encrypted",
      value: "quota-source-secret",
    });
    const agentApp = createAgentApp(fixture);

    const responses = await Promise.all(Array.from({ length: 21 }, (_, index) =>
      request(agentApp)
        .post("/api/agents/me/secret-proposals")
        .send({
          kind: "binding",
          secretId: liveSecret.id,
          configPath: `env.QUOTA_${index}`,
          justification: "Exercise the concurrent proposal cap",
        })));
    expect(responses.filter((response) => response.status === 201)).toHaveLength(20);
    expect(responses.filter((response) => response.status === 422)).toHaveLength(1);
    expect(await db.select().from(companySecretProposals)).toHaveLength(20);
    expect(await db.select().from(activityLog)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "secret.proposal.denied" }),
    ]));

    const firstPage = await request(agentApp).get("/api/agents/me/secret-proposals?limit=7&offset=0");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.proposals).toHaveLength(7);
    expect(firstPage.body.nextOffset).toBe(7);
    expect(firstPage.headers["x-next-offset"]).toBe("7");

    const lastBoardPage = await request(createBoardApp(fixture))
      .get(`/api/companies/${fixture.companyId}/secret-proposals?status=pending&limit=7&offset=14`);
    expect(lastBoardPage.status).toBe(200);
    expect(lastBoardPage.body).toHaveLength(6);
    expect(lastBoardPage.headers["x-next-offset"]).toBeUndefined();
  });

  it("bounds each expiry sweep batch", async () => {
    const fixture = await seedRun();
    const liveSecret = await secretService(db).create(fixture.companyId, {
      name: "dev/sweep/source",
      key: "SWEEP_SOURCE",
      provider: "local_encrypted",
      value: "sweep-source-secret",
    });
    const agentApp = createAgentApp(fixture);
    for (let index = 0; index < 3; index += 1) {
      const response = await request(agentApp)
        .post("/api/agents/me/secret-proposals")
        .send({
          kind: "binding",
          secretId: liveSecret.id,
          configPath: `env.SWEEP_${index}`,
          justification: "Exercise bounded expiry cleanup",
        });
      expect(response.status).toBe(201);
    }
    await db.update(companySecretProposals).set({ expiresAt: new Date(Date.now() - 1_000) });

    const proposals = createSecretProposalsService(db);
    let injectedCollision = false;
    await expect(proposals.sweepExpired(new Date(), 2, async (companyId, proposalId) => {
      if (!injectedCollision) {
        injectedCollision = true;
        throw conflict("Proposal is no longer pending");
      }
      return proposals.transition(companyId, proposalId, "expired", { reason: "Pending proposal expired" });
    })).resolves.toBe(1);
    expect((await db.select().from(companySecretProposals)).filter((proposal) => proposal.status === "pending"))
      .toHaveLength(2);
    await expect(proposals.sweepExpired(new Date(), 2)).resolves.toBe(2);
  });

  it("denies direct and cascade approval after a proposal expires", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/expired/token",
        value: "expired-secret",
        justification: "Needed before the retention window elapsed",
      });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.EXPIRED_TOKEN",
        justification: "Inject the proposed secret",
      });
    await db.update(companySecretProposals)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(companySecretProposals.id, secretProposal.body.id));

    const directApproval = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${secretProposal.body.id}/approve`)
      .send({});
    expect(directApproval.status).toBe(409);

    const cascadeApproval = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({ cascade: true });
    expect(cascadeApproval.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
  });

  it("returns 409 without mutation when the current org graph no longer permits the stored binding target", async () => {
    const fixture = await seedRun();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Report",
      role: "engineer",
      reportsTo: fixture.agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({ kind: "secret", name: "dev/reorg/token", value: "reorg-secret", justification: "Needed by report" });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        targetAgentId,
        configPath: "access.REORG_TOKEN",
        justification: "Give the report API access",
      });
    expect(bindingProposal.status).toBe(201);

    await db.update(agents).set({ reportsTo: null }).where(eq(agents.id, targetAgentId));
    const response = await request(createBoardApp(fixture))
      .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
      .send({ cascade: true });
    expect(response.status).toBe(409);
    expect(await db.select().from(companySecrets)).toHaveLength(0);
    expect((await db.select().from(companySecretProposals)).every((proposal) => proposal.status === "pending")).toBe(true);
  });


  it("rejects bindings that reference terminal secret proposals", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/withdrawn/token",
        value: "withdrawn-secret",
        justification: "No longer needed",
      });
    expect(secretProposal.status).toBe(201);

    const withdrawn = await request(createAgentApp(fixture))
      .delete(`/api/agents/me/secret-proposals/${secretProposal.body.id}`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.status).toBe("withdrawn");

    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.WITHDRAWN_TOKEN",
        justification: "Reference a terminal dependency",
      });
    expect(bindingProposal.status).toBe(422);
    expect(bindingProposal.body.error).toContain("no longer pending");
    expect(await db.select().from(companySecretProposals)).toEqual([
      expect.objectContaining({ id: secretProposal.body.id, status: "withdrawn" }),
    ]);
  });

  it("cascade-rejects pending binding proposals when their secret proposal is withdrawn", async () => {
    const fixture = await seedRun();
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/cascade/token",
        value: "cascade-secret",
        justification: "Temporary access",
      });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        configPath: "env.CASCADE_TOKEN",
        justification: "Use the temporary secret",
      });
    expect(bindingProposal.status).toBe(201);

    const withdrawn = await request(createAgentApp(fixture))
      .delete(`/api/agents/me/secret-proposals/${secretProposal.body.id}`);
    expect(withdrawn.status).toBe(200);

    expect(await db.select().from(companySecretProposals)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: secretProposal.body.id, status: "withdrawn" }),
      expect.objectContaining({
        id: bindingProposal.body.id,
        status: "rejected",
        resolutionReason: `Dependent secret proposal ${secretProposal.body.id} was withdrawn`,
      }),
    ]));
  });

  it("holds the org graph stable until binding approval commits", async () => {
    const fixture = await seedRun();
    const targetAgentId = randomUUID();
    await db.insert(agents).values({
      id: targetAgentId,
      companyId: fixture.companyId,
      name: "Concurrent report",
      role: "engineer",
      reportsTo: fixture.agentId,
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
      status: "idle",
    });
    const secretProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "secret",
        name: "dev/concurrent-reorg/token",
        value: "concurrent-reorg-secret",
        justification: "Needed by report",
      });
    const bindingProposal = await request(createAgentApp(fixture))
      .post("/api/agents/me/secret-proposals")
      .send({
        kind: "binding",
        secretProposalId: secretProposal.body.id,
        targetAgentId,
        configPath: "access.CONCURRENT_REORG_TOKEN",
        justification: "Give the report API access",
      });
    expect(bindingProposal.status).toBe(201);

    const advisoryLockKey = 147460185;
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION paperclip_test_pause_secret_approval()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $function$
      BEGIN
        PERFORM pg_advisory_xact_lock(${advisoryLockKey});
        PERFORM pg_sleep(1);
        RETURN NEW;
      END
      $function$;
      CREATE TRIGGER paperclip_test_pause_secret_approval
      BEFORE INSERT ON company_secrets
      FOR EACH ROW EXECUTE FUNCTION paperclip_test_pause_secret_approval();
    `));

    try {
      const approvalPromise = request(createBoardApp(fixture))
        .post(`/api/companies/${fixture.companyId}/secret-proposals/${bindingProposal.body.id}/approve`)
        .send({ cascade: true })
        .then((response) => response);

      let approvalPaused = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const lockAvailable = await db.transaction(async (tx) => {
          const [result] = await tx.execute<{ acquired: boolean }>(
            sql`SELECT pg_try_advisory_lock(${advisoryLockKey}) AS acquired`,
          );
          if (result?.acquired) {
            await tx.execute(sql`SELECT pg_advisory_unlock(${advisoryLockKey})`);
          }
          return result?.acquired ?? false;
        });
        if (!lockAvailable) {
          approvalPaused = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(approvalPaused).toBe(true);

      let reorgFinished = false;
      const reorgPromise = db.update(agents)
        .set({ reportsTo: null })
        .where(eq(agents.id, targetAgentId))
        .then(() => {
          reorgFinished = true;
        });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(reorgFinished).toBe(false);

      const approval = await approvalPromise;
      expect(approval.status).toBe(200);
      await reorgPromise;
    } finally {
      await db.execute(sql.raw(`
        DROP TRIGGER IF EXISTS paperclip_test_pause_secret_approval ON company_secrets;
        DROP FUNCTION IF EXISTS paperclip_test_pause_secret_approval();
      `));
    }

    expect(await db.select().from(companySecretBindings)).toEqual([
      expect.objectContaining({ targetId: targetAgentId, configPath: "access.CONCURRENT_REORG_TOKEN" }),
    ]);
    expect(await db.select({ reportsTo: agents.reportsTo }).from(agents).where(eq(agents.id, targetAgentId)))
      .toEqual([{ reportsTo: null }]);
  });
});
