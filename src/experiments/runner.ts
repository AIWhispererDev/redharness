/**
 * PRD 06: Experiment runner — evaluates candidate configurations
 * against a versioned dataset and produces comparisons.
 */

import type {
  Experiment,
  ExperimentRunResult,
  CandidateRunResult,
  RunComparison,
  MetricValue,
} from './experimentTypes.js';
import { compareRuns } from './comparison.js';
import type { ExecutionStatus } from '../core/status.js';

export type ExperimentRunnerOptions = {
  /** Function to run a suite and return results. */
  runSuite: (config: Experiment['candidates'][0], suiteId: string) => Promise<{
    status: ExecutionStatus;
    metrics: MetricValue[];
  }>;
  /** Available suite/scenario IDs. */
  suiteIds: string[];
};

/**
 * Run a full experiment across all candidates.
 */
export async function runExperiment(
  experiment: Experiment,
  options: ExperimentRunnerOptions,
): Promise<ExperimentRunResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Run baseline (if defined)
  let baselineResult: CandidateRunResult | undefined;
  if (experiment.baseline) {
    baselineResult = await runCandidate(experiment.baseline, 'baseline', options, experiment.trials);
  }

  // Run all candidates
  const candidateResults: CandidateRunResult[] = [];
  for (let i = 0; i < experiment.candidates.length; i++) {
    const candidate = experiment.candidates[i];
    const label = candidate.label ?? `candidate-${i}`;
    const result = await runCandidate(candidate, label, options, experiment.trials);
    candidateResults.push(result);
  }

  // Run comparisons
  const comparisons: RunComparison[] = [];
  if (baselineResult) {
    for (const candidate of candidateResults) {
      const comparison = compareRuns(baselineResult, candidate, {
        baselineLabel: 'baseline',
        candidateLabel: candidate.label,
      });
      comparisons.push(comparison);
    }
  }

  return {
    experimentId: experiment.experimentId,
    datasetId: experiment.datasetId,
    candidateResults,
    comparisons,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
  };
}

/**
 * Run a single candidate configuration across all suites.
 */
async function runCandidate(
  config: Experiment['candidates'][0],
  label: string,
  options: ExperimentRunnerOptions,
  trials: number,
): Promise<CandidateRunResult> {
  const runId = `exp-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const suiteResults: CandidateRunResult['suiteResults'] = [];

  for (const suiteId of options.suiteIds) {
    // Run each suite `trials` times and aggregate
    const trialResults: Array<{ status: ExecutionStatus; metrics: MetricValue[] }> = [];

    for (let t = 0; t < trials; t++) {
      const result = await options.runSuite(config, suiteId);
      trialResults.push(result);
    }

    // Aggregate: worst status, average metrics
    const worstStatus = trialResults.reduce<ExecutionStatus>((worst, r) => {
      const order: Record<ExecutionStatus, number> = {
        cancelled: 0, error: 1, failed: 2, skipped: 3, passed: 4,
      };
      return (order[r.status] ?? 4) < (order[worst] ?? 4) ? r.status : worst;
    }, 'passed');

    // Average numeric metrics
    const metricNames = [...new Set(trialResults.flatMap((r) => r.metrics.map((m) => m.name)))];
    const aggregatedMetrics: MetricValue[] = metricNames.map((name) => {
      const values = trialResults
        .flatMap((r) => r.metrics.filter((m) => m.name === name))
        .map((m) => m.value);
      const avg = values.length > 0
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
      return {
        name,
        value: avg,
        sampleSize: values.length,
      };
    });

    suiteResults.push({
      suiteId,
      scenarioId: suiteId,
      status: worstStatus,
      metrics: aggregatedMetrics,
      trialStatuses: trialResults.map((trial) => trial.status),
    });
  }

  return {
    label,
    config,
    runId,
    status: suiteResults.some((r) => r.status === 'failed' || r.status === 'error') ? 'failed' : 'passed',
    suiteResults,
  };
}
