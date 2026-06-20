import type { Page, BrowserContext } from 'playwright';
import type { TraceWriter } from './traceWriter.js';
import type { ArtifactStore } from '../artifacts/artifactStore.js';
import type { LocatorRecipe, RecordedAction } from './traceTypes.js';

/**
 * Browser instrumentation: wraps Playwright events into trace spans
 * and records a semantic action log suitable for replay generation.
 */

export type BrowserInstrumentationOptions = {
  headless?: boolean;
};

export class BrowserInstrumentation {
  private actionLog: RecordedAction[] = [];
  private spanIds: string[] = [];

  constructor(
    private traceWriter: TraceWriter,
    private artifactStore: ArtifactStore,
    private runDir: string,
  ) {}

  /** Attach event handlers to a Playwright browser context. */
  async instrument(context: BrowserContext, page: Page): Promise<void> {
    const spanId = this.traceWriter.startSpan({
      name: 'browser-session',
      kind: 'browser.action',
      attributes: { url: page.url() },
    });
    this.spanIds.push(spanId);

    // Console events
    page.on('console', (msg) => {
      this.traceWriter.addEvent(spanId, 'console', {
        type: msg.type(),
        text: msg.text(),
      });
    });

    // Failed requests
    page.on('requestfailed', (req) => {
      this.traceWriter.addEvent(spanId, 'request-failed', {
        url: req.url(),
        method: req.method(),
        failure: req.failure()?.errorText ?? null,
      });
    });

    // Navigation
    page.on('load', () => {
      this.actionLog.push({ type: 'goto', url: page.url() });
    });
  }

  /** Record a click action. */
  recordClick(locator: LocatorRecipe): void {
    this.actionLog.push({ type: 'click', locator });
  }

  /** Record a fill action. */
  recordFill(locator: LocatorRecipe, valueRef: string): void {
    this.actionLog.push({ type: 'fill', locator, valueRef });
  }

  /** Record a key press. */
  recordPress(key: string): void {
    this.actionLog.push({ type: 'press', key });
  }

  /** Record a reload. */
  recordReload(): void {
    this.actionLog.push({ type: 'reload' });
  }

  /** Record a screenshot. */
  recordScreenshot(name: string): void {
    this.actionLog.push({ type: 'screenshot', name });
  }

  /** Get the recorded action log. */
  getActionLog(): RecordedAction[] {
    return [...this.actionLog];
  }

  /** Build a locator recipe from a Playwright locator. */
  static buildLocator(page: Page, selector: string, text?: string): LocatorRecipe {
    // Prefer role-based locators
    const byRole = page.locator(selector);
    return { css: selector, text };
  }

  /** End instrumentation and persist trace. */
  async flush(): Promise<void> {
    for (const sid of this.spanIds) {
      this.traceWriter.endSpan(sid);
    }
    await this.traceWriter.flush();
  }
}
