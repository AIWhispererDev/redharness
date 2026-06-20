import path from 'node:path';
import { registry } from '../core/suiteRegistry.js';
import type { SuiteDefinition, SuiteContext, SuiteResult } from '../core/runTypes.js';
import { buildSuiteResult, serializeError } from '../core/adapters.js';
import { fromOkSkipped } from '../core/status.js';
import { loadPackFromDir } from '../pack.js';
import type { QaPack } from '../types.js';

// ---------------------------------------------------------------------------
// Helper: wrap a simple ok+checks+artifacts suite runner into SuiteDefinition.
// ---------------------------------------------------------------------------

type SimpleRunFn = (
  pack: QaPack,
  options: Record<string, unknown>,
) => Promise<{ ok: boolean; skipped?: boolean; checks: Array<{ name: string; ok: boolean; details: string[] }>; artifacts: string[] }>;

function adaptSimple(
  id: string,
  title: string,
  description: string,
  tags: string[],
  requirement: SuiteDefinition['requirement'],
  requires: SuiteDefinition['requires'],
  runFn: SimpleRunFn,
  estimatedDuration?: 'short' | 'medium' | 'long',
): SuiteDefinition {
  return {
    id,
    title,
    description,
    tags,
    requirement,
    dependencies: [],
    estimatedDuration,
    requires,
    async run(context: SuiteContext): Promise<SuiteResult> {
      const pack = await loadPackFromDir(context.packDir);
      const startedAt = new Date().toISOString();
      const startMs = Date.now();

      try {
        const opts: Record<string, unknown> = {};
        if (context.storageState) opts.storageState = context.storageState;
        if (context.nonProStorageState) opts.nonProStorageState = context.nonProStorageState;
        if (context.headless !== undefined) opts.headless = context.headless;
        if (context.outputDir) opts.outputDir = context.outputDir;
        if (context.prompt) opts.prompt = context.prompt;
        if (context.turns !== undefined) opts.turns = context.turns;
        if (context.maxTurns !== undefined) opts.maxTurns = context.maxTurns;
        if (context.refreshEvery !== undefined) opts.refreshEvery = context.refreshEvery;
        if (context.language) opts.language = context.language;
        if (context.confirmRuns !== undefined) opts.confirmRuns = context.confirmRuns;
        if (context.writeFindings !== undefined) opts.writeFindings = context.writeFindings;
        if (context.repo) opts.repo = context.repo;

        const result = await runFn(pack, opts);
        const endedAt = new Date().toISOString();
        return buildSuiteResult({
          suiteId: id,
          requirement,
          ok: result.ok,
          skipped: result.skipped,
          checks: result.checks,
          artifacts: result.artifacts,
          startedAt,
          endedAt,
          durationMs: Date.now() - startMs,
        });
      } catch (error) {
        const endedAt = new Date().toISOString();
        return {
          suiteId: id,
          status: 'error',
          requirement,
          startedAt,
          endedAt,
          durationMs: Date.now() - startMs,
          attempts: [{
            attempt: 1,
            status: 'error',
            startedAt,
            endedAt,
            durationMs: Date.now() - startMs,
            checks: [],
            error: serializeError(error),
          }],
          checks: [],
          artifacts: [],
          error: serializeError(error),
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helper: skip-state factory for suites that need storageState but it's missing
// ---------------------------------------------------------------------------

function skippedResult(id: string, requirement: SuiteDefinition['requirement'], reason: string): SuiteResult {
  const now = new Date().toISOString();
  return {
    suiteId: id,
    status: 'skipped',
    requirement,
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    attempts: [{
      attempt: 1,
      status: 'skipped',
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      checks: [{ name: 'Suite skipped', status: 'skipped', details: [reason] }],
    }],
    checks: [{ name: 'Suite skipped', status: 'skipped', details: [reason] }],
    artifacts: [],
    skipReason: reason,
  };
}

function skippedAdapter(
  id: string,
  title: string,
  description: string,
  tags: string[],
  requirement: SuiteDefinition['requirement'],
  requires: SuiteDefinition['requires'],
  checkPrerequisite: (context: SuiteContext) => string | null,
  runFn: SimpleRunFn,
  estimatedDuration?: 'short' | 'medium' | 'long',
): SuiteDefinition {
  return {
    id,
    title,
    description,
    tags,
    requirement,
    dependencies: [],
    estimatedDuration,
    requires,
    async run(context: SuiteContext): Promise<SuiteResult> {
      const skipReason = checkPrerequisite(context);
      if (skipReason) {
        // Skipped suites don't gate if optional; for required, policy handles it
        return skippedResult(id, requirement, skipReason);
      }
      // Delegate to the simple adapter
      const adapted = adaptSimple(id, title, description, tags, requirement, requires, runFn, estimatedDuration);
      return adapted.run(context);
    },
  };
}

function needsStorageState(context: SuiteContext): string | null {
  if (!context.storageState) return 'No --storage-state provided. Authenticated checks require a Playwright storage state file.';
  return null;
}

function needsNonProStorageState(context: SuiteContext): string | null {
  if (!context.nonProStorageState) return 'No --non-pro-storage-state provided. Changelog bypass test requires a non-Pro storage state.';
  return null;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { runPublicSmoke, summarizeSmokeResults } from '../smoke.js';
import { runPublicNavSmoke } from '../publicNavSmoke.js';
import { runBrowserSmoke } from '../browserSmoke.js';
import { runAuthSmoke } from '../authSmoke.js';
import { runCrucibleSmoke } from '../crucibleSmoke.js';
import { runProRegressionSmoke } from '../proRegressionSmoke.js';
import { runLongThreadSmoke } from '../longThreadSmoke.js';
import { runCompletionSmoke } from '../completionSmoke.js';
import { runMobileAuthSmoke } from '../mobileAuthSmoke.js';
import { runRecordExportSmoke } from '../recordExportSmoke.js';
import { runBillingSmoke, runLanguageSmoke, runWorkshopSmoke } from '../additionalSmoke.js';
import { runTargetedChangelogSmoke } from '../targetedChangelogSmoke.js';
import { runChaosSmoke } from '../chaosSmoke.js';
import { runSecuritySmoke } from '../securitySmoke.js';
import { runBlackboxPentest } from '../pentest.js';
import { runWhiteboxPentest } from '../whiteboxPentest.js';

// ---------------------------------------------------------------------------
// Register all suites
// ---------------------------------------------------------------------------

export function registerAllSuites(): void {
  // CLI, service, tests, and MCP may share a process. Registration is a
  // bootstrap operation and must be safe to call from more than one adapter.
  if (registry.get('public-routes')) return;

  registry.registerAll([

    // ---- Public (non-authenticated) suites ----
    {
      id: 'public-routes',
      title: 'Public Routes',
      description: 'HTTP GET pack-defined public routes and verify title + text content.',
      tags: ['smoke', 'public', 'release', 'fixture-release'],
      requirement: 'required',
      estimatedDuration: 'short',
      requires: ['baseUrl'],
      async run(context: SuiteContext): Promise<SuiteResult> {
        const loadedPack = await loadPackFromDir(context.packDir);
        const pack = { ...loadedPack, baseUrl: context.baseUrl ?? loadedPack.baseUrl };
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        try {
          const results = await runPublicSmoke(pack);
          const summary = summarizeSmokeResults(results);
          const endedAt = new Date().toISOString();
          return buildSuiteResult({
            suiteId: 'public-routes',
            requirement: 'required',
            ok: summary.ok,
            checks: results.map((r) => ({ name: r.name, ok: r.ok, details: r.details })),
            artifacts: [],
            startedAt,
            endedAt,
            durationMs: Date.now() - startMs,
          });
        } catch (error) {
          const endedAt = new Date().toISOString();
          return { suiteId: 'public-routes', status: 'error', requirement: 'required', startedAt, endedAt, durationMs: Date.now() - startMs, attempts: [], checks: [], artifacts: [], error: serializeError(error) };
        }
      },
    },

    {
      id: 'public-nav',
      title: 'Public Navigation',
      description: 'Browser-based checks for public navigation links and mobile hamburger menu.',
      tags: ['smoke', 'public', 'browser', 'release'],
      requirement: 'required',
      estimatedDuration: 'short',
      requires: ['baseUrl'],
      async run(context: SuiteContext): Promise<SuiteResult> {
        const pack = await loadPackFromDir(context.packDir);
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        try {
          const result = await runPublicNavSmoke(pack, {
            headless: context.headless ?? true,
            outputDir: context.outputDir ? path.join(context.outputDir, 'public-nav') : undefined,
          });
          const endedAt = new Date().toISOString();
          return buildSuiteResult({ suiteId: 'public-nav', requirement: 'required', ok: result.ok, checks: result.checks, artifacts: result.artifacts ?? [], startedAt, endedAt, durationMs: Date.now() - startMs });
        } catch (error) {
          const endedAt = new Date().toISOString();
          return { suiteId: 'public-nav', status: 'error', requirement: 'required', startedAt, endedAt, durationMs: Date.now() - startMs, attempts: [], checks: [], artifacts: [], error: serializeError(error) };
        }
      },
    },

    {
      id: 'early-access-tos',
      title: 'Early Access / TOS',
      description: 'Browser interaction smoke checks for the early-access invite gate and TOS modal.',
      tags: ['smoke', 'public', 'browser', 'release'],
      requirement: 'required',
      estimatedDuration: 'short',
      requires: ['baseUrl'],
      async run(context: SuiteContext): Promise<SuiteResult> {
        const pack = await loadPackFromDir(context.packDir);
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        try {
          const result = await runBrowserSmoke(pack, {
            headless: context.headless ?? true,
            outputDir: context.outputDir ? path.join(context.outputDir, 'early-access') : undefined,
          });
          const endedAt = new Date().toISOString();
          return buildSuiteResult({ suiteId: 'early-access-tos', requirement: 'required', ok: result.ok, checks: result.checks, artifacts: result.artifacts ?? [], startedAt, endedAt, durationMs: Date.now() - startMs });
        } catch (error) {
          const endedAt = new Date().toISOString();
          return { suiteId: 'early-access-tos', status: 'error', requirement: 'required', startedAt, endedAt, durationMs: Date.now() - startMs, attempts: [], checks: [], artifacts: [], error: serializeError(error) };
        }
      },
    },

    // ---- Authenticated suites (skip when no storageState) ----
    skippedAdapter(
      'authenticated-dashboard',
      'Authenticated Dashboard',
      'Browser checks for the authenticated dashboard, nav, console, and network.',
      ['smoke', 'authenticated', 'release'],
      'required',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runAuthSmoke({ baseUrl: pack.baseUrl!, storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined }) as Promise<any>,
      'short',
    ),

    skippedAdapter(
      'crucible',
      'Crucible',
      'Send a smoke prompt to Soc in the Crucible and scan for style violations.',
      ['smoke', 'authenticated', 'release'],
      'required',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runCrucibleSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined, prompt: opts.prompt ? String(opts.prompt) : undefined }) as Promise<any>,
      'medium',
    ),

    skippedAdapter(
      'pro-regression',
      'Pro Regression',
      'Authenticated Pro/Solo thread regression: turns, persistence, style scan.',
      ['smoke', 'authenticated', 'ai-quality', 'release'],
      'required',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runProRegressionSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined, turns: opts.turns ? Number(opts.turns) : undefined }) as Promise<any>,
      'medium',
    ),

    skippedAdapter(
      'long-thread',
      'Long Thread',
      'Long-running Pro/Solo thread stability with timing and refresh persistence.',
      ['smoke', 'authenticated', 'ai-quality', 'long', 'nightly'],
      'optional',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runLongThreadSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined, turns: opts.turns ? Number(opts.turns) : undefined, refreshEvery: opts.refreshEvery ? Number(opts.refreshEvery) : undefined }) as Promise<any>,
      'long',
    ),

    skippedAdapter(
      'completion',
      'Completion',
      'Drive a Pro/Solo thread toward Landing/completion and record stage timeline.',
      ['smoke', 'authenticated', 'ai-quality', 'long', 'nightly'],
      'optional',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runCompletionSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined, maxTurns: opts.maxTurns ? Number(opts.maxTurns) : undefined }) as Promise<any>,
      'long',
    ),

    skippedAdapter(
      'mobile-auth',
      'Mobile Authenticated',
      'Authenticated mobile viewport dashboard and app-shell checks.',
      ['smoke', 'authenticated', 'mobile', 'release'],
      'optional',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runMobileAuthSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined }) as Promise<any>,
      'short',
    ),

    skippedAdapter(
      'record-export',
      'Record Export',
      'Records/Documents and export/download graceful-state checks.',
      ['smoke', 'authenticated', 'release'],
      'required',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runRecordExportSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined }) as Promise<any>,
      'medium',
    ),

    skippedAdapter(
      'billing',
      'Billing',
      'Account page and billing portal graceful-state checks.',
      ['smoke', 'authenticated', 'release'],
      'optional',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runBillingSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined }) as Promise<any>,
      'short',
    ),

    skippedAdapter(
      'language',
      'Language',
      'Language selector menu and target language discoverability.',
      ['smoke', 'authenticated', 'release'],
      'optional',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runLanguageSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined, language: opts.language ? String(opts.language) : undefined }) as Promise<any>,
      'short',
    ),

    skippedAdapter(
      'workshop',
      'Workshop',
      'Roots/Echoes/Workshop surface and star interaction checks.',
      ['smoke', 'authenticated', 'release'],
      'optional',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runWorkshopSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined }) as Promise<any>,
      'short',
    ),

    // ---- Changelog-targeted (needs non-Pro state) ----
    skippedAdapter(
      'changelog-targeted',
      'Changelog Targeted',
      'Targeted checks for selected changelog items including Pro bypass test.',
      ['smoke', 'authenticated', 'release'],
      'required',
      ['baseUrl', 'storageState', 'nonProStorageState'],
      // Allow running even without nonProStorageState; the suite handles optional state internally
      (context) => {
        if (!context.storageState) return 'No --storage-state provided.';
        return null;
      },
      (pack, opts) => runTargetedChangelogSmoke(pack, {
        storageState: String(opts.storageState ?? ''),
        nonProStorageState: opts.nonProStorageState ? String(opts.nonProStorageState) : undefined,
        headless: opts.headless !== false,
        outputDir: opts.outputDir ? String(opts.outputDir) : undefined,
      }) as Promise<any>,
      'medium',
    ),

    // ---- Exploratory / Chaos (tagged out of default smoke) ----
    skippedAdapter(
      'chaos',
      'Chaos',
      'Aggressive exploratory/chaos probes to surface likely bugs.',
      ['exploratory', 'nightly'],
      'informational',
      ['baseUrl', 'storageState'],
      needsStorageState,
      (pack, opts) => runChaosSmoke(pack, { storageState: String(opts.storageState ?? ''), headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined }) as Promise<any>,
      'medium',
    ),

    // ---- Security suites ----
    skippedAdapter(
      'security-smoke',
      'Security Smoke',
      'Safe HackZero-style security smoke checks: headers, cookies, exposure, auth gates, bundles.',
      ['smoke', 'security', 'release'],
      'required',
      ['baseUrl'],
      () => null, // security smoke can run with or without storageState
      (pack, opts) => runSecuritySmoke(pack, { storageState: opts.storageState ? String(opts.storageState) : undefined, headless: opts.headless !== false, outputDir: opts.outputDir ? String(opts.outputDir) : undefined, writeFindings: opts.writeFindings === true }) as Promise<any>,
      'medium',
    ),

    // ---- Pentest suites (tagged out of default smoke) ----
    {
      id: 'blackbox-pentest',
      title: 'Black-box Pentest',
      description: 'Safe URL-only blackbox pentest probes with confirmed replay.',
      tags: ['pentest', 'security', 'exploratory', 'nightly'],
      requirement: 'informational',
      estimatedDuration: 'medium',
      requires: ['baseUrl'],
      async run(context: SuiteContext): Promise<SuiteResult> {
        const pack = await loadPackFromDir(context.packDir);
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        try {
          const result = await runBlackboxPentest(pack, {
            url: context.baseUrl,
            outputDir: context.outputDir ? path.join(context.outputDir, 'blackbox-pentest') : undefined,
            confirmRuns: context.confirmRuns ?? 2,
          });
          const endedAt = new Date().toISOString();
          return buildSuiteResult({
            suiteId: 'blackbox-pentest',
            requirement: 'informational',
            ok: result.ok,
            checks: result.checks.map((c) => ({ name: c.name, ok: c.ok, details: c.details })),
            artifacts: result.artifacts ?? [],
            startedAt,
            endedAt,
            durationMs: Date.now() - startMs,
          });
        } catch (error) {
          const endedAt = new Date().toISOString();
          return { suiteId: 'blackbox-pentest', status: 'error', requirement: 'informational', startedAt, endedAt, durationMs: Date.now() - startMs, attempts: [], checks: [], artifacts: [], error: serializeError(error) };
        }
      },
    },

    {
      id: 'whitebox-pentest',
      title: 'White-box Pentest',
      description: 'Repo-aware whitebox route discovery plus live auth-gate probes.',
      tags: ['pentest', 'security', 'exploratory', 'nightly'],
      requirement: 'informational',
      estimatedDuration: 'medium',
      requires: ['baseUrl', 'repo'],
      async run(context: SuiteContext): Promise<SuiteResult> {
        const pack = await loadPackFromDir(context.packDir);
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        try {
          const result = await runWhiteboxPentest(pack, {
            repo: context.repo!,
            url: context.baseUrl,
            outputDir: context.outputDir ? path.join(context.outputDir, 'whitebox-pentest') : undefined,
            confirmRuns: context.confirmRuns ?? 2,
          });
          const endedAt = new Date().toISOString();
          return buildSuiteResult({
            suiteId: 'whitebox-pentest',
            requirement: 'informational',
            ok: result.ok,
            checks: result.checks.map((c) => ({ name: c.name, ok: c.ok, details: c.details })),
            artifacts: result.artifacts ?? [],
            startedAt,
            endedAt,
            durationMs: Date.now() - startMs,
          });
        } catch (error) {
          const endedAt = new Date().toISOString();
          return { suiteId: 'whitebox-pentest', status: 'error', requirement: 'informational', startedAt, endedAt, durationMs: Date.now() - startMs, attempts: [], checks: [], artifacts: [], error: serializeError(error) };
        }
      },
    },

    // ---- Agent evaluation suite ----
    {
      id: 'agent-evaluation',
      title: 'Agent Evaluation',
      description: 'Run agent scenarios as versioned dataset trials with trace-backed grades.',
      tags: ['agent', 'release', 'evaluation'],
      requirement: 'optional',
      estimatedDuration: 'medium',
      requires: ['baseUrl'],
      async run(context: SuiteContext): Promise<SuiteResult> {
        const startedAt = new Date().toISOString();
        const startMs = Date.now();

        try {
          const { loadScenariosFromDir, loadDatasetManifest, resolveScenarioAgent } = await import('../scenarios/loader.js');
          const { runScenario } = await import('../scenarios/runner.js');
          const { graderRegistry } = await import('../graders/registry.js');
          const { computeDatasetHash } = await import('../datasets/manifest.js');

          const datasetDir = path.join(context.packDir, 'datasets', 'agent-eval');
          let scenarios = await loadScenariosFromDir(datasetDir);
          let manifest = await loadDatasetManifest(datasetDir);

          // Fall back to 'core' dataset for agent scenarios
          if (scenarios.length === 0) {
            const coreDir = path.join(context.packDir, 'datasets', 'core');
            scenarios = await loadScenariosFromDir(coreDir);
            manifest = await loadDatasetManifest(coreDir);

            // Filter to agent-kind scenarios only
            scenarios = scenarios.filter((s) => s.actor.kind === 'agent');
          }

          if (scenarios.length === 0) {
            return skippedResult('agent-evaluation', 'optional', 'No agent scenarios found in dataset');
          }

          const checks: Array<{ name: string; ok: boolean; details: string[] }> = [];
          const artifacts: string[] = [];
          let allOk = true;

          for (const scenario of scenarios) {
            const graders = (scenario.graders ?? []).map((def) => {
              const config = def.type === 'trajectory'
                ? { constraint: scenario.trajectory ?? def.config ?? {} }
                : def.config;
              return graderRegistry.create(def.type, config);
            });

            // Resolve agent config for tracking
            const agentInfo = resolveScenarioAgent(scenario);

            const result = await runScenario(scenario, {
              packDir: context.packDir,
              baseUrl: context.baseUrl ?? '',
              storageState: context.storageState,
              headless: context.headless ?? true,
              outputDir: context.outputDir ? path.join(context.outputDir, 'agent-evaluation') : undefined,
              graders,
              dataset: manifest ? {
                id: String((manifest as any).id ?? 'agent-eval'),
                version: String((manifest as any).version ?? '1.0.0'),
                contentHash: String((manifest as any).contentHash ?? ''),
              } : undefined,
            });

            const passCount = result.trials.filter((t) => t.status === 'passed').length;
            const totalTrials = result.trials.length;
            const scenarioOk = result.status === 'passed';

            const details = [
              `Status: ${result.status}`,
              `Trials: ${passCount}/${totalTrials} passed`,
              `Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
              `Grades: ${result.graderVersions.map((g) => `${g.id}@${g.version}`).join(', ')}`,
            ];

            if (agentInfo) {
              details.push(`Agent: ${agentInfo.config.agentId}@${agentInfo.config.version} (hash: ${agentInfo.hash})`);
            }

            checks.push({
              name: scenario.id,
              ok: scenarioOk,
              details,
            });

            if (!scenarioOk) allOk = false;
          }

          const endedAt = new Date().toISOString();
          return buildSuiteResult({
            suiteId: 'agent-evaluation',
            requirement: 'optional',
            ok: allOk,
            checks,
            artifacts,
            startedAt,
            endedAt,
            durationMs: Date.now() - startMs,
          });
        } catch (error) {
          const endedAt = new Date().toISOString();
          return {
            suiteId: 'agent-evaluation',
            status: 'error',
            requirement: 'optional',
            startedAt,
            endedAt,
            durationMs: Date.now() - startMs,
            attempts: [],
            checks: [],
            artifacts: [],
            error: serializeError(error),
          };
        }
      },
    },
  ]);
}
