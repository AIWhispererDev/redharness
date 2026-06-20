/**
 * PRD 03 / Feature 08: Human review export/import — serialises grading
 * requests and responses for offline human review and re-import.
 *
 * Human review provides an independent quality signal that can override
 * or corroborate automated grades. The queue serialises:
 * - The original grading input (response, expected, rubric, context)
 * - The automated grade (if one was produced)
 * - Human reviewer metadata and verdict
 * - Stable IDs for traceability across export/import cycles
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Grade, GradingInput, GradeEvidence, Grader } from './grader.js';
import type { RubricConfig } from './grader.js';
import type { ExecutionStatus } from '../core/status.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HumanReviewRequest = {
  /** Stable, deterministic ID derived from the grading input content. */
  reviewId: string;
  /** When the review request was created. */
  createdAt: string;
  /** The original grading input that needs review. */
  input: GradingInput;
  /** The automated grade, if one was produced before export. */
  automatedGrade?: Grade;
  /** Metadata about the export context. */
  context: {
    graderId?: string;
    scenarioId?: string;
    trial?: number;
    runId?: string;
    datasetId?: string;
    datasetVersion?: string;
    exporterVersion: string;
  };
  /** Current status of this review. */
  status: 'pending' | 'in_progress' | 'completed' | 'conflict';
};

export type HumanReviewVerdict = {
  reviewerId: string;
  reviewedAt: string;
  status: ExecutionStatus;
  score?: number;
  label?: string;
  explanation: string;
  evidence?: GradeEvidence[];
  /** Override automated grade? If true, the human verdict replaces the automated grade. */
  overridesAutomated: boolean;
  /** Flag for uncertainty — e.g. "needs second review". */
  flagged?: boolean;
  /** Free-form notes from the reviewer. */
  notes?: string;
};

export type HumanReviewResponse = HumanReviewRequest & {
  verdict?: HumanReviewVerdict;
};

// ---------------------------------------------------------------------------
// Review queue serialisation
// ---------------------------------------------------------------------------

const EXPORTER_VERSION = '1.0.0';

/**
 * Create a stable review ID from a grading input and context.
 * This ensures the same input always produces the same review ID,
 * enabling deduplication and traceability.
 */
export function createReviewId(
  input: GradingInput,
  context: { scenarioId?: string; runId?: string },
): string {
  const hash = createHash('sha256');
  const canonical = `${context.scenarioId ?? ''}|${context.runId ?? ''}|${input.target}|${input.response.slice(0, 200)}|${input.expected ?? ''}`;
  hash.update(canonical);
  return `review-${hash.digest('hex').slice(0, 16)}`;
}

/**
 * Create a review request from a grading input and optional automated grade.
 */
export function createReviewRequest(
  input: GradingInput,
  options: {
    graderId?: string;
    scenarioId?: string;
    trial?: number;
    runId?: string;
    dataset?: { id: string; version: string };
    automatedGrade?: Grade;
  },
): HumanReviewRequest {
  return {
    reviewId: createReviewId(input, {
      scenarioId: options.scenarioId,
      runId: options.runId,
    }),
    createdAt: new Date().toISOString(),
    input,
    automatedGrade: options.automatedGrade,
    context: {
      graderId: options.graderId,
      scenarioId: options.scenarioId,
      trial: options.trial,
      runId: options.runId,
      datasetId: options.dataset?.id,
      datasetVersion: options.dataset?.version,
      exporterVersion: EXPORTER_VERSION,
    },
    status: 'pending',
  };
}

// ---------------------------------------------------------------------------
// Export / Import
// ---------------------------------------------------------------------------

/**
 * Export an array of review requests to a JSON file.
 * Returns the file path written.
 */
export async function exportReviewQueue(
  reviews: HumanReviewRequest[],
  outputDir: string,
  filename?: string,
): Promise<string> {
  const filePath = path.join(outputDir, filename ?? `human-review-queue-${Date.now()}.json`);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(reviews, null, 2), 'utf-8');
  return filePath;
}

/**
 * Import review responses from a JSON file.
 * Returns the parsed review responses, preserving stable review IDs.
 */
