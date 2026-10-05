import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, companyMemberships, createDb, principalPermissionGrants } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { authorizationService } from "../services/authorization.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("new agent configuration defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("agent-configure-defaults");
    db = createDb(started.connectionString);
    cleanup = started.cleanup;
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  it("grants standard new agents direct peer configuration, but keeps restricted agents narrow", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent permission defaults",
      issuePrefix: `PD${companyId.slice(0, 6).toUpperCase()}`,
    });
    const create = (name: string, permissions: Record<string, unknown> = {}, metadata?: Record<string, unknown>) =>
      agentService(db).create(companyId, {
        name,
        role: "engineer",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions,
        metadata,
      }, metadata ? { allowBuiltInAgentMetadata: true } : undefined);

    const standard = await create("Standard");
    const peer = await create("Peer");
    const lowTrust = await create("Low trust", { trustPreset: LOW_TRUST_REVIEW_PRESET });
    const bundled = await create("Bundled", {}, {
      paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] },
    });

    const grants = await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId));
    expect(grants.filter((grant) => grant.permissionKey === "agents:configure")
      .map((grant) => grant.principalId).sort()).toEqual([standard.id, peer.id].sort());

    await db.insert(companyMemberships).values({
      companyId,
      principalType: "agent",
      principalId: standard.id,
      status: "active",
      membershipRole: "member",
    });

    const decision = await authorizationService(db).decide({
      actor: { type: "agent", agentId: standard.id, companyId, source: "agent_key" },
      action: "agent_config:update",
      resource: { type: "agent", agentId: peer.id, companyId },
      scope: { requiresChangeGrant: true },
    });
    expect(decision).toMatchObject({ allowed: true, reason: "allow_direct_change" });

    await agentService(db).remove(peer.id);
    expect(await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.principalId, peer.id))).toEqual([]);

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(companyMemberships).where(eq(companyMemberships.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("backfills existing standard agents once without widening restricted or scoped grants", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Existing permission defaults",
      issuePrefix: `PE${companyId.slice(0, 6).toUpperCase()}`,
    });
    const rows = await db.insert(agents).values([
      { companyId, name: "Existing", role: "engineer", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Scoped", role: "engineer", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Restricted", role: "engineer", permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET }, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Built in", role: "engineer", metadata: { paperclipBuiltInAgent: { key: "reflection-coach", featureKeys: [] } }, permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
      { companyId, name: "Pending", role: "engineer", status: "pending_approval", permissions: {}, adapterType: "process", adapterConfig: {}, runtimeConfig: {} },
    ]).returning();
    await db.insert(principalPermissionGrants).values({
      companyId,
      principalType: "agent",
      principalId: rows[1]!.id,
      permissionKey: "agents:configure",
      scope: { agentIds: [rows[0]!.id] },
    });

    const migration = readFileSync(new URL("../../../packages/db/src/migrations/0297_agent_configure_default_grants.sql", import.meta.url), "utf8");
    await db.execute(sql.raw(migration));
    await db.execute(sql.raw(migration));
    const grants = await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId));
    expect(grants.map((grant) => grant.principalId).sort()).toEqual([rows[0]!.id, rows[1]!.id].sort());
    expect(grants.find((grant) => grant.principalId === rows[1]!.id)?.scope).toEqual({ agentIds: [rows[0]!.id] });

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });

  it("adds the default grant when a standard pending hire is approved", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Pending permission default",
      issuePrefix: `PP${companyId.slice(0, 6).toUpperCase()}`,
    });
    const pending = await agentService(db).create(companyId, {
      name: "Pending hire",
      status: "pending_approval",
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
    });
    expect(await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId))).toEqual([]);

    const result = await agentService(db).activatePendingApproval(pending.id);
    expect(result?.activated).toBe(true);
    expect(await db.select().from(principalPermissionGrants)
      .where(eq(principalPermissionGrants.companyId, companyId)))
      .toEqual([expect.objectContaining({ principalId: pending.id, permissionKey: "agents:configure" })]);

    await db.delete(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
    await db.delete(agents).where(eq(agents.companyId, companyId));
    await db.delete(companies).where(eq(companies.id, companyId));
  });
});
