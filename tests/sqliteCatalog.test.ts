/**
 * Integration tests for the normalized catalog — migration runner,
 * run indexing, finding indexing, and query operations.
 *
 * Note: Uses node:sqlite (Node 22+).
 * Tests are skipped on Node < 22.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let DatabaseSync: any;
let openCatalog: any;
let applyMigrations: any;
let listMigrations: any;
let migration001: any;
let migration002: any;
let migration003: any;
let indexRun: any;
let indexRunFindings: any;
let RunCatalog: any;
let ALL_MIGRATIONS: any;
let rebuildCatalog: any;
let verifyCatalogIntegrity: any;
let getSchemaVersion: any;
let ALL_MIGRATIONS_LIST: any;

beforeAll(async () => {
  if (!hasSqlite) return;

  const sqlite = await import('node:sqlite');
  DatabaseSync = sqlite.DatabaseSync;

  const runner = await import('../src/store/migrations/runner.js');
  openCatalog = runner.openCatalog;
  applyMigrations = runner.applyMigrations;
  listMigrations = runner.listMigrations;

  const m001 = await import('../src/store/migrations/001-initial.js');
  migration001 = m001.migration001;

  const m002 = await import('../src/store/migrations/002-evaluation-schema.js');
  migration002 = m002.migration002;

  const m003 = await import('../src/store/migrations/003-agent-security-schema.js');
  migration003 = m003.migration003;

  const runIdx = await import('../src/store/indexers/runIndexer.js');
  indexRun = runIdx.indexRun;

  const findingIdx = await import('../src/store/indexers/findingIndexer.js');
  indexRunFindings = findingIdx.indexRunFindings;

  const catalog = await import('../src/store/catalog.js');
  RunCatalog = catalog.RunCatalog;

  const recovery = await import('../src/store/catalogRecovery.js');
  ALL_MIGRATIONS = recovery.ALL_MIGRATIONS;
  rebuildCatalog = recovery.rebuildCatalog;
  verifyCatalogIntegrity = recovery.verifyCatalogIntegrity;
  getSchemaVersion = recovery.getSchemaVersion;

  ALL_MIGRATIONS_LIST = [migration001, migration002, migration003];
}, 15000);

function makeRunManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    runId: 'test-run-001',
    packId: 'test-pack',
    profile: undefined,
    status: 'passed',
    startedAt: '2026-06-01T00:00:00.000Z',
    endedAt: '2026-06-01T00:01:00.000Z',
    durationMs: 60000,
    source: 'local',
    git: undefined,
    environment: { nodeVersion: '22', platform: 'linux', ci: false },
    selection: { suites: ['suite-a', 'suite-b'], tags: [], excludedTags: [] },
    policy: { retryErrors: 0, maxWorkers: 1 },
    configHash: 'abc123',
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
      {
        suiteId: 'suite-b',
        title: 'Suite B',
        status: 'failed',
        requirement: 'required',
        startedAt: '2026-06-01T00:00:30.000Z',
        endedAt: '2026-06-01T00:01:00.000Z',
        durationMs: 30000,
        attemptCount: 2,
        error: { message: 'Assertion failed', name: 'AssertionError' },
      },
    ],
    ...overrides,
  };
}

if (hasSqlite) {
  describe('Migration runner', () => {
    it('applies migrations in order on fresh database', () => {
      const db = new DatabaseSync(':memory:');
      const applied = applyMigrations(db, ALL_MIGRATIONS_LIST);
      expect(applied).toEqual(['001-initial-sqlite', '002-evaluation-schema', '003-agent-security-schema']);

      const migrations = listMigrations(db);
      expect(migrations).toHaveLength(3);
      expect(migrations[0].id).toBe('001-initial-sqlite');
      expect(migrations[2].id).toBe('003-agent-security-schema');

      db.close();
    });

    it('skips already-applied migrations on subsequent runs', () => {
      const db = new DatabaseSync(':memory:');
      const first = applyMigrations(db, ALL_MIGRATIONS_LIST);
      expect(first).toHaveLength(3);

      const second = applyMigrations(db, ALL_MIGRATIONS_LIST);
      expect(second).toHaveLength(0); // No new migrations

      const migrations = listMigrations(db);
      expect(migrations).toHaveLength(3);
      db.close();
    });

    it('applies only new migrations when new ones are added', () => {
      const db = new DatabaseSync(':memory:');
      const first = applyMigrations(db, [migration001]);
      expect(first).toEqual(['001-initial-sqlite']);

      const second = applyMigrations(db, ALL_MIGRATIONS_LIST);
      expect(second).toEqual(['002-evaluation-schema', '003-agent-security-schema']);
      db.close();
    });

    it('reports migration versions correctly', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const migrations = listMigrations(db);
      expect(migrations.every((m: any) => m.id && m.description && m.appliedAt)).toBe(true);
      db.close();
    });
  });

  describe('Run indexer', () => {
    it('indexes a run manifest into the catalog', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const manifest = makeRunManifest();
      const count = indexRun(db, manifest, '/tmp/runs/test-pack/test-run-001', { indexResults: true });

      // Should create suite attempts from summary (no full result files)
      expect(count).toBe(2);

      const rows = db.prepare('SELECT * FROM runs WHERE run_id = ?').get('test-run-001');
      expect(rows).toBeTruthy();
      expect(rows.pack_id).toBe('test-pack');
      expect(rows.status).toBe('passed');

      const attempts = db.prepare('SELECT * FROM suite_attempts WHERE run_id = ?').all('test-run-001');
      expect(attempts).toHaveLength(2);
      expect(attempts.some((a: any) => a.suite_id === 'suite-a')).toBe(true);
      expect(attempts.some((a: any) => a.suite_id === 'suite-b')).toBe(true);

      db.close();
    });

    it('is idempotent — re-indexing does not create duplicates', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const manifest = makeRunManifest();
      indexRun(db, manifest, '/tmp/runs/test-pack/test-run-001', { indexResults: true });
      indexRun(db, manifest, '/tmp/runs/test-pack/test-run-001', { indexResults: true });

      const runs = db.prepare('SELECT COUNT(*) as cnt FROM runs').get();
      expect(runs.cnt).toBe(1);

      const attempts = db.prepare('SELECT COUNT(*) as cnt FROM suite_attempts').get();
      expect(attempts.cnt).toBe(2);

      db.close();
    });

    it('does not throw when suite result files are missing', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const manifest = makeRunManifest();
      expect(() => indexRun(db, manifest, '/nonexistent/path', { indexResults: true })).not.toThrow();
      db.close();
    });

    it('indexes without result files when option is false', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const manifest = makeRunManifest();
      const count = indexRun(db, manifest, '/tmp/runs/test-pack/test-run-001', { indexResults: false });

      expect(count).toBe(0);

      // Run row should still be created
      const rows = db.prepare('SELECT * FROM runs WHERE run_id = ?').get('test-run-001');
      expect(rows).toBeTruthy();

      db.close();
    });
  });

  describe('Finding indexer', () => {
    it('indexes finding packets from run directory', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      // Create a temporary run directory with a finding packet
      const runDir = mkdtempSync(join(tmpdir(), 'finding-index-'));
      const findingsDir = join(runDir, 'findings');
      const findingDir = join(findingsDir, 'test-finding-001');
      mkdirSync(findingDir, { recursive: true });

      const packet = {
        findingId: 'test-finding-001',
        lifecycleState: 'suspected',
        title: 'Missing input validation',
        severity: 'high',
        category: 'security',
        originatingSuiteId: 'suite-a',
        originatingCheck: 'validate-input',
        initialAttemptId: 'attempt-1',
        confirmationAttemptIds: ['attempt-1'],
        reproductionCount: 2,
        environment: { packId: 'test-pack', baseUrl: 'https://example.com' },
        evidenceManifest: {
          runId: 'test-run-001',
          attemptId: 'attempt-1',
          traceId: 'trace-abc',
          artifacts: [
            {
              id: 'art-1',
              kind: 'screenshot',
              relativePath: 'screenshots/input.png',
              mediaType: 'image/png',
              sha256: 'abc123...',
              bytes: 1024,
              createdAt: '2026-06-01T00:00:00.000Z',
              redacted: false,
            },
          ],
          redactionSummary: [],
        },
        redactionSummary: [],
        replaySpec: { mode: 'guided', setupHint: 'Open form', unresolvedSteps: ['Click submit'], linkedArtifactIds: [] },
        expectedState: 'Form shows validation error',
        actualState: 'No validation error shown',
        steps: ['Open form', 'Click submit without filling code'],
      };

      writeFileSync(join(findingDir, 'finding.json'), JSON.stringify(packet, null, 2));

      const count = indexRunFindings(db, 'test-run-001', runDir);
      expect(count).toBe(1);

      // Verify finding row
      const finding = db.prepare('SELECT * FROM findings WHERE finding_id = ?').get('test-finding-001');
      expect(finding).toBeTruthy();
      expect(finding.title).toBe('Missing input validation');
      expect(finding.severity).toBe('high');
      expect(finding.lifecycle_state).toBe('suspected');

      // Verify evidence
      const evidence = db.prepare('SELECT * FROM finding_evidence WHERE finding_id = ?').all('test-finding-001');
      expect(evidence).toHaveLength(1);
      expect(evidence[0].kind).toBe('screenshot');

      // Verify replay spec
      const replays = db.prepare('SELECT * FROM finding_replay_specs WHERE finding_id = ?').all('test-finding-001');
      expect(replays).toHaveLength(1);
      expect(replays[0].replay_mode).toBe('guided');

      // Cleanup
      rm(runDir, { recursive: true, force: true });
      db.close();
    });

    it('returns 0 when no findings directory exists', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const count = indexRunFindings(db, 'test-run-001', '/nonexistent');
      expect(count).toBe(0);

      db.close();
    });
  });

  describe('Catalog queries', () => {
    it('queries findings by run ID', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      db.prepare(`INSERT INTO findings (
        finding_id, run_id, title, severity, category, lifecycle_state,
        originating_suite_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
        .run('finding-1', 'run-1', 'Test Finding', 'high', 'security', 'confirmed-semantic', 'suite-a');

      const rows = db.prepare('SELECT * FROM findings WHERE run_id = ?').all('run-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].finding_id).toBe('finding-1');

      db.close();
    });

    it('retrieves suite attempts for a run', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      db.prepare(`INSERT INTO runs (run_id, pack_id, status, source, started_at,
        suite_count, passed_count, failed_count, skipped_count, error_count, cancelled_count, run_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run-1', 'test-pack', 'passed', 'local', '2026-06-01T00:00:00.000Z', 2, 1, 1, 0, 0, 0, '/tmp/run-1');

      db.prepare(`INSERT INTO suite_attempts (
        attempt_id, run_id, suite_id, attempt_number, status, requirement,
        started_at, ended_at, duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run-1/suite-a/attempt-0', 'run-1', 'suite-a', 0, 'passed', 'required', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:30.000Z', 30000);

      const attempts = db.prepare('SELECT * FROM suite_attempts WHERE run_id = ?').all('run-1');
      expect(attempts).toHaveLength(1);
      expect(attempts[0].suite_id).toBe('suite-a');

      db.close();
    });
  });

  describe('RunCatalog integration', () => {
    let catalogDir: string;

    afterAll(async () => {
      if (catalogDir) {
        await rm(catalogDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('initializes with all migrations applied', async () => {
      catalogDir = mkdtempSync(join(tmpdir(), 'catalog-test-'));
      const catalog = new RunCatalog(catalogDir);
      await catalog.init();

      const versions = await catalog.getSchemaVersion();
      expect(versions).toContain('001-initial-sqlite');
      expect(versions).toContain('002-evaluation-schema');
      expect(versions).toContain('003-agent-security-schema');

      catalog.close();
    });

    it('indexes a run and queries it back', async () => {
      const manifest = makeRunManifest();
      const catalog = new RunCatalog(catalogDir);
      await catalog.indexRun(manifest, '/tmp/runs/test-pack/test-run-001');

      const entry = await catalog.getRun('test-run-001');
      expect(entry).not.toBeNull();
      expect(entry!.runId).toBe('test-run-001');
      expect(entry!.packId).toBe('test-pack');

      catalog.close();
    });

    it('queries findings through the catalog API', async () => {
      const catalog = new RunCatalog(catalogDir);
      await catalog.init();

      const findings = await catalog.queryFindings({ runId: 'test-run-001' });
      expect(findings).toHaveLength(0);

      catalog.close();
    });

    it('promotes baselines', async () => {
      const catalog = new RunCatalog(catalogDir);

      const manifest = makeRunManifest({ runId: 'baseline-run' });
      await catalog.indexRun(manifest, '/tmp/runs/test-pack/baseline-run');

      const baseline = await catalog.promoteBaseline('stable', 'baseline-run');
      expect(baseline.name).toBe('stable');
      expect(baseline.runId).toBe('baseline-run');

      const fetched = await catalog.getBaseline('stable');
      expect(fetched!.runId).toBe('baseline-run');

      catalog.close();
    });
  });

  describe('Catalog recovery', () => {
    it('verifies integrity of a valid catalog', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'catalog-recovery-'));
      try {
        const { database } = await openCatalog(dir, ALL_MIGRATIONS);
        database.close();

        const result = await verifyCatalogIntegrity(dir);
        expect(result.ok).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('reports error for missing catalog', async () => {
      const dir = join(tmpdir(), 'nonexistent-catalog-dir');
      const result = await verifyCatalogIntegrity(dir);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('reports schema versions', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'catalog-versions-'));
      try {
        const { database } = await openCatalog(dir, ALL_MIGRATIONS);
        database.close();

        const versions = await getSchemaVersion(dir);
        expect(versions).toEqual([
          '001-initial-sqlite',
          '002-evaluation-schema',
          '003-agent-security-schema',
        ]);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('Foreign key integrity', () => {
    it('cascades deletes from runs to suite_attempts', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      db.prepare(`INSERT INTO runs (run_id, pack_id, status, source, started_at,
        suite_count, passed_count, failed_count, skipped_count, error_count, cancelled_count, run_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run-1', 'test-pack', 'passed', 'local', '2026-06-01T00:00:00.000Z', 1, 1, 0, 0, 0, 0, '/tmp/run-1');

      db.prepare(`INSERT INTO suite_attempts (
        attempt_id, run_id, suite_id, attempt_number, status
      ) VALUES (?, ?, ?, ?, ?)`)
        .run('run-1/suite-a/attempt-0', 'run-1', 'suite-a', 0, 'passed');

      db.prepare('DELETE FROM runs WHERE run_id = ?').run('run-1');

      const attempts = db.prepare('SELECT * FROM suite_attempts WHERE run_id = ?').all('run-1');
      expect(attempts).toHaveLength(0);

      db.close();
    });

    it('cascades deletes from findings to finding_evidence', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      db.prepare(`INSERT INTO runs (run_id, pack_id, status, source, started_at,
        suite_count, passed_count, failed_count, skipped_count, error_count, cancelled_count, run_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('run-1', 'test-pack', 'passed', 'local', '2026-06-01T00:00:00.000Z', 1, 1, 0, 0, 0, 0, '/tmp/run-1');

      db.prepare(`INSERT INTO findings (
        finding_id, run_id, title, severity, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))`)
        .run('finding-1', 'run-1', 'Test Finding', 'high', 'suspected');

      db.prepare(`INSERT INTO finding_evidence (
        evidence_id, finding_id, kind, relative_path, created_at, redacted
      ) VALUES (?, ?, ?, ?, datetime('now'), 0)`)
        .run('ev-1', 'finding-1', 'screenshot', 'screen.png');

      db.prepare('DELETE FROM findings WHERE finding_id = ?').run('finding-1');

      const evidence = db.prepare('SELECT * FROM finding_evidence WHERE finding_id = ?').all('finding-1');
      expect(evidence).toHaveLength(0);

      db.close();
    });
  });

  describe('No secrets in columns', () => {
    it('findings table has no secret-bearing columns', () => {
      const db = new DatabaseSync(':memory:');
      applyMigrations(db, ALL_MIGRATIONS_LIST);

      const columns = db.prepare('PRAGMA table_info(findings)').all();
      const columnNames = columns.map((c: any) => c.name);

      const forbidden = ['authorization', 'cookie', 'token', 'secret', 'password', 'api_key', 'access_key'];
      for (const name of forbidden) {
        const found = columnNames.filter((c: string) => c.includes(name));
        expect(found.length).toBe(0);
      }

      // Check all tables
      const tables = ['runs', 'suite_attempts', 'findings', 'finding_evidence', 'approvals'];
      for (const table of tables) {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        const names = cols.map((c: any) => c.name);
        for (const forbiddenName of ['authorization', 'cookie', 'token', 'secret', 'password']) {
          const found = names.filter((c: string) => c.includes(forbiddenName));
          expect(found.length).toBe(0);
        }
      }

      db.close();
    });
  });
} else {
  describe('Normalized catalog tests (requires Node 22+)', () => {
    it('skipped — node:sqlite not available on Node ' + process.version, () => {
      expect(true).toBe(true);
    });
  });
}
