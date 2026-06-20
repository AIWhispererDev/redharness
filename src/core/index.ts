export { registry } from './suiteRegistry.js';
export { RunCoordinator } from './runCoordinator.js';
export type { CoordinatorOptions } from './runCoordinator.js';
export {
  evaluateSuitePolicy,
  evaluateRunPolicy,
  isRetryable,
  isCompleted,
} from './resultPolicy.js';
export type { PolicyEvaluation, RunPolicyResult } from './resultPolicy.js';
export {
  loadManifest,
  saveManifest,
  getResumeTargets,
  mergeResultsIntoManifest,
  updateRunStatus,
  computeConfigHash,
} from './resumeStore.js';

export type {
  RequirementPolicy,
  SuiteDefinition,
  SuiteContext,
  SuiteResult,
  SuiteResultSummary,
  RunManifest,
  RunPolicy,
  RunSelection,
  RunConfigHash,
  ProfileDefinition,
  AttemptSummary,
  CheckResult,
  ArtifactRef,
  SerializedError,
  SuiteRequirement,
  GitMetadata,
  EnvironmentMetadata,
} from './runTypes.js';
export type { ExecutionStatus } from './status.js';
export {
  compareStatus,
  worseStatus,
  aggregateStatus,
  fromOkSkipped,
  statusLabel,
  statusToOk,
} from './status.js';
