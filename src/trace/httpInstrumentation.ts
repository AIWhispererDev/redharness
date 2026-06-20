/**
 * HTTP request/response instrumentation with redaction, size limits,
 * and replay-safe capture.
 *
 * Captures sanitized exact requests and bounded responses suitable for
 * replay generation and finding packet evidence.
 */

import { createHash } from 'node:crypto';
import type { ArtifactRef } from './traceTypes.js';
import { redactDeep } from './redaction.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HttpCaptureOptions = {
  /** Maximum response body bytes to retain (default 64 KB). */
  maxBodyBytes?: number;
  /** Maximum request body bytes to retain (default 8 KB). */
  maxRequestBodyBytes?: number;
  /** Maximum number of headers to retain per request/response (default 50). */
  maxHeaders?: number;
  /** Sensitive header patterns to redact (default: cookie, authorization, token, key, set-cookie). */
  sensitiveHeaderPattern?: RegExp;
  /** Whether to capture request bodies for POST/PUT/PATCH (default false). */
  captureRequestBody?: boolean;
};

type CapturedRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  timestamp: string;
};

type CapturedResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body?: string;
  truncated: boolean;
  timestamp: string;
};

export type HttpCaptureRecord = {
  request: CapturedRequest;
  response: CapturedResponse;
  durationMs: number;
  /** SHA-256 of the full (untruncated) response body for deduplication. */
  responseBodyHash?: string;
};

/** Replay-safe capture — sanitized and ready for replay generation. */
export type ReplaySafeCapture = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  status: number;
  assertion: string;
};

// ---------------------------------------------------------------------------
// Default options
// ---------------------------------------------------------------------------

const DEFAULT_OPTIONS: HttpCaptureOptions = {
  maxBodyBytes: 64 * 1024,
  maxRequestBodyBytes: 8 * 1024,
  maxHeaders: 50,
  sensitiveHeaderPattern: /cookie|authorization|token|key|set-cookie|jwt|secret|credential|session/i,
  captureRequestBody: false,
};

// ---------------------------------------------------------------------------
// Instrumentation class
// ---------------------------------------------------------------------------

export class HttpInstrumentation {
  private captures: HttpCaptureRecord[] = [];
  private options: HttpCaptureOptions;

  constructor(options?: HttpCaptureOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /** Get all recorded captures. */
  getCaptures(): readonly HttpCaptureRecord[] {
    return this.captures;
  }

  /** Get the most recent capture, if any. */
  getLastCapture(): HttpCaptureRecord | undefined {
    return this.captures[this.captures.length - 1];
  }

  /** Clear all recorded captures. */
  clear(): void {
    this.captures = [];
  }

  /**
   * Instrument a single HTTP request/response pair.
   *
   * Returns the capture record for immediate use (e.g. for finding packet
   * creation) and appends it to the internal log.
   */
  async capture(
    url: string,
    init: RequestInit,
    response: Response,
    durationMs: number,
  ): Promise<HttpCaptureRecord> {
    const method = (init.method ?? 'GET').toUpperCase();
    const reqHeaders = this.sanitizeHeaders(
      Object.fromEntries(new Headers(init.headers).entries()),
    );

    // Capture request body (only if enabled, and only for methods that carry bodies)
    let reqBody: string | undefined;
    if (
      this.options.captureRequestBody &&
      ['POST', 'PUT', 'PATCH'].includes(method) &&
      init.body
    ) {
      const raw = typeof init.body === 'string'
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : String(init.body);
      reqBody = raw.slice(0, this.options.maxRequestBodyBytes);
    }

    // Capture response body (bounded)
    let respBody: string | undefined;
    let truncated = false;
    let responseBodyHash: string | undefined;

    try {
      const raw = await response.clone().text();
      responseBodyHash = createHash('sha256').update(raw).digest('hex');
      if (raw.length > (this.options.maxBodyBytes ?? 65536)) {
        respBody = raw.slice(0, this.options.maxBodyBytes);
        truncated = true;
      } else {
        respBody = raw;
      }
    } catch {
      // Non-textual or unreadable response
      respBody = undefined;
    }

    const record: HttpCaptureRecord = {
      request: {
        method,
        url,
        headers: reqHeaders,
        body: reqBody,
        timestamp: new Date().toISOString(),
      },
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: this.sanitizeHeaders(
          Object.fromEntries(response.headers.entries()),
        ),
        body: respBody,
        truncated,
        timestamp: new Date().toISOString(),
      },
      durationMs,
      responseBodyHash,
    };

    this.captures.push(record);
    return record;
  }

  /**
   * Build a replay-safe capture from the most recent capture.
   * Returns undefined if no captures exist.
   */
  toReplaySafe(): ReplaySafeCapture | undefined {
    const last = this.getLastCapture();
    if (!last) return undefined;

    return {
      method: last.request.method,
      url: last.request.url,
      headers: last.request.headers,
      body: last.request.body,
      status: last.response.status,
      assertion: this.buildAssertion(last),
    };
  }

  /**
   * Build a replay-safe capture from any capture record.
   */
  toReplaySafeFrom(record: HttpCaptureRecord): ReplaySafeCapture {
    return {
      method: record.request.method,
      url: record.request.url,
      headers: record.request.headers,
      body: record.request.body,
      status: record.response.status,
      assertion: this.buildAssertion(record),
    };
  }

  /**
   * Capture and return a replay-safe snapshot from a raw Request + Response.
   * Convenience wrapper for one-shot use.
   */
  static async captureOnce(
    url: string,
    init: RequestInit,
    response: Response,
    durationMs: number,
    options?: HttpCaptureOptions,
  ): Promise<ReplaySafeCapture> {
    const inst = new HttpInstrumentation(options);
    const record = await inst.capture(url, init, response, durationMs);
    return inst.toReplaySafeFrom(record);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private sanitizeHeaders(
    headers: Record<string, string>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    const pattern = this.options.sensitiveHeaderPattern!;
    let count = 0;

    for (const [key, value] of Object.entries(headers)) {
      if (count >= (this.options.maxHeaders ?? 50)) break;
      if (pattern.test(key)) {
        result[key] = '<redacted>';
      } else {
        result[key] = value;
      }
      count++;
    }

    return result;
  }

  private buildAssertion(record: HttpCaptureRecord): string {
    // Build a sensible assertion from the response body.
    // The assertion is compared against the raw body in confirmation,
    // so it must be a substring that appears in the original response.
    if (record.response.body) {
      // Extract a substring that appears verbatim in the raw body.
      // Strip tags but also keep a version that works with raw HTML.
      const raw = record.response.body;

      // Try to find text content between HTML tags that is distinctive.
      const tagContent = raw.match(/>([^<]+)</g);
      if (tagContent) {
        const meaningful = tagContent
          .map((t) => t.replace(/^>|<$/g, '').trim())
          .filter((t) => t.length > 8);
        if (meaningful.length > 0) {
          // Use the first meaningful inner-text segment
          return meaningful[0].slice(0, 120);
        }
      }

      // Fallback: first 80 non-whitespace chars that are printable
      const cleaned = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return cleaned.slice(0, 80);
    }

    // No body — use status text as assertion
    return `${record.response.status} ${record.response.statusText}`;
  }
}
