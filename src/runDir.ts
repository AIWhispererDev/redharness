import path from 'node:path';
import type { RunSection } from './runSummary.js';
import type { RunManifest, SuiteResultSummary } from './core/runTypes.js';
import { statusLabel } from './core/status.js';
import { evaluateRunPolicy } from './core/resultPolicy.js';

export function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function resolveRunDir(options: {
  packId: string;
  outputDir: string;
  runDir?: string;
  now?: Date;
  cwd?: string;
}): string {
  const cwd = options.cwd ?? process.cwd();
  // Preserve the path flavor supplied by callers. This keeps CI-generated
  // POSIX paths stable even when validation runs on a Windows host.
  const resolveFromCwd = (...segments: string[]) =>
    cwd.startsWith('/')
      ? path.posix.resolve(cwd, ...segments)
      : path.resolve(cwd, ...segments);
  if (options.runDir === 'auto') {
    return resolveFromCwd('runs', options.packId, timestampForPath(options.now));
  }
  if (options.runDir) {
    return resolveFromCwd(options.runDir);
  }
  return resolveFromCwd(options.outputDir);
}

/** Render a compact CI summary from a RunManifest. */
export function renderCompactRunSummary(
  packName: string,
  sections: RunSection[],
  outputDir: string,
): string {
  const ok = sections.every((section) => section.ok);
  const passed = sections.filter((section) => section.ok).length;
  const lines = [`${packName}: ${ok ? 'passed' : 'failed'}`, `${passed}/${sections.length} sections passed`, `Output: ${outputDir}`, ''];
  for (const section of sections) {
    const status = section.status ? ` [${statusLabel(section.status)}]` : '';
    lines.push(`${section.ok ? '✅' : '❌'} ${section.name}${status}`);
  }
  return lines.join('\n');
}

/** Render a compact summary from a RunManifest directly. Uses policy evaluation for overall result. */
export function renderCompactManifestSummary(manifest: RunManifest, packName: string, runDir: string): string {
  const policy = evaluateRunPolicy(manifest.suiteResults);
  const lines = [
    `${packName}: ${policy.isPassing ? 'passed' : 'failed'}`,
    `Run ID: ${manifest.runId}`,
    `Status: ${statusLabel(manifest.status)}`,
    `Profile: ${manifest.profile ?? 'none'}`,
    `Suites: ${manifest.suiteResults.length}`,
    `Duration: ${manifest.durationMs ? `${(manifest.durationMs / 1000).toFixed(1)}s` : 'N/A'}`,
    `Output: ${runDir}`,
    '',
  ];
  for (const sr of manifest.suiteResults) {
    const icon = sr.status === 'passed' ? '✅' : sr.status === 'skipped' ? '⚠️' : '❌';
    lines.push(`${icon} ${sr.title || sr.suiteId} [${statusLabel(sr.status)}]${sr.skipReason ? ` — ${sr.skipReason}` : ''}`);
  }
  return lines.join('\n');
}
