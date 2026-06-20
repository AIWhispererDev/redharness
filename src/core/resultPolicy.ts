import { aggregateStatus } from './status.js';
import type { ExecutionStatus } from './status.js';
import type { RequirementPolicy, SuiteResultSummary } from './runTypes.js';

/** Result of evaluating the run policy against one suite result. */
export type PolicyEvaluation = {
  gatesRun: boolean;
  isPassing: boolean;
  reason: string;
};

/**
 * Evaluate whether a single suite result gating is passing given its requirement
 * policy and status. Does NOT consider CLI policy overrides.
 */
export function evaluateSuitePolicy(
  status: ExecutionStatus,
  requirement: RequirementPolicy,
): PolicyEvaluation {
  switch (requirement) {
    case 'required':
      switch (status) {
        case 'passed':
          return { gatesRun: true, isPassing: true, reason: 'Required suite passed.' };
        case 'failed':
          return { gatesRun: true, isPassing: false, reason: 'Required suite failed.' };
        case 'error':
          return { gatesRun: true, isPassing: false, reason: 'Required suite encountered a harness error.' };
        case 'cancelled':
          return { gatesRun: true, isPassing: false, reason: 'Required suite was cancelled.' };
        case 'skipped':
          return { gatesRun: true, isPassing: false, reason: 'Required suite was skipped.' };
      }
    // fall through
    case 'optional':
      switch (status) {
        case 'passed':
          return { gatesRun: true, isPassing: true, reason: 'Optional suite passed.' };
        case 'failed':
          return { gatesRun: true, isPassing: false, reason: 'Optional suite failed.' };
        case 'error':
          return { gatesRun: true, isPassing: false, reason: 'Optional suite encountered a harness error.' };
        case 'cancelled':
          return { gatesRun: false, isPassing: true, reason: 'Optional suite cancelled — not gating.' };
        case 'skipped':
          return { gatesRun: false, isPassing: true, reason: 'Optional suite skipped — not gating (warning logged).' };
      }
    // fall through
    case 'informational':
      return { gatesRun: false, isPassing: true, reason: 'Informational suite — does not gate the run.' };
  }
}

/** Aggregate policy result for the entire run. */
export type RunPolicyResult = {
  status: ExecutionStatus;
  isPassing: boolean;
  evaluations: PolicyEvaluation[];
};

/**
 * Evaluate the overall run policy from all suite results.
 * Returns the aggregate status and whether the run passes.
 *
 * An empty result set (no suites ran) produces an `error` status —
 * runs with zero selected or completed suites cannot pass.
 */
export function evaluateRunPolicy(
  suiteResults: SuiteResultSummary[],
): RunPolicyResult {
  if (suiteResults.length === 0) {
    return {
      status: 'error',
      isPassing: false,
      evaluations: [],
    };
  }

  const evaluations: PolicyEvaluation[] = [];
  const gatingStatuses: ExecutionStatus[] = [];

  for (const sr of suiteResults) {
    const eval_ = evaluateSuitePolicy(sr.status, sr.requirement);
    evaluations.push(eval_);
    if (eval_.gatesRun && !eval_.isPassing) {
      gatingStatuses.push(sr.status);
    }
  }

  if (gatingStatuses.length === 0) {
    return {
      status: 'passed',
      isPassing: true,
      evaluations,
    };
  }

  // When a required suite is skipped, report it as failed rather than skipped
  // — policy says skipped required coverage fails the gate.
  const mappedStatuses: ExecutionStatus[] = gatingStatuses.map((s) =>
    s === 'skipped' ? 'failed' : s,
  );

  const worst = aggregateStatus(mappedStatuses);
  return {
    status: worst,
    isPassing: false,
    evaluations,
  };
}

/** Check if a suite status is eligible for retry. */
export function isRetryable(status: ExecutionStatus): boolean {
  return status === 'error' || status === 'cancelled';
}

/** Check if a suite status means it does not need to run again. */
export function isCompleted(status: ExecutionStatus): boolean {
  return status === 'passed' || status === 'failed';
}
