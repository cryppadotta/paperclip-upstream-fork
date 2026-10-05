# Agent permission defaults

This document describes the server defaults for an ordinary, standard trust agent. An agent must belong to the same company and be active where the action requires active membership. A responsible user's authority, project or run trust policy, scope rules, and approval gates can narrow these defaults.

## Granted by default

| Capability | Source and limit |
| --- | --- |
| `agents:configure` | A direct, company-scoped grant is added when a standard agent is created. Migration 0299 adds it once to eligible existing agents. This permits peer agent configuration, subject to protected-change and responsible-user checks. An administrator can remove the grant later. |
| Agent creation | New standard agents have `canCreateAgents: true`. This is a legacy authorization path for `agents:create`, not an `agents:create` grant row. Stored legacy records without the flag stay closed. |
| Skill creation setting | `canCreateSkills: true` is the normalized setting. Protected skill configuration changes still require a direct `skills:create` grant or a consented `skills:suggest-changes` grant. |
| Same-company visibility and work | Standard agents can read same-company agents, projects, issues, and company scope; read and manage decision queues; read runtime and secret metadata where the route allows it; comment or mutate their own or unassigned issues; and assign tasks under the assignment policy. The route and resource checks still apply. |
| Own configuration and wake | An agent can read its own configuration, update unprotected parts of it, and wake itself. Protected changes still require the relevant grant. |

## Not granted by default

These permission keys have no blanket standard-agent grant: `agents:create` (the flag above is separate), `agents:suggest-changes`, `skills:create`, `skills:suggest-changes`, `environments:manage`, `tools:admin`, `tools:manage_connections`, `tools:manage_profiles`, `tools:view_audit`, `audit:view_agent_actions`, `tools:use`, `tools:manage_runtime`, `inbox:manage`, `users:invite`, `users:manage_permissions`, `tasks:assign`, `tasks:assign_scope`, `tasks:manage_active_checkouts`, `pipelines:write`, and `joins:approve`. Some actions, such as ordinary task assignment or responsible-user inbox management, have separate bounded default paths; the absence of a grant row does not describe every route decision.

The direct `agents:configure` default does not grant company administration, user permission management, tool administration, cross-company access, or the power to change another active issue checkout. The responsible user's permissions and the normal approval gates still apply.

Agent-authenticated callers cannot set process adapter configuration or switch an existing agent onto the process adapter. They also cannot roll back into process adapter configuration or restore host-executed workspace commands through a configuration revision. This keeps host-executed commands under board control while standard agents configure other supported agent settings.

## Exceptions and rollout

The new direct grant is withheld from low trust agents and managed built-in agents. Low trust run or project policies can also deny privileged configuration even if an agent has a grant. Existing pending and terminated agents are not backfilled. A standard pending agent receives the grant when approved and activated. Invitation approval retains the grant when it replaces a new agent's grant set and preserves an explicitly scoped configuration grant. Existing scoped grants are preserved by the backfill. A grant removed after migration stays removed; startup does not reapply it.

The standard agent configuration default supports the agent setup in the linked runner task. Enabling a warm runtime can still depend on the target agent's adapter and runtime configuration, provider availability, and any responsible-user or approval checks.
