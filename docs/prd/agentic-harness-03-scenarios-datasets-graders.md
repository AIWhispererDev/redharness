# PRD 03: Declarative Scenarios, Versioned Datasets, and Graders

- Status: Partial
- Depends on: PRDs 01-02
- Blocks: PRDs 04-06

## Goal

Move reusable behavior out of suite-specific TypeScript and into versioned scenario datasets that support deterministic checks, trajectory evaluation, rubric scoring, and repeated trials.

## Product Principles

- A scenario describes intent and success criteria; the runner supplies execution mechanics.
- Final output quality and trajectory quality are separate.
- Deterministic state verification is preferred when available.
- Subjective dimensions use explicit rubrics with explanations.
- Stochastic behavior is measured over multiple trials.
- Dataset changes are versioned independently from runner changes.

## Scenario Schema

Scenarios live under:

```text
packs/<pack-id>/datasets/<dataset-id>/
  dataset.yaml
  scenarios/
    <scenario-id>.yaml
  fixtures/
  rubrics/
```

Example:

```yaml
id: solo-persists-after-refresh
version: 1
title: Solo response persists after refresh
tags: [authenticated, ai-quality, persistence]
target:
  kind: browser
  route: /en/dashboard
prerequisites:
  authProfile: pro
setup:
  - action: dismiss_if_visible
    role: button
    name: I understand
actor:
  kind: scripted
steps:
  - action: send_message
    value: "Ask me one precise question about choosing a small project."
  - action: capture
    as: first_response
  - action: reload
expected:
  - assertion: page_contains_capture
    capture: first_response
graders:
  - id: response-present
    type: deterministic
  - id: style-rules
    type: rule-set
    target: ai_response
trials: 2
budgets:
  wallTimeMs: 120000
cleanup:
  strategy: reset-session
```

## Dataset Manifest

```yaml
id: pocket-socrates-core
version: 1.0.0
description: Release-gating core behavior
splits:
  smoke: [public-landing, auth-dashboard]
  release: [solo-persists-after-refresh, no-premature-completion]
  adversarial: []
provenance:
  owner: qa
  createdFrom: manual
```

Requirements:

- content hash identifies the exact dataset version used by a run;
- scenarios have stable IDs;
- metadata includes author/provenance and last review date;
- splits separate smoke, release, exploratory, security, and holdout cases;
- generated scenarios are labeled and cannot enter release gating without review.

## Actor Types

Phase 3 supports:

- `scripted`: fixed inputs and deterministic steps;
- `fixture`: state-driven simulator with predefined branches;
- `human`: pauses for operator input;
- `model-simulated-user`: dynamic user simulator, initially experimental.

The autonomous testing agent is introduced in PRD 04.

## Grader Interface

```ts
type Grade = {
  graderId: string;
  graderVersion: string;
  status: 'passed' | 'failed' | 'error' | 'not-applicable';
  score?: number;
  label?: string;
  explanation: string;
  evidence: EvidencePointer[];
  metadata?: Record<string, JsonValue>;
};
```

### Required grader types

1. Deterministic assertion
   - exact state, status, visible control, database/fixture state, schema, latency threshold.
2. Rule-set grader
   - existing pack text rules and future structured policy rules.
3. State-diff grader
   - compares initial and final controlled environment state.
4. Trajectory grader
   - expected/forbidden tools, ordering constraints, unnecessary steps, policy violations.
5. Rubric grader
   - model-assisted scoring against explicit dimensions.
6. Pairwise grader
   - candidate versus baseline.
7. Human grader
   - structured review queue/export.

### Rubric requirements

Each rubric defines:

- dimension;
- score scale;
- anchors for each score;
- critical-failure conditions;
- evidence the judge may use;
- whether reference output is available;
- judge model/configuration version;
- calibration examples.

High-severity release gates require either:

- a deterministic grader; or
- agreement between a calibrated rubric grader and a second independent signal.

## Trajectory Evaluation

Support:

```yaml
trajectory:
  required:
    - tool: fetch_policy
  forbidden:
    - tool: delete_record
  ordering:
    - before: fetch_policy
      after: issue_refund
  maxToolCalls: 5
  allowEquivalentPaths: true
```

Exact trajectory matching is optional because many tasks have multiple valid paths. Rubric-based trajectory quality should assess efficiency and policy compliance where exact matching would overfit.

## Trials and Reliability

Each scenario can define `trials`.

Report:

- attempted/completed trials;
- success rate;
- `pass@1`;
- `pass^k`: probability/observed rate that all `k` trials succeed;
- median and p95 latency;
- tool-call count distribution;
- token/cost distribution when model-backed;
- Wilson confidence interval for binary success when sample size is sufficient.

Do not call a stochastic scenario stable from a single trial.

## Baseline Scenario Set

Create an initial manually curated dataset of at least 20 scenarios:

- 5 public/auth functional;
- 5 AI response and conversation lifecycle;
- 3 persistence/export;
- 3 mobile/language/accessibility;
- 2 security auth boundary;
- 2 chaos/recovery.

At least five scenarios must verify final application state, not only visible text.

## Proposed Implementation

Add:

```text
src/scenarios/schema.ts
src/scenarios/loader.ts
src/scenarios/runner.ts
src/scenarios/actions.ts
src/datasets/manifest.ts
src/datasets/versioning.ts
src/graders/grader.ts
src/graders/deterministic.ts
src/graders/rules.ts
src/graders/stateDiff.ts
src/graders/trajectory.ts
src/graders/rubric.ts
src/graders/pairwise.ts
src/metrics/reliability.ts
```

## CLI

```text
qa-harness dataset list <pack>
qa-harness scenario validate <pack> <dataset>
qa-harness eval <pack> <dataset> --split smoke
qa-harness eval <pack> <dataset> --scenario <id> --trials 5
qa-harness eval <pack> <dataset> --baseline <run-id>
```

## Acceptance Criteria

- Scenario and dataset files are schema-validated.
- A dataset hash is persisted in every eval run.
- Existing text rules can run as graders without duplication.
- At least one scenario uses a state-diff grader.
- At least one multi-turn scenario uses a trajectory grader.
- Repeated trials produce reliability metrics without merging infrastructure errors into task failures.
- Grader failures include explanations and evidence pointers.
- A changed dataset creates a new version/hash and cannot silently alter historical comparisons.

## Test Plan

- Schema fixtures for valid and invalid scenarios.
- Dataset hashing/version tests.
- Deterministic action runner against a local fixture app.
- Equivalent valid trajectory tests.
- Rubric parser and calibration fixture tests using a fake judge adapter.
- Reliability metric tests including incomplete/error trials.
- End-to-end dataset run producing trace, grades, and summary.

## Out of Scope

- Autonomous planner
- Adversarial prompt generation
- Production online evaluation
- Hosted annotation UI

## Exit Gate

The same dataset must run against two application versions and produce a machine-readable comparison without changing runner code.
