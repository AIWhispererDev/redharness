/**
 * Live external-provider model adapter.
 *
 * Implements ModelAdapter for one supported provider (Anthropic) behind
 * a mockable HTTP transport. Uses environment credentials only; never
 * leaks credentials into messages, traces, or replay files.
 *
 * Design principles:
 * - Provider-specific code is isolated to this file.
 * - The HTTP client is injectable for testing.
 * - All provider errors are normalised to ProviderError.
 * - Credentials come from process.env only.
 * - Usage and cost estimation are normalised.
 * - Model/provider/config versions are captured per response.
 */

import type { ModelAdapter, ModelRequest, ModelResponse, ModelToolCall } from '../modelAdapter.js';
import { ProviderError, DEFAULT_RETRY_POLICY, backoffDelay, isRetryable } from './errors.js';
import type { RetryPolicy, ProviderErrorCategory } from './errors.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Provider configuration (loaded from env at call time, never stored)
// ---------------------------------------------------------------------------

export type ProviderConfig = {
  provider: 'openai' | 'anthropic' | 'google' | string;
  apiKey: string;
  baseUrl: string;
  retryPolicy: RetryPolicy;
};

/**
 * Load provider config from environment variables.
 * Returns null if the required credentials are not set.
 */
export function loadProviderConfig(provider: string): ProviderConfig | null {
  const envKey = `${provider.toUpperCase()}_API_KEY`;
  const envBaseUrl = `${provider.toUpperCase()}_BASE_URL`;

  const apiKey = process.env[envKey];
  if (!apiKey) return null;

  const defaults: Record<string, string> = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1',
  };

  return {
    provider,
    apiKey,
    baseUrl: process.env[envBaseUrl] ?? defaults[provider] ?? `https://api.${provider}.com/v1`,
    retryPolicy: DEFAULT_RETRY_POLICY,
  };
}

// ---------------------------------------------------------------------------
// HTTP client abstraction (injectable for testing)
// ---------------------------------------------------------------------------

export type HttpClientResponse = {
  status: number;
  headers: Record<string, string>;
  body: unknown; // parsed JSON
};

export interface HttpClient {
  post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal): Promise<HttpClientResponse>;
}

/** Default HTTP client using fetch. */
export const defaultHttpClient: HttpClient = {
  async post(url, headers, body, signal): Promise<HttpClientResponse> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      responseBody = await response.text();
    }

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  },
};

// ---------------------------------------------------------------------------
// Per-response metadata
// ---------------------------------------------------------------------------

export type ProviderResponseMeta = {
  model: string;
  provider: string;
  configVersion: string;
  requestId?: string;
};

// ---------------------------------------------------------------------------
// API request/response shapes per provider
// ---------------------------------------------------------------------------

type OpenAIRequest = {
  model: string;
  messages: Array<{
    role: string;
    content: string;
  }>;
  system?: string;
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    };
  }>;
  tool_choice?: 'auto' | 'none' | 'required';
  max_tokens?: number;
  temperature?: number;
};

