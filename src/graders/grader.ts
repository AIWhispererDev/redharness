/**
 * PRD 03: Grader interface and types.
 *
 * Every grader produces a Grade object with status, optional score,
 * explanation, and evidence pointers.
 */

import type { ExecutionStatus } from '../core/status.js';

export type GradeEvidence = {
  artifactId?: string;
  spanId?: string;
  file?: string;
  line?: number;
  description: string;
};

export type Grade = {
  graderId: string;
  graderVersion: string;
  status: ExecutionStatus;
  score?: number;
  label?: string;
  explanation: string;
  evidence: GradeEvidence[];
  metadata?: Record<string, number | string | boolean>;
};

/** Base interface all graders implement. */
export interface Grader {
  id: string;
  version: string;
  grade(input: GradingInput): Promise<Grade>;
}

export type GradingInput = {
  /** The actual response/output being graded. */
  response: string;
  /** Expected output or state description. */
  expected?: string;
  /** The subject (e.g. 'ai_response', 'url', 'page_text'). */
  target: string;
  /** Optional rubric configuration. */
  rubric?: RubricConfig;
  /** Additional context for the grader. */
  context?: Record<string, unknown>;
};

export type RubricConfig = {
  dimensions: RubricDimension[];
  criticalFailureConditions?: string[];
  judgeModel?: string;
  referenceOutput?: string;
};

export type RubricDimension = {
  name: string;
  scale: [number, number];
  anchors: Record<number, string>;
  weight?: number;
};
