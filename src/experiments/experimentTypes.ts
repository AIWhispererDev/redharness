/**
 * PRD 06: Experiment model — evaluates candidate configurations
 * against versioned datasets with regression gates.
 */

import type { ExecutionStatus } from '../core/status.js';

// ---------------------------------------------------------------------------
// Experiment configuration
// ---------------------------------------------------------------------------

export type CandidateConfig = {
  /** Human label (e.g. "new-prompt-v2", "gpt-5-vs-claude-4"). */
  label: string;
  /** Application commit or deployment ID. */
  appCommit?: string;
  /** Prompt version. */
  promptVersion?: string;
  /** Agent version. */
  agentVersion?: string;
  /** Model/provider configuration. */
  modelConfig?: { provider: string; modelId: string };
  /** Tool set/version. */
  toolVersions?: Record<string, string>;
  /** Policy version. */
  policyVersion?: string;
  /** Pack version. */
  packVersion?: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
};

export type Experiment = {
  experimentId: string;
  datasetId: string;
  datasetVersion: string;
  baseline?: CandidateConfig;
  candidates: CandidateConfig[];
  trials: number;
  metrics: string[];
  gate: RegressionGate;
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export type MetricValue = {
  name: string;
  value: number;
  unit?: string;
  confidence95?: [number, number]; // Confidence interval
  sampleSize: number;
};

export type MetricDelta = {
  name: string;
  baselineValue: number;
  candidateValue: number;
  delta: number;
  deltaPercent: number;
  regressed: boolean;
  improved: boolean;
};

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type FindingRef = {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title?: string;
};

export type ScenarioComparison = {
  scenarioId: string;
  scenarioTitle: string;
  baselineStatus: ExecutionStatus;
  candidateStatus: ExecutionStatus;
  statusChanged: boolean;
  metrics: MetricDelta[];
  newFindings: FindingRef[];
  resolvedFindings: FindingRef[];
  regressed: boolean;
  improved: boolean;
  /** Grader IDs and versions used for this scenario (baseline + candidate). */
  graderVersions?: Array<{ id: string; version: string }>;
};

export type RunComparison = {
  baselineRunId: string;
  candidateRunId: string;
  datasetId: string;
  datasetVersion: string;
  baselineLabel: string;
  candidateLabel: string;
  scenarioComparisons: ScenarioComparison[];
  aggregateDeltas: Record<string, number>;
  overallRegressed: boolean;
  overallImproved: boolean;
  createdAt: string;
  /** Grader IDs and versions used across the comparison. */
  graderVersions?: Array<{ id: string; version: string }>;
};

// ---------------------------------------------------------------------------
// Regression gates
// ---------------------------------------------------------------------------

export type PassKGate = {
  k: number;
  value: number; // Minimum success rate
};

export type CoverageGate = {
  name: string; // e.g. "authenticated", "security"
  required: number; // 1.0 = 100%
};

export type RegressionGate = {
  requiredScenarioFailures: number; // 0 = no failures allowed
  maxNewHighFindings: number;
  maxNewMediumFindings: number;
  minSuccessRateDelta: number; // negative = allowed regression
  maxP95LatencyDelta: number; // positive = allowed increase
  minPassK?: PassKGate;
  requiredCoverage?: Record<string, number>; // tag -> required rate
};

export type GateResult = {
  passed: boolean;
  gateName: string;
  expected: unknown;
  actual: unknown;
  details: string;
};

export type GateSuiteResult = {
  passed: boolean;
  gates: GateResult[];
};

// ---------------------------------------------------------------------------
// Experiment run result
// ---------------------------------------------------------------------------

export type ExperimentRunResult = {
  experimentId: string;
  datasetId: string;
  candidateResults: CandidateRunResult[];
  comparisons: RunComparison[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

export type CandidateRunResult = {
  label: string;
  config: CandidateConfig;
  runId: string;
  status: ExecutionStatus;
  /** Grader IDs and versions used in this run. */
  graderVersions?: Array<{ id: string; version: string }>;
  suiteResults: Array<{
    suiteId: string;
    scenarioId: string;
    status: ExecutionStatus;
    metrics: MetricValue[];
    findings?: FindingRef[];
    tags?: string[];
    /** Individual repeated-trial outcomes when Pass@K is evaluated. */
    trialStatuses?: ExecutionStatus[];
    /** Grader IDs and versions used for this suite. */
    graderVersions?: Array<{ id: string; version: string }>;
  }>;
};
