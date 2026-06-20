import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export type RetentionCandidate = {
  path: string;
  ageDays: number;
  bytes: number;
};

export type RetentionResult = {
  dryRun: boolean;
  candidates: RetentionCandidate[];
  deleted: string[];
};

export async function applyRetention(options: {
  root: string;
  olderThanDays: number;
  dryRun?: boolean;
  now?: Date;
}): Promise<RetentionResult> {
  const root = path.resolve(options.root);
  const now = options.now?.getTime() ?? Date.now();
  const candidates: RetentionCandidate[] = [];
  const deleted: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.catalog') continue;
    const candidate = path.resolve(root, entry.name);
    assertContained(root, candidate);
    const info = await stat(candidate);
    const ageDays = (now - info.mtimeMs) / 86_400_000;
    if (ageDays < options.olderThanDays) continue;
    candidates.push({ path: candidate, ageDays, bytes: info.size });
  }

  if (!options.dryRun) {
    for (const candidate of candidates) {
      assertContained(root, candidate.path);
      await rm(candidate.path, { recursive: true, force: true });
      deleted.push(candidate.path);
    }
  }

  return { dryRun: options.dryRun ?? false, candidates, deleted };
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Retention path is outside the approved root: ${candidate}`);
  }
}
