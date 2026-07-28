import { describe, expect, it } from "vitest";
import { readPaperclipOidcConfig, sealOidcState, unsealOidcState, validatePaperclipOidcClaims } from "../auth/paperclip-oidc.js";

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
  });
});
