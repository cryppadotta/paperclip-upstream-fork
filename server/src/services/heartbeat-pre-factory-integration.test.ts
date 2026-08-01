import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildProjectMentionHref, buildSkillMentionHref } from "@paperclipai/shared";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRuns,
  issues,
  projects,
  projectWorkspaces,
  toolMcpGateways,
  toolProfiles,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "../__tests__/helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.ts";
import { heartbeatService } from "./heartbeat.ts";
import { instanceSettingsService } from "./instance-settings.ts";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const adapterType = "codex_local";
const workspaceAdapterType = "heartbeat_workspace_coverage";
const execFile = promisify(execFileCallback);

async function waitForRun(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId, { unsafeFullResultJson: true });
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId, { unsafeFullResultJson: true });
}

describePostgres("heartbeat pre-factory integration coverage", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let paperclipHome: string;
  let previousHome: string | undefined;
  let executionCount = 0;
  let executionDelayMs = 0;
  let removeWorktreeGitMetadata = false;
  const capturedConfigs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("heartbeat-pre-factory-");
    db = createDb(database.connectionString);
    paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-pre-factory-home-"));
    previousHome = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = paperclipHome;
    const execute = async (context: AdapterExecutionContext) => {
        executionCount += 1;
        capturedConfigs.push(context.config);
        if (removeWorktreeGitMetadata) {
          const workspace = context.context.paperclipWorkspace as { cwd?: string } | undefined;
          if (workspace?.cwd) await fs.rm(path.join(workspace.cwd, ".git"), { force: true });
        }
        await context.onEvent?.({ eventType: "tool.started", payload: { toolName: " shell " } });
        await context.onEvent?.({ eventType: "fallback_tool_event", payload: {} });
        await context.onEvent?.({ eventType: "assistant.delta", payload: { text: " assistant update " } });
        await context.onEvent?.({ eventType: "message_delta", message: "message update", payload: {} });
        await context.onEvent?.({ eventType: ".", message: "", payload: {} });
        if (executionDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, executionDelayMs));
        }
        if (context.agent.name === "Provider Quota Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "provider_quota",
            errorFamily: "provider_quota" as const,
            retryNotBefore: "2026-08-02T00:00:00.000Z",
            errorMessage: "quota exhausted",
          };
        }
        if (context.agent.name === "Custom Failure Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "custom_failure",
            errorMessage: "ordinary failure",
          };
        }
        if (context.agent.name === "Interaction Failure Agent") {
          return {
            exitCode: 1,
            signal: null,
            timedOut: false,
            errorCode: "adapter_failed",
            errorMessage: "ordinary failure",
          };
        }
        if (context.agent.name === "Error Only Agent") {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: "error_only", errorMessage: null };
        }
        if (context.agent.name === "Summary Only Agent") {
          return { exitCode: 1, signal: null, timedOut: false, errorCode: null, errorMessage: "summary only" };
        }
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "coverage-session",
          sessionDisplayId: "coverage-session",
          usage: executionCount === 8
            ? undefined
            : executionCount === 9
              ? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
              : {
                  inputTokens: executionCount * 10,
                  cachedInputTokens: executionCount * 2,
                  outputTokens: executionCount * 3,
                },
          usageBasis: "session_cumulative",
          provider: "coverage",
          model: "coverage-model",
          billingType: (["api", "subscription", "subscription_overage", "credits", "fixed"] as const)[
            (executionCount - 1) % 5
          ],
          costUsd: 1.23,
          resultJson: { summary: `run ${executionCount}` },
        };
    };
    const testEnvironment = async () => ({
      adapterType,
      status: "pass" as const,
      checks: [],
      testedAt: new Date().toISOString(),
    });
    registerServerAdapter({
      type: adapterType,
      execute,
      testEnvironment,
    });
    registerServerAdapter({
      type: workspaceAdapterType,
      execute,
      testEnvironment: async () => ({
        adapterType: workspaceAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    unregisterServerAdapter(adapterType);
    unregisterServerAdapter(workspaceAdapterType);
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = previousHome;
    await fs.rm(paperclipHome, { recursive: true, force: true });
    await database.cleanup();
  });

  it("resolves mentioned skills, snapshots config, and deltas cumulative session usage", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const projectId = randomUUID();
    const otherProjectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const skillId = randomUUID();
    const skillDir = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-mentioned-skill-"));
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# Mentioned skill\n", "utf8");
    await execFile("git", ["init", skillDir]);

    await db.insert(companies).values({
      id: companyId,
      name: "Coverage Company",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Coverage Project",
      status: "active",
    });
    await db.insert(projects).values({
      id: otherProjectId,
      companyId,
      name: "Other Coverage Project",
      status: "active",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Managed primary",
      cwd: skillDir,
      repoUrl: null,
      isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {
        model: "coverage-model",
        env: { OPENAI_API_KEY: "test-api-key" },
        workspaceStrategy: { provisionCommand: "echo provision", teardownCommand: "echo teardown" },
        workspaceRuntime: { command: "echo runtime" },
        desiredState: "manual",
        serviceStates: { api: "running", ignored: "invalid" },
      },
      runtimeConfig: {
        heartbeat: {
          sessionCompaction: {
            enabled: true,
            maxSessionRuns: 0,
            maxRawInputTokens: 1,
            maxSessionAgeHours: 0,
          },
        },
      },
      permissions: {},
    });
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId,
      companyId,
      name: "Other Coverage Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(companySkills).values({
      id: skillId,
      companyId,
      key: `company/${companyId}/mentioned-skill`,
      slug: "mentioned-skill",
      name: "Mentioned skill",
      markdown: "# Mentioned skill\n",
      sourceType: "local_path",
      sourceLocator: skillDir,
      trustLevel: "markdown_only",
      compatibility: "compatible",
      fileInventory: [{ path: "SKILL.md", kind: "skill" }],
      metadata: { sourceKind: "local_path" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: `Use [/mentioned-skill](${buildSkillMentionHref(skillId, "mentioned-skill")})`,
      description: "Exercise the helper path",
      status: "todo",
      priority: "medium",
      projectId,
      projectWorkspaceId,
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "COV-1",
    });
    const otherIssueId = randomUUID();
    await db.insert(issues).values({
      id: otherIssueId,
      companyId,
      title: "Other issue",
      status: "todo",
      priority: "medium",
      projectId,
      assigneeAgentId: otherAgentId,
      issueNumber: 2,
      identifier: "COV-2",
    });
    const [gatewayProfile] = await db.insert(toolProfiles).values({
      companyId,
      profileKey: "coverage-gateway",
      name: "Coverage gateway",
      defaultAction: "deny",
    }).returning();
    await db.insert(toolMcpGateways).values([
      {
        companyId,
        name: "Wrong issue gateway",
        slug: "wrong-issue-gateway",
        profileId: gatewayProfile!.id,
        contextScopeType: "issue",
        contextScopeId: randomUUID(),
      },
      {
        companyId,
        name: "Wrong issue field gateway",
        slug: "wrong-issue-field-gateway",
        profileId: gatewayProfile!.id,
        issueId: otherIssueId,
      },
      {
        companyId,
        name: "Applicable gateway",
        slug: "applicable-gateway",
        profileId: gatewayProfile!.id,
      },
      {
        companyId,
        name: "Wrong agent gateway",
        slug: "wrong-agent-gateway",
        profileId: gatewayProfile!.id,
        agentId: otherAgentId,
      },
      {
        companyId,
        name: "Wrong project gateway",
        slug: "wrong-project-gateway",
        profileId: gatewayProfile!.id,
        projectId: otherProjectId,
      },
      {
        companyId,
        name: "Wrong agent scope gateway",
        slug: "wrong-agent-scope-gateway",
        profileId: gatewayProfile!.id,
        contextScopeType: "agent",
        contextScopeId: randomUUID(),
      },
      {
        companyId,
        name: "Wrong project scope gateway",
        slug: "wrong-project-scope-gateway",
        profileId: gatewayProfile!.id,
        contextScopeType: "project",
        contextScopeId: randomUUID(),
      },
    ]);

    const heartbeat = heartbeatService(db);
    const first = await heartbeat.invoke(agentId, "assignment", {
      issueId,
      wakeReason: "issue_assigned",
    }, "system");
    expect(first).not.toBeNull();
    expect((await waitForRun(heartbeat, first!.id))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(first!.id);

    await db.update(agents).set({
      adapterConfig: {
        env: { OPENAI_API_KEY: "test-api-key" },
        managedMcpOnly: false,
      },
    }).where(eq(agents.id, agentId));

    const secondHeartbeat = heartbeatService(db);
    const second = await secondHeartbeat.invoke(agentId, "on_demand", {
      issueId,
      wakeReason: "issue_commented",
    }, "manual");
    expect(second).not.toBeNull();
    const completed = await waitForRun(secondHeartbeat, second!.id);
    expect(completed?.status).toBe("succeeded");
    expect(completed?.usageJson).toMatchObject({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      rawInputTokens: 20,
      usageSource: "session_delta",
    });
    expect(capturedConfigs.some((config) =>
      JSON.stringify(config).includes(`company/${companyId}/mentioned-skill`))).toBe(true);
    await secondHeartbeat.waitForRunExecutionDrain(second!.id);

    const payloadWake = await secondHeartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId, commentId: randomUUID() },
      contextSnapshot: {},
    });
    expect(payloadWake).not.toBeNull();
    await waitForRun(secondHeartbeat, payloadWake!.id);
    await secondHeartbeat.waitForRunExecutionDrain(payloadWake!.id);

    const acceptedWithoutIssue = await secondHeartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { mutation: "interaction" },
      contextSnapshot: {
        interactionId: randomUUID(),
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
      },
    });
    expect(acceptedWithoutIssue).not.toBeNull();
    await waitForRun(secondHeartbeat, acceptedWithoutIssue!.id);
    await secondHeartbeat.waitForRunExecutionDrain(acceptedWithoutIssue!.id);

    await fs.rm(skillDir, { recursive: true, force: true });
  }, 30_000);

  it("creates an empty managed primary workspace for a project without a checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const mentionedProjectId = randomUUID();
    const cloneProjectId = randomUUID();
    const populatedManagedProjectId = randomUUID();
    const unreadableManagedProjectId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Managed Workspace Company",
      issuePrefix: `W${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Managed project", status: "active" });
    await db.insert(projects).values({
      id: mentionedProjectId,
      companyId,
      name: "Mentioned project",
      status: "active",
    });
    await db.insert(projects).values([
      { id: cloneProjectId, companyId, name: "Clone project", status: "active" },
      { id: populatedManagedProjectId, companyId, name: "Populated managed project", status: "active" },
      { id: unreadableManagedProjectId, companyId, name: "Unreadable managed project", status: "active" },
    ]);
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Managed primary",
      cwd: null,
      repoUrl: null,
      isPrimary: true,
    });
    const referencedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-referenced-workspace-"));
    const missingCwd = path.join(referencedRoot, "missing");
    const unreadableCwd = path.join(referencedRoot, "unreadable");
    const populatedCwd = path.join(referencedRoot, "populated");
    await fs.mkdir(unreadableCwd);
    await fs.chmod(unreadableCwd, 0o000);
    await fs.mkdir(populatedCwd);
    await fs.writeFile(path.join(populatedCwd, "README.md"), "content\n", "utf8");
    const cloneSource = path.join(referencedRoot, "clone-source");
    await fs.mkdir(cloneSource);
    await execFile("git", ["init", cloneSource]);
    const cloneRepoUrl = `file://${cloneSource}`;
    const populatedManagedCwd = resolveManagedProjectWorkspaceDir({
      companyId,
      projectId: populatedManagedProjectId,
      repoName: null,
    });
    await fs.mkdir(populatedManagedCwd, { recursive: true });
    await fs.writeFile(path.join(populatedManagedCwd, "README.md"), "occupied\n", "utf8");
    const unreadableManagedCwd = resolveManagedProjectWorkspaceDir({
      companyId,
      projectId: unreadableManagedProjectId,
      repoName: "missing-unreadable",
    });
    await fs.mkdir(unreadableManagedCwd, { recursive: true });
    await fs.chmod(unreadableManagedCwd, 0o000);
    await db.insert(projectWorkspaces).values([
      {
        companyId,
        projectId: mentionedProjectId,
        name: "Missing",
        cwd: missingCwd,
        isPrimary: true,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
      },
      {
        companyId,
        projectId: mentionedProjectId,
        name: "Unreadable",
        cwd: unreadableCwd,
        isPrimary: false,
        createdAt: new Date("2026-08-01T00:00:01.000Z"),
      },
      {
        companyId,
        projectId: mentionedProjectId,
        name: "Populated",
        cwd: populatedCwd,
        isPrimary: false,
        createdAt: new Date("2026-08-01T00:00:02.000Z"),
      },
      {
        companyId,
        projectId: cloneProjectId,
        name: "Clone on demand",
        cwd: null,
        repoUrl: cloneRepoUrl,
        isPrimary: true,
      },
      {
        companyId,
        projectId: populatedManagedProjectId,
        name: "Occupied managed path",
        cwd: null,
        repoUrl: "not a valid repository URL",
        isPrimary: true,
      },
      {
        companyId,
        projectId: unreadableManagedProjectId,
        name: "Unreadable managed path",
        cwd: null,
        repoUrl: "file:///definitely/missing-unreadable.git",
        isPrimary: true,
      },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Workspace Agent",
      role: "engineer",
      status: "idle",
      adapterType: workspaceAdapterType,
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Create managed workspaces",
      description: [
        `Create managed workspace with [reference](${buildProjectMentionHref(mentionedProjectId)})`,
        `[clone](${buildProjectMentionHref(cloneProjectId)})`,
        `[occupied](${buildProjectMentionHref(populatedManagedProjectId)})`,
        `[unreadable](${buildProjectMentionHref(unreadableManagedProjectId)})`,
      ].join(" "),
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: "WM-1",
    });

    const heartbeat = heartbeatService(db);
    executionDelayMs = 300;
    const run = await heartbeat.invoke(agentId, "assignment", { issueId, wakeReason: "issue_assigned" }, "system");
    expect(run).not.toBeNull();
    const runningDeadline = Date.now() + 5_000;
    while (Date.now() < runningDeadline) {
      if ((await heartbeat.getRun(run!.id))?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const coalesced = await heartbeat.invoke(
      agentId,
      "assignment",
      { issueId, wakeReason: "issue_assigned" },
      "system",
    );
    expect(coalesced?.id).toBe(run!.id);
    expect((await waitForRun(heartbeat, run!.id))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(run!.id);
    executionDelayMs = 300;
    const unscoped = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: "unscoped-coverage", wakeReason: "manual" },
      "manual",
    );
    expect(unscoped).not.toBeNull();
    const unscopedDeadline = Date.now() + 5_000;
    while (Date.now() < unscopedDeadline) {
      if ((await heartbeat.getRun(unscoped!.id))?.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const unscopedCoalesced = await heartbeat.invoke(
      agentId,
      "on_demand",
      { taskKey: "unscoped-coverage", wakeReason: "manual" },
      "manual",
    );
    expect(unscopedCoalesced?.id).toBe(unscoped!.id);
    expect((await waitForRun(heartbeat, unscoped!.id))?.status).toBe("succeeded");
    await heartbeat.waitForRunExecutionDrain(unscoped!.id);
    executionDelayMs = 0;
    for (let index = 0; index < 6; index += 1) {
      const extra = await heartbeat.invoke(
        agentId,
        "on_demand",
        { taskKey: "billing-coverage", wakeReason: "manual" },
        "manual",
      );
      expect(extra).not.toBeNull();
      expect((await waitForRun(heartbeat, extra!.id))?.status).toBe("succeeded");
      await heartbeat.waitForRunExecutionDrain(extra!.id);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await fs.chmod(unreadableCwd, 0o700);
    await fs.chmod(unreadableManagedCwd, 0o700).catch(() => undefined);
    await fs.rm(referencedRoot, { recursive: true, force: true });
    executionDelayMs = 0;
  }, 30_000);

  it("fingerprints an unrecoverable final workspace branch inspection", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const issueId = randomUUID();
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "heartbeat-finalize-fingerprint-"));
    await execFile("git", ["init", repoRoot]);
    await execFile("git", ["config", "user.email", "coverage@example.test"], { cwd: repoRoot });
    await execFile("git", ["config", "user.name", "Coverage"], { cwd: repoRoot });
    await fs.writeFile(path.join(repoRoot, "README.md"), "coverage\n", "utf8");
    await execFile("git", ["add", "README.md"], { cwd: repoRoot });
    await execFile("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    await db.insert(companies).values({
      id: companyId, name: "Fingerprint Company", issuePrefix: "FPR", requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Fingerprint Project", status: "active" });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId, companyId, projectId, name: "Primary", cwd: repoRoot, isPrimary: true,
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Fingerprint Agent", role: "engineer", status: "idle", adapterType,
      adapterConfig: { workspaceStrategy: { type: "git_worktree" } }, runtimeConfig: {}, permissions: {},
    });
    await db.insert(issues).values({
      id: issueId, companyId, projectId, projectWorkspaceId, title: "Break final branch inspection",
      status: "in_progress", priority: "medium", assigneeAgentId: agentId, issueNumber: 1, identifier: "FPR-1",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    removeWorktreeGitMetadata = true;
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", {
      issueId, wakeReason: "issue_commented", skipIssueComment: true,
    }, "manual");
    expect(run).not.toBeNull();
    const completed = await waitForRun(heartbeat, run!.id);
    expect(completed?.status).toBe("failed");
    expect(JSON.stringify(completed?.resultJson)).toContain("workspace_finalize_branch_mismatch:v1:sha256:");
    await heartbeat.waitForRunExecutionDrain(run!.id);
    removeWorktreeGitMetadata = false;
    await fs.rm(repoRoot, { recursive: true, force: true });
  }, 30_000);

  it("reaps detached local processes across liveness error variants", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Reaper Company", issuePrefix: "RPR", requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Reaper Agent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const now = new Date("2026-08-01T00:00:00.000Z");
    const seeded = await db.insert(heartbeatRuns).values([
      {
        companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
        processPid: 4242, processLossRetryCount: 1, startedAt: now,
      },
      {
        companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
        processPid: 4243, processLossRetryCount: 1, startedAt: now,
      },
      {
        companyId, agentId, invocationSource: "on_demand", triggerDetail: "manual", status: "running",
        processGroupId: 4244, processLossRetryCount: 1, startedAt: now,
      },
    ]).returning();
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      const error = new Error("not alive") as NodeJS.ErrnoException;
      error.code = pid === 4242 ? "EPERM" : "EACCES";
      throw error;
    });
    const heartbeat = heartbeatService(db);
    const reaped = await heartbeat.reapOrphanedRuns(new Date("2026-08-01T00:01:00.000Z"), 0);
    expect(reaped.runIds).toEqual(expect.arrayContaining([seeded[1]!.id, seeded[2]!.id]));
    expect(reaped.runIds).not.toContain(seeded[0]!.id);
    kill.mockRestore();
  }, 20_000);

  it("classifies quota and interaction-continuation failure recovery", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Recovery Company", issuePrefix: "RCV", requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    const cases = [
      { name: "Provider Quota Agent", interactionStatus: "accepted" },
      { name: "Custom Failure Agent", interactionStatus: "pending" },
      { name: "Interaction Failure Agent", interactionStatus: "accepted" },
      { name: "Error Only Agent", interactionStatus: "pending" },
      { name: "Summary Only Agent", interactionStatus: "pending" },
    ];
    const heartbeat = heartbeatService(db);
    for (const [index, item] of cases.entries()) {
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(agents).values({
        id: agentId, companyId, name: item.name, role: "engineer", status: "idle",
        adapterType: workspaceAdapterType,
        adapterConfig: {},
        runtimeConfig: item.name === "Custom Failure Agent"
          ? { heartbeat: { maxConcurrentRuns: "Infinity" } }
          : {},
        permissions: {},
      });
      await db.insert(issues).values({
        id: issueId, companyId, title: `${item.name} issue`, status: "in_progress", priority: "medium",
        assigneeAgentId: agentId, issueNumber: index + 1, identifier: `RCV-${index + 1}`,
      });
      const run = await heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_commented",
        payload: { issueId, mutation: "interaction" },
        contextSnapshot: {
          issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionStatus: item.interactionStatus,
          retryReason: "issue_continuation_needed",
        },
      });
      expect(run).not.toBeNull();
      expect((await waitForRun(heartbeat, run!.id))?.status).toBe("failed");
      await heartbeat.waitForRunExecutionDrain(run!.id);
      if (item.name === "Provider Quota Agent") {
        await expect(heartbeat.scheduleBoundedRetry(run!.id, { delayMs: 60_000 }))
          .resolves.toMatchObject({ outcome: "scheduled" });
      }
    }
  }, 30_000);
});
