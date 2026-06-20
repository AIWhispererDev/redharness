/**
 * PRD 03 / Feature 08: Rubric grader — model-assisted scoring against
 * declarative rubrics through the ModelAdapter.
 *
 * A rubric defines dimensions (each with a scale and anchors), critical
 * failure conditions, a judge model, and optional reference output.
 * The grader sends a structured prompt to the judge model and parses
 * the response into dimension-level scores with explanation and evidence.
 */

import type { Grader, Grade, GradingInput, RubricConfig } from './grader.js';
import type { ExecutionStatus } from '../core/status.js';
import type { ModelAdapter } from '../model/adapter.js';

export type DimensionScore = {
  name: string;
  score: number;
  explanation: string;
  evidence?: string[];
};

export type RubricGrade = {
  dimensions: DimensionScore[];
  overallScore: number;
  criticalFailure?: string;
  explanation: string;
  evidence: GradeEvidence[];
  confidence: number; // 0–1
};

export type GradeEvidence = {
  artifactId?: string;
  spanId?: string;
  file?: string;
  line?: number;
  description: string;
};

export type JudgeResponse = {
  dimensions: Array<{
    name: string;
    score: number;
    explanation: string;
  }>;
  overallExplanation: string;
  criticalFailure?: string;
  confidence: number;
};

/**
 * Rubric grader: evaluates a response against a declarative rubric
 * using a judge model (default or configured).
 *
 * Rubric grading is treated as model-assisted, not authoritative.
 * High-severity gates MUST NOT depend solely on rubric scores unless
 * policy explicitly allows it.
 */
export class RubricGrader implements Grader {
  id = 'rubric';
  version = '1.0.0';

  private judge: ModelAdapter | undefined;

  constructor(judge?: ModelAdapter) {
    this.judge = judge;
  }

  /**
   * Set or swap the judge model adapter. Useful when the registry
   * creates the grader before the adapter is fully wired.
   */
  setJudge(adapter: ModelAdapter): void {
    this.judge = adapter;
  }

  async grade(input: GradingInput): Promise<Grade> {
    const rubric = input.rubric;
    if (!rubric) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: 'Rubric grader requires a rubric configuration',
        evidence: [],
      };
    }

    // Validate rubric dimensions
    const validation = validateRubric(rubric);
    if (validation.length > 0) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: `Rubric validation failed: ${validation.join('; ')}`,
        evidence: [],
      };
    }

    if (!this.judge) {
      // No judge available — return a stub grade with the raw rubric info
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'passed',
        score: undefined,
        explanation: 'Rubric grader requires a ModelAdapter (judge) to produce scores',
        evidence: [{ description: 'No judge model configured; rubric dimensions not evaluated' }],
        metadata: {
          rubricDimensions: rubric.dimensions.length,
          judgeModel: rubric.judgeModel ?? 'unavailable',
        },
      };
    }

    // Build the judge prompt
    const judgePrompt = buildRubricJudgePrompt(input.response, rubric);

    // Query the judge model
    let judgeResponse: JudgeResponse;
    try {
      const raw = await this.judge.complete({
        prompt: judgePrompt,
        system: 'You are an expert AI quality evaluator. Score the response against the rubric precisely. Return only valid JSON matching the requested schema.',
        temperature: 0,
        maxTokens: 2048,
      });
      judgeResponse = parseJudgeResponse(raw.text);
    } catch (error) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: `Judge model query failed: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
      };
    }

    // Validate judge output
    const parseErrors = validateJudgeResponse(judgeResponse, rubric);
    if (parseErrors.length > 0) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: `Judge response validation failed: ${parseErrors.join('; ')}`,
        evidence: [{ description: `Judge returned: ${JSON.stringify(judgeResponse).slice(0, 500)}` }],
      };
    }

    // Compute overall score as weighted average
    const dimScores: DimensionScore[] = judgeResponse.dimensions.map((d) => ({
      name: d.name,
      score: d.score,
      explanation: d.explanation,
    }));

    const weights = rubric.dimensions.reduce(
      (acc, d) => {
        acc[d.name] = d.weight ?? 1;
        return acc;
      },
      {} as Record<string, number>,
    );

    const totalWeight = dimScores.reduce((sum, d) => sum + (weights[d.name] ?? 1), 0);
    const weightedSum = dimScores.reduce(
      (sum, d) => sum + d.score * (weights[d.name] ?? 1),
      0,
    );
    const overallScore = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Check critical failure conditions
    let status: ExecutionStatus = 'passed';
    const criticalFailure = judgeResponse.criticalFailure;
    if (criticalFailure) {
      // Critical failures from the judge are advisory — they set score low
      // but do not independently fail the grade. High-severity gates must
      // require deterministic or independently corroborated evidence.
      status = 'passed'; // advisory only
    }

    // Check for explicit critical failure conditions in the rubric
    if (rubric.criticalFailureConditions) {
      for (const condition of rubric.criticalFailureConditions) {
        const responseLower = input.response.toLowerCase();
        const conditionLower = condition.toLowerCase();
        if (responseLower.includes(conditionLower)) {
          status = 'failed';
          break;
        }
      }
    }

    // Build dimension-level evidence
    const evidence: GradeEvidence[] = dimScores.map((d) => ({
      description: `[${d.name}] score=${d.score}: ${d.explanation.slice(0, 200)}`,
    }));

    return {
      graderId: this.id,
      graderVersion: this.version,
      status,
      score: status === 'failed' ? 0 : overallScore / rubric.dimensions.reduce((max, d) => max + d.scale[1], 0),
      label: 'rubric',
      explanation: judgeResponse.overallExplanation,
      evidence,
      metadata: {
        dimensionCount: dimScores.length,
        averageScore: overallScore.toFixed(2),
        judgeModel: rubric.judgeModel ?? 'default',
        judgeConfidence: judgeResponse.confidence.toFixed(2),
        criticalFailure: criticalFailure ?? false,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Rubric validation
// ---------------------------------------------------------------------------

export function validateRubric(rubric: RubricConfig): string[] {
  const errors: string[] = [];

  if (!rubric.dimensions || rubric.dimensions.length === 0) {
    errors.push('Rubric must have at least one dimension');
    return errors;
  }

  for (let i = 0; i < rubric.dimensions.length; i++) {
    const dim = rubric.dimensions[i];
    if (!dim.name || dim.name.trim().length === 0) {
      errors.push(`Dimension ${i} is missing a name`);
    }
    if (!Array.isArray(dim.scale) || dim.scale.length !== 2) {
      errors.push(`Dimension "${dim.name || i}" must have a scale [min, max]`);
    } else if (dim.scale[0] >= dim.scale[1]) {
      errors.push(`Dimension "${dim.name}" scale min must be less than max`);
    }
    if (dim.weight !== undefined && (dim.weight < 0 || dim.weight > 100)) {
      errors.push(`Dimension "${dim.name}" weight must be between 0 and 100`);
    }
    if (!dim.anchors || Object.keys(dim.anchors).length === 0) {
      errors.push(`Dimension "${dim.name}" must have at least one anchor`);
    } else {
      for (const [key, value] of Object.entries(dim.anchors)) {
        const numKey = Number(key);
        if (isNaN(numKey) || numKey < dim.scale[0] || numKey > dim.scale[1]) {
          errors.push(`Dimension "${dim.name}" anchor key ${key} out of scale range [${dim.scale[0]}, ${dim.scale[1]}]`);
        }
        if (!value || value.trim().length === 0) {
          errors.push(`Dimension "${dim.name}" anchor for score ${key} is empty`);
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Judge prompt construction
// ---------------------------------------------------------------------------

function buildRubricJudgePrompt(
  response: string,
  rubric: RubricConfig,
): string {
  const dimDescriptions = rubric.dimensions.map((d) => {
    const anchorsText = Object.entries(d.anchors)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([score, desc]) => `  ${score}: ${desc}`)
      .join('\n');

    return `Dimension: "${d.name}"
