# Investigation — Roadmap Step 2: Guidance delivered while the job runs

> specs/guidance-while-running/investigation.md · draft, not a spec ·
> Written against main `476b56b` (clean tree). Every factual claim cites
> file:line at that revision. Style follows
> `specs/guidance-in-job/investigation.md`.

## 0. What step 2 asks for

Roadmap step 2 (docs/ROADMAP.md:52-66) requires a spec that settles two
things "this runtime does not have today":

1. "a way to load an extension into the harness" (docs/ROADMAP.md:59)
2. "a read-only way out of the worker to the source of the guidance"
   (docs/ROADMAP.md:59-60)

The roadmap itself flags that "both touch the security model in the
README" and that step 2 "loosens the containment that step 1 keeps"
(docs/ROADMAP.md:61-62, 65-66).

**A framing correction the spec must adopt from the start:** the roadmap's
wording ("load an extension into the harness", "the backing agent") is
written as if the harness spawned an external agent binary. It does not.
Step 1's harness (`HARNESS_VERSION = 'deepseek-harness-0.1'`,
src/harness/adapter.ts:8) is an in-process OpenAI-compatible
`/chat/completions` tool loop (src/harness/adapter.ts:112-275) driven by
`fetch` (src/harness/adapter.ts:141-151). There is no spawned binary, no
CLI args, no agent-side config file. "Extension" in this codebase can
only mean one of the loop's *composed inputs*: the tools array, the
system message, or the user message. The spec should say this plainly
before designing anything.

---

## 1. How the harness works today (Q1)

### 1.1 Endpoint selection — not binaries

- The adapter is configured from `DeployConfig.endpoint`: `base_url`,
  `model`, `api_key_env` resolved to a key via the environment at config
  load (src/config/deploy.ts:41-49, 99-105; requireEnv at
  src/config/deploy.ts:76-81 — empty-string env values are rejected).
- There is exactly one "backing agent": any endpoint that speaks
  `POST {base_url}/chat/completions` (src/harness/adapter.ts:141). The
  README says the same: "any OpenAI-compatible /chat/completions
  endpoint" (README.md:40). There are no alternate binaries and no CLI
  args to compare.
- Cost is a fixed-rate estimate: `RATE_IN_PER_MTOK = 0.14`,
  `RATE_OUT_PER_MTOK = 0.28` (src/harness/adapter.ts:11-12); README
  disclaims these as "budget guards, not billing" (README.md:233-234).

### 1.2 The tool loop

- One executor instantiates one adapter per job (src/executor/local.ts:35-46),
  passing `endpoint`, `extraSystemPrompt`, `fetchImpl`, and an `onStep`
  cost callback that aborts via a dedicated `AbortController` when
  `cost_usd > job.constraints.max_spend_usd` (src/executor/local.ts:39-45).
- `run()` seeds `messages` with exactly one `system` and one `user`
  message (src/harness/adapter.ts:113-116) and loops while
  `steps < job.constraints.max_harness_steps` (adapter.ts:129). Each
  request posts `{ model, messages, tools: TOOLS }` (adapter.ts:147).
- The system message is `SYSTEM_PROMPT` — four sentences about the
  disposable worktree, no push access, and stopping when done —
  composed once in the constructor with the optional operator
  addendum: `${SYSTEM_PROMPT}\n\n${opts.extraSystemPrompt}`
  (src/harness/adapter.ts:74-79, 107-109).
- Termination paths: assistant message with no `tool_calls` →
  `completed` with the content as summary (adapter.ts:257-261); loop
  exhaustion → `step_cap` (adapter.ts:274); `signal.aborted` at any
  checkpoint → `cancelled` (adapter.ts:130, 155, 201, 214, 271);
  retry exhaustion / non-retryable status → `endpoint_error`
  (adapter.ts:159, 177, 191). The pool additionally imposes wall-clock
  timeout via `setTimeout(() => this.cancel(...))` and classifies it
  `timeout` (src/service/pool.ts:163, 168), and the budget abort
  surfaces as `budget_exceeded` (src/executor/local.ts:41-44, 55).
- `HARNESS_VERSION` is reported in telemetry and the run result
  (src/executor/local.ts:62; src/service/pool.ts:193).

### 1.3 `extra_system_prompt`

