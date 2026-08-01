import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { applyPendingMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0199_heartbeat_run_issue_privacy.sql";
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function migrationHash() {
  const content = await fs.promises.readFile(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url), "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describeEmbeddedPostgres("heartbeat run issue privacy migration", () => {
  it("backfills every valid context issue binding and preserves maintenance runs", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-run-issue-privacy-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => sql.end());

    await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${await migrationHash()}`;

    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const maintenanceRunId = randomUUID();

    await sql`
      INSERT INTO "companies" ("id", "name", "issue_prefix")
      VALUES (${companyId}, 'Run Privacy', 'RPR')
    `;
    await sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "adapter_type", "adapter_config")
      VALUES (${agentId}, ${companyId}, 'Runner', 'engineer', 'process', '{}'::jsonb)
    `;
    await sql`
      INSERT INTO "issues" ("id", "company_id", "title", "identifier")
      VALUES
        (${firstIssueId}, ${companyId}, 'First private task', 'RPR-1'),
        (${secondIssueId}, ${companyId}, 'Second private task', 'RPR-2')
    `;
    await sql`
      INSERT INTO "heartbeat_runs" (
        "id", "company_id", "agent_id", "status", "issue_id", "context_snapshot"
      )
      VALUES
        (${firstRunId}, ${companyId}, ${agentId}, 'succeeded', NULL, ${sql.json({ issueId: firstIssueId })}),
        (${secondRunId}, ${companyId}, ${agentId}, 'failed', NULL, ${sql.json({ issueId: secondIssueId })}),
        (${maintenanceRunId}, ${companyId}, ${agentId}, 'succeeded', NULL, ${sql.json({ wakeReason: "heartbeat_timer" })})
    `;

    await applyPendingMigrations(database.connectionString);

    const rows = await sql<{ id: string; issue_id: string | null }[]>`
      SELECT "id", "issue_id"
      FROM "heartbeat_runs"
      WHERE "id" IN (${firstRunId}, ${secondRunId}, ${maintenanceRunId})
      ORDER BY "id"
    `;
    const issueByRun = new Map(rows.map((row) => [row.id, row.issue_id]));
    expect(issueByRun.get(firstRunId)).toBe(firstIssueId);
    expect(issueByRun.get(secondRunId)).toBe(secondIssueId);
    expect(issueByRun.get(maintenanceRunId)).toBeNull();

    const [parity] = await sql<{ expected_count: number; populated_count: number }[]>`
      SELECT
        count(*) FILTER (WHERE "context_snapshot" ? 'issueId')::int AS "expected_count",
        count(*) FILTER (WHERE "context_snapshot" ? 'issueId' AND "issue_id" IS NOT NULL)::int AS "populated_count"
      FROM "heartbeat_runs"
      WHERE "id" IN (${firstRunId}, ${secondRunId}, ${maintenanceRunId})
    `;
    expect(parity).toEqual({ expected_count: 2, populated_count: 2 });

    const indexes = await sql<{ indexname: string }[]>`
      SELECT "indexname"
      FROM "pg_indexes"
      WHERE "schemaname" = 'public'
        AND "indexname" = 'heartbeat_runs_company_issue_created_idx'
    `;
    expect(indexes).toHaveLength(1);
  }, 30_000);
});
