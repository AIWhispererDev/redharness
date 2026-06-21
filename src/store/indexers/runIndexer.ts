/**
 * RunIndexer — indexes immutable run manifest and result files into the catalog.
 *
 * Reads the authoritative run.json and result files from run directories,
 * then upserts normalized records into suite_attempts, scenario_grades,
 * trial_results, and metrics tables.
 *
 * Every operation is idempotent: re-indexing the same run produces the
 * same catalog state.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { RunManifest, SuiteResult, AttemptSummary } from '../../core/runTypes.js';

export type IndexRunOptions = {
  /** Index suite attempts and grades from full result files. */
  indexResults?: boolean;
};

/**
 * Index a run into open catalog tables.
 *
 * Steps:
 * 1. Upsert the run row.
 * 2. Optionally read suite result files and index attempts/grades/metrics.
 *
 * Returns the number of suite attempts indexed.
 */
export function indexRun(
  database: DatabaseSync,
  manifest: RunManifest,
  runDir: string,
  options: IndexRunOptions = {},
): number {
  const indexResults = options.indexResults ?? true;

  // Upsert run row
  const counts = { passed: 0, failed: 0, skipped: 0, error: 0, cancelled: 0 };
  for (const result of manifest.suiteResults) {
    if (result.status in counts) counts[result.status as keyof typeof counts]++;
  }

  database
    .prepare(
      `INSERT INTO runs (
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
        config_hash=excluded.config_hash, run_dir=excluded.run_dir`,
    )
    .run(
      manifest.runId,
      manifest.packId,
      manifest.status,
      manifest.profile ?? null,
      manifest.source ?? 'local',
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

  if (!indexResults) return 0;

  return indexSuiteResults(database, manifest, runDir);
}

/**
 * Index suite result files from the run directory.
 *
 * Reads <suiteId>.json files from the run directory, or falls back to
 * summary-level data from the manifest when full result files are absent.
 */
function indexSuiteResults(
  database: DatabaseSync,
  manifest: RunManifest,
  runDir: string,
): number {
  let attemptCount = 0;

  for (const summary of manifest.suiteResults) {
    // Try to read full suite result file
    const suiteFile = path.join(runDir, `${summary.suiteId}.json`);

    // We process synchronously over the database connection
    let suiteResult: SuiteResult | null = null;
    try {
      const { readFileSync } = awaitImportSync();
      const content = readFileSync(suiteFile, 'utf8');
      suiteResult = JSON.parse(content) as SuiteResult;
    } catch {
      // Full result file not available — index from summary only
    }

    if (suiteResult) {
      attemptCount += indexFullSuiteResult(database, manifest.runId, suiteResult);
    } else {
      attemptCount += indexSummarySuiteResult(database, manifest.runId, summary);
    }
  }

  return attemptCount;
}

function indexFullSuiteResult(
  database: DatabaseSync,
  runId: string,
  result: SuiteResult,
): number {
  if (result.attempts.length === 0) {
    // No attempts recorded — create a synthetic one from the suite result
    const attemptId = `${runId}/${result.suiteId}/attempt-0`;
    database
      .prepare(
        `INSERT OR IGNORE INTO suite_attempts (
          attempt_id, run_id, suite_id, attempt_number, status, requirement,
          started_at, ended_at, duration_ms, error_message, error_name, skip_reason
        ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        runId,
        result.suiteId,
        result.status,
        result.requirement,
        result.startedAt,
        result.endedAt,
        result.durationMs,
        result.error?.message ?? null,
        result.error?.name ?? null,
        result.skipReason ?? null,
      );
    return 1;
  }

  for (const attempt of result.attempts) {
    const attemptId = `${runId}/${result.suiteId}/attempt-${attempt.attempt}`;
    database
      .prepare(
        `INSERT OR IGNORE INTO suite_attempts (
          attempt_id, run_id, suite_id, attempt_number, status, requirement,
          started_at, ended_at, duration_ms, error_message, error_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attemptId,
        runId,
        result.suiteId,
        attempt.attempt,
        attempt.status,
        result.requirement,
        attempt.startedAt,
        attempt.endedAt,
        attempt.durationMs,
        attempt.error?.message ?? null,
        attempt.error?.name ?? null,
      );

    // Index checks as scenario grades
    for (const check of attempt.checks) {
      const gradeId = `${attemptId}/check/${slugifyCheck(check.name)}`;
      database
        .prepare(
          `INSERT OR IGNORE INTO scenario_grades (
            grade_id, attempt_id, scenario_id, scenario_name, status
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(gradeId, attemptId, check.name, check.name, check.status);
    }
  }

  // Index suite-level metrics
  if (result.metrics) {
    for (const [name, value] of Object.entries(result.metrics)) {
      const metricId = `${runId}/${result.suiteId}/metric/${name}`;
      database
        .prepare(
          `INSERT OR IGNORE INTO metrics (
            metric_id, grade_id, name, value, unit, sample_size
          ) VALUES (?, NULL, ?, ?, NULL, 1)`,
        )
        .run(metricId, name, value as number);
    }
  }

  return result.attempts.length;
}

function indexSummarySuiteResult(
  database: DatabaseSync,
  runId: string,
  summary: RunManifest['suiteResults'][number],
): number {
  const attemptId = `${runId}/${summary.suiteId}/attempt-0`;
  database
    .prepare(
      `INSERT OR IGNORE INTO suite_attempts (
        attempt_id, run_id, suite_id, title, attempt_number, status, requirement,
        started_at, ended_at, duration_ms, error_message, skip_reason
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      attemptId,
      runId,
      summary.suiteId,
      summary.title ?? null,
      summary.status,
      summary.requirement,
      summary.startedAt ?? null,
      summary.endedAt ?? null,
      summary.durationMs ?? null,
      summary.error?.message ?? null,
      summary.skipReason ?? null,
    );
  return 1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugifyCheck(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'check';
}

/** Synchronous import for use inside synchronous database operations. */
let syncFs: { readFileSync: (p: string, enc: string) => string } | null = null;
function awaitImportSync() {
  if (!syncFs) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    syncFs = { readFileSync: require('node:fs').readFileSync };
  }
  return syncFs!;
}
