import type { ExecutionStatus } from './status.js';

/**
 * Requirement policy for a suite.
 * - required: failure/error/cancelled/skipped => run fails
 * - optional: failure/error => run fails unless CLI policy overrides; skipped => warning
 * - informational: never gates the run
 */
export type RequirementPolicy = 'required' | 'optional' | 'informational';

/** Prerequisite that a suite may declare. */
export type SuiteRequirement = 'baseUrl' | 'storageState' | 'nonProStorageState' | 'repo';

/** Serialized error suitable for manifest output. */
export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
};

/** Reference to an artifact produced during suite execution. */
export type ArtifactRef = {
  path: string;
  label?: string;
  type?: string;
};

/** Normalized check result within a suite attempt. */
export type CheckResult = {
  name: string;
  status: ExecutionStatus;
  details: string[];
};

/** Summary of a single attempt at a suite. */
export type AttemptSummary = {
  attempt: number;
  status: ExecutionStatus;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  checks: CheckResult[];
  error?: SerializedError;
};

/** Context passed to each suite run function. */
export type SuiteContext = {
  packDir: string;
  baseUrl?: string;
  storageState?: string;
  nonProStorageState?: string;
  repo?: string;
  headless?: boolean;
  outputDir?: string;
  prompt?: string;
  turns?: number;
  maxTurns?: number;
  refreshEvery?: number;
  language?: string;
  confirmRuns?: number;
  writeFindings?: boolean;
  /** AbortSignal for timeout/cancellation. Suites should check this periodically. */
  abortSignal?: AbortSignal;
  /** Correlation identifiers for trace and evidence writers. */
  traceId?: string;
  spanId?: string;
  /** Attempt-scoped ID for evidence tracking. */
  attemptId?: string;
  /** Attempt-scoped artifact store for evidence persistence. */
  artifactStore?: import('../artifacts/artifactStore.js').ArtifactStore;
};

/** Suite definition registered in the registry. */
export type SuiteDefinition = {
  id: string;
  title: string;
  description: string;
  tags: string[];
  requirement: RequirementPolicy;
  dependencies?: string[];
  estimatedDuration?: 'short' | 'medium' | 'long';
  requires?: SuiteRequirement[];
  run: (context: SuiteContext) => Promise<SuiteResult>;
};

/** Normalized suite result. */
export type SuiteResult = {
  suiteId: string;
  status: ExecutionStatus;
  requirement: RequirementPolicy;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attempts: AttemptSummary[];
  checks: CheckResult[];
  artifacts: ArtifactRef[];
  skipReason?: string;
  error?: SerializedError;
  metrics?: Record<string, number>;
};

/** Summary of one suite result within the run manifest. */
export type SuiteResultSummary = {
  suiteId: string;
  title: string;
  status: ExecutionStatus;
  requirement: RequirementPolicy;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  attemptCount: number;
  skipReason?: string;
  error?: SerializedError;
};

/** Run policy configuration. */
export type RunPolicy = {
  retryErrors: number;
  maxWorkers: number;
  timeoutMs?: number;
};

/** Git snapshot metadata. */
export type GitMetadata = {
  commit?: string;
  branch?: string;
  dirty?: boolean;
};

/** Environment metadata. */
export type EnvironmentMetadata = {
  nodeVersion: string;
  platform: string;
  ci: boolean;
};

/** Run selection criteria. */
export type RunSelection = {
  suites: string[];
  tags: string[];
  excludedTags: string[];
};

/** Run manifest written to run.json. */
export type RunManifest = {
  schemaVersion: '1';
  runId: string;
  packId: string;
  profile?: string;
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  source: 'local' | 'ci' | 'scheduled' | 'mcp';
  git?: GitMetadata;
  environment: EnvironmentMetadata;
  selection: RunSelection;
  policy: RunPolicy;
  suiteResults: SuiteResultSummary[];
  /** Deterministic hash of (packId, profile, policy, selection, source) for resume compatibility. */
  configHash?: string;
};

/** Profile definition from pack configuration. */
export type ProfileDefinition = {
  includeTags: string[];
  excludeTags?: string[];
};

/** Run configuration hash for resume compatibility detection. */
export type RunConfigHash = {
  packId: string;
  profile?: string;
  policy: RunPolicy;
  selection: RunSelection;
  source: 'local' | 'ci' | 'scheduled' | 'mcp';
};
