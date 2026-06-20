# PRD 11: CI, Result Store, MCP, and Operational Release

- Status: Ready for implementation
- Priority: P1
- Depends on: PRDs 07-10 and existing PRD 06 primitives
- Final release-hardening phase

## Goal

Make the harness operable as a continuous, queryable platform through CI, scheduled jobs, and MCP without weakening the policies enforced by local CLI execution.

## Problem

The repository contains experiment comparison, gates, JUnit/SARIF/GitHub reporters, OTel export, a service layer, JSONL catalog, and an MCP stdio adapter. Remaining gaps:

- there is no committed CI workflow;
- no retained complete release or nightly evidence run exists;
- the “SQLite catalog” is currently JSONL only;
- catalog rebuild and deduplication semantics are incomplete;
- no scheduled-run example proves deterministic non-interactive operation;
- MCP tests cover basic protocol behavior but not full lifecycle, traversal, authorization, or impersonation threats;
- the service and MCP layers are not proven against complete governed runs;
- documentation still describes implemented pieces as missing;
- no operational retention or failure-handling policy is defined.

## Product Requirements

### Continuous integration

Required jobs:

1. repository integrity;
2. install and typecheck;
3. unit tests;
4. fixture integration tests;
5. CLI/package smoke;
6. reporter schema validation;
7. MCP protocol/security tests.

Optional live jobs:

- Pocket Socrates public smoke;
- authenticated release profile using protected CI secrets;
- nightly long-thread and red-team runs.

Live jobs are clearly separated from deterministic fixture CI.

### CI outputs

Every CI evaluation writes:

- `run.json`;
- Markdown summary;
- machine-readable comparison JSON where applicable;
- JUnit XML;
- SARIF for mapped findings;
- GitHub step summary/annotations when on GitHub Actions.

The process exit code comes from the same regression gate represented in the report.

### Complete release profile evidence

Before release, retain one complete run proving:

- all release-tagged suites were selected;
- required authenticated coverage executed rather than skipped;
- requirement policy and skip/error reasons are visible;
- run contains nonzero suite results;
- manifest includes commit, branch, dirty state, pack version, and configuration hash;
- reports were generated from that exact manifest.

### SQLite catalog

Introduce SQLite as a rebuildable index while immutable run files remain authoritative.

Minimum tables:

- schema migrations;
- runs;
- suite attempts;
- scenarios;
- trials;
- grades;
- metrics;
- findings;
- artifacts;
- baselines;
- approvals.

Requirements:

- idempotent indexing by stable IDs;
- foreign keys and indexes;
- transactional migration;
- rebuild from run directories;
- recovery from a missing/corrupt catalog;
- schema version reporting;
- no secret-bearing artifact contents stored in database columns.

JSONL may remain as an event/import format but is not described as SQLite.

### Baselines and regression gates

- promote a compatible run under a stable name;
- prevent accidental comparison of incompatible dataset/config semantics;
- report per-scenario and aggregate deltas;
- required skipped coverage fails;
- low trial counts produce warnings;
- finding identity distinguishes new, known, mitigated, and regressed.

### Scheduled operation

Provide documented non-interactive commands for:

- fixture release gate;
- public smoke;
- authenticated release;
- nightly dataset evaluation;
- nightly red-team evaluation;
- compare against promoted baseline;
- report generation.

Scheduling may remain external.

Interrupted runs are resumable and retain partial evidence.

### MCP lifecycle

Over stdio, an MCP client can:

- initialize;
- list packs, suites, and datasets;
- validate datasets;
- start an allowed run;
- poll active/completed status;
- cancel an active run;
- compare runs;
- list and retrieve findings;
- read run/finding resources.

### MCP security

- run operations remain disabled by default;
- approved packs, profiles, suites, filesystem roots, and network targets are configurable;
- clients cannot supply storage-state paths or arbitrary output directories;
- artifact/resource paths are resolved under approved roots;
- run IDs and finding IDs cannot traverse paths;
- token passthrough is forbidden;
- session IDs are not treated as authentication;
- request/client metadata is traced;
- remote HTTP transport is deferred until authorization and consent are implemented.

### Observability

OTel export:

- is opt-in;
- uses versioned mapping;
- includes run, suite, scenario, agent, tool, grader, and MCP spans where available;
- never blocks or corrupts local persistence;
- redacts configured sensitive attributes;
- reports exporter failures separately.

### Operational retention

Document configurable retention for:

- successful run summaries;
- failure traces;
- videos;
- finding packets;
- catalog backups.

Deletion must be scoped to configured run roots and must not follow unexpected paths.

## Proposed Implementation

Modify:

```text
package.json
README.md
src/store/catalog.ts
src/store/migrations/
src/experiments/runner.ts
src/experiments/comparison.ts
src/experiments/gates.ts
src/reporters/junit.ts
src/reporters/sarif.ts
src/reporters/github.ts
src/exporters/otel.ts
src/service/harnessService.ts
src/mcp/server.ts
src/cli.ts
```

Add:

```text
.github/workflows/ci.yml
.github/workflows/live-smoke.yml
.github/workflows/nightly.yml
src/store/sqliteCatalog.ts
src/store/migrations/002-sqlite-schema.ts
src/operations/retention.ts
docs/operations/ci.md
docs/operations/mcp.md
docs/operations/nightly.md
tests/sqliteCatalog.test.ts
tests/ciGate.test.ts
tests/mcpLifecycle.test.ts
tests/mcpSecurity.test.ts
tests/retention.test.ts
```

## Acceptance Criteria

- Deterministic CI passes from a clean checkout.
- CI uploads or retains JSON, Markdown, JUnit, and SARIF outputs.
- A complete release profile cannot pass with required skipped coverage.
- A retained release run contains all selected release suites and nonzero results.
- SQLite migrations run transactionally and the catalog rebuilds from run files.
- Re-indexing the same run is idempotent.
- Baseline promotion and compatible comparison work through CLI and service APIs.
- Scheduled commands run without prompts and exit deterministically.
- MCP can complete the allowed start/poll/cancel/retrieve lifecycle.
- MCP rejects traversal, arbitrary roots, secret paths, token passthrough, and unauthorized run operations.
- OTel exporter failure does not alter run status or corrupt evidence.
- Retention only deletes eligible content beneath approved roots.
- README and PRD statuses match the shipped implementation.

## Test Plan

- clean-checkout CI;
- reporter schema and snapshot tests;
- required-skip gate test;
- complete fixture release-profile run;
- SQLite migration, foreign-key, idempotency, and rebuild tests;
- corrupt-catalog recovery;
- baseline compatibility and finding lifecycle comparison;
- interrupted scheduled run and resume;
- MCP stdio lifecycle;
- path traversal and encoded traversal;
- token passthrough and session impersonation;
- concurrent start/cancel/poll;
- OTel timeout/failure;
- retention dry-run and root-containment tests.

## Out of Scope

- Hosted dashboard
- Built-in scheduler daemon
- Multi-tenant remote MCP service
- Automatic production trace ingestion
- Automatic fix-as-PR workflow

## Final Exit Gate

The platform is release-ready when a clean checkout passes deterministic CI, controlled fixtures prove the full evaluation/security lifecycle, a complete release run is retained, SQLite can rebuild the operational index, and MCP invokes the same governed service without bypassing policy or filesystem boundaries.
