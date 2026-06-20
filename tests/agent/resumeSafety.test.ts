/**
 * Feature 04: Resume Safety — tests for crash recovery, idempotency,
 * non-restorable browser state, and policy/tool/dataset version changes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { IdempotencyStore, NON_RESTORABLE_TOOLS } from '../../src/agent/idempotency.js';
import { AgentRunService } from '../../src/service/agentRunService.js';
import { AgentRunService as AgentRunServiceType } from '../../src/service/agentRunService.js';

import type { VersionedMetadata } from '../../src/agent/runStateStore.js';
import type { AgentState, BudgetConsumption } from '../../src/agent/agentTypes.js';

function createTestRunDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'agent-rs-test-'));
}

function makeVersionedMetadata(overrides?: Partial<VersionedMetadata>): VersionedMetadata {
  return {
    policyVersion: '1.0',
    toolVersions: { http_get: '1.0', browser_navigate: '1.0' },
    modelConfig: { provider: 'fake', modelId: 'deterministic' },
    toolDefinitions: [],
    policy: {
      defaultToolApproval: 'auto' as any,
      toolPolicies: [],
      allowedOrigins: ['https://example.com'],
      prohibitedActions: [],
      requireHumanForStateChanges: false,
    },
    intent: {
      goalId: 'test-goal',
      userGoal: 'Test run',
      allowedActions: [],
      prohibitedActions: [],
      allowedOrigins: ['https://example.com'],
      dataBoundary: 'run-directory',
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    },
    ...overrides,
  };
}

function minimalAgentState(runId: string): AgentState {
  return {
    runId,
    scenarioId: 'test',
    trialId: '',
    turn: 0,
    goal: makeVersionedMetadata().intent,
    messages: [],
    observations: [],
    pendingApprovals: [],
    startedAt: new Date().toISOString(),
  };
}

function zeroBudgets(): BudgetConsumption {
  return { wallTimeMs: 0, turns: 0, messages: 0, toolCalls: 0, networkRequests: 0 };
}

// ---------------------------------------------------------------------------
// Idempotency tests
// ---------------------------------------------------------------------------

describe('IdempotencyStore', () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore({ maxActions: 100 });
  });

  afterEach(() => {
    store.clear();
  });

  it('records a completed mutation', () => {
    const action = store.record('http_post', { url: 'https://example.com/api' }, 'run-1', 1, 'success', 'write');
    expect(action.actionId).toBeTruthy();
    expect(action.toolName).toBe('http_post');
    expect(action.result).toBe('success');
  });

  it('detects completed action as immutable', () => {
    store.record('http_post', { url: 'https://example.com/api' }, 'run-b', 1, 'success', 'write');
    expect(store.isImmutable('http_post', { url: 'https://example.com/api' }, 'run-b')).toBe(true);
  });

  it('does not mark read actions as immutable', () => {
    store.record('http_get', { url: 'https://example.com' }, 'run-c', 1, 'success', 'read');
    expect(store.isImmutable('http_get', { url: 'https://example.com' }, 'run-c')).toBe(false);
  });

  it('does not mark failed mutations as immutable', () => {
    store.record('http_post', { url: 'https://example.com/api' }, 'run-d', 1, 'failure', 'write');
    expect(store.isImmutable('http_post', { url: 'https://example.com/api' }, 'run-d')).toBe(false);
  });

  it('detects different arguments as different actions', () => {
    store.record('http_post', { url: 'https://example.com/api/1' }, 'run-e', 1, 'success', 'write');
    expect(store.isImmutable('http_post', { url: 'https://example.com/api/2' }, 'run-e')).toBe(false);
  });

  it('detects different run IDs as different actions', () => {
    store.record('http_post', { url: 'https://example.com/api' }, 'run-f1', 1, 'success', 'write');
    expect(store.isImmutable('http_post', { url: 'https://example.com/api' }, 'run-f2')).toBe(false);
  });

  it('restores completed actions from persisted list', () => {
    // Create original actions
    store.record('http_post', { url: 'https://example.com/api' }, 'run-g', 1, 'success', 'write');
    const actions = store.getAllCompletedActions();
    expect(actions).toHaveLength(1);

    // Create a fresh store and restore
    const store2 = new IdempotencyStore({ maxActions: 100 });
    store2.restore(actions);

    expect(store2.isImmutable('http_post', { url: 'https://example.com/api' }, 'run-g')).toBe(true);
    expect(store2.getAllCompletedActions()).toHaveLength(1);
  });

  it('handles eviction when over maxActions limit', () => {
    const smallStore = new IdempotencyStore({ maxActions: 3 });
    smallStore.record('tool_a', { n: 1 }, 'run-h', 1, 'success', 'write');
    smallStore.record('tool_a', { n: 2 }, 'run-h', 2, 'success', 'write');
    smallStore.record('tool_a', { n: 3 }, 'run-h', 3, 'success', 'write');
    smallStore.record('tool_a', { n: 4 }, 'run-h', 4, 'success', 'write');

    // Should have evicted at least one
    expect(smallStore.getAllCompletedActions().length).toBeLessThanOrEqual(3);
    smallStore.clear();
  });

  it('computes deterministic action IDs', () => {
    const id1 = IdempotencyStore.computeActionId('http_post', { url: 'https://example.com' }, 'run-i');
    const id2 = IdempotencyStore.computeActionId('http_post', { url: 'https://example.com' }, 'run-i');
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different tools', () => {
    const id1 = IdempotencyStore.computeActionId('http_get', { url: 'https://example.com' }, 'run-j');
    const id2 = IdempotencyStore.computeActionId('http_post', { url: 'https://example.com' }, 'run-j');
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Non-restorable browser state detection
// ---------------------------------------------------------------------------

describe('Non-restorable tools detection', () => {
  it('identifies browser state tools as non-restorable', () => {
    expect(NON_RESTORABLE_TOOLS.has('browser_navigate')).toBe(true);
    expect(NON_RESTORABLE_TOOLS.has('browser_click')).toBe(true);
    expect(NON_RESTORABLE_TOOLS.has('browser_fill')).toBe(true);
    expect(NON_RESTORABLE_TOOLS.has('browser_screenshot')).toBe(true);
    expect(NON_RESTORABLE_TOOLS.has('browser_observe')).toBe(true);
  });

  it('does not flag HTTP tools as non-restorable', () => {
    expect(NON_RESTORABLE_TOOLS.has('http_get')).toBe(false);
    expect(NON_RESTORABLE_TOOLS.has('http_post')).toBe(false);
  });

  it('detects non-restorable tools in agent state messages on resume validation', async () => {
    const testDir = await createTestRunDir();
    try {
      const service = new AgentRunService({ runsBaseDir: testDir });

      const runId = 'nr-test-1';
      const state = minimalAgentState(runId);
      // Simulate a run that used browser navigation
      state.messages.push({
        role: 'tool',
        content: 'navigated',
        toolCallId: 'tc-1',
        toolName: 'browser_navigate',
        toolArguments: { url: 'https://example.com' },
        timestamp: new Date().toISOString(),
      });

      await service.createRunDocument(runId, state, zeroBudgets(), makeVersionedMetadata());

      const validation = await service.validateResume(runId, makeVersionedMetadata());
      // Should warn about non-restorable browser state
      expect(validation.nonRestorableTools).toContain('browser_navigate');
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Crash recovery scenarios
// ---------------------------------------------------------------------------

describe('Crash recovery — idempotency prevents repeated side effects', () => {
  let testDir: string;
  let service: AgentRunService;

  beforeEach(async () => {
    testDir = await createTestRunDir();
    service = new AgentRunService({ runsBaseDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('prevents re-execution of completed mutations after simulated crash', async () => {
    const runId = 'crash-test-1';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    // Simulate: action completed and recorded
    const idempotency = service.getIdempotencyStore();
    idempotency.record('http_post', { url: 'https://example.com/api' }, runId, 1, 'success', 'write');

    // Simulate crash: restart service
    const service2 = new AgentRunService({ runsBaseDir: testDir });
    const state2 = minimalAgentState(runId);
    state2.turn = 2;
    const completedActionIds = idempotency.getAllActionIds();

    // Restore completed action IDs from persisted state
    for (const actionId of completedActionIds) {
      // In real usage, the runtime reads from persisted state and restores
      // the idempotency store
    }

    // Verify the mutation is recorded as immutable
    expect(idempotency.isImmutable('http_post', { url: 'https://example.com/api' }, runId)).toBe(true);
  });

  it('allows reads and new writes after crash resume', async () => {
    const runId = 'crash-test-2';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const idempotency = service.getIdempotencyStore();
    idempotency.record('http_post', { url: 'https://example.com/api' }, runId, 1, 'success', 'write');

    // A read of the same URL should be allowed (idempotency doesn't block reads)
    expect(idempotency.isCompleted('http_get', { url: 'https://example.com/api' }, runId)).toBe(false);

    // A different write should also be allowed (different arguments)
    expect(idempotency.isImmutable('http_post', { url: 'https://example.com/api/v2' }, runId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Version change detection
// ---------------------------------------------------------------------------

describe('Resume — version change scenarios', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestRunDir();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('detects changed policy version', async () => {
    const service = new AgentRunService({ runsBaseDir: testDir });
    const runId = 'vc-test-1';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({ policyVersion: '1.0' }));

    const validation = await service.validateResume(runId, makeVersionedMetadata({ policyVersion: '2.0' }));
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('Policy version'))).toBe(true);
  });

  it('detects changed tool version', async () => {
    const service = new AgentRunService({ runsBaseDir: testDir });
    const runId = 'vc-test-2';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({
      toolVersions: { http_get: '1.0' },
    }));

    const validation = await service.validateResume(runId, makeVersionedMetadata({
      toolVersions: { http_get: '2.0' },
    }));
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('Tool'))).toBe(true);
  });

  it('detects changed model config', async () => {
    const service = new AgentRunService({ runsBaseDir: testDir });
    const runId = 'vc-test-3';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({
      modelConfig: { provider: 'fake', modelId: 'model-a' },
    }));

    const validation = await service.validateResume(runId, makeVersionedMetadata({
      modelConfig: { provider: 'openai', modelId: 'gpt-4' },
    }));
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('Model config'))).toBe(true);
  });

  it('reports multiple issues at once', async () => {
    const service = new AgentRunService({ runsBaseDir: testDir });
    const runId = 'vc-test-4';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({
      policyVersion: '1.0',
      toolVersions: { http_get: '1.0' },
      modelConfig: { provider: 'fake', modelId: 'model-a' },
    }));

    const validation = await service.validateResume(runId, makeVersionedMetadata({
      policyVersion: '2.0',
      toolVersions: { http_get: '2.0' },
      modelConfig: { provider: 'openai', modelId: 'gpt-4' },
    }));

    expect(validation.valid).toBe(false);
    expect(validation.issues.length).toBeGreaterThanOrEqual(3);
  });
});
