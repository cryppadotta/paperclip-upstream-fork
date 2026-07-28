import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authAccounts,
  authUsers,
  authVerifications,
  createDb,
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import {
  bindPaperclipOidcAccount,
  consumePaperclipOidcLinkIntent,
  createPaperclipOidcLinkIntent,
  paperclipOidcLinkBodySchema,
  paperclipOidcSignInBodySchema,
  paperclipOidcStateCookieOptions,
  readPaperclipOidcConfig,
  sealOidcState,
  unsealOidcState,
  validatePaperclipOidcClaims,
  verifyPaperclipOidcLinkPassword,
} from "../auth/paperclip-oidc.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("Paperclip ID OIDC", () => {
  it("is disabled unless every required credential is configured", () => {
    expect(readPaperclipOidcConfig({})).toBeNull();
    expect(readPaperclipOidcConfig({ PAPERCLIP_OIDC_ISSUER: "https://id.example", PAPERCLIP_OIDC_CLIENT_ID: "client" })).toBeNull();
  });

  it("normalizes scopes and always requests openid", () => {
    expect(readPaperclipOidcConfig({ PAPERCLIP_OIDC_ISSUER: "https://id.example/", PAPERCLIP_OIDC_CLIENT_ID: "client", PAPERCLIP_OIDC_CLIENT_SECRET: "secret", PAPERCLIP_OIDC_SCOPES: "email,profile" }))
      .toEqual({ issuer: "https://id.example", clientId: "client", clientSecret: "secret", scopes: ["openid", "email", "profile"] });
  });

  it("rejects tampered and expired callback state", () => {
    const state = { state: "state", nonce: "nonce", codeVerifier: "verifier", callbackURL: "/", errorCallbackURL: "/auth", expiresAt: 2_000 };
    const sealed = sealOidcState(state, "secret");
    expect(unsealOidcState(sealed, "secret", 1_000)).toEqual(state);
    expect(unsealOidcState(`${sealed}x`, "secret", 1_000)).toBeNull();
    expect(unsealOidcState(sealed, "secret", 3_000)).toBeNull();
  });

  it("requires an explicitly verified email claim", () => {
    expect(validatePaperclipOidcClaims({ sub: "subject", email: "USER@example.com", email_verified: true, name: "User" }))
      .toEqual({ subject: "subject", email: "user@example.com", name: "User" });
    expect(() => validatePaperclipOidcClaims({ sub: "subject", email: "user@example.com", email_verified: false })).toThrow();
    expect(() => validatePaperclipOidcClaims({ sub: "subject", email: "user@example.com", email_verified: "true" })).toThrow();
  });

  it("requires the dedicated linking endpoint and a password", () => {
    expect(() => paperclipOidcSignInBodySchema.parse({ callbackURL: "/", link: true })).toThrow();
    expect(() => paperclipOidcLinkBodySchema.parse({ callbackURL: "/" })).toThrow();
    expect(paperclipOidcLinkBodySchema.parse({ callbackURL: "/", password: "correct horse" }))
      .toEqual({ callbackURL: "/", password: "correct horse" });
  });

  it("rejects OIDC-only accounts and wrong passwords while accepting the local credential", async () => {
    const verify = vi.fn(async ({ hash, password }: { hash: string; password: string }) => hash === "stored" && password === "correct");

    await expect(verifyPaperclipOidcLinkPassword([{ providerId: "paperclip-id", password: null }], "correct", verify))
      .resolves.toBe(false);
    await expect(verifyPaperclipOidcLinkPassword([{ providerId: "credential", password: "stored" }], "wrong", verify))
      .resolves.toBe(false);
    await expect(verifyPaperclipOidcLinkPassword([{ providerId: "credential", password: "stored" }], "correct", verify))
      .resolves.toBe(true);
  });

  it("marks the OIDC state cookie secure only for HTTPS external URLs", () => {
    expect(paperclipOidcStateCookieOptions("https://paperclip.example.test").secure).toBe(true);
    expect(paperclipOidcStateCookieOptions("http://paperclip.local.test:3100").secure).toBe(false);
  });
});

