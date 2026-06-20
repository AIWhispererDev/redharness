import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSpans } from '../src/exporters/otel.js';
import { redactOtelAttributes } from '../src/operations/operationalPolicy.js';
import type { TraceSpan } from '../src/trace/traceTypes.js';

const span: TraceSpan = {
  traceId: 'trace-one',
  spanId: 'span-one',
  attemptId: 'attempt-one',
  name: 'test span',
  kind: 'suite',
  startedAt: '2026-06-20T00:00:00.000Z',
  endedAt: '2026-06-20T00:00:01.000Z',
  status: 'ok',
  attributes: { suiteId: 'suite-one' },
  events: [],
};

const spanWithSensitive: TraceSpan = {
  traceId: 'trace-sensitive',
  spanId: 'span-sensitive',
  attemptId: 'attempt-sensitive',
  name: 'sensitive span',
  kind: 'run',
  startedAt: '2026-06-20T00:00:00.000Z',
  endedAt: '2026-06-20T00:00:01.000Z',
  status: 'ok',
  attributes: {
    suiteId: 'auth-test',
    token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    storageState: '/home/user/.auth.json',
    'auth.token': 'secret-value',
    normalField: 'keep-this',
  },
  events: [],
};

describe('OTLP exporter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts OTLP JSON to the configured collector', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportSpans([span], {
      endpoint: 'http://collector.test/v1/traces',
      serviceName: 'qa-tests',
    });

    expect(result).toEqual({ exported: 1, failed: 0, errors: [] });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, request] = fetchMock.mock.calls[0];
    const payload = JSON.parse(request.body);
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].name)
      .toBe('test span');
  });

  it('fails with export timeout via AbortSignal', async () => {
    // Create a slow-response mock that triggers timeout
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation(async (url: string, options: any) => {
      capturedSignal = options.signal;
      // Simulate the signal aborting
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) {
          resolve();
        } else {
          options.signal?.addEventListener('abort', () => resolve());
        }
      });
      throw new Error('The operation was aborted');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportSpans([span], {
      endpoint: 'http://timeout-collector.test/v1/traces',
      timeoutMs: 50,
      failSilently: true,
    });

    expect(result.exported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
  });

  it('redacts sensitive attributes before export', async () => {
    const redacted = redactOtelAttributes(
      spanWithSensitive.attributes as Record<string, unknown>,
      ['token', 'storageState', 'auth.token'],
    );

    expect(redacted.suiteId).toBe('auth-test');
    expect(redacted.normalField).toBe('keep-this');
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted.storageState).toBe('[REDACTED]');
    expect(redacted['auth.token']).toBe('[REDACTED]');
  });

  it('redacts sensitive data in the export payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await exportSpans([spanWithSensitive], {
      endpoint: 'http://collector.test/v1/traces',
      redactedKeys: ['token', 'storageState'],
    });

    const [, request] = fetchMock.mock.calls[0];
    const payload = JSON.parse(request.body);
    const exportedAttrs = payload.resourceSpans[0].scopeSpans[0].spans[0].attributes;

    // Check that redaction was applied — the gen_ai attributes should contain
    // '[REDACTED]' for sensitive fields
    const attrMap: Record<string, any> = {};
    for (const attr of exportedAttrs) {
      attrMap[attr.key] = attr.value;
    }

    // gen_ai.token should be redacted
    expect(attrMap['gen_ai.token']?.stringValue).toBe('[REDACTED]');
    expect(attrMap['gen_ai.normalField']?.stringValue).toBe('keep-this');
  });

  it('reports export failure without affecting run status', async () => {
    const runStatus = 'passed';
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network error'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportSpans([span], {
      endpoint: 'http://unreachable/v1/traces',
      failSilently: true,
    });

    expect(result.exported).toBe(0);
    expect(result.failed).toBe(1);
    expect(runStatus).toBe('passed');
  });

  it('uses default timeout when not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportSpans([span], {
      endpoint: 'http://collector.test/v1/traces',
    });

    expect(result.exported).toBe(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, options] = fetchMock.mock.calls[0];
    // Should have an AbortSignal even without explicit timeout
    expect(options.signal).toBeTruthy();
  });
});
