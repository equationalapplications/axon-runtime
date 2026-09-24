[![npm version](https://img.shields.io/npm/v/axon-runtime)](https://www.npmjs.com/package/axon-runtime)
[![CI](https://img.shields.io/github/actions/workflow/status/equationalapplications/axon-runtime/ci.yml?branch=main)](https://github.com/equationalapplications/axon-runtime/actions/workflows/ci.yml)
[![npm downloads](https://img.shields.io/npm/dm/axon-runtime)](https://www.npmjs.com/package/axon-runtime)
[![Node.js](https://img.shields.io/node/v/axon-runtime)](https://www.npmjs.com/package/axon-runtime)
[![License](https://img.shields.io/github/license/equationalapplications/axon-runtime)](LICENSE)

# Axon Runtime

A distributed worker runtime for AI coding agents. A controller dispatches
goal-shaped jobs ("fix this test", "add this endpoint") to worker services on
other machines. Each worker runs its own tool-calling model loop inside a
disposable git worktree and returns a patch or a report, with telemetry and
cost accounting, under hard step, time, and spend limits.

Axon is how the [Equational Applications](https://equationalapplications.com)
agent fleet spreads spec-driven implementation work across spare laptops.
This repository is the generic runtime; machine inventory, tokens, and
network topology live in a separate private deployment repo.

**Status:** v0.1. Dispatch works end to end over SSH tunnels, with Linux and macOS
workers running under dedicated OS users. Windows onboarding and metrics-driven cross-node
placement are in progress.

## How it works

```
 controller                                     worker node (one per machine)
┌──────────────────────┐   SSH -L tunnel    ┌──────────────────────────────────┐
│ axon CLI             │ ─────────────────▶ │ Fastify service on 127.0.0.1     │
│  dispatch / status   │   bearer token     │  ├─ validate: contract, allowlist│
│  cancel / artifact   │                    │  │  size + spend ceilings        │
│                      │ ◀───────────────── │  ├─ JobPool: concurrency, cancel │
│ Ledger (SQLite)      │  result envelope   │  ├─ BudgetGuard: daily USD cap   │
│  per-node metrics    │  + telemetry       │  ├─ git mirror → worktree per job│
└──────────────────────┘                    │  ├─ Harness: model ⇄ run_shell   │
                                            │  └─ JobStore (SQLite), artifacts │
                                            └──────────────────────────────────┘
                                                      │
                                                      ▼
                                   any OpenAI-compatible /chat/completions endpoint
```

1. The controller sends a versioned **job request**: repo, ref, goal, optional
   context files, constraints (`max_harness_steps`, `timeout_seconds`,
   `max_spend_usd`), and the output it wants (`patch` or `report`).
2. The worker validates it with Zod, checks the repo allowlist and the node's
   ceilings, and admits it against the node's daily spend cap, or returns a
   typed rejection (`repo_not_allowlisted`, `queue_full`, `budget_exhausted`, …).
3. The worker checks the ref out into a fresh worktree from a shared bare
   mirror, then runs a tool loop against the configured model endpoint. The
   only tool is `run_shell`, scoped to the worktree.
4. Every model step is written to a durable spend ledger before the job's
   cost checkpoint, so the daily cap never undercounts, even across crashes.
5. The job ends in an **envelope**: status, exit reason (`completed`,
   `step_cap`, `timeout`, `budget_exceeded`, `cancelled`, …), the diff (inline
   or as an artifact), and telemetry (tokens, cost estimate, duration, model,
   runtime and harness versions).
6. The controller records every dispatch and envelope in its own ledger.
   Routing stays explicit: every dispatch names its target node.

## Security model

- **Loopback only.** Workers bind to `127.0.0.1`; the only way in is an SSH
  port forward.
- **Bearer auth on every route** except `/healthz`, compared in constant time.
- **Allowlisted child environment.** The agent's shell sees only `PATH`, `HOME`,
  `LANG`, `LC_ALL`, `TZ`, and `TMPDIR`. `SSH_AUTH_SOCK` is excluded on
  purpose, so a job can't authenticate as the operator.
- **No push access.** Work comes back as a diff; the worker never pushes.
- **Secrets by reference.** Config files name environment variables
  (`bearer_token_env`, `api_key_env`); secrets never live in config.
- **Bounded input and output.** Goal, context, and inline patch sizes are
  capped per node.
- **Crash recovery.** On startup, jobs left `running` are marked
  `interrupted`, orphaned worktrees are removed, and expired artifacts are
  purged.
- **OS containment is left to the deployment.** Run the worker as a
  dedicated, non-login OS user.

## Quick start

Requires Node.js 22+ and git.

```bash
npm ci
npm run build

# Worker
export AXON_NODE_TOKEN=$(openssl rand -hex 32)
export AXON_ENDPOINT_KEY=sk-...          # key for the endpoint in node.json
node dist/worker.js examples/node.json   # listens on 127.0.0.1:8787 (AXON_PORT)

# Controller: forward a local port to the worker
ssh -N -L 18787:127.0.0.1:8787 worker-host &
export AXON_TOKEN_NODE_01=$AXON_NODE_TOKEN
export AXON_NODES=examples/nodes.json AXON_LEDGER=./ledger.db

echo "Make the failing date test pass" > goal.md
npx axon dispatch --node node-01 --repo git@github.com:your-org/your-repo.git \
  --goal-file goal.md --wait
npx axon status   --job <job_id>
npx axon artifact --job <job_id> -o patch.diff
npx axon metrics  --node node-01
```

Set `AXON_EXECUTOR=fake` on a worker to exercise the whole pipeline without
calling a model.

## Worker API

| Method | Path | Purpose |
|---|---|---|
| GET | `/healthz` | Liveness (no auth) |
| GET | `/nodeinfo` | Node ID, runtime and contract versions, capacity |
| POST | `/jobs` | Submit a job (idempotent on `job_id`) |
| GET | `/jobs/:id` | Current status or final envelope |
| POST | `/jobs/:id/cancel` | Cancel a running job |
| GET | `/jobs/:id/artifact?id=` | Fetch an artifact such as `patch.diff` |

The contract lives in [`src/contract/schema.ts`](src/contract/schema.ts)
(`CONTRACT_VERSION = 2`).

## Development

```bash
npm test            # unit + in-process integration tests
npm run typecheck
AXON_SSH=1 npm test   # also runs the real SSH tunnel round trip (needs key-based `ssh localhost`)
AXON_LIVE=1 npm test  # also calls a real model endpoint
```

Cost figures are estimates from fixed per-token rates in
`src/harness/adapter.ts`. Treat them as budget guards, not billing.

## License

MIT © Equational Applications LLC
