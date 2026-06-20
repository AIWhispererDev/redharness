/**
 * PRD 06: Initial catalog migration — creates the JSONL-based index structure.
 *
 * The catalog is a simple append-only JSONL file. This "migration" is
 * a no-op that documents the schema version.
 *
 * When SQLite is introduced, this file will contain CREATE TABLE statements.
 */

export const MIGRATION_ID = '001-initial';
export const MIGRATION_DESCRIPTION = 'Create initial JSONL run catalog';

/**
 * Verify the catalog file exists and has valid structure.
 * In the initial release, this is a simple existence check.
 */
export async function verifyCatalog(catalogDir: string): Promise<{ ok: boolean; error?: string }> {
  const { access, readFile } = await import('node:fs/promises');
  const path = await import('node:path');

  const indexPath = path.default.join(catalogDir, 'runs.jsonl');

  try {
    await access(indexPath);
    const content = await readFile(indexPath, 'utf8');
    const lines = content.trim().split('\n').filter((l) => l.length > 0);

    // Validate each line is valid JSON
    for (let i = 0; i < lines.length; i++) {
      try {
        JSON.parse(lines[i]);
      } catch {
        return { ok: false, error: `Invalid JSON at line ${i + 1}` };
      }
    }

    return { ok: true };
  } catch {
    // Catalog file doesn't exist yet — that's OK
    return { ok: true };
  }
}