export async function importReviewResponses(
  filePath: string,
): Promise<HumanReviewResponse[]> {
  const raw = await readFile(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as HumanReviewResponse[];

  if (!Array.isArray(parsed)) {
    throw new Error('Review import file must contain a JSON array of review responses');
  }

  // Validate stable IDs
  for (const review of parsed) {
    if (!review.reviewId || !review.reviewId.startsWith('review-')) {
      throw new Error(`Invalid review ID in import: "${review.reviewId}"`);
    }
    if (review.verdict && !review.verdict.reviewerId) {
      throw new Error(`Review "${review.reviewId}" has a verdict but no reviewerId`);
    }
  }

  return parsed;
}

/**
 * Apply human review verdicts to grades.
 * Returns a map of reviewId → updated Grade, with the automated grade
 * replaced/overridden where the verdict specifies override.
 */
export function applyHumanVerdicts(
  reviews: HumanReviewResponse[],
): Map<string, Grade> {
  const result = new Map<string, Grade>();

  for (const review of reviews) {
    if (!review.verdict || !review.verdict.overridesAutomated) continue;

    const verdict = review.verdict;
    const overrideGrade: Grade = {
      graderId: `human-review/${review.context.graderId ?? 'unknown'}`,
      graderVersion: EXPORTER_VERSION,
      status: verdict.status,
      score: verdict.score,
      label: verdict.label ?? 'human-review',
      explanation: verdict.explanation,
      evidence: verdict.evidence ?? [
        { description: `Human review verdict by ${verdict.reviewerId}` },
      ],
      metadata: {
        reviewId: review.reviewId,
        reviewerId: verdict.reviewerId,
        overridesAutomated: true,
        automatedGraderId: review.context.graderId ?? 'unknown',
        flagged: verdict.flagged ?? false,
      },
    };

    result.set(review.reviewId, overrideGrade);
  }

  return result;
}

/**
 * Merge human review responses back into the review queue.
 * Returns updated review requests with verdicts applied.
 */
export function mergeReviewResponses(
  queue: HumanReviewRequest[],
  responses: HumanReviewResponse[],
): HumanReviewRequest[] {
  const responseMap = new Map(responses.map((r) => [r.reviewId, r]));

  return queue.map((request) => {
    const response = responseMap.get(request.reviewId);
    if (!response || !response.verdict) return request;

    return {
      ...request,
      status: 'completed',
      automatedGrade: response.automatedGrade ?? request.automatedGrade,
    };
  });
}

/**
 * HumanGrader: wraps grading input into a review request and returns
 * a pending-referral grade. This grader does not produce an automated
 * result — it creates a serialisable review request and returns a
 * 'pending' status, indicating the grade result depends on human review.
 *
 * Use this when a scenario should always go through human review.
 */
export class HumanGrader implements Grader {
  id = 'human';
  version = EXPORTER_VERSION;

  async grade(input: GradingInput): Promise<Grade> {
    const request = createReviewRequest(input, {});

    return {
      graderId: this.id,
      graderVersion: this.version,
      status: 'passed',
      score: undefined,
      label: 'human-review',
      explanation: `Pending human review (${request.reviewId}). Export the review queue and import verdicts to complete grading.`,
      evidence: [{ description: `Review ID: ${request.reviewId}` }],
      metadata: {
        reviewId: request.reviewId,
        status: 'pending_review',
      },
    };
  }
}

/**
 * Check for conflicting human review verdicts on the same review.
 * Returns pairs of (reviewId, conflicting verdicts).
 */
export function findConflictingVerdicts(
  responses: HumanReviewResponse[],
): Array<{ reviewId: string; verdicts: HumanReviewVerdict[] }> {
  const byReview = new Map<string, HumanReviewVerdict[]>();

  for (const response of responses) {
    if (!response.verdict) continue;
    const existing = byReview.get(response.reviewId) ?? [];
    existing.push(response.verdict);
    byReview.set(response.reviewId, existing);
  }

  const conflicts: Array<{ reviewId: string; verdicts: HumanReviewVerdict[] }> = [];
  for (const [reviewId, verdicts] of byReview) {
    const uniqueStatuses = new Set(verdicts.map((v) => v.status));
    if (uniqueStatuses.size > 1 || verdicts.length > 2) {
      conflicts.push({ reviewId, verdicts });
    }
  }

  return conflicts;
}
