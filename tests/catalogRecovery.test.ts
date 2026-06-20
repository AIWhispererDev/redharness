/**
 * Tests for catalog recovery — rebuild from run directories,
 * integrity verification, and schema version reporting.
 *
 * Note: Uses node:sqlite (Node 22+).
 * Tests are skipped on Node < 22.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let openCatalog: any;
let ALL_MIGRATIONS: any;
let rebuildCatalog: any;
let verifyCatalogIntegrity: any;
let getSchemaVersion: any;

beforeAll(async () => {
  if (!hasSqlite) return;

  const runner = await import('../src/store/migrations/runner.js');
  openCatalog = runner.openCatalog;

  const recovery = await import('../src/store/catalogRecovery.js');
  ALL_MIGRATIONS = recovery.ALL_MIGRATIONS;
  rebuildCatalog = recovery.rebuildCatalog;
  verifyCatalogIntegrity = recovery.verifyCatalogIntegrity;
  getSchemaVersion = recovery.getSchemaVersion;
}, 15000);

if (hasSqlite) {
  describe('Catalog recovery', () => {
    it('rebuilds catalog from flat run directories', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'rebuild-flat-runs-'));
      const catalogDir = mkdtempSync(join(tmpdir(), 'rebuild-flat-cat-'));

      try {
        const runDir = join(runsDir, 'test-run-001');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'run.json'), JSON.stringify({
          schemaVersion: '1',
          runId: 'test-run-001',
          packId: 'test-pack',
          status: 'passed',
          startedAt: '2026-06-01T00:00:00.000Z',
          endedAt: '2026-06-01T00:01:00.000Z',
          durationMs: 60000,
          source: 'local',
          environment: { nodeVersion: '22', platform: 'linux', ci: false },
          selection: { suites: ['suite-a'], tags: [], excludedTags: [] },
          policy: { retryErrors: 0, maxWorkers: 1 },
          suiteResults: [
            {
              suiteId: 'suite-a',
              title: 'Suite A',
              status: 'passed',
              requirement: 'required',
              startedAt: '2026-06-01T00:00:00.000Z',
              endedAt: '2026-06-01T00:00:30.000Z',
              durationMs: 30000,
              attemptCount: 1,
            },
          ],
        }));

        const count = await rebuildCatalog(catalogDir, runsDir);
        expect(count).toBe(1);

        const integrity = await verifyCatalogIntegrity(catalogDir);
        expect(integrity.ok).toBe(true);

        const versions = await getSchemaVersion(catalogDir);
        expect(versions).toContain('001-initial-sqlite');
      } finally {
        await rm(runsDir, { recursive: true, force: true }).catch(() => {});
        await rm(catalogDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('rebuilds catalog from nested pack/run directories', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'rebuild-nested-runs-'));
      const catalogDir = mkdtempSync(join(tmpdir(), 'rebuild-nested-cat-'));

      try {
        const runDir = join(runsDir, 'test-pack', 'test-run-002');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'run.json'), JSON.stringify({
          schemaVersion: '1',
          runId: 'test-run-002',
          packId: 'test-pack',
          status: 'failed',
          startedAt: '2026-06-01T00:00:00.000Z',
          endedAt: '2026-06-01T00:01:00.000Z',
          durationMs: 60000,
          source: 'local',
          environment: { nodeVersion: '22', platform: 'linux', ci: false },
          selection: { suites: ['suite-b'], tags: [], excludedTags: [] },
          policy: { retryErrors: 0, maxWorkers: 1 },
          suiteResults: [
            {
              suiteId: 'suite-b',
              title: 'Suite B',
              status: 'failed',
              requirement: 'required',
              startedAt: '2026-06-01T00:00:00.000Z',
              endedAt: '2026-06-01T00:00:30.000Z',
              durationMs: 30000,
              attemptCount: 1,
              error: { message: 'Failed', name: 'Error' },
            },
          ],
        }));

        const count = await rebuildCatalog(catalogDir, runsDir);
        expect(count).toBe(1);

        const integrity = await verifyCatalogIntegrity(catalogDir);
        expect(integrity.ok).toBe(true);
      } finally {
        await rm(runsDir, { recursive: true, force: true }).catch(() => {});
        await rm(catalogDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('skips invalid run directories during rebuild', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'rebuild-skip-runs-'));
      const catalogDir = mkdtempSync(join(tmpdir(), 'rebuild-skip-cat-'));

      try {
        const validRun = join(runsDir, 'valid-run');
        mkdirSync(validRun, { recursive: true });
        writeFileSync(join(validRun, 'run.json'), JSON.stringify({
          schemaVersion: '1',
          runId: 'valid-run',
          packId: 'test-pack',
          status: 'passed',
          startedAt: '2026-06-01T00:00:00.000Z',
          environment: { nodeVersion: '22', platform: 'linux', ci: false },
          selection: { suites: [], tags: [], excludedTags: [] },
          policy: { retryErrors: 0, maxWorkers: 1 },
          suiteResults: [],
        }));

        // Invalid run (no run.json)
        const invalidRun = join(runsDir, 'invalid-run');
        mkdirSync(invalidRun, { recursive: true });

        // Empty directory (should be skipped)
        const emptyDir = join(runsDir, 'empty-dir');
        mkdirSync(emptyDir, { recursive: true });

        const count = await rebuildCatalog(catalogDir, runsDir);
        expect(count).toBe(1);

        const integrity = await verifyCatalogIntegrity(catalogDir);
        expect(integrity.ok).toBe(true);
      } finally {
        await rm(runsDir, { recursive: true, force: true }).catch(() => {});
        await rm(catalogDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('indexes findings during rebuild', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'rebuild-findings-runs-'));
      const catalogDir = mkdtempSync(join(tmpdir(), 'rebuild-findings-cat-'));

      try {
        const runDir = join(runsDir, 'finding-run');
        mkdirSync(runDir, { recursive: true });

        writeFileSync(join(runDir, 'run.json'), JSON.stringify({
          schemaVersion: '1',
          runId: 'finding-run',
          packId: 'test-pack',
          status: 'failed',
          startedAt: '2026-06-01T00:00:00.000Z',
          environment: { nodeVersion: '22', platform: 'linux', ci: false },
          selection: { suites: ['suite-a'], tags: [], excludedTags: [] },
          policy: { retryErrors: 0, maxWorkers: 1 },
          suiteResults: [{
            suiteId: 'suite-a',
            title: 'Suite A',
            status: 'failed',
            requirement: 'required',
            startedAt: '2026-06-01T00:00:00.000Z',
            endedAt: '2026-06-01T00:00:30.000Z',
            durationMs: 30000,
            attemptCount: 1,
            error: { message: 'Validation failed', name: 'Error' },
          }],
        }));

        const findingsDir = join(runDir, 'findings', 'test-finding');
        mkdirSync(findingsDir, { recursive: true });
        writeFileSync(join(findingsDir, 'finding.json'), JSON.stringify({
          findingId: 'test-finding',
          lifecycleState: 'suspected',
          title: 'Validation finding',
          severity: 'high',
          category: 'validation',
          originatingSuiteId: 'suite-a',
          originatingCheck: 'check-1',
          initialAttemptId: 'attempt-1',
          confirmationAttemptIds: [],
          reproductionCount: 1,
          environment: { packId: 'test-pack' },
          evidenceManifest: {
            runId: 'finding-run',
            attemptId: 'attempt-1',
            traceId: 'trace-abc',
            artifacts: [],
            redactionSummary: [],
          },
          redactionSummary: [],
          expectedState: 'Valid',
          actualState: 'Invalid',
          steps: ['Do X', 'Check Y'],
        }));

        const count = await rebuildCatalog(catalogDir, runsDir);
        expect(count).toBe(1);

        const { database } = await openCatalog(catalogDir, []);
        const findings = database.prepare('SELECT * FROM findings').all() as Array<{ finding_id: string; title: string }>;
        expect(findings).toHaveLength(1);
        expect(findings[0].finding_id).toBe('test-finding');
        database.close();
      } finally {
        await rm(runsDir, { recursive: true, force: true }).catch(() => {});
        await rm(catalogDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('is idempotent — re-rebuild does not duplicate', async () => {
      const runsDir = mkdtempSync(join(tmpdir(), 'rebuild-idem-runs-'));
      const catalogDir = mkdtempSync(join(tmpdir(), 'rebuild-idem-cat-'));

      try {
        const runDir = join(runsDir, 'idem-run');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(join(runDir, 'run.json'), JSON.stringify({
          schemaVersion: '1',
          runId: 'idem-run',
          packId: 'test-pack',
          status: 'passed',
          startedAt: '2026-06-01T00:00:00.000Z',
          environment: { nodeVersion: '22', platform: 'linux', ci: false },
          selection: { suites: [], tags: [], excludedTags: [] },
          policy: { retryErrors: 0, maxWorkers: 1 },
          suiteResults: [],
        }));

        const first = await rebuildCatalog(catalogDir, runsDir);
        const second = await rebuildCatalog(catalogDir, runsDir);

        expect(first).toBe(1);
        expect(second).toBe(1);

        const { database } = await openCatalog(catalogDir, []);
        const runs = database.prepare('SELECT COUNT(*) as cnt FROM runs').get() as { cnt: number };
        expect(runs.cnt).toBe(1);
        database.close();
      } finally {
        await rm(runsDir, { recursive: true, force: true }).catch(() => {});
        await rm(catalogDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });
} else {
  describe('Catalog recovery tests (requires Node 22+)', () => {
    it('skipped — node:sqlite not available on Node ' + process.version, () => {
      expect(true).toBe(true);
    });
  });
}
