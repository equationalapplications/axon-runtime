# Issue #10 Harness Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the decided failed-job step-count contract with tests, record it in the harness design doc, and add a test-only `baseBackoffMs` option that drops the two slow real-timer timeout tests from ~21 s to sub-second.

**Architecture:** No behavior change. `HarnessAdapter` gains an optional constructor field that defaults to the existing module constant; `backoffSleep` reads the field instead of the constant. Two new pinning tests lock the contract (Option A: `steps` counts assistant messages on every exit). The design doc's Step-semantics bullet records the decision.

**Tech Stack:** TypeScript, Vitest (fake + real timers), conventional commits.

**Spec:** `specs/issue10-harness-followups/spec.md` (Reviewed 2026-11-14; Kurt: "1, 1 … clear to proceed with the plan and implementation")

## Global Constraints

- Production backoff default stays exactly `BASE_BACKOFF_MS = 2_000` (2/4/8 s, jitter ±20%) — no default changes.
- `steps` semantics must not change: increment only on an assistant message (`src/harness/adapter.ts:244`).
- No contract schema change (`harness_steps` stays `z.number().int().nonnegative()`).
- Conventional commits. The implementation commit is `feat(harness):` — deliberately releasable so its merge exercises the #55 token scope.
- Real timers stay in the two timeout tests (no fake timers, no AbortSignal mocking — spec Rejected alternatives).

---

### Task 1: Injectable `baseBackoffMs` option (adapter)

**Files:**
- Modify: `src/harness/adapter.ts:55` (export the constant), `:84-103` (field + ctor opt), `:305-310` (`backoffSleep`)

**Interfaces:**
- Produces: `new HarnessAdapter({ endpoint, fetchImpl?, onStep?, baseBackoffMs?: number })` — optional, test-facing; default `BASE_BACKOFF_MS`. `export const BASE_BACKOFF_MS = 2_000;`

- [ ] **Step 1: Export the constant** — change `const BASE_BACKOFF_MS = 2_000;` to `export const BASE_BACKOFF_MS = 2_000;` with a comment marking the ctor option as test-facing.

- [ ] **Step 2: Add the ctor opt** — field `private readonly baseBackoffMs: number;`, opt `baseBackoffMs?: number`, assignment `this.baseBackoffMs = opts.baseBackoffMs ?? BASE_BACKOFF_MS;`

- [ ] **Step 3: Use it in `backoffSleep`** — `const exponential = this.baseBackoffMs * 2 ** attempts * jitter;` (was `BASE_BACKOFF_MS * ...`).

- [ ] **Step 4: Convert the two timeout tests** — in `tests/harness/adapter.test.ts` `describe('per-request timeout (spec item 8)')` (lines ~403-445): both `new HarnessAdapter({...})` calls gain `baseBackoffMs: 10`. Assertions unchanged.

- [ ] **Step 5: Verify speed + suite** — run `npx vitest run tests/harness/adapter.test.ts -t "per-request timeout"`. Each of the two tests must finish in <1 s (was 14.6 s / 6.1 s). Then `npx vitest run` full suite — all green.

- [ ] **Step 6: Commit** — (folded into the single implementation commit, Task 3 Step 3.)

### Task 2: Pin the step-count contract (tests + design doc)

**Files:**
- Modify: `tests/harness/adapter.test.ts` (two new tests near the retry/step tests)
- Modify: `docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md:133-137` (Step-semantics bullet)

**Interfaces:**
- Consumes: `stubResponses`, `assistantDone`, `assistantToolCall`, `job()`, `ws()` helpers already in the test file; Task 1's `baseBackoffMs`.

- [ ] **Step 1: Pinning test A — first-step exhaustion** — new test: persistent 500 stub (`stubResponses([{ status: 500 }])`), `baseBackoffMs: 10` (real timers, fast), `onStep` spy; assert `exitReason === 'endpoint_error'`, `outcome.steps === 0`, `onStep` never called, 4 fetch calls.

- [ ] **Step 2: Pinning test B — cancel after one completed step** — new test mirroring the `onStep`-aborts pattern (`stubFetch([assistantToolCall('true')])`, `onStep: () => ac.abort()`); assert `exitReason === 'cancelled'` AND `outcome.steps === 1`.

- [ ] **Step 3: RED check A** — temporarily change the increment so every fetch attempt counts (move `steps += 1` to the attempt loop top). Run pinning test A → must FAIL (steps = 4). Restore. Run again → PASS.

- [ ] **Step 4: RED check B** — temporarily gate the final `steps` report on `exitReason === 'completed'` (report 0 otherwise). Run pinning test B → must FAIL (steps = 0). Restore. Run again → PASS.

- [ ] **Step 5: Design-doc bullet** — replace the `#10 follow-up` parenthetical at `docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md:133-137` with the decided contract: `steps` counts assistant messages on EVERY exit; failed/cancelled jobs report the count reached, 0 when none; decided in #10 2026-11-14 (Kurt "1, 1"); pinned by tests.

### Task 3: Verify, review, cleanup

**Files:**
- Modify: `specs/issue10-harness-followups/LEDGER.md` (ticks), `spec.md` (status flip), delete `plan.md` + `LEDGER.md` in cleanup.

- [ ] **Step 1: Full gates** — `npx vitest run` (exit 0, read output) and `npm run build` (exit 0). Time the two converted tests: each <1 s.

- [ ] **Step 2: Independent reviewer subagent** over the full branch diff (NOT an implementer): diff-vs-spec/plan check, re-run suites, `git status --short` remnants, adjudicate deviations. Fix findings with new commits; re-review until clean.

- [ ] **Step 3: Implementation commit** — single `feat(harness): pin failed-job step-count contract; injectable test backoff` covering Tasks 1-2 (commits may split, no force-push).

- [ ] **Step 4: Cleanup commit** — flip spec status to `Implemented`, delete `plan.md` + `LEDGER.md`, then `gh pr ready` (only after review converges).

- [ ] **Step 5: Bot gauntlet + CI** — evaluate CodeRabbit findings per the reviewer-evaluation policy; no re-request comments. CI green → merge ask (Kurt merges on attended runs; merge = first releasable push → #55 proof watch).
