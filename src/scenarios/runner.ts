import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ScenarioDefinition } from './schema.js';
import { executeAction, evaluateAssertion, type CaptureStore } from './actions.js';
import { loadPackFromDir } from '../pack.js';
import type { GradingInput, Grade } from '../graders/grader.js';
import type { ExecutionStatus } from '../core/status.js';

export type TrialResult = {
  trial: number;
  status: ExecutionStatus;
  assertions: Array<{ name: string; passed: boolean; message: string }>;
  grades: Grade[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
};

export type ScenarioRunResult = {
  scenarioId: string;
  title: string;
  status: ExecutionStatus;
  trials: TrialResult[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

export type ScenarioRunnerOptions = {
  packDir: string;
  baseUrl: string;
  storageState?: string;
  headless?: boolean;
  outputDir?: string;
  graders?: Array<{ id: string; version: string; grade(input: GradingInput): Promise<Grade> }>;
};

/**
 * Run a single scenario with optional multiple trials.
 */
export async function runScenario(
  scenario: ScenarioDefinition,
  options: ScenarioRunnerOptions,
): Promise<ScenarioRunResult> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const trialCount = scenario.trials ?? 1;
  const trials: TrialResult[] = [];

  for (let t = 1; t <= trialCount; t++) {
    const trialStartedAt = new Date().toISOString();
    const trialStartMs = Date.now();
    const captures: CaptureStore = new Map();
    const assertions: Array<{ name: string; passed: boolean; message: string }> = [];
    let pageText = '';

    let trialStatus: ExecutionStatus = 'passed';
    let trialError: string | undefined;

    try {
      const browser = await chromium.launch({ headless: options.headless ?? true });
      const context = options.storageState
        ? await browser.newContext({ storageState: options.storageState })
        : await browser.newContext();
      const page = await context.newPage();

      try {
        // Setup steps (default to empty array if not provided)
        const setupActions = scenario.setup ?? [];
        for (const action of setupActions) {
          await executeAction(page, action, captures, options.baseUrl);
        }

        // Main steps
        for (const step of scenario.steps) {
          await executeAction(page, step, captures, options.baseUrl);
        }

        // Assertions
        for (const assertion of scenario.expected) {
          const result = await evaluateAssertion(page, assertion, captures);
          assertions.push({
            name: assertion.assertion,
            passed: result.passed,
            message: result.message,
          });
          if (!result.passed) trialStatus = 'failed';
        }

        pageText = await page.locator('body').innerText().catch(() => '');
      } finally {
        if (scenario.cleanup?.strategy === 'navigate-home') {
          await page.goto(options.baseUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 10_000,
          }).catch(() => {});
        } else if (scenario.cleanup?.strategy === 'reset-session') {
          await context.clearCookies().catch(() => {});
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          }).catch(() => {});
        }
        await browser.close();
      }
    } catch (error) {
      trialStatus = 'error';
      trialError = error instanceof Error ? error.message : String(error);
    }

    // Run graders
    const grades: Grade[] = [];
    if (options.graders && scenario.graders) {
      for (const grader of options.graders) {
        const graderDef = scenario.graders.find((g) => g.id === grader.id);
        if (!graderDef) continue;

        const gradeInput: GradingInput = {
          response: pageText,
          target: graderDef.target ?? 'page_text',
          context: { scenarioId: scenario.id, trial: t },
        };

        try {
          const grade = await grader.grade(gradeInput);
          grades.push(grade);
          if (grade.status === 'failed' && trialStatus === 'passed') {
            trialStatus = 'failed';
          }
        } catch (error) {
          grades.push({
            graderId: grader.id,
            graderVersion: grader.version,
            status: 'error',
            explanation: `Grader threw: ${error instanceof Error ? error.message : String(error)}`,
            evidence: [],
          });
        }
      }
    }

    trials.push({
      trial: t,
      status: trialStatus,
      assertions,
      grades,
      startedAt: trialStartedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - trialStartMs,
      error: trialError,
    });
  }

  // Aggregate status
  const aggregateStatus: ExecutionStatus = trials.some((t) => t.status === 'failed')
    ? 'failed'
    : trials.some((t) => t.status === 'error')
      ? 'error'
      : 'passed';

  return {
    scenarioId: scenario.id,
    title: scenario.title,
    status: aggregateStatus,
    trials,
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
  };
}
