/**
 * Rebuildable SQLite catalog over immutable run directories.
 *
 * Run files remain authoritative. SQLite is only a query/index layer and can
 * be deleted and reconstructed without losing evaluation evidence.
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

export type BaselineEntry = {
  name: string;
  runId: string;
  promotedAt: string;
};

export class RunCatalog {
  private catalogDir: string;
  private databaseFile: string;
  private database?: DatabaseSync;

  constructor(baseDir: string) {
    this.catalogDir = path.resolve(baseDir, '.catalog');
    this.databaseFile = path.join(this.catalogDir, 'catalog.sqlite');
  }

  async init(): Promise<void> {
    await mkdir(this.catalogDir, { recursive: true });
    if (!this.database) {
      this.database = new DatabaseSync(this.databaseFile);
      this.database.exec('PRAGMA foreign_keys = ON;');
      this.database.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS runs (
          run_id TEXT PRIMARY KEY,
          pack_id TEXT NOT NULL,
          status TEXT NOT NULL,
          profile TEXT,
          source TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          duration_ms INTEGER,
          suite_count INTEGER NOT NULL,
          passed_count INTEGER NOT NULL,
          failed_count INTEGER NOT NULL,
          skipped_count INTEGER NOT NULL,
          error_count INTEGER NOT NULL,
          cancelled_count INTEGER NOT NULL,
          config_hash TEXT,
          run_dir TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS runs_pack_started_idx
          ON runs(pack_id, started_at DESC);
        CREATE TABLE IF NOT EXISTS baselines (
          name TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          promoted_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(id, applied_at)
          VALUES ('001-initial-sqlite', datetime('now'));
        COMMIT;
      `);
    }
  }

  private async db(): Promise<DatabaseSync> {
    await this.init();
    return this.database!;
  }

  private close(): void {
    this.database?.close();
    this.database = undefined;
  }

  async indexRun(manifest: RunManifest, runDir: string): Promise<void> {
    const database = await this.db();
    try {
      this.indexRunWithDatabase(database, manifest, runDir);
    } finally {
      this.close();
    }
  }

  private indexRunWithDatabase(
    database: DatabaseSync,
    manifest: RunManifest,
    runDir: string,
  ): void {
    const counts = { passed: 0, failed: 0, skipped: 0, error: 0, cancelled: 0 };
    for (const result of manifest.suiteResults) counts[result.status]++;

    database.prepare(`
      INSERT INTO runs (
        run_id, pack_id, status, profile, source, started_at, ended_at,
        duration_ms, suite_count, passed_count, failed_count, skipped_count,
        error_count, cancelled_count, config_hash, run_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        pack_id=excluded.pack_id, status=excluded.status,
        profile=excluded.profile, source=excluded.source,
        started_at=excluded.started_at, ended_at=excluded.ended_at,
        duration_ms=excluded.duration_ms, suite_count=excluded.suite_count,
        passed_count=excluded.passed_count, failed_count=excluded.failed_count,
        skipped_count=excluded.skipped_count, error_count=excluded.error_count,
        cancelled_count=excluded.cancelled_count,
        config_hash=excluded.config_hash, run_dir=excluded.run_dir
    `).run(
      manifest.runId,
      manifest.packId,
      manifest.status,
      manifest.profile ?? null,
      manifest.source,
      manifest.startedAt,
      manifest.endedAt ?? null,
      manifest.durationMs ?? null,
      manifest.suiteResults.length,
      counts.passed,
      counts.failed,
      counts.skipped,
      counts.error,
      counts.cancelled,
      manifest.configHash ?? null,
      path.resolve(runDir),
    );
  }

  async query(query: CatalogQuery): Promise<CatalogEntry[]> {
    const entries = await this.getAll();
    let filtered = entries;
    if (query.packId) filtered = filtered.filter((entry) => entry.packId === query.packId);
    if (query.status) filtered = filtered.filter((entry) => entry.status === query.status);
    if (query.source) filtered = filtered.filter((entry) => entry.source === query.source);
    if (query.profile) filtered = filtered.filter((entry) => entry.profile === query.profile);
    if (query.since) filtered = filtered.filter((entry) => entry.startedAt >= query.since!);
    const offset = query.offset ?? 0;
    return filtered.slice(offset, offset + (query.limit ?? 50));
  }

  async getRun(runId: string): Promise<CatalogEntry | null> {
    const database = await this.db();
    try {
      const row = database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
      return row ? rowToEntry(row as Record<string, unknown>) : null;
    } finally {
      this.close();
    }
  }

  async updateRun(runId: string, updates: Partial<CatalogEntry>): Promise<boolean> {
    const current = await this.getRun(runId);
    if (!current) return false;
    const merged = { ...current, ...updates };
    const database = await this.db();
    try {
      database.prepare(`
        UPDATE runs SET status=?, ended_at=?, duration_ms=?, run_dir=?
        WHERE run_id=?
      `).run(
        merged.status,
        merged.endedAt ?? null,
        merged.durationMs ?? null,
        merged.runDir,
        runId,
      );
      return true;
    } finally {
      this.close();
    }
  }

  async getAll(): Promise<CatalogEntry[]> {
    const database = await this.db();
    try {
      return database.prepare('SELECT * FROM runs ORDER BY started_at DESC')
        .all()
        .map((row) => rowToEntry(row as Record<string, unknown>));
    } finally {
      this.close();
    }
  }

  async promoteBaseline(name: string, runId: string): Promise<BaselineEntry> {
    if (!await this.getRun(runId)) throw new Error(`Run not found: ${runId}`);
    const promotedAt = new Date().toISOString();
    const database = await this.db();
    try {
      database.prepare(`
        INSERT INTO baselines(name, run_id, promoted_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          run_id=excluded.run_id, promoted_at=excluded.promoted_at
      `).run(name, runId, promotedAt);
      return { name, runId, promotedAt };
    } finally {
      this.close();
    }
  }

  async listBaselines(): Promise<BaselineEntry[]> {
    const database = await this.db();
    try {
      return database.prepare(
        'SELECT name, run_id, promoted_at FROM baselines ORDER BY name',
      ).all().map((row: any) => ({
        name: String(row.name),
        runId: String(row.run_id),
        promotedAt: String(row.promoted_at),
      }));
    } finally {
      this.close();
    }
  }

  async rebuild(runsBaseDir: string): Promise<number> {
    const database = await this.db();
    database.exec('BEGIN;');
    try {
      database.exec('DELETE FROM baselines; DELETE FROM runs;');
      let count = 0;
      const packDirs = await readdir(runsBaseDir, { withFileTypes: true }).catch(() => []);
      for (const packDir of packDirs.filter((entry) => entry.isDirectory())) {
        const packPath = path.join(runsBaseDir, packDir.name);
        const runDirs = await readdir(packPath, { withFileTypes: true }).catch(() => []);
        for (const runDir of runDirs.filter((entry) => entry.isDirectory())) {
          const runPath = path.join(packPath, runDir.name);
          try {
            const manifest = JSON.parse(
              await readFile(path.join(runPath, 'run.json'), 'utf8'),
            ) as RunManifest;
            this.indexRunWithDatabase(database, manifest, runPath);
            count++;
          } catch {
            // Invalid or incomplete run directories are not indexed.
          }
        }
      }
      database.exec('COMMIT;');
      return count;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      this.close();
    }
  }

  async reset(): Promise<void> {
    this.database?.close();
    this.database = undefined;
    await rm(this.databaseFile, { force: true });
  }
}

function rowToEntry(row: Record<string, unknown>): CatalogEntry {
  return {
    runId: String(row.run_id),
    packId: String(row.pack_id),
    status: String(row.status),
    profile: row.profile == null ? undefined : String(row.profile),
    source: String(row.source),
    startedAt: String(row.started_at),
    endedAt: row.ended_at == null ? undefined : String(row.ended_at),
    durationMs: row.duration_ms == null ? undefined : Number(row.duration_ms),
    suiteCount: Number(row.suite_count),
    passedCount: Number(row.passed_count),
    failedCount: Number(row.failed_count),
    skippedCount: Number(row.skipped_count),
    errorCount: Number(row.error_count),
    cancelledCount: Number(row.cancelled_count),
    configHash: row.config_hash == null ? undefined : String(row.config_hash),
    runDir: String(row.run_dir),
  };
}
