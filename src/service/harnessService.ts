/**
 * PRD 06: HarnessService — reusable application service layer.
 *
 * CLI and MCP are thin adapters over this service. No orchestration logic
 * is duplicated in the MCP server.
 *
 * Methods:
 *   listPacks, listSuites, validateDataset, startRun, getRun,
 *   cancelRun, compareRuns, listFindings, getFinding
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { registry } from '../core/suiteRegistry.js';
import { RunCoordinator } from '../core/runCoordinator.js';
import { loadManifest, computeConfigHash } from '../core/resumeStore.js';
import { RunCatalog } from '../store/catalog.js';
import type { RunManifest, SuiteDefinition, RunSelection } from '../core/runTypes.js';
import type { ExecutionStatus } from '../core/status.js';
import type { PackInfo, ServiceError } from './serviceTypes.js';

// Re-export types used by consumers
export type { PackInfo, ServiceError };

export type ServiceOptions = {
  packsDir?: string;
  runsBaseDir?: string;
  catalogBaseDir?: string;
};

/**
 * Start run options.
 */
export type StartRunOptions = {
  runId?: string;
  packId: string;
  profile?: string;
  suites?: string[];
  tags?: string[];
  excludedTags?: string[];
  storageState?: string;
  nonProStorageState?: string;
  repo?: string;
  headless?: boolean;
  workers?: number;
  retryErrors?: number;
  timeoutMs?: number;
  source?: RunManifest['source'];
  runDir?: string;
  baseUrl?: string;
};

/**
 * Harness service — centralized business logic for the QA platform.
 * Both CLI and MCP adapters call this service.
 */
export class HarnessService {
  private options: Required<ServiceOptions>;
  private catalog: RunCatalog;
  /** Tracks active coordinators for cancellation. */
  private runningCoordinators: Map<string, RunCoordinator> = new Map();

  constructor(options: ServiceOptions = {}) {
    this.options = {
      packsDir: options.packsDir ?? path.resolve(process.cwd(), 'packs'),
      runsBaseDir: options.runsBaseDir ?? path.resolve(process.cwd(), 'runs'),
      catalogBaseDir: options.catalogBaseDir ?? process.cwd(),
    };
    this.catalog = new RunCatalog(this.options.catalogBaseDir);
  }

  // ---------------------------------------------------------------------------
  // List operations
  // ---------------------------------------------------------------------------

  /** List available packs. */
  async listPacks(): Promise<PackInfo[]> {
    try {
      const entries = await readdir(this.options.packsDir);
      const packs: PackInfo[] = [];

      for (const name of entries) {
        const dirPath = path.join(this.options.packsDir, name);
        try {
          const dirStat = await stat(dirPath);
          if (!dirStat.isDirectory()) continue;
          const packRaw = await readFile(path.join(dirPath, 'pack.yaml'), 'utf8');
          const pack = YAML.parse(packRaw) as { id?: string; name?: string; baseUrl?: string };
          packs.push({
            id: pack.id ?? name,
            name: pack.name ?? name,
            baseUrl: pack.baseUrl,
          });
        } catch {
          packs.push({ id: name, name });
        }
      }

      return packs;
    } catch {
      return [];
    }
  }

  /** List all registered suites. */
  listSuites(): SuiteDefinition[] {
    return registry.getAll();
  }

  /** List suites matching selection criteria. */
  selectSuites(selection: RunSelection): SuiteDefinition[] {
    return registry.select(selection);
  }

  // ---------------------------------------------------------------------------
  // Dataset validation
  // ---------------------------------------------------------------------------

