# Spec — guidance delivered while the job runs

**Date:** 2026-11-14
**Status:** PROPOSED — awaiting owner approval (spec gate). Decisions marked
**(rec)** are this spec's recommendation; the owner amends or approves each
at the gate.
**Revision:** r3 — T3 Opus review (REQUEST CHANGES, 4 MAJOR / 5 MINOR,
$0.64/11 turns) folded in r2; T4 Fable SPEC gate (REQUEST CHANGES,
4 MAJOR / 5 MINOR, $2.93/30 turns, effort high) folded in r3. Fable's
can't-break attestations: D1, D2, D5-replace-semantics, D13, invariants
1–3 and 6. Receipts in PR #60.
**Branch:** `feat/roadmap-step2-guidance-while-running`
**Backbone:** [investigation.md](./investigation.md) (written against main
`476b56b`; every factual claim cites file:line there)
**Roadmap:** docs/ROADMAP.md, step 2. Also carries the missed step-8 cleanup
from PR #52: the Status line of `specs/guidance-in-job/spec.md` flips to
Implemented in this PR (owner ruling 2026-11-14; issue #59).

## Summary

The dispatcher can push updated guidance to a running job, and the worker
model can read it on demand through one new read-only tool. No guidance
source system is named. No job-contract field grows; CONTRACT_VERSION
stays 3. Nodes opt in per deploy config; an opted-out node behaves exactly
as today.

## Framing (adopts the investigation's correction)

The harness is an in-process OpenAI-compatible tool loop
(src/harness/adapter.ts:112-275). It spawns no binary. "Load an extension
into the harness" therefore means: add one composed input to the loop.
This spec adds one tool and one deploy flag. It adds no plugin loader, no
MCP config, no hook machinery.

## Ruled decisions

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Extension mechanism | One developer-authored read-only tool, `get_guidance`, executed in-process by the adapter. It never runs in the job shell (rec) | The tool reads worker-local memory; the job shell keeps its allowlisted env and one writable surface. A plugin loader would bypass the runTool env pin (adapter.ts:352-353) and has no README language to bound it (investigation §4a option A3) |
| D2 | Opt-in | New deploy field `mid_job_guidance`, boolean, default `false`, `.strict()`-validated (rec). A flag-off node does NOT register the push route; it answers 404 exactly like an older runtime without the route (r2-M3) | Pattern of `extra_system_prompt` (deploy.ts:32-40); the default node stays byte-for-byte today's node, including its route table. Per-job opt-in rejected: submitters must not alter the tool surface (README.md:100-101) |
| D3 | Tools array and name dispatch | When the flag is off, `TOOLS` stays the current singleton. When on, the adapter adds `get_guidance`. Tool dispatch is BY NAME in BOTH flag states: `run_shell` keeps today's path; `get_guidance` runs its in-process handler; an unknown tool name returns the string `error: unknown tool <name>` without spawning a shell (r2-M1). The `get_guidance` handler is exempt from the `ws.dir` workspace guard (adapter.ts:335) — it needs no workspace (r2-M1) | One dispatch table per node state; a model that hallucinates a tool on a flag-off node must not reach `execa` with undefined arguments. Tests pin dispatch in both flag states (adapter.ts:263-268 today ignores `function.name`) |
| D4 | Push endpoint | `POST /jobs/:id/guidance`, bearer-authenticated like every non-`/healthz` route (server.ts:24-31). Check order: VALIDATION FIRST, then job lookup (r3-M1). Body shape: `{"guidance": [ ...items ] }` — wrapped, `.strict()`, not a bare array, so the body can grow without breaking clients (r2-M1; the `POST /jobs` body is a bare `JobRequest`, so it is NOT a precedent for wrapping — r3-M5). Validation is the SAME TWO-STEP PIPELINE as dispatch (validate.ts:14-46): first a `z.array(GuidanceItemSchema).max(MAX_GUIDANCE_ITEMS)` shape+count parse → failure answers `400 {job_id, status:'rejected', reason:'malformed_payload'}`; then `validateGuidanceItems` against the node's `max_guidance_bytes` → content-rule failures answer `malformed_payload`, the byte cap alone answers `limit_exceeded`. A bare `validateGuidanceItems` call is not enough — it assumes parsed items (guidance.ts:37-64), so a wrong-shaped body would otherwise throw a TypeError that Fastify answers as 500 (r2-M1). Then the job lookup: unknown or non-running job answers `409 {error:'job is not running'}` (D5). Success: `202 {job_id, status:'updated'}`. The body carries no contract_version — the push is version-pinned by the job it targets (r3-M2). Documented Fastify-level exceptions to the `reason` vocabulary: invalid JSON answers Fastify's own 400 body without a `reason` field; a missing content-type answers 415 — both match the `POST /jobs` precedent (r3-M2) | Validate-first makes a malformed probe side-effect-free against ANY job id; lookup-first would force a dispatcher to hold a running job just to probe. Dispatchers need a stable `reason` field to branch on |
| D5 | Snapshot semantics | The snapshot starts as the dispatch-time `job.guidance` at REVISION 1 — the user prompt already carries that render verbatim (adapter.ts:280-283), so the model's initial last-read marker is 1, never 0 (r3-M2). Each successful POST replaces it whole — no append. An identical-content re-push (same rendered bytes) does NOT bump the revision, so a dispatcher retry after a network timeout cannot force a re-render (r3-M2). An empty list `[]` is the wire-level CLEAR: it stores an empty snapshot at a new revision and the tool answers `no standing guidance.` (r2-M4; the CLI guards it — D10). A push to an unknown or non-running job answers `409 {error:'job is not running'}` — deliberately NOT 404, and deliberately different from the cancel route's 404 for the same condition, so a dispatcher can distinguish "job gone" from "node lacks the route" (flag-off nodes 404 per D2) (r2-M3, r3-M5) | Replace-not-append keeps each snapshot bounded; the revision counter (D6) bounds repeated reads; the no-bump rule bounds dispatcher retries. The 404/409 split keeps the capability signal unambiguous |
| D6 | What the model sees | The tool returns `renderGuidance(snapshot)` plus its revision. When the snapshot's revision equals the job's last-read marker — including the FIRST read at marker 1, because the prompt already carries revision 1 — the tool returns one short line, `standing guidance unchanged (revision N).`, instead of the full render (r2-M4, r3-M2). Each read moves the marker | Every tool result rides in `messages` and is re-sent on every later request (adapter.ts:263-268, 147); the one-line answer keeps an unchanged re-read to one sentence. But a read is NOT free: it consumes a harness step (adapter.ts:249) and a full-context request — see D12 |
| D7 | Cap semantics | Each POST is a complete replacement ≤ `max_guidance_bytes`. No new cap field (rec). What replace semantics bounds is the SNAPSHOT, not the prompt; the prompt bound comes from D6's unchanged-line, the marker initialization in D5, and the existing step ceiling (r2-M4, r3-M2) | Reuses the existing cap honestly. Token growth per update is ≤ cap+fence once; unchanged reads and dispatcher retries cost one line |
| D8 | Contract | CONTRACT_VERSION stays 3. No JobRequest field, no envelope field, no telemetry FIELD, no ledger column (rec). `HARNESS_VERSION` becomes FLAG-DEPENDENT: `'deepseek-harness-0.2'` when `mid_job_guidance` is on, unchanged `'deepseek-harness-0.1'` when off (r3-M3) — the envelope already reports it (pool.ts:193), a value bump grows no schema, and the dispatcher can then tell which tool surface a job ran with | A single bumped constant would mislabel flag-off nodes (the constant is module-level, local.ts:62) and would change an opted-out node's envelope telemetry, contradicting invariant 5 |
| D9 | Capability signal | `/nodeinfo` does not grow (rec). Under validate-first (D4), the side-effect-free capability probe is `POST /jobs/<any-id>/guidance` with an invalid body: a capable node answers 400 with a `reason`; an incapable (flag-off or older-runtime) node answers 404 whose Fastify default body carries no `reason` field. No running job is needed. **Owner gate question:** accept this, or grow `/nodeinfo` by one boolean instead? | The check order makes the probe work against any id; the boolean remains available if the owner wants dispatch-time gating without any probe |
| D10 | CLI | New subcommand `axon update-guidance --job <job_id> --guidance-file <path> [--clear]` — the `--job` option + `ledger.nodeFor` node resolution, matching the existing `status`/`cancel` convention (cli.ts:80-100) (r3-M4). The file path reuses `loadGuidanceFile` AS-IS (src/client/guidance-file.ts:15-45) (r2-M2). An empty file answers a named CLI error unless `--clear` is also passed; `--clear` sends `[]` — the wire-level clear of D5. Precedent: 1.4.0 deliberately made an empty guidance FILE harmless at dispatch (drop-empty at dispatch-job.ts:33, commit 3f7bd08); wiping standing guidance mid-job must stay an explicit act (r3-M4) | Step-1 D11/D9 precedent: without the flag the mechanism ships unreachable to the shipped client; the convention reuse keeps one node-resolution path |
| D11 | Adapter wiring | `Executor.run` KEEPS its signature (types.ts:28). The pool passes a guidance-store service into the executor's constructor; the executor resolves the job's read-only snapshot reader inside `run()` and hands it to the `HarnessAdapter` CONSTRUCTOR, mirroring how `extraSystemPrompt` reaches the adapter today (local.ts:35-46) (r3-M3). The fake executor is untouched. The adapter must not reach the pool or the server (rec) | A fourth `run()` parameter would ripple through every adapter call site; constructor passing keeps `adapter.run` and the local tests untouched (r3-M3) |
| D12 | System prompt | `SYSTEM_PROMPT` gains one sentence, present only when the flag is on: the model may call `get_guidance` when it enters a new area of the codebase, to check for updated standing guidance. The tool description must NOT say the read is cheap — a read consumes a harness step and a full-context request (r3-M2). **Owner gate question (B2-lite, deferred by default):** the adapter could instead append a one-line notice to a `run_shell` result when the revision changed since the model's last read, informing without spending a step. Rec: DEFER — it adds a second notification surface to bound and document; revisit only if real jobs show the model missing updates | Model-paced asks match the roadmap's use case: only the model knows which part of the codebase it has entered |
| D13 | Delivery honesty | A `202` response means the update was STORED, not that the model read it. A push during `prepare()` is accepted (the job is already in the running map, pool.ts:67-69) and races the first prompt normally. A push during `teardown()` may be stored after the model's last read — the spec and the README both say stored-not-read (r2-M3) | The pool keeps the running entry through prepare/teardown and deletes it only in `done.finally` (pool.ts:69); promising delivery-to-model would be false |

Rejected alternatives (full analysis in investigation.md §4):

- B2 per-step injected messages — adapter-controlled timing, and every
  update lands in the transcript permanently; the model cannot ask, and
  cannot distinguish changed from unchanged guidance. (The D12 gate
  question is a bounded B2-lite variant, deferred by default.)
- B3 worker pulls from a dispatcher URL — worker-initiated egress; breaks
  the loopback-only direction (README.md:63-64) and invariant 5.
- A3 plugin loader into the worker process — bypasses every pinned
  guarantee in child-env; needs its own spec.
- Pull-only channel with no endpoint — cannot deliver guidance for a part
  the job wandered into unless the source is worker-reachable, which
  invariant 5 forbids.

## Scope (files)

- `src/config/deploy.ts` — `mid_job_guidance` boolean, default false.
- `src/harness/adapter.ts` — tools array and name dispatch per D3;
  `get_guidance` handler with revision/marker semantics per D5/D6;
  guidance-reader constructor parameter per D11; system-prompt sentence
  per D12; flag-dependent `HARNESS_VERSION` per D8.
- `src/service/server.ts` — `POST /jobs/:id/guidance` per D4, registered
  only on flag-on nodes.
- `src/service/pool.ts` — guidance-store service and per-job readers per
  D5/D11.
- `src/executor/local.ts` — constructor takes the guidance-store service
  per D11. `src/executor/types.ts` and `src/executor/fake.ts` unchanged.
- `src/client/http.ts` — client method for the push per D10.
- `src/client/cli.ts` — `update-guidance` subcommand per D10.
- `src/client/guidance-file.ts` — unchanged; reused as-is per D10.
- `README.md` — per investigation §7: the "only tool" sentence (README:51),
  the bounded-input bullet (README:72-73), the Worker API table, the new
  deploy field, one sentence naming the second dispatcher→worker data flow,
  and one sentence stating stored-not-read (D13).
- `specs/guidance-in-job/spec.md` — Status line flips to Implemented,
  naming PR #52 and release 1.4.0 (missed step-8 cleanup; issue #59).
- Tests: `tests/config/deploy.test.ts` (new field, default false);
  `tests/harness/adapter.test.ts` (flag off → tools array, prompt, and
  `run_shell` dispatch identical; unknown tool name → `error: unknown
  tool` in both flag states; `get_guidance` exempt from the workspace
  guard; first read at marker 1 → unchanged line; changed snapshot → full
  render under the guidance closing fence; identical-content re-push → no
  revision bump; empty snapshot → `no standing guidance.`; system-prompt
  sentence present; flag-dependent harness version);
  `tests/service/server.test.ts` (auth required; probe `{}` → 400
  `malformed_payload` on a capable node, 404 on a flag-off node; wrong-
  shaped body → 400 `malformed_payload`, never 500; 17 items → 400;
  over-cap → 400 `limit_exceeded`; content-rule violation → 400
  `malformed_payload`; valid body to unknown or non-running job → 409;
  `[]` clears; replace semantics; identical re-push keeps the revision);
  `tests/service/pool.test.ts` (store lifecycle, revision/marker
  semantics); `tests/client/cli.test.ts` and `tests/client/http.test.ts`
  (new subcommand with `--job` convention, node resolution, empty file
  without `--clear` → named error, client method).

## Invariants (checked at review, not just in tests)

1. **No new writable surface.** The worker gains no write access anywhere:
   the tool reads memory; the endpoint writes one in-memory snapshot.
2. **No new egress.** The worker still binds loopback only (worker.ts:76)
   and initiates no connection. Only the dispatcher pushes.
3. **The tool never runs in the job shell.** `get_guidance` executes
   in-process; the job shell keeps exactly `run_shell`; unknown tool names
   never reach a shell.
4. **Bounded and verbatim.** Mid-job guidance passes the SAME two-step
   validation pipeline as dispatch-time guidance — shape+count parse, then
   content rules, then the byte cap — and renders word for word under the
   guidance closing fence (`GUIDANCE_END_LINE`).
5. **Opt-out is exact.** With the flag off, requests, prompts, the tools
   array, the route table, `run_shell` dispatch behavior, and envelope
   telemetry (including `harness_version`) match today's bytes; tests pin
   this (r3-M3).
6. **Source neutrality.** No file names a guidance source system.
7. **No silent loss.** A rejected POST answers with the named reason
   (`malformed_payload` / `limit_exceeded` / 409); the two documented
   Fastify-level exceptions (invalid JSON, missing content-type) are named
   in D4; the CLI pre-validates through `loadGuidanceFile`.
8. **Stored is not read.** Success responses claim storage only; the spec
   and the README both say the model may never read a stored update (D13).

## Out of scope

- Roadmap steps beyond step 2; any guidance source system.
- Plugin loaders, MCP config, hooks (investigation A3).
- Contract version 4; telemetry-field or ledger growth.
- Delivery guarantees: a snapshot lost to a worker restart stays lost;
  the README says the snapshot is in-memory.
- The B2-lite run_shell notice (D12 gate question) — deferred unless the
  owner adopts it.

## Open items for the owner (the gate)

1. Approve or amend D1–D13 as marked (rec).
2. D9 — validate-first probe (400-vs-404) as the capability signal, or one
   `/nodeinfo` boolean instead?
3. Confirm the PR carries the #59 Status flip as missed cleanup.
4. D12 B2-lite (one-line revision notice on `run_shell` results) — adopt
   now, or defer as recommended?

## Revision history

- r1 (2026-11-14): initial spec.
- r2 (2026-11-14): applied T3 Opus review (REQUEST CHANGES, 4 MAJOR /
  5 MINOR, $0.64, 11 turns). Name dispatch + unknown-tool error +
  workspace-guard exemption (D3); two-step validation + wrapped body +
  response contract (D4); route unregistered when off (D2); 409 split
  (D5); revision counter + unchanged-line (D5/D6); corrected cap
  rationale (D7); `HARNESS_VERSION` bump (D8); `loadGuidanceFile` reuse
  (D10); pinned signature (D11); stored-not-read (D13).
- r3 (2026-11-14): applied T4 Fable SPEC gate (REQUEST CHANGES, 4 MAJOR /
  5 MINOR, $2.93, 30 turns, effort high). r3-M1 → D4 (validate-first
  check order) and D9 (probe reframed); r3-M2 → D5 (marker starts at 1,
  identical re-push does not bump), D6 (first-read behavior), D7, D12
  (never "cheap"); r3-M3 → D8 (flag-dependent harness version, invariant
  5 extended), D11 (constructor passing, `run()` signature kept);
  r3-M4 → D10 (`--clear` guard, 1.4.0 precedent, `--job` convention);
  r3-M5 → prose (fence renamed, "inv. A3" fixed, envelope claim removed,
  409 divergence stated), invariant 5 wording, invariant 7 (Fastify-level
  exceptions), Scope tests updated.
