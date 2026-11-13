# Spec — a guidance block the worker is shown word for word

**Date:** 2026-11-13
**Status:** DRAFT — in review (Opus delta pending → Tier-4 Fable spec gate)
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
| D2 | `JobRequestSchema` strictness | `.strict()` under v3 | Different protection: a same-version client adding an unbumped field fails loudly with `malformed_payload` instead of being stripped (inv. Q1b / Fable m1). In-repo precedent: `FileSchema`, `deploy.ts:49` |
| D3 | Rollout | **Lockstep**: drain in-flight jobs → upgrade workers → upgrade controller/CLI; `/nodeinfo` pre-check before dispatch | Both directions are exact-match pinned; the owner-operated fleet is small and jobs are short (inv. Q1c) |
| D4 | `wait()` observability | `AxonClient.wait` must rethrow contract-version parse failures **immediately** as a dedicated error naming both versions (node's via `/nodeinfo`, client's `CONTRACT_VERSION`); only genuine transient errors keep retrying | Today a bare `catch {}` masks the mismatch until the 1-hour deadline (inv. Q1c / Fable M1 — the drain-first order is load-bearing *because* of this masking) |
| D5 | Prompt position | User message, dedicated fenced section rendered by `userPrompt` after the goal and before `Context files:` | Keeps dispatcher data out of the operator-owned system channel (README:99-101); no constructor change (inv. Q2) |
| D6 | Over the cap | Reject `limit_exceeded`; never truncate | Truncation silently changes a rule's meaning — the failure this feature exists to prevent; goal/context already reject (inv. Q3) |
| D7 | Cap semantics | `max_guidance_bytes` deploy config, positive int, **default 3,072**; counts Σ UTF-8 bytes of `label` + `text` **raw item bytes only** — heading, delimiter, and label-format bytes excluded | Precedent: context cap counts `f.content` and ignores the header (`validate.ts:30` vs `adapter.ts:273`); renderer-wording changes can never move the acceptance boundary (inv. Q4 / Fable M3) |
| D8 | Renderer | One pure `renderGuidance(items): string` in `src/contract/guidance.ts`, used by `adapter.ts`; the validator depends on raw bytes, not the renderer | Single render truth; no validator/renderer boundary test needed under D7 |
| D9 | Field shape | `guidance?: Array<{ label?: string; text: string }>`; `label` non-empty single line; `text` non-empty and not whitespace-only (trim check like `extra_system_prompt`, `deploy.ts:33`); max 16 items | Whitespace-only text must not render as an empty rule (Fable m4); item cap is a sanity bound |
| D10 | Ledger | No ledger or store migration; `guidance` is NOT added as a ledger column | Verified: `recordDispatch` stores metadata only (`ledger.ts:52-60`); `JobStore` re-parses the full request with a plain cast (`store.ts:89,115`); interrupted jobs never re-run (`store.ts:159-165`) (Fable M2) |
| D11 | CLI | `axon dispatch --guidance-file <path>` reads a JSON array of items and sends `guidance`; flag omitted → field omitted (not `[]`) | Without it the mechanism ships unreachable to the shipped client (inv. §3.2) |
| D12 | Rendered wording | Heading `Standing guidance (verbatim, from the dispatcher):`; items as `- [label] text` / `- text`; section ends with `--- End of standing guidance ---`; empty/absent list renders no section at all | Source-neutral — no guidance-source system is named (ruling; roadmap "intentionally absent"); the fence makes the section end unambiguous |

## Scope (files)

- `src/contract/schema.ts` — `CONTRACT_VERSION = 3`; `GuidanceItemSchema`; `guidance`
  optional on `JobRequestSchema`; `.strict()`.
- `src/contract/guidance.ts` (new) — `renderGuidance` + `guidanceBytes` (the raw-byte
  counter both validator and CLI can reuse).
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
  nothing), `tests/client/http.test.ts` (envelope v3; `wait()` fails fast on version
  mismatch instead of retrying to the deadline), `tests/service/server.test.ts`
  (`/nodeinfo` version), `tests/config/deploy.test.ts` (new cap field).

## Invariants (checked at review, not just in tests)

1. **Word for word:** the bytes of each `label`/`text` item appear verbatim in the
   user message; nothing reorders, wraps, or paraphrases item text.
2. **Silent loss is impossible in both directions:** v3 guidance to a v2 worker →
   `contract_unsupported` (D1); v2-shaped unknown fields under v3 → `malformed_payload`
   (D2); v2 envelope at a v3 client during rollout → immediate named error (D4).
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
- Spec ladder: pending — Opus delta on this spec, then ONE Tier-4 Fable spec gate
  (board ruling: Fable is the final spec gate before Kurt).
- Merge gate: Kurt's spec approval. The PR stays DRAFT until implementation is under
  way; nothing merges without his go.
