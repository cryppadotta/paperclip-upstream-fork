import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import { authAccounts, authUsers, authVerifications, type Db } from "@paperclipai/db";
import * as oidc from "openid-client";
import { z } from "zod";

const PROVIDER_ID = "paperclip-id";
const STATE_COOKIE = "paperclip_oidc_state";
const STATE_TTL_MS = 10 * 60 * 1000;
const LINK_INTENT_PREFIX = "paperclip-oidc-link:";

export type PaperclipOidcConfig = { issuer: string; clientId: string; clientSecret: string; scopes: string[] };
type OidcState = { state: string; nonce: string; codeVerifier: string; callbackURL: string; errorCallbackURL: string; linkIntent?: string; expiresAt: number };
type LinkIntentBinding = { userId: string; sessionId: string };

export const paperclipOidcSignInBodySchema = z.object({
  callbackURL: z.string().optional(),
  errorCallbackURL: z.string().optional(),
}).strict();

export const paperclipOidcLinkBodySchema = paperclipOidcSignInBodySchema.extend({
  password: z.string().min(1),
}).strict();

export function readPaperclipOidcConfig(env: NodeJS.ProcessEnv = process.env): PaperclipOidcConfig | null {
  const issuer = env.PAPERCLIP_OIDC_ISSUER?.trim();
  const clientId = env.PAPERCLIP_OIDC_CLIENT_ID?.trim();
  const clientSecret = env.PAPERCLIP_OIDC_CLIENT_SECRET?.trim();
  if (!issuer || !clientId || !clientSecret) return null;
  const scopes = (env.PAPERCLIP_OIDC_SCOPES ?? "openid profile email").split(/[\s,]+/).filter(Boolean);
  if (!scopes.includes("openid")) scopes.unshift("openid");
  return { issuer: new URL(issuer).toString().replace(/\/$/, ""), clientId, clientSecret, scopes };
}

function signature(value: string, secret: string) {
  return createHmac("sha256", createHash("sha256").update(secret).digest()).update(value).digest("base64url");
}

export function sealOidcState(state: OidcState, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function unsealOidcState(value: string | undefined, secret: string, now = Date.now()): OidcState | null {
  if (!value) return null;
  const [payload, actual] = value.split(".");
  if (!payload || !actual) return null;
  const expected = signature(payload, secret);
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OidcState;
    return state.expiresAt > now ? state : null;
  } catch {
    return null;
  }
}

export function validatePaperclipOidcClaims(claims: Record<string, unknown>) {
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const emailVerified = claims.email_verified === true;
  if (!subject || !email || !emailVerified) throw new Error("Paperclip ID must return a verified email and subject");
  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : email;
  return { subject, email, name };
}

function linkIntentId(token: string) {
  return `${LINK_INTENT_PREFIX}${createHash("sha256").update(token).digest("base64url")}`;
}

function linkIntentValue(binding: LinkIntentBinding) {
  return JSON.stringify(binding);
}

export async function createPaperclipOidcLinkIntent(db: Db, binding: LinkIntentBinding, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  await db.insert(authVerifications).values({
    id: linkIntentId(token),
    identifier: LINK_INTENT_PREFIX,
    value: linkIntentValue(binding),
    expiresAt: new Date(now.getTime() + STATE_TTL_MS),
    createdAt: now,
    updatedAt: now,
  });
  return token;
}

export async function consumePaperclipOidcLinkIntent(db: Db, token: string, binding: LinkIntentBinding, now = new Date()) {
  const [consumed] = await db.delete(authVerifications)
    .where(and(
      eq(authVerifications.id, linkIntentId(token)),
      eq(authVerifications.identifier, LINK_INTENT_PREFIX),
      eq(authVerifications.value, linkIntentValue(binding)),
      gt(authVerifications.expiresAt, now),
    ))
    .returning({ id: authVerifications.id });
  return Boolean(consumed);
}

export function paperclipOidcStateCookieOptions(baseURL: string) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/api/auth",
    maxAge: STATE_TTL_MS / 1000,
    secure: new URL(baseURL).protocol === "https:",
  };
}

