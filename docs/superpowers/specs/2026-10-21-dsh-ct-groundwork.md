# Spec: DSH×CT groundwork — generic worker system-prompt extension

Repo: axon-runtime. Date: 2026-10-21. Author: Tessera.
Status: Tier 2 APPROVED (2 rounds, 2026-10-21). Tier 3 Opus review:
REQUEST CHANGES (2026-10-21, $0.51) — M2 (token-cost claim) fixed,
m1–m5 folded (byte-based cap matching `max_goal_bytes`, whitespace-only
rejection, startup-log design step, README/examples docs note,
exact-equality AC1, startup-stdout AC6). **M1 OPEN — needs Kurt:** the
spec names CT in this public repo (Constraint 1 scope vs design-doc
practice); resolution pending his ruling, tracked as AC7.
Q1–Q4 dispositions: Q1 top-level placement; Q2 16,384 UTF-8-byte cap
(fixed value, matching `max_goal_bytes` convention); Q3 startup log
carries presence + byte count only, never contents (now Design step 4);
Q4 field name stays `extra_system_prompt`.
Issue: none yet (groundwork for the axon-queue item 2; sequencing memo
`axon` repo `docs/superpowers/specs/2026-09-26-dsh-ct-sequencing-memo.md`).
Basis: 2026-10-21 Kurt rulings (CTI-as-dependency; public repo supports the
SynapseTree wisdom roadmap **generically**; internal axon tool gets the
intuitive wisdom), verified against `main` @ `e0b4632`
(`adapter.ts`, `config/deploy.ts`, `executor/local.ts`, `contract/schema.ts`).

## Problem

Per the Sep 26 sequencing memo (post-review), the first build step of DSH×CT
is "(a) read-only CT query via `run_shell` — query-time search with zero
adapter changes". That framing has a hole the memo itself anticipates: a
worker only invokes the CT CLI if it **knows it exists**. Telling it means
putting text in front of the model, and every current route to that text is
either ad-hoc or wrongly scoped:

