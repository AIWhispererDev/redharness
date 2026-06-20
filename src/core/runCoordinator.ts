import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { registry } from './suiteRegistry.js';
import type { ExecutionStatus } from './status.js';
import type {
  SuiteDefinition,
  SuiteContext,
  SuiteResult,
  RunManifest,
  RunPolicy,
  RunSelection,
  SuiteResultSummary,
  RunConfigHash,
} from './runTypes.js';
import { evaluateRunPolicy } from './resultPolicy.js';
import { isRetryable } from './resultPolicy.js';
import { saveManifest, computeConfigHash } from './resumeStore.js';
import { TraceWriter } from '../trace/traceWriter.js';
import { ArtifactStore } from '../artifacts/artifactStore.js';
import { redactDeep } from '../trace/redaction.js';

export type CoordinatorOptions = {
  packDir: string;
  packId: string;
  source: RunManifest['source'];
  selection: RunSelection;
  policy: RunPolicy;
  profile?: string;
  baseUrl?: string;
  storageState?: string;
  nonProStorageState?: string;
  repo?: string;
  headless?: boolean;
  outputBaseDir?: string;
  runDir?: string;
  runId?: string;
  /** Pre-existing results to include without re-executing (for resume). */
  existingResults?: SuiteResultSummary[];
  /** Only run these suite IDs (subset of selection). */
  pendingSuiteIds?: string[];
};

/**
 * Run coordinator: orchestrates suite execution with dependency ordering,
 * bounded parallelism, retries, result normalization, and aggregate policy.
 */
export class RunCoordinator {
  private options: CoordinatorOptions;
  private context: SuiteContext;
  private manifest: RunManifest;
  private runDir: string;
  private existingResults: SuiteResultSummary[];
  /** Global abort controller for the entire run. */
  private abortController: AbortController;
  /** null = no filtering (run everything), empty Set = nothing to run (completed resume) */
  private pendingSuiteIds: Set<string> | null;
  private traceWriter: TraceWriter;
  private runSpanId?: string;

