# Docker CI bridge budget guard: implementation plan

Design: `docs/superpowers/specs/2026-11-26-budget-guard-design.md` (approved 2026-11-26).
Scope: generic public bridge source only. No real build, sandbox probe, deploy or
Railway variable change in this plan. Ships disabled unless BUDGET_JSON is set.

## Steps

1. **budget.mjs: configuration.** Parse and validate BUDGET_JSON (USD, small
   hourly rate in micro-USD, global and per-project monthly allowances, opening
   usage per YYYY-MM, verified max setup seconds, fixed TTL 3600 s, evidence
   flags). Malformed config fails startup; missing evidence or unopened month
   makes real admission not ready. Errors never echo config contents.
2. **budget.mjs: ledger.** Versioned JSON ledger in DATA_DIR: policy versions,
   opening entries, reservations (job/request id, project/task/SHA, months,
   micro-USD bound, phase, sandbox name, outcome), holds and audit entries.
   Atomic write with file and directory fsync. Exclusive lock file held for the
   process lifetime; stale lock blocks real admission until reconciled.
   Corrupt, unsupported or missing-after-init ledger fails closed. Config must
   match the latest policy version.
3. **Admission.** In start_build, under one serialized section: dedupe, one
   active job, plan validation, then reserve ceil(rate x (launch timeout + setup
   + TTL) / 3600) in every UTC month the window overlaps, checking global and
   project remaining. Exact fit allowed. Mock mode never touches the ledger.
4. **Runner integration.** Phases: reserved -> launch_intent (persisted before
   create) -> created (sandbox name) -> verified -> terminal. Recheck window and
   holds immediately before create. Create with `lifecycle: { timeoutMs:
   3600000, onTimeout: 'delete', autoResume: false }`, `maxRetries: 0`.
   Refresh and validate effectiveFeatures.timeouts and resources before running
   repository code; mismatch -> cleanup + hold. Uncertain create, failed
   cleanup or interrupted job -> hold. Never refund.
5. **Recovery at startup.** Join ledger and job records; any reservation past
   launch_intent without verified deletion, or an interrupted job, becomes a hold.
6. **Operator CLI `scripts/budget-admin.mjs`.** `init` (baseline from existing
   jobs: clean terminal jobs recorded as history, others become holds),
   `policy` (append policy version / opening entry), `reconcile <reservation>
   --evidence <text>` (closes a hold, keeps the charge), `status`. Offline only;
   refuses while the server holds the lock. Every action writes an audit entry.
7. **MCP surface.** New read-only `get_budget_status`; bounded budget summary in
   build status and list_projects entries (array shape unchanged); concise
   refusal reasons.
8. **Docs.** README, .env.example, skill copies: scope (not an account cap),
   conservative accounting, init/reconcile, approval-before-launch.
9. **Tests (node:test).** Config validation; rounding; exact fit / one over;
   global vs project; month crossing; opening usage; request-id replay and
   conflict; concurrent start_build; second process lock; restart at each
   phase; corrupt/missing ledger; disk write failure; TTL mismatch; unknown
   sandbox; cleanup failure; no refunds; no new-month reset; lifecycle fields
   reach the SDK HTTP request (mock HTTP endpoint, maxRetries 0); mock mode
   untouched. Full `npm test` passes.
10. **Independent code review** of the exact diff; fix until PASS.
11. **Publish** only after the Git email blocker is resolved; deployment and
    E2P BUDGET_JSON configuration are separate approved actions.