- Optional deploy-config string, ≤ 16,384 UTF-8 bytes, must not be
  empty/whitespace (src/config/deploy.ts:32-40). Startup logs presence
  and byte count only, never wording (src/worker.ts:43-47, 51).
- It is appended to the built-in system prompt once per adapter
  (src/harness/adapter.ts:107-109) and rides in every request body
  (comment at adapter.ts:104-106). Tests pin the composition
  (tests/harness/adapter.test.ts:615-649).
- README's rule: "Job submitters cannot set or override it — it is
  operator-owned and applies to every job on the node" (README.md:100-101).
  This is the D5 system-channel boundary in code.

### 1.4 `run_shell` and worktree containment

- `TOOLS` is a module-level constant with exactly one function tool,
  `run_shell`, whose parameters are `{ command: string }`
  (src/harness/adapter.ts:31-44). The system prompt tells the model it
  has "no push access" (adapter.ts:77); README: "The only tool is
  `run_shell`, scoped to the worktree" (README.md:51) and "No push
  access. Work comes back as a diff; the worker never pushes"
  (README.md:69).
- `runTool` parses the arguments JSON, then `execa(command, { cwd:
  ws.dir, shell: true, timeout: 120_000, reject: false, env:
  childEnv(process.env), extendEnv: false })`, returning combined
  output truncated to 16,000 chars (src/harness/adapter.ts:334-358).
  `extendEnv: false` is called out as load-bearing against execa
  re-merging `process.env` (adapter.ts:349-353).
- The child environment is a six-name allowlist — `PATH`, `HOME`,
  `LANG`, `LC_ALL`, `TZ`, `TMPDIR` — with `SSH_AUTH_SOCK` excluded
  deliberately so a job "would [not] authenticate as the operator"
  (src/harness/child-env.ts:2-8). README repeats it (README.md:66-68).
- The worktree itself: a detached `git worktree add` from a bare mirror
  keyed by a sha256 prefix of the repo URL, with local
  `user.email`/`user.name` config set per worktree
  (src/executor/workspace.ts:21-24, 59-66). The final patch is
  `git add -A; git diff --cached --binary` (workspace.ts:69-79); the
  worktree is removed at teardown (workspace.ts:81-90).

### 1.5 Prompt composition (step-1 wiring)

`userPrompt(job)` builds: goal, then the rendered guidance block, then
the context-files section (src/harness/adapter.ts:277-286). Guidance
renders through `renderGuidance()` (src/contract/guidance.ts:21-29) —
D12 heading and fence, verbatim text (pinned by
tests/contract/guidance.test.ts:24-55 and
tests/harness/adapter.test.ts:197-238). Validator rules live in
`validateGuidanceItems` (src/contract/guidance.ts:37-64): no `- ` line
starts, no delimiter line in text, byte cap check. The job-level
enforcement is `malformed_payload` vs `limit_exceeded`
(src/service/validate.ts:36-46). Cap defaults: 3072 bytes
(src/contract/guidance.ts:7; src/config/deploy.ts:29), 16 items
(src/contract/guidance.ts:10; src/contract/schema.ts:67).

---

## 2. What "load an extension into the harness" can mean here (Q2)

Because there is no binary to extend (§0), the candidate extension
points are exactly the things the adapter composes into the request:

