import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareOpenAiHostedFixture } from "./openai-managed-fixture.js";
import { runnerSuites } from "./catalog.js";
import { evaluateMatcher } from "./matchers.js";
it("checks binary contents rather than only their existence", async () => {
  const suite = runnerSuites.find((entry) => entry.id === "openai-managed-hosted")!;
  const matchers = suite.tasks[0]!.buildMatchers("nonce", {} as never);
  const matcher = matchers.find((entry) => entry.kind === "file_sha256")!;
  expect(matcher).toMatchObject({ path: "binary.bin" });
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  expect((await evaluateMatcher(matcher, { fileHashes: { "binary.bin": hash(Buffer.from([0,1,2,255])) } })).passed).toBe(true);
  expect((await evaluateMatcher(matcher, { fileHashes: { "binary.bin": hash(Buffer.from([0,1,2,254])) } })).passed).toBe(false);
  expect((await evaluateMatcher(matcher, { fileHashes: {} })).passed).toBe(false);
});
it("creates an isolated Git worktree with a committed input fixture", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "openai-e2e-fixture-"));
  try {
    const workspace = path.join(root, "workspace"); await mkdir(workspace);
    await prepareOpenAiHostedFixture(workspace);
    expect(await readFile(path.join(workspace, ".git"), "utf8")).toContain("gitdir:");
    expect(await readFile(path.join(workspace, "seed.txt"), "utf8")).toBe("OpenAI hosted fixture baseline\n");
    await expect(prepareOpenAiHostedFixture(workspace)).rejects.toThrow("empty disposable workspace");
  } finally { await rm(root, { recursive: true, force: true }); }
});
