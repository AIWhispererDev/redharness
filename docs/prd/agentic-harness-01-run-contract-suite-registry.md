# PRD 01: Trustworthy Run Contract and Suite Registry

- Status: Partial
- Depends on: Existing suite modules
- Blocks: PRDs 02-06

## Goal

Create one truthful execution contract for every suite and replace the hand-written `all-smoke` orchestration with a discoverable registry.

This is the first build because every later trace, grader, experiment, finding, and agent feature depends on accurate run state.

## Problem

Today:

- suite result shapes differ;
- skipped authenticated suites often return `ok: true`;
- aggregate summaries only retain a boolean;
- `all-smoke` covers only a subset of implemented commands;
- no distinction exists between product failure, harness error, cancellation, and missing prerequisites;
- retries and repeated stochastic trials would currently be conflated.

## Product Requirements

### Status model

Every suite, scenario, attempt, check, and grader uses:

```ts
type ExecutionStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'error'
  | 'cancelled';
```

Rules:

- `failed`: execution completed and a product assertion failed.
- `error`: the harness could not perform or evaluate the work.
- `skipped`: a declared prerequisite was unavailable or policy excluded the work.
- `cancelled`: user, policy, timeout, budget, or kill switch stopped execution.
- `passed`: required execution and evaluation completed successfully.

`ok: boolean` may remain temporarily as a derived compatibility field, but it is not authoritative.

### Required coverage

Each registered suite declares:

```ts
type RequirementPolicy = 'required' | 'optional' | 'informational';
```

Default release policy:

- required `failed`, `error`, `cancelled`, or `skipped` => run fails;
- optional `failed` or `error` => run fails unless CLI policy overrides;
- optional `skipped` => run can pass with warning;
- informational results never gate the run.

### Suite registry

Each suite registers:

```ts
type SuiteDefinition = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  requirement: RequirementPolicy;
  dependencies?: string[];
  estimatedDuration?: 'short' | 'medium' | 'long';
  requires?: Array<'baseUrl' | 'storageState' | 'nonProStorageState' | 'repo'>;
  run: (context: SuiteContext) => Promise<SuiteResult>;
};
```

Initial registry includes every implemented suite:

- public routes
- public navigation
- early access/TOS
- authenticated dashboard
- Crucible
- Pro regression
- long thread
- completion
- mobile authenticated
- record/export
- billing
- language
- workshop
- changelog-targeted
- chaos
- security smoke
- black-box pentest
- white-box pentest

Pentest and long-running suites may be tagged out of the default smoke profile, but they must be discoverable and explicitly represented.

### Run manifest

Each run writes `run.json`:

```ts
type RunManifest = {
  schemaVersion: '1';
  runId: string;
  packId: string;
  profile?: string;
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  source: 'local' | 'ci' | 'scheduled' | 'mcp';
  git?: {
    commit?: string;
    branch?: string;
    dirty?: boolean;
  };
  environment: {
    nodeVersion: string;
    platform: string;
    ci: boolean;
  };
  selection: {
    suites: string[];
    tags: string[];
    excludedTags: string[];
  };
  policy: RunPolicy;
  suiteResults: SuiteResultSummary[];
};
```

No secrets, cookies, authorization headers, storage-state contents, or raw environment variables are written.

### Suite result

```ts
type SuiteResult = {
  suiteId: string;
  status: ExecutionStatus;
  requirement: RequirementPolicy;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attempts: AttemptSummary[];
  checks: CheckResult[];
  artifacts: ArtifactRef[];
  skipReason?: string;
  error?: SerializedError;
  metrics?: Record<string, number>;
};
```

### Retry and resume

- Infrastructure errors can be retried.
- Product assertion failures are not retried by default.
- Retry policy is configurable by status and error category.
- Completed suites are reusable when a run is resumed with the same run ID and compatible configuration hash.
- A resumed run never silently overwrites prior attempts.

### Selection and profiles

Add:

```text
qa-harness list suites <pack>
qa-harness run <pack> --profile smoke
qa-harness run <pack> --suite auth-smoke --suite pro-regression
qa-harness run <pack> --tag authenticated --exclude-tag destructive
qa-harness run <pack> --workers 3 --retry-errors 2
qa-harness run <pack> --resume <run-id>
```

Profiles live in pack configuration:

```yaml
profiles:
  smoke:
    includeTags: [smoke]
  release:
    includeTags: [smoke, authenticated, ai-quality, security]
    excludeTags: [long, exploratory]
  nightly:
    includeTags: [smoke, authenticated, ai-quality, security, long, exploratory]
```

Legacy commands remain as wrappers during migration.

## Proposed Implementation

Add:

```text
src/core/status.ts
src/core/runTypes.ts
src/core/suiteRegistry.ts
src/core/runCoordinator.ts
src/core/resultPolicy.ts
src/core/resumeStore.ts
src/suites/registerSuites.ts
```

Refactor:

```text
src/cli.ts
src/runSummary.ts
src/runDir.ts
src/types.ts
```

The coordinator owns:

- prerequisite resolution;
- suite selection;
- dependency ordering;
- bounded parallelism;
- retries;
- result normalization;
- aggregate policy;
- durable manifest updates.

## Migration

1. Introduce the new types and normalization adapters.
2. Register existing public and authenticated suites without changing suite internals.
3. Replace `all-smoke` with the coordinator.
4. Register remaining suites.
5. Deprecate direct `ok` aggregation.
6. Move profiles into `pack.yaml`.

## Acceptance Criteria

- `all-smoke` is implemented through the registry and cannot omit a registered smoke-tagged suite accidentally.
- A missing storage-state file produces `skipped`, not `passed`.
- A required skipped authenticated suite makes the release profile fail.
- A harness exception produces `error`, not a product finding.
- JSON and Markdown summaries show status, requirement, attempts, duration, and skip/error reason.
- Resume schedules only incomplete or retryable suites.
- Registry selection is deterministic and covered by tests.
- Legacy commands continue to work.

## Test Plan

- Unit tests for status aggregation and every policy combination.
- Registry tests for duplicate IDs, dependency cycles, missing dependencies, and tag selection.
- Coordinator tests using fake suites for pass/fail/skip/error/cancel/retry.
- Resume tests with an interrupted synthetic run.
- CLI tests for profiles, tags, and explicit suites.
- Fixture-backed integration run proving required auth skip fails the release profile.

## Out of Scope

- Model execution
- LLM graders
- Agent planning
- MCP server
- Production monitoring

## Exit Gate

No later PRD begins implementation until aggregate status is truthful and the complete suite inventory is registry-driven.