| Extension point | Today | Source | Where an "extension" would land |
|---|---|---|---|
| Tools array | hardcoded `TOOLS`, 1 tool (adapter.ts:31-44) | developer | extra tool entries in the request body |
| System message | `SYSTEM_PROMPT` + operator addendum (adapter.ts:74-79, 107-109) | developer + deploy config | more standing text (D5 channel) |
| User message | goal + guidance + context (adapter.ts:277-286) | dispatcher (contract v3) | more dispatcher-authored text |
| Tool executor | `runTool` handles `run_shell` only (adapter.ts:334-358) | developer | dispatch on tool name to a new handler |
| MCP config / hooks / plugins / config files written into the worktree | **none — no such mechanism exists anywhere in src/** | — | would be entirely new machinery |

Verification of the negative: `src/` contains no MCP, hook, plugin, or
worktree-config-file writing. The only things the worker writes into a
worktree are git config values (`user.email`, `user.name`,
src/executor/workspace.ts:63-64). The adapter never writes files at
all; it only reads `ws.dir` to set `cwd` (adapter.ts:344).

What the adapter would need to gain, per design:

- **Extra tools**: a way for the tools array and the `runTool` dispatch
  (adapter.ts:263-269 → 334) to admit more than one tool — either
  developer-authored code (new module) or a bounded deploy-config
  declaration. Both change invariant 5 ("the worker still gets only
  run_shell and the worktree" — step-1 decision record) unless the new
  tool is strictly read-only and non-egress.
- **Extra system text**: deploy config already has the mechanism
  (`extra_system_prompt`, §1.3); "loading" more of it is a config
  shape change, not a runtime change.
- **Sanitization already pinned by child-env**: `extendEnv: false`
  (adapter.ts:353) and the six-name allowlist (child-env.ts:8). Any
  extension that runs code in the job shell inherits this pinning; an
  extension that runs code in the *worker process* (e.g. a plugin
  loader) would bypass it and is a different containment class.

---

## 3. Worker→outside communication today (Q3)

### 3.1 Can the running job write outside the worktree?

- By construction the shell's `cwd` is the worktree (adapter.ts:344),
  but `shell: true` means nothing *prevents* the model from issuing
  `cat > /etc/foo` — the containment layers are: the allowlisted env
  (child-env.ts:8, adapter.ts:352-353), the 120s per-command timeout
  (adapter.ts:346), and the deployment's OS user (README.md:77-78:
  "OS containment is left to the deployment. Run the worker as a
  dedicated, non-login OS user."). The runtime itself does not sandbox
  paths. A step-2 channel must therefore assume the shell could already
  attempt out-of-tree writes and rely on OS containment — the runtime
  should add no new writable surface.
- The adapter result returns to the executor only at the end
  (src/executor/local.ts:49); nothing mid-run crosses back except the
  `onStep` cost callback (local.ts:39-40), which carries numbers, not
  content.

### 3.2 The dispatcher's view

- Client polling: `AxonClient.status()` GETs `/jobs/:id`; while running
  the server answers a bare `{ job_id, status: 'running' }`
  (src/client/http.ts:80-95; src/service/server.ts:48-55). `wait()`
  polls every `pollMs` (default 2000) until a terminal envelope or the
  deadline (src/client/http.ts:97-111).
- Server surface: `/healthz` (unauthenticated), `/nodeinfo`, `POST
  /jobs`, `GET /jobs/:id`, `POST /jobs/:id/cancel`,
  `GET /jobs/:id/artifact?id=` (src/service/server.ts:33-73). Auth is
  constant-time bearer on everything except `/healthz`
  (server.ts:24-31). Bind is loopback (src/worker.ts:76).
- The pool runs each job as a promise keyed by id with an
  `AbortController` (src/service/pool.ts:21-27, 66-69); `drain()`
  awaits all in-flight `done` promises (pool.ts:84-86). There is
  **no endpoint and no in-memory queue by which a running job posts
  anything outward**: `envelope()` returns `undefined` while running
  (pool.ts:91), artifacts are written only at finish time
  (pool.ts:196-201), and the ledger records dispatch + terminal
  envelope only (src/controller/ledger.ts:52-98).
- Conclusion: the only building block for a mid-job guidance channel is
  (a) the worker's own loopback HTTP service plus the pool's
  job-keyed bookkeeping, and (b) the adapter's per-step loop, which is
  a natural injection cadence. A pull channel needs no new worker→
  dispatcher path at all; a push channel needs one new server endpoint.

---

## 4. Candidate designs (Q4)

### 4a. Extension loading

**Option A1 — developer-authored tool module (read-only `get_guidance`).**
Add a second function tool next to `run_shell` in `TOOLS`
(adapter.ts:31-44), executed in-process by the adapter (not via
`execa`), returning guidance held by the pool for the running job. No
new config, no new egress, nothing runs in the job shell. Containment
cost: the tools array stops being a singleton; anything that later
generalizes "add a tool" must re-prove the invariant that tools do not
execute in the job shell. README changes: the bullet "The only tool is
`run_shell`, scoped to the worktree" (README.md:51) and Security model
needs a sentence that the harness exposes one additional read-only
tool.

**Option A2 — deploy-config extension declaration.**
A new optional, `.strict()`-validated deploy field (pattern of
`extra_system_prompt`, src/config/deploy.ts:32-40) declaring a bounded
set of allowed extension kinds (e.g. `guidance_tool: true`), which the
LocalExecutor passes to the adapter (src/executor/local.ts:35-46).
Per-deploy opt-in keeps the default node identical to today. Cost: a
schema field and a validation matrix; nothing about the job shell
changes. README changes: Worker configuration section gains a bullet
(README.md:80-101 area); security model unchanged except the
"only tool" line above.

**Option A3 — generic plugin loader (load code into the worker
process).** The literal reading of "load an extension into the
harness". Rejected for this spec's scope: arbitrary worker-process code
bypasses every pinned guarantee in §2 (the allowlist is only enforced
at `runTool`, adapter.ts:352-353), and the README security model has no
language to bound it. If ever built it needs its own spec. Not
recommended.

Recommendation: A1 + A2 (A1 is the mechanism, A2 is the opt-in flag).

### 4b. Read-only guidance channel

Constraints all options share (from step 1): source neutrality
(docs/ROADMAP.md:71-72 — "No named source of guidance"), bounded input
(byte cap pattern of `max_guidance_bytes`, src/contract/guidance.ts:7),
word-for-word rendering with the D12 fence
(src/contract/guidance.ts:4, 21-29), and "the worker gains no write
access" (docs/ROADMAP.md:66).

**Option B1 — dispatcher pushes, worker pulls (read-only tool).**
New authenticated endpoint `POST /jobs/:id/guidance` on the worker
(server.ts pattern of `/jobs/:id/cancel`, server.ts:57-62): validated
with `validateGuidanceItems` against `max_guidance_bytes`
(src/contract/guidance.ts:37-64), stored in the pool's per-job state
(pool.ts `Running` map, pool.ts:21-27). The adapter calls it through a
new read-only tool (`get_guidance`) each step or when the model asks;
the tool result renders through `renderGuidance()` so the model sees
the same D12 fence (src/contract/guidance.ts:23-27). Egress: none —
the tool reads worker-local memory. Write access gained by worker:
none (read-only); write access gained by *dispatcher*: one push
endpoint. README changes: Worker API table (README.md:160-170) gains a
row; Security model "Bounded input and output" bullet (README.md:72-73)
gains "and mid-job guidance updates, same cap"; the loopback bullet
(README.md:63-64) is unchanged because the dispatcher already reaches
the worker over the SSH tunnel.

**Option B2 — push-injected message per step.**
Same endpoint, but instead of a tool, the adapter checks for pending
guidance between steps and appends a `user` message rendered with the
D12 fence (messages array, adapter.ts:113-116, 255). No new tool;
smaller surface. Cost: the model cannot ask; guidance timing is
adapter-controlled; conversation grows monotonically with each update
(token cost unbounded until a cap is defined). README changes identical
to B1 minus the tool sentence.

**Option B3 — poll the dispatcher from the worker (worker→dispatcher
HTTP pull).** The adapter would fetch guidance from a dispatcher URL
each step. Rejected: this is worker-initiated egress to a
dispatcher-controlled host — it breaks the direction of every existing
connection (only the dispatcher initiates; the worker only binds
loopback, src/worker.ts:76) and contradicts invariant 5's "no egress".
The README "Loopback only" bullet (README.md:63-64) would have to be
rewritten. Not recommended.

Recommendation: B1 (or B2 if the owner wants to avoid a second tool).

---

## 5. Contract / rollout impact (Q5)

- **Does this require CONTRACT_VERSION 4?** Only if the *job request*
  or *terminal envelope* schema grows (both are `.strict()` with
  `contract_version: z.literal(3)` pinned: src/contract/schema.ts:4,
  70, 101). Under B1/B2 with per-deploy opt-in and a per-job-id
  operational endpoint, the job request does not change; the envelope
  does not change; telemetry does not change (TelemetrySchema,
  schema.ts:75-90). So v3 can stand. If the owner instead wants the
  dispatcher to declare mid-job guidance *capability* in the job
  (e.g. a `guidance_stream: true` field) or to report delivered
  guidance count in telemetry, that is a v4 bump.
- **Step-1 mechanisms that apply on any future bump:** D3 drain-first
  lockstep (README.md:204-215: "Upgrade in order: drain running jobs,
  then upgrade workers, then the controller"); D4 typed
  `ContractMismatchError` with both versions, rethrown immediately by
  `wait()` instead of polling to timeout (src/client/http.ts:12-36,
  104-105; test pin tests/client/http.test.ts:135-139); the worker-side
  version check that rejects with `contract_unsupported` before shape
  validation (src/service/validate.ts:12-15).
- **/nodeinfo surface:** currently `{ node_id, contract_version,
  runtime_version, active_jobs, max_concurrent_jobs }`
  (src/service/server.ts:35-41; mirrored in the client type
  src/client/http.ts:42-48). It does not *need* to grow for B1/B2 —
  the dispatcher can simply attempt the push and handle a 404 as "node
  lacks the feature". If the owner prefers explicit capability
  negotiation, one optional field (e.g. `mid_job_guidance: boolean`)
  is the smallest honest growth; the README's guidance ("check each
  node's version via GET /nodeinfo … hold dispatch", README.md:208-210)
  is the precedent.

