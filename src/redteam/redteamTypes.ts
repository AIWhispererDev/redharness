/**
 * PRD 05: Agentic Security and Red-Team Evaluation — core type definitions.
 *
 * Extends the existing safe web security checks into an OWASP Agentic Top 10-
 * aligned evaluation system that measures whether an AI application resists
 * attacks while preserving benign utility.
 */

import type { ExecutionStatus } from '../core/status.js';

// ---------------------------------------------------------------------------
// OWASP Agentic Security categories
// ---------------------------------------------------------------------------

export type OwaspCategory =
  | 'ASI01' // Agent Goal Hijack
  | 'ASI02' // Tool Misuse and Exploitation
  | 'ASI03' // Identity and Privilege Abuse
  | 'ASI04' // Agentic Supply Chain
  | 'ASI05' // Unexpected Code Execution
  | 'ASI06' // Memory and Context Poisoning
  | 'ASI07' // Insecure Inter-Agent Communication
  | 'ASI08' // Cascading Failures
  | 'ASI09' // Human-Agent Trust Exploitation
  | 'ASI10'; // Rogue Agents

// ---------------------------------------------------------------------------
// Attack definition
// ---------------------------------------------------------------------------

export type AttackDefinition = {
  id: string;
  name: string;
  description: string;
  category: OwaspCategory;
  subcategory: string;
  /** Risk level for sorting/filtering. */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** How the attack is delivered. */
  vector: 'prompt' | 'page_injection' | 'tool_output' | 'memory' | 'identity' | 'supply_chain' | 'multi_step';
  /** Template prompt or injection content. */
  template: string;
  /** Placeholders to fill for specific scenarios. */
  placeholders?: string[];
  /** Expected resistance patterns. */
  expectedResistance?: string[];
  /** Whether this attack requires fixture state. */
  requiresFixture?: boolean;
  /** Whether this attack is safe to run in all environments. */
  safeForProduction?: boolean;
  /** Tags for categorization and selection. */
  tags: string[];
};

// ---------------------------------------------------------------------------
// Attack instance (a specific rendered attack)
// ---------------------------------------------------------------------------

export type AttackInstance = {
  id: string;
  attackId: string;
  renderedPrompt: string;
  placeholders: Record<string, string>;
  generator: string;
  generatorVersion: string;
  seed: string;
  parentAttackId?: string;
  transformationStrategy?: string;
  humanReviewed: boolean;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Three-stage harm endpoints
// ---------------------------------------------------------------------------

export type HarmEndpoint = {
  /** Did the model semantically accept/repeat the malicious objective? */
  semanticAcceptance: boolean;
  /** Evidence of semantic acceptance. */
  semanticEvidence: string[];
  /** Is there audit-visible harm evidence in the trace? */
  auditVisibleHarm: boolean;
  /** Evidence of audit-visible harm. */
  auditEvidence: string[];
  /** Did external state actually change (sandbox/state harm)? */
  stateHarm: boolean;
  /** Evidence of state harm (state diff, tool output, etc.). */
  stateHarmEvidence: string[];
};

// ---------------------------------------------------------------------------
// Trial result for adversarial scenarios
// ---------------------------------------------------------------------------

export type AdversarialTrialResult = {
  trial: number;
  status: ExecutionStatus;
  harm: HarmEndpoint;
  benignTaskSuccess: boolean;
  /** Was cleanup successful after this trial? */
  cleanupSuccess: boolean;
  /** Number of tool calls used. */
  toolCallCount: number;
  /** Tokens consumed (if available). */
  tokenCount?: number;
  /** Cost in USD (if available). */
  costUsd?: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Full adversarial scenario result
// ---------------------------------------------------------------------------

export type AdversarialScenarioResult = {
  scenarioId: string;
  attackId: string;
  category: OwaspCategory;
  title: string;
  status: ExecutionStatus;
  trials: AdversarialTrialResult[];
  aggregateHarm: HarmEndpoint;
  aggregateBenignSuccess: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Red-team run result
// ---------------------------------------------------------------------------

export type RedTeamRunResult = {
  runId: string;
  packId: string;
  environment: string;
  category?: OwaspCategory;
  scenarios: AdversarialScenarioResult[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Attack mutation strategy
// ---------------------------------------------------------------------------

export type MutationStrategy = {
  id: string;
  name: string;
  description: string;
  /** Apply the mutation to an attack template. */
  apply: (template: string, seed: string) => string;
};

// ---------------------------------------------------------------------------
// Canary types
// ---------------------------------------------------------------------------

export type Canary = {
  id: string;
  value: string;
  marker: string;
  context: string;
  placement: 'system_prompt' | 'memory' | 'tool_output' | 'page_text' | 'api_response';
  expiresAt: string;
};

export type CanaryDetection = {
  canaryId: string;
  marker: string;
  detectedIn: string;
  context: string;
};

// ---------------------------------------------------------------------------
// Finding lifecycle (extends PRD 02)
// ---------------------------------------------------------------------------

export type RedTeamFindingState =
  | 'observed'
  | 'suspected'
  | 'confirmed-semantic'
  | 'confirmed-evidence'
  | 'confirmed-state-harm'
  | 'mitigated'
  | 'regression';

export type RedTeamFinding = {
  id: string;
  lifecycleState: RedTeamFindingState;
  category: OwaspCategory;
  attackId: string;
  title: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  benignTaskSuccessRate: number;
  harm: HarmEndpoint;
  trialCount: number;
  successfulTrialCount: number;
  cleanupStatus: 'clean' | 'partial' | 'failed';
  environment: string;
  policyVersion: string;
  toolVersions: Record<string, string>;
  createdAt: string;
};

// ---------------------------------------------------------------------------
// Environment declaration
// ---------------------------------------------------------------------------

export type RedTeamEnvironment = {
  name: string;
  allowedOrigins: string[];
  allowedAccounts: string[];
  seededCanaries: Canary[];
  resetStrategy: 'fixture_reset' | 'session_reset' | 'none';
  prohibitedActions: string[];
  maxMutationScope: 'none' | 'read_only' | 'write_cleanable';
};
