# PRD 04: Bounded Agent Runtime, Tools, Approvals, and Checkpoints

- Status: Partial
- Depends on: PRDs 01-03
- Blocks: PRDs 05-06

## Goal

Add agentic exploration only after runs, traces, replay, scenarios, and graders are trustworthy.

The runtime must be provider-neutral, bounded, cancellable, resumable, and governed by explicit tool policies.

## Runtime Model

```ts
type AgentDefinition = {
  id: string;
  version: string;
  instructions: string;
  model: ModelConfig;
  tools: string[];
  policy: AgentPolicy;
  budgets: AgentBudgets;
};
```

```ts
type AgentState = {
  runId: string;
  scenarioId: string;
  trialId: string;
  turn: number;
  goal: IntentCapsule;
  messages: AgentMessage[];
  observations: Observation[];
  pendingApprovals: ApprovalRequest[];
  checkpointId?: string;
};
```

The first agent mode is constrained exploratory QA:

- receives a scenario goal and allowed surface;
- observes browser/application state;
- selects from registered tools;
- records a plan and each action;
- stops on success, failure, budget, policy denial, or cancellation;
- does not invent new permissions.

## Model Adapter

Create a provider-neutral interface:

```ts
interface ModelAdapter {
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;
  estimateCost?(usage: ModelUsage): number;
}
```

Initial implementation may support one provider, but model/provider identifiers and usage belong in trace metadata rather than suite code.

Tests use a deterministic fake adapter.

## Tool Registry

```ts
type ToolDefinition = {
  name: string;
  version: string;
  description: string;
  inputSchema: JsonSchema;
  risk: 'read' | 'write' | 'high-impact';
  capabilities: string[];
  network?: {
    allowedHosts: string[];
  };
  execute: ToolHandler;
};
```

Initial tools:

- browser observe;
- browser navigate;
- browser click;
- browser fill;
- browser screenshot;
- HTTP GET/HEAD/OPTIONS;
- artifact read/write inside the run directory;
- scenario state query;
- submit candidate finding.

Shell, arbitrary filesystem writes, payments, account deletion, and external messaging are not enabled in the initial runtime.

## Policy and Approval

Every tool call passes through:

```text
model proposal
  -> schema validation
  -> capability/risk lookup
  -> intent and scope validation
  -> budget check
  -> approval policy
  -> execution
  -> postcondition and trace
```

Approval decisions:

- `allow`;
- `deny`;
- `require-human`;
- `require-dry-run`;
- `escalate`.

CI behavior is fail-closed:

- human-required calls are denied unless an approved non-interactive policy exists;
- unknown tools or arguments are denied;
- high-impact tools cannot be auto-approved in the initial release.

Approval records include policy version, matched rule, tool arguments after redaction, operator identity when applicable, and decision time.

## Intent Capsule

Each execution cycle carries an immutable goal envelope:

```ts
type IntentCapsule = {
  goalId: string;
  userGoal: string;
  allowedActions: string[];
  prohibitedActions: string[];
  allowedOrigins: string[];
  dataBoundary: string;
  expiresAt: string;
};
```

Tool calls that do not map to the declared goal or allowed scope are denied and recorded as goal drift.

This is a local policy object, not a cryptographic security claim in the first release.

## Budgets and Stop Conditions

```ts
type AgentBudgets = {
  wallTimeMs: number;
  workingTimeMs?: number;
  turns: number;
  messages: number;
  toolCalls: number;
  perToolCalls?: Record<string, number>;
  tokens?: number;
  costUsd?: number;
  networkRequests: number;
};
```

Budget exhaustion produces `cancelled` with reason `budget-exceeded`, not `failed`.

Mandatory controls:

- `AbortSignal` through model and tool calls;
- CLI cancellation;
- global kill-switch file or coordinator signal;
- per-run timeout;
- loop/stall detection;
- repeated identical action detection;
- external-call rate limiting.

## Sandbox Profiles

Profiles:

1. `browser-readonly`
   - browser observation/navigation;
   - no mutating app actions unless explicitly listed.
2. `browser-safe-write`
   - pack-approved reversible mutations;
   - cleanup required.
3. `http-readonly`
   - fixed methods and allowlisted origins.
4. `repo-readonly`
   - source inspection only.
5. `container` (later milestone)
   - isolated code/tool execution with restricted network.

Every scenario declares its sandbox profile. Production targets default to read-only.

## Checkpoint and Resume

Checkpoint at:

- turn boundaries;
- before approved high-impact actions;
- after successful state-changing tools;
- configurable intervals.

Checkpoint contents:

- agent messages and observations;
- budgets consumed;
- scenario variables;
- pending approvals;
- browser/storage references where safely serializable;
- trace cursor and artifact manifest.

Resume:

- restores logical state;
- validates policy, dataset, agent, and tool versions;
- marks non-restorable browser/process state explicitly;
- may restart from the last replayable action boundary.

## Human Intervention

Operators can:

- approve/deny a pending action;
- add a bounded instruction;
- stop the run;
- mark a candidate finding invalid;
- convert a trace into a new scenario.

Intervention is an event in the trace and never hidden from evaluation.

## Proposed Implementation

Add:

```text
src/agent/agentTypes.ts
src/agent/runtime.ts
src/agent/modelAdapter.ts
src/agent/toolRegistry.ts
src/agent/policyEngine.ts
src/agent/approval.ts
src/agent/budgets.ts
src/agent/checkpoints.ts
src/agent/intent.ts
src/agent/stopConditions.ts
```

## CLI

```text
qa-harness agent run <pack> <scenario> --agent exploratory-qa
qa-harness agent resume <run-id>
qa-harness agent approve <run-id> <approval-id>
qa-harness agent cancel <run-id>
```

## Acceptance Criteria

- The deterministic fake agent completes a fixture scenario.
- Unknown and out-of-scope tool calls are denied.
- High-impact calls cannot execute without approval.
- All calls enforce schema, origin, and budget policies.
- Cancellation stops model and tool work promptly.
- A checkpointed fixture run resumes without repeating completed safe actions.
- Infinite/repeated action loops terminate.
- Tool arguments, decisions, usage, and outcomes appear in the trace.
- No initial tool can write outside the run directory or approved browser target.

## Security Tests

- prompt attempts to add a new tool;
- indirect page text instructing the agent to leave the allowed origin;
- hidden content requesting secrets;
- repeated costly tool loop;
- forged approval ID;
- stale checkpoint with a changed policy;
- tool-name impersonation;
- argument schema smuggling;
- cancellation during a long-running tool.

## Out of Scope

- Unrestricted shell
- Autonomous code modification
- Automatic PR creation
- Multi-agent delegation
- Production destructive actions

## Exit Gate

No red-team attack generator or autonomous bug hunt may run unless all tool execution is policy-mediated, traced, budgeted, and cancellable.