export async function verifyPaperclipOidcLinkPassword(
  accounts: Array<{ providerId: string; password?: string | null }>,
  password: string,
  verify: (input: { hash: string; password: string }) => Promise<boolean>,
) {
  const credentialAccount = accounts.find((account) => account.providerId === "credential" && account.password);
  return credentialAccount?.password
    ? verify({ hash: credentialAccount.password, password })
    : false;
}

export async function bindPaperclipOidcAccount(
  db: Db,
  input: {
    userId: string;
    providerId: string;
    accountId: string;
    accessToken?: string;
    refreshToken?: string;
    idToken?: string;
    scope?: string;
  },
  now = new Date(),
) {
  await db.insert(authAccounts).values({
    id: randomUUID(),
    userId: input.userId,
    providerId: input.providerId,
    accountId: input.accountId,
    accessToken: input.accessToken,
    refreshToken: input.refreshToken,
    idToken: input.idToken,
    scope: input.scope,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: [authAccounts.providerId, authAccounts.accountId] });
  const [account] = await db.select({ userId: authAccounts.userId })
    .from(authAccounts)
    .where(and(eq(authAccounts.providerId, input.providerId), eq(authAccounts.accountId, input.accountId)))
    .limit(1);
  if (!account) throw new Error("OIDC account binding was not persisted");
  return account.userId === input.userId;
}

