# Spec — harness follow-ups: failed-job step-count contract, injectable test backoff

**Date:** 2026-11-14
**Status:** Implemented — 2026-11-14; review ladder PASS (independent leaf, 0 blockers); spec + plan + ledger artifacts removed in the same-PR cleanup per the SDD lifecycle
**Branch:** `fix/issue10-harness-followups`
**Issue:** equationalapplications/axon-runtime#10
**INTENT alignment:** the repo has no INTENT.md or AGENTS.md; this check is vacuous for this lane.

## Problem

Issue #10 carries two follow-ups deferred from the PR #9 review.

### Item 1 — failed-job step-count semantics

`HarnessAdapter.run` increments `steps` only when a step produces an
assistant message (`src/harness/adapter.ts:124-129, 244`). A job that
exhausts retries on its first step returns `steps` 0. The PR #9
dispositions say the spec text counts steps on "success or final failure"
(`docs/superpowers/specs/2026-09-26-pr9-review-dispositions.md:30-33`).
The code counts success only. The contract question stayed open.

Consumers already treat `steps` as the assistant-message count:

- Pool telemetry reads the partial count into job results
  (`src/service/pool.ts:183`).
- The store persists `harness_steps` per checkpoint
  (`src/state/store.ts:132-135`).
- The contract schema allows 0 (`src/contract/schema.ts:79`,
  `z.number().int().nonnegative()`).

## Decided contract (item 1) — needs Kurt's approval

**Option A (recommended).** `steps` counts assistant messages on every
exit. A failed or cancelled job reports the count it reached. A job with
no assistant message reports 0.

**Option B (rejected).** Count one step on final failure too. This
changes the ledger comparison baseline mid-feature. It adds no signal:
failed attempts already log class, status, and elapsed time per attempt.

The code already implements Option A. The deliverable is a decision
record and pinning tests. This is not a behavior change.

### Item 2 — real-timer timeout tests are slow

The two per-request-timeout tests
(`tests/harness/adapter.test.ts:403-445`) use real timers with
`requestTimeoutMs: 100`. Real exponential backoff runs between the
attempts. Measured on base `ec3e3eb`:

| Test | Wall time |
|---|---|
| "permanently-hanging endpoint ends endpoint_error" | 14.6 s |
| "fetchImpl rejects with a TimeoutError; adapter retries then succeeds" | 6.1 s |

Together ~21 s of the suite. The backoff schedule (2/4/8 s, jittered
±20%) dominates the run.

## Proposed change

1. **Record the contract.** Update the Step-semantics bullet in
   `docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md`.
   The bullet drops the "#10 follow-up" parenthetical and states
   Option A as the decided contract, citing issue #10.
2. **Pin the contract with tests** in `tests/harness/adapter.test.ts`:
   - Retries exhausted on the first step → `endpoint_error`, `steps` 0,
     `onStep` never called.
   - Cancel after one completed step → `cancelled`, `steps` 1.
3. **Add an optional `baseBackoffMs` constructor option** to
   `HarnessAdapter`. Default: the existing `BASE_BACKOFF_MS` (2 s,
   exported, unchanged). Production behavior does not change. The two
   per-request-timeout tests pass a small value. Their wall time drops
   to under 1 s each.
4. **No contract schema change.** `harness_steps` already admits 0.

## Files touched

- `src/harness/adapter.ts` — add the `baseBackoffMs` constructor option.
- `tests/harness/adapter.test.ts` — convert the two timeout tests to the
  option; add the two pinning tests.
- `docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md` —
  record the decided contract in the Step-semantics bullet.
- `specs/issue10-harness-followups/` — this spec, plan, ledger
  (transient; removed before merge).

## Test plan

1. Run the full suite: `npx vitest run`. Exit code 0.
2. Run `npm run build`. Exit code 0.
3. Time the two converted timeout tests again. Each must run under 1 s.
4. The pinning tests must pass. Prove they pin: revert the `steps`
   increment condition temporarily and see them fail (RED check), then
   restore (GREEN).

## Rejected alternatives

- **Option B (count a step on final failure).** Rejected above: it
  moves the ledger baseline and adds no signal beyond attempt logs.
- **Mock `AbortSignal.timeout` in the timeout tests.** The tests exist
  to exercise the native-signal interplay (`AbortSignal.any` +
  `AbortSignal.timeout`). A mock hides exactly that interplay.
- **Fake timers for the timeout tests.** Vitest's fake clock does not
  drive `AbortSignal.timeout`; the stub never rejects. This is why the
  tests use real timers today (comment at
  `tests/harness/adapter.test.ts:408-411`).
- **Adopt the repo's missing AGENTS.md SDD block in this lane.** Out of
  scope here; it needs its own spec per the SDD adoption rule.
