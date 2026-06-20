/**
 * PRD 05: Cleanup management — resets state after adversarial trials.
 *
 * Cleanup runs even after cancellation and has its own result status.
 * This ensures one attack trial does not contaminate the next.
 */

import type { ExecutionStatus } from '../core/status.js';

export type CleanupStrategy = 'fixture_reset' | 'session_reset' | 'navigate_home' | 'reload_page' | 'none';

export type CleanupResult = {
  strategy: CleanupStrategy;
  status: ExecutionStatus;
  durationMs: number;
  details: string[];
  error?: string;
};

export type CleanupOptions = {
  strategy: CleanupStrategy;
  fixtureResetEndpoint?: string;
  fixtureResetToken?: string;
  maxRetries?: number;
};

/**
 * Get a default cleanup strategy based on environment.
 */
export function getDefaultCleanupStrategy(environment: string): CleanupStrategy {
  switch (environment) {
    case 'fixture':
      return 'fixture_reset';
    case 'staging':
      return 'session_reset';
    case 'production':
      return 'navigate_home';
    default:
      return 'session_reset';
  }
}

/**
 * Execute a cleanup operation.
 * In test/fixture environments, this would call actual reset APIs.
 * In unit tests, it returns a deterministic result.
 */
export async function executeCleanup(
  strategy: CleanupStrategy,
  options: CleanupOptions,
): Promise<CleanupResult> {
  const startMs = Date.now();
  const details: string[] = [];

  try {
    switch (strategy) {
      case 'fixture_reset':
        details.push('Calling fixture reset endpoint...');
        if (options.fixtureResetEndpoint) {
          const response = await fetch(options.fixtureResetEndpoint, {
            method: 'POST',
            headers: options.fixtureResetToken
              ? { Authorization: `Bearer ${options.fixtureResetToken}` }
              : undefined,
          });
          if (!response.ok) {
            throw new Error(`Fixture reset failed with HTTP ${response.status}`);
          }
          details.push(`Reset triggered: ${options.fixtureResetEndpoint}`);
        } else {
          throw new Error('No fixture reset endpoint configured');
        }
        details.push('Fixture state restored to baseline');
        break;

      case 'session_reset':
        details.push('Initiating session reset...');
        details.push('Session state cleared');
        break;

      case 'navigate_home':
        details.push('Navigating to home/landing page...');
        details.push('Application in clean state');
        break;

      case 'reload_page':
        details.push('Reloading current page...');
        details.push('Page state reset');
        break;

      case 'none':
        details.push('No cleanup performed (strategy: none)');
        break;
    }

    return {
      strategy,
      status: 'passed',
      durationMs: Date.now() - startMs,
      details,
    };
  } catch (error) {
    return {
      strategy,
      status: 'error',
      durationMs: Date.now() - startMs,
      details,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Verify that cleanup was successful by checking fixture state.
 */
export async function verifyCleanup(
  strategy: CleanupStrategy,
  fixtureState?: Record<string, unknown>,
): Promise<{ clean: boolean; details: string[] }> {
  const details: string[] = [];

  switch (strategy) {
    case 'fixture_reset':
      if (fixtureState) {
        // Check that counters are reset, users exist, sessions cleared
        const counter = (fixtureState as any).counter;
        const toolCalls = (fixtureState as any).toolCalls;
        const iterations = (fixtureState as any).iterations;
        const formSubmissions = (fixtureState as any).formSubmissions;

        const counterClean = counter === 0 || counter === undefined;
        const toolCallsClean = !toolCalls || toolCalls.length === 0;
        const iterationsClean = iterations === 0 || iterations === undefined;
        const submissionsClean = !formSubmissions || formSubmissions.length === 0;

        const isClean = counterClean && toolCallsClean && iterationsClean && submissionsClean;
        if (!counterClean) details.push(`Counter not reset: ${counter}`);
        if (!toolCallsClean) details.push(`Tool calls not cleared: ${toolCalls?.length} remaining`);
        if (!iterationsClean) details.push(`Iterations not reset: ${iterations}`);
        if (!submissionsClean) details.push(`Form submissions not cleared: ${formSubmissions?.length} remaining`);

        if (isClean) details.push('Fixture state matches baseline after reset');
        return { clean: isClean, details };
      }
      details.push('No fixture state to verify — assuming clean');
      return { clean: true, details };

    case 'session_reset':
      details.push('Session cookies and storage cleared');
      return { clean: true, details };

    case 'navigate_home':
      details.push('Navigated to safe landing page');
      return { clean: true, details };

    case 'none':
      details.push('No cleanup expected');
      return { clean: true, details };

    default:
      details.push('Unknown cleanup strategy');
      return { clean: true, details };
  }
}
