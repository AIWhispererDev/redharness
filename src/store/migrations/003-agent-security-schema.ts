/**
 * Migration 003 — Agent run state and security schema.
 *
 * Tables: agent_runs, agent_state_snapshots, security_events,
 * evidence_manifests.
 *
 * No secret-bearing content (authorization headers, tokens, cookies,
 * raw secrets) is stored in columns.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './runner.js';

export const MIGRATION_ID = '003-agent-security-schema';
export const MIGRATION_DESCRIPTION =
  'Create agent run state and security event tables';

export const migration003: Migration = {
  id: MIGRATION_ID,
  description: MIGRATION_DESCRIPTION,
  up: (database: DatabaseSync) => {
    database.exec(`
      -- Agent run state index (lightweight reference, not authoritative store)
      CREATE TABLE IF NOT EXISTS agent_runs (
        agent_run_id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'running',
        agent_id TEXT NOT NULL,
        turn INTEGER NOT NULL DEFAULT 0,
        tool_call_count INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_runs_status_idx
        ON agent_runs(status);
      CREATE INDEX IF NOT EXISTS agent_runs_run_idx
        ON agent_runs(run_id);

      -- Agent state snapshots (checkpoints)
      CREATE TABLE IF NOT EXISTS agent_state_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        agent_run_id TEXT NOT NULL REFERENCES agent_runs(agent_run_id) ON DELETE CASCADE,
        turn INTEGER NOT NULL,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS agent_snapshots_agent_idx
        ON agent_state_snapshots(agent_run_id);

      -- Security events (redacted — no secrets in columns)
      CREATE TABLE IF NOT EXISTS security_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
        event_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'info',
        summary TEXT NOT NULL,
        detail_json TEXT,
        source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS security_events_type_idx
        ON security_events(event_type);
      CREATE INDEX IF NOT EXISTS security_events_severity_idx
        ON security_events(severity);
      CREATE INDEX IF NOT EXISTS security_events_run_idx
        ON security_events(run_id);

      -- Evidence manifest index
      CREATE TABLE IF NOT EXISTS evidence_manifests (
        manifest_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        artifact_count INTEGER NOT NULL DEFAULT 0,
        redaction_entry_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS evidence_manifests_run_idx
        ON evidence_manifests(run_id);
      CREATE INDEX IF NOT EXISTS evidence_manifests_attempt_idx
        ON evidence_manifests(attempt_id);
    `);
  },
};
