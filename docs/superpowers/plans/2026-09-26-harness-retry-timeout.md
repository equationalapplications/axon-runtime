# Plan: harness retry with per-request timeout (#8, PR #9)

Repo: axon-runtime. Branch: `feat/harness-retry-timeout`. Spec:
`docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md`
(APPROVED — Gemini review, all three gates decided 2026-09-26).

Gate command (run after EVERY task from repo root):
```
npm ci && npm run typecheck && npm test
```
Baseline before Task 1: suite green, typecheck clean (verify and record
counts: `npx vitest run --reporter=basic 2>&1 | tail -5`).

## Task 1 — Config surface (`src/config/deploy.ts` + types)

Add optional, backward-compatible fields to the endpoint config:

- `request_timeout_ms?: number` — default 600_000 (10 min), validated
  positive integer; default applied in the same place existing endpoint
  defaults are resolved (read the file first; mirror its pattern exactly).
- `max_retries?: number` — default 3, validated non-negative integer.
- Update `tests/config/` (find the existing deploy-config test file;
  add cases: absent fields → defaults; zero/negative → validation error).

Verify: gate. Then STOP — controller reviews diff + re-runs gate before
Task 2 is dispatched.

## Task 2 — Retry loop + per-request timeout in `HarnessAdapter.run`

Rewrite the fetch section of `src/harness/adapter.ts` per spec §Design:

- Wrap the per-step fetch in an attempt loop (`attempts` ≤ `max_retries`).
- Per-request signal: `AbortSignal.any([signal, AbortSignal.timeout(ms)])`.
- **Abort disambiguation order (load-bearing, spec-mandated):** on any
  abort/throw, check `signal.aborted` FIRST → return `outcome('cancelled')`
  with zero retries; only when the job signal is clean classify as
  retryable (timeout → `timeout_request` internal class; network → retry).
- Retryable: network errors, request timeout, 408, 429, 499, 5xx, JSON
  parse failure on 200, empty `choices` on 200. Non-retryable: all other
  4xx → immediate `endpoint_error`.
- Backoff: 2/4/8 s jittered ±20%; `Retry-After` honored when parseable
  (seconds or HTTP-date), clamped ≤ 60 s; unparseable/past/negative →
  exponential backoff, never throw, never 0 ms. Sleeps abort on job signal.
- `steps += 1` / `onStep` fire ONLY on a step producing an assistant
  message — restructure so the attempt loop lives INSIDE the step, not
  around it.
- Guard `response.json()` + `choices[0]` access inside the retryable path
  (they currently throw past all classification).
- Failed-attempt diagnostics logged via `console.warn` (worker-log channel;
  no new logger plumbing in this PR): `attempt N/M failed: <class>
  status=<code|-> elapsed_ms=<ms>`.
- Keep HARNESS_VERSION, cost math, tool execution, summary handling
  untouched.

Verify: gate. STOP — controller review + re-run before Task 3.

## Task 3 — Acceptance tests (`tests/harness/adapter.test.ts`)

Implement spec acceptance tests 1–10 exactly, including:

- 8b (job-signal abort during hung request → `cancelled`, ZERO extra fetch
  calls), 8c (`Retry-After: banana` → exponential fallback, no throw).
- Fake timers for backoff where practical (`vi.useFakeTimers`); assert
  fetch call counts for the 401-fast-fail and exhaustion cases.
- Update the existing endpoint-failure test to assert 4 attempts (1+3)
  per spec item 10 — deliberately, with a comment.
- Test the config defaults end-to-end (adapter with default constructor
  opts issues a fetch whose combined signal has ~600 s timeout — assert
  `signal` present, don't assert exact ms).

Verify: gate + full suite count vs baseline. STOP — controller re-run,
then implementation review loop (GLM pass + `opus-review --repo
~/code/github/equationalapplications/axon-runtime --range
origin/main...HEAD --context docs/superpowers/specs/2026-09-26-harness-retry-timeout-design.md`).

## Controller rules (standing)

- Serial tasks, one implementer at a time; controller re-runs the gate
  and compares counts after each task.
- Conventional Commits per task (`feat(harness): ...`,
  `test(harness): ...`); push after each green gate.
- Brief each implementer with the CURRENT branch state (commit SHAs,
  helper names from prior tasks), not plan-time assumptions.