describeEmbeddedPostgres("Paperclip ID OIDC persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-oidc-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    await db.delete(authAccounts);
    await db.delete(authVerifications);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("binds link intents to one session, expires them, and consumes them once", async () => {
    const now = new Date("2026-07-28T12:00:00.000Z");
    const token = await createPaperclipOidcLinkIntent(db, { userId: "user-1", sessionId: "session-1" }, now);

    await expect(consumePaperclipOidcLinkIntent(db, token, { userId: "user-1", sessionId: "session-2" }, now))
      .resolves.toBe(false);
    await expect(consumePaperclipOidcLinkIntent(db, token, { userId: "user-1", sessionId: "session-1" }, now))
      .resolves.toBe(true);
    await expect(consumePaperclipOidcLinkIntent(db, token, { userId: "user-1", sessionId: "session-1" }, now))
      .resolves.toBe(false);

    const expiredToken = await createPaperclipOidcLinkIntent(db, { userId: "user-1", sessionId: "session-1" }, now);
    await expect(consumePaperclipOidcLinkIntent(
      db,
      expiredToken,
      { userId: "user-1", sessionId: "session-1" },
      new Date(now.getTime() + 10 * 60 * 1000),
    )).resolves.toBe(false);
  });

  it("allows only one user to win concurrent issuer-subject binding", async () => {
    const timestamp = new Date("2026-07-28T12:00:00.000Z");
    const userIds = [randomUUID(), randomUUID()];
    await db.insert(authUsers).values(userIds.map((id, index) => ({
      id,
      name: `User ${index + 1}`,
      email: `user-${index + 1}@example.test`,
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })));

    const results = await Promise.all(userIds.map((userId) => bindPaperclipOidcAccount(db, {
      userId,
      providerId: "paperclip-id:https://id.example.test",
      accountId: "shared-subject",
    }, timestamp)));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => !result)).toHaveLength(1);
    const rows = await db.select({ userId: authAccounts.userId }).from(authAccounts);
    expect(rows).toHaveLength(1);
    const losingUserId = userIds.find((userId) => userId !== rows[0]?.userId);
    expect(losingUserId).toBeDefined();
    await expect(bindPaperclipOidcAccount(db, {
      userId: losingUserId!,
      providerId: "paperclip-id:https://id.example.test",
      accountId: "shared-subject",
    }, timestamp)).resolves.toBe(false);
  });

  it("deduplicates same-user legacy bindings and rejects cross-user legacy bindings", async () => {
    const timestamp = new Date("2026-07-28T12:00:00.000Z");
    const userIds = [randomUUID(), randomUUID()];
    await db.insert(authUsers).values(userIds.map((id, index) => ({
      id,
      name: `Migration User ${index + 1}`,
      email: `migration-user-${index + 1}@example.test`,
      emailVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })));
    const migration = await readFile(
      new URL("../../../packages/db/src/migrations/0195_oidc_account_binding_unique.sql", import.meta.url),
      "utf8",
    );
    const statements = migration.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);

    await db.execute(sql.raw('DROP INDEX "account_provider_account_unique"'));
    await db.insert(authAccounts).values(["legacy-a", "legacy-b"].map((id) => ({
      id,
      userId: userIds[0]!,
      providerId: "paperclip-id:https://legacy.example.test",
      accountId: "legacy-subject",
      createdAt: timestamp,
      updatedAt: timestamp,
    })));
    for (const statement of statements) await db.execute(sql.raw(statement));
    expect(await db.select().from(authAccounts)).toHaveLength(1);

    await db.execute(sql.raw('DROP INDEX "account_provider_account_unique"'));
    await db.insert(authAccounts).values({
      id: "legacy-cross-user",
      userId: userIds[1]!,
      providerId: "paperclip-id:https://legacy.example.test",
      accountId: "legacy-subject",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await expect(db.execute(sql.raw(statements[0]!))).rejects.toThrow("linked to multiple users");
  });
});
