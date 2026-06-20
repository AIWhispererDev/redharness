# Agentic Harness Remaining Implementation Plan

- Status: Ready for implementation
- Created from: Repository audit on June 20, 2026
- Scope: Work required to turn the current local prototype into a reproducible, integrated, release-ready agentic QA platform
- Related roadmap: `agentic-harness-2026-research-roadmap.md`

## Current Baseline

The repository already contains substantial implementations for PRDs 01-06:

- truthful execution statuses and a suite registry;
- run coordination, retries, cancellation, resume, and trace spans;
- scenario and dataset schemas;
- deterministic graders and reliability helpers;
- bounded agent runtime primitives;
- OWASP-aligned red-team definitions;
- experiments, reports, OTel export, service APIs, and MCP protocol handling.

The local baseline passes:

```text
TypeScript: 116 files, 0 errors
Vitest: 31 files, 118 tests passed
Registered suites: 18
```

Passing local tests is not yet sufficient evidence of release readiness. Several required source files are not safely represented in Git, the new subsystems are only partially integrated, and no complete release-profile run proves the architecture end to end.

## Delivery Order

| Order | Spec | Outcome | Blocks |
|---|---|---|---|
| 0 | [Repository Integrity and Release Baseline](agentic-harness-07-repository-integrity-release-baseline.md) | A fresh clone installs, builds, tests, and contains every required source file | All later work |
| 1 | [Evidence, Trace, and Replay Integration](agentic-harness-08-evidence-trace-replay-integration.md) | Real suites emit scoped evidence and executable replay without placeholder assertions | Confirmed findings |
| 2 | [Fixture App, Datasets, and Grader Completion](agentic-harness-09-fixtures-datasets-graders.md) | Core behavior is tested against controlled fixtures and versioned datasets | Reliable comparisons |
| 3 | [Agent Runtime and Red-Team End-to-End Execution](agentic-harness-10-agent-redteam-e2e.md) | Policy-controlled agents and adversarial scenarios execute safely against fixtures | Autonomous/security release use |
| 4 | [CI, Result Store, MCP, and Operational Release](agentic-harness-11-ci-store-mcp-operations.md) | CI and external clients can run and inspect the same governed system | Platform release |

Implementation follows this order. Later specs may be developed in parallel only when their acceptance tests do not depend on an incomplete earlier gate.

## Definition of Done

The remaining program is complete when:

- a clean clone reproduces the verified build and tests;
- no required source file is hidden by ignore rules;
- all required release suites execute or truthfully fail as skipped/error;
- a controlled product failure produces a trace, scoped evidence, and executable replay;
- a versioned dataset runs repeatedly against a controlled fixture and produces reliability metrics;
- deterministic and trajectory/state graders are exercised in real scenario runs;
- agent actions are policy-mediated, cancellable, budgeted, and checkpointable;
- red-team results distinguish semantic failure, audit evidence, and state harm;
- SQLite provides a rebuildable query index over immutable run files;
- CI emits JSON, Markdown, JUnit, and SARIF outputs;
- MCP clients can safely list, start, poll, cancel, compare, and inspect runs;
- documentation accurately describes implemented and deferred capabilities;
- a complete release-profile run is retained as release evidence.

## Global Engineering Rules

### Truthful execution

- Empty suite selections cannot produce a passing run.
- Required skipped coverage fails the release gate.
- Infrastructure errors remain distinct from product failures.
- Generated summaries and exit codes derive from the same policy evaluation.

### Evidence integrity

- Secrets are redacted before persistence.
- Artifacts have stable IDs, hashes, media types, and trace correlation.
- Findings include only relevant evidence rather than entire suite directories.
- `confirmed` requires a successful confirmation attempt and impact evidence.

### Reproducibility

- Generated replay commands run from the repository root.
- Fixtures have deterministic setup and cleanup.
- Dataset, grader, policy, pack, and application versions are persisted.
- Every release check runs non-interactively.

### Safety

- Default agent and MCP operations are read-only.
- High-impact actions require explicit policy and approval.
- Network targets and filesystem roots are allowlisted.
- Cancellation and timeout paths are tested, not merely declared.

## Required Documentation Updates

As each spec exits:

1. Change the corresponding original PRD status from `Proposed` to `Implemented`, `Partial`, or `Deferred`.
2. Update the README feature and test-count sections.
3. Record any intentional deviations from the original PRD.
4. Add the verification command and retained evidence path.
5. Remove completed items from the README's missing-work list.

## Program Exit Gate

No platform-release claim is made until every spec in this plan has passed its exit gate and the release evidence run can be reproduced from a fresh clone.
