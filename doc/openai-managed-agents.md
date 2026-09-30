# OpenAI managed agents

Status: experimental; live qualification attempted on 2026-09-30, not yet passed.
Implemented against the public Agents API documentation reviewed that day.
Neither profile has a production qualification attestation.

## Which OpenAI product?

The [Agents API](https://openai.com/index/introducing-the-agents-api/) runs the
OpenAI-managed Codex harness. Paperclip supplies instructions, a model, tools and
an environment policy; OpenAI owns the execution loop. This integration uses
`gpt-6-astra` and the `agents=v1` protocol revision. The model and the Codex harness
are separate identities. The API revision does not pin an immutable hosted
harness build, so evidence records `hostedHarnessVersion: null`.

[Workspace Agents](https://developers.openai.com/workspace-agents) is the
ChatGPT workflow surface. Its API invokes saved workspace workflows; it is not the
session/tool-result interface used by this runner.

## Configuration

Select **OpenAI Managed (experimental)** in the native Runner settings. Create a
company secret containing an OpenAI API key, then create a remote agent profile
and bind that secret. The key is resolved only into the controller's provider
client. It is never an environment variable inside the OpenAI-hosted sandbox.
Profiles are company-scoped, revisioned, and bound to their credential secret.
Existing board authorization and audit logging protect profile changes.

The UI saves new profiles disabled. Production enablement requires a 35/35 live
attestation for the exact configuration. A hosted profile requires its own
attestation, separate from the tools-only profile.

Example `configuration` for `POST /api/companies/:companyId/remote-agent-profiles`:

```json
{
  "defaultModel": "gpt-6-astra",
  "apiRevision": "agents=v1",
  "reasoningEffort": "medium",
  "environment": {
    "type": "openai_hosted",
    "container_size": "medium",
    "network": { "access": "disabled" }
  },
  "maxEstimatedSessionCostUsd": 2,
  "timeoutSeconds": 180
}
```

The surrounding request supplies `profileKey`, `displayName`,
`service: "openai_agents_api"`, `credentialSecretId`, `enabled`,
`retentionAcknowledged`, and `qualification`. For tools-only execution, use
`environment: {"type":"none"}`. Restricted networks require exact hostnames;
network access is an explicit profile choice. Reusable profiles cannot contain
initial files; the controller stages inputs for each hosted run.

The agent configuration uses `provider: "openai_managed"`, `openaiProfileId`,
`openaiRetentionAcknowledged: true`, and an `env.OPENAI_API_KEY` secret reference
matching the profile. Hosted coding requires `lifecycleMode: "per_turn"` and an
isolated Git task worktree. Each new run gets a fresh baseline and hosted session;
recovery of the same interrupted run reuses its durable binding.

## Execution and recovery

Session preparation makes no paid API call. The first authorized turn creates the
session with initial input. A stable logical driver thread is separate from the
real API session ID assigned at creation. Recovery accepts that one transition,
then rejects a change to another real session.

The Rust provider polls paginated sessions, turns and items. Only current
`required_actions` authorize Paperclip function execution; historical call items
do not. Calls retain their turn, call ID and saved result. An ambiguous result
submission is reconciled against provider history; it is not blindly repeated.
Interrupted creation is recovered using the exact session ownership metadata;
zero or multiple matches fail closed. Completion requires the saved turn outcome,
not merely an idle session. Provider subagents are disabled.

Local runner detachment preserves recoverable work. Explicit cancellation sends a
remote cancel event and checks for a terminal outcome. A lost response or timeout
can leave cancellation unconfirmed; the run reports that condition.

## Hosted files

The controller stages the Git-filtered task workspace, read-only instruction
bundle and assigned skill bundles. Authenticated inbound attachments already
staged under the task workspace travel with that snapshot. The remote workspace
is `/workspace/project`. Instructions and skills are under
`/workspace/project/.paperclip-runtime/openai-hosted/`.

Before finishing or blocking, the agent runs:

```sh
python3 /workspace/paperclip-export.py
```

This writes `/workspace/outputs/paperclip-workspace.json`, containing text, binary
files, modes, additions and deletions. Other downloadable outputs go under
`/workspace/outputs`. The API publishes outputs after the turn ends, so the agent
cannot register these files before finishing. Paperclip downloads and registers
outputs through its existing attachment/work-product path before applying the
workspace export. A missing or invalid export fails finalization.

Restore validates all paths and entry types, rejects new/changed symlinks, keeps
Git metadata and controller runtime files out, and uses the existing locked,
baseline-aware merge. Concurrent local edits cause a conflict instead of being
overwritten. Git push and PR creation are not part of this integration.

Practical limits:

- At most 50 initial files, including archives and the export helper. Small inputs
  are inline; larger archives use the Files API, with a 50 MiB per-file bound.
- Workspace inventory: 100,000 entries and 100 MiB decoded file content.
- Published files also obey Paperclip's attachment limit (10 MiB by default,
  configurable with `PAPERCLIP_ATTACHMENT_MAX_BYTES`). This often becomes the
  effective workspace-export limit before the provider's larger file limits.
- Unknown output MIME types must be bundled in ZIP files.
- Planning mode requires a tools-only profile; the current hosted environment
  cannot enforce a read-only filesystem during planning.
- Live reading of unpublished hosted files is unavailable. Persistent agent-home
  file synchronization and additional referenced-project staging are not supported
  by this initial hosted path. Use assigned read-only instruction/skill bundles
  and Paperclip document/instruction tools.

After successful import and merge, Paperclip deletes the hosted session and its
uploaded inputs. Cleanup failures are recorded and logged for retry; output or
merge failures preserve remote work. Tools-only qualification sessions are
retained for inspection. Hosted qualification sessions are deleted only when they
contain no unexpected artifacts. OpenAI retention acknowledgment is required.

## Usage and budget

Usage tokens are best-effort cumulative provider observations. The integration
reports unknown model-request counts and billed cost as `null`, not as zero.
A completed eval without usable token accounting cannot pass qualification.

The company cost ledger records this usage as `unpriced`. It cannot add these
unknown charges to the company's dollar spend, so aggregate dollar budget stops
do not account for OpenAI spend until billing is reconciled. The profile's
estimated session ceiling and timeout are the automatic controls for these runs.

The controller's estimate uses conservative long-context rates: known cache hits
use the cached-input rate; other input reserves the higher cache-write rate.
Missing or inconsistent cache counts receive no discount. It also includes a
one-hour hosted container reservation. It is not an invoice
or a provider-enforced dollar cap. Polling, delayed usage, cancellation and cleanup
can overshoot estimates. Configure an OpenAI project spending limit as well as the
Paperclip timeout/estimated session ceiling. See the current
[Agents API pricing](https://developers.openai.com/api/docs/pricing).

## Qualification

The private `paperclip-evals` repository contains
`live-openai-managed-tools.json` and `live-openai-managed-hosted.json`. Each uses
the unchanged 35-case Claude managed roster, one attempt per case, no automatic
infrastructure retries, `gpt-6-astra`, and a $2 estimated per-session ceiling.
Their maintained campaign lanes remain disabled until live qualification passes.

The candidate-only server flag `PAPERCLIP_OPENAI_MANAGED_QUALIFICATION=1` permits
an enabled but unattested profile inside a qualification instance. The product
harness removes any ambient flag and sets it only for the two explicit manual
suites. Do not enable this flag in a production instance.

Product E2E commands from this repository:

```sh
pnpm test:e2e:runner -- --list --suite openai-managed-tools
pnpm test:e2e:runner -- --list --suite openai-managed-hosted
```

After configuring `OPENAI_API_KEY` in the ignored `.env.runner-e2e.local`, the same
commands without `--list` exercise real paid work. Tools-only covers response,
plan revision/acceptance and Ask-mode answers. Hosted covers a seeded isolated Git
worktree, exact text and binary return, and a persisted output attachment.

A production qualification object contains `suite`
(`openai-managed-tools-v1` or `openai-managed-hosted-v1`), `probedAt`,
`paperclipSha`, `evalsSha`, `runnerSha256`, `configurationSha256`, `passedCases: 35`
and `totalCases: 35`. Hashes bind the integration build and configuration; they do
not claim to identify OpenAI's private runtime build. Preserve immutable attempt
artifacts and reports before recording the attestation.

## Live qualification evidence (2026-09-30)

The first complete measurements used Paperclip
`e2d8e05eb6b400011d47cf7649d25bb50c990b92`, private eval revision
`8ee4c283`, `gpt-6-astra`, medium reasoning, `agents=v1`, and the unchanged
35-case Claude managed roster. Each case had one attempt and zero automatic
retries. The hosted environment was medium with networking disabled. Provider
and eval timeouts were 180 and 240 seconds, with a $2 estimated session ceiling.

| Profile | Qualified cases | Preserved run ID |
| --- | --- | --- |
| Tools-only | 30 / 35 | `openai-tools-qualification-20260930t185459z` |
| Hosted | 25 / 35 | `openai-hosted-qualification-20260930t185500z` |

The 15 non-passing attempts comprise:

- Ten estimate-limit failures (three tools-only, seven hosted). Each completed
  its provider turn and passed every behavior check, but the original estimator
  charged cached input at the uncached reservation rate. The subsequent fix
  accounts for known cache hits. These original grades remain failures.
- Three tool-schema failures: `get-task-context` and `avoid-generic-api-request`
  in tools-only, and `avoid-generic-api-request` hosted. The unchanged fixtures
  expose synthetic agent IDs, while `read_agent_instructions.targetAgentId`
  requires a UUID. The integration rejects those calls. Schemas and fixtures have
  not been weakened to turn these attempts green.
- Hosted `get-company-agent` lacked usable token accounting after the bounded
  terminal accounting grace period.
- Hosted `schedule-task-wake` failed provider shutdown with unsettled function
  calls; successful tool receipts alone did not prove safe shutdown.

The live Product E2E work also exposed and fixed duplicate semantic completion,
absolute-path artifact handoff, missing durable artifact receipts, tools-only
planning admission, and insufficient shutdown/accounting grace. Repeated drain
probes now back off to avoid exhausting the durable command journal while waiting
for the provider. Hosted outputs are registered through the existing tool authority
before merge, with stable idempotency keys and durable presentation receipts.

Subsequent regression probes on Paperclip `8d00db6a2` and the same private eval
revision passed all four selected cases: tools-only `search-company-tasks` and
hosted `set-task-dependencies`, `schedule-task-wake`, and `get-company-agent`.
Run IDs are `openai-tools-regression-20260930t193124z` and
`openai-hosted-regression-20260930t193125z`. These used the same case definitions,
model, environment policies and ceilings, and zero automatic retries. A passing
repeat of the accounting case does not establish that delayed usage is reliable.

All four live Product E2E cells have passing retained attempts, each with six
passing matchers. These are separate measurements across integration revisions:

| Cell | Paperclip revision | Product campaign |
| --- | --- | --- |
| Message response | `5fc478024` | `local-2026-09-30T19-01-52-414Z` |
| Hosted workspace return | `e35e73f51` | `local-2026-09-30T19-15-01-461Z` |
| Plan, revise, accept (three runs) | `8d00db6a2` | `local-2026-09-30T19-29-56-784Z` |
| Ask-mode answer | `8d00db6a2` | `local-2026-09-30T19-30-54-574Z` |

The hosted check verifies exact imported text, binary SHA-256, and a persisted
artifact downloaded again through the authenticated public API. The first two
campaigns lack embedded source SHA fields; their source and runner hashes were
captured in pre-launch provenance. Later campaigns also embed the source SHA.
Each campaign retains its normal dashboard, browser evidence and API snapshots.

The live work reserved $206 in total across all recorded launches, then released
$14 for three verified pre-inference failures, leaving $192 in conservative
reservations against the authorized $200 budget. These are reservations, not
measured or invoiced spend. Original attempt provenance is unchanged; releases
are recorded separately. Provider billed cost and incomplete accounting totals
remain unknown.

Retained attempts, including startup failures and probes on later revisions, are
independent measurements. Narrow regression passes do not replace either complete
roster or qualify a changed build. A new complete 35/35 measurement for each exact
configuration remains necessary before production enablement.

## Primary references

- [Architecture](https://developers.openai.com/api/docs/guides/agents-api/architecture)
- [Sessions and turns](https://developers.openai.com/api/docs/guides/agents-api/sessions)
- [Function calls and recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions)
- [Hosted environments](https://developers.openai.com/api/docs/guides/agents-api/environments/openai-hosted)
- [File transport and artifacts](https://developers.openai.com/api/docs/guides/agents-api/environments/files)
