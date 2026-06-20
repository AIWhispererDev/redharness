/**
 * Replay model adapter: replays captured model responses for deterministic debugging.
 *
 * Uses a pre-recorded list of (request_hash → response) pairs.
 * If a request doesn't match any recorded response, it either
 * fails or delegates to a fallback adapter.
 */

import type { ModelAdapter, ModelRequest, ModelResponse } from './modelAdapter.js';
import { createHash } from 'node:crypto';

export type ReplayEntry = {
  requestHash?: string;
  messages: Array<{ role: string; content: string }>;
  response: ModelResponse;
};

export type ReplayAdapterOptions = {
  entries: ReplayEntry[];
  fallbackAdapter?: ModelAdapter;
  strict?: boolean;
};

/**
 * Replay adapter that returns pre-recorded responses.
 * Useful for deterministic debugging and replaying specific scenarios.
 */
export class ReplayAdapter implements ModelAdapter {
  private entries: ReplayEntry[];
  private fallback?: ModelAdapter;
  private strict: boolean;
  private replayCount = 0;

  constructor(options: ReplayAdapterOptions) {
    this.entries = options.entries;
    this.fallback = options.fallbackAdapter;
    this.strict = options.strict ?? false;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Try by exact message content match (in order)
    const messageContent = request.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-3) // last 3 messages for context
      .map((m) => `${m.role}: ${m.content}`)
      .join(' || ');

    const requestHash = createHash('sha256').update(messageContent).digest('hex').slice(0, 16);

    // Find matching entry
    const entry = this.entries.find(
      (e) => e.requestHash === requestHash,
    );

    if (entry) {
      this.replayCount++;
      return {
        ...entry.response,
        model: entry.response.model ?? 'replay-adapter',
        provider: 'replay',
      };
    }

    // Try fallback
    if (this.fallback) {
      return this.fallback.generate(request, signal);
    }

    if (this.strict) {
      throw new Error(`Replay adapter: no matching entry for request hash ${requestHash}`);
    }

    // Default: return empty response
    return {
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: 'replay-adapter',
      provider: 'replay',
    };
  }

  /** Get the number of replayed responses. */
  getReplayCount(): number {
    return this.replayCount;
  }

  /** Add more entries at runtime. */
  addEntries(entries: ReplayEntry[]): void {
    this.entries.push(...entries);
  }
}
