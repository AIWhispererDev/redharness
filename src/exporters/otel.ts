/**
 * PRD 06: OpenTelemetry exporter — maps harness trace spans to
 * OpenTelemetry semantic conventions for GenAI and MCP.
 *
 * Because OpenTelemetry GenAI semantic conventions are still Development,
 * mappings live behind an exporter version and do not dictate the internal schema.
 *
 * Uses the OTLP/HTTP JSON encoding so the harness can export without tying
 * its internal trace model to an OpenTelemetry SDK implementation.
 */

import type { TraceSpan } from '../trace/traceTypes.js';
import { createHash } from 'node:crypto';

export type OtelExportOptions = {
  /** OTLP endpoint URL (e.g. http://localhost:4318/v1/traces). */
  endpoint?: string;
  /** Service name for the resource. */
  serviceName?: string;
  /** Exporter version for semantic convention tracking. */
  exporterVersion?: string;
  /** Whether to fail silently on export errors. */
  failSilently?: boolean;
  /** Additional OTLP headers, for example collector authentication. */
  headers?: Record<string, string>;
};

export type OtelExportResult = {
  exported: number;
  failed: number;
  errors: string[];
};

/**
 * Map a harness trace span to OTLP span attributes following
 * GenAI semantic conventions (Development).
 *
 * This is a structural map — actual OTLP export requires
 * the OpenTelemetry JS SDK.
 */
export function mapSpanToOtelAttributes(span: TraceSpan): Record<string, string | number | boolean> {
  const attrs: Record<string, string | number | boolean> = {
    'gen_ai.operation.name': mapKindToOperation(span.kind),
    'gen_ai.system': 'qa-harness',
    'span.kind': span.kind,
    'span.status': span.status,
    'trace.id': span.traceId,
    'span.id': span.spanId,
  };

  if (span.parentSpanId) {
    attrs['parent.span.id'] = span.parentSpanId;
  }

  // Copy relevant custom attributes
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attrs[`gen_ai.${key}`] = value;
    }
  }

  return attrs;
}

/**
 * Map harness span kind to GenAI operation name.
 */
function mapKindToOperation(kind: string): string {
  const operationMap: Record<string, string> = {
    'run': 'run_suite',
    'suite': 'execute_suite',
    'scenario': 'evaluate_scenario',
    'browser.action': 'browser_interact',
    'http.request': 'http_request',
    'model.generate': 'generate',
    'agent.invoke': 'invoke_agent',
    'agent.plan': 'plan',
    'tool.execute': 'execute_tool',
    'grader.score': 'grade',
    'artifact.write': 'write_artifact',
    'policy.check': 'check_policy',
  };
  return operationMap[kind] ?? kind;
}

/**
 * Export a batch of spans via OTLP/HTTP JSON.
 */
export async function exportSpans(
  spans: TraceSpan[],
  options?: OtelExportOptions,
): Promise<OtelExportResult> {
  const errors: string[] = [];

  if (!options?.endpoint) {
    // Write to console as JSONL for development
    for (const span of spans) {
      const mapped = mapSpanToOtelAttributes(span);
      console.log(`[OTel] ${JSON.stringify(mapped)}`);
    }
    return { exported: spans.length, failed: 0, errors: [] };
  }

  const payload = {
    resourceSpans: [{
      resource: {
        attributes: [{
          key: 'service.name',
          value: { stringValue: options.serviceName ?? 'qa-harness' },
        }, {
          key: 'qa_harness.exporter.version',
          value: { stringValue: options.exporterVersion ?? '1' },
        }],
      },
      scopeSpans: [{
        scope: { name: 'qa-harness', version: options.exporterVersion ?? '1' },
        spans: spans.map(toOtlpSpan),
      }],
    }],
  };

  try {
    const response = await fetch(options.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...options.headers,
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`OTLP collector returned ${response.status}: ${await response.text()}`);
    }
    return { exported: spans.length, failed: 0, errors: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(message);
    if (!options.failSilently) console.warn(`[OTel] ${message}`);
    return {
      exported: 0,
      failed: spans.length,
      errors,
    };
  }
}

function toOtlpSpan(span: TraceSpan): Record<string, unknown> {
  return {
    traceId: normalizeId(span.traceId, 32),
    spanId: normalizeId(span.spanId, 16),
    ...(span.parentSpanId
      ? { parentSpanId: normalizeId(span.parentSpanId, 16) }
      : {}),
    name: span.name,
    kind: 1,
    startTimeUnixNano: toUnixNano(span.startedAt),
    endTimeUnixNano: toUnixNano(span.endedAt ?? span.startedAt),
    attributes: Object.entries(mapSpanToOtelAttributes(span)).map(
      ([key, value]) => ({
        key,
        value: typeof value === 'string'
          ? { stringValue: value }
          : typeof value === 'boolean'
            ? { boolValue: value }
            : Number.isInteger(value)
              ? { intValue: String(value) }
              : { doubleValue: value },
      }),
    ),
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: toUnixNano(event.timestamp),
      attributes: Object.entries(event.attributes)
        .filter(([, value]) =>
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean')
        .map(([key, value]) => ({
          key,
          value: typeof value === 'string'
            ? { stringValue: value }
            : typeof value === 'boolean'
              ? { boolValue: value }
              : { doubleValue: value },
        })),
    })),
    status: {
      code: span.status === 'ok' ? 1 : 2,
      message: span.status,
    },
  };
}

function normalizeId(value: string, length: number): string {
  const hex = value.replace(/[^a-f0-9]/gi, '').toLowerCase();
  if (hex.length === length) return hex;
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function toUnixNano(value: string): string {
  return (BigInt(new Date(value).getTime()) * 1_000_000n).toString();
}

/**
 * Export a single trace event as an OTel span data point.
 */
export function exportTraceEvent(
  _eventName: string,
  _attributes: Record<string, unknown>,
  _options?: OtelExportOptions,
): void {
  // Stub for future real OTLP export
}
