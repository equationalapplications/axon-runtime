# Spec — runtime_version tracks the deployed package version

**Date:** 2026-10-23
**Status:** Draft
**Branch:** `fix/issue31-runtime-version`
**Issue:** equationalapplications/axon-runtime#31
**Backbone:** [investigation.md](./investigation.md) (Step 0 converged: GLM → Opus → Fable, 0 open BLOCKER/MAJOR)

## Problem

`src/worker.ts:14` hardcodes the reported runtime version:

```ts
export const RUNTIME_VERSION = '0.1.0';
```

The constant is never updated when the package version bumps: the package is at 1.2.0 while every deployment reports `runtime_version: "0.1.0"` in `/nodeinfo` and job telemetry. An operator verifying an upgrade cannot tell from `/nodeinfo` whether the deployed build is the new release (this caused real confusion during a recent upgrade verification).

## Root cause (verified)

Controller-verified on origin/main `eea4c34`:

| # | Check | Result |
|---|-------|--------|
| R1 | Fresh `npm ci && npm run build` of main, then `import('./dist/worker.js')` | `RUNTIME_VERSION = 0.1.0` |
| R2 | Same tree `package.json` | `1.2.0` |
| R3 | Live worker (`AXON_EXECUTOR=fake`), `GET /nodeinfo` with bearer token | `runtime_version: "0.1.0"` |

Data flow: `worker.ts:14` → `worker.ts:48` (`JobPool` telemetry) and `worker.ts:51` (`buildServer`) → `server.ts:38` (`/nodeinfo`) and `pool.ts:126,192` (job telemetry) → `ledger.ts` (`runtime_version TEXT` column). The schema (`schema.ts:62`, `runtime_version: z.string()`) is version-agnostic — no contract change.

Stale-deployment hypothesis ruled out: a fresh build of current main still emits `0.1.0` (R1/R3).

## Proposed change

Replace the hardcoded literal with a runtime read of `package.json` (Option A of the investigation; B and C rejected there — B fails on `rootDir`/`bin` grounds, C is guaranteed stale because the release job builds before semantic-release bumps the version):

```ts
import { createRequire } from 'node:module';

const requireJson = createRequire(import.meta.url);

export const RUNTIME_VERSION: string = (() => {
  try {
    return (requireJson('../package.json') as { version: string }).version;
  } catch (err) {
    // Fail-fast with a signature that names the actual requirement — the raw
    // createRequire failure is a nondescript `Cannot find module '../package.json'`
    // (MODULE_NOT_FOUND) that an operator cannot connect to deployment layout.
    throw new Error(
      'axon-runtime: cannot determine runtime version — package.json must sit exactly ' +
        'one directory above the compiled worker.js (dist-only deployments must ship package.json)',
      { cause: err },
    );
  }
})();
```

Why this is correct: `tsconfig.json` pins `rootDir: src` / `outDir: dist`, so `dist/worker.js` resolves `../package.json` to the package root (the published layout; `npm pack` always ships `package.json`); under vitest, `src/worker.ts` resolves to the repo root. The release flow already bumps `package.json`, making it the single source of truth.

## Files touched

| File | Change |
|---|---|
| `src/worker.ts` | Replace the literal at line 14 with the `createRequire` read above (same export name, same type `string`) |
| `tests/version.test.ts` | NEW — regression test (below) |
| `tests/service/server.test.ts` | Add `runtime_version: '0.1.0'` (the injected value) to the `/nodeinfo` `toMatchObject` at lines 68-70 — today no test pins that field's presence |
| `package.json` | Add `"test:dist"` script (smoke check below) |
| `.github/workflows/ci.yml` | Add a step running `npm run test:dist` immediately AFTER the existing `npm run build` step |

No other files change. The `'0.1.0'` literals in `tests/contract/schema.test.ts`, `tests/controller/ledger.test.ts`, `tests/service/pool.test.ts`, `tests/client/http.test.ts`, and `tests/integration/tunnel.ssh.test.ts` are schema/ledger fixtures or self-injected values that never read the constant — they stay unchanged.

## Test plan

1. **Unit regression test** (`tests/version.test.ts`): assert `RUNTIME_VERSION` equals the `version` field read via `new URL('../package.json', import.meta.url)` — never via `process.cwd()`. Catches re-hardcoding (staleness semantics: a re-hardcode equal to the then-current version passes until the next bump — correct, the bug is staleness) and any break of the src resolution chain.
2. **Dist smoke check** (`test:dist` npm script, run by CI after `build` — NOT a vitest test, because ci.yml runs `npm test` before `npm run build`): a fresh `node --input-type=module -e` process imports `dist/worker.js` and asserts `RUNTIME_VERSION === process.env.npm_package_version`. Implementation pin: the script filename must not end in `worker.js` and must not be `node <file>.js` named `*worker.js` — `worker.ts:57` boots the whole server whenever `process.argv[1]?.endsWith('worker.js')`.
3. **`/nodeinfo` field pin** (see Files touched): protects the field from being dropped or rewired by future refactors.
4. Full local gates before pushing: `npm run typecheck && npm test && npm run build && npm run test:dist`, all exit 0, output read (not assumed).

## Out of scope

- `harness_version: 'unknown'` (`pool.ts:127` error path, `pool.ts:193` completion fallback) — separate field, different data path.
- CLI version surface (no `--version`; client shows only `contract_version`).
- Any contract/schema/migration change — none needed.

## Release-note obligation (PR body)

Operators must be told: after upgrading, `/nodeinfo` and job telemetry report the real version; all pre-fix ledger rows permanently record `0.1.0` (a phantom `0.1.0` cohort straddles the upgrade boundary — treat old rows as historical in grouping/alerting); rejected jobs carry no telemetry at all (`schema.ts:84-90`), so there is no version to look for on rejected rows.

## Risks

- Operator-visible behavior change (reported version `0.1.0` → actual). Intended; covered by the release note.
- A dist-only deployment missing `package.json` now fails at startup with an explicit error instead of reporting a wrong version silently. Intended fail-fast; error message names the requirement.
