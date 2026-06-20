/**
 * Harness service — shared types used by both CLI and MCP adapters.
 */

export type PackInfo = {
  id: string;
  name: string;
  baseUrl?: string;
};

export type ServiceError = {
  code: string;
  message: string;
  details?: unknown;
};

// Feature 04: Agent run control-plane types

export type AgentRunSummary = {
  runId: string;
  status: 'running' | 'awaiting-approval' | 'paused' | 'completed' | 'failed' | 'cancelled';
  previousStatus?: string;
  agentId: string;
  turn: number;
  pendingApprovals: number;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
};
