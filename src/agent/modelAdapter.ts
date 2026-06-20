/**
 * PRD 04: Model Adapter — provider-neutral interface for LLM interaction.
 *
 * Initial implementation ships with a deterministic fake adapter for testing.
 * Real provider adapters (OpenAI, Anthropic, etc.) implement the same interface.
 */

import type { AgentMessage, ModelConfig } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Request / Response types
// ---------------------------------------------------------------------------

export type ModelRequest = {
  messages: AgentMessage[];
  systemPrompt?: string;
  tools?: ModelToolDef[];
  toolChoice?: 'auto' | 'none' | 'required';
  maxTokens?: number;
  temperature?: number;
  model?: ModelConfig;
};

export type ModelToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ModelResponse = {
  content: string;
  toolCalls: ModelToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error' | 'cancelled';
  usage?: ModelUsage;
  model?: string;
  provider?: string;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd?: number;
};

// ---------------------------------------------------------------------------
// Adapter interface
// ---------------------------------------------------------------------------

export interface ModelAdapter {
  /** Generate a response, respecting abort signal for cancellation. */
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse>;

  /** Estimate cost from usage data (optional, for budget tracking). */
  estimateCost?(usage: ModelUsage): number;
}

// ---------------------------------------------------------------------------
// Deterministic Fake Adapter (for testing)
// ---------------------------------------------------------------------------

export type FakeAdapterConfig = {
  /** Fixed content to return for assistant messages. */
  content?: string;
  /** Fixed tool calls to return. */
  toolCalls?: ModelToolCall[];
  /** Finish reason override. */
  finishReason?: ModelResponse['finishReason'];
  /** Usage override. */
  usage?: ModelUsage;
  /** If true, simulates an error on generate. */
  simulateError?: boolean;
  /** If set, simulates a timeout after this many ms. */
  simulateDelayMs?: number;
};

/**
 * Deterministic fake model adapter for testing the agent runtime.
 * Returns configured responses without calling any real LLM.
 */
export class FakeModelAdapter implements ModelAdapter {
  private config: FakeAdapterConfig;

  constructor(config: FakeAdapterConfig = {}) {
    this.config = {
      content: '',
      toolCalls: [],
      finishReason: 'stop',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      ...config,
    };
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    // Simulate delay if configured
    if (this.config.simulateDelayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.config.simulateDelayMs);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    }

    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    if (this.config.simulateError) {
      throw new Error('Fake adapter simulated error');
    }

    return {
      content: this.config.content ?? '',
      toolCalls: this.config.toolCalls ?? [],
      finishReason: this.config.finishReason ?? 'stop',
      usage: this.config.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      model: request.model?.modelId ?? 'fake-model',
      provider: request.model?.provider ?? 'fake-provider',
    };
  }

  /** Update the fake adapter's configuration mid-test. */
  configure(config: Partial<FakeAdapterConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
