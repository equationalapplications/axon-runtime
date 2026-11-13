## [1.4.0](https://github.com/equationalapplications/axon-runtime/compare/v1.3.2...v1.4.0) (2026-11-13)

### Features

* **cli:** add dispatch --guidance-file with client-side pre-flight validation ([0eed3d0](https://github.com/equationalapplications/axon-runtime/commit/0eed3d0dc2f7127e15c9df660a6670d6bfd57969))
* **client:** typed ContractMismatchError on terminal-envelope parse failure ([d4d2cdb](https://github.com/equationalapplications/axon-runtime/commit/d4d2cdbf6fc1d27576189c617d07ca88340ab343))
* **config:** add max_guidance_bytes (default 3072) to deploy config ([db9b8cc](https://github.com/equationalapplications/axon-runtime/commit/db9b8cc7fc760d3ba654f9b8f19d7926358fb4eb))
* **contract:** pin contract version 3 with optional guidance items ([9fe7249](https://github.com/equationalapplications/axon-runtime/commit/9fe72498d0b10ffe4e49fe1e9fe7e99a24e068bd))
* **harness:** render guidance verbatim between goal and context in user prompt ([f403137](https://github.com/equationalapplications/axon-runtime/commit/f403137301fbf2545fb670d729d9a382da454caa))
* **service:** enforce guidance rules and byte cap in validateJob ([5b76c2a](https://github.com/equationalapplications/axon-runtime/commit/5b76c2af331c74b4474a021f36db54a4f33674fc))

### Bug Fixes

* **age-gate:** fail closed — resolved/integrity deltas, null/unparsable registry data ([b9da065](https://github.com/equationalapplications/axon-runtime/commit/b9da065385997804702db33f9c4f7703006ac507))
* empty guidance file sends absent key (never []); drop timing-sensitive poll-count assertions ([3f7bd08](https://github.com/equationalapplications/axon-runtime/commit/3f7bd08026ca49b1f41b8c020fe5de9387248a1e))
* guidance content-rule violations reject malformed_payload, cap stays limit_exceeded ([d2803bf](https://github.com/equationalapplications/axon-runtime/commit/d2803bfb8c40ecdce34c1d641d2b8601a1a6a898))
* haiku-high rung minors — README rollout wording, Zod cause chain, tested job builder, CR boundary ([8a2d065](https://github.com/equationalapplications/axon-runtime/commit/8a2d065d997f06b20b7ac1878d037f57ca8c7edb))
* non-2xx JSON bodies retry instead of aborting wait() as contract mismatch; pre-flight caps items at 16 ([53a546c](https://github.com/equationalapplications/axon-runtime/commit/53a546c1d76ec8d341f7f8ee81113a66163ea2f7))

## [1.3.2](https://github.com/equationalapplications/axon-runtime/compare/v1.3.1...v1.3.2) (2026-11-01)

### Bug Fixes

* **release:** pin conventional-changelog-conventionalcommits ^9.3.1 + dependabot ignore >=10 ([42e8da2](https://github.com/equationalapplications/axon-runtime/commit/42e8da24b9b5c6764cbc3cccb1330ad8bde7a673)), closes [#29](https://github.com/equationalapplications/axon-runtime/issues/29)
* **worker:** cut 1.3.2 for the vendored-dist version guard ([565c9b7](https://github.com/equationalapplications/axon-runtime/commit/565c9b7310a197cecdad80c53599979d60cef7e5)), closes [#31](https://github.com/equationalapplications/axon-runtime/issues/31) [#42](https://github.com/equationalapplications/axon-runtime/issues/42)

## [1.3.1](https://github.com/equationalapplications/axon-runtime/compare/v1.3.0...v1.3.1) (2026-10-26)

### Bug Fixes

* **worker:** derive RUNTIME_VERSION from package.json (issue [#31](https://github.com/equationalapplications/axon-runtime/issues/31)) ([0f0f0ce](https://github.com/equationalapplications/axon-runtime/commit/0f0f0ce211ad12c739cd075bd48d3bb334e042e0))

## [1.3.0](https://github.com/equationalapplications/axon-runtime/compare/v1.2.0...v1.3.0) (2026-10-23)

### Features

* **config:** trailing /* wildcard entries in repo_allowlist ([93c4661](https://github.com/equationalapplications/axon-runtime/commit/93c466114486ec8de6d0bb9b81a30c2a70fae3f4))

## [1.2.0](https://github.com/equationalapplications/axon-runtime/compare/v1.1.0...v1.2.0) (2026-10-23)

### Features

* **harness:** operator-owned extra_system_prompt — generic worker system-prompt extension ([c29c251](https://github.com/equationalapplications/axon-runtime/commit/c29c2510342445cb80ce948eb497e05cadae620e))

## [1.1.0](https://github.com/equationalapplications/axon-runtime/compare/v1.0.0...v1.1.0) (2026-09-26)

### Features

* **harness:** per-request timeout + retry loop for LLM calls ([#8](https://github.com/equationalapplications/axon-runtime/issues/8)) ([bc66fd7](https://github.com/equationalapplications/axon-runtime/commit/bc66fd70989978ae061733498d8c53d24a04af13))

### Bug Fixes

* **executor:** serialize per-mirror worktree creates — shared git config lock race ([bb993d0](https://github.com/equationalapplications/axon-runtime/commit/bb993d0a2fdcfc9b296bf46275c58902ba717807))
* **harness:** complete review fixes — shared defaults/status fn, body-read cancel race, log format reuse ([144d855](https://github.com/equationalapplications/axon-runtime/commit/144d8550123463f6406b881376573d9c9d84fa08))
* **harness:** cycle-2 review — shape-guard all bad 200s, honest body-read classes, single-source defaults ([de74b9c](https://github.com/equationalapplications/axon-runtime/commit/de74b9c11ee770404bfa41f85e3ff3104efc0dad))
* **harness:** cycle-3 review (approve-with-minors) — layering, honest body-cleanup, test hygiene ([deee5ad](https://github.com/equationalapplications/axon-runtime/commit/deee5ad6158a6c3e2c5d0c6635f2eb8e02d9b57c))
* **harness:** final review round — release unread bodies on the retry path, dedupe persistent-500 test ([0e87a9b](https://github.com/equationalapplications/axon-runtime/commit/0e87a9b1a8598730b4cdd082d09de009247d6f34))
* **harness:** PR review threads — AbortError body-read class, final-attempt cancel test, spec math corrections ([421e215](https://github.com/equationalapplications/axon-runtime/commit/421e215bb60536c20b1de78f38b008ca19225c0d))
* **harness:** review fixes — cancel-during-body-read, full 5xx range, listener leak, socket release ([3c0efa3](https://github.com/equationalapplications/axon-runtime/commit/3c0efa3b9590f30efe43884638067caf5227ba7b))

## 1.0.0 (2026-09-24)

### Features

* publishable packaging — files allowlist, prepare build, drop private ([7b1eb98](https://github.com/equationalapplications/axon-runtime/commit/7b1eb98a254885d4e0fad04c3bf7c162578021c3))
* semantic-release config ported from expo-llm-wiki two-phase pattern ([ea557e1](https://github.com/equationalapplications/axon-runtime/commit/ea557e1715ff2f3e7f618c214b3d60ab99879cec))
* two-phase release workflow ported from expo-llm-wiki (OIDC, Node 24) ([3b03192](https://github.com/equationalapplications/axon-runtime/commit/3b031926c1fc193e8063cec1fab725b321bc83a4))

### Bug Fixes

* **package:** normalize bin path so npm publish keeps the axon bin ([b083159](https://github.com/equationalapplications/axon-runtime/commit/b083159171bd9bab0028e21ab472eeefafc3096c))
* **release:** pin conventionalcommits preset to v9 ([7096fda](https://github.com/equationalapplications/axon-runtime/commit/7096fdab38061df6f8501a926e0e4945e4653211))
* **release:** refresh stale release PRs, real PAT pushes, lag fallback ([6dcafba](https://github.com/equationalapplications/axon-runtime/commit/6dcafba0e105ce158ace89f5366b606962705761)), closes [#N](https://github.com/equationalapplications/axon-runtime/issues/N) [#136](https://github.com/equationalapplications/axon-runtime/issues/136)
