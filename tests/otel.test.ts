import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportSpans } from '../src/exporters/otel.js';
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
});
