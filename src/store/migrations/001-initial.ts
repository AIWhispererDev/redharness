/** Initial transactional SQLite catalog migration metadata. */
export const MIGRATION_ID = '001-initial-sqlite';
export const MIGRATION_DESCRIPTION =
  'Create runs, baselines, indexes, and schema migration tables';

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
