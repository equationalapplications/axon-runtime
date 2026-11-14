# Spec — guidance delivered while the job runs

**Date:** 2026-11-14
**Status:** PROPOSED — awaiting owner approval (spec gate). Decisions marked
**(rec)** are this spec's recommendation; the owner amends or approves each
at the gate.
**Revision:** r2 — full T3 Opus review applied (4 MAJOR, 5 MINOR, verdict
REQUEST CHANGES, $0.64/11 turns; receipts in PR #60). r1→r2: D2/D3/D4/D5/D7/D8/D10/D11 amended, D13 added, invariant 4 reworded, invariant 7 scoped, invariant 8 added, Scope and tests extended. Resolution tags below.
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
| D1 | Extension mechanism | One developer-authored read-only tool, `get_guidance`, executed in-process by the adapter. It never runs in the job shell (rec) | The tool reads worker-local memory; the job shell keeps its allowlisted env and one writable surface. A plugin loader would bypass the runTool env pin (adapter.ts:352-353) and has no README language to bound it (inv. A3) |
| D2 | Opt-in | New deploy field `mid_job_guidance`, boolean, default `false`, `.strict()`-validated (rec). A flag-off node does NOT register the push route; it answers 404 exactly like an older runtime without the route (r2-M3) | Pattern of `extra_system_prompt` (deploy.ts:32-40); the default node stays byte-for-byte today's node, including its route table. Per-job opt-in rejected: submitters must not alter the tool surface (README.md:100-101) |
| D3 | Tools array and name dispatch | When the flag is off, `TOOLS` stays the current singleton. When on, the adapter adds `get_guidance`. Tool dispatch is BY NAME in BOTH flag states: `run_shell` keeps today's path; `get_guidance` runs its in-process handler; an unknown tool name returns the string `error: unknown tool <name>` without spawning a shell (r2-M1). The `get_guidance` handler is exempt from the `ws.dir` workspace guard (adapter.ts:335) — it needs no workspace (r2-M1) | One dispatch table per node state; a model that hallucinates a tool on a flag-off node must not reach `execa` with undefined arguments. Tests pin dispatch in both flag states (adapter.ts:263-268 today ignores `function.name`) |
| D4 | Push endpoint | `POST /jobs/:id/guidance`, bearer-authenticated like every non-`/healthz` route (server.ts:24-31). Body shape: `{"guidance": [ ...items ] }` — wrapped, not a bare array, so the body can grow without breaking clients (r2-M1). Validation is the SAME TWO-STEP PIPELINE as dispatch (validate.ts:14-46): first a `z.array(GuidanceItemSchema).max(MAX_GUIDANCE_ITEMS)` shape+count parse → failure answers `malformed_payload`; then `validateGuidanceItems` against the node's `max_guidance_bytes` → content-rule failures answer `malformed_payload`, the byte cap alone answers `limit_exceeded`. A bare `validateGuidanceItems` call is not enough — it assumes parsed items (guidance.ts:37-64), so a wrong-shaped body would otherwise throw a TypeError that Fastify answers as 500 (r2-M1). Response contract (r2-M2): success `202 {job_id, status:'updated'}`; rejection `400 {job_id, status:'rejected', reason}` with `reason` drawn from the existing `RejectReason` vocabulary; unknown-or-non-running job `409 {error:'job is not running'}` (D5) | Shape must be checked before `validateGuidanceItems` or bad input becomes a 500; dispatchers need a stable `reason` field to branch on. The wrapped body follows the `POST /jobs` envelope style |
| D5 | Snapshot semantics | The snapshot starts as the dispatch-time `job.guidance` at revision 1. Each successful POST replaces it whole — no append — and increments the revision. An empty list `[]` is a valid push and CLEARS the snapshot; the tool then answers `no standing guidance.` (r2-M4). A push to an unknown or non-running job answers `409 {error:'job is not running'}` — deliberately NOT 404, so a dispatcher can distinguish "job gone" from "node lacks the route" (flag-off nodes 404 per D2) (r2-M3) | Replace-not-append keeps each snapshot bounded; the revision counter (D6) is what bounds repeated reads. The 404/409 split keeps the capability signal unambiguous |
| D6 | What the model sees | The tool returns `renderGuidance(snapshot)` plus its revision. When the revision is unchanged since this job's last `get_guidance` read, the tool returns one short line — `standing guidance unchanged (revision N).` — instead of the full render (r2-M4) | Every tool result rides in `messages` and is re-sent on every later request (adapter.ts:263-268, 147). Without the unchanged-line, a rational model calls the tool every step and guidance tokens grow with every step; the revision line makes an unchanged re-read cost one sentence |
| D7 | Cap semantics | Each POST is a complete replacement ≤ `max_guidance_bytes`. No new cap field (rec). What replace semantics bounds is the SNAPSHOT, not the prompt; the prompt bound comes from D6's unchanged-line plus the existing step ceiling (r2-M4 — r1's "bounded prompt growth" rationale was wrong and is corrected here) | Reuses the existing cap honestly. Token growth per update is ≤ cap+fence once; unchanged re-reads cost one line |
| D8 | Contract | CONTRACT_VERSION stays 3. No JobRequest field, no envelope field, no telemetry FIELD, no ledger column (rec). `HARNESS_VERSION` bumps to `'deepseek-harness-0.2'` — the harness behavior differs when the flag is on, the envelope already reports `harness_version` (pool.ts:193), and a value bump grows no schema (r2-M4) | The flow is per-job operational state; interrupted jobs never re-run (store.ts:159-165). The dispatcher can already see which harness ran a job |
| D9 | Capability signal | `/nodeinfo` does not grow. A dispatcher that gets 404 from the push endpoint treats the node as not offering the feature; 409 means the node HAS the feature but the job is gone (r2-M3). **Owner gate question:** accept this, or grow `/nodeinfo` by one boolean instead? The probe is side-effect-free only against a RUNNING job — capability probing without one is 404-only | The 409/404 split removed r1's ambiguity; the boolean remains available if the owner wants dispatch-time gating without any probe |
| D10 | CLI | New subcommand `axon update-guidance <job_id> --guidance-file <path>`; it reuses `loadGuidanceFile` AS-IS (src/client/guidance-file.ts:15-45) — schema parse, 16-item limit, content rules, cap warning all already live there under the same flag name (r2-M2). Client-side pre-validation therefore needs no new code; the client POSTs whatever `loadGuidanceFile` returns (rec) | Step-1 D11/D9 precedent: without the flag the mechanism ships unreachable to the shipped client; the existing pre-flight already turns an ordinary markdown file into a named error |
| D11 | Adapter wiring | `Executor.run` grows a fourth parameter: `run(ws, job, signal, guidance)` where `guidance` is a per-job read-only snapshot reader exposing `current(): { revision: number; items: GuidanceItem[] }` plus the last-read marker (types.ts:28; pool call site pool.ts:167). The fake executor accepts and ignores it. The pool hands each job its own reader; the adapter must not reach the pool or the server (rec, signature pinned r2-M5) | Keeps the one-directional flow pool→executor→adapter that exists today (local.ts:35-46) |
| D12 | System prompt | `SYSTEM_PROMPT` gains one sentence, present only when the flag is on: the model may call `get_guidance` for updated standing guidance (rec). The tool's own schema description tells the model the read is cheap when nothing changed | Model-paced asks match the roadmap's use case: only the model knows which part of the codebase it has entered |
| D13 | Delivery honesty | A `202` response means the update was STORED, not that the model read it. A push during `prepare()` is accepted (the job is already in the running map, pool.ts:67-69) and races the first prompt normally. A push during `teardown()` may be stored after the model's last read — the spec and the README both say stored-not-read (r2-M3) | The pool keeps the running entry through prepare/teardown and deletes it only in `done.finally` (pool.ts:69); promising delivery-to-model would be false |

