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
import { redactOtelAttributes } from '../operations/operationalPolicy.js';

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
  /** Export timeout in milliseconds (default 5000). */
  timeoutMs?: number;
  /** Attribute keys whose values should be redacted before export. */
  redactedKeys?: string[];
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
    'gen_ai.system': 'redharness',
    'span.kind': span.kind,
    'span.status': span.status,
    'trace.id': span.traceId,
    'span.id': span.spanId,
  };

  if (span.parentSpanId) {
    attrs['parent.span.id'] = span.parentSpanId;
  }

  // Agent-invoke specific attributes
  if (span.kind === 'agent.invoke') {
    const agentId = span.attributes['agentId'];
    if (typeof agentId === 'string') {
      attrs['gen_ai.agent.id'] = agentId;
    }
  }

  // Model generation attributes
  if (span.kind === 'model.generate') {
    const model = span.attributes['model'];
    const finishReason = span.attributes['finishReason'];
    const inputTokens = span.attributes['inputTokens'];
    const outputTokens = span.attributes['outputTokens'];
    if (typeof model === 'string') attrs['gen_ai.request.model'] = model;
    if (typeof finishReason === 'string') attrs['gen_ai.response.finish_reason'] = finishReason;
    if (typeof inputTokens === 'number') attrs['gen_ai.response.input_tokens'] = inputTokens;
    if (typeof outputTokens === 'number') attrs['gen_ai.response.output_tokens'] = outputTokens;
  }

  // Tool execution attributes
  if (span.kind === 'tool.execute') {
    const toolName = span.attributes['toolName'];
    const success = span.attributes['success'];
    const durationMs = span.attributes['durationMs'];
    if (typeof toolName === 'string') attrs['gen_ai.tool.name'] = toolName;
    if (typeof success === 'boolean') attrs['gen_ai.tool.success'] = success;
    if (typeof durationMs === 'number') attrs['gen_ai.tool.duration_ms'] = durationMs;
  }

  // Policy check attributes
  if (span.kind === 'policy.check') {
    const allowed = span.attributes['allowed'];
    const policy = span.attributes['policy'];
    if (typeof allowed === 'boolean') attrs['gen_ai.policy.allowed'] = allowed;
    if (typeof policy === 'string') attrs['gen_ai.policy.policy'] = policy;
  }

  // Grader score attributes
  if (span.kind === 'grader.score') {
    const score = span.attributes['score'];
    const passed = span.attributes['passed'];
    if (typeof score === 'number') attrs['gen_ai.grade.score'] = score;
    if (typeof passed === 'boolean') attrs['gen_ai.grade.passed'] = passed;
  }

  // Copy remaining custom attributes that aren't already mapped
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      const attrKey = `gen_ai.${key}`;
      // Don't overwrite already-set convention attributes
      if (!(attrKey in attrs)) {
        attrs[attrKey] = value;
      }
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
    'policy.approval': 'approval_event',
    'checkpoint.save': 'checkpoint_save',
    'checkpoint.load': 'checkpoint_load',
    'agent.cleanup': 'cleanup',
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
  const timeoutMs = options?.timeoutMs ?? 5000;
  const redactedKeys = options?.redactedKeys ?? [];

  // Apply redaction before any export
  const redactedSpans = redactedKeys.length > 0
    ? spans.map((span) => ({
        ...span,
        attributes: redactOtelAttributes(span.attributes as Record<string, unknown>, redactedKeys) as Record<string, string | number | boolean>,
      }))
    : spans;

  if (!options?.endpoint) {
    // Write to console as JSONL for development
    for (const span of redactedSpans) {
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
          value: { stringValue: options.serviceName ?? 'redharness' },
        }, {
          key: 'redharness.exporter.version',
          value: { stringValue: options.exporterVersion ?? '1' },
        }],
      },
      scopeSpans: [{
        scope: { name: 'redharness', version: options.exporterVersion ?? '1' },
        spans: redactedSpans.map(toOtlpSpan),
      }],
    }],
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`OTLP collector returned ${response.status}: ${await response.text()}`);
      }
      return { exported: spans.length, failed: 0, errors: [] };
    } finally {
      clearTimeout(timeout);
    }
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
