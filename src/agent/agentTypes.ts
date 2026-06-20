/**
 * PRD 04: Bounded Agent Runtime — core type definitions.
 *
 * Every agent run is governed by an IntentCapsule, policy declarations,
 * and budgets. These types are provider-neutral and safe-by-default.
 */

import type { ExecutionStatus } from '../core/status.js';
import type { TraceWriter } from '../trace/traceWriter.js';
import type { ArtifactStore } from '../artifacts/artifactStore.js';

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

export type ModelConfig = {
  provider: string;
  modelId: string;
  /** Optional model-specific parameters (temperature, top_p, max_tokens, etc.). */
  parameters?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Agent definition (loaded from pack or config)
// ---------------------------------------------------------------------------

export type AgentDefinition = {
  id: string;
  version: string;
  instructions: string;
  model: ModelConfig;
  tools: string[];
  policy: AgentPolicy;
  budgets: AgentBudgets;
};

// ---------------------------------------------------------------------------
// Agent policy
// ---------------------------------------------------------------------------

export type ApprovalPolicy = 'auto' | 'require-human' | 'require-dry-run' | 'deny' | 'escalate';

export type ToolPolicy = {
  toolName: string;
  approval: ApprovalPolicy;
  /** Per-tool call budget within the overall budget. */
  maxCalls?: number;
  /** Rate limit: max calls per windowMs. */
  rateLimit?: { maxCalls: number; windowMs: number };
};

export type AgentPolicy = {
  /** Default approval for tools not explicitly listed. */
  defaultToolApproval: ApprovalPolicy;
  /** Per-tool policies. */
  toolPolicies: ToolPolicy[];
  /** Allowed origins for HTTP/network tools. */
  allowedOrigins: string[];
  /** Prohibited actions regardless of tool. */
  prohibitedActions: string[];
  /** Whether human intervention is required for any state change. */
  requireHumanForStateChanges: boolean;
};

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export type AgentBudgets = {
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

// ---------------------------------------------------------------------------
// Intent capsule — immutable goal envelope
// ---------------------------------------------------------------------------

export type IntentCapsule = {
  goalId: string;
  userGoal: string;
  allowedActions: string[];
  prohibitedActions: string[];
  allowedOrigins: string[];
  dataBoundary: string;
  expiresAt: string;
};

// ---------------------------------------------------------------------------
// Agent message types
// ---------------------------------------------------------------------------

export type AgentMessageRole = 'system' | 'user' | 'assistant' | 'tool';

export type AgentMessage = {
  role: AgentMessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  toolResult?: unknown;
  timestamp: string;
};

// ---------------------------------------------------------------------------
// Observation (browser/application state observation)
// ---------------------------------------------------------------------------

export type Observation = {
  type: 'browser_state' | 'http_response' | 'tool_output' | 'system_state';
  data: Record<string, unknown>;
  timestamp: string;
  sourceTool?: string;
};

// ---------------------------------------------------------------------------
// Approval request
// ---------------------------------------------------------------------------

export type ApprovalRequest = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  intendedAction: string;
  risk: ToolRiskLevel;
  requestedAt: string;
  decidedAt?: string;
  decision?: 'allowed' | 'denied' | 'escalated';
  decidedBy?: 'policy' | 'human' | 'ai';
  reason?: string;
};

// ---------------------------------------------------------------------------
// Tool risk level
// ---------------------------------------------------------------------------

export type ToolRiskLevel = 'read' | 'write' | 'high-impact';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export type ToolDefinition = {
  name: string;
  version: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
  risk: ToolRiskLevel;
  capabilities: string[];
  network?: {
    allowedHosts: string[];
  };
  execute: ToolHandler;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

export type ToolExecutionContext = {
  agentId: string;
  runId: string;
  intent: IntentCapsule;
  traceId: string;
  spanId: string;
  abortSignal: AbortSignal;
  /** Controlled fixture endpoint for fixture-only tools. */
  fixtureBaseUrl?: string;
  /** Tool execution span ID for trace correlation. */
  toolSpanId?: string;
  /** Policy check span ID for trace correlation. */
  policySpanId?: string;
};

export type ToolResult = {
  success: boolean;
  output?: unknown;
  error?: string;
  durationMs: number;
  traceAttributes?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Agent state (mutable per turn)
// ---------------------------------------------------------------------------

export type AgentState = {
  runId: string;
  scenarioId: string;
  trialId: string;
  turn: number;
  goal: IntentCapsule;
  messages: AgentMessage[];
  observations: Observation[];
  pendingApprovals: ApprovalRequest[];
  checkpointId?: string;
  startedAt: string;
};

// ---------------------------------------------------------------------------
// Agent execution result
// ---------------------------------------------------------------------------

export type AgentRunResult = {
  runId: string;
  status: ExecutionStatus;
  reason?: string;
  turn: number;
  messages: AgentMessage[];
  observations: Observation[];
  budgetsConsumed: BudgetConsumption;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  checkpointId?: string;
  /** Trace ID for correlation with harness traces. */
  traceId?: string;
  /** Invocation span ID for navigation. */
  invokeSpanId?: string;
  /** Evidence manifest reference for finding linkage. */
  evidenceManifestRef?: {
    traceId: string;
    attemptId: string;
    artifactCount: number;
  };
};

// ---------------------------------------------------------------------------
// Budget consumption tracking
// ---------------------------------------------------------------------------

export type BudgetConsumption = {
  wallTimeMs: number;
  turns: number;
  messages: number;
  toolCalls: number;
  networkRequests: number;
  tokens?: number;
  costUsd?: number;
  perToolCalls?: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

export type Checkpoint = {
  id: string;
  runId: string;
  agentState: AgentState;
  budgetsConsumed: BudgetConsumption;
  policyVersion: string;
  toolVersions: Record<string, string>;
  datasetVersion?: string;
  createdAt: string;
  /** Trace cursor for resuming trace parentage after checkpoint restore. */
  traceCursor?: {
    traceId: string;
    invokeSpanId: string;
    lastTurn: number;
  };
};

// ---------------------------------------------------------------------------
// Sandbox profiles
// ---------------------------------------------------------------------------

export type SandboxProfile =
  | 'browser-readonly'
  | 'browser-safe-write'
  | 'http-readonly'
  | 'repo-readonly'
  | 'container';
