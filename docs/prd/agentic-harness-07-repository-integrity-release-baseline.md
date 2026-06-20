# PRD 07: Repository Integrity and Release Baseline

- Status: Ready for implementation
- Priority: P0
- Depends on: Current working tree
- Blocks: PRDs 08-11

## Goal

Make the current implementation reproducible from Git and establish a trustworthy build, test, packaging, and documentation baseline.

## Problem

The local workspace passes TypeScript and unit tests, but the same result is not guaranteed from a fresh clone.

Known issues:

- `src/artifacts/artifactStore.ts` is excluded by the broad `artifacts/` ignore rule;
- 73 implementation files are currently untracked and 9 tracked files are modified;
- package metadata still describes an unbuilt starter package;
- no CI workflow proves install, typecheck, and tests on a clean checkout;
- the README reports 23 test files and 44 tests while the current baseline is 31 files and 118 tests;
- the new PRDs remain marked `Proposed` despite partial implementation;
- historical manifests include passing runs with zero suite results.

## Product Requirements

### Git-safe source layout

Ignore generated root artifacts without ignoring source code:

```gitignore
/artifacts/
/runs/
/drafts/
/reports/
```

Rules:

- generated-directory patterns are rooted where possible;
- `src/artifacts/**` is explicitly included or renamed to an unambiguous source directory;
- a verification test or CI command fails if an imported source file is ignored or absent from Git;
- authentication state and generated evidence remain ignored.

### Clean-clone verification

The following sequence must succeed from a fresh checkout:

```text
npm ci
npm run typecheck
npm test
npm run build
npm run qa -- list
```

No step may rely on:

- an untracked source file;
- a pre-existing `node_modules`;
- local authentication state;
- generated run artifacts;
- a globally installed TypeScript or test runner.

### Package contract

Update `package.json` with:

- non-empty description;
- supported Node engine range;
- `typecheck`, `build`, `qa`, and focused verification scripts;
- valid CLI/bin contract;
- valid `main`, `types`, or `exports` fields if the package is importable;
- published file allowlist if publishing is intended;
- repository metadata when known.

Decide and document one distribution mode:

1. source-executed private CLI; or
2. compiled distributable CLI/package.

The package must not claim a nonexistent `index.js`.

### Build output

If compiled distribution is selected:

- compile source separately from tests;
- place distributable files under `dist/`;
- preserve executable CLI entry behavior;
- verify Node ESM resolution;
- run a built CLI smoke test.

If source-executed distribution is selected:

- remove misleading build entrypoints;
- document `tsx` as an intentional runtime dependency;
- keep CI typecheck and CLI smoke coverage.

### Empty-run policy

A run with zero selected or completed suites must not be `passed`.

Required behavior:

- explicit empty selection is rejected before run creation; or
- the run ends as `error` with a clear reason;
- resume with no pending work may preserve the prior completed result, but must be marked as a no-op resume rather than a new passing evaluation.

### Documentation baseline

Update:

- README test counts and commands;
- architecture tree;
- implemented versus partial capabilities;
- setup requirements;
- known limitations;
- PRD statuses.

## Proposed Implementation

Modify:

```text
.gitignore
package.json
tsconfig.json
README.md
docs/prd/agentic-harness-01-*.md
docs/prd/agentic-harness-02-*.md
docs/prd/agentic-harness-03-*.md
docs/prd/agentic-harness-04-*.md
docs/prd/agentic-harness-05-*.md
docs/prd/agentic-harness-06-*.md
src/core/runCoordinator.ts
src/core/suiteRegistry.ts
```

Add as appropriate:

```text
tsconfig.build.json
.github/workflows/ci.yml
tests/repositoryIntegrity.test.ts
tests/cliSmoke.test.ts
```

## Acceptance Criteria

- Every imported local source module is tracked and available in a clean clone.
- `src/artifacts/artifactStore.ts` is no longer hidden by ignore rules.
- `npm ci`, typecheck, tests, build/distribution verification, and CLI smoke pass in CI.
- A zero-suite run cannot report `passed`.
- README test counts are generated or updated to the verified baseline.
- Package entrypoints describe files that actually exist.
- CI does not require auth or live Pocket Socrates access for its core checks.
- The existing 118-test baseline remains green or is intentionally increased.
- All local implementation files required for PRDs 01-06 are committed together in reviewable units.

## Test Plan

- `git check-ignore` regression for source directories;
- imported-module inventory check against `git ls-files`;
- clean-install CI job;
- TypeScript no-emit validation;
- full Vitest run;
- built or source CLI `list` invocation;
- zero-selection and completed-resume behavior tests;
- package-entrypoint smoke test.

## Out of Scope

- Live authenticated release execution
- Replay integration
- New datasets
- Real model-provider integration
- Remote MCP transport

## Exit Gate

A new machine can clone the repository and reproduce the verified build and test baseline without copying any local-only files.