Rejected alternatives (full analysis in investigation.md §4):

- B2 per-step injected messages — adapter-controlled timing, and every
  update lands in the transcript permanently; the model cannot ask, and
  cannot distinguish changed from unchanged guidance.
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
  `get_guidance` handler with revision semantics per D6; system-prompt
  sentence per D12; `HARNESS_VERSION` bump per D8.
- `src/service/server.ts` — `POST /jobs/:id/guidance` per D4, registered
  only on flag-on nodes.
- `src/service/pool.ts` — per-job snapshot store and reader per D5/D11.
- `src/executor/types.ts`, `src/executor/local.ts`, `src/executor/fake.ts` —
  signature grows per D11.
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
  dispatch behavior identical; unknown tool name → `error: unknown tool`;
  `get_guidance` exempt from the workspace guard; tool result carries the
  D12 fence verbatim; unchanged revision → the one-line answer; empty
  snapshot → `no standing guidance.`; system-prompt sentence present);
  `tests/service/server.test.ts` (auth required; wrong-shaped body → 400
  `malformed_payload`, never 500; 17 items → 400; over-cap → 400
  `limit_exceeded`; content-rule violation → 400 `malformed_payload`;
  `[]` clears; replace semantics; 409 for unknown and non-running jobs;
  404 on flag-off nodes); `tests/service/pool.test.ts` (snapshot lifecycle,
  revision counter); `tests/executor/fake.test.ts` (fourth parameter
  accepted and ignored); `tests/client/cli.test.ts` and
  `tests/client/http.test.ts` (new subcommand, client method,
  `loadGuidanceFile` error path).

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
   same D12 fence.
5. **Opt-out is exact.** With the flag off, requests, prompts, the tools
   array, and the route table match today's bytes; tests pin this.
6. **Source neutrality.** No file names a guidance source system.
7. **No silent loss.** A rejected POST answers with the named reason
   (`malformed_payload` / `limit_exceeded` / 409); the CLI pre-validates
   through `loadGuidanceFile`.
8. **Stored is not read.** Success responses claim storage only; the spec
   and the README both say the model may never read a stored update (D13).

## Out of scope

- Roadmap steps beyond step 2; any guidance source system.
- Plugin loaders, MCP config, hooks (investigation A3).
- Contract version 4; telemetry-field or ledger growth.
- Delivery guarantees: a snapshot lost to a worker restart stays lost;
  the README says the snapshot is in-memory.

## Open items for the owner (the gate)

1. Approve or amend D1–D13 as marked (rec).
2. D9 — 404-as-capability-signal with the 409 split, or one `/nodeinfo`
   boolean instead?
3. Confirm the PR carries the #59 Status flip as missed cleanup.

## Revision history

- r1 (2026-11-14): initial spec.
- r2 (2026-11-14): applied T3 Opus review (REQUEST CHANGES, 4 MAJOR /
  5 MINOR, $0.64, 11 turns). r2-M1 → D3 (name dispatch, unknown-tool
  error, workspace-guard exemption) and D4 (two-step validation, wrapped
  body); r2-M2 → D4 (response contract) and D10 (`loadGuidanceFile`
  reuse); r2-M3 → D2 (route unregistered when off), D5 (409 split),
  D9 (gate question reframed), D13 (new); r2-M4 → D5/D6 (revision
  counter + unchanged-line), D7 (corrected rationale), D8
  (`HARNESS_VERSION` bump); r2-M5 → D11 (signature pinned). All five
  MINORs folded; invariant 4 reworded, invariant 7 scoped, invariant 8
  added.
