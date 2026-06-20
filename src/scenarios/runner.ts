import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ScenarioDefinition } from './schema.js';
import { executeAction, evaluateAssertion, type CaptureStore } from './actions.js';
import { loadPackFromDir } from '../pack.js';
import type { GradingInput, Grade } from '../graders/grader.js';
import type { Grader } from '../graders/grader.js';
import type { ExecutionStatus } from '../core/status.js';
import type { ReliabilityReport } from '../metrics/reliability.js';
import { computeReliability } from '../metrics/reliability.js';

export type TrialResult = {
  trial: number;
  status: ExecutionStatus;
  assertions: Array<{ name: string; passed: boolean; message: string }>;
  grades: Grade[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  error?: string;
  evidence: string[];
};

export type ScenarioRunResult = {
  scenarioId: string;
  title: string;
  status: ExecutionStatus;
  trials: TrialResult[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  dataset?: {
    id: string;
    version: string;
    contentHash: string;
  };
  graderVersions: Array<{ id: string; version: string }>;
  reliability: ReliabilityReport;
  evidence: string[];
};

export type ScenarioRunnerOptions = {
  packDir: string;
  baseUrl: string;
  storageState?: string;
  headless?: boolean;
  outputDir?: string;
  graders?: Array<Grader>;
  dataset?: {
    id: string;
    version: string;
    contentHash: string;
  };
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
    const evidence: string[] = [];
    const toolCalls: string[] = [];
    let pageText = '';

    let trialStatus: ExecutionStatus = 'passed';
    let trialError: string | undefined;
    let beforeState: Record<string, unknown> = {};
    let afterState: Record<string, unknown> = {};

    try {
      if (scenario.target.kind === 'fixture') {
        // Fixture target: use HTTP directly (no browser needed)
        const setupActions = scenario.setup ?? [];
        for (const action of setupActions) {
          await executeFixtureAction(action, captures, options.baseUrl);
          toolCalls.push(fixtureActionTool(action));
        }

        // Capture before state if state-diff grading is configured
        if (scenario.graders?.some((g) => g.type === 'state-diff')) {
          beforeState = await fetchJson(`${options.baseUrl}/state`);
        }

        for (const step of scenario.steps) {
          await executeFixtureAction(step, captures, options.baseUrl);
          toolCalls.push(fixtureActionTool(step));
        }

        // Capture after state
        if (scenario.graders?.some((g) => g.type === 'state-diff')) {
          afterState = await fetchJson(`${options.baseUrl}/state`);
        }

        // Fixture assertions via HTTP
        for (const assertion of scenario.expected) {
          const result = await evaluateFixtureAssertion(assertion, captures, options.baseUrl);
          assertions.push({
            name: assertion.assertion,
            passed: result.passed,
            message: result.message,
          });
          if (!result.passed) trialStatus = 'failed';
        }

        // Cleanup
        if (scenario.cleanup?.strategy === 'reset-session') {
          await fetch(`${options.baseUrl}/reset`, { method: 'POST' }).catch(() => {});
        }
      } else {
        // Browser target (default)
        const browser = await chromium.launch({ headless: options.headless ?? true });
        const context = options.storageState
          ? await browser.newContext({ storageState: options.storageState })
          : await browser.newContext();
        const page = await context.newPage();

        try {
          const setupActions = scenario.setup ?? [];
          for (const action of setupActions) {
            await executeAction(page, action, captures, options.baseUrl);
          }

          for (const step of scenario.steps) {
            await executeAction(page, step, captures, options.baseUrl);
          }

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
          if (trialStatus !== 'passed' && options.outputDir) {
            const screenshotPath = path.join(
              options.outputDir,
              scenario.id,
              `trial-${t}`,
              'failure.png',
            );
            await mkdir(path.dirname(screenshotPath), { recursive: true });
            await page.screenshot({ path: screenshotPath, fullPage: true })
              .catch(() => undefined);
            evidence.push(screenshotPath);
          }
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
          context: {
            scenarioId: scenario.id,
            trial: t,
            beforeState,
            afterState,
            toolCalls,
          },
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

    if (trialStatus !== 'passed' && options.outputDir) {
      const evidencePath = path.join(
        options.outputDir,
        scenario.id,
        `trial-${t}`,
        'failure.json',
      );
      await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, JSON.stringify({
        scenarioId: scenario.id,
        trial: t,
        status: trialStatus,
        error: trialError,
        assertions,
        beforeState,
        afterState,
        toolCalls,
        grades,
      }, null, 2), 'utf8');
      evidence.push(evidencePath);
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
      evidence,
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
    dataset: options.dataset,
    graderVersions: (options.graders ?? []).map((grader) => ({
      id: grader.id,
      version: grader.version,
    })),
    reliability: computeReliability(
      trials.map((trial) => trial.status as 'passed' | 'failed' | 'error' | 'cancelled'),
      trials.map((trial) => trial.durationMs),
      Math.min(3, trials.length || 1),
    ),
    evidence: trials.flatMap((trial) => trial.evidence),
  };
}

// ---------------------------------------------------------------------------
// Fixture execution helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const resp = await fetch(url);
  return resp.json() as Promise<Record<string, unknown>>;
}

async function executeFixtureAction(
  action: import('./schema.js').ScenarioAction,
  captures: CaptureStore,
  baseUrl: string,
): Promise<void> {
  switch (action.action) {
    case 'goto':
      // For fixture targets, 'goto' means a simple HTTP GET
      await fetch(action.url.startsWith('http') ? action.url : `${baseUrl}${action.url}`);
      break;

    case 'capture': {
      const url = `${baseUrl}${action.selector ?? '/'}`;
      const resp = await fetch(url);
      const text = await resp.text();
      captures.set(action.as, text);
      break;
    }

    case 'wait':
      await new Promise((r) => setTimeout(r, action.ms));
      break;

    default:
      // Other actions are ignored for fixture targets
      break;
  }
}

function fixtureActionTool(action: import('./schema.js').ScenarioAction): string {
  switch (action.action) {
    case 'goto':
    case 'capture':
      return 'http_get';
    case 'wait':
      return 'wait';
    default:
      return action.action;
  }
}

async function evaluateFixtureAssertion(
  assertion: import('./schema.js').ScenarioAssertion,
  captures: CaptureStore,
  baseUrl: string,
): Promise<{ passed: boolean; message: string }> {
  const resolveUrl = (path: string): string =>
    path.startsWith('http') ? path : `${baseUrl}${path}`;

  switch (assertion.assertion) {
    case 'text_present': {
      // First try captures (set by capture actions)
      const captureText = Array.from(captures.values()).join(' ');
      if (captureText && captureText.includes(assertion.text)) {
        return { passed: true, message: 'Text found in captured content' };
      }
      // Fall back to fetching the base URL
      const resp = await fetch(resolveUrl('/'));
      const text = await resp.text();
      const passed = text.includes(assertion.text);
      return { passed, message: passed ? 'Text found on page' : `Text "${assertion.text}" not found` };
    }

    case 'url_matches': {
      const passed = new RegExp(assertion.pattern).test(baseUrl);
      return { passed, message: passed ? 'URL matches' : `URL ${baseUrl} does not match ${assertion.pattern}` };
    }

    case 'state_equals': {
      try {
        const state = await fetchJson(`${baseUrl}/state`);
        const actual = getNestedValue(state, assertion.path);
        const passed = JSON.stringify(actual) === JSON.stringify(assertion.expected);
        return {
          passed,
          message: passed
            ? `State at "${assertion.path}" equals expected`
            : `State at "${assertion.path}": expected ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(actual)}`,
        };
      } catch (error) {
        return { passed: false, message: `State fetch failed: ${error}` };
      }
    }

    default:
      return { passed: false, message: `Assertion "${assertion.assertion}" not supported for fixture targets` };
  }
}

/** Get a nested value from an object by dot-separated path. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key: string) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}
