import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  agents, authUsers, companyMemberships, createDb, instanceSettings,
  instanceUserRoles, principalPermissionGrants, resourceLifecycleEvents, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "./auth.js";
import { errorHandler } from "./error-handler.js";
import { userProfileRoutes } from "../routes/user-profiles.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("Cloud membership synchronization with PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const clients: Db[] = [];

  function freshDb() {
    const client = createDb(database.connectionString);
    clients.push(client);
    return client;
  }

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cloud-membership-sync-");
    db = freshDb();
    // Count actual tuple changes, including updates whose values are unchanged.
    await db.execute(sql`create table cloud_sync_write_probe (relation text, operation text)`);
    await db.execute(sql`create function cloud_sync_probe() returns trigger language plpgsql as $$
      begin insert into cloud_sync_write_probe values (TG_TABLE_NAME, TG_OP); return NEW; end $$`);
    await db.execute(sql`create trigger cloud_sync_probe after insert or update on company_memberships
      for each row execute function cloud_sync_probe()`);
    await db.execute(sql`create trigger cloud_sync_probe after insert or update on "user"
      for each row execute function cloud_sync_probe()`);
  }, 90_000);
  afterAll(async () => {
    await Promise.all(clients.map(client => client.$client.end({ timeout: 0 })));
    await database?.cleanup();
  }, 60_000);
  beforeEach(() => {
    process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN = "synthetic-cloud-sync-token";
  });
  afterEach(() => {
    delete process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN;
    delete process.env.PAPERCLIP_MANAGED_CONFIG;
  });

  function headers(userId = randomUUID(), role = "owner", stackId = `stack-${randomUUID()}`) {
    return {
      "x-paperclip-cloud-tenant-token": "synthetic-cloud-sync-token",
      "x-paperclip-cloud-user-id": userId,
      "x-paperclip-cloud-user-email": `${userId}@example.test`,
      "x-paperclip-cloud-stack-id": stackId,
      "x-paperclip-cloud-stack-role": role,
    };
  }

  function resolve(client: Db, value: Record<string, string>) {
    return resolveCloudTenantActor(client, cloudActorHeaderSourceFromHeaders(value));
  }

  it("does not update unchanged tuples, returns the input role on an empty RETURNING result, and repairs missing grants", async () => {
    const value = headers();
    const actor = await resolve(db, value);
    const companyId = actor!.companyIds![0]!;
    const userId = value["x-paperclip-cloud-user-id"];
    const membershipWhere = and(eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId));
    const oldUpdatedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(authUsers).set({ updatedAt: oldUpdatedAt }).where(eq(authUsers.id, userId));
    await db.update(companyMemberships).set({ updatedAt: oldUpdatedAt }).where(membershipWhere);
    const [beforeUser] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    const [beforeMembership] = await db.select().from(companyMemberships).where(membershipWhere);
    await db.delete(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, userId)));
    await db.execute(sql`truncate cloud_sync_write_probe`);
    const second = await resolve(freshDb(), value); // bypass process-local debounce
    expect(second?.memberships?.[0]).toEqual({ companyId, membershipRole: "owner", status: "active" });
    expect(await db.select().from(authUsers).where(eq(authUsers.id, userId))).toEqual([beforeUser]);
    expect(await db.select().from(companyMemberships).where(membershipWhere)).toEqual([beforeMembership]);
    expect(await db.execute(sql`select * from cloud_sync_write_probe`)).toEqual([]);
    expect((await db.select().from(principalPermissionGrants).where(and(eq(principalPermissionGrants.companyId, companyId), eq(principalPermissionGrants.principalId, userId)))).length).toBeGreaterThan(0);
    await resolve(freshDb(), { ...value, "x-paperclip-cloud-user-name": "Changed profile", "x-paperclip-cloud-stack-role": "member" });
    const [changedUser] = await db.select().from(authUsers).where(eq(authUsers.id, userId));
    const [changedMembership] = await db.select().from(companyMemberships).where(membershipWhere);
    expect(changedUser.name).toBe("Changed profile");
    expect(changedUser.updatedAt.getTime()).toBeGreaterThan(oldUpdatedAt.getTime());
    expect(changedMembership.membershipRole).toBe("member");
    expect(changedMembership.updatedAt.getTime()).toBeGreaterThan(oldUpdatedAt.getTime());
  });

  it("preserves runtime invalidation on real membership changes while no-op conflicts produce no invalidation", async () => {
    const value = headers();
    const actor = await resolve(db, value);
    const companyId = actor!.companyIds![0]!;
    await db.insert(agents).values({ companyId, name: "Synthetic sync observer", adapterType: "codex_local" });
    await db.delete(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, companyId));
    await resolve(freshDb(), value);
    expect(await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, companyId))).toEqual([]);
    const demoted = await resolve(db, { ...value, "x-paperclip-cloud-stack-role": "member" });
    expect(demoted?.memberships?.[0]?.membershipRole).toBe("member");
    const events = await db.select().from(resourceLifecycleEvents).where(eq(resourceLifecycleEvents.companyId, companyId));
    expect(events.some(event => event.resourceType === "agent_runtime" && event.action === "update")).toBe(true);
  });

  it("rechecks imported memberships, stale admin rows and the owner flag inside the write debounce", async () => {
    const value = headers();
    const actor = await resolve(db, value);
    const userId = value["x-paperclip-cloud-user-id"];
    const imported = await resolve(db, headers(userId, "member"));
    const importedCompanyId = imported!.companyIds![0]!;
    await resolve(db, value);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await db.update(companyMemberships).set({ status: "inactive" }).where(and(eq(companyMemberships.companyId, importedCompanyId), eq(companyMemberships.principalId, userId)));
    await db.insert(instanceSettings).values({ singletonKey: "default", experimental: { enableOwnerInstanceAdmin: true } })
      .onConflictDoUpdate({ target: instanceSettings.singletonKey, set: { experimental: { enableOwnerInstanceAdmin: true } } });
    const elevated = await resolve(db, value);
    expect(elevated?.isInstanceAdmin).toBe(true);
    expect(elevated?.companyIds).toEqual(actor!.companyIds);
    expect(await db.select().from(instanceUserRoles).where(eq(instanceUserRoles.userId, userId))).toEqual([]);
    await db.update(instanceSettings).set({ experimental: { enableOwnerInstanceAdmin: false } });
    expect((await resolve(db, value))?.isInstanceAdmin).toBe(false);
  });

  it("keeps an unchanged Cloud user's profile reachable beyond the first membership page", async () => {
    const value = headers();
    const first = await resolve(db, value);
    const companyId = first!.companyIds![0]!;
    const userId = value["x-paperclip-cloud-user-id"];
    const oldUpdatedAt = new Date("2020-01-01T00:00:00Z");
    await db.update(companyMemberships).set({ updatedAt: oldUpdatedAt }).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId),
    ));
    const newerUsers = Array.from({ length: 200 }, () => {
      const id = randomUUID();
      return { id, name: `Newer ${id}`, email: `${id}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() };
    });
    await db.insert(authUsers).values(newerUsers);
    await db.insert(companyMemberships).values(newerUsers.map(user => ({
      companyId, principalType: "user", principalId: user.id, status: "active", membershipRole: "member",
    })));
    // The page boundary shares a millisecond. A JavaScript Date cursor would lose
    // the remaining PostgreSQL precision and skip this user's membership.
    await db.execute(sql`update company_memberships set updated_at = case
      when principal_id = ${userId} then '2020-01-01 00:00:00.000100+00'::timestamptz
      else '2020-01-01 00:00:00.000200+00'::timestamptz end
      where company_id = ${companyId}`);

    const actor = await resolve(freshDb(), value);
    const [unchanged] = await db.select({ updatedAt: companyMemberships.updatedAt }).from(companyMemberships).where(and(
      eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalId, userId),
    ));
    expect(unchanged.updatedAt).toEqual(oldUpdatedAt);
    const app = express();
    app.use((req, _res, next) => { req.actor = actor!; next(); });
    app.use("/api", userProfileRoutes(db));
    app.use(errorHandler);
    const response = await request(app).get(`/api/companies/${companyId}/users/${userId}/profile`);
    expect(response.status).toBe(200);
    expect(response.body.user.id).toBe(userId);
    expect(response.body.user.membershipRole).toBe("owner");
    expect((await request(app).get(`/api/companies/${randomUUID()}/users/${userId}/profile`)).status).toBe(403);
  });
});
