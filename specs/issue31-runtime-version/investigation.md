# Investigation — runtime_version hardcoded (0.1.0)

**Issue:** equationalapplications/axon-runtime#31
**Date:** 2026-10-23
**Repo state:** origin/main `eea4c34` (v1.2.0), worktree `axon-runtime-issue31`, branch `fix/issue31-runtime-version`
**Verification tags:** [V] = controller re-verified; [C] = child-reported.

## Repro

| # | Command | Result | Tag |
|---|---------|--------|-----|
| R1 | `node -e "import('./dist/worker.js').then(m => console.log(m.RUNTIME_VERSION))"` on a FRESH `npm ci && npm run build` of origin/main `eea4c34` | `RUNTIME_VERSION = 0.1.0` | [V] |
| R2 | Same tree: `node -p "require('./package.json').version"` | `1.2.0` | [V] |
| R3 | Live worker: `AXON_EXECUTOR=fake startWorker(config, 18788)` then `curl -H "Authorization: Bearer tok" :18788/nodeinfo` | `{"node_id":"repro-node","contract_version":2,"runtime_version":"0.1.0","active_jobs":0,"max_concurrent_jobs":1}` | [V] |

R3 is the canonical repro: a correctly built, freshly booted node reports `runtime_version: "0.1.0"` while its own `package.json` says `1.2.0`.

## Root cause [V]

`src/worker.ts:14`:

```ts
export const RUNTIME_VERSION = '0.1.0';
```

The constant is a literal that was never touched by the release flow. Data flow:

- `src/worker.ts:48` — `runtimeVersion: RUNTIME_VERSION` into `new JobPool({...})`
- `src/worker.ts:51` — `buildServer({ cfg, pool, artifacts, runtimeVersion: RUNTIME_VERSION })`
- `src/service/server.ts:38` — `/nodeinfo` returns `runtime_version: opts.runtimeVersion`
- `src/service/pool.ts:126` and `:192` — job telemetry records `runtime_version: this.opts.runtimeVersion`, persisted via `src/controller/ledger.ts` (`runtime_version TEXT` column)

So `/nodeinfo` and job telemetry faithfully report whatever the constant holds. The contract schema (`src/contract/schema.ts:62`, `runtime_version: z.string()`) is version-agnostic and needs no change.

### Competing hypothesis tested and ruled out

"Deployed nodes run stale dist builds" — ruled out by R1/R3: a fresh `npm ci && npm run build` from current main still emits `0.1.0`, and the live `/nodeinfo` on that fresh build reports `0.1.0`. The staleness is in the source constant, not in deployment hygiene.

## Proposed fix directions

**A (recommended): read the version from `package.json` at runtime.**

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

(Binding named `requireJson`, not `require`: legal either way under NodeNext ESM, but `require` would collide if this file is ever compiled as CommonJS (TS2441) and reads as a CJS leftover.)

- Works from `dist/worker.js` (published layout: `rootDir: src`, `outDir: dist`, so `../package.json` resolves to the package root) and from `src/` under any transform that preserves `import.meta.url` (vitest does; a tsx dev mode, if ever added, would too). `package.json` is always included in an npm-published package even though `files` lists only `dist/README.md/LICENSE` (GLM Tier-2 verified via `npm pack --dry-run`: tarball contains both `package.json` and `dist/worker.js`).
- Single source of truth: the release flow already bumps `package.json` (`chore(release): 1.2.0`, commit `e36d88f`), so the constant can never go stale again.
- No build-step changes; `tsconfig.json` stays untouched (no `resolveJsonModule` needed — TypeScript never sees the JSON as a module).
- Failure modes that would break the relative resolution (none exist in the repo today — verified: no bundler step, npm pack layout correct, `npmPublish:false` means git installs rebuild dist via `prepare` against the shipped `package.json`):
  1. A deployment that copies only `dist/` without the root `package.json` — runtime throw at module load (fail-fast, matching the stated preference; operators should recognize this signature).
  2. A future bundler step (esbuild --bundle / rollup / webpack) relocating `worker.js` or rewriting `import.meta.url`.
  3. A future change that removes or alters `rootDir` (or `outDir` nesting) so `worker.js` is no longer exactly one level below the package root — note that with `rootDir: "src"` set explicitly, adding a file outside `src/` is a compile error (TS6059), not a silent relocation; the risk is the removal of that pin.
- Trade-off vs Option B, stated explicitly: B's one advantage is a compile-time guarantee that the `version` field exists; in A that guarantee moves to runtime (startup throw) plus the new unit test.

**B (rejected): static JSON import attribute** — `import pkg from '../package.json' with { type: 'json' }`. The decisive reason: with `rootDir: "src"` explicit, importing `../package.json` pulls a file outside `rootDir` — TS6059 unless `rootDir` is changed, and changing it moves output to `dist/src/…`, which breaks the `bin` path `dist/client/cli.js` (`package.json`). Secondary: it needs `resolveJsonModule` and drags the whole `package.json` type surface into the module graph.

