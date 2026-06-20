import type { ArtifactStore } from '../artifacts/artifactStore.js';
import type { TraceWriter } from './traceWriter.js';
import type { BrowserInstrumentation } from './browserInstrumentation.js';

/**
 * Attempt-scoped evidence context provided to every suite run.
 *
 * Created by the RunCoordinator per attempt and passed via SuiteContext.
 */
export type AttemptEvidenceContext = {
  runId: string;
  suiteId: string;
  attemptId: string;
  traceId: string;
  spanId: string;
  artifactStore: ArtifactStore;
  traceWriter: TraceWriter;
  browserInstrumentation?: BrowserInstrumentation;
};
