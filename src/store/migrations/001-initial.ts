/**
 * Migration 001 — Create runs, baselines, indexes, and schema migration tables.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './runner.js';

export const MIGRATION_ID = '001-initial-sqlite';
export const MIGRATION_DESCRIPTION =
  'Create runs, baselines, indexes, and schema migration tables';

export const migration001: Migration = {
  id: MIGRATION_ID,
  description: MIGRATION_DESCRIPTION,
  up: (database: DatabaseSync) => {
    database.exec(`
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
      CREATE INDEX IF NOT EXISTS runs_status_idx
        ON runs(status);
      CREATE TABLE IF NOT EXISTS baselines (
        name TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        promoted_at TEXT NOT NULL
      );
    `);
  },
};

export async function verifyCatalog(
  catalogDir: string,
): Promise<{ ok: boolean; error?: string }> {
  const { access } = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    await access(path.default.join(catalogDir, 'catalog.sqlite'));
    return { ok: true };
  } catch {
    return { ok: false, error: 'catalog.sqlite does not exist' };
  }
}
