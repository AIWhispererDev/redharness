/**
 * PRD 11: Release Certification — type definitions.
 *
 * Defines the machine-readable certification checklist and evidence
 * structures produced by the release certification process.
 */

import type { RunManifest } from '../core/runTypes.js';

// ---------------------------------------------------------------------------
// Certification phase identifiers
// ---------------------------------------------------------------------------

export type CertificationPhaseId =
  | 'clean-checkout'
  | 'deterministic-fixture'
  | 'agent-fixture'
  | 'redteam-fixture'
  | 'authenticated-release'
  | 'comparison'
  | 'catalog-rebuild'
  | 'mcp-verification'
  | 'documentation-convergence';

// ---------------------------------------------------------------------------
// Single phase result
// ---------------------------------------------------------------------------

export type PhaseResult = {
  phase: CertificationPhaseId;
  label: string;
  passed: boolean;
  skipped: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  details: string[];
  errors: string[];
  warnings: string[];
  /** Relative path to retained evidence within the certification run directory. */
  evidencePath?: string;
};

// ---------------------------------------------------------------------------
// Certification run manifest
// ---------------------------------------------------------------------------

export type CertificationManifest = {
  schemaVersion: '2';
  certificationId: string;
  label: string;
  createdAt: string;
  completedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'partial';
  /** Git metadata at certification time. */
  git: {
    commit: string;
    branch: string;
    dirty: boolean;
  };
  /** Node and platform versions. */
  environment: {
    nodeVersion: string;
    platform: string;
    ci: boolean;
  };
  /** Configuration hash for reproducibility. */
  configHash: string;
  /** Per-phase results. */
  phases: PhaseResult[];
  /** Absolute paths to retained run manifests referenced by phases. */
  retainedRunDirs: string[];
  /** Summary counts. */
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
  };
  /** Baseline name promoted during certification (if any). */
  promotedBaseline?: string;
  /** Catalog rebuild result. */
  catalogRebuild?: {
    indexedRuns: number;
    schemaVersion: string[];
  };
  /** Documentation convergence outcomes. */
  documentationConvergence?: {
    readmeTestCount: number;
    readmeSuiteCount: number;
    readmeStatusMatches: boolean;
    prdStatuses: Array<{
      prdId: string;
      status: 'implemented' | 'partial' | 'deferred';
      reason: string;
    }>;
    obsoleteMissingRemoved: boolean;
    deferredItems: Array<{
      area: string;
      reason: string;
    }>;
  };
};

// ---------------------------------------------------------------------------
// Certification options
// ---------------------------------------------------------------------------

export type CertificationOptions = {
  /** Pack ID to certify against. */
  packId: string;
  /** Certification label (e.g. "release-2026-06"). */
  label: string;
  /** Output directory for certification evidence. */
  outputDir: string;
  /** Base URL override (e.g. fixture URL). */
  baseUrl?: string;
  /** Playwright storage state for authenticated suites. */
  storageState?: string;
  /** Repository directory for whitebox pentest. */
  repo?: string;
  /** Use release fixtures for deterministic runs. */
  startFixture?: boolean;
  /** Run the clean-checkout verification step (requires git clone). */
  cleanCheckout?: boolean;
  /** Whether this is a CI run. */
  ci?: boolean;
  /** Baseline name to promote for comparison. */
  baselineName?: string;
  /** Baseline run ID to compare against (defaults to last promoted). */
  baselineRunId?: string;
  /** Profile name for the release gate. */
  releaseProfile?: string;
  /** Named packs directory override. */
  packsDir?: string;
};
