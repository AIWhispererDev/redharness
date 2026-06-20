import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { TraceWriter } from '../src/trace/traceWriter.js';

describe('TraceWriter', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'trace-test-'));

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates spans with unique IDs', () => {
    const writer = new TraceWriter(tmpDir, 'trace-id');
    const id1 = writer.startSpan({ name: 'span-1', kind: 'run' });
    const id2 = writer.startSpan({ name: 'span-2', kind: 'suite' });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('sets parent-child relationships', () => {
    const writer = new TraceWriter(tmpDir, 'trace-parent');
    const parentId = writer.startSpan({ name: 'parent', kind: 'run' });
    const childId = writer.startSpan({ name: 'child', kind: 'suite', parentSpanId: parentId });

    const spans = writer.getSpans();
    const child = spans.find((s) => s.spanId === childId);
    expect(child?.parentSpanId).toBe(parentId);
  });

  it('ends spans with status and duration', () => {
    const writer = new TraceWriter(tmpDir, 'trace-status');
    const id = writer.startSpan({ name: 'test', kind: 'suite' });
    writer.endSpan(id, 'error', { reason: 'timeout' });

    const span = writer.getSpans().find((s) => s.spanId === id);
    expect(span?.endedAt).toBeTruthy();
    expect(span?.status).toBe('error');
    expect(span?.attributes.reason).toBe('timeout');
  });

  it('adds events to spans', () => {
    const writer = new TraceWriter(tmpDir, 'trace-events');
    const id = writer.startSpan({ name: 'browser', kind: 'browser.action' });
    writer.addEvent(id, 'console', { type: 'log', text: 'hello' });

    const span = writer.getSpans().find((s) => s.spanId === id);
    expect(span?.events.length).toBe(1);
    expect(span?.events[0].name).toBe('console');
    expect(span?.events[0].attributes.text).toBe('hello');
  });

  it('sets attributes on spans', () => {
    const writer = new TraceWriter(tmpDir, 'trace-attr');
    const id = writer.startSpan({ name: 'suite', kind: 'suite' });
    writer.setAttribute(id, 'suiteId', 'public-routes');
    writer.setAttribute(id, 'passed', true);

    const span = writer.getSpans().find((s) => s.spanId === id);
    expect(span?.attributes.suiteId).toBe('public-routes');
    expect(span?.attributes.passed).toBe(true);
  });

  it('builds correlation IDs', () => {
    const writer = new TraceWriter(tmpDir, 'corr-trace');
    const corr = writer.buildCorrelation({ runId: 'run-1', attemptId: 'attempt-1' });

    expect(corr.traceId).toBe('corr-trace');
    expect(corr.runId).toBe('run-1');
    expect(corr.attemptId).toBe('attempt-1');
  });

  it('flushes spans to JSONL file', async () => {
    const writer = new TraceWriter(tmpDir, 'flush-trace');
    writer.startSpan({ name: 'flush-test', kind: 'run' });
    await writer.flush();

    const traceDir = join(tmpDir, 'traces');
    expect(existsSync(traceDir)).toBe(true);
    const files = require('fs').readdirSync(traceDir);
    const jsonlFile = files.find((f: string) => f.endsWith('.jsonl'));
    expect(jsonlFile).toBeTruthy();

    const content = readFileSync(join(traceDir, jsonlFile!), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.name).toBe('flush-test');
    expect(parsed.traceId).toBe('flush-trace');
  });

  it('loads persisted spans from run directory', async () => {
    const writer = new TraceWriter(tmpDir, 'load-trace');
    writer.startSpan({ name: 'persisted', kind: 'run' });
    await writer.flush();

    const loaded = await TraceWriter.load(tmpDir);
    expect(loaded.length).toBeGreaterThanOrEqual(1);
    expect(loaded.some((s) => s.name === 'persisted')).toBe(true);
  });

  it('handles multiple spans in one trace', async () => {
    const writer = new TraceWriter(tmpDir, 'multi-trace');
    writer.startSpan({ name: 'run', kind: 'run' });
    writer.startSpan({ name: 'suite-a', kind: 'suite' });
    writer.startSpan({ name: 'suite-b', kind: 'suite' });
    await writer.flush();

    const content = readFileSync(join(tmpDir, 'traces', `trace-multi-trace.jsonl`), 'utf8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(3);
  });
});
