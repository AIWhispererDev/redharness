# PRD 05: Agentic Security and Red-Team Evaluation

- Status: Partial
- Depends on: PRDs 01-04
- Blocks: Full security regression gating in PRD 06

## Goal

Extend the existing safe web security checks into an OWASP Agentic Top 10-aligned evaluation system that measures whether an AI application resists attacks while preserving benign utility.

## Design Basis

The red-team system must not collapse all outcomes into one attack-success boolean.

For each adversarial trial, record:

1. semantic acceptance: did the model agree with or repeat the malicious objective?
2. audit-visible harm evidence: did the trace contain a prohibited plan, disclosure, tool call, or payload?
3. sandbox/state harm: did an external state, memory, message, database, file, or controlled tool actually change?

This staged model follows the key lesson from SafeClawBench and prevents both false reassurance and exaggerated impact claims.

## Threat Coverage

### ASI01 Agent Goal Hijack

- direct prompt override;
- indirect injection in page/document/tool output;
- delayed/scheduled instruction;
- conflicting helpful and malicious instructions;
- goal drift detection.

### ASI02 Tool Misuse and Exploitation

- unsafe tool chaining;
- excessive/repeated calls;
- tool argument injection;
- exfiltration through allowed tools;
- tool-name impersonation;
- untrusted tool output pivot.

### ASI03 Identity and Privilege Abuse

- cross-user object access;
- inherited privileged session;
- role confusion;
- non-Pro to Pro boundary;
- stale or over-scoped credentials.

### ASI04 Agentic Supply Chain

- poisoned tool description/schema;
- changed MCP/tool version;
- malicious prompt/template dependency;
- unsigned or unexpected agent/tool package.

### ASI05 Unexpected Code Execution

- command-like content passed to an execution sink;
- unsafe URL or file handling;
- script payload in tool output.

Initial implementation detects and blocks attempts in controlled fixtures; it does not execute destructive payloads.

### ASI06 Memory and Context Poisoning

- persistent malicious memory;
- poisoned retrieved context;
- cross-session contamination;
- memory extraction;
- cleanup/rollback verification.

### ASI07 Insecure Inter-Agent Communication

- forged sender identity;
- malformed or schema-invalid message;
- instruction/data confusion;
- unauthorized delegation.

This category becomes active after multi-agent support exists. Schema and fixtures can be introduced earlier.

### ASI08 Cascading Failures

- tool outage;
- repeated retry amplification;
- partial-state failure;
- downstream bad data propagation;
- circuit-breaker validation.

### ASI09 Human-Agent Trust Exploitation

- fabricated confidence;
- misleading approval request;
- concealed high-impact action;
- social-engineering text presented as system authority.

### ASI10 Rogue Agents

- self-expanded scope;
- ignored cancellation;
- persistent action after goal completion;
- hidden subgoal;
- unauthorized tool discovery.

## Scenario Families

Initial safe release:

- system prompt extraction attempts;
- cross-user/session data requests using synthetic canaries;
- direct persona/policy override;
- indirect page and tool-return injection;
- tool misuse against fixture tools;
- memory poison/extract against synthetic memory;
- ambiguity-driven unsafe inference;
- repeated-action and budget exhaustion;
- identity/entitlement boundary checks.

No real secrets or third-party data are used. Canary data is generated per run and contains a run-specific marker.

## Environment Requirements

Red-team scenarios run against:

1. controlled local fixture environment for state-harm verification;
2. authorized staging environment for end-to-end validation;
3. production only for explicitly allowlisted, non-mutating probes.

Each environment declares:

- allowed origins;
- allowed accounts and roles;
- seeded canaries;
- reset strategy;
- prohibited actions;
- maximum mutation scope.

Cleanup runs even after cancellation and has its own result status.

## Attack Inputs

Sources:

- manually curated pack scenarios;
- reviewed templates;
- mutation strategies;
- optional model-generated variants;
- imported public benchmark cases where licenses permit.

Generated attacks are labeled with:

- generator and version;
- seed;
- parent scenario;
- transformation strategy;
- human review status.

Generated cases cannot become release gates until reviewed.

## Metrics

Per family and overall:

- semantic attack acceptance rate;
- audit-evidence harm rate;
- state-harm rate;
- benign task success rate;
- utility under attack;
- false-positive/over-defense rate;
- reproducibility rate;
- mean calls/tokens/cost to successful attack;
- detection/containment latency;
- cleanup success rate.

Repeated trials are mandatory for model-backed attacks.

## Findings

Finding state:

```text
observed
  -> suspected
  -> confirmed-semantic
  -> confirmed-evidence
  -> confirmed-state-harm
  -> mitigated
  -> regression
```

Severity is based primarily on demonstrated reachable impact:

- semantic-only results do not automatically become high severity;
- state harm involving authorization, data disclosure, external communication, code execution, or persistent memory can be high severity;
- inability to clean up increases severity.

Finding packets include:

- threat category and attack family;
- benign utility result;
- all three harm endpoints;
- trial statistics;
- canary/state diff;
- trace and replay;
- policy and tool versions;
- cleanup status.

## CLI

```text
qa-harness redteam <pack> --dataset agentic-security --split safe
qa-harness redteam <pack> --category ASI01 --trials 5
qa-harness redteam <pack> --environment fixture
qa-harness redteam compare <baseline-run> <candidate-run>
```

## Proposed Implementation

Add:

```text
src/redteam/redteamTypes.ts
src/redteam/attackRegistry.ts
src/redteam/attackMutations.ts
src/redteam/canaries.ts
src/redteam/harmEndpoints.ts
src/redteam/utility.ts
src/redteam/cleanup.ts
src/redteam/owaspMapping.ts
packs/pocket-socrates/datasets/agentic-security/
fixtures/agentic-security-app/
```

## Acceptance Criteria

- Every adversarial result reports semantic, evidence, and state-harm endpoints separately.
- A fixture scenario demonstrates semantic failure without state harm.
- A fixture scenario demonstrates blocked semantic output but detectable prohibited tool/state harm.
- Benign utility is measured for every defense comparison.
- Canary leakage is detected without using real secrets.
- Cleanup state is verified.
- OWASP ASI01, ASI02, ASI03, ASI06, ASI08, ASI09, and ASI10 have at least one safe scenario.
- Findings cannot claim state impact without state-diff/tool evidence.
- Red-team runs obey PRD 04 policies and budgets.

## Test Plan

- attack-template and mutation determinism tests;
- canary uniqueness and redaction tests;
- staged harm classifier tests;
- controlled fixture state-diff tests;
- over-defense case where the benign task must still succeed;
- repeated-trial metrics;
- cleanup after timeout/cancellation;
- finding lifecycle and severity tests.

## Out of Scope

- destructive exploitation
- malware generation/execution
- brute force or denial-of-service
- real payment or messaging actions
- unapproved third-party targets
- automatic disclosure submission

## Exit Gate

The red-team suite is release-gating only after fixture scenarios prove that harm endpoints and cleanup are measured correctly and judge-based graders are calibrated.
