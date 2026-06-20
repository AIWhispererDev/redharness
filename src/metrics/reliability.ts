/**
 * PRD 03: Reliability metrics for multi-trial evaluations.
 *
 * Reports: success rate, pass@1, pass^k, latency percentiles,
 * tool-call counts, Wilson confidence interval.
 */

export type ReliabilityReport = {
  attemptedTrials: number;
  completedTrials: number;
  successCount: number;
  successRate: number;
  passAt1: number;
  passAtK: number; // pass^k: probability all k trials succeed
  k: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  wilsonLower: number;
  wilsonUpper: number;
};

/** Compute reliability metrics from trial latencies and statuses. */
export function computeReliability(
  trialStatuses: Array<'passed' | 'failed' | 'error' | 'cancelled'>,
  trialLatenciesMs: number[],
  k: number = 3,
): ReliabilityReport {
  const n = trialStatuses.length;
  const successes = trialStatuses.filter((s) => s === 'passed').length;
  const completed = trialStatuses.filter((s) => s === 'passed' || s === 'failed').length;

  const successRate = n > 0 ? successes / n : 0;
  const sortedLatencies = [...trialLatenciesMs].sort((a, b) => a - b);

  // pass@1 = success rate
  const passAt1 = successRate;

  // pass^k = probability that all k consecutive trials succeed
  const passAtK = Math.pow(successRate, k);

  // Percentiles (only for completed trials)
  const completedLatencies = trialLatenciesMs.slice(0, completed);
  const sortedCompleted = [...completedLatencies].sort((a, b) => a - b);
  const medianLatencyMs = sortedCompleted.length > 0 ? percentile(sortedCompleted, 50) : 0;
  const p95LatencyMs = sortedCompleted.length > 0 ? percentile(sortedCompleted, 95) : 0;

  // Wilson confidence interval for binomial proportion
  const z = 1.96; // 95% confidence
  const { lower, upper } = wilsonScore(successes, n, z);

  return {
    attemptedTrials: n,
    completedTrials: completed,
    successCount: successes,
    successRate,
    passAt1,
    passAtK,
    k,
    medianLatencyMs,
    p95LatencyMs,
    wilsonLower: lower,
    wilsonUpper: upper,
  };
}

/** Compute the p-th percentile from a sorted array. */
function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

/** Wilson score interval for binomial proportion. */
function wilsonScore(successes: number, n: number, z: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const denominator = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / denominator;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denominator;
  return {
    lower: Math.max(0, centre - margin),
    upper: Math.min(1, centre + margin),
  };
}
