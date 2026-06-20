/**
 * PRD 06: GitHub CI output helpers — produces GitHub-specific output
 * formats including step summaries, annotations, and exit codes.
 */

import type { RunManifest, SuiteResultSummary } from '../core/runTypes.js';

export type GitHubStepSummary = string; // Markdown

/**
 * Generate a GitHub Actions step summary markdown from a run manifest.
 */
export function generateGitHubStepSummary(manifest: RunManifest): string {
  const lines: string[] = [];

  lines.push(`## QA Harness Run: ${manifest.packId}`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Run ID | \`${manifest.runId}\` |`);
  lines.push(`| Status | ${statusBadge(manifest.status)} |`);
  lines.push(`| Profile | ${manifest.profile ?? '(none)'} |`);
  lines.push(`| Source | ${manifest.source} |`);
  lines.push(`| Duration | ${manifest.durationMs ? `${(manifest.durationMs / 1000).toFixed(1)}s` : 'N/A'} |`);
  lines.push(`| Suites | ${manifest.suiteResults.length} |`);
  lines.push('');

  // Per-suite breakdown
  lines.push('### Suite Results');
  lines.push('');
  lines.push('| Suite | Status | Duration | Attempts |');
  lines.push('|-------|--------|----------|----------|');

  for (const suite of manifest.suiteResults) {
    const duration = suite.durationMs ? `${(suite.durationMs / 1000).toFixed(1)}s` : 'N/A';
    lines.push(`| ${suite.title || suite.suiteId} | ${statusBadge(suite.status)} | ${duration} | ${suite.attemptCount} |`);
  }

  lines.push('');

  // Failures
  const failures = manifest.suiteResults.filter(
    (s) => s.status === 'failed' || s.status === 'error',
  );
  if (failures.length > 0) {
    lines.push('### Failures');
    lines.push('');
    for (const f of failures) {
      lines.push(`- **${f.title || f.suiteId}** (${f.status})`);
      if (f.error?.message) {
        lines.push(`  - ${f.error.message}`);
      }
    }
    lines.push('');
  }

  // CI summary for GitHub
  if (process.env.GITHUB_STEP_SUMMARY) {
    lines.push(`_Full manifest: run.json_\n`);
  }

  return lines.join('\n');
}

/**
 * Generate GitHub Actions annotation commands for failures.
 */
export function generateGitHubAnnotations(
  manifest: RunManifest,
): string[] {
  const annotations: string[] = [];

  for (const suite of manifest.suiteResults) {
    if (suite.status === 'failed' || suite.status === 'error') {
      const level = suite.status === 'error' ? 'error' : 'warning';
      const title = suite.title || suite.suiteId;
      const message = suite.error?.message ?? `${title} ${suite.status}`;

      annotations.push(
        `::${level} title=QA Harness/${title}::${escapeMessage(message)}`,
      );
    }
  }

  return annotations;
}

/**
 * Generate the appropriate exit code for CI.
 */
export function getCiExitCode(manifest: RunManifest): number {
  return manifest.status === 'passed' ? 0 : 1;
}

/**
 * Status badge in GitHub-flavored markdown.
 */
function statusBadge(status: string): string {
  const colors: Record<string, string> = {
    passed: 'success',
    failed: 'critical',
    error: 'critical',
    skipped: 'notice',
    cancelled: 'notice',
  };
  const color = colors[status] ?? 'notice';
  return `![${status}](https://img.shields.io/badge/${status}-${color})`;
}

/**
 * Escape message for GitHub :: annotations.
 */
function escapeMessage(msg: string): string {
  return msg.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
