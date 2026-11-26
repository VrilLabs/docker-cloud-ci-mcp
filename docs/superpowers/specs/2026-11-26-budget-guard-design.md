# Docker CI bridge fail-closed budget guard

Status: Approved by the user on 2026-11-26.

## Intent and constraints

Add an operator-controlled cost reservation guard to the generic public bridge,
then configure it privately for E2P. Prevent bridge-controlled launches from
silently exceeding the configured estimate. This is not a Docker account-wide
billing cap or an invoice meter. Other Docker usage, taxes, model-provider
charges, price changes, and platform failure are outside its guarantee.

No real build, sandbox probe, or external deployment is authorized by this
design. Every billable build still needs explicit project/task/40-character-SHA
and forwarded-variable-name approval. E2P native runner and qualifier holds
remain unchanged. Docker's allowance is separate from the approved GCP budget.
Until an operator supplies an approved Docker allowance and reconciled opening
usage, the live bridge's available variable budget is zero.

## Approaches

The user selected a fail-closed durable reservation guard. An estimated usage
tracker alone was rejected because interrupted launches and failed cleanup can
keep billing. Account-wide enforcement is not available through the researched
Docker SDK; dashboard figures are evidence, not an API-enforced cap.

## Evidence and lifetime gate

Docker documents explicit TTL and deletion on expiry:
https://docs.docker.com/ai/sandboxes/cloud/usage/#configure-expiration

Installed SDK @docker/sandboxes 0.53.0 exposes create options
`lifecycle: { timeoutMs, onTimeout, autoResume }`. Kit launch forwards those
options to create. Resource `effectiveFeatures.timeouts` includes
`initialTimeout`, `expiresAt`, `onTimeout`, and `autoResume`.
Local request timeouts do not delete the sandbox or kill its process.

Use the existing small Shell kit, an explicit one-hour server lifetime,
`onTimeout: 'delete'`, and `autoResume: false`. No lifetime extension, resume,
restart, custom kit, or caller-selected resources. Set SDK maxRetries to zero.
Before operational enablement, inspect the exact SDK request serialization with
a mocked HTTP service and verify independently that the selected creation path
does not allocate an unreserved builder. Verify server expiration and billed
setup coverage using existing evidence or a separately approved billable probe.
If setup or any auxiliary compute lacks a finite verified bound, deny launches.
Do not claim the backend lifetime guarantee was tested using only mocks.

Refresh the accepted sandbox and validate effective lifetime/action/resources
before executing repository code. Missing or contradictory fields trigger
cleanup and a durable hold, never continued execution. A failed create response
may still represent an allocated sandbox: treat it as uncertain.

## Configuration and admission

Keep project allowlists in PROJECTS_JSON. Add a separate operator-only
BUDGET_JSON configuration, never a forwarded build variable, with:

- USD currency and a fixed conservative small-compute hourly rate;
- monthly bridge-wide allowance and optional per-project monthly allowances;
- explicit YYYY-MM opening-usage entries and rate/lifetime verification evidence;
- verified maximum billable setup duration and the fixed one-hour runtime TTL.

Absent configuration permits read tools and nonbillable mocks only. Malformed
configuration fails startup; unverified evidence or an unopened month denies
real admission. No auto-reset to an assumed zero-cost new month. Operator
configuration may increase limits only through an explicitly authorized change.
Opening usage covers previous bridge/account usage the operator wishes counted.
All status labels say estimated/reserved, not actual billed.

Before any Docker create, serialize admissions (including request dedupe and
one-active-job checks), validate the task and forwarding plan, and durably reserve
ceil(rate * verified maximum billable seconds / 3600), in integer USD micro-units.
Round upward and reject unsafe integers, negatives, unknown project entries,
unsupported currency, and inconsistent bounds. Check both global and applicable
project remaining allowance. Reserve the full bound in every UTC month the
allocation could overlap, including worst-case setup delay. No future opening
entry means deny a boundary-crossing launch. Exact-fit admission is permitted.
Request-id replay returns the same job without a second allocation/reservation;
conflicting reuse fails. Mock execution never consumes real allowance.

## Durable storage and recovery

