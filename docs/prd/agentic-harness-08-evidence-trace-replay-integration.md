# PRD 08: Evidence, Trace, and Replay Integration

- Status: Ready for implementation
- Priority: P0
- Depends on: PRD 07 and existing PRD 02 primitives
- Blocks: Confirmed-finding automation and release-grade security reporting

## Goal

Wire the existing trace, artifact, redaction, finding-packet, and replay primitives into real suite execution so a failure can be inspected and reproduced.

## Problem

The repository contains `TraceWriter`, `ArtifactStore`, browser instrumentation, HTTP replay, browser replay, and finding packet v2. They are not yet consistently used by existing suites.

Known gaps:

- legacy finding packets still generate `expect(true).toBe(true)`;
- browser instrumentation records limited events and is not broadly attached to suites;
- Playwright trace archives and video are not captured per failed attempt;
- exact request/response capture is incomplete;
- finding packet v2 may include store-wide artifacts rather than a strictly scoped attempt/finding set;
- redaction summaries are not fully populated;
- trace/replay/artifact paths lack direct test coverage;
- guided replay is available but confirmation lifecycle enforcement is incomplete.

## Product Requirements

### Attempt-scoped artifact store

Every suite attempt receives:

```ts
type AttemptEvidenceContext = {
  runId: string;
  suiteId: string;
  attemptId: string;
  traceId: string;
  spanId: string;
  artifactStore: ArtifactStore;
};
```

Artifacts are scoped by attempt and linked to the trace span that created them.

Required artifact metadata:

- ID;
- kind;
- relative path;
- media type;
- byte length;
- SHA-256;
- creation timestamp;
- trace ID;
- span ID;
- redaction status.

### Browser evidence

For browser suites:

- start Playwright tracing before product actions;
- retain trace archives on failure/error and optionally by policy on success;
- capture screenshot on assertion failure;
- capture video when enabled;
- capture console messages, page errors, failed requests, and response status failures;
- persist semantic actions with replay-safe locators;
- close and flush evidence even during timeout or cancellation.

Default retention:

| Outcome | Trace | Screenshot | Video | Console/network |
|---|---:|---:|---:|---:|
| Passed | policy | no | no | summary |
| Failed | yes | yes | yes when enabled | yes |
| Error | yes | best effort | yes when enabled | yes |
| Cancelled | best effort | best effort | optional | yes |

### HTTP evidence

HTTP captures include:

- method and URL;
- sanitized request headers;
- sanitized request body;
- response status;
- sanitized response headers;
- bounded response-body sample;
- elapsed time;
- confirmation attempt count.

Authorization, cookies, tokens, secret-like query parameters, and configured sensitive fields are redacted before persistence.

### Executable replay

Replay modes:

- HTTP: request spec with an assertion tied to the observed defect;
- browser: Playwright actions plus a real assertion;
- guided: explicit `test.fixme`, lifecycle remains `suspected` or `needs-authoring`.

Rules:

- no generated replay may contain `expect(true)`;
- values that originated from secrets are represented by environment/setup references, never embedded;
- locators prefer role, label, test ID, then stable CSS;
- replay specs run from repository root;
- generated specs have a syntax/import validation test;
- a confirmation runner records whether the replay reproduced the defect.

### Finding lifecycle

Allowed lifecycle:

```text
suspected -> needs-authoring -> confirming -> confirmed
suspected/confirming -> rejected
confirmed -> mitigated -> regressed
```

`confirmed` requires:

- at least one confirmation attempt;
- linked trace and artifact evidence;
- successful replay or an approved manual-confirmation record;
- state/effect evidence when external impact is claimed.

### Compatibility migration

- legacy `writeFindingPacket` remains available temporarily;
- callers migrate to `writeFindingPacketV2`;
- legacy replay generation must emit guided `test.fixme`, never a passing placeholder;
- deprecation is documented with a removal milestone.

## Proposed Implementation

Modify:

```text
src/core/runCoordinator.ts
src/core/runTypes.ts
src/suites/registerSuites.ts
src/trace/browserInstrumentation.ts
src/trace/redaction.ts
src/trace/traceTypes.ts
src/artifacts/artifactStore.ts
src/findingPackets.ts
src/replay/replayCompiler.ts
src/replay/httpReplay.ts
```

Add:

```text
src/replay/confirmationRunner.ts
src/trace/evidenceContext.ts
tests/artifactStore.test.ts
tests/traceWriter.test.ts
tests/browserInstrumentation.test.ts
tests/replayCompiler.test.ts
tests/findingPacketsV2.test.ts
tests/fixtures/evidence-app/
```

## Migration Order

1. Correct legacy placeholder replay behavior.
2. Add attempt-scoped evidence context to the coordinator.
3. Add artifact-store and redaction tests.
4. Integrate HTTP evidence into public/security/pentest suites.
5. Integrate browser tracing into one fixture-backed suite.
6. Migrate real browser suites incrementally.
7. Enforce lifecycle confirmation rules.
8. Enable configurable video retention.

## Acceptance Criteria

- No repository code generates a passing placeholder replay.
- Every suite attempt has a trace ID and attempt ID.
- A deterministic fixture failure produces a Playwright trace, screenshot, evidence manifest, and finding packet.
- An HTTP fixture failure produces an executable replay that reproduces the expected status/body defect.
- A browser fixture failure produces an executable replay with a real failing assertion.
- Artifact hashes and redaction flags are persisted.
- Planted secrets do not appear in trace, artifact, report, or replay content.
- Finding packets contain only evidence linked to their attempts.
- A guided replay cannot become `confirmed` automatically.
- Timeout and cancellation still flush best-effort trace/evidence.

## Test Plan

- artifact path traversal and filename collision tests;
- SHA-256 and byte-count tests;
- redaction corpus including headers, URLs, bodies, console text, and tool arguments;
- trace lifecycle and parent/child correlation tests;
- fixture browser failure with trace-opening smoke test;
- HTTP replay execution test;
- browser replay execution test;
- generated-code syntax test;
- test forbidding `expect(true)` in generated replay;
- confirmation lifecycle tests;
- cancellation during evidence capture.

## Out of Scope

- Full browser virtual-machine snapshots
- Automatic fix generation
- Long-term artifact object storage
- Production traffic capture

## Exit Gate

A controlled product defect can be discovered by a real suite, inspected through linked evidence, and reproduced from its generated packet without manual reconstruction.
