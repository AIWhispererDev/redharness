import { describe, expect, it } from 'vitest';
import { evaluateAssertion } from '../src/scenarios/actions.js';

describe('generic browser diagnostic assertions', () => {
  const unusedPage = {} as never;
  const captures = new Map<string, string>();

  it('fails on relevant browser errors and supports explicit ignores', async () => {
    await expect(evaluateAssertion(
      unusedPage,
      { assertion: 'no_console_errors' },
      captures,
      {
        consoleErrors: ['wallet provider unavailable'],
        failedRequests: [],
        serverErrors: [],
      },
    )).resolves.toMatchObject({ passed: false });

    await expect(evaluateAssertion(
      unusedPage,
      { assertion: 'no_console_errors', ignorePatterns: ['wallet provider'] },
      captures,
      {
        consoleErrors: ['wallet provider unavailable'],
        failedRequests: [],
        serverErrors: [],
      },
    )).resolves.toEqual({
      passed: true,
      message: 'No console errors observed',
    });
  });
});
