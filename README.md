# Docker Cloud CI MCP Bridge

A small, single-user MCP server that runs operator-approved CI tasks in Docker cloud sandboxes. An agent calls it over HTTPS (`/mcp`, bearer API key); the bridge clones one exact commit of an allowlisted repository inside a fresh sandbox, runs the approved script, returns status, logs and artifacts, and deletes the sandbox.

It is a fallback CI runner, not a proxy for Docker's MCP Gateway. It needs no Docker socket, host shell, OAuth callback, model API key or `sbx` installation: it talks to Docker through the official Sandboxes SDK with a Docker ID and personal access token.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/docker-agentic-cloud-ci-bridge?utm_medium=integration&utm_source=button&utm_campaign=docker-agentic-cloud-ci-bridge)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/VrilLabs/docker-cloud-ci-mcp)

Fly.io has no deploy button; see [Deploy on Fly.io](#deploy-on-flyio).

Every host must run **exactly one instance with a persistent volume**: the one-build-at-a-time rule, `request_id` de-duplication, job records and the budget ledger all live on that instance's disk.

## Quick start (local, Node 22.9+)

1. `npm ci`, then `cp .env.example .env; cp projects.example.json projects.json; chmod 600 .env`.
2. Generate a key with `openssl rand -hex 32` and put it in `BRIDGE_API_KEY`.
3. Edit `projects.json` to allow only repositories and scripts you trust. Callers can pick only listed project/task pairs at an exact 40-character commit SHA; they cannot supply a URL, shell command, kit or secret.
4. `npm test`, then `MOCK_DOCKER=1 npm start` and, in another terminal, `node --env-file=.env scripts/smoke.mjs`. Mock mode runs a fake build with no sandbox and no cost.
5. For real builds, create a Docker PAT with **Allow Cloud Sandboxes access** (requires an active Agentic Platform subscription; sandbox compute is billed separately), set `DOCKER_ID` and `DOCKER_PAT`, configure the [budget guard](#budget-guard) and set `MOCK_DOCKER=0`. Real builds are refused until the budget guard is configured.
6. Use a disposable repository for the first real build. The `shell` kit has git, node and npm; scripts must bootstrap any other toolchain from trusted, pinned sources.

## Deploy on Railway

Use the button above, or the CLI (`railway login`, from this directory; `railway.json` sets the start command, `/healthz` healthcheck, restart policy and one replica):

```bash
railway init --name docker-cloud-bridge
railway add --service docker-ci-bridge --variables "MOCK_DOCKER=1"
railway volume add --mount-path /data      # required: the app refuses to start on Railway without a volume
printf %s "$(openssl rand -hex 32)" | railway variable set BRIDGE_API_KEY --stdin --skip-deploys
railway up --ci --service docker-ci-bridge   # first deploy in mock mode (no billable sandboxes)
railway domain --service docker-ci-bridge    # public HTTPS URL: https://<domain>/mcp
```

The template asks for `DOCKER_ID`, `DOCKER_PAT` and `PROJECTS_JSON` and generates `BRIDGE_API_KEY`. Set secrets in the Railway dashboard, never on a command line. When `RAILWAY_ENVIRONMENT_NAME` is set, the app binds to `0.0.0.0` and `$PORT` and uses the volume as `DATA_DIR` automatically. A service with a volume redeploys with brief downtime, and any variable change redeploys, which kills a running build (it becomes `interrupted`). Shell access for budget commands: `railway ssh`.

## Deploy on Render

Use the button above or create a Blueprint from `render.yaml`: one `starter` web service (persistent disks need a paid instance type) with a 1 GB disk at `/var/data`, a generated `BRIDGE_API_KEY`, and prompts for `DOCKER_ID`, `DOCKER_PAT`, `PROJECTS_JSON` and `BUDGET_JSON` (leave `BUDGET_JSON` empty until the budget guard is set up). The app starts in real mode, so provide `DOCKER_ID` and `DOCKER_PAT` at first deploy, or add `MOCK_DOCKER=1` to the Blueprint before deploying. Real builds remain refused until the budget guard is configured. Render redeploys on every push to the connected branch. Shell access: the service's **Shell** tab.

## Deploy on Fly.io

`fly.toml` and `deploy/fly.Dockerfile` run one always-on machine with a 1 GB volume at `/data`. The app starts in real mode, so provide `DOCKER_ID` and `DOCKER_PAT` before the first boot, or set `MOCK_DOCKER=1` before it boots. Real builds remain refused until the budget guard is configured. Create `.env.fly` in the repo root for the secrets import; `.env.fly` is excluded from Git and the Docker build context:

```bash
fly launch --copy-config --no-deploy --name <your-app>
fly volumes create bridge_data --size 1 --region iad
chmod 600 .env.fly
fly secrets import < .env.fly && rm .env.fly   # NAME=VALUE lines; PROJECTS_JSON and BUDGET_JSON must each be one-line JSON
fly deploy --ha=false             # one machine only
```

Keep `auto_stop_machines = "off"`: a stopped machine kills in-flight builds. Shell access: `fly ssh console`.

## Other hosts

Any host that runs one Node 22.9+ process with a persistent block volume works: set `HOST=0.0.0.0`, `PORT` and `DATA_DIR`, and put HTTPS in front. Hosts without a persistent volume for a single instance, such as Heroku, DigitalOcean App Platform or Google Cloud Run, are not supported: job records, de-duplication and the budget ledger would be lost on restart.

## Configuration

| Variable | Notes |
|---|---|
| `BRIDGE_API_KEY` | Required, at least 32 characters. Clients send `Authorization: Bearer <key>`. |
| `DOCKER_ID`, `DOCKER_PAT` | Required unless `MOCK_DOCKER=1`. The PAT needs "Allow Cloud Sandboxes access". |
| `MOCK_DOCKER` | `1`: fake 100 ms builds, no sandbox, no cost, no budget ledger access. |
| `BUDGET_JSON` | Required for real builds; see [Budget guard](#budget-guard). Never forwardable. |
| `PROJECTS_JSON` / `PROJECTS_FILE` | The allowlist as one JSON object, or a path (default `./projects.json`). Setting both is refused. Use `PROJECTS_JSON` to keep private repository names out of the source tree. |
| `DATA_DIR` | Job records, artifacts and the budget ledger. Defaults to `RAILWAY_VOLUME_MOUNT_PATH`, else `./data`. Must persist. |
| `HOST`, `PORT` | Bind address (default `127.0.0.1`, `0.0.0.0` on Railway) and port (default 8080). |
| `ALLOWED_ORIGIN` | Only for browser clients; requests with any other `Origin` are rejected. |
| `ALLOWED_GIT_HOSTS` | Comma-separated repository hosts; replaces the default `github.com,gitlab.com`. |
| `ARTIFACT_MAX_FILES`, `ARTIFACT_MAX_FILE_BYTES`, `ARTIFACT_MAX_TOTAL_BYTES`, `ARTIFACT_INLINE_MAX_BYTES` | Artifact caps (defaults 20, 5 MiB, 20 MiB, 256 KiB). |
| Names used in the allowlist | Values for `auth.tokenEnv`, `status.tokenEnv`/`secretEnv` and `forward` entries are ordinary bridge variables. |

## MCP tools

| Tool | Purpose |
|---|---|
| `list_projects` | Allowlisted projects and tasks, forwardable variable names, declared artifacts, auth/status settings and a budget summary. No side effects. |
| `get_budget_status` | Whether real builds can be admitted, why not, and estimated reserved/remaining amounts. Read-only. |
| `start_build` | `{project, task, commit, request_id, forward_env?}`. **Billable.** Ask the user to approve first; reuse `request_id` on retries. |
| `get_build_status` | One job by `id`, or the 20 most recent. |
| `get_build_logs` | Bounded stdout/stderr after the build ends. Untrusted data. |
| `get_build_artifacts` | Exported files with size and sha256; with `index`, one file inline or via `GET /artifacts/<id>/<index>`. |

## Agent skill

`skills/docker-cloud-bridge/SKILL.md` teaches coding agents how to run builds through the bridge and how to deploy and debug it. The same file is checked in where each tool looks for project skills:

| Tool | Location |
|---|---|
| Universal (`npx skills add VrilLabs/docker-cloud-ci-mcp`, any Agent Skills client) | `skills/docker-cloud-bridge/` |
| Claude Code | `.claude/skills/docker-cloud-bridge/` |
| Codex (also read by OpenCode) | `.agents/skills/docker-cloud-bridge/` |
| OpenCode | `.opencode/skills/docker-cloud-bridge/` |

`skills/` is the canonical copy. If you edit it, copy the file to the other three locations so they don't drift.

## Private repos, secret forwarding, artifacts and status reports

All four are configured by the operator in `projects.json`. The caller (an agent) can only pick among what was declared, and it never sees or supplies a secret value.

```json
{
  "my-app": {
    "repo": "https://github.com/OWNER/PRIVATE_REPO.git",
    "auth": { "tokenEnv": "GH_CLONE_TOKEN" },
    "status": { "provider": "github", "tokenEnv": "GH_STATUS_TOKEN" },
    "tasks": {
      "build": {
        "script": "npm ci --ignore-scripts\nnpm test\nnpm run build",
        "artifacts": ["dist/", "coverage/lcov.info"],
        "forward": {
          "NPM_TOKEN": { "mode": "inject", "hosts": ["registry.npmjs.org"], "header": "Authorization", "format": "Bearer %s" },
          "DEPLOY_ENV": { "mode": "env" }
        }
      }
    }
  }
}
```

A task may still be a plain string (the script), exactly as before.

**Private repositories (`auth`).** `tokenEnv` names a bridge environment variable holding a read-only token (a fine-grained GitHub token with *Contents: read* on that one repo, or a GitLab deploy/project token with `read_repository`). For each build the bridge stores it as a Docker stored secret and attaches it to the sandbox; Docker's proxy adds the credential to requests for the repo host only, so the token is **never written into the sandbox**. GitHub uses Docker's native `github` secret type (Docker rejects custom injection for managed hosts). Other forges get a custom `Authorization` injection (`scheme` `basic` (default, user `oauth2` on gitlab.com or `username`) or `bearer`). Repo hosts default to `github.com,gitlab.com`; set `ALLOWED_GIT_HOSTS` (comma separated) to use others. It replaces the default list, so include `github.com`/`gitlab.com` if you still need them. The stored secret is deleted when the build ends, and any `bridge-*` secret left by a crash is purged at startup.

**Forwarding environment variables (`forward` + `forward_env`).** The agent calls `start_build` with `forward_env: ["NPM_TOKEN"]`: names only. A name is accepted only if the operator listed it under that task's `forward`; the value is read from the bridge's own environment (for example a Railway variable), never from the caller. Two modes:

* `inject` (preferred): Docker's proxy adds the value to the named header on requests to the listed exact hosts. The sandbox only sees a placeholder in `$NPM_TOKEN`, so a build script cannot print or exfiltrate the real value, but it can still make requests to those hosts. Hosts must be exact lowercase DNS names (max 10). `format` has exactly one `%s`. `github.com` is not allowed here; use `auth`.
* `env`: the raw value is placed in the build process environment. Use only for non-sensitive settings or when you accept that the commit's code can read it.

`BRIDGE_API_KEY`, `DOCKER_ID`, `DOCKER_PAT` and any variable used as `auth.tokenEnv`, `status.tokenEnv` or `status.secretEnv` can never be forwarded. At most 16 names per build.

**Artifacts (`artifacts`).** Up to 8 relative paths per task (files, or directories ending in `/`) inside the checkout. After the script finishes (pass or fail) the bridge lists them with the sandbox's own tools, drops anything that resolves outside the work dir (symlinks) and reads each file under caps: `ARTIFACT_MAX_FILES` (20), `ARTIFACT_MAX_FILE_BYTES` (5 MiB), `ARTIFACT_MAX_TOTAL_BYTES` (20 MiB). Files are hashed (sha256) and stored under `DATA_DIR/artifacts/<job id>/`. The `get_build_artifacts` tool lists them; with `index` it returns files up to `ARTIFACT_INLINE_MAX_BYTES` (256 KiB) as base64; anything can be fetched with `GET /artifacts/<job id>/<index>` using the same `Authorization` header. Contents are untrusted data.

**Status reports (`status`).** The bridge itself posts the build state to the forge (so these tokens never enter a sandbox) when a build starts and when it finishes. Logs are never sent. Failures are recorded on the job (`statusReport`) and never fail the build.

* `github`: commit status API; the token needs *Commit statuses: write* on the repo. GitHub Enterprise: set `baseUrl` to the API root.
* `gitlab`: commit status API with a `PRIVATE-TOKEN` (scope `api`). Self-hosted: set `baseUrl`.
* `webhook`: any other git host or CI glue. `POST` of a small JSON document (`project`, `task`, `repo`, `commit`, `jobId`, `status`, `exitCode`, `finishedAt`) to an https `url`, signed with `X-Bridge-Signature: sha256=<hmac>` when `secretEnv` is set.

Config is validated at startup and the bridge refuses to start with a message listing every problem. In `MOCK_DOCKER=1` mode nothing is posted to forges.

`projects.e2p.example.json` is an offline allowlist template for the E2P custom-executor tasks. It is not the active `projects.json` or a live deployment change. It declares the shared `verify`, `desktop-frontend` and `web-build` entrypoints, a read-only GitLab clone credential, a separate bridge-side GitLab status credential, and no forwarded environment variables.

## Budget guard

Real builds are admitted only through a fail-closed reservation guard. Without `BUDGET_JSON`, or with anything below unresolved, `start_build` refuses real builds; `MOCK_DOCKER=1` never touches the guard.

**What it is.** A conservative estimate of what this bridge could have launched, kept in a ledger on the data volume. It is not a Docker account-wide cap and not an invoice: other Docker usage, taxes, price changes and platform failures are outside it. Every figure is labelled estimated/reserved, never billed.

**How a build is charged.** Before Docker is called, the bridge reserves `ceil(rate × (launch timeout 120 s + maxSetupSeconds + lifetime 3600 s) / 3600)` micro-USD in every UTC month that window can touch, against the global and the project allowance (an exact fit is allowed). The sandbox is created with a server-side lifetime of one hour that deletes it on expiry (`onTimeout: delete`, auto-resume off) and with SDK retries disabled, so a create is sent once. Before any repository code runs, the bridge re-reads the sandbox and stops (deleting it) if its effective lifetime, expiry action or size differs. Reservations are never refunded, including for failed or aborted builds. Only one reserved build is open at a time.

**Holds.** A build that ends with an uncertain create, a failed sandbox or secret deletion, a failed lifetime check, or a bridge restart mid-build becomes a hold. Any unresolved hold blocks all real builds until an operator reconciles it.

**`BUDGET_JSON`** (operator-only; it can never be forwarded to a build). All amounts are integer micro-USD (1 USD = 1000000):

```json
{
  "version": 1, "policyVersion": 1, "currency": "USD",
  "smallHourlyRateMicroUsd": 500000,
  "monthlyAllowanceMicroUsd": 10000000,
  "projects": { "my-app": { "monthlyAllowanceMicroUsd": 5000000 } },
  "opening": { "2026-11": { "globalMicroUsd": 0, "projects": { "my-app": 0 } } },
  "maxSetupSeconds": 300, "ttlSeconds": 3600,
  "evidence": { "rateVerified": true, "lifetimeVerified": true, "setupVerified": true, "reference": "where the operator checked these" }
}
```

* `smallHourlyRateMicroUsd`: a conservative hourly price for the small sandbox (2 CPU, 4 GiB), from your Docker plan. The numbers above are placeholders, not Docker's prices.
* `opening`: usage to count before the bridge's own reservations, per UTC month (earlier builds, other Docker use you want counted). A month with no opening entry admits nothing; there is no automatic reset to zero at a new month.
* `evidence`: set each flag to `true` only after checking it yourself (the hourly rate, that the one-hour lifetime deletes sandboxes on your account, and that setup fits `maxSetupSeconds`). Any `false` keeps real builds disabled.
* Malformed configuration stops startup; error messages name fields, never values.

**Operator commands.** Each action is audited and charges are never erased. They refuse while a real-mode server holds the ledger lock, so open a maintenance window: set `MOCK_DOCKER=1` (the server then never takes the lock and cannot start real builds), open a shell in the instance (`railway ssh`, Render **Shell**, `fly ssh console`), run the commands there, then set `MOCK_DOCKER=0`. They read the same `DATA_DIR`, `BUDGET_JSON` and allowlist variables as the server:

```bash
node scripts/budget-admin.mjs init --authorized-by <you>        # create the ledger; existing job records become history or holds
node scripts/budget-admin.mjs status --authorized-by <you>
node scripts/budget-admin.mjs policy --authorized-by <you>      # after editing BUDGET_JSON: bump policyVersion first
node scripts/budget-admin.mjs reconcile --authorized-by <you> --hold <id> --evidence "<what you checked in Docker Console>"
node scripts/budget-admin.mjs reconcile --authorized-by <you> --stale-lock --evidence "<why no bridge is running>"
```

`BUDGET_JSON` must match the ledger's latest policy version or real builds stay disabled, so every allowance change or new-month opening entry goes through `policy`. Keep one bridge instance per data volume: the ledger lock refuses a second one. Agents read the guard with `get_budget_status`; there is no MCP tool that resets or reconciles it.

## Connect Perplexity

Plugins -> Add custom -> Add MCP connector -> Remote.
URL: https://YOUR_DOMAIN/mcp
Transport: Streamable HTTP. Authentication: API Key, not OAuth.
API key: BRIDGE_API_KEY. Server expects `Authorization: Bearer <key>`.
The official Perplexity guide does not specify the API Key field's exact wire encoding. Validate this with smoke.mjs and connector setup; if your client sends a different standard authorization format, adjust the auth middleware deliberately, not by disabling auth. There is no arbitrary custom-header field in the connector form.

Tools: list_projects, get_budget_status, start_build, get_build_status, get_build_logs, get_build_artifacts.
Example request: list approved tasks and the budget status, then ask me to approve a test of project my-app at exact commit SHA. Start only after approval, generate a UUID request_id, and poll status. Reuse the SAME request_id when retrying a timed-out start call. Read logs after completion.

## Behavior and limitations

* Uses official SDK PAT exchange, shell kit launch, waitUntilRunning, processes.run, refresh/delete/waitUntilDeleted.
* start_build returns a job ID immediately; poll status. Results and bounded tail logs persist in data/. Logs are collected on process completion, not live streamed. The SDK can buffer more output before truncation here; constrain noisy build output in your trusted script.
* One active job, one process/replica. request_id deduplication retained on disk. No distributed lock or queue. Local disk must persist across restarts. Manually prune old job records when idle; there is no retention scheduler.
* Process timeout is ten minutes; launch/wait timeouts two minutes each. These local timeouts do not stop billing. The bound is the sandbox's server-side lifetime of one hour with delete on expiry, requested on create and checked before the script runs; it has been checked against the SDK's request format, not against a live Docker account, so verify it on yours before setting `evidence.lifetimeVerified`. Cleanup is attempted in finally, including failed builds. SDK timeouts or a crash can still leave a sandbox (until it expires) or stored secrets; on restart active records become interrupted and holds, so inspect Docker Console before reconciling. A creation timeout can occur before the sandbox name reaches the bridge. Set account budget alerts and review Console resources.
* Default SDK small compute: 2 CPUs/4 GiB. No network policy is configured by this implementation (Docker rejected inline network policies on the account used for verification; use Docker governance policies if you need egress control). Private repos, forwarded variables, artifacts and status reports are opt-in per project in `projects.json` (see the section above). Do not put PATs in repo URLs or scripts.
* Default workflow is CI (test/build). No deployment/registry credentials, prod deploy, rollback, cancellations or automatic failover scheduler. Add a fixed allowlisted deployment task only after designing narrowly scoped credentials, independent approval enforcement and rollback. Exported artifacts accumulate on the volume (capped per build, no retention scheduler); prune `DATA_DIR/artifacts/` when idle.
* Task execution is a billable, side-effecting operation, even for tests. Tool description instructs client to request approval, but does NOT provide a server-side human approval gate. Possession of bridge API key permits running ANY allowlisted task/commit. Use only trusted connector owners. Do not add production deployment credentials unless you implement an independent approval gate.
* An allowlisted repo is not a security boundary against malicious code within that repo. Tests/package scripts execute code from the selected commit. Do not execute unreviewed fork/PR code with secrets. npm ci --ignore-scripts only disables installation lifecycle scripts; npm test/build still execute code.
* Logs are untrusted and may include secrets deliberately printed by code. The bridge key, Docker PAT, the repo token and every forwarded value are redacted from logs, job records, error messages and artifact names; this is not a generic secret scanner and artifact contents are not scanned. The Docker PAT remains on the bridge host and is never injected into a sandbox.
* Railway provides HTTPS only; there is no rate limiting, so keep the API key secret (32+ chars enforced) and rotate credentials. Origin-bearing requests rejected unless ALLOWED_ORIGIN matches; non-browser MCP requests normally omit Origin.

## Verification status

`npm test` runs offline (Node test runner, fake Docker client, plus a local HTTP endpoint that checks the exact create request the Docker SDK sends). The Railway deployment is live and served real Docker builds in November 2026 before the budget guard was added; the budget guard itself has only been exercised by tests, and the one-hour server-side lifetime has not yet been observed on a live Docker account. `fly.toml` parses as TOML, but neither the Render nor Fly deployment has been deployed.

## Official references consulted

https://docs.docker.com/ai/sandboxes-api/
https://docs.docker.com/ai/sandboxes-api/authentication/
https://docs.docker.com/ai/sandboxes-api/get-started/
https://docs.docker.com/ai/sandboxes-api/concepts/
https://docs.docker.com/ai/sandboxes-api/cookbook/create-your-first-sandbox/
https://docs.docker.com/ai/sandboxes-api/cookbook/run-your-first-command/
https://docs.docker.com/ai/sandboxes-api/limits/
https://github.com/modelcontextprotocol/typescript-sdk/tree/1.32.2
https://www.perplexity.ai/help-center/en/articles/13915507-adding-custom-remote-connectors

Docker CLI cloud secret store and web Agentic Platform secrets are separate. Earlier chat advice implying they are interchangeable was inaccurate. This bridge authenticates directly through the documented SDK API, not by borrowing the Gateway's OAuth session.
