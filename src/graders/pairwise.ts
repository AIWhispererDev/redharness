/**
 * PRD 03 / Feature 08: Pairwise grader — compares a candidate response
 * against a baseline and reports preference, confidence, and reasoning.
 *
 * Pairwise grading is used for A/B comparisons, regression detection in
 * subjective quality, and tracking improvement across model or prompt
 * changes. The grader can operate with or without a judge model:
 * without one it falls back to deterministic comparison of available
 * metrics.
 */

import type { Grader, Grade, GradingInput } from './grader.js';
import type { ExecutionStatus } from '../core/status.js';
import type { ModelAdapter } from '../model/adapter.js';

export type PairwisePreference = 'candidate' | 'baseline' | 'tie';

export type PairwiseGrade = {
  preference: PairwisePreference;
  confidence: number; // 0–1
  explanation: string;
  dimensions: Array<{
    name: string;
    preference: PairwisePreference;
    explanation: string;
  }>;
};

export type PairwiseGraderConfig = {
  /** Baseline response text. */
  baselineResponse: string;
  /** Optional label for the baseline. */
  baselineLabel?: string;
  /** Optional label for the candidate. */
  candidateLabel?: string;
  /** Named dimensions for comparison. */
  dimensions?: Array<{
    name: string;
    description: string;
  }>;
  /** Criteria/instructions for the judge. */
  criteria?: string;
};

/**
 * Pairwise grader: compares candidate vs baseline responses using a
 * judge model, or falls back to a simple text-comparison heuristic.
 */
export class PairwiseGrader implements Grader {
  id = 'pairwise';
  version = '1.0.0';

  private judge: ModelAdapter | undefined;
  private config: PairwiseGraderConfig;

  constructor(config: PairwiseGraderConfig, judge?: ModelAdapter) {
    this.config = config;
    this.judge = judge;
  }

  /** Set or swap the judge model adapter. */
  setJudge(adapter: ModelAdapter): void {
    this.judge = adapter;
  }

