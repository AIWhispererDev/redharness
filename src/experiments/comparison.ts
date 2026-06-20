/**
 * PRD 06: Run comparison — pairwise comparison of baseline vs candidate
 * per scenario and metric.
 *
 * Reports: absolute metrics, candidate-baseline deltas, per-scenario
 * regressions/improvements, status transitions, and new/resolved findings.
 */

import type {
  RunComparison,
  ScenarioComparison,
  MetricDelta,
  MetricValue,
  CandidateRunResult,
  FindingRef,
} from './experimentTypes.js';
import type { ExecutionStatus } from '../core/status.js';

export type CompareOptions = {
  baselineLabel: string;
  candidateLabel: string;
  allowIncompatibleDatasets?: boolean;
};

/**
 * Compare two candidate run results.
 */
export function compareRuns(
  baseline: CandidateRunResult,
  candidate: CandidateRunResult,
  options: CompareOptions,
): RunComparison {
  const scenarioComparisons: ScenarioComparison[] = [];
  const aggregateDeltas: Record<string, number> = {};

  // Build maps by scenario id
  const baselineByScenario = new Map(
    baseline.suiteResults.map((r) => [r.scenarioId, r]),
  );
  const candidateByScenario = new Map(
    candidate.suiteResults.map((r) => [r.scenarioId, r]),
  );

  // All unique scenario ids
  const allScenarioIds = new Set([
    ...baselineByScenario.keys(),
    ...candidateByScenario.keys(),
  ]);

  for (const scenarioId of allScenarioIds) {
    const baselineResult = baselineByScenario.get(scenarioId);
    const candidateResult = candidateByScenario.get(scenarioId);

    if (!baselineResult || !candidateResult) {
      // If a baseline scenario is absent from the candidate, that is a
      // regression (the candidate silently dropped tested coverage).
      const isMissingFromCandidate = !!baselineResult && !candidateResult;
      const newFindings: FindingRef[] = [];
      const resolvedFindings: FindingRef[] = [];
      if (isMissingFromCandidate) {
        newFindings.push({
          id: `${candidate.runId}/${scenarioId}`,
          severity: 'high',
          title: `${scenarioId}: candidate silently dropped baseline scenario`,
        });
      }
      scenarioComparisons.push({
        scenarioId,
        scenarioTitle: scenarioId,
        baselineStatus: baselineResult?.status ?? 'skipped',
        candidateStatus: candidateResult?.status ?? 'skipped',
        statusChanged: baselineResult?.status !== candidateResult?.status,
        metrics: [],
        newFindings,
        resolvedFindings,
        regressed: isMissingFromCandidate,
        improved: false,
      });
      continue;
    }

    // Compare per-metric
    const metrics = compareMetrics(
      baselineResult.metrics,
      candidateResult.metrics,
    );

    // Track aggregate deltas
    for (const m of metrics) {
      const key = `${scenarioId}.${m.name}`;
      aggregateDeltas[key] = m.delta;
    }

    const statusChanged = baselineResult.status !== candidateResult.status;
    const regressed = metrics.some((m) => m.regressed) ||
      (statusChanged && candidateResult.status === 'failed');
    const improved = metrics.some((m) => m.improved) ||
      (statusChanged && candidateResult.status === 'passed' && baselineResult.status !== 'passed');

    // Compare explicit finding identities when runners provide them.
    const baselineFindings = new Map(
      (baselineResult.findings ?? []).map((finding) => [finding.id, finding]),
    );
    const candidateFindings = new Map(
      (candidateResult.findings ?? []).map((finding) => [finding.id, finding]),
    );
    const newFindings: FindingRef[] = [...candidateFindings.values()]
      .filter((finding) => !baselineFindings.has(finding.id));
    const resolvedFindings: FindingRef[] = [...baselineFindings.values()]
      .filter((finding) => !candidateFindings.has(finding.id));

    // Fall back to status transitions when no explicit finding was emitted:
    // - A scenario that passed baseline but failed candidate = new finding
    // - A scenario that failed baseline but passed candidate = resolved finding
    // - A scenario that was missing (silently dropped) = regressed
    if (
      newFindings.length === 0 &&
      baselineResult.status === 'passed' &&
      (candidateResult.status === 'failed' || candidateResult.status === 'error')
    ) {
      newFindings.push({
        id: `${candidate.runId}/${scenarioId}`,
        severity: 'high',
        title: `${scenarioId}: regressed from ${baselineResult.status} to ${candidateResult.status}`,
      });
    }
    if (
      resolvedFindings.length === 0 &&
      (baselineResult.status === 'failed' || baselineResult.status === 'error') &&
      candidateResult.status === 'passed'
    ) {
      resolvedFindings.push({
        id: `${baseline.runId}/${scenarioId}`,
        severity: 'high',
        title: `${scenarioId}: resolved from ${baselineResult.status} to ${candidateResult.status}`,
      });
    }
    // A missing-from-candidate scenario (handled above in the !baselineResult || !candidateResult
    // block) always generates a high finding. The missing-scenario case sets
    // regressed=true and adds a finding to newFindings below.

    scenarioComparisons.push({
      scenarioId,
      scenarioTitle: scenarioId,
      baselineStatus: baselineResult.status,
      candidateStatus: candidateResult.status,
      statusChanged,
      metrics,
      newFindings,
      resolvedFindings,
      regressed,
      improved,
    });
  }

  const overallRegressed = scenarioComparisons.some((s) => s.regressed);
  const overallImproved = scenarioComparisons.some((s) => s.improved);

  return {
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    datasetId: baseline.config.metadata?.datasetId as string ?? '',
    datasetVersion: baseline.config.metadata?.datasetVersion as string ?? '',
    baselineLabel: options.baselineLabel,
    candidateLabel: options.candidateLabel,
    scenarioComparisons,
    aggregateDeltas,
    overallRegressed,
    overallImproved,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Compare metric values between baseline and candidate.
 */
function compareMetrics(
  baseline: MetricValue[],
  candidate: MetricValue[],
): MetricDelta[] {
  const deltas: MetricDelta[] = [];
  const baselineMap = new Map(baseline.map((m) => [m.name, m]));
  const candidateMap = new Map(candidate.map((m) => [m.name, m]));

  const allNames = new Set([...baselineMap.keys(), ...candidateMap.keys()]);

  for (const name of allNames) {
    const b = baselineMap.get(name);
    const c = candidateMap.get(name);

    if (!b) {
      deltas.push({
        name,
        baselineValue: 0,
        candidateValue: c?.value ?? 0,
        delta: c?.value ?? 0,
        deltaPercent: 0,
        regressed: false,
        improved: true,
      });
      continue;
    }

    if (!c) {
      deltas.push({
        name,
        baselineValue: b.value,
        candidateValue: 0,
        delta: -b.value,
        deltaPercent: -100,
        regressed: true,
        improved: false,
      });
      continue;
    }

    const delta = c.value - b.value;
    const deltaPercent = b.value !== 0 ? (delta / Math.abs(b.value)) * 100 : 0;

    // Determine if regression (lower is worse for success metrics)
    const isSuccessMetric = name.toLowerCase().includes('success') ||
      name.toLowerCase().includes('rate') ||
      name.toLowerCase().includes('pass');
    const regressed = isSuccessMetric ? delta < 0 : delta > 0;
    const improved = isSuccessMetric ? delta > 0 : delta < 0;

    deltas.push({
      name,
      baselineValue: b.value,
      candidateValue: c.value,
      delta,
      deltaPercent,
      regressed,
      improved,
    });
  }

  return deltas;
}

/**
 * Format a comparison as a readable summary.
 */
export function formatComparisonSummary(comparison: RunComparison): string {
  const lines: string[] = [];
  lines.push(`# Run Comparison: ${comparison.baselineLabel} → ${comparison.candidateLabel}`);
  lines.push('');
  lines.push(`Baseline run: ${comparison.baselineRunId}`);
  lines.push(`Candidate run: ${comparison.candidateRunId}`);
  lines.push(`Dataset: ${comparison.datasetId} (${comparison.datasetVersion})`);
  lines.push('');

  const regressed = comparison.scenarioComparisons.filter((s) => s.regressed);
  const improved = comparison.scenarioComparisons.filter((s) => s.improved);

  lines.push(`## Summary`);
  lines.push(`- Scenarios compared: ${comparison.scenarioComparisons.length}`);
  lines.push(`- Regressed: ${regressed.length}`);
  lines.push(`- Improved: ${improved.length}`);
  lines.push(`- Overall: ${comparison.overallRegressed ? 'REGRESSION DETECTED' : comparison.overallImproved ? 'IMPROVED' : 'No change'}`);
  lines.push('');

  if (regressed.length > 0) {
    lines.push(`## Regressions`);
    for (const s of regressed) {
      lines.push(`- ${s.scenarioTitle} (${s.scenarioId})`);
      for (const m of s.metrics) {
        if (m.regressed) {
          lines.push(`  - ${m.name}: ${m.baselineValue} → ${m.candidateValue} (${m.deltaPercent > 0 ? '+' : ''}${m.deltaPercent.toFixed(1)}%)`);
        }
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
