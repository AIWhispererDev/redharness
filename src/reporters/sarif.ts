/**
 * PRD 06: SARIF (Static Analysis Results Interchange Format) report generator.
 *
 * Converts security findings and suite failures into SARIF 2.1 format
 * for GitHub Advanced Security, Azure DevOps, and other SARIF consumers.
 */

import type { RunManifest, SuiteResultSummary } from '../core/runTypes.js';

export type SarifReport = {
  $schema: string;
  version: string;
  runs: SarifRun[];
};

type SarifRun = {
  tool: {
    driver: {
      name: string;
      version: string;
      informationUri?: string;
      rules: SarifRule[];
    };
  };
  results: SarifResult[];
  invocations: SarifInvocation[];
  artifacts?: SarifArtifact[];
};

type SarifRule = {
  id: string;
  name: string;
  shortDescription: { text: string };
  fullDescription?: { text: string };
  defaultConfiguration?: { level: string };
  properties?: Record<string, unknown>;
};

type SarifResult = {
  ruleId: string;
  ruleIndex: number;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
  properties?: Record<string, unknown>;
};

type SarifLocation = {
  physicalLocation?: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
};

type SarifInvocation = {
  executionSuccessful: boolean;
  startTimeUtc?: string;
  endTimeUtc?: string;
};

type SarifArtifact = {
  location: { uri: string };
  description?: { text: string };
};

/**
 * Generate SARIF report from a run manifest.
 * Maps suite failures to SARIF results.
 */
export function generateSarifReport(
  manifest: RunManifest,
  runDir?: string,
  findings?: Array<{ ruleId: string; label: string; severity: string; description: string }>,
): SarifReport {
  const rules: SarifRule[] = [];
  const results: SarifResult[] = [];
  let ruleIndex = 0;

  // Create rules from findings
  if (findings) {
    for (const finding of findings) {
      const level = mapSeverityToLevel(finding.severity);
      rules.push({
        id: finding.ruleId,
        name: finding.label,
        shortDescription: { text: finding.description.slice(0, 200) },
        fullDescription: { text: finding.description },
        defaultConfiguration: { level },
        properties: { severity: finding.severity },
      });

      results.push({
        ruleId: finding.ruleId,
        ruleIndex,
        level,
        message: { text: finding.description },
        locations: runDir ? [{
          physicalLocation: {
            artifactLocation: { uri: runDir },
          },
        }] : [],
        properties: { findingLabel: finding.label },
      });

      ruleIndex++;
    }
  }

  // Create rules from suite failures
  for (const suite of manifest.suiteResults) {
    if (suite.status === 'failed' || suite.status === 'error') {
      const ruleId = `QA/${suite.suiteId}`;
      const level = suite.status === 'error' ? 'error' : 'warning';

      // Avoid duplicate rules
      if (!rules.find((r) => r.id === ruleId)) {
        rules.push({
          id: ruleId,
          name: suite.title || suite.suiteId,
          shortDescription: { text: `${suite.title || suite.suiteId} ${suite.status}` },
          defaultConfiguration: { level },
        });
      }

      const ruleIdx = rules.findIndex((r) => r.id === ruleId);

      results.push({
        ruleId,
        ruleIndex: ruleIdx >= 0 ? ruleIdx : 0,
        level,
        message: {
          text: suite.error?.message ?? `${suite.title || suite.suiteId} ${suite.status}`,
        },
        locations: runDir ? [{
          physicalLocation: {
            artifactLocation: { uri: `${runDir}/suites/${suite.suiteId}/summary.json` },
          },
        }] : [],
        properties: {
          suiteId: suite.suiteId,
          attemptCount: suite.attemptCount,
          durationMs: suite.durationMs,
        },
      });
    }
  }

  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: {
        driver: {
          name: 'qa-harness',
          version: '1.0.0',
          rules,
        },
      },
      results,
      invocations: [{
        executionSuccessful: manifest.status === 'passed',
        startTimeUtc: manifest.startedAt,
        endTimeUtc: manifest.endedAt,
      }],
    }],
  };
}

/**
 * Mapqa-harness severity to SARIF levels.
 */
function mapSeverityToLevel(severity: string): string {
  switch (severity.toLowerCase()) {
    case 'critical':
    case 'high':
    case 'blocker':
      return 'error';
    case 'medium':
    case 'major':
      return 'warning';
    case 'low':
    case 'minor':
    case 'polish':
      return 'note';
    default:
      return 'warning';
  }
}
