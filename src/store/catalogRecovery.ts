/**
 * Catalog recovery — rebuild corrupt or missing catalogs from immutable
 * run directories, with transactional replacement and idempotent re-indexing.
 *
 * Recovery does not modify immutable run evidence.
 * It deletes and recreates the catalog atomically from run directories.
 */

import { mkdir, readdir, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openCatalog, type Migration } from './migrations/runner.js';
import { migration001 } from './migrations/001-initial.js';
import { migration002 } from './migrations/002-evaluation-schema.js';
import { migration003 } from './migrations/003-agent-security-schema.js';
import { indexRun } from './indexers/runIndexer.js';
import { indexRunFindings } from './indexers/findingIndexer.js';
import type { RunManifest } from '../core/runTypes.js';

/** All available catalog migrations in order. */
export const ALL_MIGRATIONS: Migration[] = [
  migration001,
  migration002,
  migration003,
];

/**
 * Verify catalog integrity by running PRAGMA integrity_check.
 * Returns ok=false with error details when the database is corrupt.
 */
export async function verifyCatalogIntegrity(
  catalogDir: string,
): Promise<{ ok: boolean; error?: string }> {
  const databaseFile = path.join(catalogDir, 'catalog.sqlite');
  try {
    const { access } = await import('node:fs/promises');
    await access(databaseFile);
  } catch {
    return { ok: false, error: 'catalog.sqlite does not exist' };
  }

  try {
    const database = new DatabaseSync(databaseFile);
    const result = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown>;
    database.close();
    const status = String(Object.values(result)[0] ?? '');
    if (status !== 'ok') {
      return { ok: false, error: `Integrity check failed: ${status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: `Cannot open catalog: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Rebuild the catalog from scratch from run directories.
 *
 * Process:
 * 1. Create a temporary catalog in a sibling directory.
 * 2. Index every run directory (pack/run layout and flat layout).
 * 3. Atomically replace the corrupt catalog with the temporary one.
 *
 * Returns the number of runs indexed.
 *
 * Does NOT modify immutable run evidence.
 */
export async function rebuildCatalog(
  catalogDir: string,
  runsBaseDir: string,
): Promise<number> {
  const resolvedCatalogDir = path.resolve(catalogDir);
  const resolvedRunsDir = path.resolve(runsBaseDir);
  const tempDir = path.join(
    path.dirname(resolvedCatalogDir),
    `.catalog-rebuild-${Date.now()}`,
  );

  try {
    // Build catalog in temporary directory
    const { database } = await openCatalog(tempDir, ALL_MIGRATIONS);
    let totalRuns = 0;

    // Discover run directories (both nested pack/run and flat layouts)
    const packDirs = await readdir(resolvedRunsDir, { withFileTypes: true }).catch(() => []);

    for (const packEntry of packDirs) {
      if (!packEntry.isDirectory() || packEntry.name === '.catalog') continue;
      const packPath = path.join(resolvedRunsDir, packEntry.name);

      // Try nested layout first: runs/<pack>/<run>
      const subEntries = await readdir(packPath, { withFileTypes: true }).catch(() => []);
      const runSubDirs = subEntries.filter((e) => e.isDirectory());

      if (runSubDirs.length > 0) {
        for (const runEntry of runSubDirs) {
          const runPath = path.join(packPath, runEntry.name);
          if (await indexRunDirectory(database, runPath)) {
            totalRuns++;
          }
        }
      } else {
        // Flat layout: runs/<run-id> (no pack nesting)
        // But at this level, packPath is the "run" and we determine packId from manifest
        if (await indexRunDirectory(database, packPath)) {
          totalRuns++;
        }
      }
    }

    database.close();

    // Backup existing catalog if present
    const catalogFile = path.join(resolvedCatalogDir, 'catalog.sqlite');
    const backupFile = path.join(resolvedCatalogDir, `catalog.sqlite.bak.${Date.now()}`);
    try {
      await copyFile(catalogFile, backupFile);
    } catch {
      // No existing catalog to back up
    }

    // Atomic replace: rename temp catalog into place
    await mkdir(resolvedCatalogDir, { recursive: true });
    const tempCatalogFile = path.join(tempDir, 'catalog.sqlite');
    await rename(tempCatalogFile, catalogFile);

    // Clean up old backups (keep last 3)
    await cleanOldBackups(resolvedCatalogDir, 3);

    return totalRuns;
  } finally {
    // Clean up temp directory
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Index a single run directory into an open database.
 * Returns true if the run was indexed.
 */
async function indexRunDirectory(
  database: DatabaseSync,
  runPath: string,
): Promise<boolean> {
  let manifest: RunManifest;
  try {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile(path.join(runPath, 'run.json'), 'utf8');
    manifest = JSON.parse(content) as RunManifest;
  } catch {
    return false;
  }

  database.exec('BEGIN;');
  try {
    indexRun(database, manifest, runPath, { indexResults: true });
    indexRunFindings(database, manifest.runId, runPath);
    database.exec('COMMIT;');
    return true;
  } catch (error) {
    database.exec('ROLLBACK;');
    // Log but don't fail the whole rebuild for one bad run
    console.error(`Failed to index run ${runPath}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Clean old catalog backups, keeping only the most recent `keep` count.
 */
async function cleanOldBackups(dir: string, keep: number): Promise<void> {
  try {
    const entries = await readdir(dir);
    const backups = entries
      .filter((e) => e.startsWith('catalog.sqlite.bak.'))
      .map((e) => ({
        name: e,
        time: Number(e.split('.').pop() ?? '0'),
      }))
      .sort((a, b) => b.time - a.time);

    for (const backup of backups.slice(keep)) {
      await rm(path.join(dir, backup.name), { force: true }).catch(() => {});
    }
  } catch {
    // Best effort
  }
}

/**
 * Get the current schema version as a list of applied migration IDs.
 */
export async function getSchemaVersion(
  catalogDir: string,
): Promise<string[]> {
  const databaseFile = path.join(catalogDir, 'catalog.sqlite');
  try {
    const database = new DatabaseSync(databaseFile);
    const rows = database
      .prepare('SELECT id FROM schema_migrations ORDER BY id')
      .all() as Array<{ id: string }>;
    database.close();
    return rows.map((r) => r.id);
  } catch {
    return [];
  }
}
