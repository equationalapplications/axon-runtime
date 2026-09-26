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
