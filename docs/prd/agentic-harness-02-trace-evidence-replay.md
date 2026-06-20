# PRD 02: Unified Trace, Evidence, and Executable Replay

- Status: Partial
- Depends on: PRD 01
- Blocks: PRDs 03-06

## Goal

Make every run inspectable and every confirmed finding reproducible.

The harness must capture one correlated history across browser actions, HTTP traffic, model turns, tool calls, assertions, graders, retries, and artifacts.

## Problem

Current evidence is fragmented across screenshots and suite-specific JSON files. Finding packets point at broad artifact lists, while generated Playwright replay files contain placeholder assertions.

This prevents:

- exact failure diagnosis;
- reliable replay;
- trajectory grading;
- model/tool observability;
- evidence-level security conclusions;
- comparison across attempts.

## Trace Model

Use an internal span/event schema inspired by OpenTelemetry GenAI and MCP conventions while retaining a stable harness-owned storage format.

```ts
type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attemptId: string;
  name: string;
  kind:
    | 'run'
    | 'suite'
    | 'scenario'
    | 'browser.action'
    | 'http.request'
    | 'model.generate'
    | 'agent.invoke'
    | 'agent.plan'
    | 'tool.execute'
    | 'grader.score'
    | 'artifact.write'
    | 'policy.check';
  startedAt: string;
  endedAt?: string;
  status: 'ok' | 'error' | 'cancelled';
  attributes: Record<string, JsonValue>;
  events: TraceEvent[];
};
```

Required correlation:

```text
runId -> suiteId -> scenarioId -> trialId -> attemptId -> traceId/spanId
```

### Redaction

Redact before persistence:

- cookies;
- authorization headers;
- API keys and tokens;
- storage-state contents;
- invite codes;
- known user PII fields;
- configured pack-specific patterns.

Store redaction metadata such as field path and redaction rule ID, never the original value.

## Browser Evidence

For every browser attempt:

- Playwright `trace.zip`;
- screenshot on failure and configured checkpoints;
- console events;
- failed requests;
- HTTP 4xx/5xx responses;
- optional HAR;
- optional video for confirmed finding replays;
- semantic action log.

Playwright tracing is enabled from shared browser infrastructure, not repeated independently by every suite.

Default policy:

- smoke run: trace retained on failure;
- security/nightly run: trace retained for all failed and sampled passed scenarios;
- confirmed finding: trace and video retained;
- CI artifacts have configurable retention.

## Semantic Action Log

Raw Playwright traces are excellent for debugging but are not a stable replay script. Record a parallel action log:

```ts
type RecordedAction =
  | { type: 'goto'; url: string }
  | { type: 'click'; locator: LocatorRecipe }
  | { type: 'fill'; locator: LocatorRecipe; valueRef: string }
  | { type: 'press'; key: string }
  | { type: 'request'; requestRef: string }
  | { type: 'waitFor'; condition: WaitRecipe }
  | { type: 'assert'; assertion: AssertionRecipe };
```

`LocatorRecipe` preference:

1. role plus accessible name;
2. label;
3. test ID;
4. stable text;
5. CSS only as a last resort.

Sensitive values use named secret/value references and are not embedded in replay files.

## Replay Modes

### HTTP replay

Used for route/API findings:

- exact method, URL, sanitized headers, and body template;
- expected status/body/security condition;
- curl and Playwright request forms;
- explicit assertion that reproduces the finding.

### Browser replay

Used for UI/workflow findings:

- executable `@playwright/test` spec;
- reconstructed semantic actions;
- prerequisite declaration;
- expected and actual assertion;
- linked trace/artifact IDs.

### Guided replay

Used when actions cannot be deterministically reconstructed:

- generated spec contains valid setup and evidence links;
- unresolved steps are explicit `test.fixme` items;
- packet status remains `needs-replay-authoring`;
- it cannot be called confirmed solely from the scaffold.

## Finding Packet v2

```text
findings/<finding-id>/
  finding.md
  finding.json
  evidence-manifest.json
  replay.spec.ts
  exact-request.http       # when applicable
  replay.curl.sh           # when applicable
  trace.zip
  video.webm               # policy-controlled
  screenshots/
```

`finding.json` includes:

- stable finding ID;
- lifecycle state;
- originating scenario and check;
- initial and confirmation attempt IDs;
- reproduction count;
- affected environment/version;
- evidence references by artifact ID;
- redaction summary;
- replay command;
- expected and observed state.

## Evidence Manifest

Each artifact has:

```ts
type ArtifactRef = {
  id: string;
  kind: string;
  relativePath: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  traceId?: string;
  spanId?: string;
  redacted: boolean;
};
```

Hashes provide integrity and make duplicate evidence detectable. They are not a claim of legal chain of custody.

## Proposed Implementation

Add:

```text
src/trace/traceTypes.ts
src/trace/traceWriter.ts
src/trace/redaction.ts
src/trace/browserInstrumentation.ts
src/trace/httpInstrumentation.ts
src/artifacts/artifactStore.ts
src/replay/actionRecorder.ts
src/replay/replayCompiler.ts
src/replay/httpReplay.ts
src/replay/browserReplay.ts
```

Refactor:

```text
src/findingPackets.ts
src/authSmoke.ts
src/proRegressionSmoke.ts
src/longThreadSmoke.ts
src/securitySmoke.ts
src/pentest.ts
```

Add `@playwright/test` as a development dependency and a minimal Playwright configuration for generated replay specs.

## Acceptance Criteria

- Every suite attempt has a trace ID.
- A browser failure produces a Playwright trace that opens successfully.
- A confirmed HTTP finding produces an executable replay with a real failing/passing assertion.
- A confirmed browser finding produces an executable replay or remains explicitly unconfirmed/needs-authoring.
- Finding packets contain only the evidence for their own attempts, not the suite's entire artifact directory.
- Artifact hashes and redaction flags are present.
- Secrets planted in test fixtures do not appear in persisted traces or reports.
- Replay commands run from the repository root.

## Test Plan

- Redaction corpus tests.
- Trace parent/child and lifecycle tests.
- Artifact hashing and manifest tests.
- Fixture web app that produces a deterministic auth-gate failure.
- Generated HTTP replay test.
- Generated browser replay test using role-based locators.
- Failure test proving placeholder `expect(true)` replay cannot be emitted.

## Out of Scope

- Full browser environment snapshotting
- Process-level sandbox rollback
- Long-term external trace backend
- Automatic replay repair by an LLM

## Exit Gate

A finding cannot advance to `confirmed` unless its claimed impact is supported by linked evidence and a successful confirmation attempt.
