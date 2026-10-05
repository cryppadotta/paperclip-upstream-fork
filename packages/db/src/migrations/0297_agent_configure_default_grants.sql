-- Match the standard-agent creation default for agents that already exist.
-- The unique grant index makes this safe to retry without replacing scopes.
INSERT INTO "principal_permission_grants" (
  "company_id", "principal_type", "principal_id", "permission_key",
  "scope", "granted_by_user_id", "created_at", "updated_at"
)
SELECT
  a."company_id", 'agent', a."id", 'agents:configure',
  NULL, NULL, now(), now()
FROM "agents" a
WHERE a."status" NOT IN ('pending_approval', 'terminated')
  AND NOT coalesce(a."metadata" ? 'paperclipBuiltInAgent', false)
  AND a."permissions"->>'trustPreset' IS DISTINCT FROM 'low_trust_review'
  AND a."permissions"->'reviewPreset'->>'id' IS DISTINCT FROM 'low_trust_review'
  AND a."permissions"->'authorizationPolicy'->>'trustPreset' IS DISTINCT FROM 'low_trust_review'
  AND a."permissions"->'authorizationPolicy'->'reviewPreset'->>'id' IS DISTINCT FROM 'low_trust_review'
  AND jsonb_typeof(a."permissions"->'authorizationPolicy'->'trustBoundary') IS DISTINCT FROM 'object'
ON CONFLICT ("company_id", "principal_type", "principal_id", "permission_key") DO NOTHING;
