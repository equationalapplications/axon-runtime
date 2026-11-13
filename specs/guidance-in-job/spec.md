# Spec — a guidance block the worker is shown word for word

**Date:** 2026-11-13
**Status:** DRAFT — SPEC LADDER COMPLETE, awaiting owner approval. Opus spec delta APPROVE WITH NITS ($0.25, folded) → Tier-4 Fable spec gate REQUEST CHANGES ($2.11, cap $3; M1 + m1–m5, ALL folded) → down-ladder Opus delta APPROVE WITH NITS ($0.18, no BLOCKER/MAJOR; 5xx-retry + discoverability minors folded). Merge gate: Kurt.
**Branch:** `feat/issue50-guidance-in-job`
**Issue:** equationalapplications/axon-runtime#50
**Backbone:** [investigation.md](./investigation.md) (Step 0 converged: Opus $0.54 RC → all findings folded → Fable $2.12 RC → all findings verified and folded; 0 open BLOCKER/MAJOR)

## Summary

Add an optional `guidance` field to the job contract (v3): a short list of items the
worker is shown **word for word**, apart from the goal and the context files, under a
raw-byte cap. The runtime stays neutral about where guidance comes from. This is
roadmap step 1 (`docs/ROADMAP.md`, merged PR #51); the private `axon` repo's CT
dispatch step is downstream and out of scope here.

## Ruled decisions (settling every open question from the investigation)

| # | Question | Decision | Why |
|---|---|---|---|
| D1 | Field vs convention | Dedicated optional field `guidance?: GuidanceItem[]`; `CONTRACT_VERSION` → **3** | Zod silently strips unknown keys; the bump is what turns silent guidance loss into an observable `contract_unsupported` rejection (inv. Q1b) |
| D2 | `JobRequestSchema` strictness | `.strict()` on `JobRequestSchema` AND on `GuidanceItemSchema` (nested unknown keys must not silently vanish — a typo'd `lable` would otherwise drop provenance); other nested schemas keep today's leniency, and Invariant 2's wording stays scoped to the fields this spec adds | Different protection: a same-version client adding an unbumped field fails loudly with `malformed_payload` instead of being stripped (inv. Q1b / Fable m1); nested gap closed per Opus spec-delta m2. In-repo precedent: `FileSchema`, `deploy.ts:49` |
| D3 | Rollout | **Lockstep**: drain in-flight jobs → upgrade workers → upgrade controller/CLI; `/nodeinfo` pre-check before dispatch. Runbook notes: during a lagging-worker window every `contract_unsupported` rejection still leaves a `dispatched` ledger row (recorded before the rejection check, `cli.ts:64-65`) — expected, not a bug | Both directions are exact-match pinned; the owner-operated fleet is small and jobs are short (inv. Q1c). **For the v2→v3 bump the drain-first order is the ONLY guard against the masked-mismatch hang** (Fable spec-gate M1): the polling client at risk is the OLD binary, which D4 cannot fix |
| D4 | `wait()` observability | `AxonClient.status` reads `contract_version` from the raw response body BEFORE `EnvelopeSchema.parse` and raises a distinguishable typed contract error carrying the node's `contract_version` on ANY schema-parse failure of a terminal body (not just version mismatches — a terminal envelope that fails once never parses later); `AxonClient.wait` rethrows ONLY that typed contract error immediately, and keeps retrying everything else — 404, fetch/network errors, non-2xx responses (a 502 with an HTML body throws in `res.json()` before any parse and must keep retrying), and JSON parse failures (the existing timeout test at `tests/client/http.test.ts:86` depends on 404 retrying; add a 5xx-retry test). No extra `/nodeinfo` call on the error path | **Forward-looking:** D4 ships in the NEW binary, so it cannot guard the v2→v3 bump itself (see D3) — it protects the v3→v4 bump and every later one (Fable spec-gate M1 + m1: the parse lives in `status()`, `http.ts:52-54`; `wait()` never sees a body). Today the bare `catch {}` masks any mismatch until the 1-hour deadline (inv. Q1c / Fable M1); rethrow scope narrowed to the typed error only per the down-ladder Opus delta (a gateway 5xx must not kill a wait) |
| D5 | Prompt position | User message, dedicated fenced section rendered by `userPrompt` after the goal and before `Context files:` | Keeps dispatcher data out of the operator-owned system channel (README:99-101); no constructor change (inv. Q2) |
| D6 | Over the cap | Reject `limit_exceeded`; never truncate | Truncation silently changes a rule's meaning — the failure this feature exists to prevent; goal/context already reject (inv. Q3) |
| D7 | Cap semantics | `max_guidance_bytes` deploy config, positive int, **default 3,072**; counts Σ UTF-8 bytes of `label` + `text` **raw item bytes only** — heading, delimiter, and label-format bytes excluded | Precedent: context cap counts `f.content` and ignores the header (`validate.ts:30` vs `adapter.ts:273`); renderer-wording changes can never move the acceptance boundary (inv. Q4 / Fable M3) |
| D8 | Renderer | One pure `renderGuidance(items): string` in `src/contract/guidance.ts`, used by `adapter.ts`; the validator depends on raw bytes, not the renderer | Single render truth; no validator/renderer boundary test needed under D7 |
| D9 | Field shape | `guidance?: Array<{ label?: string; text: string }>`; `label` non-empty single line; `text` non-empty, not whitespace-only (trim check like `extra_system_prompt`, `deploy.ts:33`), MAY span multiple lines, but the validator rejects any `text` containing a rendered closing-delimiter line OR a line beginning with `- ` (a continuation line starting `- ` would forge an item boundary and misattribute `label` provenance); max 16 items; `GuidanceItemSchema` is `.strict()` (D2). Discoverability (down-ladder delta): the CLI pre-validates `--guidance-file` against `GuidanceItemSchema` client-side BEFORE dispatch, so a bullet-list-style file fails at the dispatcher with a named, actionable message instead of a server rejection; the README documents the no-leading-`- ` rule | Whitespace-only text must not render as an empty rule (Fable m4); multi-line text + delimiter/boundary-injection rejection closes the section-ambiguity gap (Opus spec-delta m1 + Fable spec-gate m2); CLI-side pre-validation keeps ordinary markdown rules usable with a clear error instead of silent surprise (down-ladder Opus delta) |
| D10 | Ledger | No ledger or store migration; `guidance` is NOT added as a ledger column | Verified: `recordDispatch` stores metadata only (`ledger.ts:52-60`); `JobStore` re-parses the full request with a plain cast (`store.ts:89,115`); interrupted jobs never re-run (`store.ts:159-165`) (Fable M2) |
| D11 | CLI | `axon dispatch --guidance-file <path>` reads a JSON array of items and sends `guidance`; flag omitted → field omitted (not `[]`) | Without it the mechanism ships unreachable to the shipped client (inv. §3.2) |
| D12 | Rendered wording | Heading `Standing guidance (verbatim, from the dispatcher):`; items as `- [label] text` / `- text`; section ends with `=== End of standing guidance ===` (`===` style so the closing line can never be misread as a `--- path ---` context-file header); empty/absent list renders no section at all | Source-neutral — no guidance-source system is named (ruling; roadmap "intentionally absent"); the fence makes the section end unambiguous, and D9 forbids item text containing it |

## Scope (files)

- `src/contract/schema.ts` — `CONTRACT_VERSION = 3`; `GuidanceItemSchema`; `guidance`
  optional on `JobRequestSchema`; `.strict()`.
- `src/contract/guidance.ts` (new) — `renderGuidance` + `guidanceBytes` (the raw-byte
  counter; validator-side truth. The CLI CANNOT pre-check a node's cap — `/nodeinfo`
  reports no caps (`server.ts:35-41`) — so at most it warns when a file exceeds the
  3,072 default, per Fable spec-gate m4).
- `src/service/validate.ts` — cap check + `limit_exceeded` rejection.
- `src/config/deploy.ts` — `max_guidance_bytes` (positive int, default 3072).
- `src/harness/adapter.ts` — `userPrompt` renders the section via `renderGuidance`.
- `src/client/http.ts` — D4 `wait()` change (NodeInfo type unchanged).
- `src/client/cli.ts` — D11 flag.
- `README.md` — bounded-input list gains the guidance cap (README:72-73);
  `CONTRACT_VERSION` mention (README:172); rollout note (D3/D4).
- `examples/node.json` — unchanged (lists no caps today; default-only).
- Tests: `tests/contract/schema.test.ts` (round-trip, strict, item validation),
  `tests/service/validate.test.ts` (`CONTRACT_VERSION - 1` explicit case — only `+1`
  exists today at line 47; over-cap; at-cap boundary; label bytes counted),
  `tests/harness/adapter.test.ts` (word-for-word, placement, absent/empty renders
  nothing), `tests/client/http.test.ts` (envelope v3; `wait()` fails fast on ANY
  schema-parse failure of a terminal body — version mismatch included — instead of
  retrying to the deadline, keeps retrying on fetch/network/404, and rethrows the
  typed contract error from `status()`),
  `tests/service/server.test.ts` (`/nodeinfo` version), `tests/config/deploy.test.ts`
  (new cap field), plus D9-specific cases: `text` containing the closing-delimiter
  line → rejected; whitespace-only `text` → rejected; unknown key inside a guidance
  item → `malformed_payload`; multi-line `text` accepted and rendered verbatim;
  `text` with a line beginning `- ` → rejected (forged item boundary).

## Invariants (checked at review, not just in tests)

1. **Word for word:** the bytes of each `label`/`text` item appear verbatim in the
   user message; nothing reorders, wraps, or paraphrases item text.
2. **Silent loss is impossible in the fields this spec adds:** v3 guidance to a v2
   worker → `contract_unsupported` (D1); unknown top-level fields under v3 and
   unknown keys inside a guidance item → `malformed_payload` (D2). **For THIS
   rollout (v2↔v3) the drain-first order is the only guard against a masked
   mismatch** — the client that can hang is the old binary, which ships before D4
   exists; D4 is forward-looking protection for the v3→v4 bump and later (D3, D4;
   Fable spec-gate M1).
3. **Bounded input:** guidance is capped (D7) and the README bounded-input list says
   so when this ships.
4. **Source neutrality:** no file in this repo names any guidance source system.
5. **Containment unchanged:** the worker still gets only `run_shell` and the
   worktree; guidance adds no egress or access.

## Out of scope

- Delivery of guidance while a job runs (roadmap step 2; gated separately).
- The private repo's CT-matching dispatch step (blocked on this spec and
  curated-thoughts#345).
- Any UI/ledger changes (D10).

## Review trail

- Step 0 backbone converged (see investigation.md §8: Opus $0.54, Fable $2.12, all
  findings verified and folded).
- Spec ladder: Opus spec delta DONE (APPROVE WITH NITS, $0.25; m1 closing-delimiter
  ambiguity → `===` delimiter + D9 injection rejection; m2 nested strictness →
  `GuidanceItemSchema` `.strict()` + scoped invariant; m3 transient-error definition →
  D4 rewritten). Tier-4 Fable SPEC gate DONE (REQUEST CHANGES, $2.11 vs cap $3;
  every file:line citation verified independently): M1 — D4 cannot guard the v2→v3
  rollout (the polling client at risk is the OLD binary) → D3/D4/Invariant-2 reworded:
  drain-first is the only guard for THIS bump, D4 is forward-looking; m1 → the parse
  lives in `status()`, `wait()` rethrows except 404/fetch (`http.test.ts:86` pins
  404-retry); m2 → D9 also rejects text lines beginning `- `; m3 → stray-ledger-row
  runbook note moved into D3; m4 → guidanceBytes is validator-side truth, CLI cannot
  pre-check node caps; m5 nit (branch exists — PR #52). Down-ladder verification DONE
  (board rule, Tier 2 suspended → Opus `--effort low`): APPROVE WITH NITS, $0.18, no
  BLOCKER/MAJOR; folded: D4 rethrow narrowed to the typed contract error only (a
  gateway 5xx throwing in `res.json()` must keep retrying; 5xx-retry test added);
  D9 discoverability via CLI-side pre-validation of `--guidance-file` against
  `GuidanceItemSchema` + README documentation of the no-leading-`- ` rule.
  Implementation ladder clarification (haiku medium rung, adopted): guidance
  CONTENT-rule violations (delimiter / `- ` boundary injection) reject with
  `malformed_payload` — raising the byte cap cannot help an operator — while the
  byte cap alone rejects with `limit_exceeded` (D6 unchanged; this refines the
  validate.ts scope line above).
  Next: OWNER APPROVAL (Kurt) — RECEIVED 2026-11-13; implementation merged into
  this PR and under review.
- Merge gate: Kurt's spec approval. The PR stays DRAFT until implementation is under
  way; nothing merges without his go.