Use the existing DATA_DIR persistent volume. Persist one versioned ledger with
policy snapshot, opening entries, reservations, and global hold state. Each
reservation includes job/request id, project/task/SHA, involved months, cost
bound, launch phase, sandbox identity when known, and terminal outcome.
Use atomic replacement with file fsync and parent-directory fsync. Fail closed
on persistence errors, corrupt/unsupported ledgers, missing ledger after
initialization, and policy/history inconsistencies. Fresh initialization is an
explicit operator action, not an automatic empty-ledger fallback.

Acquire an exclusive process ownership lock before serving real admissions.
Concurrent instances must not launch from the same ledger. Retain the lock
after a crash and require authorized reconciliation, rather than guessing that
a stale lock means no orphan. Different DATA_DIR copies cannot share a budget;
document one authoritative volume/instance as a deployment prerequisite.

Write reservation before job persistence or any launch; write launch-intent
before create. Never refund the bound automatically, including launch errors,
early deletion, and failed jobs. This deliberately sacrifices utilization for
simple conservative accounting. Recovery joins ledger and jobs by identity;
missing records, launch-intent, interrupted jobs, uncertain create outcomes,
and failed sandbox/secret cleanup block all subsequent real launches.
Successfully persisted and verified deletion closes the reservation's outcome
but its cost remains charged. A pre-launch abort may be closed with no orphan
hold only when durable phases prove create could not have been attempted.

Provide an offline operator reconciliation CLI, not an agent-callable MCP reset.
It requires explicit reservation identity and evidence of deletion/no allocation,
validates the ledger, records an append-only audit entry, and does not erase
charges. Reconciliation is a separately authorized operational action.

## Integration and observable behavior

Add an authenticated read-only `get_budget_status` MCP tool for global/project
opening, charged reservations, remaining estimate, readiness, and hold reasons.
Add bounded budget summaries to existing build status and project descriptions,
preserving list_projects' current array shape. Return concise refusal reasons
without leaking config contents, credentials, or private evidence.

Update README, .env.example, and installed copies of the bridge skill with
scope, conservative accounting, initialization, reconciliation, operator approval,
and read-before-launch guidance. Configure E2P privately only after its allowance
is approved. Do not add automatic billable CI triggers or retry fallback.
Inspect E2P's existing CI call path before proposing exact wiring changes;
retain retry:0 and exact-head review/CI gates.

## Validation and rollout

Tests must cover actual MCP admission in mock/fake-client mode as well as units:
exact fit and one-unit-over allowance; global/project ceilings; integer rounding;
month crossing; opening usage; repeated/conflicting request ids; concurrent calls;
multiple processes; restart at each persistence/launch phase; ledger corruption,
missing ledger, disk failures; unknown sandbox identity; TTL response mismatch;
cleanup and status/persistence failure; no automatic refunds or new-month reset.
Use a mocked SDK HTTP endpoint to verify lifecycle fields and no replay.
Run the existing Node tests, with no local Cargo/rustc/Tauri build or tests.
Fresh independent code review must pass before publication.

Live enablement requires approved limit/opening usage, authoritative persistent
volume, verified rate/charge/lifetime evidence, and separately approved deployment.
If those gates remain unresolved, ship the feature disabled and report the gaps.
The Git email blocker must be resolved by the user; never override Git identity.

## Builder-check resolutions (author's calls)

- Admission timing: the reservation window starts at reservation time and covers
  the launch timeout plus the server TTL. Immediately before Docker create (after
  secret creation and status reporting), recheck that the window still fits the
  reserved months and that no hold exists; otherwise abort before create, record
  a pre-launch abort, and keep the charge.
- Initialization baseline: the offline init command scans existing job records.
  Clean terminal jobs (deleted sandbox and secrets) are recorded as pre-ledger
  history and do not block. Any queued, running, interrupted or cleanup-failed
  legacy job becomes an unresolved hold that must be reconciled individually.
  Their cost belongs in operator-supplied opening usage.
- Policy changes: BUDGET_JSON must match the ledger's latest policy version, or
  real admission fails closed. Allowance changes and new-month opening entries
  go through the same offline operator CLI, which appends a versioned policy
  entry with an audit record. Earlier policies and charges are never rewritten.

## Builder discretion

Choose module boundaries and test helpers to match current ES modules and
node:test. Choose bounded schema sizes and concise output formatting. No database
or new service is required. Do not relax the fail-closed gates for convenience.
