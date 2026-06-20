import { readdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/** Per-category retention policy in days. */
export type RetentionPolicy = {
  /** Default run retention (applied to full run directories). */
  runDays: number;
  /** Trace retention (trace.zip, traces.jsonl). */
  traceDays: number;
  /** Video retention (video.webm). */
  videoDays: number;
  /** Finding retention (finding packets). */
  findingDays: number;
  /** Report retention (JUnit, SARIF, etc.). */
  reportDays: number;
  /** Catalog backup retention. */
  catalogBackupDays: number;
};

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  runDays: 90,
  traceDays: 30,
  videoDays: 14,
  findingDays: 180,
  reportDays: 60,
  catalogBackupDays: 7,
};

// ---------------------------------------------------------------------------
// Main retention logic
// ---------------------------------------------------------------------------

export type RetentionOptions = {
  root: string;
  olderThanDays: number;
  dryRun?: boolean;
  now?: Date;
  /** Named baselines to protect from deletion. */
  protectedBaselines?: string[];
  /** Per-category policy override. */
  policy?: Partial<RetentionPolicy>;
  /** Whether to use recursive pack/run discovery. */
  recursive?: boolean;
};

/**
 * Apply retention: discover run directories (flat or nested packs), filter
 * by age and eligibility, and delete candidates.
 *
 * Supports two layouts:
 *   runs/<run-id>/                              (flat — legacy/single-pack)
 *   runs/<pack-id>/<run-id>/                    (nested — multi-pack)
 *
 * Protected baselines, named release runs, and the most recent run per pack
 * are never deleted.
 */
export async function applyRetention(options: RetentionOptions): Promise<RetentionResult> {
  const root = path.resolve(options.root);
  const now = options.now?.getTime() ?? Date.now();
  const olderThanDays = options.olderThanDays;
  const protectedBaselines = new Set(options.protectedBaselines ?? []);
  const candidates: RetentionCandidate[] = [];
  const deleted: string[] = [];

  // Discover run directories (recursive if requested)
  const runDirs = await discoverRunDirs(root, options.recursive ?? true);

  // Group by pack for "most recent run" protection
  const runsByPack = new Map<string, Array<{ path: string; ageDays: number; bytes: number; runId: string }>>();

  for (const runDir of runDirs) {
    assertContained(root, runDir.path);

    // Skip protected baselines
    if (protectedBaselines.has(runDir.runId)) continue;

    const packId = runDir.packId;
    if (!runsByPack.has(packId)) runsByPack.set(packId, []);
    runsByPack.get(packId)!.push(runDir);
  }

  // For each pack, if there are runs, sort by age and skip the youngest
  const youngestPerPack = new Set<string>();
  for (const [, packRuns] of runsByPack) {
    if (packRuns.length <= 1) continue;
    packRuns.sort((a, b) => a.ageDays - b.ageDays);
    youngestPerPack.add(packRuns[0].path);
  }

  for (const runDir of runDirs) {
    assertContained(root, runDir.path);

    // Skip protected baselines
    if (protectedBaselines.has(runDir.runId)) continue;

    // Skip youngest per pack
    if (youngestPerPack.has(runDir.path)) continue;

    // Skip runs that are still young enough
    if (runDir.ageDays < olderThanDays) continue;

    candidates.push({
      path: runDir.path,
      ageDays: runDir.ageDays,
      bytes: runDir.bytes,
    });

    if (!options.dryRun) {
      assertContained(root, runDir.path);
      await rm(runDir.path, { recursive: true, force: true });
      deleted.push(runDir.path);
    }
  }

  return { dryRun: options.dryRun ?? false, candidates, deleted };
}

// ---------------------------------------------------------------------------
// Run directory discovery
// ---------------------------------------------------------------------------

type DiscoveredRun = {
  path: string;
  packId: string;
  runId: string;
  ageDays: number;
  bytes: number;
};

async function discoverRunDirs(
  root: string,
  recursive: boolean,
): Promise<DiscoveredRun[]> {
  const runs: DiscoveredRun[] = [];
  const now = Date.now();

  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.catalog') continue;
    const entryPath = path.resolve(root, entry.name);
    assertContained(root, entryPath);

    if (recursive) {
      // Try nested layout: runs/<pack>/<run>
      const subEntries = await readdir(entryPath, { withFileTypes: true }).catch(() => []);
      const runSubDirs = subEntries.filter((e) => e.isDirectory());

      if (runSubDirs.length > 0) {
        // This is a pack directory — recurse into run subdirectories
        for (const runSub of runSubDirs) {
          const runPath = path.resolve(entryPath, runSub.name);
          assertContained(root, runPath);
          const info = await stat(runPath).catch(() => null);
          if (!info) continue;
          runs.push({
            path: runPath,
            packId: entry.name,
            runId: runSub.name,
            ageDays: (now - info.mtimeMs) / 86_400_000,
            bytes: info.size,
          });
        }
        continue;
      }
    }

    // Flat layout: runs/<run-id>
    const info = await stat(entryPath).catch(() => null);
    if (!info) continue;

    // Try to read run.json for packId
    let packId = '_default';
    try {
      const runJsonPath = path.join(entryPath, 'run.json');
      const runJson = JSON.parse(await readFile(runJsonPath, 'utf8'));
      if (runJson.packId) packId = runJson.packId;
    } catch { /* no run.json */ }

    runs.push({
      path: entryPath,
      packId,
      runId: entry.name,
      ageDays: (now - info.mtimeMs) / 86_400_000,
      bytes: info.size,
    });
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Retention path is outside the approved root: ${candidate}`);
  }
}
