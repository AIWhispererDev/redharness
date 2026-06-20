# PRD 09: Fixture App, Datasets, and Grader Completion

- Status: Ready for implementation
- Priority: P1
- Depends on: PRDs 07-08 and existing PRD 03 primitives
- Blocks: Reliable experiments and calibrated release gates

## Goal

Prove the scenario, dataset, grader, and reliability architecture against controlled applications instead of relying primarily on renderer/helper unit tests or a live external target.

## Problem

The current repository has scenario schemas, a browser runner, dataset manifests, deterministic graders, trajectory helpers, and reliability calculations. The integrated proof is thin:

- only one Pocket Socrates dataset scenario exists;
- eval execution does not wire configured graders;
- dataset hashes are not clearly persisted in every eval result;
- no controlled fixture proves state-diff grading;
- no controlled multi-turn fixture proves trajectory grading;
- scenario runs do not yet use the complete trace/evidence pipeline;
- infrastructure errors and failed trials need stronger end-to-end coverage;
- comparisons are not proven across two fixture versions without runner changes.

## Product Requirements

### Controlled fixture applications

Add deterministic local fixtures with no external dependencies.

Minimum fixtures:

1. `fixture-web-v1`: correct public, auth-gate, form, and API behavior;
2. `fixture-web-v2-regression`: intentional route, validation, or response regression;
3. `fixture-agent`: deterministic model/tool loop with inspectable state;
4. `fixture-agent-vulnerable`: controlled policy or state-harm defect.

Fixtures provide:

- stable startup command;
- dynamically assigned or isolated port;
- health endpoint;
- deterministic reset endpoint or direct reset API;
- seeded users/data with fake credentials only;
- observable state snapshot;
- no access to real secrets or external systems.

### Dataset contract

Every eval result persists:

- dataset ID and version;
- computed content hash;
- scenario ID and version;
- split;
- pack version/hash;
- grader IDs and versions;
- application/fixture version;
- trial count and seed where relevant.

The computed hash is authoritative. A declared hash mismatch fails validation.

### Baseline dataset coverage

Create scenarios for:

- public landing success;
- protected-route auth gate;
- client-side validation;
- HTTP status/body behavior;
- authenticated page behavior;
- multi-turn deterministic task;
- alternate valid trajectory;
- state mutation and state-diff verification;
- infrastructure failure;
- cleanup verification.

At least one scenario runs multiple trials.

### Grader registry and configuration

Graders are discoverable and instantiated from scenario/pack configuration.

Required grader types:

- deterministic assertion grader;
- text/rule grader using existing pack rules;
- state-diff grader;
- trajectory/tool-use grader;
- composite grader;
- optional rubric judge through a fake adapter in CI.

The CLI must not require hard-coded grader construction for each dataset.

### State-diff grading

Fixture scenarios capture state before and after execution.

The grader reports:

- allowed changes;
- required changes;
- prohibited changes;
- unexpected changes;
- evidence pointers;
- passed/failed/error status.

### Trajectory grading

Trajectory grading supports:

- exact ordered steps where required;
- required subsequence;
- equivalent valid alternatives;
- prohibited tools/actions;
- maximum tool-call count;
- final outcome independent of exact path.

### Reliability metrics

For repeated trials report:

- successful, failed, error, skipped, and cancelled trial counts;
- success rate;
- `pass@1`;
- `pass^k` for configured `k`;
- mean, median, and p95 latency;
- confidence interval when sample size permits;
- infrastructure error rate separately.

### Scenario evidence

Scenario and grader outputs link to:

- trace IDs;
- action/tool spans;
- before/after state artifacts;
- assertion evidence;
- grader explanations.

## Proposed Implementation

Modify:

```text
src/cli.ts
src/scenarios/runner.ts
src/scenarios/loader.ts
src/scenarios/schema.ts
src/datasets/manifest.ts
src/graders/grader.ts
src/graders/deterministic.ts
src/graders/rules.ts
src/graders/trajectory.ts
src/metrics/reliability.ts
src/experiments/comparison.ts
```

Add:

```text
src/graders/stateDiff.ts
src/graders/composite.ts
src/graders/registry.ts
tests/fixtures/web-app/
tests/fixtures/agent-app/
packs/fixture-web/pack.yaml
packs/fixture-web/datasets/core/
packs/fixture-agent/pack.yaml
packs/fixture-agent/datasets/core/
tests/datasets.test.ts
tests/scenarioRunner.test.ts
tests/graders.test.ts
tests/reliabilityIntegration.test.ts
```

## Acceptance Criteria

- Fixture apps start, report healthy, reset, and stop reliably in tests.
- Dataset validation detects stale or incorrect content hashes.
- Every eval result persists dataset and grader identity/version information.
- Existing text rules execute through the grader interface.
- A fixture scenario is graded using before/after state diff.
- A multi-turn fixture scenario is graded using trajectory rules.
- Equivalent valid trajectories can both pass.
- Repeated trials report reliability metrics without converting infrastructure errors into task failures.
- The same dataset runs against v1 and v2 fixtures without runner-code changes.
- Comparison output identifies the intentional v2 regression.
- Scenario failures include trace and evidence pointers.

## Test Plan

- fixture lifecycle and port-isolation tests;
- valid/invalid scenario schema fixtures;
- content-hash mismatch tests;
- split-reference tests;
- deterministic action execution;
- state reset and cleanup verification;
- state-diff allow/deny tests;
- exact, subsequence, alternative, and prohibited trajectory tests;
- grader registry/configuration tests;
- repeated-trial metric tests;
- v1 versus v2 end-to-end comparison;
- eval CLI exit-code tests.

## Out of Scope

- Real paid model calls in default CI
- Large benchmark datasets
- Production user-data ingestion
- Autonomous scenario generation

## Exit Gate

One versioned dataset runs repeatedly against two controlled application versions, uses deterministic, state, and trajectory graders, and produces a machine-readable regression comparison with linked evidence.
