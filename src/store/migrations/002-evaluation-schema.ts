/**
 * Migration 002 — Normalized evaluation schema.
 *
 * Tables: suite_attempts, scenario_grades, trial_results, metrics,
 * findings, finding_evidence, finding_replay_specs, artifacts, approvals.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './runner.js';

export const MIGRATION_ID = '002-evaluation-schema';
export const MIGRATION_DESCRIPTION =
  'Create evaluation tables: suite attempts, scenarios, trials, grades, metrics, findings, artifacts, and approvals';

export const migration002: Migration = {
  id: MIGRATION_ID,
  description: MIGRATION_DESCRIPTION,
  up: (database: DatabaseSync) => {
    database.exec(`
      -- Suite attempt tracking (one row per attempt within a run)
      CREATE TABLE IF NOT EXISTS suite_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        suite_id TEXT NOT NULL,
        title TEXT,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        requirement TEXT NOT NULL DEFAULT 'required',
        started_at TEXT,
        ended_at TEXT,
        duration_ms INTEGER,
        error_message TEXT,
        error_name TEXT,
        skip_reason TEXT,
        trace_id TEXT,
        span_id TEXT
      );
      CREATE INDEX IF NOT EXISTS suite_attempts_run_idx
        ON suite_attempts(run_id, suite_id);
      CREATE INDEX IF NOT EXISTS suite_attempts_status_idx
        ON suite_attempts(status);

      -- Scenario grades per suite attempt
      CREATE TABLE IF NOT EXISTS scenario_grades (
        grade_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES suite_attempts(attempt_id) ON DELETE CASCADE,
        scenario_id TEXT NOT NULL,
        scenario_name TEXT,
        status TEXT NOT NULL DEFAULT 'passed',
        started_at TEXT,
        ended_at TEXT,
        duration_ms INTEGER,
        grader_version TEXT
      );
      CREATE INDEX IF NOT EXISTS scenario_grades_attempt_idx
        ON scenario_grades(attempt_id);
      CREATE INDEX IF NOT EXISTS scenario_grades_scenario_idx
        ON scenario_grades(scenario_id);

      -- Trial results (for repeated-trial evaluations like Pass@K)
      CREATE TABLE IF NOT EXISTS trial_results (
        trial_id TEXT PRIMARY KEY,
        grade_id TEXT NOT NULL REFERENCES scenario_grades(grade_id) ON DELETE CASCADE,
        trial_number INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'passed',
        duration_ms INTEGER,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS trial_results_grade_idx
        ON trial_results(grade_id);

      -- Normalized metrics (keyed to scenarios or trials)
      CREATE TABLE IF NOT EXISTS metrics (
        metric_id TEXT PRIMARY KEY,
        grade_id TEXT REFERENCES scenario_grades(grade_id) ON DELETE CASCADE,
        trial_id TEXT REFERENCES trial_results(trial_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT,
        sample_size INTEGER DEFAULT 1,
        confidence_lower REAL,
        confidence_upper REAL
      );
      CREATE INDEX IF NOT EXISTS metrics_grade_idx
        ON metrics(grade_id);
      CREATE INDEX IF NOT EXISTS metrics_name_idx
        ON metrics(name);

      -- Canonical findings from finding packets
      CREATE TABLE IF NOT EXISTS findings (
        finding_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES suite_attempts(attempt_id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        category TEXT,
        lifecycle_state TEXT NOT NULL DEFAULT 'observed',
        originating_suite_id TEXT,
        originating_check TEXT,
        initial_attempt_id TEXT,
        confirmation_count INTEGER DEFAULT 1,
        reproduction_count INTEGER DEFAULT 1,
        expected_state TEXT,
        actual_state TEXT,
        steps_json TEXT,
        pack_id TEXT,
        base_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS findings_run_idx
        ON findings(run_id);
      CREATE INDEX IF NOT EXISTS findings_lifecycle_idx
        ON findings(lifecycle_state);
      CREATE INDEX IF NOT EXISTS findings_severity_idx
        ON findings(severity);
      CREATE INDEX IF NOT EXISTS findings_suite_idx
        ON findings(originating_suite_id);

      -- Finding evidence artifacts
      CREATE TABLE IF NOT EXISTS finding_evidence (
        evidence_id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES findings(finding_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        media_type TEXT,
        sha256 TEXT,
        bytes INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        redacted INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS finding_evidence_finding_idx
        ON finding_evidence(finding_id);

      -- Replay specifications for findings
      CREATE TABLE IF NOT EXISTS finding_replay_specs (
        spec_id TEXT PRIMARY KEY,
        finding_id TEXT NOT NULL REFERENCES findings(finding_id) ON DELETE CASCADE,
        replay_mode TEXT NOT NULL,
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS finding_replay_finding_idx
        ON finding_replay_specs(finding_id);

      -- Artifact references per run
      CREATE TABLE IF NOT EXISTS artifacts (
        artifact_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        attempt_id TEXT REFERENCES suite_attempts(attempt_id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        media_type TEXT,
        sha256 TEXT,
        bytes INTEGER,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        redacted INTEGER NOT NULL DEFAULT 0,
        trace_id TEXT,
        span_id TEXT
      );
      CREATE INDEX IF NOT EXISTS artifacts_run_idx
        ON artifacts(run_id);
      CREATE INDEX IF NOT EXISTS artifacts_attempt_idx
        ON artifacts(attempt_id);

      -- Approval records for agent runs
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        arguments_hash TEXT,
        risk TEXT NOT NULL DEFAULT 'low',
        requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT,
        resolved_at TEXT,
        decision TEXT CHECK(decision IN ('allowed', 'denied')),
        decided_by TEXT CHECK(decided_by IN ('policy', 'human', 'ai')),
        reason TEXT,
        nonce TEXT NOT NULL,
        actor TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_run_idx
        ON approvals(run_id);
      CREATE INDEX IF NOT EXISTS approvals_decision_idx
        ON approvals(decision);
    `);
  },
};
