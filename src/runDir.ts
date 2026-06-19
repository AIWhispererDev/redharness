import path from 'node:path';
import type { RunSection } from './runSummary.js';

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
  if (options.runDir === 'auto') {
    return path.resolve(cwd, 'runs', options.packId, timestampForPath(options.now));
  }
  if (options.runDir) {
    return path.resolve(cwd, options.runDir);
  }
  return path.resolve(cwd, options.outputDir);
}

export function renderCompactRunSummary(packName: string, sections: RunSection[], outputDir: string): string {
  const ok = sections.every((section) => section.ok);
  const passed = sections.filter((section) => section.ok).length;
  const lines = [`${packName}: ${ok ? 'passed' : 'failed'}`, `${passed}/${sections.length} sections passed`, `Output: ${outputDir}`, ''];
  for (const section of sections) lines.push(`${section.ok ? '✅' : '❌'} ${section.name}`);
  return lines.join('\n');
}
