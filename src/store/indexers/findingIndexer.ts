/**
 * FindingIndexer — indexes canonical finding packets into the catalog.
 *
 * Reads finding.json files from run directories, then upserts normalized
 * records into findings, finding_evidence, and finding_replay_specs tables.
 *
 * Preserves stable finding lifecycle and identity across comparisons
 * by keying on finding_id from the packet.
 */

import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FindingPacketV2, ArtifactRef as TraceArtifactRef } from '../../trace/traceTypes.js';

/**
 * Index finding packets from a run directory.
 *
 * Scans <runDir>/findings/ for finding.json files and upserts them
 * into the catalog's findings, finding_evidence, and finding_replay_specs tables.
 *
 * Returns the number of findings indexed.
 */
export function indexRunFindings(
  database: DatabaseSync,
  runId: string,
  runDir: string,
): number {
  const findingsDir = path.join(runDir, 'findings');
  let findingDirs: string[];

  try {
    findingDirs = readdirSync(findingsDir, { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => entry.name);
  } catch {
    // No findings directory
    return 0;
  }

  let count = 0;

  for (const findingDirName of findingDirs) {
    const findingDir = path.join(findingsDir, findingDirName);
    const findingFile = path.join(findingDir, 'finding.json');

    let packet: FindingPacketV2;
    try {
      const content = readFileSync(findingFile, 'utf8');
      packet = JSON.parse(content) as FindingPacketV2;
    } catch {
      // Invalid or missing finding.json — skip
      continue;
    }

    if (!packet.findingId) continue;

    // Upsert finding record
    const stepsJson = packet.steps ? JSON.stringify(packet.steps) : null;
    database
      .prepare(
        `INSERT INTO findings (
          finding_id, run_id, attempt_id, title, severity, category,
          lifecycle_state, originating_suite_id, originating_check,
          initial_attempt_id, confirmation_count, reproduction_count,
          expected_state, actual_state, steps_json, pack_id, base_url,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          COALESCE((SELECT created_at FROM findings WHERE finding_id = ?), datetime('now')),
          datetime('now'))
        ON CONFLICT(finding_id) DO UPDATE SET
          run_id=excluded.run_id,
          title=excluded.title,
          severity=excluded.severity,
          category=excluded.category,
          lifecycle_state=excluded.lifecycle_state,
          originating_suite_id=excluded.originating_suite_id,
          originating_check=excluded.originating_check,
          confirmation_count=excluded.confirmation_count,
          reproduction_count=excluded.reproduction_count,
          expected_state=excluded.expected_state,
          actual_state=excluded.actual_state,
          steps_json=excluded.steps_json,
          pack_id=excluded.pack_id,
          base_url=excluded.base_url,
          updated_at=excluded.updated_at`,
      )
      .run(
        packet.findingId,
        runId,
        packet.initialAttemptId ?? null,
        packet.title,
        packet.severity,
        packet.category ?? null,
        packet.lifecycleState,
        packet.originatingSuiteId ?? null,
        packet.originatingCheck ?? null,
        packet.initialAttemptId ?? null,
        packet.confirmationAttemptIds?.length ?? 0,
        packet.reproductionCount ?? 1,
        packet.expectedState ?? null,
        packet.actualState ?? null,
        stepsJson,
        packet.environment?.packId ?? null,
        packet.environment?.baseUrl ?? null,
        packet.findingId,
      );

    // Index evidence artifacts
    if (packet.evidenceManifest?.artifacts) {
      for (const artifact of packet.evidenceManifest.artifacts) {
        const evidenceId = `${packet.findingId}/ev/${artifact.id}`;
        database
          .prepare(
            `INSERT OR IGNORE INTO finding_evidence (
              evidence_id, finding_id, kind, relative_path, media_type,
              sha256, bytes, created_at, redacted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            evidenceId,
            packet.findingId,
            artifact.kind,
            artifact.relativePath,
            artifact.mediaType ?? null,
            artifact.sha256 ?? null,
            artifact.bytes ?? null,
            artifact.createdAt ?? new Date().toISOString(),
            artifact.redacted ? 1 : 0,
          );
      }
    }

    // Index replay spec
    if (packet.replaySpec) {
      const specId = `${packet.findingId}/replay`;
      database
        .prepare(
          `INSERT OR IGNORE INTO finding_replay_specs (
            spec_id, finding_id, replay_mode, spec_json, created_at
          ) VALUES (?, ?, ?, ?, datetime('now'))`,
        )
        .run(
          specId,
          packet.findingId,
          packet.replaySpec.mode,
          JSON.stringify(packet.replaySpec),
        );
    }

    count++;
  }

  return count;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import { readdirSync } from 'node:fs';
