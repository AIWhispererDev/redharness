import { describe, it, expect } from 'vitest';
import {
  compileBrowserSpec,
  compileHttpSpec,
  compileGuidedSpec,
  compileHttpCurl,
} from '../src/replay/replayCompiler.js';
import type { RecordedAction, ReplaySpec, FindingPacketV2 } from '../src/trace/traceTypes.js';

describe('ReplayCompiler', () => {
  describe('compileHttpSpec', () => {
    it('generates valid Playwright HTTP test without expect(true)', () => {
      const spec: ReplaySpec = {
        mode: 'http',
        method: 'GET',
        url: 'https://example.com/api/test',
        headers: { accept: 'application/json' },
        expectedStatus: 200,
        assertion: 'expected content',
      };

      const code = compileHttpSpec(spec);
      expect(code).toContain('expect(resp.status()).toBe(200)');
      expect(code).toContain('expect(body).toMatch');
      expect(code).not.toContain('expect(true).toBe(true)');
    });

    it('generates POST request spec', () => {
      const spec: ReplaySpec = {
        mode: 'http',
        method: 'POST',
        url: 'https://example.com/api/data',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'value' }),
        expectedStatus: 201,
        assertion: 'created',
      };

      const code = compileHttpSpec(spec);
      expect(code).toContain('method: \'POST\'');
      expect(code).toContain('data:');
      expect(code).toContain('toBe(201)');
    });
  });

  describe('compileHttpCurl', () => {
    it('generates curl command for GET request', () => {
      const spec: ReplaySpec = {
        mode: 'http',
        method: 'GET',
        url: 'https://example.com/api',
        headers: { accept: 'application/json' },
        expectedStatus: 200,
        assertion: 'x',
      };

      const curl = compileHttpCurl(spec);
      expect(curl).toContain('curl');
      expect(curl).toContain('-X GET');
      expect(curl).toContain('example.com/api');
    });

    it('redacts sensitive headers', () => {
      const spec: ReplaySpec = {
        mode: 'http',
        method: 'GET',
        url: 'https://example.com/secret',
        headers: { authorization: 'Bearer secret123', accept: 'text/html' },
        expectedStatus: 200,
        assertion: 'x',
      };

      const curl = compileHttpCurl(spec);
      expect(curl).not.toContain('secret123');
      expect(curl).toContain('text/html');
    });
  });

  describe('compileBrowserSpec', () => {
    it('generates Playwright test from actions', () => {
      const actions: RecordedAction[] = [
        { type: 'goto', url: 'https://example.com/login' },
        { type: 'fill', locator: { testId: 'username' }, valueRef: 'user' },
        { type: 'click', locator: { role: 'button', name: 'Submit' } },
      ];

      const code = compileBrowserSpec(actions, { type: 'url', pattern: '/dashboard' }, 'finding-1');
      expect(code).toContain('page.goto');
      expect(code).toContain('page.fill');
      expect(code).toContain('page.click');
      expect(code).toContain('toHaveURL');
      expect(code).not.toContain('expect(true).toBe(true)');
    });

    it('generates text assertion', () => {
      const actions: RecordedAction[] = [
        { type: 'goto', url: 'https://example.com' },
      ];

      const code = compileBrowserSpec(actions, { type: 'text', locator: { css: '.title' }, value: 'Welcome' }, 'finding-text');
      expect(code).toContain('toContainText');
      expect(code).toContain('Welcome');
    });

    it('generates visibility assertion', () => {
      const actions: RecordedAction[] = [{ type: 'goto', url: 'https://example.com' }];
      const code = compileBrowserSpec(actions, { type: 'visible', locator: { testId: 'error-msg' } }, 'finding-vis');
      expect(code).toContain('toBeVisible');
    });
  });

  describe('compileGuidedSpec', () => {
    it('generates scaffold with test.fixme', () => {
      const packet: FindingPacketV2 = {
        findingId: 'guided-1',
        lifecycleState: 'suspected',
        title: 'Manual review needed',
        severity: 'medium',
        category: 'manual',
        originatingSuiteId: 'test',
        originatingCheck: 'manual-review',
        initialAttemptId: 'attempt-1',
        confirmationAttemptIds: [],
        reproductionCount: 0,
        environment: { packId: 'test' },
        evidenceManifest: { runId: '', attemptId: '', traceId: '', artifacts: [], redactionSummary: [] },
        redactionSummary: [],
        expectedState: 'Should show validation',
        actualState: 'No validation shown',
        steps: ['Click button', 'Observe result'],
      };

      const code = compileGuidedSpec(packet, ['Cannot deterministically reconstruct clicks']);
      expect(code).toContain('test.fixme');
      expect(code).toContain('Cannot deterministically reconstruct');
      expect(code).not.toContain('expect(true).toBe(true)');
    });
  });
});