  async grade(input: GradingInput): Promise<Grade> {
    const candidateResponse = input.response;
    const baselineResponse = this.config.baselineResponse;

    if (!baselineResponse) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: 'Pairwise grader requires a baseline response',
        evidence: [],
      };
    }

    if (!candidateResponse) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: 'Pairwise grader requires a candidate response',
        evidence: [],
      };
    }

    let pairwiseResult: PairwiseGrade;

    if (this.judge) {
      try {
        pairwiseResult = await this.judgePairwise(input.response, baselineResponse);
      } catch (error) {
        return {
          graderId: this.id,
          graderVersion: this.version,
          status: 'error',
          explanation: `Pairwise judge query failed: ${error instanceof Error ? error.message : String(error)}`,
          evidence: [],
        };
      }
    } else {
      // Fallback heuristic: compare by length similarity and exact overlap
      pairwiseResult = heuristicPairwise(input.response, baselineResponse, this.config);
    }

    // Determine overall status from preference
    let status: ExecutionStatus;
    let score: number | undefined;

    if (pairwiseResult.preference === 'candidate') {
      status = 'passed';
      score = 1;
    } else if (pairwiseResult.preference === 'baseline') {
      status = 'failed';
      score = 0;
    } else {
      status = 'passed';
      score = 0.5;
    }

    const evidence: Grade['evidence'] = [
      {
        description: `Preference: ${pairwiseResult.preference} (confidence: ${pairwiseResult.confidence.toFixed(2)})`,
      },
      ...pairwiseResult.dimensions.map((d) => ({
        description: `[${d.name}] preference=${d.preference}: ${d.explanation.slice(0, 200)}`,
      })),
    ];

    return {
      graderId: this.id,
      graderVersion: this.version,
      status,
      score,
      label: 'pairwise',
      explanation: pairwiseResult.explanation,
      evidence,
      metadata: {
        preference: pairwiseResult.preference,
        confidence: pairwiseResult.confidence,
        dimensionCount: pairwiseResult.dimensions.length,
        judgeAvailable: !!this.judge,
      },
    };
  }

  /**
   * Query the judge model for pairwise comparison.
   */
  private async judgePairwise(
    candidate: string,
    baseline: string,
  ): Promise<PairwiseGrade> {
    if (!this.judge) {
      throw new Error('No judge model available for pairwise grading');
    }

    const dimDescriptions = this.config.dimensions && this.config.dimensions.length > 0
      ? `\nCompare on these specific dimensions:\n${this.config.dimensions.map((d) => `- ${d.name}: ${d.description}`).join('\n')}`
      : '';

    const criteriaSection = this.config.criteria
      ? `\nEvaluation criteria: ${this.config.criteria}`
      : '';

    const prompt = `Compare the following two responses and determine which is better.

BASELINE (${this.config.baselineLabel ?? 'baseline'}):
---
${baseline}
---

CANDIDATE (${this.config.candidateLabel ?? 'candidate'}):
---
${candidate}
---${dimDescriptions}${criteriaSection}

Return a JSON object with this EXACT structure:
{
  "preference": "candidate" | "baseline" | "tie",
  "confidence": <0.0 to 1.0>,
  "explanation": "<detailed comparison summary>",
  "dimensions": [
    {
      "name": "<dimension name>",
      "preference": "candidate" | "baseline" | "tie",
      "explanation": "<brief justification>"
    }
  ]
}

Do not include any text outside the JSON object.`;

    const raw = await this.judge.complete({
      prompt,
      system: 'You are an expert AI response evaluator. Compare responses fairly and precisely. Return only valid JSON.',
      temperature: 0,
      maxTokens: 2048,
    });

    return parsePairwiseResponse(raw.text);
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback
// ---------------------------------------------------------------------------

function heuristicPairwise(
  candidate: string,
  baseline: string,
  config: PairwiseGraderConfig,
): PairwiseGrade {
  const baselineLen = baseline.length;
  const candidateLen = candidate.length;
  const lengthRatio = candidateLen > 0
    ? Math.min(candidateLen, baselineLen) / Math.max(candidateLen, baselineLen)
    : 0;

  // Simple heuristic: prefer longer responses (more complete) unless
  // the length difference is small, in which case it's a tie
  let preference: PairwisePreference;
  let confidence: number;
  let explanation: string;

  if (lengthRatio > 0.85) {
    // Similar length — compare exact content overlap
    const overlap = countOverlap(candidate, baseline);
    const overlapRatio = overlap / Math.max(candidateLen, baselineLen);

    if (overlapRatio > 0.9) {
      preference = 'tie';
      confidence = 0.95;
      explanation = 'Responses are nearly identical';
    } else if (overlapRatio > 0.7) {
      preference = 'tie';
      confidence = 0.5;
      explanation = 'Responses share significant overlap; no clear preference';
    } else {
      preference = 'tie';
      confidence = 0.3;
      explanation = 'Different content, similar length — cannot determine preference without a judge';
    }
  } else if (candidateLen > baselineLen) {
    preference = 'candidate';
    confidence = 0.2 + lengthRatio * 0.3;
    explanation = 'Candidate is longer (heuristic — low confidence without a judge)';
  } else {
    preference = 'baseline';
    confidence = 0.2 + lengthRatio * 0.3;
    explanation = 'Baseline is longer (heuristic — low confidence without a judge)';
  }

  // Build auto dimensions
  const dimNames = config.dimensions ? config.dimensions.map((d) => d.name) : ['overall_quality'];
  const dimensions = dimNames.map((name) => ({
    name,
    preference: preference as PairwisePreference,
    explanation: `Heuristic comparison — no judge model available for dimension "${name}"`,
  }));

  return {
    preference,
    confidence: Math.min(confidence, 1),
    explanation,
    dimensions,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }
  return overlap;
}

// ---------------------------------------------------------------------------
// Pairwise response parsing
// ---------------------------------------------------------------------------

function parsePairwiseResponse(raw: string): PairwiseGrade {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : raw;
  const parsed = JSON.parse(jsonStr) as PairwiseGrade;

  // Normalise preference
  if (!['candidate', 'baseline', 'tie'].includes(parsed.preference)) {
    parsed.preference = 'tie';
  }

  // Normalise confidence
  if (typeof parsed.confidence !== 'number' || isNaN(parsed.confidence)) {
    parsed.confidence = 0.5;
  }

  // Ensure dimensions array
  if (!Array.isArray(parsed.dimensions)) {
    parsed.dimensions = [];
  }

  // Normalise dimension preferences
  for (const dim of parsed.dimensions) {
    if (!['candidate', 'baseline', 'tie'].includes(dim.preference)) {
      dim.preference = 'tie';
    }
  }

  return parsed;
}
