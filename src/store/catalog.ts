/**
 * PRD 06: Result store — SQLite catalog for run queries and comparisons.
 *
 * The catalog is an append-only index over immutable run directories.
 * Artifact files remain on disk; SQLite provides queryable metadata.
 *
 * This is a lightweight schema implementation using JSON files as the
 * backing store for portability. A future version may use better-sqlite3.
 */

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RunManifest } from '../core/runTypes.js';

export type CatalogEntry = {
  runId: string;
  packId: string;
  status: string;
  profile?: string;
  source: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  suiteCount: number;
  passedCount: number;
  failedCount: number;
  skippedCount: number;
  errorCount: number;
  cancelledCount: number;
  configHash?: string;
  runDir: string;
};

export type CatalogQuery = {
  packId?: string;
  status?: string;
  source?: string;
  profile?: string;
  limit?: number;
  offset?: number;
  since?: string;
};

/**
 * Run catalog — manages a JSONL index of runs for discovery and comparison.
 */
export class RunCatalog {
  private catalogDir: string;
  private indexFile: string;

  constructor(baseDir: string) {
    this.catalogDir = path.resolve(baseDir, '.catalog');
    this.indexFile = path.join(this.catalogDir, 'runs.jsonl');
  }

  /** Ensure catalog directory exists. */
  async init(): Promise<void> {
    await mkdir(this.catalogDir, { recursive: true });
  }

  /** Index a run manifest into the catalog. */
  async indexRun(manifest: RunManifest, runDir: string): Promise<void> {
    await this.init();

    const suiteCount = manifest.suiteResults.length;
    const counts = { passed: 0, failed: 0, skipped: 0, error: 0, cancelled: 0 };
    for (const sr of manifest.suiteResults) {
      if (counts[sr.status] !== undefined) counts[sr.status]++;
    }

    const entry: CatalogEntry = {
      runId: manifest.runId,
      packId: manifest.packId,
      status: manifest.status,
      profile: manifest.profile,
      source: manifest.source,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
      durationMs: manifest.durationMs,
      suiteCount,
      passedCount: counts.passed,
      failedCount: counts.failed,
      skippedCount: counts.skipped,
      errorCount: counts.error,
      cancelledCount: counts.cancelled,
      configHash: manifest.configHash,
      runDir,
    };

    await writeFile(this.indexFile, JSON.stringify(entry) + '\n', { flag: 'a' });
  }

  /** Query the catalog. */
  async query(query: CatalogQuery): Promise<CatalogEntry[]> {
    const entries = await this.getAll();
    let filtered = entries;

    if (query.packId) {
      filtered = filtered.filter((e) => e.packId === query.packId);
    }
    if (query.status) {
      filtered = filtered.filter((e) => e.status === query.status);
    }
    if (query.source) {
      filtered = filtered.filter((e) => e.source === query.source);
    }
    if (query.profile) {
      filtered = filtered.filter((e) => e.profile === query.profile);
    }
    if (query.since) {
      filtered = filtered.filter((e) => e.startedAt >= query.since!);
    }

    // Sort: newest first
    filtered.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    return filtered.slice(offset, offset + limit);
  }

  /** Get a single run by ID. */
  async getRun(runId: string): Promise<CatalogEntry | null> {
    const entries = await this.getAll();
    return entries.find((e) => e.runId === runId) ?? null;
  }

  /** Update a run entry in-place (overwrites the matching JSONL line). */
  async updateRun(runId: string, updates: Partial<CatalogEntry>): Promise<boolean> {
    const entries = await this.getAll();
    const idx = entries.findIndex((e) => e.runId === runId);
    if (idx === -1) return false;

    entries[idx] = { ...entries[idx], ...updates };

    // Rewrite the entire index
    await mkdir(this.catalogDir, { recursive: true });
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await writeFile(this.indexFile, lines);

    return true;
  }

  /** Get all indexed entries. */
  async getAll(): Promise<CatalogEntry[]> {
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      return raw
        .trim()
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as CatalogEntry);
    } catch {
      return [];
    }
  }

  /** Rebuild the catalog from existing run directories. */
  async rebuild(runsBaseDir: string): Promise<number> {
    let count = 0;
    try {
      const packDirs = await readdir(runsBaseDir, { withFileTypes: true });
      for (const packDir of packDirs.filter((d) => d.isDirectory())) {
        const packPath = path.join(runsBaseDir, packDir.name);
        const runDirs = await readdir(packPath, { withFileTypes: true });
        for (const runDir of runDirs.filter((d) => d.isDirectory())) {
          const runPath = path.join(packPath, runDir.name);
          try {
            const manifestRaw = await readFile(path.join(runPath, 'run.json'), 'utf8');
            const manifest = JSON.parse(manifestRaw) as RunManifest;
            await this.indexRun(manifest, runPath);
            count++;
          } catch {
            // Skip runs without valid manifests
          }
        }
      }
    } catch {
      // No existing runs to rebuild
    }
    return count;
  }
}
