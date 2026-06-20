/**
 * Migration runner — applies transactional versioned migrations in order.
 *
 * Migrations are identified by ordered IDs and applied transactionally.
 * The runner records each applied migration in the schema_migrations table
 * and skips already-applied migrations on subsequent runs.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Migration = {
  id: string;
  description: string;
  up: (database: DatabaseSync) => void;
};

/**
 * Ensure the schema_migrations tracking table exists.
 */
function ensureTrackingTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);
}

/**
 * Get the set of already-applied migration IDs.
 */
function appliedMigrations(database: DatabaseSync): Set<string> {
  const rows = database
    .prepare('SELECT id FROM schema_migrations ORDER BY id')
    .all() as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * Apply pending migrations in order, each inside its own transaction.
 *
 * Returns the list of newly applied migration IDs.
 */
export function applyMigrations(
  database: DatabaseSync,
  migrations: Migration[],
): string[] {
  database.exec('PRAGMA foreign_keys = ON;');
  ensureTrackingTable(database);
  const applied = appliedMigrations(database);
  const newlyApplied: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;

    database.exec('BEGIN;');
    try {
      migration.up(database);
      database
        .prepare(
          'INSERT INTO schema_migrations(id, description, applied_at) VALUES (?, ?, datetime(\'now\'))',
        )
        .run(migration.id, migration.description);
      database.exec('COMMIT;');
      newlyApplied.push(migration.id);
    } catch (error) {
      database.exec('ROLLBACK;');
      throw new Error(
        `Migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return newlyApplied;
}

/**
 * Report applied migrations with their descriptions and timestamps.
 */
export function listMigrations(
  database: DatabaseSync,
): Array<{ id: string; description: string; appliedAt: string }> {
  ensureTrackingTable(database);
  return (
    database
      .prepare(
        'SELECT id, description, applied_at FROM schema_migrations ORDER BY id',
      )
      .all() as Array<{ id: string; description: string; applied_at: string }>
  ).map((r) => ({
    id: r.id,
    description: r.description ?? '',
    appliedAt: r.applied_at,
  }));
}

/**
 * Open or create a SQLite catalog database and apply available migrations.
 *
 * Returns the schema version as a list of applied migration IDs.
 */
export async function openCatalog(
  catalogDir: string,
  migrations: Migration[],
): Promise<{ database: DatabaseSync; applied: string[] }> {
  await mkdir(catalogDir, { recursive: true });
  const databaseFile = path.join(catalogDir, 'catalog.sqlite');
  const database = new DatabaseSync(databaseFile);
  database.exec('PRAGMA journal_mode=WAL;');
  database.exec('PRAGMA foreign_keys=ON;');
  const applied = applyMigrations(database, migrations);
  return { database, applied };
}
