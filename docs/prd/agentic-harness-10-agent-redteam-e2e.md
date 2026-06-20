# PRD 10: Agent Runtime and Red-Team End-to-End Execution

- Status: Ready for implementation
- Priority: P1
- Depends on: PRDs 07-09 and existing PRDs 04-05 primitives
- Blocks: Safe autonomous QA and agentic-security release gates

## Goal

Turn the existing agent-runtime and red-team building blocks into executable, fixture-proven workflows with real policy enforcement, cleanup verification, and staged harm measurement.

## Problem

The repository has:

- model adapter interfaces and a fake adapter;
- tool registry and schema validation;
- approval, budget, checkpoint, loop, stall, and cancellation primitives;
- attack definitions and deterministic mutations;
- canary, utility, harm-endpoint, cleanup, and OWASP mapping helpers.

Most current tests validate components independently. Missing proof includes:

- a full agent scenario completing through model, tools, trace, graders, and checkpointing;
- a provider-neutral real adapter contract beyond the fake adapter;
- origin and filesystem enforcement through actual tools;
- approval lifecycle through CLI/service interfaces;
- checkpoint resume without repeating completed side effects;
- controlled red-team execution against a vulnerable and defended fixture;
- verified cleanup state;
- separate semantic, audit-evidence, and state-harm outcomes in retained findings.

## Product Requirements

### End-to-end agent execution

An agent run must execute:

```text
intent -> model decision -> policy decision -> approval if needed
-> tool execution -> observation -> checkpoint -> stop condition
-> graders -> evidence -> result
```

Every stage emits trace events and stable IDs.

### Initial governed tools

Provide a minimal tool set:

- browser navigate/read/click/fill;
- HTTP GET to allowlisted origins;
- fixture state read;
- fixture state mutation for explicitly approved test environments;
- artifact write inside the active run directory.

Rules:

- unknown tools are denied;
- argument schemas reject extra/smuggled fields;
- redirects are revalidated against origin policy;
- filesystem paths resolve inside approved roots;
- mutation tools are disabled outside fixture/test profiles by default.

### Model adapters

Support:

1. deterministic fake adapter for CI;
2. one configurable external adapter behind environment-based credentials;
3. replay adapter that reuses captured model responses for deterministic debugging.

No external provider is required for the default test suite.

Provider errors, rate limits, cancellation, token use, and latency map to the common runtime contract.

### Approval lifecycle

High-impact calls enter `awaiting_approval`.

Approval records include:

- approval ID;
- run and tool-call IDs;
- normalized arguments;
- risk level;
- policy reason;
- expiration;
- approving actor;
- approve/deny decision.

Forged, stale, mismatched, or reused approvals are denied.

### Checkpoint and resume

Checkpoint state contains:

- intent and policy versions;
- model/tool history;
- completed action IDs;
- pending approval;
- budget consumption;
- fixture/state snapshot reference;
- trace correlation.

Resume must not repeat a completed mutation. Changed policy/tool versions require explicit compatibility handling.

### Red-team execution

The red-team runner:

- selects attack definitions by ID/category/tag;
- creates deterministic mutations from an explicit seed;
- runs benign controls alongside adversarial cases;
- uses the governed agent runtime;
- captures canary exposure;
- evaluates semantic response, audit/tool evidence, and actual state harm separately;
- performs and verifies cleanup;
- reports utility impact.

### Minimum OWASP coverage

Executable fixture scenarios must cover:

- ASI01 goal hijack;
- ASI02 tool misuse;
- ASI03 identity/privilege abuse;
- ASI06 memory/context poisoning;
- ASI08 cascading failure;
- ASI09 human-agent trust exploitation;
- ASI10 rogue-agent behavior.

ASI04, ASI05, and ASI07 remain documented extensions unless safe fixtures are included.

### Harm model

Each adversarial trial reports:

```ts
type StagedHarm = {
  semanticAcceptance: boolean;
  auditEvidence: boolean;
  stateHarm: boolean;
  canaryLeakage: boolean;
  cleanupVerified: boolean;
  benignUtilityPassed: boolean;
};
```

A finding cannot claim state harm without state-diff or tool-effect evidence.

### Cleanup verification

Cleanup is successful only when post-cleanup checks confirm:

- fixture data restored;
- session/cookies reset where applicable;
- navigation returned to a safe state where applicable;
- no pending mutation remains;
- cleanup errors are reported separately.

Remove current “verification not implemented” paths for release-gating fixtures.

## Proposed Implementation

Modify:

```text
src/agent/runtime.ts
src/agent/toolRegistry.ts
src/agent/policyEngine.ts
src/agent/approval.ts
src/agent/checkpoints.ts
src/agent/modelAdapter.ts
src/agent/budgets.ts
src/agent/stopConditions.ts
src/cli.ts
src/redteam/cleanup.ts
src/redteam/harmEndpoints.ts
src/redteam/utility.ts
```

Add:

```text
src/agent/tools/browserTools.ts
src/agent/tools/httpTools.ts
src/agent/tools/fixtureTools.ts
src/agent/replayAdapter.ts
src/redteam/runner.ts
src/redteam/report.ts
tests/agent/e2e.test.ts
tests/agent/policySecurity.test.ts
tests/redteamE2E.test.ts
packs/fixture-agent/datasets/redteam/
```

## Acceptance Criteria

- A deterministic fake agent completes a multi-step fixture task.
- Every tool call is schema-validated, policy-mediated, traced, and budgeted.
- Unknown, out-of-origin, path-traversal, and argument-smuggling calls are denied.
- High-impact mutation cannot execute without a valid approval.
- Cancellation stops model and tool execution promptly.
- Resume does not repeat a completed mutation.
- Repeated-action and loop attacks terminate within configured budgets.
- A vulnerable fixture demonstrates semantic acceptance without state harm.
- A separate fixture demonstrates prohibited tool/state harm even when final text refuses or conceals it.
- Canary leakage is detected without persisting a real secret.
- Cleanup is verified through state/session/navigation checks.
- Benign utility is reported for every defense comparison.
- Required OWASP categories have at least one executable safe scenario.
- Findings distinguish semantic, evidence, and state harm.

## Test Plan

- deterministic full-loop success;
- provider error/rate-limit/cancellation mapping;
- indirect page injection;
- hidden-content secret request;
- cross-origin redirect;
- filesystem traversal;
- forged/stale/reused approval;
- mutation checkpoint and resume;
- cancellation during long-running tool;
- budget and repeated-loop exhaustion;
- vulnerable versus defended fixture comparison;
- semantic-only versus state-harm cases;
- canary leak and redaction;
- cleanup success and cleanup failure;
- benign utility regression.

## Out of Scope

- Unrestricted autonomous web exploration
- Destructive testing against production
- Automatic exploit generation
- Inter-agent federation
- Built-in secret management

## Exit Gate

Agent and red-team commands are release-gating only after controlled end-to-end tests prove that every action is bounded and traced, approvals cannot be bypassed, harm is measured in stages, and cleanup is verified.
