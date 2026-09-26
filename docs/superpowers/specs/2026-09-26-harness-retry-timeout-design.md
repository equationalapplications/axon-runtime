# Spec: harness retry with per-request timeout (#8)

Repo: axon-runtime. Date: 2026-09-26. Author: Tessera.
Status: DRAFT — Kurt's spec approval gates implementation; PR opens now as the review surface.
Issue: equationalapplications/axon-runtime#8.
Investigation basis: live failures 2026-09-26 (jobs 4e76307e, c71ca6e5,
dee43e5b — all `endpoint_error`, ~6 min, 6–9 steps, empty output) + source
review verified against `main` (`adapter.ts`, `pool.ts`, `schema.ts`) + Opus
review 6b496e77 of the sequencing memo.

## Problem

The harness makes one fetch per step and has no error handling beyond three
bare failure returns:

- `adapter.ts:98-100` — network error → `endpoint_error`
- `adapter.ts:101` — any non-2xx → `endpoint_error`
- `adapter.ts:115` — empty `choices` → `endpoint_error`

Two defects follow:

1. **No per-request timeout.** The fetch at `adapter.ts:90` passes no
   `signal` and no timeout, so Node/undici defaults apply (300 s headers /
   300 s body). Context grows every step, so late-step LLM calls get slower;
   when one crosses 300 s undici aborts, the bare catch classifies it as
   `endpoint_error`, and the job dies. This is the leading explanation for
   the 2026-09-26 pattern (three long jobs died at 6.0–6.8 min wall clock,
   mid-conversation; short jobs never hit it; pool wall-clock deaths
   classify as `timeout`, not `endpoint_error` — `pool.ts:216`).
2. **No retry.** One transient failure — network blip, 429, 5xx, 504-style
   gateway timeout, malformed 200 body — kills the whole job. Hermes (same
   Z.ai endpoint, same account) survives identical conditions via its retry
   ladder (`api_max_retries` default 3 + escalation phases), which is the
   port reference.

Secondary defect in the same code path (same fix, same tests): unguarded
throws. `response.json()` at `adapter.ts:103` and `body.choices[0]` at
`:114` sit outside any try — a 200 response with an HTML error page or
truncated body throws out of `run()` entirely, bypassing even
`endpoint_error` classification (the pool's catch in `pool.ts:170` then
labels it `harness_error`).

## Goals

1. A job survives transient endpoint failures: network errors, 408 / 429 /
   499 / 5xx responses, per-request timeouts, and 200-with-malformed-body.
