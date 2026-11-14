# LEDGER — issue #10 harness follow-ups

**What's in flight:** implementation complete (`98fbc45`), independent review PASS (2026-11-14, 0 blockers, 2 NITs — stale header fixed here, export surface judged spec-conformant). Cleanup in progress. Branch `fix/issue10-harness-followups`, PR #57.

## Task 1: Injectable `baseBackoffMs` option

- [x] Export `BASE_BACKOFF_MS`, add ctor opt, use in `backoffSleep` (plan Task 1, Steps 1-3) — `src/harness/adapter.ts` (7 insertions on the feature diff)
- [x] Convert the two per-request-timeout tests to `baseBackoffMs: 10` (Step 4) — both constructor calls updated, assertions untouched
- [x] Timing + suite verification (Step 5) — evidence: adapter test file 25s-class → **1.66s** (`time npx vitest run tests/harness/adapter.test.ts`, 35/35 passed); timeout describe block 1.48s total; real 2026-11-14 runs in session log

## Task 2: Pin the step-count contract

- [x] Pinning test A — first-step exhaustion → `endpoint_error`, steps 0, no `onStep` (Step 1) — `tests/harness/adapter.test.ts` `pin #10 contract: retries exhausted on the FIRST step…`
- [x] Pinning test B — cancel after one completed step → `cancelled`, steps 1 (Step 2) — `pin #10 contract: cancel after one completed step…`
- [x] RED check A — mutation: `steps: exitReason === 'completed' ? steps : steps + 1` (Option-B-style) → **BOTH pin tests FAIL** (2 failed | 33 skipped); restored → PASS. Stronger than planned: test B also catches the count-on-failure deviation (Step 3) — evidence: vitest run 2026-11-14 14:31Z
- [x] RED check B — mutation: `steps: exitReason === 'completed' ? steps : 0` (completed-only) → test B FAILs (1 failed | 1 passed), test A passes; restored → PASS (Step 4) — evidence: vitest run 2026-11-14 14:32Z
- [x] Design-doc Step-semantics bullet records the decided contract (Step 5) — `docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md` bullet rewritten with DECIDED marker + rejected alternative

## Task 3: Verify, review, cleanup

- [x] Full suite + build green, timing re-check (Step 1) — evidence: `npx vitest run` → 23 files / **259 passed (259)**, exit 0; `npm run build` (tsc) exit 0
- [x] Independent reviewer subagent over full branch diff — verdict + evidence: **PASS** (2026-11-14, independent leaf, 46s): all five spec points verified, production wiring confirmed inert, real re-runs 23 files/259 passed exit 0 + build exit 0 + timeout describe 1.55s; transcript deleg_8e5f65d1/task-0.log
- [x] Implementation commit (`feat(harness):`) pushed — SHA: `98fbc45`
- [ ] Cleanup commit: spec → `Implemented`, plan + ledger deleted, `gh pr ready` — SHA:
- [ ] Bot reviews evaluated, CI green, merge ask posted