**C (rejected): build-time generated version module** — a prebuild script writing a version file can itself go stale (build without the script), adding a second thing to keep in sync — the exact failure mode we are removing. Decisive repo-specific reason: the release job runs `npm run build` (`release.yml:144`) BEFORE semantic-release bumps `package.json` (see the `release.yml` comments: `@semantic-release/npm`'s prepare step runs `npm version --no-git-tag-version` after the build), so a generated version module would be baked with the pre-bump version on EVERY release — guaranteed staleness, not a risk. The same ordering validates Option A: a runtime read is correct regardless of build/bump order.

## Testing plan

- New unit test at `tests/version.test.ts`: `RUNTIME_VERSION` equals the `version` field of `package.json`. **Resolution pin (Fable NIT-1): the test resolves `package.json` relative to the test file** (`new URL('../package.json', import.meta.url)`), never via `process.cwd()` — `tsconfig.json` does not compile `tests/`, the test runs under vitest only, and a cwd-relative read breaks when vitest is invoked from a subdirectory or another worktree. Coverage precisely stated: it exercises the src resolution chain (`src/../package.json`) under vitest and detects staleness. If someone re-hardcodes the constant to the *then-current* version, the test stays green until the next bump — that is the correct semantics (the bug is staleness), but it is not an absolute re-hardcode detector. A lint/grep guard against string-literal assignment to `RUNTIME_VERSION` was considered and deferred as beyond the minimal diff for this issue.
- Post-build dist smoke check (closes the gap the unit test cannot): after `npm run build`, import `dist/worker.js` in a fresh node process and assert `RUNTIME_VERSION` equals the `package.json` version. This is the only check that exercises the published resolution chain (`dist/worker.js -> ../package.json`) — the path that actually carries this bug class for operators. **Placement pin (Fable MINOR-1): NOT a vitest test** — `.github/workflows/ci.yml` runs `npm test` BEFORE `npm run build`, so a test under `tests/**/*.test.ts` either fails on missing `dist/` in CI or silently passes against a developer's stale local `dist/`. It is a step placed after the build (a CI step following the `npm run build` line, or a `postbuild`/`test:dist` npm script); exact mechanism decided at spec stage. **Implementation pin:** run via `node -e` / `node --input-type=module -e` (or a script whose filename does NOT end in `worker.js`) — `worker.ts:57` boots the whole server whenever `process.argv[1]?.endsWith('worker.js')`, so a file-named smoke script matching that suffix would start `startWorker(undefined)` and exit/hang instead of asserting.
- Existing fixtures using `'0.1.0'` literals — **six files**, all stay valid unchanged:
  - `tests/contract/schema.test.ts` (4×), `tests/controller/ledger.test.ts` (1×) — schema/ledger fixtures; the schema accepts any string.
  - `tests/service/server.test.ts:40,42`, `tests/service/pool.test.ts:72`, `tests/client/http.test.ts:40,42`, `tests/integration/tunnel.ssh.test.ts:51,53` — these pass their own injected `runtimeVersion: '0.1.0'` string rather than reading the constant, so they never touch the `worker.ts` wiring and need no change.
- Test-file decision: the new test lives at `tests/version.test.ts` (chosen over extending `tests/worker.test.ts` — `worker.ts` has top-level await behind the argv check; safe under vitest but a needless coupling).
- `/nodeinfo` field assertion gap: `tests/service/server.test.ts` asserts a `toMatchObject` at lines 68-70 (the `it(...)` is at :65) on `node_id`/`contract_version`/`active_jobs`/`max_concurrent_jobs` but NOT `runtime_version` — today no test pins the field's presence in the response. The implementation adds `runtime_version: '0.1.0'` (the injected value) to that assertion so a future refactor cannot silently drop or rewire the field.

## Out of scope / related

- `harness_version: 'unknown'` is a separate hardcoded telemetry field with a different data path: `src/service/pool.ts:127` (error path — always `'unknown'` when `prepare()` fails) and `src/service/pool.ts:193` (completion path — executor-supplied `result?.harnessVersion ?? 'unknown'`). Noted, not addressed here.
- The CLI has no version surface at all (no `--version` flag; `src/client/cli.ts` only surfaces `contract_version`), so operators have no client-side way to ask a node what version it runs; out of scope here.
- Release-note obligation for the PR: tell operators that after upgrading, `/nodeinfo` and job telemetry report the real version, that all pre-fix ledger rows permanently record `0.1.0` (a phantom `0.1.0` cohort will straddle the upgrade boundary; anything grouping/alerting on `runtime_version` should treat old rows as historical), and that REJECTED jobs never carry telemetry at all (`EnvelopeSchema` refine, `schema.ts:84-90` enforces `telemetry === null` for rejected) — so there is no version to look for on rejected rows.
- Change is behavioral for operators (reported version changes `0.1.0` → actual), no API/schema change, no migration.

## Open questions

- None blocking. Fail-fast on a missing `package.json` (throw at startup) is preferred over a silent fallback value, since a wrong version string is precisely the bug being fixed.

## Review trail

### Tier 2 — GLM 5.3 (fresh context), 2026-10-23: APPROVE WITH CHANGES

Full review: `.hermes/cache/scratch/issue31-review/glm-tier2-review.md` (working state, not committed). The reviewer additionally performed live empirical verification of the repro, Option A (clean NodeNext strict build; `dist/worker.js` reports 1.2.0; `npm pack --dry-run` ships `package.json`; createRequire resolves from both dist and src paths; proposed regression test fails on unfixed code and passes with the fix; 28/28 vitest green) — recorded as child-reported [C] pending controller re-verification during implementation.

| Finding | Adjudication | Action |
|---|---|---|
| MAJOR-1: unit test cannot catch dist/publish-layout regressions | REAL | Testing plan rewritten; post-build dist smoke check added |
| MINOR-1: createRequire-breaking packaging modes not enumerated | REAL | Enumerated (dist-without-package.json, future bundler, tsconfig output-depth change) |
| MINOR-2: phantom 0.1.0 ledger cohort across upgrade boundary | REAL | Release-note obligation added to Out of scope |
| MINOR-3: re-hardcode claim overstated | REAL | Claim rescoped to staleness semantics; lint guard deferred (documented) |
| NIT-1: tsx claim describes nonexistent dev mode | REAL | Claim rescoped to transforms that preserve `import.meta.url` |
| NIT-2: CLI has no version surface | REAL | Out-of-scope line added |
| NIT-3: untracked repro artifact at repo root | REAL | Repro script moved out of the repo (scratch); not committed |
| NIT-4: Option B trade-off unstated | REAL | Compile-time-vs-runtime guarantee sentence added |

0 findings rejected as FP. All applied before Opus presentation.

### Tier 3 — Opus (opus-review --doc, effort medium, $0.39), 2026-10-23: APPROVE WITH NITS

No blockers, no majors. Every finding's file:line claim was grep-verified by the controller before application — all TRUE. All m1–m5 and n1–n4 applied; n1 (smoke-check script must not be named `*.worker.js` or it trips the `argv[1]` boot check) is pinned as an implementation constraint for the spec.

| Finding | Adjudication | Action |
|---|---|---|
| m1: `'0.1.0'` literal inventory incomplete (4 more files) | REAL — grep confirmed 6 files | Full inventory + why each stays unchanged |
| m2: `server.test.ts:65` does not assert `runtime_version` | REAL — confirmed | Field added to the test plan's required assertion |
| m3: failure mode 3 mechanism wrong (TS6059, not relocation) | REAL — `rootDir` explicit | Reworded; risk restated as removal of the pin |
| m4: Option B rejection misses the decisive rootDir/bin reason | REAL | TS6059 + `bin` break added as decisive reason |
| m5: `harness_version` cite off by one; second path missed | REAL — confirmed `:127`/`:193` | Both cites corrected with path semantics |
| n1: smoke-check filename can trip the `argv[1]` boot check | REAL — `worker.ts:57` | Implementation pin added |
| n2: `require` binding rename | REAL | `requireJson` in the snippet |
| n3: "dynamic import" wording | REAL | Reworded |
| n4: test file name | REAL | `tests/version.test.ts` pinned |

### Tier 4 — Fable (opus-review --doc --model fable, effort medium, $1.31), 2026-10-23: APPROVE WITH NITS — FINAL TIER, INVESTIGATION CONVERGED

All file:line citations in the document independently re-checked by Fable and confirmed correct, including `.releaserc.json:9`, `release.yml`, `ci.yml`, and the six-file literal inventory. No BLOCKER, no MAJOR. Every finding's claim was controller-verified before application — all TRUE (ci.yml test-before-build order, release.yml build-before-bump order, rejected-envelope telemetry=null refine). All 3 MINOR + 3 NIT applied; the investigation is now the spec backbone.

| Finding | Adjudication | Action |
|---|---|---|
| MINOR-1: smoke check as vitest test would run pre-build in CI / against stale local dist | REAL — ci.yml confirmed | Placement pin: post-build CI step or postbuild/test:dist script, explicitly not a vitest test |
| MINOR-2: release job builds before version bump — guarantees Option C staleness | REAL — release.yml:144 + comments confirmed | Added as decisive repo-specific Option C rejection reason |
| MINOR-3: fail-fast error signature nondescript | REAL | Snippet wraps the read in try/catch, rethrows naming package.json + layout requirement |
| NIT-1: unit test must not resolve package.json via cwd | REAL | Resolution pin: `new URL('../package.json', import.meta.url)` |
| NIT-2: `server.test.ts` cite imprecision (toMatchObject at 68-70) | REAL | Cite corrected |
| NIT-3: rejected jobs carry no telemetry — phantom cohort caveat | REAL — schema.ts:84-90 confirmed | Added to release-note obligation |

Step 0 complete: repro [V], root cause [V], ladder converged (GLM: APPROVE WITH CHANGES → Opus: APPROVE WITH NITS → Fable: APPROVE WITH NITS; 0 open BLOCKER/MAJOR).