export function paperclipOidc(config: PaperclipOidcConfig, secret: string, db: Db): BetterAuthPlugin {
  let discovered: Promise<oidc.Configuration> | undefined;
  const getConfiguration = () => discovered ??= oidc.discovery(new URL(config.issuer), config.clientId, config.clientSecret);

  return {
    id: "paperclip-oidc",
    endpoints: {
      paperclipOidcSignIn: createAuthEndpoint("/sign-in/paperclip-id", {
        method: "POST",
        body: paperclipOidcSignInBodySchema,
      }, async (ctx) => {
        const state: OidcState = {
          state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier(),
          callbackURL: ctx.body.callbackURL || "/", errorCallbackURL: ctx.body.errorCallbackURL || "/auth",
          expiresAt: Date.now() + STATE_TTL_MS,
        };
        const authorizationURL = oidc.buildAuthorizationUrl(await getConfiguration(), {
          redirect_uri: `${ctx.context.baseURL}/oauth2/callback/${PROVIDER_ID}`,
          response_type: "code", scope: config.scopes.join(" "), state: state.state, nonce: state.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(state.codeVerifier), code_challenge_method: "S256",
        });
        ctx.setCookie(STATE_COOKIE, sealOidcState(state, secret), paperclipOidcStateCookieOptions(ctx.context.baseURL));
        return ctx.json({ url: authorizationURL.toString(), redirect: true });
      }),
      paperclipOidcLink: createAuthEndpoint("/link/paperclip-id", {
        method: "POST",
        body: paperclipOidcLinkBodySchema,
      }, async (ctx) => {
        const activeSession = await getSessionFromCtx(ctx);
        if (!activeSession) throw ctx.error("UNAUTHORIZED", { message: "A local session is required to link Paperclip ID" });
        const accounts = await ctx.context.internalAdapter.findAccounts(activeSession.user.id);
        if (!accounts.some((account) => account.providerId === "credential" && account.password)) {
          throw ctx.error("BAD_REQUEST", { message: "A local password is required to link Paperclip ID" });
        }
        if (!await verifyPaperclipOidcLinkPassword(accounts, ctx.body.password, ctx.context.password.verify)) {
          throw ctx.error("UNAUTHORIZED", { message: "Invalid local password" });
        }
        const linkIntent = await createPaperclipOidcLinkIntent(db, {
          userId: activeSession.user.id,
          sessionId: activeSession.session.id,
        });
        const state: OidcState = {
          state: oidc.randomState(), nonce: oidc.randomNonce(), codeVerifier: oidc.randomPKCECodeVerifier(),
          callbackURL: ctx.body.callbackURL || "/", errorCallbackURL: ctx.body.errorCallbackURL || "/auth",
          linkIntent, expiresAt: Date.now() + STATE_TTL_MS,
        };
        const authorizationURL = oidc.buildAuthorizationUrl(await getConfiguration(), {
          redirect_uri: `${ctx.context.baseURL}/oauth2/callback/${PROVIDER_ID}`,
          response_type: "code", scope: config.scopes.join(" "), state: state.state, nonce: state.nonce,
          code_challenge: await oidc.calculatePKCECodeChallenge(state.codeVerifier), code_challenge_method: "S256",
        });
        ctx.setCookie(STATE_COOKIE, sealOidcState(state, secret), paperclipOidcStateCookieOptions(ctx.context.baseURL));
        return ctx.json({ url: authorizationURL.toString(), redirect: true });
      }),
      paperclipOidcCallback: createAuthEndpoint("/oauth2/callback/paperclip-id", {
        method: "GET",
        query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
      }, async (ctx) => {
        const state = unsealOidcState(ctx.getCookie(STATE_COOKIE) ?? undefined, secret);
        ctx.setCookie(STATE_COOKIE, "", { ...paperclipOidcStateCookieOptions(ctx.context.baseURL), maxAge: 0 });
        const fail = (code: string): never => { throw ctx.redirect(`${state?.errorCallbackURL || "/auth"}${(state?.errorCallbackURL || "/auth").includes("?") ? "&" : "?"}oidcError=${encodeURIComponent(code)}`); };
        if (!state || ctx.query.error || !ctx.query.code || ctx.query.state !== state.state || !ctx.request) return fail("invalid_state");
        const validState = state;
        const tokens = await oidc.authorizationCodeGrant(await getConfiguration(), new URL(ctx.request.url), {
          expectedState: validState.state, expectedNonce: validState.nonce, pkceCodeVerifier: validState.codeVerifier,
        });
        const claims = tokens.claims();
        if (!claims) fail("missing_id_token");
        let identity: ReturnType<typeof validatePaperclipOidcClaims>;
        try { identity = validatePaperclipOidcClaims(claims as Record<string, unknown>); } catch { return fail("unverified_email"); }
        const providerId = `${PROVIDER_ID}:${config.issuer}`;
        const existingAccount = await ctx.context.internalAdapter.findAccountByProviderId(identity.subject, providerId);
        let user;
        if (existingAccount) {
          user = await ctx.context.internalAdapter.findUserById(existingAccount.userId);
          if (!user) return fail("user_not_found");
        } else if (validState.linkIntent) {
          const activeSession = await getSessionFromCtx(ctx);
          if (!activeSession) return fail("link_session_expired");
          if (!await consumePaperclipOidcLinkIntent(db, validState.linkIntent, {
            userId: activeSession.user.id,
            sessionId: activeSession.session.id,
          })) return fail("link_session_expired");
          if (activeSession.user.email.toLowerCase() !== identity.email) return fail("email_mismatch");
          user = activeSession.user;
          if (!await bindPaperclipOidcAccount(db, { userId: user.id, providerId, accountId: identity.subject, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, scope: tokens.scope })) return fail("account_already_linked");
        } else {
          if (await ctx.context.internalAdapter.findUserByEmail(identity.email)) return fail("account_not_linked");
          user = await ctx.context.internalAdapter.createUser({ email: identity.email, emailVerified: true, name: identity.name });
          if (!await bindPaperclipOidcAccount(db, { userId: user.id, providerId, accountId: identity.subject, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, idToken: tokens.id_token, scope: tokens.scope })) {
            await db.delete(authUsers).where(eq(authUsers.id, user.id));
            return fail("account_already_linked");
          }
        }
        if (validState.linkIntent && existingAccount) {
          const activeSession = await getSessionFromCtx(ctx);
          if (!activeSession || existingAccount.userId !== activeSession.user.id) return fail("account_already_linked");
          if (!await consumePaperclipOidcLinkIntent(db, validState.linkIntent, {
            userId: activeSession.user.id,
            sessionId: activeSession.session.id,
          })) return fail("link_session_expired");
        }
        if (!user) return fail("user_not_found");
        const session = await ctx.context.internalAdapter.createSession(user.id);
        if (!session) fail("session_failed");
        await setSessionCookie(ctx, { session, user });
        throw ctx.redirect(validState.callbackURL);
      }),
    },
  };
}
