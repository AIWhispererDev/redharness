import path from 'node:path';
import { fromOkSkipped } from './status.js';
import type { ExecutionStatus } from './status.js';
import type { SuiteResult, CheckResult, ArtifactRef, SerializedError } from './runTypes.js';
import type { BrowserSmokeCheck } from '../types.js';

/** Normalize a harness-level error into a SerializedError. */
export function serializeError(error: unknown): SerializedError | undefined {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

/** Normalize a BrowserSmokeCheck array into CheckResult[]. */
export function normalizeChecks(
  checks: BrowserSmokeCheck[],
): CheckResult[] {
  return checks.map((c) => ({
    name: c.name,
    status: fromOkSkipped(c.ok),
    details: c.details ?? [],
  }));
}

/** Normalize string artifact paths into ArtifactRef[]. */
export function normalizeArtifacts(artifactPaths: string[]): ArtifactRef[] {
  return artifactPaths.map((p) => ({
    path: path.resolve(p),
    type: path.extname(p).slice(1) || undefined,
  }));
}

/** Convert a result's ok/skipped to a status, handling 'error' for exceptions. */
export function normalizeSuiteStatus(
  ok: boolean,
  skipped?: boolean,
  error?: unknown,
): ExecutionStatus {
  if (error) return 'error';
  return fromOkSkipped(ok, skipped);
}

/** Build a SuiteResult from the common result pattern: checks + artifacts + ok/skipped. */
export function buildSuiteResult(params: {
  suiteId: string;
  requirement: import('../core/runTypes.js').RequirementPolicy;
  ok: boolean;
  skipped?: boolean;
  checks: BrowserSmokeCheck[];
  artifacts: string[];
  error?: unknown;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  skipReason?: string;
}): SuiteResult {
  return {
    suiteId: params.suiteId,
    status: normalizeSuiteStatus(params.ok, params.skipped, params.error),
    requirement: params.requirement,
    startedAt: params.startedAt,
    endedAt: params.endedAt,
    durationMs: params.durationMs,
    attempts: [
      {
        attempt: 1,
        status: normalizeSuiteStatus(params.ok, params.skipped, params.error),
        startedAt: params.startedAt,
        endedAt: params.endedAt,
        durationMs: params.durationMs,
        checks: normalizeChecks(params.checks),
        error: serializeError(params.error),
      },
    ],
    checks: normalizeChecks(params.checks),
    artifacts: normalizeArtifacts(params.artifacts),
    skipReason: params.skipReason,
    error: serializeError(params.error),
  };
}
