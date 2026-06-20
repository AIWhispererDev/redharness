import { aggregateStatus, statusLabel, statusToOk } from './core/status.js';
import type { ExecutionStatus } from './types.js';

export type RunSection = {
  name: string;
  ok: boolean;
  status?: ExecutionStatus;
  markdown: string;
  artifacts?: string[];
  requirement?: string;
  skipReason?: string;
  durationMs?: number;
};

export type RunSummaryJson = {
  packName: string;
  ok: boolean;
  status: ExecutionStatus;
  generatedAt: string;
  sections: Array<{
    name: string;
    status: ExecutionStatus;
    ok: boolean;
    requirement?: string;
    skipReason?: string;
    durationMs?: number;
    artifacts: string[];
  }>;
};

export function buildRunSummaryJson(
  packName: string,
  sections: RunSection[],
  generatedAt = new Date().toISOString(),
): RunSummaryJson {
  const statuses = sections.map((s) => s.status ?? (s.ok ? 'passed' : 'failed'));
  const aggStatus = aggregateStatus(statuses);
  return {
    packName,
    ok: statusToOk(aggStatus),
    status: aggStatus,
    generatedAt,
    sections: sections.map((section) => ({
      name: section.name,
      status: section.status ?? (section.ok ? 'passed' : 'failed'),
      ok: section.ok,
      requirement: section.requirement,
      skipReason: section.skipReason,
      durationMs: section.durationMs,
      artifacts: section.artifacts ?? [],
    })),
  };
}

export function renderRunSummary(packName: string, sections: RunSection[]): string {
  const statuses = sections.map((s) => s.status ?? (s.ok ? 'passed' : 'failed'));
  const aggStatus = aggregateStatus(statuses);
  const passed = sections.filter((s) => s.ok).length;
  const failedCount = sections.filter((s) => !s.ok).length;
  const lines = [
    `# ${packName} QA run summary`,
    '',
    `Overall: ${statusLabel(aggStatus)}`,
    `Summary: ${passed} passed, ${failedCount} failed${sections.length > 0 ? ` (${sections.length} total)` : ''}`,
    '',
    '## Sections',
    '',
  ];

  for (const section of sections) {
    const icon = section.ok ? '✅' : '❌';
    const status = section.status ? ` [${statusLabel(section.status)}]` : '';
    const dur = section.durationMs ? ` (${(section.durationMs / 1000).toFixed(1)}s)` : '';
    const reason = section.skipReason ? ` — ${section.skipReason}` : '';
    lines.push(`- ${icon} ${section.name}${status}${dur}${reason}`);
  }
  lines.push('');

  for (const section of sections) {
    lines.push('---', '', section.markdown, '');
  }

  return lines.join('\n');
}