- `SYSTEM_PROMPT` is a hardcoded const in `adapter.ts` — no extension point.
- `job.context` files are caller-supplied; `userPrompt()` inlines them into
  the first user message **once**, but the text then rides in the
  `messages` history that is resent in **every request body**, so
  per-deployment standing instructions would either be duplicated into
  every job payload (caller's burden, recurring token cost) or not exist.
- Today the only way to give workers CT awareness is to fork the prompt —
  exactly what "public repo supports it generically" forbids.

The gap is generic: **axon-runtime has no way for a deployment operator to
append standing instructions to the worker's system prompt.** CT is merely
the first consumer (the private axon deploy would supply wording directing
workers to read-only `ct wisdom match` via `run_shell`); deploy-specific
house rules are the obvious second consumer.

## Constraints (from rulings and prior reviews)

1. **CT is never named in axon-runtime.** The public repo ships a generic
   mechanism; the private axon repo / job submitter supplies any CT wording.
   (2026-10-21 ruling: CTI consumed as a dependency; public side generic.)
2. **Sep 26 constraint:** never expose CT read+write over the axon tunnel —
   read-only only. This spec does not implement CT access at all; it only
   creates the prompt extension point the private side will use to describe
   read-only usage.
3. **No contract (v2) change.** The worker↔controller contract is frozen
   unless a change is unavoidable; worker-side config is the right owner for
   deployment-specific behavior.
4. **Trust boundary:** deploy config is operator-owned (loaded from the
   worker's local file in `loadDeployConfig`); job payloads are
   caller-owned. Standing per-deployment instructions belong on the
   operator's side of that line.

## Options considered

### Option 1 — job-context convention (zero code)

The private side writes CT-usage instructions into a context file in every
job it submits.

- ✅ Zero code; shippable today.
- ❌ Standing text is inlined into the first user message **once** by
  `userPrompt()` — but it still rides in the `messages` history that is
  **resent in every request body**, so the token cost recurs per step for
  zero conversational benefit. (The same is true of any system-prompt
  text; the difference is that standing deployment instructions belong in
  the system role, where they are also sent once per request but are
  correctly positioned for the model.)
- ❌ Caller burden: every job author must remember the convention; nothing
  enforces it.
- ❌ Wrong trust side: per-deployment posture set by job submitters.
- Verdict: viable as an *interim* (it works today), not as the groundwork.

### Option 2 — generic system-prompt extension in DeployConfig (chosen)

Add an optional operator-owned config field, e.g.
`extra_system_prompt: string (1..16384 chars, optional)`, appended to the
built-in `SYSTEM_PROMPT` at adapter construction.

- ✅ Generic: no CT references; any deployment can append standing
  instructions (CT wording, house rules, output conventions).
- ✅ Correct trust side and correct role placement. (Token cost per request
  is the **same** as a context file — the system message is element 0 of
  `messages` and rides in every request body. The advantage is posture, not
  spend.)
- ✅ Tiny blast radius: schema field + config plumb + adapter append +
  tests. Contract untouched; wire format unchanged.
- ✅ Matches the ruling's shape exactly ("deploy-config option that appends
  caller-supplied text to the worker system prompt" — supplied by the
  operator, not the job caller).
- ❌ Requires worker deploy to take effect (macbook-01 already has a pending
  deploy for 1.1.0; this would ride the next one).
- Verdict: **chosen.**

### Option 3 — generic skills/docs file shipping

Ship an operator-designated directory of files (e.g. a "skills" dir) into
each job workspace and reference it from the prompt.

- ✅ Most extensible (multi-file, versionable content).
- ❌ New workspace-staging machinery + a prompt reference convention; needs
  contract or workspace-manager changes for real guarantees.
- ❌ Content still has to reach the model through the prompt, so option 2's
  append is needed anyway — option 3 is option 2 plus file plumbing.
- Verdict: deferred. Revisit if/when workers need multi-file standing
  material; it composes with, not replaces, option 2.

## Design

1. **Schema** (`src/config/deploy.ts`): optional top-level
   `extra_system_prompt` on the strict `FileSchema` —
   `z.string().refine(s => s.trim().length > 0).refine(s =>
   Buffer.byteLength(s, 'utf8') <= 16_384).optional()` (16,384 **UTF-8
   bytes**, matching the `max_goal_bytes` convention, and rejecting
   whitespace-only values). Surface as
   `DeployConfig.extraSystemPrompt?: string`.
2. **Adapter** (`src/harness/adapter.ts`): constructor takes
   `extraSystemPrompt?: string`; the system message content becomes
   `SYSTEM_PROMPT + (extra ? '\n\n' + extra : '')`, built once per adapter
   instance. This is code hygiene, not a token saving: the system message
   is resent in every request body like the rest of `messages`. Built-in
   `SYSTEM_PROMPT` const unchanged.
3. **Plumb** (`src/executor/local.ts`): `LocalExecutor` passes
   `extraSystemPrompt: this.cfg.extraSystemPrompt` to the adapter.
4. **Startup log** (`src/worker.ts`, after `loadDeployConfig`): one line —
   `extra_system_prompt: set (<n> bytes)` or `extra_system_prompt: unset`.
   Presence + size only; **never** log the wording.
5. **Docs**: add a short field note to README's config area and an optional
   `extra_system_prompt` entry in `examples/node.json` with a neutral
   example (e.g. "always run the project's test command before
   summarizing"). No consumer-specific wording anywhere.

## Non-goals

- No CT code, CT wording, `ct` references, or MCP client in this repo.
- No contract/schema (v2) change; no job-level prompt fields (a job-level
  prompt field would let any submitter rewrite worker posture — rejected on
  trust grounds).
- No bundle renderer, OKF handling, or artifact export (memo items 2b/2d).
- No behavior change for deployments that omit the field: byte-identical
  system message.

## Acceptance criteria

1. Config with `extra_system_prompt` parses; the system message content of
   every request is exactly `SYSTEM_PROMPT + '\n\n' + extra` (exact-equality
   assertion on captured request bodies — covers "appears once" without a
   substring count).
2. Config without it produces the exact current system message (regression
   guard: string equality on captured request bodies).
3. Config validation rejects: empty string, whitespace-only string
   (e.g. `"\n"`, `"  "`), > 16,384 UTF-8 bytes, wrong type (strict schema
   already rejects unknown keys).
4. `npm run typecheck`, `npm run test` (vitest, low `-j`), `npm run build`
   pass.
5. Grep gate over `src/` on this branch: no occurrence of
   `curated[-_]thoughts` or `\bCT\b` (case-sensitive).
6. Startup stdout contains the field's byte count and does **not** contain
   any part of the configured wording.
7. Genericity gate (pending M1 ruling): the *shipped* artifacts (`src/`,
   `README.md`, `examples/`) contain no consumer naming. Whether design
   docs in this public repo may name the consumer is the open M1 question
   for Kurt.

## Open questions for review

- Q1: Field placement — top-level (chosen; harness-wide posture) vs under
  `endpoint` (rejected: it is not endpoint properties, and `endpoint` is
  strictly about the LLM API connection)?
- Q2: Cap at 16 KiB — right order of magnitude, or tie it to a config-declared
  ceiling like the other byte caps (`max_goal_bytes` pattern)?
- Q3: Should the worker log a one-line notice at startup when the field is
  set (observability) — and does that leak deploy-private wording into logs?
  (Proposed: log presence + byte count, never contents.)
- Q4: Name — `extra_system_prompt` vs `system_prompt_addendum` vs
  `worker_instructions`. Chosen for descriptiveness + honesty about
  mechanics; reviewer may prefer operator-facing framing.