---

## 6. Open questions for the owner (Q6)

1. **How does the worker ASK for guidance?** Options: (i) read-only
   tool the model calls on demand (`get_guidance`, option B1) — model-
   paced, matches "a job that wanders into another part" (the model
   knows where it is); (ii) adapter-injected message every step when
   pending guidance exists (B2) — deterministic but token-hungry;
   (iii) fixed cadence poll by the adapter. **Recommendation: (i)**,
   with the system prompt describing the tool, since only the model
   can know which part of the codebase it has entered.

2. **Is the read-only channel pull-only?** Options: (i) pull-only —
   the worker exposes no guidance endpoint at all; the dispatcher
   cannot push, and guidance must be attached at dispatch or via the
   tool's backing store configured per deploy; (ii) pull + push —
   dispatcher POSTs updates mid-job (B1 as designed). (i) is more
   contained but cannot deliver "guidance for the part it wandered
   into" unless the *source* is reachable by the worker, which
   invariant 5 forbids. **Recommendation: (ii)** — one authenticated
   push endpoint on the already-loopback worker; state plainly in the
   README that this adds a second dispatcher→worker data flow.

3. **Cap semantics for mid-job guidance.** Options: (i) each update
   independently ≤ `max_guidance_bytes`; (ii) cumulative across the
   job ≤ cap (later updates must replace, not append); (iii) separate
   new deploy cap (e.g. `max_midjob_guidance_bytes`). (i) is simplest
   but lets token cost grow without bound; (ii) reuses the existing
   cap honestly (the D12 fence renders a snapshot, not a log).
   **Recommendation: (ii)** — replace semantics, validated with the
   existing `validateGuidanceItems` (src/contract/guidance.ts:37-64).

