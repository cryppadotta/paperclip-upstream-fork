ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_context_issue_backfill_idx"
  ON "heartbeat_runs" USING btree ("id")
  WHERE "issue_id" IS NULL AND "context_snapshot" ? 'issueId';
--> statement-breakpoint
UPDATE "heartbeat_runs" AS "run"
SET "issue_id" = "issue"."id"
FROM "issues" AS "issue"
WHERE "run"."issue_id" IS NULL
  AND "run"."context_snapshot" ? 'issueId'
  AND "issue"."id" = CASE
    WHEN "run"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN ("run"."context_snapshot"->>'issueId')::uuid
    ELSE NULL
  END
  AND "issue"."company_id" = "run"."company_id";
--> statement-breakpoint
DO $$
DECLARE
  "expected_count" bigint;
  "populated_count" bigint;
BEGIN
  SELECT count(*)
  INTO "expected_count"
  FROM "heartbeat_runs" AS "run"
  INNER JOIN "issues" AS "issue"
    ON "issue"."company_id" = "run"."company_id"
    AND "issue"."id" = CASE
      WHEN "run"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN ("run"."context_snapshot"->>'issueId')::uuid
      ELSE NULL
    END
  WHERE "run"."context_snapshot" ? 'issueId'
    AND "run"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

  SELECT count(*)
  INTO "populated_count"
  FROM "heartbeat_runs" AS "run"
  WHERE "run"."context_snapshot" ? 'issueId'
    AND "run"."issue_id" = CASE
      WHEN "run"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN ("run"."context_snapshot"->>'issueId')::uuid
      ELSE NULL
    END;

  IF "expected_count" <> "populated_count" THEN
    RAISE EXCEPTION 'heartbeat_runs.issue_id backfill parity failed: expected %, populated %',
      "expected_count", "populated_count";
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "heartbeat_runs_context_issue_backfill_idx";
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'heartbeat_runs_issue_id_issues_id_fk'
  ) THEN
    ALTER TABLE "heartbeat_runs"
      ADD CONSTRAINT "heartbeat_runs_issue_id_issues_id_fk"
      FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_idx"
  ON "heartbeat_runs" USING btree ("company_id", "issue_id", "created_at");
