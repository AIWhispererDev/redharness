import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import type { ReplaySpec, FindingPacketV2, FindingLifecycleState } from '../trace/traceTypes.js';

/**
 * Confirmation runner: executes replay specs to confirm or reject findings.
 *
 * The lifecycle rule is:
 * - `confirmed` requires at least one confirmation attempt, linked evidence,
 *   and a successful replay or approved manual-confirmation record.
 * - Guided replays cannot become confirmed automatically.
 */

export type ConfirmationResult = {
  findingId: string;
  lifecycleState: FindingLifecycleState;
  reproduced: boolean;
  attempts: number;
  evidencePaths: string[];
  message: string;
};

export type ConfirmationOptions = {
  maxAttempts?: number;
  forceReplay?: boolean;
};

/**
 * Run confirmation against a replay spec.
 *
 * For HTTP replays, executes the request and checks the status/body.
 * For browser/guided replays, validates the spec is well-formed and records
 * the state. Returns the new lifecycle state.
 */
export async function confirmFinding(
  packet: FindingPacketV2,
  spec: ReplaySpec,
  options?: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const attempts: number[] = [];
  const evidencePaths: string[] = [];

  // Guided replays can never auto-confirm
  if (spec.mode === 'guided') {
    return {
      findingId: packet.findingId,
      lifecycleState: 'suspected',
      reproduced: false,
      attempts: 0,
      evidencePaths: [],
      message: 'Guided replay cannot be confirmed automatically — requires manual authoring',
    };
  }

  // HTTP confirmation
  if (spec.mode === 'http') {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const url = new URL(spec.url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url.toString(), {
          method: spec.method,
          headers: spec.headers as Record<string, string>,
          body: spec.method !== 'GET' ? spec.body : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const body = await response.text();
        const statusMatch = response.status === spec.expectedStatus;
        const bodyMatch = body.includes(spec.assertion) || new RegExp(spec.assertion).test(body);
        const reproduced = statusMatch && bodyMatch;

        attempts.push(i + 1);
        if (reproduced) {
          return {
            findingId: packet.findingId,
            lifecycleState: 'confirmed-semantic',
            reproduced: true,
            attempts: attempts.length,
            evidencePaths,
            message: `Confirmed on attempt ${i + 1}: status ${response.status}, body matched assertion`,
          };
        }
      } catch {
        attempts.push(i + 1);
      }
    }

    return {
      findingId: packet.findingId,
      lifecycleState: 'suspected',
      reproduced: false,
      attempts: attempts.length,
      evidencePaths,
      message: `Not confirmed after ${attempts.length} HTTP attempt(s)`,
    };
  }

  // Browser confirmation — execute the recorded actions and assertion.
  if (spec.mode === 'browser') {
    for (let i = 0; i < maxAttempts; i++) {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        for (const action of [...spec.setup, ...spec.actions]) {
          await executeBrowserAction(page, action);
        }
        await assertBrowserOutcome(page, spec.assertion);
        attempts.push(i + 1);
        return {
          findingId: packet.findingId,
          lifecycleState: 'confirmed-semantic',
          reproduced: true,
          attempts: attempts.length,
          evidencePaths: spec.linkedArtifactIds ?? [],
          message: `Browser replay confirmed on attempt ${i + 1}`,
        };
      } catch {
        attempts.push(i + 1);
      } finally {
        await browser.close();
      }
    }
    return {
      findingId: packet.findingId,
      lifecycleState: 'suspected',
      reproduced: false,
      attempts: attempts.length,
      evidencePaths: spec.linkedArtifactIds ?? [],
      message: `Browser replay did not reproduce after ${attempts.length} attempt(s)`,
    };
  }

  return {
    findingId: packet.findingId,
    lifecycleState: 'suspected',
    reproduced: false,
    attempts: 0,
    evidencePaths: [],
    message: 'Unknown replay mode — cannot confirm',
  };
}

/**
 * Load a finding packet from disk and attempt confirmation.
 */
