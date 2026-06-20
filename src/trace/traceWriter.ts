import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TraceSpan, TraceCorrelation, TraceEvent, JsonValue } from './traceTypes.js';

/**
 * Manages trace spans within a single run directory.
 * Appends spans to a JSONL file for crash-safe incremental storage.
 */
export class TraceWriter {
  private spans: TraceSpan[] = [];
  private dirty = false;

  constructor(
    private runDir: string,
    private traceId = randomUUID().replace(/-/g, '').slice(0, 16),
  ) {}

  getTraceId(): string {
    return this.traceId;
  }

  /** Create a new span and return its id. */
  startSpan(params: {
    name: string;
    kind: TraceSpan['kind'];
    parentSpanId?: string;
    attemptId?: string;
    attributes?: Record<string, JsonValue>;
  }): string {
    const spanId = randomUUID().replace(/-/g, '').slice(0, 16);
    const span: TraceSpan = {
      traceId: this.traceId,
      spanId,
      parentSpanId: params.parentSpanId,
      attemptId: params.attemptId ?? '0',
      name: params.name,
      kind: params.kind,
      startedAt: new Date().toISOString(),
      status: 'ok',
      attributes: params.attributes ?? {},
      events: [],
    };
    this.spans.push(span);
    this.dirty = true;
    return spanId;
  }

  /** End a span, setting its status and duration. */
  endSpan(spanId: string, status?: TraceSpan['status'], attributes?: Record<string, JsonValue>): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    span.endedAt = new Date().toISOString();
    if (status) span.status = status;
    if (attributes) Object.assign(span.attributes, attributes);
    this.dirty = true;
  }

  /** Add an event to an existing span. */
  addEvent(spanId: string, name: string, attributes?: Record<string, JsonValue>): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    const event: TraceEvent = { name, timestamp: new Date().toISOString(), attributes: attributes ?? {} };
    span.events.push(event);
    this.dirty = true;
  }

  /** Set an attribute on a span. */
  setAttribute(spanId: string, key: string, value: JsonValue): void {
    const span = this.spans.find((s) => s.spanId === spanId);
    if (!span) return;
    span.attributes[key] = value;
    this.dirty = true;
  }

  /** Build correlation IDs. */
  buildCorrelation(overrides: Partial<TraceCorrelation>): TraceCorrelation {
    return {
      runId: '',
      attemptId: '0',
      traceId: this.traceId,
      ...overrides,
    };
  }

  /** Persist all spans to traces.jsonl (append-only). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    const traceDir = path.join(this.runDir, 'traces');
    await mkdir(traceDir, { recursive: true });
    const lines = this.spans.map((s) => JSON.stringify(s)).join('\n');
    await writeFile(path.join(traceDir, `trace-${this.traceId}.jsonl`), lines + '\n', 'utf8');
    this.dirty = false;
  }

  /** Load traces from a run directory. */
  static async load(runDir: string): Promise<TraceSpan[]> {
    const traceDir = path.join(runDir, 'traces');
    const spans: TraceSpan[] = [];
    try {
      const files = await (await import('node:fs/promises')).readdir(traceDir);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const content = await readFile(path.join(traceDir, file), 'utf8');
        for (const line of content.trim().split('\n')) {
          if (line) spans.push(JSON.parse(line) as TraceSpan);
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return spans;
  }

  /** Get all spans currently in memory. */
  getSpans(): TraceSpan[] {
    return [...this.spans];
  }
}
