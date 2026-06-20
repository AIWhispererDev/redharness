/**
 * Rebuildable SQLite catalog over immutable run directories.
 *
 * Run files remain authoritative. SQLite is only a query/index layer and can
 * be deleted and reconstructed without losing evaluation evidence.
 *
 * Uses transactional versioned migrations and normalized tables for
 * suite attempts, scenarios, trials, grades, metrics, findings,
 * artifacts, and approvals.
 */

import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunManifest } from '../core/runTypes.js';
import { openCatalog } from './migrations/runner.js';
import { ALL_MIGRATIONS, rebuildCatalog as rebuildFromDir, getSchemaVersion } from './catalogRecovery.js';
import { indexRun } from './indexers/runIndexer.js';
import { indexRunFindings } from './indexers/findingIndexer.js';

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

/** Finding result from catalog query. */
export type FindingEntry = {
  findingId: string;
  runId: string;
  title: string;
  severity: string;
  category?: string;
  lifecycleState: string;
  originatingSuiteId?: string;
  packId?: string;
  createdAt: string;
  updatedAt: string;
};

/** Suite attempt result from catalog query. */
export type SuiteAttemptEntry = {
  attemptId: string;
  runId: string;
  suiteId: string;
  title?: string;
  attemptNumber: number;
  status: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

/** Metric entry from catalog query. */
export type MetricEntry = {
  metricId: string;
  name: string;
  value: number;
  unit?: string;
  sampleSize: number;
};

export type FindingQuery = {
  runId?: string;
  severity?: string;
  lifecycleState?: string;
  suiteId?: string;
  limit?: number;
  offset?: number;
};

export class RunCatalog {
  private catalogDir: string;
  private databaseFile: string;
  private database?: DatabaseSync;
  private initialized = false;

  constructor(baseDir: string) {
    this.catalogDir = path.resolve(baseDir, '.catalog');
    this.databaseFile = path.join(this.catalogDir, 'catalog.sqlite');
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await mkdir(this.catalogDir, { recursive: true });
    if (!this.database) {
      this.database = new DatabaseSync(this.databaseFile);
      this.database.exec('PRAGMA journal_mode=WAL;');
      this.database.exec('PRAGMA foreign_keys=ON;');

      // Apply migrations through the runner
      const { applyMigrations } = await import('./migrations/runner.js');
      applyMigrations(this.database, ALL_MIGRATIONS);
    }
  }

  private async db(): Promise<DatabaseSync> {
    await this.init();
    return this.database!;
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
    this.initialized = false;
  }

  async indexRun(manifest: RunManifest, runDir: string): Promise<void> {
    const database = await this.db();
    this.indexRunWithDatabase(database, manifest, runDir);
  }

  indexRunWithDatabase(
    database: DatabaseSync,
    manifest: RunManifest,
    runDir: string,
  ): void {
    database.exec('BEGIN;');
    try {
      indexRun(database, manifest, runDir, { indexResults: true });
      indexRunFindings(database, manifest.runId, runDir);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  async query(query: CatalogQuery): Promise<CatalogEntry[]> {
    let sql = 'SELECT * FROM runs WHERE 1=1';
    const params: Array<string | number> = [];

    if (query.packId) { sql += ' AND pack_id = ?'; params.push(query.packId); }
    if (query.status) { sql += ' AND status = ?'; params.push(query.status); }
    if (query.source) { sql += ' AND source = ?'; params.push(query.source); }
    if (query.profile) { sql += ' AND profile = ?'; params.push(query.profile); }
    if (query.since) { sql += ' AND started_at >= ?'; params.push(query.since); }

    sql += ' ORDER BY started_at DESC';
    sql += ` LIMIT ? OFFSET ?`;
    params.push(query.limit ?? 50, query.offset ?? 0);

    const database = await this.db();
    try {
      const rows = database.prepare(sql).all(...params);
      return (rows as Record<string, unknown>[]).map(rowToEntry);
    } finally {
      // Keep connection open for subsequent queries
    }
  }

  async getRun(runId: string): Promise<CatalogEntry | null> {
    const database = await this.db();
    try {
      const row = database.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
      return row ? rowToEntry(row as Record<string, unknown>) : null;
    } finally {
      // Keep connection open
    }
  }

  async updateRun(runId: string, updates: Partial<CatalogEntry>): Promise<boolean> {
    const current = await this.getRun(runId);
    if (!current) return false;
    const merged = { ...current, ...updates };
    const database = await this.db();
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
  }

  /** Update a finding's lifecycle state. */
  async updateFindingLifecycle(
    findingId: string,
    lifecycleState: string,
  ): Promise<boolean> {
    const database = await this.db();
    const result = database.prepare(`
      UPDATE findings SET lifecycle_state=?, updated_at=datetime('now')
      WHERE finding_id=?
    `).run(lifecycleState, findingId);
    return (result as any).changes > 0;
  }

  /** Add a confirmation attempt ID to a finding. */
  async addFindingConfirmation(
    findingId: string,
    attemptId: string,
  ): Promise<boolean> {
    const database = await this.db();
    const finding = database.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId) as Record<string, unknown> | undefined;
    if (!finding) return false;

    // Read confirmation attempt count from the database
    const existingRaw = database.prepare('SELECT confirmation_count FROM findings WHERE finding_id = ?').get(findingId) as Record<string, unknown> | undefined;
    const currentCount = existingRaw ? Number(existingRaw.confirmation_count) : 0;
    // Increment the confirmation count
    const newCount = currentCount + 1;
    database.prepare(`
      UPDATE findings SET
        confirmation_count=?,
        updated_at=datetime('now')
      WHERE finding_id=?
    `).run(newCount, findingId);

    return true;
  }

  async getAll(): Promise<CatalogEntry[]> {
    const database = await this.db();
    try {
      return (database.prepare('SELECT * FROM runs ORDER BY started_at DESC')
        .all() as Record<string, unknown>[])
        .map(rowToEntry);
    } finally {
      // Keep connection open
    }
  }

  async getBaseline(name: string): Promise<BaselineEntry | null> {
    const database = await this.db();
    try {
      const row = database.prepare('SELECT name, run_id, promoted_at FROM baselines WHERE name = ?').get(name);
      if (!row) return null;
      const r = row as Record<string, unknown>;
      return {
        name: String(r.name),
        runId: String(r.run_id),
        promotedAt: String(r.promoted_at),
      };
    } finally {
      // Keep connection open
    }
  }

  async promoteBaseline(name: string, runId: string): Promise<BaselineEntry> {
    if (!await this.getRun(runId)) throw new Error(`Run not found: ${runId}`);
    const promotedAt = new Date().toISOString();
    const database = await this.db();
    database.prepare(`
      INSERT INTO baselines(name, run_id, promoted_at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        run_id=excluded.run_id, promoted_at=excluded.promoted_at
    `).run(name, runId, promotedAt);
    return { name, runId, promotedAt };
  }

  async listBaselines(): Promise<BaselineEntry[]> {
    const database = await this.db();
    try {
      return (database.prepare(
        'SELECT name, run_id, promoted_at FROM baselines ORDER BY name',
      ).all() as any[]).map((row: any) => ({
        name: String(row.name),
        runId: String(row.run_id),
        promotedAt: String(row.promoted_at),
      }));
    } finally {
      // Keep connection open
    }
  }

  // ---------------------------------------------------------------------------
  // Normalized finding queries
  // ---------------------------------------------------------------------------

  /** Query canonical findings with optional filters. */
  async queryFindings(query: FindingQuery = {}): Promise<FindingEntry[]> {
    let sql = 'SELECT * FROM findings WHERE 1=1';
    const params: Array<string | number> = [];

    if (query.runId) { sql += ' AND run_id = ?'; params.push(query.runId); }
    if (query.severity) { sql += ' AND severity = ?'; params.push(query.severity); }
    if (query.lifecycleState) { sql += ' AND lifecycle_state = ?'; params.push(query.lifecycleState); }
    if (query.suiteId) { sql += ' AND originating_suite_id = ?'; params.push(query.suiteId); }

    sql += ' ORDER BY created_at DESC';
    sql += ' LIMIT ? OFFSET ?';
    params.push(query.limit ?? 50, query.offset ?? 0);

    const database = await this.db();
    const rows = database.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(findingRowToEntry);
  }

  /** Get a single canonical finding by ID. */
  async getFinding(findingId: string): Promise<Record<string, unknown> | null> {
    const database = await this.db();
    const row = database.prepare('SELECT * FROM findings WHERE finding_id = ?').get(findingId) as Record<string, unknown> | undefined;
    if (!row) return null;

    // Load evidence artifacts
    const evidence = database.prepare(
      'SELECT * FROM finding_evidence WHERE finding_id = ? ORDER BY created_at',
    ).all(findingId) as Record<string, unknown>[];

    // Load replay specs
    const replays = database.prepare(
      'SELECT * FROM finding_replay_specs WHERE finding_id = ? ORDER BY created_at',
    ).all(findingId) as Record<string, unknown>[];

    return {
      ...row,
      steps: row.steps_json ? JSON.parse(String(row.steps_json)) : undefined,
      evidence: evidence.map((e) => ({
        kind: e.kind,
        relativePath: e.relative_path,
        mediaType: e.media_type,
        sha256: e.sha256,
        bytes: e.bytes,
        redacted: Boolean(e.redacted),
      })),
      replays: replays.map((r) => ({
        mode: r.replay_mode,
        spec: r.spec_json ? JSON.parse(String(r.spec_json)) : undefined,
      })),
    };
  }

  /** Get suite attempts for a run. */
  async getSuiteAttempts(runId: string): Promise<SuiteAttemptEntry[]> {
    const database = await this.db();
    const rows = database.prepare(
      'SELECT * FROM suite_attempts WHERE run_id = ? ORDER BY suite_id, attempt_number',
    ).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      attemptId: String(r.attempt_id),
      runId: String(r.run_id),
      suiteId: String(r.suite_id),
      title: r.title ? String(r.title) : undefined,
      attemptNumber: Number(r.attempt_number),
      status: String(r.status),
      startedAt: r.started_at ? String(r.started_at) : undefined,
      endedAt: r.ended_at ? String(r.ended_at) : undefined,
      durationMs: r.duration_ms != null ? Number(r.duration_ms) : undefined,
    }));
  }

  /** Get metrics for a run or suite. */
  async getMetrics(
    runId?: string,
    suiteId?: string,
  ): Promise<MetricEntry[]> {
    const database = await this.db();
    let sql = `SELECT m.metric_id, m.name, m.value, m.unit, m.sample_size
      FROM metrics m`;
    const params: Array<string | number> = [];
    const joins: string[] = [];

    if (suiteId) {
      joins.push('JOIN scenario_grades sg ON m.grade_id = sg.grade_id');
      joins.push('JOIN suite_attempts sa ON sg.attempt_id = sa.attempt_id');
      sql += ' ' + joins.join(' ');
      sql += ' WHERE sa.suite_id = ?';
      params.push(suiteId);
      if (runId) { sql += ' AND sa.run_id = ?'; params.push(runId); }
    } else if (runId) {
      joins.push('JOIN scenario_grades sg ON m.grade_id = sg.grade_id');
      joins.push('JOIN suite_attempts sa ON sg.attempt_id = sa.attempt_id');
      sql += ' ' + joins.join(' ');
      sql += ' WHERE sa.run_id = ?';
      params.push(runId);
    }

    sql += ' ORDER BY m.name';
    const rows = database.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      metricId: String(r.metric_id),
      name: String(r.name),
      value: Number(r.value),
      unit: r.unit ? String(r.unit) : undefined,
      sampleSize: Number(r.sample_size),
    }));
  }

  // ---------------------------------------------------------------------------
  // Catalog lifecycle
  // ---------------------------------------------------------------------------

  async rebuild(runsBaseDir: string): Promise<number> {
    // Close current database
    this.close();
    // Remove old catalog file
    const { rm } = await import('node:fs/promises');
    await rm(this.databaseFile, { force: true }).catch(() => {});
    // Rebuild from scratch
    const count = await rebuildFromDir(this.catalogDir, runsBaseDir);
    // Re-initialize on next access
    this.initialized = false;
    return count;
  }

  async getSchemaVersion(): Promise<string[]> {
    return getSchemaVersion(this.catalogDir);
  }

  async reset(): Promise<void> {
    this.close();
    const { rm } = await import('node:fs/promises');
    await rm(this.databaseFile, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function findingRowToEntry(row: Record<string, unknown>): FindingEntry {
  return {
    findingId: String(row.finding_id),
    runId: String(row.run_id),
    title: String(row.title),
    severity: String(row.severity),
    category: row.category ? String(row.category) : undefined,
    lifecycleState: String(row.lifecycle_state),
    originatingSuiteId: row.originating_suite_id ? String(row.originating_suite_id) : undefined,
    packId: row.pack_id ? String(row.pack_id) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