export async function confirmFromPacket(
  packetDir: string,
  options?: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const jsonPath = path.join(packetDir, 'finding.json');
  const content = await readFile(jsonPath, 'utf8');
  const packet = JSON.parse(content) as FindingPacketV2;

  // Load the machine-readable replay specification written with the packet.
  const specPath = path.join(packetDir, 'replay.json');
  let spec: ReplaySpec;

  try {
    spec = JSON.parse(await readFile(specPath, 'utf8')) as ReplaySpec;
  } catch {
    spec = packet.replaySpec ?? {
      mode: 'guided',
      setupHint: packet.expectedState,
      unresolvedSteps: packet.steps,
      linkedArtifactIds: [],
    };
  }

  return confirmFinding(packet, spec, options);
}

/**
 * Check whether a lifecycle transition is valid.
 */
export function isValidTransition(
  from: FindingLifecycleState,
  to: FindingLifecycleState,
): boolean {
  const allowed: Record<string, FindingLifecycleState[]> = {
    'observed': ['suspected', 'rejected'],
    'needs-authoring': ['suspected', 'rejected'],
    'suspected': ['confirmed-semantic', 'confirmed-evidence', 'confirmed-state-harm', 'rejected', 'needs-authoring'],
    'confirmed-semantic': ['confirmed-evidence', 'confirmed-state-harm', 'mitigated', 'regression'],
    'confirmed-evidence': ['confirmed-state-harm', 'mitigated', 'regression'],
    'confirmed-state-harm': ['mitigated', 'regression'],
    'rejected': [],
    'mitigated': ['regression'],
    'regression': ['suspected'],
  };

  return allowed[from]?.includes(to) ?? false;
}

// Re-export for convenience
export type { FindingLifecycleState };

function locatorSelector(locator: import('../trace/traceTypes.js').LocatorRecipe): string {
  if (locator.testId) return `[data-testid="${locator.testId}"]`;
  if (locator.css) return locator.css;
  if (locator.role && locator.name) return `[role="${locator.role}"]`;
  if (locator.label) return `text=${locator.label}`;
  return 'body';
}

async function executeBrowserAction(
  page: Page,
  action: import('../trace/traceTypes.js').RecordedAction,
): Promise<void> {
  switch (action.type) {
    case 'goto':
      await page.goto(action.url, { waitUntil: 'domcontentloaded' });
      break;
    case 'click':
      await page.locator(locatorSelector(action.locator)).click();
      break;
    case 'fill':
      await page.locator(locatorSelector(action.locator)).fill(action.valueRef);
      break;
    case 'press':
      await page.keyboard.press(action.key);
      break;
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded' });
      break;
    case 'waitFor':
      if (action.condition.type === 'timeout') {
        await page.waitForTimeout(action.condition.ms);
      }
      break;
    case 'screenshot':
      break;
  }
}

async function assertBrowserOutcome(
  page: Page,
  assertion: import('../trace/traceTypes.js').AssertionRecipe,
): Promise<void> {
  if (assertion.type === 'url') {
    if (!new RegExp(assertion.pattern).test(page.url())) {
      throw new Error(`URL ${page.url()} did not match ${assertion.pattern}`);
    }
    return;
  }
  if (assertion.type === 'state') {
    const actual = await page.evaluate((statePath) => {
      const root = (globalThis as any).__QA_STATE__ ?? {};
      return statePath.split('.').reduce(
        (value: any, key: string) => value?.[key],
        root,
      );
    }, assertion.path);
    if (JSON.stringify(actual) !== JSON.stringify(assertion.expected)) {
      throw new Error(`State at ${assertion.path} did not match expected value`);
    }
    return;
  }
  const locator = page.locator(locatorSelector(assertion.locator));
  if (assertion.type === 'visible') {
    if (!await locator.isVisible()) throw new Error('Expected locator to be visible');
    return;
  }
  const text = await locator.textContent();
  if (!text?.includes(assertion.value)) {
    throw new Error(`Expected locator text to include ${assertion.value}`);
  }
}
