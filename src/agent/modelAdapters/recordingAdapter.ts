/**
 * Recording model adapter wrapper.
 *
 * Wraps any ModelAdapter and records every request/response pair for later
 * replay. Credentials and auth values are never stored in the recording.
 * Request hashes (SHA-256 of normalised user/assistant message content) are
 * stored instead of full raw requests.
 *
 * Recordings can be serialised and fed to ReplayAdapter.
 */

import type { ModelAdapter, ModelRequest, ModelResponse } from '../modelAdapter.js';
import type { ReplayEntry } from '../replayAdapter.js';
import crypto from 'node:crypto';
import { redactDeep } from '../../trace/redaction.js';

// ---------------------------------------------------------------------------
// Recording entry (redacted, safe to persist)
// ---------------------------------------------------------------------------

export type RecordingEntry = {
  requestHash: string;
  /** Redacted message content — credentials and secrets removed. */
  messages: Array<{ role: string; content: string }>;
  response: ModelResponse;
  /** ISO timestamp of when the request was made. */
  recordedAt: string;
};

// ---------------------------------------------------------------------------
// Recording adapter
// ---------------------------------------------------------------------------

/**
 * Wraps a real or fake adapter and records every interaction.
 * The recording is redacted and safe to persist.
 */
export class RecordingAdapter implements ModelAdapter {
  private inner: ModelAdapter;
  private recordings: RecordingEntry[] = [];

  constructor(inner: ModelAdapter) {
    this.inner = inner;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const response = await this.inner.generate(request, signal);

    // Record after successful generation
    this.record(request, response);

    return response;
  }

  estimateCost(usage: { inputTokens: number; outputTokens: number }): number {
    if (typeof (this.inner as any).estimateCost === 'function') {
      return (this.inner as any).estimateCost(usage);
    }
    return 0;
  }

  // -----------------------------------------------------------------------
  // Recording API
  // -----------------------------------------------------------------------

  /** Record a request/response pair. */
  record(request: ModelRequest, response: ModelResponse): void {
    const messages = request.messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-3)
      .map(m => ({ role: m.role, content: m.content }));

    // Compute request hash from normalised message content
    const messageContent = messages
      .map(m => `${m.role}: ${m.content}`)
      .join(' || ');
    const requestHash = crypto.createHash('sha256')
      .update(messageContent)
      .digest('hex')
      .slice(0, 16);

    // Redact messages before storing
    const redactedMessages = messages.map(m => ({
      role: m.role,
      content: this.redactText(m.content),
    }));

    this.recordings.push({
      requestHash,
      messages: redactedMessages,
      response: {
        ...response,
        content: this.redactText(response.content),
      },
      recordedAt: new Date().toISOString(),
    });
  }

  /** Export recordings as ReplayEntry array. */
  getReplayEntries(): ReplayEntry[] {
    return this.recordings.map(r => ({
      requestHash: r.requestHash,
      messages: r.messages,
      response: r.response,
    }));
  }

  /** Export raw recordings (with metadata). */
  getRecordings(): RecordingEntry[] {
    return [...this.recordings];
  }

  /** Serialise recordings to JSON. */
  serializeRecordings(): string {
    return JSON.stringify(this.recordings, null, 2);
  }

  /** Clear all recordings. */
  clear(): void {
    this.recordings = [];
  }

  /** Number of recorded interactions. */
  get recordingCount(): number {
    return this.recordings.length;
  }

  // -----------------------------------------------------------------------
  // Redaction helper
  // -----------------------------------------------------------------------

  private redactText(text: string): string {
    const { result } = redactDeep(text);
    return result as string;
  }

  /** Get the inner adapter (for direct access in tests). */
  getInnerAdapter(): ModelAdapter {
    return this.inner;
  }
}
