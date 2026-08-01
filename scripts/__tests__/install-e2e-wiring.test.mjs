import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const lifecycleScript = path.join(repoRoot, "scripts", "e2e-install-lifecycle.sh");
const migrationScript = path.join(repoRoot, "scripts", "e2e-update-migrations.sh");
const systemdDriver = path.join(repoRoot, "scripts", "run-install-e2e-systemd-docker.sh");
const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "install-e2e.yml"), "utf8");

test("install acceptance shell harnesses have valid syntax", () => {
  for (const script of [lifecycleScript, migrationScript, systemdDriver]) {
    const result = spawnSync("bash", ["-n", script], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(result.status, 0, `${path.basename(script)}\n${result.stderr}`);
  }
});

test("CI runs git refs plus native amd64 and arm64 systemd lanes", () => {
  assert.match(workflow, /case: master/);
  assert.match(workflow, /case: tag/);
  assert.match(workflow, /case: sha/);
  assert.match(workflow, /case: fork-repo/);
  assert.match(workflow, /ubuntu-24\.04-arm/);
  assert.match(workflow, /run-install-e2e-systemd-docker\.sh all/);
  assert.match(workflow, /actions\/upload-artifact/);
  assert.doesNotMatch(workflow, /skipping cross-version update e2e/);
});

test("systemd lifecycle asserts every service acceptance invariant", () => {
  const source = readFileSync(lifecycleScript, "utf8");
  for (const marker of [
    "explicit service install is idempotent and leaves the service started",
    "crash-killed service respawned",
    "login-session restart with linger",
    "foreground run refused while service is active",
    "live local CLI-agent run reached running state",
    "adoptedRunIds",
    "adopted live run completed successfully",
    "service logs readable",
    "uninstall leaves no service loaded or active",
  ]) {
    assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("systemd hot restart preserves children and orders embedded database shutdown", () => {
  const serviceManager = readFileSync(path.join(repoRoot, "cli", "src", "services", "service-manager.ts"), "utf8");
  const server = readFileSync(path.join(repoRoot, "server", "src", "index.ts"), "utf8");
  const embeddedPatch = readFileSync(
    path.join(repoRoot, "patches", "embedded-postgres@18.1.0-beta.16.patch"),
    "utf8",
  );
  assert.match(serviceManager, /KillMode=process/);
  assert.match(serviceManager, /Environment="EMBEDDED_POSTGRES_DISABLE_EXIT_HOOK=1"/);
  assert.match(server, /EMBEDDED_POSTGRES_DISABLE_EXIT_HOOK = "1"/);
  assert.match(embeddedPatch, /EMBEDDED_POSTGRES_DISABLE_EXIT_HOOK/);
});

test("cross-version migration harness cleans failed installs and exposes base backup errors", () => {
  const source = readFileSync(migrationScript, "utf8");
  const cleanup = source.match(/cleanup\(\) \{(?<body>[\s\S]*?)\n\}/)?.groups?.body;
  assert.ok(cleanup, "expected cleanup function");
  assert.match(cleanup, /shim service stop/);
  assert.match(cleanup, /shim service uninstall/);
  assert.match(cleanup, /shim uninstall/);
  assert.match(source, /BASE_BACKUP_OUTPUT/);
  assert.match(source, /shim db:backup/);
  assert.doesNotMatch(source, /shim db-backup/);
  assert.doesNotMatch(source, /dump_text[^\n]*\| grep -q/);
  assert.match(source, /restarted service reports the updated payload version/);
  assert.match(source, /service logs are readable after update/);
});

test("cross-version refs are required before the harness writes files", () => {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("PAPERCLIP_") && !name.startsWith("E2E_UPDATE_")),
  );
  for (const testCase of [
    { env: {}, missing: "E2E_UPDATE_BASE_REF" },
    { env: { E2E_UPDATE_BASE_REF: "test/base" }, missing: "E2E_UPDATE_NEXT_REF" },
  ]) {
    const testHome = mkdtempSync(path.join(os.tmpdir(), "paperclip-update-migrations-"));
    try {
      const result = spawnSync("bash", [migrationScript], {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...cleanEnv, HOME: testHome, ...testCase.env },
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(`${testCase.missing} is required`));
      assert.deepEqual(readdirSync(testHome), [], "validation must precede side effects");
    } finally {
      rmSync(testHome, { recursive: true, force: true });
    }
  }
});
