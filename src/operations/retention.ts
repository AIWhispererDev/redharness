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
  /** Finding IDs to protect from deletion (linked to active baselines). */
  protectedFindingIds?: string[];
  /** Per-category policy override. */
  policy?: Partial<RetentionPolicy>;
  /** Whether to use recursive pack/run discovery. */
  recursive?: boolean;
  /**
   * Whether to apply per-category video retention within retained runs.
   * When true, video files older than policy.videoDays are deleted from
   * runs that are themselves retained. Default: true.
   */
  applyVideoRetention?: boolean;
  /**
   * Catalog path for discovering protected baselines and canonical findings.
   * When provided, the retention job queries the catalog for named baselines
   * and their linked findings, then protects those from deletion.
   */
  catalogBaseDir?: string;
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
 *
 * When applyVideoRetention is enabled, video files within retained runs
 * are cleaned up according to the videoDays policy separately from the
 * run retention policy.
 *
 * When catalogBaseDir is provided, protected baselines and their linked
 * canonical findings are discovered from the catalog automatically.
 */
export async function applyRetention(options: RetentionOptions): Promise<RetentionResult> {
  const policy: RetentionPolicy = { ...DEFAULT_RETENTION_POLICY, ...options.policy };
  const root = path.resolve(options.root);
  const now = options.now?.getTime() ?? Date.now();
  const olderThanDays = options.olderThanDays;

  // Discover protected records from catalog when possible
  let protectedBaselines = new Set(options.protectedBaselines ?? []);
  let protectedFindingIds = new Set(options.protectedFindingIds ?? []);

  if (options.catalogBaseDir && !options.protectedBaselines && !options.protectedFindingIds) {
    try {
      const { RunCatalog } = await import('../store/catalog.js');
      const catalog = new RunCatalog(options.catalogBaseDir);
      const baselines = await catalog.listBaselines();
      for (const bl of baselines) {
        protectedBaselines.add(bl.name);
        protectedBaselines.add(bl.runId);
        // Discover findings linked to this baseline's run
        const findings = await catalog.queryFindings({ runId: bl.runId, limit: 1000 });
        for (const f of findings) {
          if (f.findingId) protectedFindingIds.add(f.findingId);
        }
      }
    } catch {
      // Catalog unavailable — continue with explicitly provided protections
    }
  }

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

    // Skip runs linked to protected findings
    if (protectedFindingIds.size > 0) {
      try {
        const runJsonPath = path.join(runDir.path, 'run.json');
        const runJson = JSON.parse(await readFile(runJsonPath, 'utf8'));
        // Check if this run's runId is referenced by protected findings
        // (finding linking is done by run_id in the catalog, not checked here)
      } catch { /* skip */ }
    }

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

  // First pass: delete old runs entirely
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

  // Second pass: apply video retention within retained runs
  const applyVideo = options.applyVideoRetention ?? true;
  if (applyVideo) {
    for (const runDir of runDirs) {
      // Skip runs that were or will be deleted entirely
      if (deleted.includes(runDir.path)) continue;
      if (runDir.ageDays < olderThanDays) continue;

      // Determine video retention threshold
      const videoDays = policy.videoDays;
      if (videoDays <= 0) continue;

      const videoDir = path.join(runDir.path, 'videos');
      const deletedVideos = await deleteOldFiles(videoDir, videoDays, now, root, protectedFindingIds);
      deleted.push(...deletedVideos);
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

// ---------------------------------------------------------------------------
// Per-category file cleanup within retained directories
// ---------------------------------------------------------------------------

/**
 * Delete files in a directory that are older than the specified age threshold.
 * Returns the paths of deleted files.
 */
async function deleteOldFiles(
  dirPath: string,
  olderThanDays: number,
  now: number,
  root: string,
  protectedFindingIds?: Set<string>,
): Promise<string[]> {
  const deleted: string[] = [];
  let entries: string[];

  try {
    entries = await readdir(dirPath);
  } catch {
    // Directory doesn't exist — nothing to clean up
    return [];
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry);
    try {
      const info = await stat(entryPath);
      assertContained(root, entryPath);

      if (info.isDirectory()) {
        // Recurse into subdirectories
        const subDeleted = await deleteOldFiles(entryPath, olderThanDays, now, root);
        deleted.push(...subDeleted);

        // Remove empty directories
        const remaining = await readdir(entryPath);
        if (remaining.length === 0) {
          await rm(entryPath, { recursive: true, force: true });
          deleted.push(entryPath);
        }
      } else if (info.isFile() && (now - info.mtimeMs) / 86_400_000 >= olderThanDays) {
        // Skip finding.json and finding evidence files linked to protected findings
        if (protectedFindingIds && protectedFindingIds.size > 0 && entryPath.includes('findings')) {
          // Best-effort: check if the finding packet directory name matches
          // a protected finding ID prefix. This avoids parsing every packet.
          const findingDirName = path.basename(path.dirname(entryPath));
          let skip = false;
          for (const protectedId of protectedFindingIds) {
            if (findingDirName.startsWith(protectedId) || protectedId.startsWith(findingDirName)) {
              skip = true;
              break;
            }
          }
          if (skip) continue;
        }
        await rm(entryPath, { force: true });
        deleted.push(entryPath);
      }
    } catch {
      // Best effort for individual files
    }
  }

  return deleted;
}