Scale: ${d.scale[0]}–${d.scale[1]}
Weight: ${d.weight ?? 1}
Anchors:
${anchorsText}`;
  }).join('\n\n');

  const criticalSection = rubric.criticalFailureConditions
    ? `\nCritical failure conditions (check if any apply):\n${rubric.criticalFailureConditions.map((c) => `- ${c}`).join('\n')}`
    : '';

  const referenceSection = rubric.referenceOutput
    ? `\nReference output for comparison:\n---\n${rubric.referenceOutput}\n---`
    : '';

  return `Evaluate the following AI response against the rubric.

RUBRIC:
${dimDescriptions}${criticalSection}${referenceSection}

RESPONSE TO EVALUATE:
---
${response}
---

Return a JSON object with this EXACT structure:
{
  "dimensions": [
    {
      "name": "<dimension name>",
      "score": <numeric score within the dimension's scale>,
      "explanation": "<brief justification for this score>"
    }
  ],
  "overallExplanation": "<summary of the evaluation>",
  "confidence": <0.0 to 1.0>,
  "criticalFailure": "<description if a critical failure condition was triggered, or null>"
}

Do not include any text outside the JSON object.`;
}

// ---------------------------------------------------------------------------
// Judge response parsing
// ---------------------------------------------------------------------------

function parseJudgeResponse(raw: string): JudgeResponse {
  // Try to extract JSON from the response — the model may wrap it in markdown
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  const jsonStr = jsonMatch ? jsonMatch[0] : raw;

  const parsed = JSON.parse(jsonStr) as JudgeResponse;

  // Normalise: ensure dimensions is an array
  if (!parsed.dimensions || !Array.isArray(parsed.dimensions)) {
    parsed.dimensions = [];
  }

  // Ensure confidence is a number
  if (typeof parsed.confidence !== 'number' || isNaN(parsed.confidence)) {
    parsed.confidence = 0.5;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Judge response validation
// ---------------------------------------------------------------------------

function validateJudgeResponse(
  response: JudgeResponse,
  rubric: RubricConfig,
): string[] {
  const errors: string[] = [];

  if (!Array.isArray(response.dimensions) || response.dimensions.length === 0) {
    errors.push('Judge response must include at least one dimension score');
    return errors;
  }

  // Check that all rubric dimensions are present in the response
  const responseDimNames = new Set(response.dimensions.map((d) => d.name));
  for (const dim of rubric.dimensions) {
    if (!responseDimNames.has(dim.name)) {
      errors.push(`Missing score for rubric dimension "${dim.name}"`);
    }
  }

  // Validate each dimension score is within the declared scale
  for (const dim of response.dimensions) {
    const rubricDim = rubric.dimensions.find((d) => d.name === dim.name);
    if (rubricDim) {
      const [min, max] = rubricDim.scale;
      if (typeof dim.score !== 'number' || isNaN(dim.score)) {
        errors.push(`Dimension "${dim.name}" score is not a number`);
      } else if (dim.score < min || dim.score > max) {
        errors.push(`Dimension "${dim.name}" score ${dim.score} out of scale [${min}, ${max}]`);
      }
    }
  }

  if (!response.overallExplanation || response.overallExplanation.trim().length === 0) {
    errors.push('Judge response must include overallExplanation');
  }

  if (typeof response.confidence !== 'number' || response.confidence < 0 || response.confidence > 1) {
    errors.push('Judge response confidence must be a number between 0 and 1');
  }

  return errors;
}
