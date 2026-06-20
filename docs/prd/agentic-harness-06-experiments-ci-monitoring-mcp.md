# PRD 06: Experiments, CI Gates, Monitoring, and MCP Interoperability

- Status: Partial
- Depends on: PRDs 01-05
- Final platform integration phase

## Goal

Turn individual runs into a continuous improvement system and expose the same governed capabilities to CI, scheduled jobs, and external agents.

## Experiment Model

An experiment evaluates one or more candidate configurations against a versioned dataset.

```ts
type Experiment = {
  experimentId: string;
  datasetId: string;
  datasetVersion: string;
  baseline?: CandidateConfig;
  candidates: CandidateConfig[];
  trials: number;
  metrics: string[];
  gate: RegressionGate;
};
```

Candidate dimensions may include:

- application commit/deployment;
- prompt version;
- agent version;
- model/provider configuration;
- tool set/version;
- policy version;
- pack version.

## Comparison

Report:

- absolute metrics;
- candidate-baseline deltas;
- per-scenario regressions and improvements;
- status transitions;
- reliability changes;
- latency/tool/token/cost changes;
- new, known, mitigated, and regressed findings;
- dataset and grader versions.

Pairwise comparison never compares runs with incompatible dataset semantics unless explicitly forced and marked.

## Regression Gates

Example:

```yaml
gates:
  requiredScenarioFailures: 0
  maxNewHighFindings: 0
  maxNewMediumFindings: 1
  minSuccessRateDelta: -0.02
  maxP95LatencyDelta: 0.15
  minPassK:
    k: 3
    value: 0.80
  requiredCoverage:
    authenticated: 1.0
    security: 1.0
```

Rules:

- infrastructure error rates are separate from product metrics;
- required skipped coverage fails;
- low sample sizes are flagged;
- an LLM-judge-only delta cannot independently block release without a configured confidence/calibration policy.

## Result Store

Initial local store:

- immutable run directories;
- JSONL index for append-only event/run discovery;
- SQLite catalog for queries and comparisons;
- artifact files remain on disk.

Tables:

- runs;
- suites;
- scenarios;
- trials;
- grades;
- metrics;
- findings;
- artifacts;
- baselines;
- approvals.

The file artifacts remain portable; SQLite is an index, not the sole source of evidence.

## CI Outputs

Produce:

- Markdown summary;
- machine JSON;
- JUnit XML for suites/scenarios;
- SARIF for security findings where mapping is meaningful;
- GitHub step summary when detected;
- exit code based on regression gate.

CLI:

```text
qa-harness experiment run <pack> <experiment.yaml>
qa-harness compare <baseline-run> <candidate-run>
qa-harness baseline promote <run-id> --name release
qa-harness report junit <run-id>
qa-harness report sarif <run-id>
```

## Scheduled and Online Monitoring

### Scheduled evaluation

Support recurring external orchestration through a stable non-interactive command. Scheduling itself may remain outside the harness.

Nightly behavior:

- run selected dataset/profile;
- compare to promoted baseline;
- classify drift;
- retain failure traces;
- emit findings and CI-compatible outputs.

### Production trace evaluation

Later milestone:

- ingest explicitly supplied, redacted production traces;
- sample by policy;
- run reference-free safety, anomaly, latency, and trajectory graders;
- promote reviewed incidents into offline dataset scenarios.

The harness does not silently capture production user traffic.

## Observability Export

Internal trace storage remains authoritative.

Optional exporters:

- OpenTelemetry Protocol;
- JSONL;
- console/debug.

Map where practical:

- agent invocation -> `gen_ai.operation.name=invoke_agent`;
- planning -> `plan`;
- tool execution -> `execute_tool`;
- conversation ID;
- model/provider;
- input/output token usage;
- MCP method/session/protocol;
- error type.

Because OpenTelemetry GenAI semantic conventions are still Development, mappings live behind an exporter version and do not dictate the internal schema.

## MCP Server

Expose read-mostly harness capabilities through MCP.

### Tools

```text
qa_list_packs
qa_list_suites
qa_list_datasets
qa_validate_dataset
qa_start_run
qa_get_run
qa_cancel_run
qa_compare_runs
qa_list_findings
qa_get_finding
```

### Resources

```text
qa://runs/<run-id>/summary
qa://runs/<run-id>/manifest
qa://findings/<finding-id>
qa://datasets/<pack>/<dataset>/<version>
```

### Security policy

- read operations are default;
- run/cancel operations require explicit server configuration;
- no raw storage-state or secrets are exposed;
- artifact access is scoped to approved run roots;
- clients receive stable IDs, not unrestricted filesystem paths;
- remote HTTP transport requires authorization and per-client consent;
- token passthrough is forbidden;
- sessions are not authentication;
- tool calls are traced with MCP request/session metadata;
- `qa_start_run` applies the same run, agent, and approval policies as CLI.

## Service Boundary

Implement a reusable application service:

```text
HarnessService
  listSuites()
  validateDataset()
  startRun()
  getRun()
  cancelRun()
  compareRuns()
  listFindings()
  getFinding()
```

CLI and MCP are thin adapters over this service. No orchestration logic is duplicated in the MCP server.

## Proposed Implementation

Add:

```text
src/experiments/experimentTypes.ts
src/experiments/runner.ts
src/experiments/comparison.ts
src/experiments/gates.ts
src/store/catalog.ts
src/store/migrations/
src/reporters/junit.ts
src/reporters/sarif.ts
src/reporters/github.ts
src/exporters/otel.ts
src/service/harnessService.ts
src/mcp/server.ts
```

## Acceptance Criteria

- Two compatible runs can be compared per scenario and metric.
- A baseline can be promoted and referenced by name.
- Required skipped coverage fails a CI gate.
- JUnit output distinguishes failure, error, and skipped.
- SARIF includes stable rule/finding IDs and evidence references.
- A nightly-compatible non-interactive command exits deterministically.
- OTel export is optional and failure to export does not corrupt the run.
- MCP clients can list suites, start an allowed run, poll it, cancel it, and retrieve findings.
- MCP cannot access files outside approved run roots.
- MCP run tools enforce the same policies as CLI.

## Test Plan

- SQLite migration and rebuild-from-files tests;
- baseline compatibility tests;
- metric delta and regression-gate tests;
- JUnit/SARIF schema tests;
- interrupted scheduled run and resume;
- OTel exporter mapping tests;
- MCP protocol tests over stdio;
- MCP authorization/policy tests for remote mode;
- path traversal, token passthrough, and session impersonation tests.

## Out of Scope

- Hosted multi-tenant dashboard
- Built-in scheduler service
- Automatic production traffic ingestion
- Automatic PR fixes
- A2A agent federation

## Final Exit Gate

The harness is considered an agentic evaluation platform when:

- datasets and agents can be evaluated repeatedly;
- trajectories and state outcomes are graded;
- runs are traceable and replayable;
- actions are bounded and policy-controlled;
- regressions are compared against baselines;
- security harm is measured in stages;
- CI and external agents can invoke the same governed service.
