/**
 * Provider-error taxonomy for model adapters.
 *
 * Every provider error is classified into one of these categories so
 * the runtime can apply appropriate retry, escalation, or cancellation
 * behaviour without knowing provider-internal error details.
 */

// ---------------------------------------------------------------------------
// Error categories
// ---------------------------------------------------------------------------

export type ProviderErrorCategory =
  | 'authentication'    // Invalid/expired/missing credentials
  | 'rate_limit'        // Rate-limit hit; generally transient and retryable
  | 'timeout'           // Request took too long; may be retryable
  | 'unavailable'       // Service unavailable / overloaded; generally transient
  | 'invalid_request'   // Malformed request, unsupported parameter, etc.
  | 'cancelled'         // Operation was cancelled by the caller
  | 'unknown';          // Catch-all for unclassified errors

// ---------------------------------------------------------------------------
// Retry decision
// ---------------------------------------------------------------------------

export type RetryPolicy = {
  /** Maximum number of retry attempts (0 = no retry). */
  maxRetries: number;
  /** Base delay in ms before first retry. */
  baseDelayMs: number;
  /** Max delay cap in ms. */
  maxDelayMs: number;
  /** Which categories are considered retryable. */
  retryableCategories: ProviderErrorCategory[] | readonly ProviderErrorCategory[];
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  retryableCategories: ['rate_limit', 'timeout', 'unavailable'],
};

// ---------------------------------------------------------------------------
// Provider error class
// ---------------------------------------------------------------------------

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly statusCode?: number;
  readonly retryable: boolean;
  readonly providerName?: string;

  constructor(opts: {
    message: string;
    category: ProviderErrorCategory;
    statusCode?: number;
    retryable?: boolean;
    providerName?: string;
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'ProviderError';
    this.category = opts.category;
    this.statusCode = opts.statusCode;
    this.retryable = opts.retryable ?? false;
    this.providerName = opts.providerName;

    if (opts.cause instanceof Error) {
      this.cause = opts.cause;
    }
  }

  /** Classify an unknown Error into a ProviderError with a category hint. */
  static classify(
    providerName: string,
    error: unknown,
    statusCode?: number,
  ): ProviderError {
    // Already a ProviderError
    if (error instanceof ProviderError) return error;

    // AbortError / DOMException from AbortSignal
    if (
      error instanceof DOMException ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return new ProviderError({
        message: 'Request was cancelled',
        category: 'cancelled',
        statusCode,
        providerName,
        cause: error,
      });
    }

    const msg = error instanceof Error ? error.message : typeof error === 'object' && error !== null ? JSON.stringify(error) : String(error);
    const lower = msg.toLowerCase();
    const code = statusCode;

    // HTTP-level classification
    if (code === 401 || code === 403 || lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('invalid api key')) {
      return new ProviderError({
        message: msg,
        category: 'authentication',
        statusCode: code,
        providerName,
        cause: error instanceof Error ? error : undefined,
      });
    }

    if (code === 429 || lower.includes('rate limit') || lower.includes('too many requests')) {
      return new ProviderError({
        message: msg,
        category: 'rate_limit',
        statusCode: code,
        retryable: true,
        providerName,
        cause: error instanceof Error ? error : undefined,
      });
    }

    if (code === 503 || code === 502 || lower.includes('service unavailable') || lower.includes('overloaded') || lower.includes('temporarily unavailable')) {
      return new ProviderError({
        message: msg,
        category: 'unavailable',
        statusCode: code,
        retryable: true,
        providerName,
        cause: error instanceof Error ? error : undefined,
      });
    }

    if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('deadline exceeded')) {
      return new ProviderError({
        message: msg,
        category: 'timeout',
        retryable: true,
        providerName,
        cause: error instanceof Error ? error : undefined,
      });
    }

    if (code && code >= 400 && code < 500) {
      return new ProviderError({
        message: msg,
        category: 'invalid_request',
        statusCode: code,
        providerName,
        cause: error instanceof Error ? error : undefined,
      });
    }

    // Catch-all
    return new ProviderError({
      message: msg,
      category: 'unknown',
      statusCode: code,
      providerName,
      cause: error instanceof Error ? error : undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

/**
 * Exponential back-off with jitter.
 * Returns the delay in ms for attempt `attempt` (0-indexed).
 */
export function backoffDelay(attempt: number, policy: RetryPolicy): number {
  const exponential = Math.min(
    policy.baseDelayMs * Math.pow(2, attempt),
    policy.maxDelayMs,
  );
  // Add ±25% jitter
  const jitter = exponential * (0.75 + Math.random() * 0.5);
  return Math.round(jitter);
}

/**
 * Determine whether an error should be retried under the given policy.
 */
export function isRetryable(error: ProviderError, policy: RetryPolicy): boolean {
  return error.retryable && (policy.retryableCategories as readonly ProviderErrorCategory[]).includes(error.category);
}