  constructor(options: CoordinatorOptions) {
    this.options = options;
    this.existingResults = options.existingResults ?? [];
    // undefined = no resume = no filtering = null
    // empty array = all suites completed = filter to nothing = empty Set
    // non-empty array = specific suites to re-run
    this.pendingSuiteIds = options.pendingSuiteIds === undefined
      ? null
      : new Set(options.pendingSuiteIds);
    this.abortController = new AbortController();
    const runId = options.runId ?? `${options.packId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const runDir = options.runDir ?? path.resolve(options.outputBaseDir ?? process.cwd(), 'runs', options.packId, runId);
    this.runDir = runDir;
    this.traceWriter = new TraceWriter(runDir);
    this.context = {
      packDir: options.packDir,
      baseUrl: options.baseUrl,
      storageState: options.storageState,
      nonProStorageState: options.nonProStorageState,
      repo: options.repo,
      headless: options.headless ?? true,
      outputDir: runDir,
    };
    this.manifest = {
      schemaVersion: '1',
      runId,
      packId: options.packId,
      profile: options.profile,
      status: 'passed',
      startedAt: new Date().toISOString(),
      source: options.source,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        ci: !!process.env.CI,
      },
      selection: options.selection,
      policy: options.policy,
      suiteResults: [],
    };
  }

  /** The directory where run artifacts are stored. */
  getRunDir(): string {
    return this.runDir;
  }

  /** Abort the run — signals all in-flight suites to cancel. */
  abort(): void {
    this.abortController.abort();
  }

  /** Whether this run has been aborted. */
  isAborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /** The current manifest (may be mutated during execution). */
  getManifest(): RunManifest {
    return this.manifest;
  }

  /** Compute a config hash for resume compatibility. */
  getConfigHash(): string {
    const config: RunConfigHash = {
      packId: this.options.packId,
      profile: this.options.profile,
      policy: this.options.policy,
      selection: this.options.selection,
      source: this.options.source,
    };
    return computeConfigHash(config);
  }

  /**
   * Execute the selected suites.
   *
   * Returns the complete run manifest after execution.
   */
  async execute(): Promise<RunManifest> {
    await mkdir(this.runDir, { recursive: true });
    this.runSpanId = this.traceWriter.startSpan({
      name: `run:${this.manifest.runId}`,
      kind: 'run',
      attemptId: 'run',
      attributes: {
        runId: this.manifest.runId,
        packId: this.manifest.packId,
        source: this.manifest.source,
      },
    });

    // Select suites
    let selected = registry.select(this.options.selection);

    // Filter by pending suite IDs (for resume)
    if (this.pendingSuiteIds) {
      selected = selected.filter((s) => this.pendingSuiteIds!.has(s.id));
    }

    // Include pre-existing results (for resume)
    const results: SuiteResultSummary[] = [...this.existingResults];

    // Resolve dependency ordering
    const ordered = registry.resolveOrder(selected);

    // Persist the run before starting work so an interrupted run is discoverable
    // and resumable even when the first suite never completes.
    this.manifest.configHash = this.getConfigHash();
    await saveManifest(this.runDir, this.manifest);

    // Execute with bounded parallelism
    await this.executePool(ordered, results);

    // Write each suite result to its own file (full + summary)
    for (const result of results) {
      const suiteDir = path.join(this.runDir, 'suites', result.suiteId);
      await mkdir(suiteDir, { recursive: true });
      await writeFile(
        path.join(suiteDir, 'summary.json'),
        JSON.stringify(redactDeep(result).result, null, 2),
        'utf8',
      );
      // Write full result (with checks, artifacts, attempts) if available
      const full = this.fullResults.get(result.suiteId);
      if (full) {
        await writeFile(
          path.join(suiteDir, 'result.json'),
          JSON.stringify(redactDeep(full).result, null, 2),
          'utf8',
        );
      }
    }

    // Finalize manifest
    this.manifest.suiteResults = results;
    this.manifest.durationMs = Date.now() - new Date(this.manifest.startedAt).getTime();
    this.manifest.endedAt = new Date().toISOString();

    // Evaluate run policy
    const policyResult = evaluateRunPolicy(results);
    this.manifest.status = policyResult.status;
    this.traceWriter.endSpan(
      this.runSpanId,
      this.manifest.status === 'passed'
        ? 'ok'
        : this.manifest.status === 'cancelled'
          ? 'cancelled'
          : 'error',
      { status: this.manifest.status },
    );
    await this.traceWriter.flush();

    // Store config hash for resume compatibility
    this.manifest.configHash = this.getConfigHash();

    // Final write — incremental writes happened after each suite
    await saveManifest(this.runDir, this.manifest);

    return this.manifest;
  }

  /**
   * Execute suites with proper dependency ordering.
   *
   * Each suite only runs after all its selected dependencies have completed.
   * Independent suites run concurrently up to `maxWorkers`.
   * Dependents are not scheduled if their prerequisite failed/errored/cancelled.
   */
  private async executePool(
    ordered: SuiteDefinition[],
    results: SuiteResultSummary[],
  ): Promise<void> {
    const concurrency = this.options.policy.maxWorkers ?? 4;
    const retryErrors = this.options.policy.retryErrors ?? 0;
    const timeoutMs = this.options.policy.timeoutMs;

    const selectedIds = new Set(ordered.map((s) => s.id));
    const completed = new Set<string>();
    const failed = new Set<string>();
    // Build dependency sets (only among selected suites)
    const deps = new Map<string, string[]>();
    for (const suite of ordered) {
      deps.set(suite.id, (suite.dependencies ?? []).filter((d) => selectedIds.has(d)));
    }

    // All suites by id for lookup
    const byId = new Map(ordered.map((s) => [s.id, s]));
    const remaining = new Set(ordered.map((s) => s.id));
    const running = new Set<Promise<void>>();
    /** Return the next suite whose dependencies are all met and none failed. */
    function nextReady(): SuiteDefinition | undefined {
      for (const id of remaining) {
        const suite = byId.get(id);
        if (!suite) continue;
        const deps_ = deps.get(id) ?? [];
        const unmet = deps_.filter((d) => !completed.has(d) && !failed.has(d));
        // A dependency that failed blocks this suite
        const blockedByFailure = deps_.some((d) => failed.has(d));
        if (unmet.length === 0 && !blockedByFailure) {
          return suite;
        }
      }
      return undefined;
    }

    /** Persist incremental state so crashes are resumable. */
    const persistIncremental = async (): Promise<void> => {
      this.manifest.suiteResults = [...results];
      this.manifest.configHash = this.getConfigHash();
      await saveManifest(this.runDir, this.manifest);
    };

    /** Run one suite and return when done (or timeout). */
    const runOne = async (suite: SuiteDefinition): Promise<void> => {
      remaining.delete(suite.id);

      const ac = new AbortController();
      const suiteSpanId = this.traceWriter.startSpan({
        name: `suite:${suite.id}`,
        kind: 'suite',
        parentSpanId: this.runSpanId,
        attemptId: `${suite.id}:1`,
        attributes: { suiteId: suite.id, requirement: suite.requirement },
      });
      // Link to the global abort controller — when the run is cancelled,
      // all in-flight suite abort controllers are also triggered.
      const cancelHandler = () => { if (!ac.signal.aborted) ac.abort(); };
      this.abortController.signal.addEventListener('abort', cancelHandler, { once: true });

      const makeResult = (
        status: ExecutionStatus,
        reason: string,
        durationMs = 0,
      ): SuiteResultSummary => ({
        suiteId: suite.id,
        title: suite.title,
        status,
        requirement: suite.requirement,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs,
        attemptCount: 0,
        ...(status === 'skipped'
          ? { skipReason: reason }
          : { error: { message: reason } }),
      });

      const missingRequirement = this.getMissingRequirement(suite);
      if (missingRequirement) {
        results.push(makeResult(
          'skipped',
          `Missing required context: ${missingRequirement}`,
        ));
        await persistIncremental();
        this.traceWriter.endSpan(suiteSpanId, 'cancelled', {
          status: 'skipped',
          skipReason: `Missing required context: ${missingRequirement}`,
        });
        await this.traceWriter.flush();
        this.abortController.signal.removeEventListener('abort', cancelHandler);
        return;
      }

      type Outcome =
        | { kind: 'completed'; result: SuiteResultSummary }
        | { kind: 'timeout' }
        | { kind: 'cancelled' };

      const attemptId = `${suite.id}:${results.length + 1}`;
      const firstAttemptDir = path.join(
        this.runDir,
        'suites',
        suite.id,
        'attempts',
        'attempt-1',
      );
      const artifactStore = new ArtifactStore(
        firstAttemptDir,
        this.manifest.runId,
        {
          traceWriter: this.traceWriter,
          parentSpanId: suiteSpanId,
          attemptId,
        },
      );
      const suiteContext: SuiteContext = {
        ...this.context,
        outputDir: path.join(this.runDir, 'suites', suite.id, 'attempts'),
        abortSignal: ac.signal,
        traceId: this.traceWriter.getTraceId(),
        spanId: suiteSpanId,
        attemptId,
        artifactStore,
        traceWriter: this.traceWriter,
      };
      const runPromise: Promise<Outcome> = this.executeSuite(
        suite,
        retryErrors,
        suiteContext,
      ).then((result) => ({ kind: 'completed', result }));

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      const timeoutPromise = timeoutMs
        ? new Promise<Outcome>((resolve) => {
            timeoutHandle = setTimeout(() => {
              timedOut = true;
              ac.abort();
              resolve({ kind: 'timeout' });
            }, timeoutMs);
          })
        : new Promise<Outcome>(() => {});
      let resolveCancellation: ((outcome: Outcome) => void) | undefined;
      const cancellationHandler = () => {
        if (!timedOut) resolveCancellation?.({ kind: 'cancelled' });
      };
      const cancelPromise = new Promise<Outcome>((resolve) => {
        resolveCancellation = resolve;
        if (this.abortController.signal.aborted) {
          resolve({ kind: 'cancelled' });
          return;
        }
        this.abortController.signal.addEventListener(
          'abort',
          cancellationHandler,
          { once: true },
        );
      });

      const outcome = await Promise.race([
        runPromise,
        timeoutPromise,
        cancelPromise,
      ]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.abortController.signal.removeEventListener('abort', cancelHandler);
      this.abortController.signal.removeEventListener(
        'abort',
        cancellationHandler,
      );

      if (outcome.kind === 'completed') {
        results.push(outcome.result);
        if (outcome.result.status === 'passed') completed.add(suite.id);
        else failed.add(suite.id);
      } else {
        const reason = outcome.kind === 'timeout'
          ? `Suite timed out after ${timeoutMs}ms`
          : 'Suite cancelled via run abort signal';
        results.push(makeResult(
          'cancelled',
          reason,
          outcome.kind === 'timeout' ? timeoutMs : 0,
        ));
        failed.add(suite.id);
        // The suite may not cooperate with cancellation, but evidence already
        // written by the time the bound fires is still flushed and indexed.
        await artifactStore.saveManifest(
          attemptId,
          this.traceWriter.getTraceId(),
        );
      }
      const recorded = results[results.length - 1];
      this.traceWriter.endSpan(
        suiteSpanId,
        recorded.status === 'passed'
          ? 'ok'
          : recorded.status === 'cancelled'
            ? 'cancelled'
            : 'error',
        { status: recorded.status, durationMs: recorded.durationMs },
      );
      await this.traceWriter.flush();
      await persistIncremental();
    };

    // Main scheduling loop
    while (remaining.size > 0 || running.size > 0) {
      // Launch as many ready suites as concurrency allows
      while (
        running.size < concurrency &&
        !this.abortController.signal.aborted
      ) {
        const next = nextReady();
        if (!next) break;
        const p = runOne(next).catch(() => {});
        running.add(p);
        p.finally(() => running.delete(p));
      }

      if (running.size === 0) {
        // If nothing is running and no suite is ready, record any remaining
        // suites as blocked/skipped due to dependency failures or global abort.
        for (const id of remaining) {
          const suite = byId.get(id);
          if (!suite) continue;
          const deps_ = deps.get(id) ?? [];
          const failedDep = deps_.find((d) => failed.has(d));
          const cancelled = this.abortController.signal.aborted;
          const reason = cancelled
            ? 'Run was cancelled'
            : failedDep
              ? `Dependency suite "${failedDep}" failed — skipping "${suite.id}"`
              : 'Unresolved dependency — skipping';
          const blocked: SuiteResultSummary = {
            suiteId: suite.id,
            title: suite.title,
            status: cancelled ? 'cancelled' : 'skipped',
            requirement: suite.requirement,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: 0,
            attemptCount: 0,
            ...(cancelled
              ? { error: { message: reason } }
              : { skipReason: reason }),
          };
          results.push(blocked);
          remaining.delete(id);
        }
        await persistIncremental();
        break;
      }

      // Wait for at least one to finish
      await Promise.race(running);
    }
  }

  /** Track the full SuiteResult for each suite for detailed persistence. */
  private fullResults = new Map<string, SuiteResult>();

  private getMissingRequirement(suite: SuiteDefinition): string | undefined {
    for (const requirement of suite.requires ?? []) {
      if (!this.context[requirement]) return requirement;
    }
    return undefined;
  }

  private async executeSuite(
    suite: SuiteDefinition,
    retryErrors: number,
    suiteContext?: SuiteContext,
  ): Promise<SuiteResultSummary> {
    const baseCtx = suiteContext ?? this.context;
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    const allAttempts: SuiteResult[] = [];
    let suiteResult: SuiteResult;

    // Each attempt gets a numbered subdirectory for artifact isolation
    const attemptDir = (attemptNum: number) =>
      path.join(baseCtx.outputDir ?? this.runDir, `attempt-${attemptNum}`);
    // Create attempt-scoped artifact store for this suite execution
    const store = baseCtx.artifactStore ??
      new ArtifactStore(attemptDir(1), this.manifest.runId, {
        traceWriter: this.traceWriter,
        parentSpanId: baseCtx.spanId,
        attemptId: baseCtx.attemptId,
      });
    const attemptId = baseCtx.attemptId ?? `${suite.id}:1`;

    /** Persist attempt evidence and flush trace. */
    const persistEvidence = async (attemptStore: ArtifactStore, persistedAttemptId: string): Promise<void> => {
      await this.traceWriter.flush();
      await attemptStore.saveManifest(
        persistedAttemptId,
        this.traceWriter.getTraceId(),
      );
    };

    try {
      if (baseCtx.abortSignal?.aborted) {
        throw new DOMException('Suite cancelled before execution', 'AbortError');
      }
      const attemptCtx: SuiteContext = { ...baseCtx, outputDir: attemptDir(1), artifactStore: store, attemptId };
      suiteResult = await suite.run(attemptCtx);
    } catch (error) {
      suiteResult = {
        suiteId: suite.id,
        status: 'error',
        requirement: suite.requirement,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        attempts: [],
        checks: [],
        artifacts: [],
        error: { message: String(error instanceof Error ? error.message : error) },
      };
    }
    await persistEvidence(store, attemptId);
    allAttempts.push(suiteResult);

    // Retry attempts for error/cancelled — each with its own artifact directory
    let attempts = 1;
    while (
      isRetryable(suiteResult.status) &&
      attempts <= retryErrors &&
      !baseCtx.abortSignal?.aborted
    ) {
      attempts++;
      const retryAttemptId = `${suite.id}:attempt-${attempts}`;
      const retryStore = new ArtifactStore(
        attemptDir(attempts),
        this.manifest.runId,
        {
          traceWriter: this.traceWriter,
          parentSpanId: baseCtx.spanId,
          attemptId: retryAttemptId,
        },
      );
      const retryCtx: SuiteContext = { ...baseCtx, outputDir: attemptDir(attempts), artifactStore: retryStore, attemptId: retryAttemptId };
      try {
        suiteResult = await suite.run(retryCtx);
      } catch (error) {
        suiteResult = {
          suiteId: suite.id,
          status: 'error',
          requirement: suite.requirement,
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          attempts: [],
          checks: [],
          artifacts: [],
          error: { message: String(error instanceof Error ? error.message : error) },
        };
      }
      await persistEvidence(retryStore, retryAttemptId);
      allAttempts.push(suiteResult);
    }

    // Use the last attempt's timing; all attempts preserved in the final result
    const lastAttempt = allAttempts[allAttempts.length - 1];
    // Store the full result for detailed persistence
    const fullResult: SuiteResult = {
      ...lastAttempt,
      suiteId: suite.id,
      requirement: suite.requirement,
      attempts: allAttempts.flatMap((a) => a.attempts),
    };
    this.fullResults.set(suite.id, fullResult);

    const endedAt = new Date().toISOString();
    return {
      suiteId: suite.id,
      title: suite.title,
      status: lastAttempt.status,
      requirement: suite.requirement,
      startedAt: allAttempts[0].startedAt,
      endedAt: lastAttempt.endedAt,
      durationMs: lastAttempt.durationMs,
      attemptCount: attempts,
      skipReason: lastAttempt.skipReason,
      error: lastAttempt.error,
    };
  }
}
