import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  costEvents,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "Race seam coverage completed.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import {
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("heartbeat deterministic race seams", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-race-seams-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Race seam coverage completed.",
      provider: "test",
      model: "test-model",
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
      .where(sql`${heartbeatRuns.status} in ('queued', 'running')`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.execute(sql.raw("SET client_min_messages TO WARNING"));
        await db.execute(sql.raw('TRUNCATE TABLE "companies" RESTART IDENTITY CASCADE'));
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(input: {
    heartbeat?: Record<string, unknown>;
    status?: "active" | "paused";
  } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Race seam company",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "RaceAgent",
      role: "engineer",
      status: input.status ?? "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          ...(input.heartbeat ?? {}),
        },
      },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedQueuedRun(input: {
    companyId: string;
    agentId: string;
    issueId?: string | null;
    context?: Record<string, unknown>;
  }) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: input.issueId ? { issueId: input.issueId } : {},
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: {
        ...(input.issueId ? { issueId: input.issueId } : {}),
        ...(input.context ?? {}),
      },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    return { runId, wakeupRequestId };
  }

  async function seedIssue(companyId: string, agentId: string, input: {
    status?: "todo" | "in_progress" | "in_review";
    assigneeAgentId?: string | null;
  } = {}) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Race seam issue",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId === undefined ? agentId : input.assigneeAgentId,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  async function runStatus(runId: string) {
    return db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]?.status ?? null);
  }

  it("loses a timer claim when another scheduler advances the heartbeat baseline", async () => {
    const { agentId } = await seedAgent();
    const now = new Date();
    await db.update(agents).set({
      createdAt: new Date(now.getTime() - 120_000),
      lastHeartbeatAt: null,
    }).where(eq(agents.id, agentId));
    const heartbeat = heartbeatService(db, {
      testHooks: {
        beforeTimerHeartbeatClaimCas: async () => {
          await db.update(agents).set({ lastHeartbeatAt: now }).where(eq(agents.id, agentId));
        },
      },
    });

    await expect(heartbeat.tickTimers(now)).resolves.toMatchObject({ checked: 1, enqueued: 0 });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("covers queued-run missing-agent, invokability, budget, hold, and claim races", async () => {
    let virtualNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => virtualNow);
    const missingFixture = await seedAgent();
    const missingRun = await seedQueuedRun(missingFixture);

    const pausedFixture = await seedAgent();
    const pausedRun = await seedQueuedRun(pausedFixture);

    const budgetFixture = await seedAgent();
    const budgetRun = await seedQueuedRun(budgetFixture);
    await db.insert(budgetPolicies).values({
      companyId: budgetFixture.companyId,
      scopeType: "agent",
      scopeId: budgetFixture.agentId,
      windowKind: "monthly",
      metric: "billed_cents",
      amount: 1,
      hardStopEnabled: true,
      isActive: true,
    });
    await db.insert(costEvents).values({
      companyId: budgetFixture.companyId,
      agentId: budgetFixture.agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test-model",
      inputTokens: 1,
      outputTokens: 1,
      costCents: 1,
      occurredAt: new Date(),
    });

    const holdFixture = await seedAgent();
    const holdIssueId = await seedIssue(holdFixture.companyId, holdFixture.agentId);
    const holdRun = await seedQueuedRun({ ...holdFixture, issueId: holdIssueId });
    await db.insert(issueTreeHolds).values({
      companyId: holdFixture.companyId,
      rootIssueId: holdIssueId,
      mode: "pause",
      status: "active",
      reason: "race seam hold",
      releasePolicy: { strategy: "manual" },
    });

    const claimFixture = await seedAgent();
    const claimRun = await seedQueuedRun(claimFixture);
    const heartbeat = heartbeatService(db, {
      testHooks: {
        beforeQueuedRunAgentRead: async ({ run }) => {
          virtualNow += 31_000;
          if (run.id === pausedRun.runId) {
            await db.update(agents).set({ status: "paused" }).where(eq(agents.id, pausedFixture.agentId));
          }
        },
        queuedRunAgentRead: ({ run }) => run.id === missingRun.runId ? null : undefined,
        beforeQueuedRunClaimCas: async ({ run }) => {
          await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
        },
      },
    });

    await heartbeat.resumeQueuedRuns();

    expect(await runStatus(missingRun.runId)).toBe("cancelled");
    expect(await runStatus(pausedRun.runId)).toBe("cancelled");
    expect(await runStatus(budgetRun.runId)).toBe("cancelled");
    expect(await runStatus(holdRun.runId)).toBe("cancelled");
    expect(await runStatus(claimRun.runId)).toBe("cancelled");
  }, 30_000);

  it("contains daily-cap, blocked-dependency, and stale-issue cancellation races", async () => {
    const dailyFixture = await seedAgent({ heartbeat: { maxDailyCostCents: 1 } });
    const dailyRun = await seedQueuedRun(dailyFixture);
    await db.insert(costEvents).values({
      companyId: dailyFixture.companyId,
      agentId: dailyFixture.agentId,
      provider: "test",
      biller: "test",
      billingType: "metered_api",
      model: "test",
      inputTokens: 1,
      outputTokens: 1,
      costCents: 1,
      occurredAt: new Date(),
    });

    const blockedFixture = await seedAgent();
    const blockerId = await seedIssue(blockedFixture.companyId, blockedFixture.agentId, { assigneeAgentId: null });
    const blockedIssueId = await seedIssue(blockedFixture.companyId, blockedFixture.agentId);
    const blockedRun = await seedQueuedRun({ ...blockedFixture, issueId: blockedIssueId });
    await db.insert(issueRelations).values({
      companyId: blockedFixture.companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const staleFixture = await seedAgent();
    const replacementAgentId = randomUUID();
    await db.insert(agents).values({
      id: replacementAgentId,
      companyId: staleFixture.companyId,
      name: "ReplacementAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const staleIssueId = await seedIssue(staleFixture.companyId, staleFixture.agentId, {
      assigneeAgentId: replacementAgentId,
    });
    const staleRun = await seedQueuedRun({ ...staleFixture, issueId: staleIssueId });

    const heartbeat = heartbeatService(db, {
      testHooks: {
        beforeDailyCapCancellationCas: async ({ runId }) => {
          await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, dailyRun.wakeupRequestId));
          await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        },
        beforeBlockedDependencyCancellationCas: async ({ runId }) => {
          await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, blockedRun.wakeupRequestId));
          await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        },
        beforeStaleIssueCancellationCas: async ({ runId }) => {
          await db.update(agentWakeupRequests).set({ runId: null }).where(eq(agentWakeupRequests.id, staleRun.wakeupRequestId));
          await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        },
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(dailyRun.runId)).toBeNull();
    expect(await runStatus(blockedRun.runId)).toBeNull();
    expect(await runStatus(staleRun.runId)).toBeNull();
  }, 15_000);

  it("contains scheduled-retry cancellation and missing-agent races", async () => {
    const gateFixture = await seedAgent({ status: "paused" });
    const gateRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: gateRunId,
      companyId: gateFixture.companyId,
      agentId: gateFixture.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: new Date(),
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {},
    });

    const missingFixture = await seedAgent();
    const missingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: missingRunId,
      companyId: missingFixture.companyId,
      agentId: missingFixture.agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      scheduledRetryAt: new Date(),
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {},
    });

    const heartbeat = heartbeatService(db, {
      testHooks: {
        beforeScheduledRetryCancellationCas: async ({ runId }) => {
          if (runId === gateRunId) {
            await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
          }
        },
        beforeDueScheduledRetryPromotion: async ({ run }) => {
          if (run.id === missingRunId) {
            await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
            await db.delete(agents).where(eq(agents.id, run.agentId));
          }
        },
      },
    });

    await expect(heartbeat.promoteDueScheduledRetries(new Date())).resolves.toEqual({ promoted: 0, runIds: [] });
    expect(await runStatus(gateRunId)).toBe("succeeded");
    expect(await runStatus(missingRunId)).toBeNull();
  });

  it("surfaces a runtime-state conflict whose winning row disappears", async () => {
    const fixture = await seedAgent();
    const queued = await seedQueuedRun(fixture);
    const heartbeat = heartbeatService(db, {
      testHooks: {
        beforeRuntimeStateInsert: async ({ agent }) => {
          await db.insert(agentRuntimeState).values({
            agentId: agent.id,
            companyId: agent.companyId,
            adapterType: agent.adapterType,
            stateJson: {},
          });
        },
        beforeRuntimeStateFallbackRead: async ({ agentId }) => {
          await db.delete(agentRuntimeState).where(eq(agentRuntimeState.agentId, agentId));
        },
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queued.runId)).toBe("failed");
  });

  it("contains a non-retryable plan-approval escalation failure", async () => {
    const fixture = await seedAgent();
    const issueId = await seedIssue(fixture.companyId, fixture.agentId, { status: "in_review" });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId: fixture.companyId,
      issueId,
      kind: "request_confirmation",
      status: "accepted",
      continuationPolicy: "wake_assignee_on_accept",
      createdByAgentId: fixture.agentId,
      payload: {
        version: 1,
        prompt: "Approve?",
        target: { type: "issue_document", issueId, key: "plan", revisionId: randomUUID() },
      },
      result: { version: 1, outcome: "accepted" },
    });
    const queued = await seedQueuedRun({
      ...fixture,
      issueId,
      context: {
        wakeReason: "issue_commented",
        mutation: "interaction",
        interactionId,
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });
    mockAdapterExecute.mockRejectedValueOnce(new Error("non-retryable configuration failure"));
    const escalatedRuns: string[] = [];
    const heartbeat = heartbeatService(db, {
      escalatePlanApprovalResumeFailure: async ({ run }) => {
        escalatedRuns.push(run.id);
        throw new Error("synthetic non-retryable escalation failure");
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queued.runId)).toBe("failed");
    expect(escalatedRuns).toEqual([queued.runId]);
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON)),
    ).toHaveLength(0);
  });

  it("keeps a successful run authoritative when final agent lookup disappears", async () => {
    const fixture = await seedAgent();
    const queued = await seedQueuedRun(fixture);
    const heartbeat = heartbeatService(db, {
      testHooks: {
        finalizeAgentRead: () => null,
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    expect(await runStatus(queued.runId)).toBe("succeeded");
  });
});
