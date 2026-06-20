import path from 'node:path';
import type { Page, BrowserContext } from 'playwright';
import type { TraceWriter } from './traceWriter.js';
import type { ArtifactStore } from '../artifacts/artifactStore.js';
import type { LocatorRecipe, RecordedAction } from './traceTypes.js';

/**
 * Browser instrumentation: wraps Playwright events into trace spans,
 * captures screenshots, console/network logs, and records a semantic
 * action log suitable for replay generation.
 */

export type BrowserInstrumentationOptions = {
  captureConsole?: boolean;
  captureNetwork?: boolean;
  captureScreenshots?: boolean;
  captureVideo?: boolean;
  retainTraceOnSuccess?: boolean;
};

const DEFAULT_OPTIONS: BrowserInstrumentationOptions = {
  captureConsole: true,
  captureNetwork: true,
  captureScreenshots: true,
  captureVideo: false,
  retainTraceOnSuccess: false,
};

export class BrowserInstrumentation {
  private actionLog: RecordedAction[] = [];
  private spanIds: string[] = [];
  private options: BrowserInstrumentationOptions;
  private consoleMessages: Array<{ type: string; text: string; location?: string }> = [];
  private pageErrors: Array<{ message: string; stack?: string }> = [];
  private failedRequests: Array<{ url: string; method: string; error: string }> = [];
  private responseFailures: Array<{ url: string; status: number }> = [];

  constructor(
    private traceWriter: TraceWriter,
    private artifactStore: ArtifactStore,
    private runDir: string,
    options?: BrowserInstrumentationOptions,
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Attach event handlers to a Playwright browser context and page. Optionally starts Playwright tracing. */
  async instrument(context: BrowserContext, page: Page): Promise<string> {
    const spanId = this.traceWriter.startSpan({
      name: 'browser-session',
      kind: 'browser.action',
      attributes: { url: page.url(), captureVideo: !!this.options.captureVideo },
    });
    this.spanIds.push(spanId);

    // Start Playwright built-in tracing
    await context.tracing.start({
      screenshots: this.options.captureScreenshots,
      snapshots: true,
    }).catch(() => {});

    // Console events
    if (this.options.captureConsole) {
      page.on('console', (msg) => {
        this.consoleMessages.push({
          type: msg.type(),
          text: msg.text(),
          location: msg.location()?.url,
        });
        this.traceWriter.addEvent(spanId, 'console', {
          type: msg.type(),
          text: msg.text(),
        });
      });
    }

    // Page errors
    page.on('pageerror', (err) => {
      this.pageErrors.push({ message: err.message, stack: err.stack });
      this.traceWriter.addEvent(spanId, 'page-error', {
        message: err.message,
      });
    });

    // Failed requests
    if (this.options.captureNetwork) {
      page.on('requestfailed', (req) => {
        this.failedRequests.push({
          url: req.url(),
          method: req.method(),
          error: req.failure()?.errorText ?? 'unknown',
        });
        this.traceWriter.addEvent(spanId, 'request-failed', {
          url: req.url(),
          method: req.method(),
          failure: req.failure()?.errorText ?? null,
        });
      });

      page.on('response', (resp) => {
        if (resp.status() >= 400) {
          this.responseFailures.push({
            url: resp.url(),
            status: resp.status(),
          });
          this.traceWriter.addEvent(spanId, 'response-error', {
            url: resp.url(),
            status: resp.status(),
          });
        }
      });
    }

    // Navigation
    page.on('load', () => {
      this.actionLog.push({ type: 'goto', url: page.url() });
    });

    return spanId;
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

  /** Get captured console messages. */
  getConsoleMessages(): Array<{ type: string; text: string; location?: string }> {
    return [...this.consoleMessages];
  }

  /** Get captured page errors. */
  getPageErrors(): Array<{ message: string; stack?: string }> {
    return [...this.pageErrors];
  }

  /** Get captured failed requests. */
  getFailedRequests(): Array<{ url: string; method: string; error: string }> {
    return [...this.failedRequests];
  }

  /** Get captured response failures (4xx/5xx). */
  getResponseFailures(): Array<{ url: string; status: number }> {
    return [...this.responseFailures];
  }

  /**
   * Capture evidence — screenshots, trace, and network logs.
   * Call this on failure/error to ensure evidence is retained.
   */
  async captureEvidence(page: Page, outcome: 'passed' | 'failed' | 'error' | 'cancelled'): Promise<void> {
    const spanId = this.spanIds.length > 0 ? this.spanIds[this.spanIds.length - 1] : undefined;

    // Screenshot on failure
    if (outcome !== 'passed' && this.options.captureScreenshots) {
      try {
        const screenshotBuf = await page.screenshot({ fullPage: true, type: 'png' });
        await this.artifactStore.write({
          kind: 'screenshot',
          data: screenshotBuf,
          filename: `failure-${Date.now()}.png`,
          mediaType: 'image/png',
          traceId: this.traceWriter.getTraceId(),
          spanId,
        });
      } catch {
        // Best effort
      }
    }

    // Retain Playwright trace.zip on failure
    if (outcome !== 'passed') {
      const ctx = (page.context as any)();
      if (ctx && typeof ctx.tracing?.stop === 'function') {
        try {
          const traceDir = path.resolve(this.runDir, 'browser-evidence');
          const tracePath = path.join(traceDir, 'trace.zip');
          await ctx.tracing.stop({ path: tracePath });
          await this.artifactStore.copy(tracePath, 'playwright-trace', 'trace.zip', {
            traceId: this.traceWriter.getTraceId(),
            spanId,
            subDir: 'browser-evidence',
          });
        } catch {
          // Best effort
        }
      }
    }

    // Write console log artifact
    if (this.consoleMessages.length > 0) {
      await this.artifactStore.writeText(
        'console-log',
        JSON.stringify(this.consoleMessages, null, 2),
        'console.json',
        { traceId: this.traceWriter.getTraceId(), spanId, subDir: 'browser-evidence' },
      );
    }

    // Write network failures artifact
    if (this.failedRequests.length > 0 || this.responseFailures.length > 0) {
      await this.artifactStore.writeText(
        'network-failures',
        JSON.stringify({ failed: this.failedRequests, responseErrors: this.responseFailures }, null, 2),
        'network-failures.json',
        { traceId: this.traceWriter.getTraceId(), spanId, subDir: 'browser-evidence' },
      );
    }

    // Write action log
    if (this.actionLog.length > 0) {
      await this.artifactStore.writeJson(
        'action-log',
        this.actionLog,
        'action-log.json',
        { traceId: this.traceWriter.getTraceId(), spanId, subDir: 'browser-evidence' },
      );
    }
  }

  /** End instrumentation and persist all evidence. */
  async flush(): Promise<void> {
    for (const sid of this.spanIds) {
      this.traceWriter.endSpan(sid, 'ok', {
        actionCount: this.actionLog.length,
        consoleCount: this.consoleMessages.length,
        errorCount: this.pageErrors.length,
        failureCount: this.failedRequests.length,
      });
    }
    await this.traceWriter.flush();
  }
}