  /** Validate a dataset. */
  async validateDataset(packId: string, datasetId: string): Promise<{ valid: boolean; errors: string[]; scenarioCount: number }> {
    const dsDir = path.resolve(this.options.packsDir, packId, 'datasets', datasetId);
    const errors: string[] = [];
    let scenarioCount = 0;

    try {
      const { loadScenariosFromDir, loadDatasetManifest, validateScenario } = await import('../scenarios/loader.js');
      const {
        validateSplitRefs,
        validateDatasetContent,
      } = await import('../datasets/manifest.js');

      const scenarios = await loadScenariosFromDir(dsDir);
      scenarioCount = scenarios.length;

      for (const s of scenarios) {
        errors.push(...validateScenario(s).map((e: string) => `Scenario ${s.id}: ${e}`));
      }

      const manifest = await loadDatasetManifest(dsDir);
      if (manifest) {
        const ids = new Set(scenarios.map((s: { id: string }) => s.id));
        errors.push(...validateSplitRefs(manifest as any, ids));
        errors.push(...validateDatasetContent(manifest as any, scenarios));
      }
    } catch (error) {
      errors.push(`Cannot load dataset: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      scenarioCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Run operations
  // ---------------------------------------------------------------------------

  /** Start a run (synchronous). */
  async startRun(options: StartRunOptions): Promise<{ runId: string; manifest: RunManifest; runDir: string }> {
    const { runId, coordinator } = await this.prepareRun(options);
    this.runningCoordinators.set(runId, coordinator);

    try {
      return await this.completeRun(runId, coordinator);
    } finally {
      this.runningCoordinators.delete(runId);
    }
  }

  /**
   * Start a run in the background and return once cancellation/status lookup
   * is available. Used by remote adapters such as MCP.
   */
  async startRunDetached(options: StartRunOptions): Promise<{
    runId: string;
    runDir: string;
  }> {
    const { runId, coordinator } = await this.prepareRun(options);
    this.runningCoordinators.set(runId, coordinator);
    void this.completeRun(runId, coordinator)
      .catch(() => {})
      .finally(() => this.runningCoordinators.delete(runId));
    return { runId, runDir: coordinator.getRunDir() };
  }

  private async prepareRun(options: StartRunOptions): Promise<{
    runId: string;
    coordinator: RunCoordinator;
  }> {
    const packDir = path.resolve(this.options.packsDir, options.packId);
    const packRaw = await readFile(path.join(packDir, 'pack.yaml'), 'utf8');
    const pack = YAML.parse(packRaw) as {
      baseUrl?: string;
      profiles?: Record<string, {
        includeTags?: string[];
        excludeTags?: string[];
      }>;
    };

    let tags = options.tags ?? [];
    let excludedTags = options.excludedTags ?? [];
    if (options.profile) {
      const profile = pack.profiles?.[options.profile];
      if (!profile) {
        throw new Error(
          `Unknown profile "${options.profile}". Available: ${Object.keys(pack.profiles ?? {}).join(', ')}`,
        );
      }
      tags = [...new Set([...tags, ...(profile.includeTags ?? [])])];
      excludedTags = [
        ...new Set([...excludedTags, ...(profile.excludeTags ?? [])]),
      ];
    }

    const runId = options.runId ??
      `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const coordinator = new RunCoordinator({
      packDir,
      packId: options.packId,
      source: options.source ?? 'local',
      profile: options.profile,
      selection: {
        suites: options.suites ?? [],
        tags,
        excludedTags,
      },
      policy: {
        retryErrors: options.retryErrors ?? 0,
        maxWorkers: options.workers ?? 3,
        timeoutMs: options.timeoutMs,
      },
      baseUrl: options.baseUrl ?? pack.baseUrl,
      storageState: options.storageState,
      nonProStorageState: options.nonProStorageState,
      repo: options.repo,
      headless: options.headless ?? true,
      outputBaseDir: this.options.runsBaseDir,
      runDir: options.runDir,
      runId,
    });

    return { runId, coordinator };
  }

  private async completeRun(
    runId: string,
    coordinator: RunCoordinator,
  ): Promise<{ runId: string; manifest: RunManifest; runDir: string }> {
    const manifest = await coordinator.execute();
    const runDir = coordinator.getRunDir();
    await this.catalog.indexRun(manifest, runDir);
    return { runId, manifest, runDir };
  }

  /** Get a run by ID. */
  async getRun(runId: string): Promise<{ manifest: RunManifest | null; entry: import('../store/catalog.js').CatalogEntry | null }> {
    const active = this.runningCoordinators.get(runId);
    if (active) {
      return { manifest: active.getManifest(), entry: null };
    }

    const entry = await this.catalog.getRun(runId);
    let manifest: RunManifest | null = null;

    if (entry) {
      manifest = await loadManifest(entry.runDir);
    }

    return { manifest, entry };
  }

  /** Cancel a run — sends abort signal to active coordinator. */
  async cancelRun(runId: string): Promise<boolean> {
    // Check in-memory running coordinators first (run may not yet be cataloged)
    const activeCoordinator = this.runningCoordinators.get(runId);
    if (activeCoordinator) {
      activeCoordinator.abort();
      // Try catalog update if the entry exists
      try {
        await this.catalog.updateRun(runId, {
          status: 'cancelled',
          endedAt: new Date().toISOString(),
        });
      } catch { /* in-flight run may not be cataloged yet */ }
      return true;
    }

    // Fall back to catalog lookup for completed runs
    const { entry } = await this.getRun(runId);
    if (!entry) return false;

    await this.catalog.updateRun(runId, {
      status: 'cancelled',
      endedAt: new Date().toISOString(),
    });

    return true;
  }

  // ---------------------------------------------------------------------------
  // Comparison
  // ---------------------------------------------------------------------------

  /** Compare two runs. */
  async compareRuns(
    baselineRunId: string,
    candidateRunId: string,
  ): Promise<{
    comparison: import('../experiments/experimentTypes.js').RunComparison | null;
    error?: string;
  }> {
    const baseline = await this.getRun(baselineRunId);
    const candidate = await this.getRun(candidateRunId);

    if (!baseline.manifest || !candidate.manifest) {
      return { comparison: null, error: 'One or both runs not found' };
    }

    if (baseline.manifest.packId !== candidate.manifest.packId) {
      return { comparison: null, error: 'Cannot compare runs from different packs' };
    }

    // Build candidate result from manifest
    const { compareRuns: compareFn } = await import('../experiments/comparison.js');
    const candidateResult = {
      label: candidateRunId,
      config: { label: candidateRunId },
      runId: candidateRunId,
      status: candidate.manifest.status,
      suiteResults: candidate.manifest.suiteResults.map((sr) => ({
        suiteId: sr.suiteId,
        scenarioId: sr.suiteId,
        status: sr.status,
        metrics: [] as import('../experiments/experimentTypes.js').MetricValue[],
        findings: sr.status === 'failed' || sr.status === 'error'
          ? [{
              id: sr.suiteId,
              severity: (sr.error?.message?.toLowerCase().includes('security')
                ? 'high'
                : 'medium') as 'high' | 'medium',
              title: sr.title,
            }]
          : [],
        tags: registry.get(sr.suiteId)?.tags ?? [],
      })),
    };

    const baselineResult = {
      label: baselineRunId,
      config: { label: baselineRunId },
      runId: baselineRunId,
      status: baseline.manifest.status,
      suiteResults: baseline.manifest.suiteResults.map((sr) => ({
        suiteId: sr.suiteId,
        scenarioId: sr.suiteId,
        status: sr.status,
        metrics: [] as import('../experiments/experimentTypes.js').MetricValue[],
        findings: sr.status === 'failed' || sr.status === 'error'
          ? [{
              id: sr.suiteId,
              severity: (sr.error?.message?.toLowerCase().includes('security')
                ? 'high'
                : 'medium') as 'high' | 'medium',
              title: sr.title,
            }]
          : [],
        tags: registry.get(sr.suiteId)?.tags ?? [],
      })),
    };

    const comparison = compareFn(baselineResult, candidateResult, {
      baselineLabel: `Baseline (${baselineRunId})`,
      candidateLabel: `Candidate (${candidateRunId})`,
    });

    return { comparison };
  }

  async promoteBaseline(name: string, runId: string) {
    return this.catalog.promoteBaseline(name, runId);
  }

  async getBaseline(name: string) {
    return this.catalog.getBaseline(name);
  }

  async listBaselines() {
    return this.catalog.listBaselines();
  }

  async rebuildCatalog(): Promise<number> {
    return this.catalog.rebuild(this.options.runsBaseDir);
  }

  // ---------------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------------

  /** List findings from a run. */
  async listFindings(runId: string): Promise<Array<{ findingId: string; title: string; severity: string; lifecycleState: string }>> {
    const { entry } = await this.getRun(runId);
    if (!entry) return [];

    // In the initial release, findings are extracted from failed suites
    const manifest = await loadManifest(entry.runDir);
    if (!manifest) return [];

    return manifest.suiteResults
      .filter((sr) => sr.status === 'failed')
      .map((sr) => ({
        findingId: `${runId}/${sr.suiteId}`,
        title: sr.title || sr.suiteId,
        severity: sr.error?.message?.includes('security') ? 'high' : 'medium',
        lifecycleState: 'observed',
      }));
  }

  /** Get a specific finding. */
  async getFinding(findingId: string): Promise<Record<string, unknown> | null> {
    const parts = findingId.split('/');
    if (parts.length !== 2) return null;

    const [runId, suiteId] = parts;
    const { entry } = await this.getRun(runId);
    if (!entry) return null;

    const manifest = await loadManifest(entry.runDir);
    if (!manifest) return null;

    const suite = manifest.suiteResults.find((sr) => sr.suiteId === suiteId);
    if (!suite) return null;

    return {
      findingId,
      suiteId,
      title: suite.title,
      status: suite.status,
      error: suite.error,
      skipReason: suite.skipReason,
      runId,
      packId: manifest.packId,
      runDir: entry.runDir,
    };
  }

  // ---------------------------------------------------------------------------
  // Report generation
  // ---------------------------------------------------------------------------

  /** Generate JUnit XML for a run. */
  async generateJUnit(runId: string): Promise<string | null> {
    const { entry } = await this.getRun(runId);
    if (!entry) return null;

    const manifest = await loadManifest(entry.runDir);
    if (!manifest) return null;

    const { generateJUnitXml } = await import('../reporters/junit.js');
    return generateJUnitXml(manifest, entry.runDir);
  }

  /** Generate SARIF for a run. */
  async generateSarif(runId: string): Promise<Record<string, unknown> | null> {
    const { entry } = await this.getRun(runId);
    if (!entry) return null;

    const manifest = await loadManifest(entry.runDir);
    if (!manifest) return null;

    const { generateSarifReport } = await import('../reporters/sarif.js');
    return generateSarifReport(manifest, entry.runDir) as unknown as Record<string, unknown>;
  }
}