type OpenAIResponse = {
  id: string;
  model: string;
  choices: Array<{
    finish_reason: string;
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

type AnthropicRequest = {
  model: string;
  system?: string;
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  tools?: Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }>;
  tool_choice?: { type: 'auto' | 'any' | 'tool' };
  max_tokens: number;
  temperature?: number;
};

type AnthropicContentBlock = {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
};

type AnthropicResponse = {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
};

type GoogleRequest = {
  contents: Array<{
    role: string;
    parts: Array<{ text: string }>;
  }>;
  systemInstruction?: { parts: Array<{ text: string }> };
  tools?: Array<{
    functionDeclarations: Array<{
      name: string;
      description: string;
      parameters: Record<string, unknown>;
    }>;
  }>;
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
};

type GoogleResponse = {
  candidates: Array<{
    finishReason: string;
    content: {
      role: string;
      parts: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args: Record<string, unknown>;
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
};

// ---------------------------------------------------------------------------
// Live model adapter
// ---------------------------------------------------------------------------

/**
 * Live adapter for an external model provider.
 * Credentials are read from environment at call time and never captured.
 */
export class LiveModelAdapter implements ModelAdapter {
  readonly providerName: string;
  private config: ProviderConfig;
  private httpClient: HttpClient;
  private configVersion: string;
  private retryPolicy: RetryPolicy;

  constructor(config: ProviderConfig, httpClient?: HttpClient) {
    this.providerName = config.provider;
    this.config = config;
    this.httpClient = httpClient ?? defaultHttpClient;
    this.configVersion = crypto.createHash('sha256')
      .update(JSON.stringify({ provider: config.provider, baseUrl: config.baseUrl, retryPolicy: config.retryPolicy }))
      .digest('hex')
      .slice(0, 12);
    this.retryPolicy = config.retryPolicy;
  }

  async generate(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    if (signal.aborted) {
      throw new ProviderError({
        message: 'Request was cancelled before generation',
        category: 'cancelled',
        providerName: this.providerName,
      });
    }

    const provider = this.config.provider;

    switch (provider) {
      case 'openai':
        return this.generateOpenAI(request, signal);
      case 'anthropic':
        return this.generateAnthropic(request, signal);
      case 'google':
        return this.generateGoogle(request, signal);
      default:
        throw new ProviderError({
          message: `Unsupported provider: ${provider}`,
          category: 'invalid_request',
          providerName: provider,
        });
    }
  }

  estimateCost(usage: { inputTokens: number; outputTokens: number }): number {
    // Approximate per-token costs (USD). Updated periodically.
    // These are rough estimates; exact pricing depends on model tier.
    const rates: Record<string, { input: number; output: number }> = {
      openai: { input: 0.000_003, output: 0.000_012 },    // gpt-4o-mini rates
      anthropic: { input: 0.000_003, output: 0.000_015 },  // claude-3-haiku rates
      google: { input: 0.000_002, output: 0.000_008 },     // gemini-2.0-flash rates
    };

    const rate = rates[this.providerName] ?? { input: 0.000_005, output: 0.000_020 };
    return (usage.inputTokens * rate.input) + (usage.outputTokens * rate.output);
  }

  // -----------------------------------------------------------------------
  // OpenAI
  // -----------------------------------------------------------------------

  private async generateOpenAI(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const modelId = request.model?.modelId ?? 'gpt-4o-mini';
    const openAiRequest: OpenAIRequest = {
      model: modelId,
      messages: request.messages.map(m => ({
        role: m.role,
        content: m.content,
      })),
      max_tokens: request.maxTokens,
      temperature: request.temperature,
    };

    if (request.systemPrompt) {
      // OpenAI supports system as a separate parameter or as a system message
      openAiRequest.system = request.systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      openAiRequest.tools = request.tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        },
      }));
      openAiRequest.tool_choice = request.toolChoice === 'required' ? 'required'
        : request.toolChoice === 'none' ? 'none'
        : 'auto';
    }

    const response = await this.attemptWithRetry<OpenAIResponse>(
      `${this.config.baseUrl}/chat/completions`,
      openAiRequest,
      this.buildHeaders(),
      signal,
    );

    const choice = response.choices?.[0];
    if (!choice) {
      throw new ProviderError({
        message: 'OpenAI response missing choices',
        category: 'unknown',
        providerName: this.providerName,
      });
    }

    const toolCalls: ModelToolCall[] = (choice.message?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: this.safeParseJson(tc.function.arguments, {}),
    }));

    return {
      content: choice.message?.content ?? '',
      toolCalls,
      finishReason: this.mapOpenAIFinishReason(choice.finish_reason),
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
        costUsd: this.estimateCost({
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        }),
      } : undefined,
      model: response.model ?? modelId,
      provider: this.providerName,
    };
  }

  // -----------------------------------------------------------------------
  // Anthropic
  // -----------------------------------------------------------------------

  private async generateAnthropic(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const modelId = request.model?.modelId ?? 'claude-3-haiku-20240307';
    const anthropicRequest: AnthropicRequest = {
      model: modelId,
      messages: this.anthropicMessages(request.messages),
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature,
    };

    if (request.systemPrompt) {
      anthropicRequest.system = request.systemPrompt;
    }

    if (request.tools && request.tools.length > 0) {
      anthropicRequest.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Record<string, unknown>,
      }));
      anthropicRequest.tool_choice = request.toolChoice === 'none'
        ? { type: 'auto' }
        : request.toolChoice === 'required'
          ? { type: 'any' }
          : { type: 'auto' };
    }

    const response = await this.attemptWithRetry<AnthropicResponse>(
      `${this.config.baseUrl}/messages`,
      anthropicRequest,
      this.buildHeaders(),
      signal,
    );

    let content = '';
    const toolCalls: ModelToolCall[] = [];

    for (const block of response.content ?? []) {
      if (block.type === 'text' && block.text) {
        content += block.text;
      } else if (block.type === 'tool_use' && block.name) {
        toolCalls.push({
          id: block.id ?? `toolu_${crypto.randomUUID().slice(0, 8)}`,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }

    return {
      content,
      toolCalls,
      finishReason: this.mapAnthropicFinishReason(response.stop_reason),
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
        costUsd: this.estimateCost({
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }),
      } : undefined,
      model: response.model ?? modelId,
      provider: this.providerName,
    };
  }

  // -----------------------------------------------------------------------
  // Google / Gemini
  // -----------------------------------------------------------------------

  private async generateGoogle(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const modelId = request.model?.modelId ?? 'gemini-2.0-flash';

    const googleRequest: GoogleRequest = {
      contents: this.googleContents(request.messages),
      generationConfig: {
        maxOutputTokens: request.maxTokens,
        temperature: request.temperature,
      },
    };

    if (request.systemPrompt) {
      googleRequest.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    if (request.tools && request.tools.length > 0) {
      googleRequest.tools = [{
        functionDeclarations: request.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema as Record<string, unknown>,
        })),
      }];
    }

    const url = `${this.config.baseUrl}/models/${modelId}:generateContent?key=${this.config.apiKey}`;

    // For Google, API key is in the URL; headers are minimal
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    const response = await this.attemptWithRetry<GoogleResponse>(
      url,
      googleRequest,
      headers,
      signal,
    );

    const candidate = response.candidates?.[0];
    if (!candidate) {
      return {
        content: '',
        toolCalls: [],
        finishReason: 'stop',
        model: modelId,
        provider: this.providerName,
      };
    }

    let content = '';
    const toolCalls: ModelToolCall[] = [];

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) {
        content += part.text;
      } else if (part.functionCall) {
        toolCalls.push({
          id: `fc_${crypto.randomUUID().slice(0, 8)}`,
          name: part.functionCall.name,
          arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
        });
      }
    }

    const usage = response.usageMetadata;
    return {
      content,
      toolCalls,
      finishReason: this.mapGoogleFinishReason(candidate.finishReason),
      usage: usage ? {
        inputTokens: usage.promptTokenCount,
        outputTokens: usage.candidatesTokenCount,
        totalTokens: usage.totalTokenCount,
        costUsd: this.estimateCost({
          inputTokens: usage.promptTokenCount,
          outputTokens: usage.candidatesTokenCount,
        }),
      } : undefined,
      model: modelId,
      provider: this.providerName,
    };
  }

  // -----------------------------------------------------------------------
  // Retry logic
  // -----------------------------------------------------------------------

  private async attemptWithRetry<T>(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<T> {
    let lastError: ProviderError | null = null;

    for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
      if (signal.aborted) {
        throw new ProviderError({
          message: 'Request was cancelled',
          category: 'cancelled',
          providerName: this.providerName,
        });
      }

      try {
        const response = await this.httpClient.post(url, headers, body, signal);

        if (response.status >= 200 && response.status < 300) {
          return response.body as T;
        }

        // Classify HTTP-level errors
        const providerError = ProviderError.classify(this.providerName, response.body, response.status);

        // Handle rate-limit headers for retry-after
        if (providerError.category === 'rate_limit' && response.headers['retry-after']) {
          const retryAfter = parseInt(response.headers['retry-after'], 10) * 1000;
          if (retryAfter > 0 && retryAfter < 60_000) {
            await delay(retryAfter, signal);
            lastError = providerError;
            continue;
          }
        }

        if (!isRetryable(providerError, this.retryPolicy)) {
          throw providerError;
        }

        // Exponential back-off
        const waitMs = backoffDelay(attempt, this.retryPolicy);
        await delay(waitMs, signal);
        lastError = providerError;
      } catch (error) {
        if (error instanceof ProviderError) throw error;

        const providerError = ProviderError.classify(this.providerName, error);

        // Cancellation is always terminal
        if (providerError.category === 'cancelled') throw providerError;

        if (!isRetryable(providerError, this.retryPolicy)) {
          throw providerError;
        }

        const waitMs = backoffDelay(attempt, this.retryPolicy);
        await delay(waitMs, signal);
        lastError = providerError;
      }
    }

    throw lastError ?? new ProviderError({
      message: 'Max retries exceeded',
      category: 'unavailable',
      providerName: this.providerName,
    });
  }

  // -----------------------------------------------------------------------
  // Header builders
  // -----------------------------------------------------------------------

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    switch (this.config.provider) {
      case 'openai':
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        break;
      case 'anthropic':
        headers['x-api-key'] = this.config.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        break;
      // Google puts the key in the URL query string
    }

    return headers;
  }

  // -----------------------------------------------------------------------
  // Message transformers
  // -----------------------------------------------------------------------

  private anthropicMessages(messages: ModelRequest['messages']): AnthropicRequest['messages'] {
    return messages.map(m => ({
      role: m.role === 'tool' ? 'user' : (m.role === 'assistant' ? 'assistant' : 'user'),
      content: m.content || (m.toolResult ? JSON.stringify(m.toolResult) : ''),
    }));
  }

  private googleContents(messages: ModelRequest['messages']): GoogleRequest['contents'] {
    return messages.map(m => ({
      role: m.role === 'tool' ? 'user' : m.role,
      parts: [{ text: m.content || (m.toolResult ? JSON.stringify(m.toolResult) : '') }],
    }));
  }

  // -----------------------------------------------------------------------
  // Finish reason normalisation
  // -----------------------------------------------------------------------

  private mapOpenAIFinishReason(reason: string): ModelResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      default: return reason?.toLowerCase().includes('error') ? 'error' : 'stop';
    }
  }

  private mapAnthropicFinishReason(reason: string): ModelResponse['finishReason'] {
    switch (reason) {
      case 'end_turn': return 'stop';
      case 'tool_use': return 'tool_calls';
      case 'max_tokens': return 'length';
      default: return 'stop';
    }
  }

  private mapGoogleFinishReason(reason: string): ModelResponse['finishReason'] {
    switch (reason) {
      case 'STOP': return 'stop';
      case 'FUNCTION_CALL': return 'tool_calls';
      case 'MAX_TOKENS': return 'length';
      default: return 'stop';
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  private safeParseJson(text: string, fallback: Record<string, unknown>): Record<string, unknown> {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------
// Delay helper (supports abort)
// ---------------------------------------------------------------------------

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
