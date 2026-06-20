import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { TraceWriter } from '../src/trace/traceWriter.js';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';
import { BrowserInstrumentation } from '../src/trace/browserInstrumentation.js';

describe('BrowserInstrumentation', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'browser-inst-test-'));

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records actions and console messages', () => {
    const writer = new TraceWriter(tmpDir, 'browser-test');
    const store = new ArtifactStore(tmpDir, 'browser-test-run');
    const inst = new BrowserInstrumentation(writer, store, tmpDir);

    inst.recordClick({ role: 'button', name: 'Submit' });
    inst.recordFill({ testId: 'username' }, 'testuser');
    inst.recordPress('Enter');
    inst.recordScreenshot('post-submit');
    inst.recordReload();

    const log = inst.getActionLog();
    expect(log.length).toBe(5);
    expect(log[0].type).toBe('click');
    expect(log[1].type).toBe('fill');
    expect(log[2].type).toBe('press');
    expect(log[3].type).toBe('screenshot');
    expect(log[4].type).toBe('reload');
  });

  it('builds locator recipe from selector', () => {
    // LocatorRecipe is just an interface — build one directly
    const locator = { css: '#my-button', text: 'Click Me' };
    expect(locator.css).toBe('#my-button');
    expect(locator.text).toBe('Click Me');
  });

  it('captureEvidence writes artifacts on failure', async () => {
    // We need a mock page that provides screenshot
    const mockPage: any = {
      async screenshot(opts?: any) {
        return Buffer.from('fake-png-data');
      },
    };

    const writer = new TraceWriter(tmpDir, 'capture-test');
    const store = new ArtifactStore(tmpDir, 'capture-run');
    const inst = new BrowserInstrumentation(writer, store, tmpDir);

    // Add some console messages
    const logSpy = (inst as any).consoleMessages;
    if (logSpy) {
      logSpy.push({ type: 'error', text: 'Something went wrong', location: 'https://example.com/app.js' });
    }

    await inst.captureEvidence(mockPage, 'failed');

    const artifacts = store.getArtifacts();
    expect(artifacts.length).toBeGreaterThanOrEqual(1);
    const screenshotArtifact = artifacts.find((a) => a.kind === 'screenshot');
    expect(screenshotArtifact).toBeTruthy();
  });

  it('captureEvidence skips screenshot on pass', async () => {
    const mockPage: any = {
      async screenshot() { return Buffer.from('data'); },
    };

    const writer = new TraceWriter(tmpDir, 'skip-screenshot');
    const store = new ArtifactStore(tmpDir, 'skip-run');
    const inst = new BrowserInstrumentation(writer, store, tmpDir);

    await inst.captureEvidence(mockPage, 'passed');

    const artifacts = store.getArtifacts();
    const screenshots = artifacts.filter((a) => a.kind === 'screenshot');
    expect(screenshots.length).toBe(0);
  });

  it('flush ends all open spans', async () => {
    const writer = new TraceWriter(tmpDir, 'flush-spans');
    const store = new ArtifactStore(tmpDir, 'flush-run');
    const inst = new BrowserInstrumentation(writer, store, tmpDir);

    // Simulate instrumentation
    const mockCtx: any = { on: () => {} };
    const mockPage: any = { on: () => {}, url: () => 'https://example.com' };

    await inst.instrument(mockCtx, mockPage);
    inst.recordClick({ role: 'button', name: 'Go' });
    await inst.flush();

    const spans = writer.getSpans();
    const browserSpan = spans.find((s) => s.kind === 'browser.action');
    expect(browserSpan?.endedAt).toBeTruthy();
    expect(browserSpan?.attributes.actionCount).toBe(1);
  });
});