4. **Extension loading: per-deploy config or per-job?** Options: (i)
   per-deploy flag (`extra_system_prompt` precedent, src/config/deploy.ts:32-40)
   — operator-owned, uniform for the node; (ii) per-job field in the
   contract — forces the v4 question in §5 and lets submitters alter
   the tool surface, which the README's operator-ownership rule argues
   against (README.md:100-101). **Recommendation: (i)**.

5. **Does `/nodeinfo` grow now or never?** Options: (i) never — 404 on
   the push endpoint is the capability signal; (ii) one optional
   boolean now. **Recommendation: (ii)** only if the owner wants
   dispatch-time gating without a probe POST; otherwise (i).

---

## 7. Exact README sentences that would change (for the spec)

Under B1/B2 + A1/A2, and *only* those:

- README.md:51: "The only tool is `run_shell`, scoped to the
  worktree." → would name the second, read-only tool or say "the only
  tools are `run_shell` and `get_guidance` (read-only)".
- README.md:72-73: "**Bounded input and output.** Goal, context,
  guidance, and inline patch sizes are capped per node." → would add
  mid-job guidance updates to the bounded list.
- README.md:160-169 (Worker API table) → gains the guidance-push row.
- Unchanged, and worth re-quoting as constraints: "Loopback only"
  (README.md:63-64) — B1/B2 keep worker loopback; "No push access"
  (README.md:69) — untouched; "OS containment is left to the
  deployment" (README.md:77-78) — untouched.
