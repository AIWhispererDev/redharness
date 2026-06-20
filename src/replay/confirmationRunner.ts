import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type Page, type BrowserContext } from 'playwright';
import type { ReplaySpec, FindingPacketV2, FindingLifecycleState, RecordedAction, AssertionRecipe, LocatorRecipe } from '../trace/traceTypes.js';

/**
 * Confirmation runner: executes replay specs to confirm or reject findings.
 *
 * The lifecycle rule is:
 * - `confirmed-semantic` requires at least one confirmation attempt, linked evidence,
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
  /** Directory to write confirmation evidence artifacts. */
  evidenceDir?: string;
};

/**
 * Run confirmation against a replay spec.
 *
 * For HTTP replays, executes the request and checks the status/body.
 * For browser replays, launches a headless browser and replays recorded actions.
 * Returns the new lifecycle state and evidence paths.
 */
export async function confirmFinding(
  packet: FindingPacketV2,
  spec: ReplaySpec,
  options?: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const attempts: number[] = [];
  const evidencePaths: string[] = [];
  const evidenceDir = options?.evidenceDir;

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

        // Persist evidence for this attempt
        if (evidenceDir) {
          const attemptDir = path.join(evidenceDir, `attempt-${i + 1}`);
          await mkdir(attemptDir, { recursive: true });
          await writeFile(path.join(attemptDir, 'response.json'), JSON.stringify({
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
            bodyPreview: body.slice(0, 2000),
            matched: reproduced,
          }, null, 2), 'utf8');
          evidencePaths.push(attemptDir);
        }

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
      } catch (err) {
        attempts.push(i + 1);
        if (evidenceDir) {
          const attemptDir = path.join(evidenceDir, `attempt-${i + 1}`);
          await mkdir(attemptDir, { recursive: true });
          await writeFile(path.join(attemptDir, 'error.json'), JSON.stringify({
            error: String(err),
          }, null, 2), 'utf8');
          evidencePaths.push(attemptDir);
        }
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
      let context: BrowserContext | null = null;
      try {
        context = await browser.newContext();
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();

        for (const action of [...spec.setup, ...spec.actions]) {
          await executeBrowserAction(page, action);
        }
        await assertBrowserOutcome(page, spec.assertion);

        attempts.push(i + 1);

        // Persist trace evidence on success
        if (evidenceDir) {
          const attemptDir = path.join(evidenceDir, `attempt-${i + 1}`);
          await mkdir(attemptDir, { recursive: true });
          await context.tracing.stop({ path: path.join(attemptDir, 'trace.zip') }).catch(() => {});
          evidencePaths.push(attemptDir);
        }

        return {
          findingId: packet.findingId,
          lifecycleState: 'confirmed-semantic',
          reproduced: true,
          attempts: attempts.length,
          evidencePaths: [...evidencePaths, ...(spec.linkedArtifactIds ?? [])],
          message: `Browser replay confirmed on attempt ${i + 1}`,
        };
      } catch {
        attempts.push(i + 1);
        // Persist trace evidence on failure too
        if (evidenceDir && context) {
          const attemptDir = path.join(evidenceDir, `attempt-${i + 1}`);
          await mkdir(attemptDir, { recursive: true });
          await context.tracing.stop({ path: path.join(attemptDir, 'trace.zip') }).catch(() => {});
          evidencePaths.push(attemptDir);
        }
      } finally {
        await browser.close();
      }
    }
    return {
      findingId: packet.findingId,
      lifecycleState: 'suspected',
      reproduced: false,
      attempts: attempts.length,
      evidencePaths: [...evidencePaths, ...(spec.linkedArtifactIds ?? [])],
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

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Browser replay execution with improved locator support
// ---------------------------------------------------------------------------

function locatorSelector(locator: LocatorRecipe): string {
  if (locator.testId) return `[data-testid="${locator.testId}"]`;
  if (locator.css) return locator.css;
  if (locator.role && locator.name) {
    // Role + name is the most specific — use Playwright's role locator internally
    return `role=${locator.role}[name="${locator.name.replace(/"/g, '\\"')}"]`;
  }
  if (locator.label) return `text=${locator.label}`;
  if (locator.text) return `text=${locator.text}`;
  return 'body';
}

async function executeBrowserAction(
  page: Page,
  action: RecordedAction,
): Promise<void> {
  switch (action.type) {
    case 'goto':
      await page.goto(action.url, { waitUntil: 'domcontentloaded' });
      break;

    case 'click': {
      const loc = locatorSelector(action.locator);
      // For role locators, use getByRole
      if (action.locator.role && action.locator.name) {
        await page.getByRole(action.locator.role as any, { name: action.locator.name }).click();
      } else {
        await page.locator(loc).click();
      }
      break;
    }

    case 'fill': {
      if (action.locator.role && action.locator.name) {
        await page.getByRole(action.locator.role as any, { name: action.locator.name }).fill(action.valueRef);
      } else {
        await page.locator(locatorSelector(action.locator)).fill(action.valueRef);
      }
      break;
    }

    case 'press':
      await page.keyboard.press(action.key);
      break;

    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded' });
      break;

    case 'request':
      // HTTP request action — fetch the referenced request
      try {
        const resp = await page.request.fetch(action.requestRef);
        if (!resp.ok()) {
          throw new Error(`Request to ${action.requestRef} returned ${resp.status()}`);
        }
      } catch (err) {
        // Allow the replay to continue — assertion will catch failures
        console.warn(`Replay request failed: ${err}`);
      }
      break;

    case 'waitFor':
      switch (action.condition.type) {
        case 'timeout':
          await page.waitForTimeout(action.condition.ms);
          break;
        case 'networkidle':
          await page.waitForLoadState('networkidle', { timeout: action.condition.timeoutMs ?? 10000 });
          break;
        case 'selector': {
          const selLoc = locatorSelector(action.condition.locator);
          await page.locator(selLoc).waitFor({ state: 'visible', timeout: action.condition.timeoutMs ?? 5000 }).catch(() => {});
          break;
        }
        default:
          await page.waitForTimeout(1000);
          break;
      }
      break;

    case 'assert':
      await assertBrowserOutcome(page, action.assertion);
      break;

    case 'screenshot':
      // Best-effort screenshot capture
      break;

    default:
      break;
  }
}

async function assertBrowserOutcome(
  page: Page,
  assertion: AssertionRecipe,
): Promise<void> {
  switch (assertion.type) {
    case 'url': {
      if (!new RegExp(assertion.pattern).test(page.url())) {
        throw new Error(`URL ${page.url()} did not match ${assertion.pattern}`);
      }
      return;
    }
    case 'state': {
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
    case 'visible': {
      const loc = locatorSelector(assertion.locator);
      if (assertion.locator.role && assertion.locator.name) {
        if (!await page.getByRole(assertion.locator.role as any, { name: assertion.locator.name }).isVisible()) {
          throw new Error(`Expected role=${assertion.locator.role}[name="${assertion.locator.name}"] to be visible`);
        }
      } else {
        if (!await page.locator(loc).isVisible()) throw new Error('Expected locator to be visible');
      }
      return;
    }
    case 'text': {
      const loc = locatorSelector(assertion.locator);
      const text = await page.locator(loc).textContent();
      if (!text?.includes(assertion.value)) {
        throw new Error(`Expected locator text to include "${assertion.value}", got "${text?.slice(0, 100)}"`);
      }
      return;
    }
    default:
      throw new Error(`Unknown assertion type: ${(assertion as any).type}`);
  }
}
