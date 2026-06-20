/**
 * Adapter factory — creates model adapters by provider name.
 *
 * Supports:
 * - 'fake' — deterministic FakeModelAdapter for testing
 * - 'replay' — ReplayAdapter (requires --replay <file>)
 * - 'openai', 'anthropic', 'google' — live adapters from env credentials
 *
 * Fail closed for unknown providers.
 */

import type { ModelAdapter } from '../modelAdapter.js';
import { FakeModelAdapter } from '../modelAdapter.js';
import type { FakeAdapterConfig } from '../modelAdapter.js';
import { ReplayAdapter, type ReplayEntry } from '../replayAdapter.js';
import { LiveModelAdapter, loadProviderConfig } from './externalProvider.js';
import { RecordingAdapter } from './recordingAdapter.js';
import type { HttpClient } from './externalProvider.js';

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export type AdapterFactoryOptions = {
  /** Provider name: 'fake', 'replay', 'openai', 'anthropic', 'google'. */
  provider: string;

  /** Fake adapter configuration (only for 'fake' provider). */
  fakeConfig?: FakeAdapterConfig;

  /** Replay entries or file path (only for 'replay' provider). */
  replayEntries?: ReplayEntry[];

  /** Whether to wrap the adapter in a RecordingAdapter. */
  record?: boolean;

  /** Optional HTTP client override (testing/mocking). */
  httpClient?: HttpClient;

  /** Model ID override (passed as request.model?.modelId). */
  modelId?: string;
};

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a model adapter for the given provider.
 *
 * @param options - Factory options
 * @returns A ModelAdapter instance
 * @throws ProviderError for unknown providers or missing credentials
 */
export function createAdapter(options: AdapterFactoryOptions): ModelAdapter {
  let adapter: ModelAdapter;

  switch (options.provider) {
    case 'fake': {
      adapter = new FakeModelAdapter(options.fakeConfig ?? {});
      break;
    }

    case 'replay': {
      if (!options.replayEntries || options.replayEntries.length === 0) {
        throw new Error(
          'Replay adapter requires replay entries. Provide them via --replay <file>.',
        );
      }
      adapter = new ReplayAdapter({
        entries: options.replayEntries,
        strict: false,
      });
      break;
    }

    case 'openai':
    case 'anthropic':
    case 'google': {
      const config = loadProviderConfig(options.provider);
      if (!config) {
        throw new Error(
          `Provider "${options.provider}" is not configured. ` +
          `Set the ${options.provider.toUpperCase()}_API_KEY environment variable.`,
        );
      }
      adapter = new LiveModelAdapter(
        config,
        options.httpClient,
      );
      break;
    }

    default:
      throw new Error(
        `Unknown provider: "${options.provider}". ` +
        'Supported providers: fake, replay, openai, anthropic, google.',
      );
  }

  // Wrap in recording adapter if requested
  if (options.record) {
    adapter = new RecordingAdapter(adapter);
  }

  return adapter;
}

/**
 * Create a live adapter with a configurable mock HTTP client.
 * Intended for testing only.
 */
export function createMockableAdapter(
  provider: string,
  httpClient: HttpClient,
  options?: { modelId?: string },
): ModelAdapter {
  const config = loadProviderConfig(provider);
  if (!config) {
    throw new Error(
      `Provider "${provider}" not configured. Set ${provider.toUpperCase()}_API_KEY.`,
    );
  }
  return new LiveModelAdapter(config, httpClient);
}
