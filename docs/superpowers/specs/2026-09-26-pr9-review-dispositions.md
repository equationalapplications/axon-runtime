# Dispositions — Opus review 068d0a69 (PR #9, range review) vs commit 3c0efa3

All dispositions refer to edits already applied in `3c0efa3`.

## MAJOR

1. **Cancel during response body read / pre-aborted backoff — FIXED.**
   `parse_error` catch now begins with `if (signal.aborted) return
   outcome('cancelled');` (before `maybeRetry`), and `backoffSleep` returns
   immediately when the signal is already aborted. Cancel on the last
   attempt now ends `cancelled`; cancel on an earlier attempt no longer
   waits out the sleep; a request-timeout during body read on a cancelled
   job classifies as `cancelled`, not `parse_error`.
2. **5xx coverage — FIXED.** Hand-listed `RETRYABLE_STATUS` set replaced by
   `(status >= 500 && status <= 599) || status === 408 || 429 || 499`
   (comment cites Cloudflare 520-527/529). 509 and 512-599 now retry.
3. **Abort-listener accumulation — FIXED.** `backoffSleep` removes the
   abort listener on the normal-timer path (`onTimer` calls
   `removeEventListener`); `{ once: true }` kept for the abort path.

## MINOR

1. **Network errors logged as timeouts — FIXED.** Fetch catch now
   classifies `err.name === 'TimeoutError'` → `timeout_request`, else
   `network_error`, and logs the honest class.
2. **Unread response bodies — FIXED.** `await response.body?.cancel()`
   (swallowing errors) added on the retryable-HTTP path and the parse_error
   path before backoff.
3. **Steps on final failure (0 vs 1) — DEFERRED to #10** with reason: the
   spec text says steps count on "success or final failure" but the
   code/spec examples assume success-only counting; the existing
   `step_cap`/telemetry consumers treat steps as assistant-message count.
   Changing the failed-job number now would alter the ledger comparison
   baseline mid-feature; filed as its own issue so the contract question
   gets a real decision rather than a drive-by.
4. **Duplicated defaults — FIXED.** `requestTimeoutMs`/`maxRetries`
   defaults in `adapter.ts` now import `DEFAULT_REQUEST_TIMEOUT_MS` /
   `DEFAULT_MAX_RETRIES` exported from `src/config/deploy.ts` (single
   source; adapter no longer hardcodes 600_000 / 3).
5. **Real-timer timeout tests slow (~14-17s) — DEFERRED to #10** with
   reason: works today (suite ~25s, under the 30s per-test timeout with
   margin after the fake-timer conversion); an injectable base-backoff is
   a test-API design change better made deliberately.
6. **Missing cancel-during-json test — FIXED.** Added: response whose body
   stream never closes, job signal aborted mid-read → `cancelled` promptly
   (covers the MAJOR 1 path).
7. **Cleanups (body! assertions, duplicated log format) — FIXED.** The
   attempt loop now assigns `body` via a typed local and the fail-fast
   path reuses `maybeRetry`'s log format (single format string constant).
