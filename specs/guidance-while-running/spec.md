# Spec — guidance delivered while the job runs

**Date:** 2026-11-14
**Status:** PROPOSED — awaiting owner approval (spec gate). Decisions marked
**(rec)** are this spec's recommendation; the owner amends or approves each
at the gate.
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
| D2 | Opt-in | New deploy field `mid_job_guidance`, boolean, default `false`, `.strict()`-validated (rec) | Pattern of `extra_system_prompt` (deploy.ts:32-40); the default node stays byte-for-byte today's node. Per-job opt-in rejected: submitters must not alter the tool surface (README.md:100-101) |
| D3 | Tools array | When the flag is off, `TOOLS` stays the current singleton. When on, the adapter adds `get_guidance` and dispatches on tool name (rec) | One code path per node state; the "only tool" invariant is now state-dependent and must say so in the README |
| D4 | Push endpoint | `POST /jobs/:id/guidance`, bearer-authenticated like every non-`/healthz` route (server.ts:24-31). Body: a v3 guidance item list. The endpoint validates with `validateGuidanceItems` against `max_guidance_bytes`, then replaces the job's snapshot (rec) | The worker already binds loopback and already serves authenticated dispatcher routes (cancel, artifact). This adds a second dispatcher→worker data flow; the README says so |
| D5 | Snapshot semantics | The snapshot starts as the dispatch-time `job.guidance`. Each successful POST replaces it whole; no append. A POST to a non-running or unknown job answers 404 (rec) | Replace-not-append keeps total prompt growth bounded; 404 matches the cancel route's contract |
| D6 | What the model sees | The tool returns `renderGuidance(snapshot)`. An empty or absent snapshot returns the string `no standing guidance.` (rec) | The D12 fence and word-for-word rendering apply to mid-job guidance exactly as to dispatch-time guidance; the model must get one honest sentence, not an empty string |
| D7 | Cap semantics | Each POST is a complete replacement ≤ `max_guidance_bytes`. No new cap field (rec) | Reuses the existing cap honestly; a per-update cap with append would let token cost grow without bound (inv. Q3) |
| D8 | Contract | CONTRACT_VERSION stays 3. No JobRequest field, no envelope field, no telemetry field, no ledger column (rec) | Neither `.strict()` schema grows (schema.ts:70, 101); the flow is per-job operational state, and interrupted jobs never re-run (store.ts:159-165) |
| D9 | Capability signal | `/nodeinfo` does not grow. A dispatcher that gets 404 from the push endpoint treats the node as not offering the feature (rec) | The probe has no side effects; one boolean is honest growth only if the owner wants dispatch-time gating without a probe. Owner may amend |
| D10 | CLI | New subcommand `axon update-guidance <job_id> --guidance-file <path>`; reads the same JSON item file as `--guidance-file`; client-side pre-validation against `GuidanceItemSchema` before the POST (rec) | Step-1 D11/D9 precedent: without the flag the mechanism ships unreachable to the shipped client; without pre-validation an ordinary markdown file fails with a server error instead of a named message |
| D11 | Adapter wiring | The executor hands the adapter a per-job guidance store; the tool handler reads that store. The adapter must not reach the pool or the server (rec) | Keeps the one-directional flow pool→executor→adapter that exists today (local.ts:35-46) |
| D12 | System prompt | `SYSTEM_PROMPT` gains one sentence, present only when the flag is on: the model may call `get_guidance` for updated standing guidance (rec) | Model-paced asks match the roadmap's use case: only the model knows which part of the codebase it has entered |

Rejected alternatives (full analysis in investigation.md §4):

- B2 per-step injected messages — adapter-controlled timing, token cost
  grows with every update, and the model cannot ask.
- B3 worker pulls from a dispatcher URL — worker-initiated egress; breaks
  the loopback-only direction (README.md:63-64) and invariant 5.
- A3 plugin loader into the worker process — bypasses every pinned
  guarantee in child-env; needs its own spec.
- Pull-only channel with no endpoint — cannot deliver guidance for a part
  the job wandered into unless the source is worker-reachable, which
  invariant 5 forbids.

## Scope (files)

- `src/config/deploy.ts` — `mid_job_guidance` boolean, default false.
- `src/harness/adapter.ts` — tools array per D3; `get_guidance` handler;
  system-prompt sentence per D12.
- `src/service/server.ts` — `POST /jobs/:id/guidance` per D4.
- `src/service/pool.ts` — per-job snapshot store per D5/D11.
- `src/executor/types.ts`, `src/executor/local.ts`, `src/executor/fake.ts` —
  interface grows per D11.
- `src/client/http.ts` — client method for the push per D10.
- `src/client/cli.ts` — `update-guidance` subcommand per D10.
- `README.md` — per investigation §7: the "only tool" sentence (README:51),
  the bounded-input bullet (README:72-73), the Worker API table, the new
  deploy field, one sentence naming the second dispatcher→worker data flow.
- `specs/guidance-in-job/spec.md` — Status line flips to Implemented,
  naming PR #52 and release 1.4.0 (missed step-8 cleanup; issue #59).
- Tests: `tests/config/deploy.test.ts` (new field, default false);
  `tests/harness/adapter.test.ts` (flag off → tools array identical, prompt
  identical; flag on → `get_guidance` present, tool result carries the D12
  fence verbatim, empty snapshot → `no standing guidance.`, system prompt
  sentence present); `tests/service/server.test.ts` (auth required;
  validation rejects `limit_exceeded` and `malformed_payload`; replace
  semantics; 404 for unknown and non-running jobs); `tests/service/pool.test.ts`
  (snapshot lifecycle); `tests/client/cli.test.ts` and
  `tests/client/http.test.ts` (new subcommand, client method, pre-validation
  error).

## Invariants (checked at review, not just in tests)

1. **No new writable surface.** The worker gains no write access anywhere:
   the tool reads memory; the endpoint writes one in-memory snapshot.
2. **No new egress.** The worker still binds loopback only (worker.ts:76)
   and initiates no connection. Only the dispatcher pushes.
3. **The tool never runs in the job shell.** `get_guidance` executes
   in-process; the job shell keeps exactly `run_shell`.
4. **Bounded and verbatim.** Mid-job guidance passes the same validator,
   the same cap, and renders word for word under the same D12 fence.
5. **Opt-out is exact.** With the flag off, requests, prompts, and the
   tools array match today's bytes; tests pin this.
6. **Source neutrality.** No file names a guidance source system.
7. **No silent loss.** A rejected POST answers with the named error
   (`malformed_payload` / `limit_exceeded` / 404); the CLI pre-validates.

## Out of scope

- Roadmap steps beyond step 2; any guidance source system.
- Plugin loaders, MCP config, hooks (investigation A3).
- Contract version 4; telemetry or ledger growth.
- Delivery guarantees: a snapshot lost to a worker restart stays lost;
  the README says the snapshot is in-memory.

## Open items for the owner (the gate)

1. Approve or amend D1–D12 as marked (rec).
2. D9 (nodeinfo) — accept 404-as-signal, or grow one boolean now?
3. Confirm the PR carries the #59 Status flip as missed cleanup.
