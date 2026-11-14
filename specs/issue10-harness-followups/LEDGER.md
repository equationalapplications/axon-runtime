# LEDGER — issue #10 harness follow-ups

**What's in flight:** nothing — plan written, implementation not started. Branch `fix/issue10-harness-followups`, PR #57 (draft).

## Task 1: Injectable `baseBackoffMs` option

- [ ] Export `BASE_BACKOFF_MS`, add ctor opt, use in `backoffSleep` (plan Task 1, Steps 1-3)
- [ ] Convert the two per-request-timeout tests to `baseBackoffMs: 10` (Step 4)
- [ ] Timing + suite verification (Step 5) — evidence:

## Task 2: Pin the step-count contract

- [ ] Pinning test A — first-step exhaustion → `endpoint_error`, steps 0, no `onStep` (Step 1)
- [ ] Pinning test B — cancel after one completed step → `cancelled`, steps 1 (Step 2)
- [ ] RED check A — mutation: count every attempt → test A FAILs, restore → PASS (Step 3) — evidence:
- [ ] RED check B — mutation: report steps only on `completed` → test B FAILs, restore → PASS (Step 4) — evidence:
- [ ] Design-doc Step-semantics bullet records the decided contract (Step 5)

## Task 3: Verify, review, cleanup

- [ ] Full suite + build green, timing re-check (Step 1) — evidence:
- [ ] Independent reviewer subagent over full branch diff — verdict + evidence:
- [ ] Implementation commit (`feat(harness):`) pushed — SHA:
- [ ] Cleanup commit: spec → `Implemented`, plan + ledger deleted, `gh pr ready` — SHA:
- [ ] Bot reviews evaluated, CI green, merge ask posted
