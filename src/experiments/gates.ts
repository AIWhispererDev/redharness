/**
 * PRD 06: Regression gates — enforce quality thresholds before
 * allowing a candidate configuration to pass CI.
 *
 * Each gate evaluates a specific constraint and produces a pass/fail
 * result with explanation.
 */

import type { RegressionGate, GateSuiteResult, GateResult, RunComparison, MetricDelta, CandidateRunResult } from './experimentTypes.js';

/**
 * Evaluate all regression gates against a run comparison.
 */
export function evaluateGates(
  comparison: RunComparison,
  gate: RegressionGate,
  candidateResult: CandidateRunResult,
): GateSuiteResult {
  const gates: GateResult[] = [];

  // Required scenario failures
  gates.push(evaluateScenarioFailureGate(comparison, gate));
  gates.push(evaluateNewFindingsGate(comparison, gate));
  gates.push(evaluateSuccessRateGate(comparison, gate));
  gates.push(evaluateLatencyGate(comparison, gate));

  if (gate.minPassK) {
    gates.push(evaluatePassKGate(candidateResult, gate.minPassK));
  }

  if (gate.requiredCoverage) {
    gates.push(evaluateCoverageGate(candidateResult, gate.requiredCoverage));
  }

  return {
    passed: gates.every((g) => g.passed),
    gates,
  };
}

/**
 * Gate: No required scenario failures allowed.
 */
function evaluateScenarioFailureGate(
  comparison: RunComparison,
  gate: RegressionGate,
): GateResult {
  const failures = comparison.scenarioComparisons.filter(
    (s) => s.candidateStatus === 'failed' || s.candidateStatus === 'error',
  );

  const passed = failures.length <= gate.requiredScenarioFailures;
  return {
    passed,
    gateName: 'required-scenario-failures',
    expected: `≤ ${gate.requiredScenarioFailures} failures`,
    actual: `${failures.length} failures`,
    details: failures.length > 0
      ? `Suites with failures: ${failures.map((f) => f.scenarioId).join(', ')}`
      : 'No scenario failures',
  };
}

/**
 * Gate: Max new high/medium findings.
 * Counts actual finding instances, not scenarios containing findings.
 */
function evaluateNewFindingsGate(
  comparison: RunComparison,
  gate: RegressionGate,
): GateResult {
  let newHigh = 0;
  let newMedium = 0;
  for (const s of comparison.scenarioComparisons) {
    for (const f of s.newFindings) {
      if (f.severity === 'high') newHigh++;
      else if (f.severity === 'medium') newMedium++;
    }
  }

  const highPassed = newHigh <= gate.maxNewHighFindings;
  const mediumPassed = newMedium <= gate.maxNewMediumFindings;

  return {
    passed: highPassed && mediumPassed,
    gateName: 'new-findings',
    expected: `High ≤ ${gate.maxNewHighFindings}, Medium ≤ ${gate.maxNewMediumFindings}`,
    actual: `High: ${newHigh}, Medium: ${newMedium}`,
    details: !highPassed
      ? `Too many new high-severity findings: ${newHigh}`
      : !mediumPassed
        ? `Too many new medium-severity findings: ${newMedium}`
        : 'No excessive new findings',
  };
}

/**
 * Gate: Minimum success rate delta.
 */
function evaluateSuccessRateGate(
  comparison: RunComparison,
  gate: RegressionGate,
): GateResult {
  // Compute overall success rates
  const baselineSuccesses = comparison.scenarioComparisons.filter(
    (s) => s.baselineStatus === 'passed',
  ).length;
  const candidateSuccesses = comparison.scenarioComparisons.filter(
    (s) => s.candidateStatus === 'passed',
  ).length;
  const total = comparison.scenarioComparisons.length || 1;

  const baselineRate = baselineSuccesses / total;
  const candidateRate = candidateSuccesses / total;
  const delta = candidateRate - baselineRate;

  const passed = delta >= gate.minSuccessRateDelta;
  return {
    passed,
    gateName: 'success-rate-delta',
    expected: `Δ ≥ ${gate.minSuccessRateDelta}`,
    actual: `Δ = ${delta.toFixed(3)} (${(baselineRate * 100).toFixed(1)}% → ${(candidateRate * 100).toFixed(1)}%)`,
    details: !passed
      ? `Success rate dropped by ${(Math.abs(delta) * 100).toFixed(1)}% (exceeds max decline of ${(Math.abs(gate.minSuccessRateDelta) * 100).toFixed(1)}%)`
      : 'Success rate maintained',
  };
}

