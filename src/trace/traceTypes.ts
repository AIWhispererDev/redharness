/**
 * PRD 02: Unified trace model inspired by OpenTelemetry GenAI conventions.
 *
 * Every suite, scenario, trial, browser action, HTTP request, model
 * generation, agent invocation, tool execution, grader score, and
 * artifact write produces spans in a single correlated trace.
 */

import type { ExecutionStatus } from '../core/status.js';

/** Primitive JSON-compatible value. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Span kind — mirrors the PRD 02 taxonomy. */
export type SpanKind =
  | 'run'
  | 'suite'
  | 'scenario'
  | 'browser.action'
  | 'http.request'
  | 'model.generate'
  | 'agent.invoke'
  | 'agent.plan'
  | 'tool.execute'
  | 'grader.score'
  | 'artifact.write'
  | 'policy.check'
  | 'policy.approval'
  | 'checkpoint.save'
  | 'checkpoint.load'
  | 'cleanup';

/** A single event within a span (e.g. a sub-step or state change). */
export type TraceEvent = {
  name: string;
  timestamp: string;
  attributes: Record<string, JsonValue>;
};

/** Span-oriented trace segment. */
export type TraceSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attemptId: string;
  name: string;
  kind: SpanKind;
  startedAt: string;
  endedAt?: string;
  status: 'ok' | 'error' | 'cancelled';
  attributes: Record<string, JsonValue>;
  events: TraceEvent[];
};

/** Correlation IDs linking run → suite → scenario → trial → attempt → trace. */
export type TraceCorrelation = {
  runId: string;
  suiteId?: string;
  scenarioId?: string;
  trialId?: string;
  attemptId: string;
  traceId: string;
};

// ---------------------------------------------------------------------------
// Evidence manifest types
// ---------------------------------------------------------------------------

/** Integrity-checked artifact reference. */
export type ArtifactRef = {
  id: string;
  kind: string;
  relativePath: string;
  mediaType: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  traceId?: string;
  spanId?: string;
  redacted: boolean;
};

/** Evidence manifest for a single finding or attempt. */
export type EvidenceManifest = {
  runId: string;
  attemptId: string;
  traceId: string;
  artifacts: ArtifactRef[];
  redactionSummary: RedactionEntry[];
};

// ---------------------------------------------------------------------------
// Redaction types
// ---------------------------------------------------------------------------

export type RedactionEntry = {
  fieldPath: string;
  ruleId: string;
};

// ---------------------------------------------------------------------------
// Semantic action log types
// ---------------------------------------------------------------------------

export type LocatorRecipe = {
  role?: string;
  name?: string;
  label?: string;
  testId?: string;
  text?: string;
  css?: string;
};

export type WaitRecipe =
  | { type: 'networkidle'; timeoutMs?: number }
  | { type: 'selector'; locator: LocatorRecipe; timeoutMs?: number }
  | { type: 'function'; fn: string; timeoutMs?: number }
  | { type: 'timeout'; ms: number };

export type AssertionRecipe =
  | { type: 'visible'; locator: LocatorRecipe }
  | { type: 'text'; locator: LocatorRecipe; value: string }
  | { type: 'url'; pattern: string }
  | { type: 'state'; path: string; expected: JsonValue };

export type RecordedAction =
  | { type: 'goto'; url: string }
  | { type: 'click'; locator: LocatorRecipe }
  | { type: 'fill'; locator: LocatorRecipe; valueRef: string }
  | { type: 'press'; key: string }
  | { type: 'request'; requestRef: string }
  | { type: 'waitFor'; condition: WaitRecipe }
  | { type: 'assert'; assertion: AssertionRecipe }
  | { type: 'screenshot'; name: string }
  | { type: 'reload' };

// ---------------------------------------------------------------------------
// Finding Packet v2
// ---------------------------------------------------------------------------

export type FindingLifecycleState =
  | 'observed'
  | 'suspected'
  | 'needs-authoring'
  | 'confirmed-semantic'
  | 'confirmed-evidence'
  | 'confirmed-state-harm'
  | 'rejected'
  | 'mitigated'
  | 'regression';

export type FindingPacketV2 = {
  findingId: string;
  lifecycleState: FindingLifecycleState;
  title: string;
  severity: string;
  category: string;
  originatingSuiteId: string;
  originatingScenarioId?: string;
  originatingCheck: string;
  initialAttemptId: string;
  confirmationAttemptIds: string[];
  reproductionCount: number;
  environment: {
    packId: string;
    baseUrl?: string;
    appVersion?: string;
  };
  evidenceManifest: EvidenceManifest;
  redactionSummary: RedactionEntry[];
  replayCommand?: string;
  replaySpec?: ReplaySpec;
  expectedState: string;
  actualState: string;
  steps: string[];
};

// ---------------------------------------------------------------------------
// Replay types
// ---------------------------------------------------------------------------

export type ReplayMode = 'http' | 'browser' | 'guided';

export interface HttpReplaySpec {
  mode: 'http';
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  expectedStatus: number;
  assertion: string;
}

export interface BrowserReplaySpec {
  mode: 'browser';
  setup: RecordedAction[];
  actions: RecordedAction[];
  assertion: AssertionRecipe;
  prerequisiteText?: string;
  linkedArtifactIds: string[];
}

export interface GuidedReplaySpec {
  mode: 'guided';
  setupHint: string;
  unresolvedSteps: string[];
  linkedArtifactIds: string[];
}

export type ReplaySpec = HttpReplaySpec | BrowserReplaySpec | GuidedReplaySpec;
