# Investigation — axon-runtime#50: a guidance block the worker is shown word for word

Revised 2026-11-13 by Tessera (controller) after the Opus step-0 review
(REQUEST CHANGES: M1 fleet lockstep, M2 silent-strip justification, M3 shared
renderer; minors folded in). All facts verified against
`equationalapplications/axon-runtime` HEAD `07c34f1` (main) unless noted.

## 1. The problem, restated

A dispatcher often knows standing guidance a worker should not rediscover: a rule for
this part of the codebase, a decision already made, a trap. Today the only channel is
`goal` (the dispatcher's own paraphrase — meaning can drift, provenance is lost) or the
context array (but see §3.2 — the CLI cannot send it at all, and nothing marks it as
instructions or caps it as guidance). The owner ruled 2026-11-13: guidance travels **in
the job**, attached by a **fixed step at dispatch**, shown **word for word**, under a
**size cap** (realistic budget 1–3 KB, because the block rides in `messages` on every
model step — verified: the whole array is resent per call, `adapter.ts:139-141`). The
runtime stays **neutral about the source**. The open-source runtime adopts the mechanism
first; the private `axon` repo later adds the CT-matching dispatch step (blocked on this
issue's spec and on curated-thoughts#345).

## 2. Verified current state (file:line, HEAD 07c34f1)

| Fact | Evidence |
|---|---|
| Contract version is `2`, pinned by exact match on BOTH sides | Worker: `src/service/validate.ts:11-13` (any other version → `RejectError('contract_unsupported')`). Client: `src/client/http.ts` parses every envelope with `EnvelopeSchema`, whose `contract_version` is `z.literal(CONTRACT_VERSION)` (`schema.ts:75`) — a v3 envelope fails a v2 client with a thrown ZodError, and vice versa |
| Job request fields | `JobRequestSchema` (`schema.ts:38-47`): `contract_version, job_id (uuid), repo, ref, goal (min 1), context: ContextFile[] (default []), constraints, output('patch'|'report')`. Plain `z.object` — **unknown keys are silently stripped** |
| Envelope built from the runtime's own constant | `schema.ts:75`; `src/service/pool.ts:92-93`; `src/service/server.ts:37` (also the `/nodeinfo` route — `NodeInfo.contract_version`, `src/client/http.ts:12-18`, README:165) |
| Caps today | `validate.ts:26-33`: goal ≤ `max_goal_bytes` (default 32,768), context Σ bytes ≤ `max_context_bytes` (default 1,048,576) → `limit_exceeded`; defaults at `src/config/deploy.ts:26-28` |
| Render path | `HarnessAdapter.run` builds messages once at `src/harness/adapter.ts:107-109`: system = `SYSTEM_PROMPT` (`adapter.ts:72-77`) + optional deploy-level `extra_system_prompt`, composed once in the constructor (`adapter.ts:100-103`); user = `userPrompt(job)` |
| `userPrompt` | `adapter.ts:271-276`: goal, then if context non-empty `\n\nContext files:\n` + each entry as `` --- ${f.path} ---\n${f.content} `` — **verbatim, no truncation, no cap of its own** |
| `extra_system_prompt` is per-DEPLOYMENT, not per-job | `src/config/deploy.ts:31-37` (config field, ≤16,384 UTF-8 bytes, non-blank); operator-owned; README:99-101: job submitters cannot set or override it |
| Worker containment | `SYSTEM_PROMPT` (`adapter.ts:72-77`): disposable worktree, `run_shell` only, no push access; work returned as diff |
| Context files are PROMPT-ONLY | Verified by grep over **all of `src/`**: `job.context`'s only consumers are `validate.ts:30` (cap) and `adapter.ts:272` (render). Nothing materializes context files on disk; the worker never sees them as files |
| Client CLI cannot send context | `src/client/cli.ts`: `dispatch` has `--goal-file`, no context flag; hardcodes `context: []` (`cli.ts:54`). The stopgap is reachable only to a raw-HTTP dispatcher |
| Ledger stores only metadata | `recordDispatch` inserts `job_id, node_id, repo, ref, output, timestamp` — NOT goal/context (`src/controller/ledger.ts:52-60`, call at `cli.ts:64`); `recordEnvelope` stores the envelope as an opaque JSON string (`ledger.ts:95`) that nothing reads back. The worker-side `JobStore` persists the full request and re-parses with a plain cast, no schema (`src/state/store.ts:89,115`); interrupted jobs are marked and never re-run (`store.ts:159-165`). An optional field therefore needs NO ledger or store migration |
| Tests pinning the surface | `tests/contract/schema.test.ts`, `tests/harness/adapter.test.ts`, `tests/service/*` (validate), `tests/config/*`, `tests/client/http.test.ts`, `tests/controller/ledger.test.ts` |

## 3. Corrections to the issue text (found during investigation)

1. **"The worker sees it as one more file from the repo" — not literally.** Context
   entries are never materialized on disk; they are rendered into the user message
   under a `Context files:` heading with `--- path ---` headers. The true defects are:
   (a) the header implies repo provenance that does not exist, (b) no dedicated cap,
   (c) nothing semantically marks the block as standing instructions rather than repo
   content. The conclusion (a stopgap, not the mechanism) stands.
2. **The stopgap is not reachable from the shipped client.** `axon dispatch` has no
   context flag (`cli.ts:54` hardcodes `context: []`). Only a raw-HTTP dispatcher
   can use the stopgap today.
3. **`extra_system_prompt` is per-deployment.** Confirmed: composed once in the
   adapter constructor from the node's config file — cannot carry per-job guidance.

## 4. Design space (evidence-backed)

### Q1 — Dedicated field vs documented context-file convention

- Convention (context file e.g. `.axon/guidance.md`): zero contract change, but inherits
  the context caps (1 MB — far over budget), no distinct semantics, no room for
  provenance labels per item, and the ruling wants the block "apart from the goal and
  the context files" — a convention cannot separate them.
- Dedicated optional field: needs `CONTRACT_VERSION` → 3 (see Q1b for why the bump is
  mandatory, not cosmetic).
- Leans: dedicated optional field, version bump to 3.

### Q1b — WHY the bump is mandatory (settled by the Opus review, M2)

`JobRequestSchema` is a plain `z.object`: Zod **silently strips unknown keys** (zod
^4.6.5). Without a version bump, a new client sending `guidance` to an older worker
gets `status: ok`, the worker never sees the rule, and nobody can tell — the exact
silent-loss failure this feature exists to prevent. A version bump converts silent
loss into an observable `contract_unsupported` rejection (worker side,
`validate.ts:11-13`; the version check runs BEFORE the payload parse, tested at
`tests/service/validate.test.ts:77-79`).
`.strict()` is a SECOND, different protection (Fable m1): it catches a same-version
client that adds a field WITHOUT bumping — today it would be stripped silently;
under `.strict()` it fails loudly with `malformed_payload`. Precedent in-repo:
`FileSchema` in `deploy.ts:49` is already `.strict()`.
The envelope literals are a secondary reason for the bump, not the primary one.

### Q1c — Rollout cost of the bump (settled as REAL; M1)

The bump is NOT "one rebuild of the two senders". Both directions are pinned by
exact-match version checks: an upgraded controller cannot dispatch to (or read
`axon status` of jobs on) a non-upgraded worker, and an upgraded worker rejects every
job from a non-upgraded controller — including guidance-less jobs. `/nodeinfo`
reports `contract_version` (`http.ts:12-18`), so a controller can pre-check a node
before dispatch. **The mismatch is partly MASKED on the controller side** (Fable M1,
verified): `AxonClient.status` parses envelopes with `EnvelopeSchema.parse`
(`http.ts:54`), but `AxonClient.wait` wraps that call in a bare `catch {}` and keeps
polling to a one-hour default deadline (`http.ts:57-67`) — a v3 controller reading a
v2 worker's envelope times out with "timed out waiting for job" and no contract
mention. The spec must (a) state that the drain-first ordering is load-bearing
precisely because the mismatch is masked there, and (b) change `wait()` to surface a
`contract_version` mismatch immediately instead of retrying it. Also note: the ledger
records a `dispatched` row BEFORE the rejection check (`cli.ts:64-66`), so during a
lagging-worker window `contract_unsupported` rejections leave stray rows — expected,
worth stating in the rollout runbook (Fable m6).
Options for the spec:
- **(a) Lockstep upgrade** with a stated order: drain in-flight jobs, upgrade all
  workers, then upgrade the controller/CLI. No dual-version code lingers. The fleet is
  owner-operated and small (`nodes.json`), jobs are short — this is cheap today.
- **(b) Dual-accept**: workers accept 2 and 3 (guidance only under 3), client envelope
  parse accepts both, CLI sends v2 unless `--guidance-file` is given. No coordination,
  but two code paths live on indefinitely.
- Leans (a): simplest, matches the fleet's reality; the spec states the order and the
  pre-dispatch `/nodeinfo` check as the guardrail.

### Q2 — Where the block sits (system vs user)

- System position would mix dispatcher-supplied data into a channel the README reserves
  for the operator (`extra_system_prompt`, README:99-101, "job submitters cannot set or
  override it"), and would require rebuilding the once-per-adapter composed
  `systemContent` per job.
- User position: a distinctly headed, delimited section rendered by `userPrompt`,
  after the goal and before `Context files:` (guidance governs the goal; files
  illustrate it). No constructor change, no operator-channel violation.
- Leans: user message, dedicated heading.

### Q3 — Over the cap: reject or truncate

- Truncate-and-flag silently changes a rule's meaning — against the ruling's core
  ("word for word"; paraphrase-corruption is the failure being fixed). Reject with
  `limit_exceeded` reuses the existing pattern (goal/context already reject, never
  truncate).
- Byte-based (UTF-8, like the other caps), default `max_guidance_bytes` 3,072
  (top of the 1–3 KB budget), configurable like `max_goal_bytes` (`deploy.ts:26-28`
  pattern).
- Leans: reject with `limit_exceeded`.

### Q4 — Shape of the field, and ONE renderer for the cap (M3, m4)

Ruling: "a short list of items, each with its text and an optional label saying where
it came from." E.g. `guidance?: [{ label?: string, text: string }]`. Hard requirements
from the review:
- **Single source of truth for the rendered bytes**: one pure
  `renderGuidance(items): string` living in `src/contract/`, imported by BOTH
  `validate.ts` (cap check) and `adapter.ts` (render). Otherwise the validator's copy
  drifts from the renderer and the cap silently stops meaning anything. Boundary test
  asserting validator and renderer agree at exactly the cap.
- **Cap counts raw item bytes only** — Σ(`label` + `text` UTF-8 bytes) of the items,
  heading/delimiter/label-format excluded (Fable M3, revised from the earlier
  "rendered bytes" position, which contradicted its own rationale: rendered-byte
  counting would still let a renderer wording change move the acceptance boundary).
  Precedent: the context cap counts `f.content` only and ignores the `path` and the
  `--- path ---` header (`validate.ts:30` vs `adapter.ts:273`). The shared
  `renderGuidance` stays, but only for rendering and the word-for-word test — the
  validator depends on raw bytes, not the renderer, which is simpler and needs no
  boundary test.
- **Empty/absent list renders no section at all.**
- **Field validation**: `label` single-line `min(1)` (a newline could forge structure),
  `text` `min(1)` + trim check (whitespace-only text must not render as an empty rule —
  same pattern as `extra_system_prompt`, `deploy.ts:33`, Fable m4); consider a max
  item count; the section gets a fence/closing delimiter so its end is unambiguous
  even if item text contains prompt-like strings (dispatcher is trusted —
  correctness, not security).
- Open for the spec: exact delimiter format; whether a per-item byte sub-cap is worth
  it (lean: no — the raw cap suffices).

### Q5 — Per-node cap configuration

Follow `max_goal_bytes`: `max_guidance_bytes` deploy-config field, positive int,
default 3072, enforced in `validate.ts` alongside the others.

## 5. Blast radius

- **Code**: `schema.ts` (field + version + possible `.strict()`), `validate.ts`
  (cap + rejection + shared renderer use), `deploy.ts` (config field + default),
  `adapter.ts` (`userPrompt` render via the shared renderer), `cli.ts`
  (`--guidance-file` flag — else the mechanism ships unreachable, the same gap §3.2
  catches), shared `renderGuidance` in `src/contract/`.
- **Version-dependent places the bump touches**: `http.ts` (NodeInfo type; envelope
  parse), `pool.ts:92-93` (envelope literal), `server.ts:37` (`/nodeinfo` route),
  plus the dispatch path.
- **Tests**: schema round-trip + strict-mode rejection of unknown fields; validate
  reject-over-cap (raw item bytes); adapter render word-for-word + placement +
  empty-list-renders-nothing; **both** directions of the bump pinned by tests —
  `CONTRACT_VERSION - 1` explicitly (today only `+ 1` is tested, `validate.test.ts:47`;
  Fable m5); CLI flag wiring; `tests/client/http.test.ts` (envelope version);
  `tests/service/server.test.ts` (`/nodeinfo` version).
- **Docs**: README:172 (`CONTRACT_VERSION`), README:72-73 (bounded-input list gains
  the guidance cap entry); `examples/node.json` lists no caps today (Fable m3) — the
  spec decides whether to document `max_guidance_bytes` there or leave it default-only.
- **Rollout**: per Q1c — lockstep order (drain → workers → controller) or dual-accept;
  `/nodeinfo` pre-dispatch check as guardrail. No telemetry change; no security-model
  change beyond one new bounded input (README:72-73 list gains the entry); worker
  containment unchanged. Roadmap step-2 remains gated separately.

## 6. Open questions for the spec

1. Lockstep (a) vs dual-accept (b) — lean (a), state the order and the `/nodeinfo`
   pre-check (Q1c), plus the `wait()` mismatch-surfacing change the review required.
2. `.strict()` on `JobRequestSchema` under v3 — lean yes (distinct rationale in Q1b).
3. Exact heading/delimiter wording for the rendered section (source-neutral, no
   mention of any guidance source system).
4. Max item count and per-item sub-cap (Q4).
5. ~~Ledger migration~~ — SETTLED (Fable M2, verified): none needed. The spec only
   decides whether `guidance` becomes a ledger column (queryability); default lean:
   no.

## 7. Alignment checks

- axon-runtime has no INTENT.md (roadmap PR #51 states this); intent check is against
  README's security model ("Bounded input and output" — the new cap strengthens it;
  README:172 contract rules → bump is mandatory) and the roadmap's step-1 gate (this
  spec IS the gate).
- The private-repo dispatch step (CT matching) is NOT in scope here; runtime stays
  source-neutral (ruling; roadmap "What is intentionally absent").

## 8. Review trail (step 0)

- Opus medium, 2026-11-13, $0.54: REQUEST CHANGES — M1 (lockstep rollout, both
  directions pinned), M2 (silent-strip as the bump's real justification; consider
  `.strict()`), M3 (shared renderer), m1–m6. Folded in; evidence spot-checked.
- Fable high, 2026-11-13, $2.12 (cap $3): REQUEST CHANGES on the Opus-revised doc —
  M1 (`wait()` bare `catch {}` masks a version mismatch for up to the 1-hour poll
  deadline, `http.ts:57-67`), M2 (no ledger/store migration is needed — verified at
  `ledger.ts:52-60,95`, `store.ts:89,115,159-165`), M3 (cap must count raw item
  bytes, not rendered bytes; rendered-counting contradicts its own rationale),
  m1–m6 (strict rationale split, `cli.ts:64` citation, `examples/node.json` lists no
  caps, `text` trim check, explicit `CONTRACT_VERSION - 1` test, dispatch-row-before-
  rejection note). Fable independently re-verified every §2 citation against HEAD and
  confirmed the zod ^4.6.5 strip premise. All findings folded into this revision;
  each was verified by the controller against the tree before applying.
- Next: spec.md under `specs/guidance-in-job/`; the Tier-4 Fable SPEC gate runs on
  the converged spec before it is presented to Kurt (per the board's Tier-4 ruling).