/**
 * Gate: Max P95 latency increase.
 */
function evaluateLatencyGate(
  comparison: RunComparison,
  gate: RegressionGate,
): GateResult {
  const latencyDeltas = comparison.scenarioComparisons
    .flatMap((s) => s.metrics)
    .filter((m) => m.name.toLowerCase().includes('latency') || m.name.toLowerCase().includes('duration'));

  if (latencyDeltas.length === 0) {
    return {
      passed: true,
      gateName: 'latency-delta',
      expected: `Δ ≤ ${gate.maxP95LatencyDelta}`,
      actual: 'No latency metrics available',
      details: 'No latency data to evaluate',
    };
  }

  const maxDelta = Math.max(...latencyDeltas.map((m) => Math.abs(m.deltaPercent)));
  const passed = maxDelta <= gate.maxP95LatencyDelta * 100; // Convert to percent

  return {
    passed,
    gateName: 'latency-delta',
    expected: `Max Δ ≤ ${(gate.maxP95LatencyDelta * 100).toFixed(0)}%`,
    actual: `Max Δ = ${maxDelta.toFixed(1)}%`,
    details: !passed
      ? `Latency increased beyond threshold: ${maxDelta.toFixed(1)}%`
      : 'Latency within bounds',
  };
}

/**
 * Gate: Pass@K minimum success rate.
 */
function evaluatePassKGate(
  result: CandidateRunResult,
  gate: { k: number; value: number },
): GateResult {
  const repeated = result.suiteResults.filter(
    (r) => (r.trialStatuses?.length ?? 0) > 0,
  );
  const successRate = repeated.length > 0
    ? repeated.filter((r) => {
        const trials = r.trialStatuses ?? [];
        return trials.slice(0, gate.k).some((status) => status === 'passed');
      }).length / repeated.length
    : result.suiteResults.filter((r) => r.status === 'passed').length /
      (result.suiteResults.length || 1);

  const passed = successRate >= gate.value;
  return {
    passed,
    gateName: `pass-k-${gate.k}`,
    expected: `≥ ${(gate.value * 100).toFixed(0)}%`,
    actual: `${(successRate * 100).toFixed(1)}%`,
    details: !passed
      ? `Pass@${gate.k} rate ${(successRate * 100).toFixed(1)}% below threshold ${(gate.value * 100).toFixed(0)}%`
      : 'Pass@K within threshold',
  };
}

/**
 * Gate: Required coverage for specific tags.
 */
function evaluateCoverageGate(
  result: CandidateRunResult,
  requiredCoverage: Record<string, number>,
): GateResult {
  const failures: string[] = [];

  for (const [tag, required] of Object.entries(requiredCoverage)) {
    const tagged = result.suiteResults.filter((r) =>
      (r.tags ?? []).some((value) => value.toLowerCase() === tag.toLowerCase()),
    );
    const covered = tagged.filter((r) => r.status !== 'skipped');
    const rate = tagged.length > 0 ? covered.length / tagged.length : 0;

    if (rate < required) {
      failures.push(`${tag}: ${(rate * 100).toFixed(0)}% < ${(required * 100).toFixed(0)}%`);
    }
  }

  return {
    passed: failures.length === 0,
    gateName: 'required-coverage',
    expected: 'All required coverage met',
    actual: failures.length > 0 ? failures.join('; ') : 'All coverage met',
    details: failures.length > 0
      ? `Coverage gaps: ${failures.join('; ')}`
      : 'All required coverage satisfied',
  };
}
