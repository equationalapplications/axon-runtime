# Plan: generic worker system-prompt extension (`extra_system_prompt`)

Repo: axon-runtime. Branch: `feat/extra-system-prompt`. Spec:
`docs/superpowers/specs/2026-10-21-dsh-ct-groundwork.md` (APPROVED —
Tier 2 GLM ×2, Tier 3 Opus findings folded, M1 resolved per Kurt ruling,
Gemini verdict "airtight", Kurt merge clearance 2026-10-22; spec merged
in PR #23 @ `82b1718`).

Gate command (run after EVERY task from repo root, low `-j`):
```
npm run typecheck && npx vitest run --no-file-parallelism
```
Baseline (verified 2026-10-22): 16 files / 158 tests, all green; typecheck
clean.

## Task 1 — Config surface (`src/config/deploy.ts` + `tests/config/deploy.test.ts`)

RED first: tests for `extra_system_prompt` — absent → `undefined`;
accepted when 1..16,384 UTF-8 bytes; rejected on whitespace-only (`"\n"`,
`"  "`), > 16,384 bytes (`'a'.repeat(16_385)` and the CJK boundary
`'字'.repeat(5_462)` = 16,386 bytes; `'字'.repeat(5_461)` = 16,383 passes),
wrong type. GREEN: optional top-level field on the strict `FileSchema`
with `.refine` for trim-nonempty and `Buffer.byteLength(s,'utf8')`;
surface as `DeployConfig.extraSystemPrompt?: string`.

Verify: gate. STOP — controller reviews diff before Task 2.

## Task 2 — Adapter append (`src/harness/adapter.ts` + `tests/harness/adapter.test.ts`)

RED first: exact-equality tests on captured request bodies —
with `extraSystemPrompt: 'X'` the system message content is exactly
`SYSTEM_PROMPT + '\n\n' + X` on the first AND a later request; absent →
exactly `SYSTEM_PROMPT`. GREEN: export `SYSTEM_PROMPT`; constructor takes
`extraSystemPrompt?: string`; `run()` composes
`SYSTEM_PROMPT + (extra ? '\n\n' + extra : '')` once into `messages[0]`.

Verify: gate. STOP.

## Task 3 — Plumb (`src/executor/local.ts` + `tests/executor/local.test.ts`)

`LocalExecutor.run` passes `extraSystemPrompt: this.cfg.extraSystemPrompt`
to the adapter. Test: end-to-end through the executor with a config
carrying the field — the captured body carries the addendum.

Verify: gate. STOP.

## Task 4 — Startup log (`src/worker.ts` + test)

Exported helper `describeExtraSystemPrompt(cfg)` →
`set (<n> bytes)` | `unset`; logged once after `loadDeployConfig`.
Test: helper output contains the byte count and NEVER the wording
(feed it a canary string; assert canary absent).

Verify: gate. STOP.

## Task 5 — Docs + examples + genericity gate test

- README config-area field note (generic wording only).
- `examples/node.json`: optional `extra_system_prompt` with neutral example.
- New test `tests/genericity.test.ts`: greps `src/` for the consumer-naming
  patterns (AC5); also asserts docs carry none of the AC7 private-detail
  patterns (a host name, a private subnet prefix, a private repo path).

Verify: full gate + `npm run build`. PR, review, merge.
