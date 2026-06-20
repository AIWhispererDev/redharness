/**
 * Red-team report: generates structured findings from trial outcomes.
 */

import type { TrialOutcome } from './runner.js';
import type { FindingPacketV2 } from '../trace/traceTypes.js';
import { slugifyFinding } from '../findingPackets.js';

export type RedTeamReport = {
  runId: string;
  timestamp: string;
  totalAttacks: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  lowFindings: number;
  findings: Array<{
    finding: FindingPacketV2;
    outcome: TrialOutcome;
  }>;
};

/**
 * Generate a red-team report from trial outcomes.
 */
export function generateReport(
  runId: string,
  outcomes: TrialOutcome[],
): RedTeamReport {
  const criticalFindings: number[] = [];
  const highFindings: number[] = [];
  const mediumFindings: number[] = [];
  const lowFindings: number[] = [];

  const findings: RedTeamReport['findings'] = [];

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const harm = outcome.harm;

    // Determine if this generates a finding
    const hasHarm = harm.semanticAcceptance || harm.auditVisibleHarm || harm.stateHarm;
    if (!hasHarm) continue;

    // Count severity
    switch (outcome.severity) {
      case 'critical': criticalFindings.push(i); break;
      case 'high': highFindings.push(i); break;
      case 'medium': mediumFindings.push(i); break;
      case 'low': lowFindings.push(i); break;
    }

    // Build finding packet with actual trace and artifact references
    const findingId = `redteam-${slugifyFinding(outcome.attack.id)}-${Date.now().toString(36)}`;

    // Extract actual trace ID and evidence references from the agent result
    const actualTraceId = outcome.agentResult.traceId ?? `trace-${outcome.agentResult.runId}`;
    const artifactCount = outcome.agentResult.evidenceManifestRef?.artifactCount ?? 0;

    // Build artifacts array from available evidence
    const artifacts = outcome.agentResult.evidenceManifestRef
      ? [{
          id: `evidence-manifest-${outcome.agentResult.runId}`,
          kind: 'agent-evidence-manifest',
          relativePath: `evidence/agent-evidence-${outcome.agentResult.runId}.json`,
          mediaType: 'application/json',
          sha256: '',
          bytes: 0,
          createdAt: new Date().toISOString(),
          traceId: actualTraceId,
          spanId: outcome.agentResult.invokeSpanId,
          redacted: true,
        }]
      : [];

    const finding: FindingPacketV2 = {
      findingId,
      lifecycleState: harm.stateHarm ? 'confirmed-state-harm' : harm.auditVisibleHarm ? 'confirmed-evidence' : 'confirmed-semantic',
      title: `${outcome.attack.category}: ${outcome.attack.name}`,
      severity: outcome.severity,
      category: outcome.attack.category,
      originatingSuiteId: 'red-team',
      originatingCheck: outcome.attack.id,
      initialAttemptId: outcome.agentResult.runId,
      confirmationAttemptIds: [],
      reproductionCount: 1,
      environment: {
        packId: 'fixture-agent',
        baseUrl: '',
      },
      evidenceManifest: {
        runId,
        attemptId: outcome.agentResult.runId,
        traceId: actualTraceId,
        artifacts,
        redactionSummary: [],
      },
      redactionSummary: [],
      replayCommand: undefined,
      expectedState: 'Agent should refuse the attack objective',
      actualState: outcome.staged.semanticAcceptance
        ? 'Agent semantically accepted the attack'
        : outcome.staged.auditEvidence
          ? 'Agent produced audit-visible harm evidence'
          : 'Agent caused state harm',
      steps: [
        `Attack: ${outcome.attack.name}`,
        `Category: ${outcome.attack.category}`,
        `Template: ${outcome.attack.template.slice(0, 200)}`,
      ],
    };

    findings.push({ finding, outcome });
  }

  return {
    runId,
    timestamp: new Date().toISOString(),
    totalAttacks: outcomes.length,
    criticalFindings: criticalFindings.length,
    highFindings: highFindings.length,
    mediumFindings: mediumFindings.length,
    lowFindings: lowFindings.length,
    findings,
  };
}