2. A slow LLM generation cannot silently kill the job: each request carries
   an explicit, configurable timeout, classified as its own retryable
   failure (and finally as `endpoint_error`, not `timeout` — that stays
   reserved for the pool's wall-clock classification).
3. Failures are observable: each failed attempt logs status/class and
   elapsed ms.
4. Cost and budget semantics stay honest: retried attempts do not inflate
   step counts or cost attribution.

## Non-goals

- No resume across worker restarts (job-level replay is out of scope).
- No request coalescing, streaming, or backpressure changes.
- No changes to the pool's wall-clock `timeout` classification, budget
  gating, or the step-cap semantics for *successful* steps.
- No contract change: `ExitReason` keeps its current values; the wire
  contract stays v2.

## Design

### 1. Per-request timeout

Every fetch runs with an explicit timeout:

```
requestSignal = AbortSignal.any([signal, AbortSignal.timeout(cfg.request_timeout_ms)])
```

- `request_timeout_ms` is a new optional deploy-config endpoint field
  (`src/config/deploy.ts`), default **600 000 ms (10 min)** — generous
  enough that a legitimately slow late-step generation completes; the
  300 s undici default is the failure mode, not the target. Accepted
  trade-off: on a job whose `timeout_seconds` ≤ 600, one max-length
  request can consume the whole wall clock before any retry — the pool
  timer cancels it as `timeout`, which is correct behavior.
- Prerequisite: `AbortSignal.any` + `AbortSignal.timeout` need Node ≥
  20.3; this repo targets Node 24 (CI), so no action, but noted for
  any future Node downgrade.
- `AbortSignal.any` keeps the job's own abort signal authoritative:
  cancellation and the pool wall-clock timer must cut into a hung request
  immediately.
- On timeout-abort (distinguishable via `signal.throwIfAborted()` /
  `TimeoutError`), classify `timeout_request` (internal, retryable).

### 2. Retry loop (per step, inside the existing while)

```
attempts = 0
loop:
  try fetch → response
  catch (network/timeout):
    if attempts < max_retries and retryable: backoff; attempts++; continue
    else return endpoint_error (with diagnostics)
  if !response.ok:
    if status in {408, 429, 499, 5xx} and attempts < max_retries:
      backoff (respecting Retry-After when present); attempts++; continue
    return endpoint_error
  parse JSON (guarded): parse/shape failure → retryable like 5xx
  empty choices → retryable like 5xx
  ... existing happy path ...
```

- **Retry budget:** default `max_retries: 3` per STEP (not per job), so a
  60-step job cannot accumulate 180 retries; the wall-clock and budget caps
  still bound the total. Configurable via the same deploy-config endpoint
  block.
- **Backoff:** exponential base 2 s (2, 4, 8 s), jittered ±20%. When the
  response carries `Retry-After` (seconds or HTTP-date), use it instead
  (clamped to 60 s). **`Retry-After` fallback rule:** if the header is
  present but unparseable, or parses to a past/negative value, fall back
  to the standard exponential backoff — never throw and never sleep 0 ms.
  Backoff sleeps abort immediately on the job signal — cancellation must
  never wait behind a sleep.
- **Abort disambiguation (order is load-bearing):** when the request
  aborts, check the job `signal.aborted` FIRST and return `cancelled`
  immediately (no retry, no backoff) — only when the job signal is clean
  may the abort be classified as a retryable `timeout_request`. Parent
  cancellation (job cancel, pool wall-clock) must never trigger retries.
- **Retryable set:** network errors, request timeouts, 408, 429, 499, all
  5xx, JSON parse failures on 200, missing/empty `choices` on 200.
  **Non-retryable:** all other 4xx (401/403/400/404/422…) — fail fast with
  `endpoint_error` + status logged; retrying auth/config errors is waste.
- **Step semantics:** `steps += 1` and `onStep` fire only on a step that
  PRODUCES an assistant message (success or final failure). Retried
  attempts inside a step do not increment `steps` and do not call `onStep`.
- **Telemetry:** failed attempts log to the worker log via the existing
  step-callback channel — `attempt 2/3 failed: status=502 elapsed_ms=4821`
  (class, status if any, elapsed ms). No new `ExitReason` values; a job
  that exhausts retries still ends as `endpoint_error` (with the last
  failure's diagnostics in the log).

### 3. Config surface

`DeployConfig['endpoint']` gains optional fields (backward-compatible,
defaults preserve availability while fixing the 300 s trap):

```ts
request_timeout_ms?: number;  // default 600_000
max_retries?: number;         // default 3
```

Worker node configs (macbook-01 et al.) only need changes if the defaults
are wrong for them; no redeploy coordination beyond the npm pin bump.

## Acceptance tests (extend `tests/harness/adapter.test.ts`)

1. Retries a 500 then succeeds on the next attempt; `steps` reflects ONE
   step; `onStep` called once for it; outcome `completed`.
2. Retries a network rejection (fetchImpl throws once) then succeeds;
   same single-step semantics.
3. Retries 429 honoring `Retry-After: 1` (fake timers or ≥1s real sleep
   assertion on the fetch call spacing).
4. Exhausts retries on persistent 500 → `endpoint_error`, exactly
   `max_retries + 1` fetch attempts observed.
5. Fails fast (exactly 1 fetch attempt) on 401.
6. Survives a 200 with malformed JSON body → retried, then success.
7. Survives a 200 with valid JSON but `choices: []` → retried, then success.
8. Per-request timeout: fetchImpl honors a passed `AbortSignal` and rejects
   with `TimeoutError` when its signal fires; adapter retries then
   succeeds; and a permanently-hanging endpoint ends as `endpoint_error`
   (not `timeout`) after retries exhaust.
8b. Job-signal abort during a hung REQUEST (not just backoff): the fetch's
   combined signal fires via the parent; outcome is `cancelled` with ZERO
   retry attempts (assert fetch call count).
8c. `Retry-After` fallback: an unparseable `Retry-After: banana` header
   falls back to exponential backoff (no throw, no 0 ms sleep), then
   succeeds on retry.
9. Job-signal abort during backoff: cancellation resolves promptly (does
   not wait out the sleep), outcome `cancelled`.
10. Existing suite still passes unchanged except: the existing
    "reports endpoint_error when the endpoint returns a failure" test now
    observes 4 fetch attempts (1 + 3 retries) instead of 1 — update that
    assertion deliberately.

## Risks / notes

- **Longer wall-clock worst case:** retries extend a failing job's life
  (default worst case ≈ 3 × (timeout or backoff) per step). The pool's
  wall-clock timer still cancels it — retry is bounded by the job's
  `timeout_seconds`, and backoff/timeout paths abort on the job signal.
- **Z.ai 429 storms:** `Retry-After` honoring plus the per-step retry cap
  keeps us polite; a persistent 429 ends the job as `endpoint_error`
  rather than looping for the job's whole wall clock.
- **Config drift:** defaults are in-code; deployed plists carry no new
  required env. `deploy-macos.sh` needs no change.
