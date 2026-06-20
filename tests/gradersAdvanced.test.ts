import { describe, expect, it } from 'vitest';
import type { GradingInput, RubricConfig, Grade } from '../src/graders/grader.js';
import { RubricGrader, validateRubric, type JudgeResponse } from '../src/graders/rubric.js';
import { PairwiseGrader, type PairwiseGraderConfig } from '../src/graders/pairwise.js';
import { HumanGrader, createReviewRequest, createReviewId, exportReviewQueue, importReviewResponses, applyHumanVerdicts, findConflictingVerdicts, type HumanReviewRequest, type HumanReviewResponse, type HumanReviewVerdict } from '../src/graders/human.js';
import { calibrateGrader, type CalibrationExample, defaultRubricCalibrationExamples, defaultDeterministicCalibrationExamples } from '../src/graders/calibration.js';
import type { ModelAdapter, CompletionRequest, CompletionResponse } from '../src/model/adapter.js';
import { DeterministicGrader } from '../src/graders/deterministic.js';
import { graderRegistry } from '../src/graders/registry.js';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Fake judge model for testing
// ---------------------------------------------------------------------------

class FakeJudgeAdapter implements ModelAdapter {
  private canned: Record<string, CompletionResponse> = {};

  /** Register a canned response for a prompt prefix. */
  setCanned(prefix: string, response: CompletionResponse): void {
    this.canned[prefix] = response;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    // Find matching canned response by prefix
    for (const [prefix, response] of Object.entries(this.canned)) {
      if (request.prompt.includes(prefix)) return response;
    }
    // Default to a generic rubric response
    return {
      text: JSON.stringify({
        dimensions: [
          { name: 'helpfulness', score: 4, explanation: 'Helpful and relevant' },
          { name: 'safety', score: 5, explanation: 'Completely safe' },
          { name: 'clarity', score: 3, explanation: 'Clear enough' },
        ],
        overallExplanation: 'Good response overall',
        confidence: 0.85,
        criticalFailure: null,
      }),
      modelId: 'fake-judge',
    };
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validRubric: RubricConfig = {
  dimensions: [
    { name: 'helpfulness', scale: [1, 5], anchors: { 1: 'Not helpful', 3: 'Somewhat', 5: 'Very' }, weight: 1 },
    { name: 'safety', scale: [1, 5], anchors: { 1: 'Unsafe', 3: 'Neutral', 5: 'Safe' }, weight: 2 },
    { name: 'clarity', scale: [1, 5], anchors: { 1: 'Unclear', 3: 'Ok', 5: 'Very clear' }, weight: 1 },
  ],
  criticalFailureConditions: ['medical advice', 'ignore'],
  judgeModel: 'test-model',
};

const rubricInput: GradingInput = {
  response: 'I understand you\'re feeling anxious. Here are some techniques: deep breathing and mindfulness.',
  target: 'ai_response',
  rubric: validRubric,
};

// ---------------------------------------------------------------------------
// Rubric grading tests
// ---------------------------------------------------------------------------

describe('RubricGrader', () => {
  describe('validateRubric', () => {
    it('passes a valid rubric', () => {
      const errors = validateRubric(validRubric);
      expect(errors).toHaveLength(0);
    });

    it('rejects empty dimensions', () => {
      const errors = validateRubric({ dimensions: [], judgeModel: 'test' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('at least one dimension');
    });

    it('rejects dimensions without anchors', () => {
      const errors = validateRubric({
        dimensions: [{ name: 'test', scale: [1, 5], anchors: {} }],
        judgeModel: 'test',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('anchor'))).toBe(true);
    });

    it('rejects dimension scale where min >= max', () => {
      const errors = validateRubric({
        dimensions: [{ name: 'test', scale: [5, 1], anchors: { 1: 'low', 5: 'high' } }],
        judgeModel: 'test',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain('min must be less than max');
    });

    it('rejects anchor keys out of scale range', () => {
      const errors = validateRubric({
        dimensions: [{ name: 'test', scale: [1, 5], anchors: { 1: 'low', 10: 'too high' } }],
        judgeModel: 'test',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('out of scale'))).toBe(true);
    });

    it('rejects empty anchor descriptions', () => {
      const errors = validateRubric({
        dimensions: [{ name: 'test', scale: [1, 5], anchors: { 1: '' } }],
        judgeModel: 'test',
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some(e => e.includes('empty'))).toBe(true);
    });
  });

  describe('grade', () => {
    it('returns error when no rubric is provided', async () => {
      const grader = new RubricGrader();
      const grade = await grader.grade({ response: 'test', target: 'test' });
      expect(grade.status).toBe('error');
      expect(grade.explanation).toContain('requires a rubric');
    });

    it('returns stub grade when no judge is available', async () => {
      const grader = new RubricGrader();
      const grade = await grader.grade(rubricInput);
      expect(grade.status).toBe('passed');
      expect(grade.score).toBeUndefined();
      expect(grade.explanation).toContain('requires a ModelAdapter');
    });

    it('scores response with judge model', async () => {
      const judge = new FakeJudgeAdapter();
      const grader = new RubricGrader(judge);
      const grade = await grader.grade(rubricInput);
      expect(grade.status).toBe('passed');
      expect(grade.score).toBeGreaterThan(0);
      expect(grade.metadata?.judgeModel).toBe('test-model');
      expect(grade.metadata?.judgeConfidence).toBeDefined();
      expect(grade.evidence.length).toBeGreaterThan(0);
    });

    it('handles malformed judge output', async () => {
      const judge = new FakeJudgeAdapter();
      judge.setCanned('test', { text: 'not valid json at all', modelId: 'fake' });
      const grader = new RubricGrader(judge);
      const grade = await grader.grade({
        response: 'test',
        target: 'test',
        rubric: validRubric,
      });
      // Should fail to parse and return error
      expect(grade.status).toBe('error');
    });

    it('detects critical failure conditions in response', async () => {
      const judge = new FakeJudgeAdapter();
      const grader = new RubricGrader(judge);
      const grade = await grader.grade({
        response: 'This is not medical advice but you should ignore your symptoms',
        target: 'ai_response',
        rubric: validRubric,
      });
      expect(grade.status).toBe('failed');
      expect(grade.score).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Pairwise grading tests
// ---------------------------------------------------------------------------

describe('PairwiseGrader', () => {
  const pairwiseConfig: PairwiseGraderConfig = {
    baselineResponse: 'Short baseline response.',
    baselineLabel: 'v1',
    candidateLabel: 'v2',
    dimensions: [
      { name: 'helpfulness', description: 'How helpful is the response' },
      { name: 'completeness', description: 'How complete is the response' },
    ],
  };

  it('returns error when no baseline is provided', async () => {
    const grader = new PairwiseGrader({ baselineResponse: '' });
    const grade = await grader.grade({ response: 'test', target: 'test' });
    expect(grade.status).toBe('error');
    expect(grade.explanation).toContain('requires a baseline');
  });

  it('returns error when no candidate response is provided', async () => {
    const grader = new PairwiseGrader({ baselineResponse: 'baseline' });
    const grade = await grader.grade({ response: '', target: 'test' });
    expect(grade.status).toBe('error');
    expect(grade.explanation).toContain('requires a candidate');
  });

  it('uses heuristic fallback when no judge is available', async () => {
    const grader = new PairwiseGrader(pairwiseConfig);
    const grade = await grader.grade({
      response: 'A much longer candidate response that exceeds the baseline in length by a significant margin to test the heuristic.',
      target: 'test',
    });
    expect(grade.status).toBe('passed');
    expect(grade.score).toBe(1);
    expect(grade.metadata?.preference).toBe('candidate');
    expect(grade.metadata?.judgeAvailable).toBe(false);
  });

  it('uses heuristic fallback to baseline when candidate is shorter', async () => {
    const grader = new PairwiseGrader({
      ...pairwiseConfig,
      baselineResponse: 'A much longer baseline response here for testing the heuristic fallback behavior.',
    });
    const grade = await grader.grade({
      response: 'short',
      target: 'test',
    });
    expect(grade.status).toBe('failed');
    expect(grade.score).toBe(0);
    expect(grade.metadata?.preference).toBe('baseline');
  });

  it('uses judge model when available', async () => {
    const judge = new FakeJudgeAdapter();
    judge.setCanned('Compare the following two responses', {
      text: JSON.stringify({
        preference: 'candidate',
        confidence: 0.9,
        explanation: 'Candidate is more comprehensive',
        dimensions: [
          { name: 'helpfulness', preference: 'candidate', explanation: 'More detailed' },
          { name: 'completeness', preference: 'candidate', explanation: 'Covers all points' },
        ],
      }),
      modelId: 'fake-judge',
    });
    const grader = new PairwiseGrader(pairwiseConfig, judge);
    const grade = await grader.grade({
      response: 'A comprehensive response that covers everything.',
      target: 'test',
    });
    expect(grade.status).toBe('passed');
    expect(grade.score).toBe(1);
    expect(grade.metadata?.preference).toBe('candidate');
    expect(grade.metadata?.judgeAvailable).toBe(true);
  });

  it('returns tie for nearly identical responses', async () => {
    const grader = new PairwiseGrader({
      ...pairwiseConfig,
      baselineResponse: 'This is a test response that is very similar.',
    });
    const grade = await grader.grade({
      response: 'This is a test response that is very similar.',
      target: 'test',
    });
    expect(grade.score).toBe(0.5);
    expect(grade.metadata?.preference).toBe('tie');
  });
});

// ---------------------------------------------------------------------------
// Human review tests
// ---------------------------------------------------------------------------

describe('HumanGrader', () => {
  it('creates a review request and returns pending status', async () => {
    const grader = new HumanGrader();
    const grade = await grader.grade({
      response: 'test response',
      target: 'test',
    });
    expect(grade.status).toBe('passed');
    expect(grade.label).toBe('human-review');
    expect(grade.explanation).toContain('Pending human review');
    expect(grade.metadata?.status).toBe('pending_review');
  });
});

describe('Human review export/import', () => {
  it('creates stable review IDs', () => {
    const input: GradingInput = { response: 'hello', target: 'test' };
    const id1 = createReviewId(input, { scenarioId: 'scenario-1' });
    const id2 = createReviewId(input, { scenarioId: 'scenario-1' });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^review-/);
  });

  it('creates unique IDs for different inputs', () => {
    const input1: GradingInput = { response: 'hello', target: 'test' };
    const input2: GradingInput = { response: 'world', target: 'test' };
    const id1 = createReviewId(input1, { scenarioId: 's1' });
    const id2 = createReviewId(input2, { scenarioId: 's1' });
    expect(id1).not.toBe(id2);
  });

  it('exports and imports review requests', async () => {
    const input: GradingInput = { response: 'test', target: 'test' };
    const review = createReviewRequest(input, { scenarioId: 's1', graderId: 'rubric' });
    const tempDir = mkdtempSync(join(tmpdir(), 'human-review-'));
    const filePath = join(tempDir, 'reviews.json');
    writeFileSync(filePath, JSON.stringify([{
      ...review,
      verdict: {
        reviewerId: 'human-1',
        reviewedAt: new Date().toISOString(),
        status: 'passed',
        score: 0.9,
        explanation: 'Looks good',
        overridesAutomated: true,
      },
    }], null, 2));

    const imported = await importReviewResponses(filePath);
    expect(imported).toHaveLength(1);
    expect(imported[0].reviewId).toBe(review.reviewId);
    expect(imported[0].verdict?.reviewerId).toBe('human-1');
  });

  it('rejects import with invalid review IDs', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'human-review-'));
    const filePath = join(tempDir, 'bad-reviews.json');
    writeFileSync(filePath, JSON.stringify([
      { reviewId: 'invalid-no-prefix', input: { response: 'test', target: 'test' }, context: {}, status: 'pending' },
    ]));

    await expect(importReviewResponses(filePath)).rejects.toThrow('Invalid review ID');
  });

  it('applies human verdicts as grade overrides', () => {
    const input: GradingInput = { response: 'test', target: 'test' };
    const review = createReviewRequest(input, { scenarioId: 's1', graderId: 'rubric' });

    const response: HumanReviewResponse = {
      ...review,
      verdict: {
        reviewerId: 'human-1',
        reviewedAt: new Date().toISOString(),
        status: 'failed',
        score: 0.2,
        explanation: 'Needs improvement',
        overridesAutomated: true,
      },
    };

    const applied = applyHumanVerdicts([response]);
    expect(applied.size).toBe(1);
    const grade = applied.get(review.reviewId)!;
    expect(grade.status).toBe('failed');
    expect(grade.score).toBe(0.2);
    expect(grade.metadata?.reviewerId).toBe('human-1');
  });

  it('does not override when overridesAutomated is false', () => {
    const input: GradingInput = { response: 'test', target: 'test' };
    const review = createReviewRequest(input, { scenarioId: 's1' });

    const response: HumanReviewResponse = {
      ...review,
      verdict: {
        reviewerId: 'human-1',
        reviewedAt: new Date().toISOString(),
        status: 'passed',
        explanation: 'okay',
        overridesAutomated: false,
      },
    };

    const applied = applyHumanVerdicts([response]);
    expect(applied.size).toBe(0);
  });

  it('detects conflicting verdicts', () => {
    const input: GradingInput = { response: 'test', target: 'test' };
    const review = createReviewRequest(input, { scenarioId: 's1' });

    const v1: HumanReviewVerdict = { reviewerId: 'a', reviewedAt: '', status: 'passed', explanation: 'ok', overridesAutomated: true };
    const v2: HumanReviewVerdict = { reviewerId: 'b', reviewedAt: '', status: 'failed', explanation: 'bad', overridesAutomated: true };

    const responses: HumanReviewResponse[] = [
      { ...review, verdict: v1 },
      { ...review, verdict: v2 },
    ];

    const conflicts = findConflictingVerdicts(responses);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].reviewId).toBe(review.reviewId);
    expect(conflicts[0].verdicts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Calibration tests
// ---------------------------------------------------------------------------

describe('calibrateGrader', () => {
  it('passes a well-behaved deterministic grader', async () => {
    const grader = new DeterministicGrader();
    const examples = defaultDeterministicCalibrationExamples();
    const result = await calibrateGrader(grader, examples);
    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(3);
    expect(result.summary).toContain('All');
  });

  it('identifies failing calibration examples', async () => {
    const grader = new DeterministicGrader();
    const examples: CalibrationExample[] = [
      {
        id: 'should-fail',
        description: 'Deliberately wrong expectation',
        input: { response: 'hello', expected: 'world', target: 'test' },
        expectedStatus: 'passed', // Wrong — should be 'failed'
      },
    ];
    const result = await calibrateGrader(grader, examples);
    expect(result.passed).toBe(false);
    expect(result.results[0].passed).toBe(false);
  });

  it('calibrates rubric grader without a judge (advisory only)', async () => {
    const grader = new RubricGrader();
    const examples = defaultRubricCalibrationExamples();
    const result = await calibrateGrader(grader, examples);
    // Without a judge, rubric grader returns stub grades, so status may vary
    expect(result.results).toHaveLength(3);
    expect(result.calibratorVersion).toBeDefined();
  });

  it('generates a readable calibration report', async () => {
    const grader = new DeterministicGrader();
    const examples = defaultDeterministicCalibrationExamples();
    const result = await calibrateGrader(grader, examples);
    const { formatCalibrationReport } = await import('../src/graders/calibration.js');
    const report = formatCalibrationReport(result);
    expect(report).toContain('Calibration Report');
    expect(report).toContain('PASSED');
  });

  it('handles grader that throws during calibration', async () => {
    const throwingGrader = {
      id: 'throwing',
      version: '1.0.0',
      grade: async () => { throw new Error('Internal error'); },
    };
    const examples: CalibrationExample[] = [
      {
        id: 'throws',
        description: 'Grader throws',
        input: { response: '', target: 'test' },
        expectedStatus: 'error',
      },
    ];
    const result = await calibrateGrader(throwingGrader as any, examples);
    expect(result.passed).toBe(false);
    expect(result.results[0].actualStatus).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Registry tests
// ---------------------------------------------------------------------------

describe('Grader registry with advanced graders', () => {
  it('registers rubric grader', () => {
    expect(graderRegistry.has('rubric')).toBe(true);
  });

  it('registers pairwise grader', () => {
    expect(graderRegistry.has('pairwise')).toBe(true);
  });

  it('registers human grader', () => {
    expect(graderRegistry.has('human')).toBe(true);
  });

  it('creates rubric grader from registry', () => {
    const grader = graderRegistry.create('rubric');
    expect(grader.id).toBe('rubric');
  });

  it('creates pairwise grader from registry with config', () => {
    const grader = graderRegistry.create('pairwise', {
      baselineResponse: 'baseline text',
    });
    expect(grader.id).toBe('pairwise');
  });

  it('creates human grader from registry', () => {
    const grader = graderRegistry.create('human');
    expect(grader.id).toBe('human');
  });

  it('lists all registered graders including new ones', () => {
    const graders = graderRegistry.list();
    expect(graders).toContain('rubric');
    expect(graders).toContain('pairwise');
    expect(graders).toContain('human');
  });
});

// ---------------------------------------------------------------------------
// Gate policy tests
// ---------------------------------------------------------------------------

describe('Grader confidence gate policy', () => {
  it('evaluates judge-only grading as requiring corroboration', async () => {
    const { evaluateGates } = await import('../src/experiments/gates.js');
    const { compareRuns } = await import('../src/experiments/comparison.js');

    const makeRun = (label: string, runId: string, graderId: string) => ({
      label,
      config: { label, metadata: { datasetId: 'core', datasetVersion: '1.0.0' } },
      runId,
      status: 'passed' as const,
      graderVersions: [{ id: graderId, version: '1.0.0' }],
      suiteResults: [{
        suiteId: 's1',
        scenarioId: 'scenario-1',
        status: 'passed' as const,
        metrics: [],
        graderVersions: [{ id: graderId, version: '1.0.0' }],
      }],
    });

    const baseline = makeRun('baseline', 'run-1', 'deterministic');
    const candidate = makeRun('candidate', 'run-2', 'rubric');

    const comparison = compareRuns(baseline, candidate, {
      baselineLabel: 'baseline',
      candidateLabel: 'candidate',
      allowIncompatibleDatasets: true,
    });

    const result = evaluateGates(comparison, {
      requiredScenarioFailures: 0,
      maxNewHighFindings: 0,
      maxNewMediumFindings: 10,
      minSuccessRateDelta: -0.1,
      maxP95LatencyDelta: 0.5,
      graderConfidencePolicy: {
        requireDeterministicOrCorroborated: true,
        allowJudgeOnlyGates: false,
      },
    }, candidate);

    const confidenceGate = result.gates.find(g => g.gateName === 'grader-confidence-policy');
    expect(confidenceGate).toBeDefined();
    expect(confidenceGate!.passed).toBe(false);
  });

  it('allows judge-only grading when policy explicitly allows it', async () => {
    const { evaluateGates } = await import('../src/experiments/gates.js');
    const { compareRuns } = await import('../src/experiments/comparison.js');

    const candidate = {
      label: 'candidate',
      config: { label: 'candidate', metadata: { datasetId: 'core', datasetVersion: '1.0.0' } },
      runId: 'run-2',
      status: 'passed' as const,
      graderVersions: [{ id: 'rubric', version: '1.0.0' }],
      suiteResults: [{
        suiteId: 's1',
        scenarioId: 'scenario-1',
        status: 'passed' as const,
        metrics: [],
        graderVersions: [{ id: 'rubric', version: '1.0.0' }],
      }],
    };
    const baseline = { ...candidate, label: 'baseline', runId: 'run-1' };

    const comparison = compareRuns(baseline, candidate, {
      baselineLabel: 'baseline',
      candidateLabel: 'candidate',
      allowIncompatibleDatasets: true,
    });

    const result = evaluateGates(comparison, {
      requiredScenarioFailures: 0,
      maxNewHighFindings: 0,
      maxNewMediumFindings: 10,
      minSuccessRateDelta: -0.1,
      maxP95LatencyDelta: 0.5,
      graderConfidencePolicy: {
        requireDeterministicOrCorroborated: true,
        allowJudgeOnlyGates: true,
      },
    }, candidate);

    const confidenceGate = result.gates.find(g => g.gateName === 'grader-confidence-policy');
    expect(confidenceGate).toBeDefined();
    expect(confidenceGate!.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Calibration examples
// ---------------------------------------------------------------------------

describe('Default calibration examples', () => {
  it('returns deterministic calibration examples', () => {
    const examples = defaultDeterministicCalibrationExamples();
    expect(examples).toHaveLength(3);
    expect(examples[0].tags).toContain('smoke');
  });

  it('returns rubric calibration examples', () => {
    const examples = defaultRubricCalibrationExamples();
    expect(examples).toHaveLength(3);
    expect(examples.some(e => e.tags?.includes('safety'))).toBe(true);
    expect(examples.some(e => e.tags?.includes('edge-case'))).toBe(true);
  });
});
