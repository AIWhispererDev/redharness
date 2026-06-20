/**
 * PRD 06: JUnit XML report generator — converts run manifests into
 * JUnit XML format for CI integration (Jenkins, GitHub Actions, etc.).
 *
 * Maps: suites -> testsuites, scenarios/trials -> testcases
 * Status mapping: passed -> passed, failed -> failure, error -> error, skipped -> skipped
 */

import type { RunManifest, SuiteResultSummary } from '../core/runTypes.js';

export type JUnitReport = string; // XML string

/**
 * Generate JUnit XML from a run manifest.
 */
export function generateJUnitXml(manifest: RunManifest, runDir?: string): string {
  const lines: string[] = [];

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');

  const totalTests = manifest.suiteResults.length;
  const failures = manifest.suiteResults.filter((s) => s.status === 'failed').length;
  const errors = manifest.suiteResults.filter((s) => s.status === 'error').length;
  const skipped = manifest.suiteResults.filter((s) => s.status === 'skipped').length;
  const time = manifest.durationMs ? (manifest.durationMs / 1000).toFixed(3) : '0';

  lines.push(`<testsuites name="${escapeXml(manifest.packId)}" tests="${totalTests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">`);

  // Group suites by pack for the testsuite element
  lines.push(`  <testsuite name="${escapeXml(manifest.packId)}" tests="${totalTests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">`);

  // Properties element — goes inside <testsuite> per JUnit XSD
  lines.push(`    <properties>`);
  lines.push(`      <property name="runId" value="${escapeXml(manifest.runId)}" />`);
  lines.push(`      <property name="source" value="${escapeXml(manifest.source)}" />`);
  if (manifest.profile) {
    lines.push(`      <property name="profile" value="${escapeXml(manifest.profile)}" />`);
  }
  lines.push(`    </properties>`);

  for (const suite of manifest.suiteResults) {
    const suiteTime = suite.durationMs ? (suite.durationMs / 1000).toFixed(3) : '0';
    const testName = suite.title || suite.suiteId;

    switch (suite.status) {
      case 'passed':
        lines.push(`    <testcase name="${escapeXml(testName)}" classname="${escapeXml(suite.suiteId)}" time="${suiteTime}" />`);
        break;

      case 'failed':
        lines.push(`    <testcase name="${escapeXml(testName)}" classname="${escapeXml(suite.suiteId)}" time="${suiteTime}">`);
        lines.push(`      <failure message="${escapeXml(suite.error?.message ?? 'Suite failed')}">`);
        if (suite.error?.stack) {
          lines.push(escapeXml(suite.error.stack));
        }
        lines.push(`      </failure>`);
        lines.push(`    </testcase>`);
        break;

      case 'error':
        lines.push(`    <testcase name="${escapeXml(testName)}" classname="${escapeXml(suite.suiteId)}" time="${suiteTime}">`);
        lines.push(`      <error message="${escapeXml(suite.error?.message ?? 'Harness error')}">`);
        if (suite.error?.stack) {
          lines.push(escapeXml(suite.error.stack));
        }
        lines.push(`      </error>`);
        lines.push(`    </testcase>`);
        break;

      case 'skipped':
        lines.push(`    <testcase name="${escapeXml(testName)}" classname="${escapeXml(suite.suiteId)}" time="${suiteTime}">`);
        lines.push(`      <skipped message="${escapeXml(suite.skipReason ?? 'Skipped')}" />`);
        lines.push(`    </testcase>`);
        break;

      case 'cancelled':
        lines.push(`    <testcase name="${escapeXml(testName)}" classname="${escapeXml(suite.suiteId)}" time="${suiteTime}">`);
        lines.push(`      <failure message="Cancelled: ${escapeXml(suite.error?.message ?? 'Run cancelled')}" />`);
        lines.push(`    </testcase>`);
        break;
    }
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');

  return lines.join('\n');
}

/**
 * Escape special XML characters.
 */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
