import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetRuntimeServicesForTests,
  startRuntimeServicesForWorkspaceControl,
} from "../services/workspace-runtime.js";
import {
  listLocalServiceRegistryRecords,
  readLocalServicePortOwner,
  resolveLocalServiceLogPath,
  terminateLocalService,
} from "../services/local-service-supervisor.js";

describe("local service supervision", () => {
  afterEach(async () => {
    await resetRuntimeServicesForTests({ terminateProcesses: true });
  });

  it("keeps request-logging runtime stdio usable after the supervisor side closes", async () => {
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-stdio-"));
    const paperclipHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-home-"));
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = `service-stdio-${randomUUID()}`;

    let registryRecord: Awaited<ReturnType<typeof listLocalServiceRegistryRecords>>[number] | null = null;
    try {
      const [service] = await startRuntimeServicesForWorkspaceControl({
        actor: { id: null, name: "Board", companyId: randomUUID() },
        issue: null,
        workspace: {
          baseCwd: workspaceRoot,
          source: "agent_home",
          projectId: null,
          workspaceId: null,
          repoUrl: null,
          repoRef: null,
          strategy: "project_primary",
          cwd: workspaceRoot,
          branchName: null,
          worktreePath: null,
          warnings: [],
          created: false,
        },
        config: {
          workspaceRuntime: {
            services: [{
              name: "web",
              command: "node -e \"const http=require('node:http'); process.on('SIGTERM',()=>{}); http.createServer((req,res)=>{ process.stdout.write('request '+req.url+'\\\\n',(error)=>{ if (!error) res.end('ok'); }); }).listen(Number(process.env.PORT), '127.0.0.1')\"",
              port: { type: "auto" },
              readiness: {
                type: "http",
                urlTemplate: "http://127.0.0.1:{{port}}",
                timeoutSec: 10,
                intervalMs: 100,
              },
              lifecycle: "shared",
              reuseScope: "agent",
              stopPolicy: { type: "manual" },
            }],
          },
        },
        adapterEnv: {},
      });

      expect(service?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(service?.port).toBeTypeOf("number");
      registryRecord = (await listLocalServiceRegistryRecords({ profileKind: "workspace-runtime" }))
        .find((record) => record.runtimeServiceId === service!.id) ?? null;
      expect(registryRecord).not.toBeNull();

      await resetRuntimeServicesForTests({ simulateSupervisorExit: true });

      await expect(fetch(`${service!.url}/after-restart`)).resolves.toMatchObject({ ok: true });
      const log = await fs.readFile(resolveLocalServiceLogPath(registryRecord!.serviceKey), "utf8");
      expect(log).toContain("request /after-restart");

      await terminateLocalService(registryRecord!);
      expect(await readLocalServicePortOwner(service!.port!)).toBeNull();
      await expect(fetch(service!.url!)).rejects.toThrow();
      registryRecord = null;
    } finally {
      if (registryRecord) await terminateLocalService(registryRecord).catch(() => undefined);
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
      await fs.rm(paperclipHome, { recursive: true, force: true });
      await fs.rm(workspaceRoot, { recursive: true, force: true });
    }
  }, 15_000);
});
