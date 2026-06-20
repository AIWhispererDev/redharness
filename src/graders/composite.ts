import type { Grader, Grade, GradingInput } from './grader.js';

/**
 * Composite grader: runs multiple sub-graders and aggregates their results.
 *
 * - If any sub-grader fails, the composite fails.
 * - The overall score is the average of sub-grader scores (where available).
 * - Evidence is concatenated from all sub-graders.
 */
export class CompositeGrader implements Grader {
  id = 'composite';
  version = '1.0.0';

  private graders: Grader[];

  constructor(graders: Grader[]) {
    this.graders = graders;
  }

  async grade(input: GradingInput): Promise<Grade> {
    const allGrades: Grade[] = [];
    let allPassed = true;
    let totalScore = 0;
    let scoredCount = 0;

    for (const grader of this.graders) {
      try {
        const grade = await grader.grade(input);
        allGrades.push(grade);
        if (grade.status === 'failed' || grade.status === 'error') {
          allPassed = false;
        }
        if (grade.score !== undefined) {
          totalScore += grade.score;
          scoredCount++;
        }
      } catch (error) {
        allPassed = false;
        allGrades.push({
          graderId: grader.id,
          graderVersion: grader.version,
          status: 'error',
          explanation: `Composite sub-grader threw: ${error instanceof Error ? error.message : String(error)}`,
          evidence: [],
        });
      }
    }

    const overallScore = scoredCount > 0 ? totalScore / scoredCount : undefined;
    const explanations = allGrades.map((g) => `[${g.graderId}] ${g.explanation}`);

    return {
      graderId: this.id,
      graderVersion: this.version,
      status: allPassed ? 'passed' : 'failed',
      score: overallScore,
      explanation: explanations.join('\n'),
      evidence: allGrades.flatMap((g) => g.evidence),
      metadata: {
        subGraderCount: this.graders.length,
        subGraderPassed: allGrades.filter((g) => g.status === 'passed').length,
      },
    };
  }
}
