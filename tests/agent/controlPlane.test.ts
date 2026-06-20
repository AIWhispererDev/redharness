/**
 * Feature 04: Agent Control Plane — tests for approve, deny, expire,
 * forge, mismatch, and reuse validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { AgentRunService } from '../../src/service/agentRunService.js';
import type { AgentRunDocument, ApprovalBinding, VersionedMetadata } from '../../src/agent/runStateStore.js';
import type { AgentState, BudgetConsumption, IntentCapsule, ModelConfig, AgentPolicy } from '../../src/agent/agentTypes.js';

function createTestRunDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'agent-cp-test-'));
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

describe('AgentRunService — approve/deny validation', () => {
  let testDir: string;
  let service: AgentRunService;

  beforeEach(async () => {
    testDir = await createTestRunDir();
    service = new AgentRunService({ runsBaseDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('approves a valid pending approval', async () => {
    const runId = 'test-run-1';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    // Create an approval binding through the store directly
    const binding: ApprovalBinding = {
      id: 'apb-1',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: { url: 'https://example.com/api' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test-nonce-1',
    };

    // Transition to awaiting-approval with the binding
    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [binding],
    );

    const result = await service.approveTool({
      approvalId: 'apb-1',
      runId,
      actor: 'human',
      reason: 'Looks safe',
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('denies a pending approval', async () => {
    const runId = 'test-run-2';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const binding: ApprovalBinding = {
      id: 'apb-2',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: { url: 'https://example.com/api' },
      risk: 'high-impact',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test-nonce-2',
    };

    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [binding],
    );

    const result = await service.denyTool({
      approvalId: 'apb-2',
      runId,
      actor: 'human',
      reason: 'Not authorized',
    });

    expect(result.success).toBe(true);
  });

  it('rejects expired approvals', async () => {
    const runId = 'test-run-3';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const expiredBinding: ApprovalBinding = {
      id: 'apb-3',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: { url: 'https://example.com/api' },
      risk: 'write',
      requestedAt: new Date(Date.now() - 600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // Already expired
      nonce: 'test-nonce-3',
    };

    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [expiredBinding],
    );

    const result = await service.approveTool({
      approvalId: 'apb-3',
      runId,
      actor: 'human',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('rejects forged approval IDs (not found in run)', async () => {
    const runId = 'test-run-4';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const binding: ApprovalBinding = {
      id: 'apb-4',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: { url: 'https://example.com/api' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test-nonce-4',
    };

    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [binding],
    );

    // Try a forged ID
    const result = await service.approveTool({
      approvalId: 'apb-forged',
      runId,
      actor: 'human',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('rejects mismatched approval for wrong run', async () => {
    const runId = 'test-run-5a';
    const wrongRunId = 'test-run-5b';

    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());
    await service.createRunDocument(wrongRunId, minimalAgentState(wrongRunId), zeroBudgets(), makeVersionedMetadata());

    const binding: ApprovalBinding = {
      id: 'apb-5',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: { url: 'https://example.com/api' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test-nonce-5',
    };

    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [binding],
    );

    // Try to approve from wrong run
    const result = await service.approveTool({
      approvalId: 'apb-5',
      runId: wrongRunId,
      actor: 'human',
    });

    expect(result.success).toBe(false);
    // Either 'not found' or 'not awaiting' depending on whether wrongRunId has pending approvals
    expect(result.error).toBeTruthy();
  });

  it('rejects reused approval (already resolved)', async () => {
    const runId = 'test-run-6';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const binding: ApprovalBinding = {
      id: 'apb-6',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: { url: 'https://example.com/api' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test-nonce-6',
    };

    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [binding],
    );

    // First approval succeeds
    const firstResult = await service.approveTool({
      approvalId: 'apb-6',
      runId,
      actor: 'human',
    });
    expect(firstResult.success).toBe(true);

    // Second attempt should fail
    const secondResult = await service.approveTool({
      approvalId: 'apb-6',
      runId,
      actor: 'human',
    });
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain('already been');
  });

  it('rejects approval when run is not awaiting-approval', async () => {
    const runId = 'test-run-7';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    // Run is still 'running' — no pending approvals
    const result = await service.approveTool({
      approvalId: 'nonexistent',
      runId,
      actor: 'human',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not awaiting approval');
  });

  it('rejects unknown actor', async () => {
    const runId = 'test-run-8';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const binding: ApprovalBinding = {
      id: 'apb-8',
      runId,
      toolName: 'http_post',
      argumentsHash: 'abc123',
      arguments: {},
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test-nonce-8',
    };

    await service.transitionToAwaitingApproval(
      runId,
      minimalAgentState(runId),
      zeroBudgets(),
      [binding],
    );

    // Testing invalid actor — cast to bypass type check
    const result = await service.approveTool({
      approvalId: 'apb-8',
      runId,
      actor: 'robot' as any,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown actor');
  });
});

describe('AgentRunService — cancel validation', () => {
  let testDir: string;
  let service: AgentRunService;

  beforeEach(async () => {
    testDir = await createTestRunDir();
    service = new AgentRunService({ runsBaseDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('cancels an active run', async () => {
    const runId = 'cancel-test-1';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const result = await service.cancelAgentRun(runId, 'User requested cancel');
    expect(result.success).toBe(true);

    // Verify persisted status
    const { doc } = await service.getAgentRun(runId);
    expect(doc?.status).toBe('cancelled');
    expect(doc?.error).toBe('User requested cancel');
  });

  it('rejects cancel for an already completed run', async () => {
    const runId = 'cancel-test-2';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    // Manually transition to completed
    await service.getAgentRun(runId); // ensures doc exists
    const { doc } = await service.getAgentRun(runId);
    if (doc) {
      await service['store'].transition(runId, 'completed', { agentState: doc.agentState, budgetsConsumed: doc.budgetsConsumed });
    }

    const result = await service.cancelAgentRun(runId);
    expect(result.success).toBe(false);
    expect(result.error).toContain('already');
  });

  it('returns false for non-existent run cancel', async () => {
    const result = await service.cancelAgentRun('nonexistent-run');
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('AgentRunService — resume validation', () => {
  let testDir: string;
  let service: AgentRunService;

  beforeEach(async () => {
    testDir = await createTestRunDir();
    service = new AgentRunService({ runsBaseDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('validates resume with matching versions', async () => {
    const runId = 'resume-test-1';
    const metadata = makeVersionedMetadata({ policyVersion: '1.0' });
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), metadata);

    const validation = await service.validateResume(runId, metadata);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toHaveLength(0);
  });

  it('rejects resume when policy version changed', async () => {
    const runId = 'resume-test-2';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({ policyVersion: '1.0' }));

    const currentMetadata = makeVersionedMetadata({ policyVersion: '2.0' });

    const validation = await service.validateResume(runId, currentMetadata);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('Policy version'))).toBe(true);
  });

  it('rejects resume when tool version changed', async () => {
    const runId = 'resume-test-3';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({
      toolVersions: { http_get: '1.0' },
    }));

    const currentMetadata = makeVersionedMetadata({
      toolVersions: { http_get: '2.0' },
    });

    const validation = await service.validateResume(runId, currentMetadata);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('version'))).toBe(true);
  });

  it('rejects resume when model config changed', async () => {
    const runId = 'resume-test-4';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata({
      modelConfig: { provider: 'fake', modelId: 'model-a' },
    }));

    const currentMetadata = makeVersionedMetadata({
      modelConfig: { provider: 'anthropic', modelId: 'claude-sonnet-4' },
    });

    const validation = await service.validateResume(runId, currentMetadata);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('Model config'))).toBe(true);
  });

  it('rejects resume for already completed runs', async () => {
    const runId = 'resume-test-5';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    // Mark as completed through service
    await service['store'].markCompleted(runId, minimalAgentState(runId), zeroBudgets());

    const validation = await service.validateResume(runId, makeVersionedMetadata());
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('already'))).toBe(true);
  });

  it('rejects resume for non-existent run', async () => {
    const validation = await service.validateResume('nonexistent', makeVersionedMetadata());
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.includes('not found'))).toBe(true);
  });
});

describe('ApprovalBinding validation', () => {
  it('detects tool name mismatch', () => {
    const binding: ApprovalBinding = {
      id: 'apb-test',
      runId: 'run-1',
      toolName: 'http_post',
      argumentsHash: 'abc',
      arguments: { url: 'https://example.com' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test',
    };

    const result = AgentRunService.validateApprovalBinding(binding, 'http_get', { url: 'https://example.com' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Tool name mismatch');
  });

  it('detects arguments hash mismatch', () => {
    const binding: ApprovalBinding = {
      id: 'apb-test',
      runId: 'run-1',
      toolName: 'http_post',
      argumentsHash: 'original-hash',
      arguments: { url: 'https://original.com' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test',
    };

    const result = AgentRunService.validateApprovalBinding(binding, 'http_post', { url: 'https://forged.com' });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Arguments hash mismatch');
  });

  it('passes valid binding', () => {
    const args = { url: 'https://example.com/api', method: 'POST' };
    const hash = require('node:crypto').createHash('sha256')
      .update(JSON.stringify(args, Object.keys(args).sort()))
      .digest('hex');

    const binding: ApprovalBinding = {
      id: 'apb-test',
      runId: 'run-1',
      toolName: 'http_post',
      argumentsHash: hash,
      arguments: args,
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'test',
    };

    const result = AgentRunService.validateApprovalBinding(binding, 'http_post', args);
    expect(result.valid).toBe(true);
  });
});

describe('AgentRunService — pause and lifecycle', () => {
  let testDir: string;
  let service: AgentRunService;

  beforeEach(async () => {
    testDir = await createTestRunDir();
    service = new AgentRunService({ runsBaseDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('transitions through full lifecycle: running -> awaiting-approval -> running', async () => {
    const runId = 'lifecycle-test-1';
    await service.createRunDocument(runId, minimalAgentState(runId), zeroBudgets(), makeVersionedMetadata());

    const binding: ApprovalBinding = {
      id: 'apb-lc1',
      runId,
      toolName: 'http_post',
      argumentsHash: 'hash1',
      arguments: { url: 'https://example.com/api' },
      risk: 'write',
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      nonce: 'lc-nonce-1',
    };

    // Transition to awaiting-approval
    await service.transitionToAwaitingApproval(runId, minimalAgentState(runId), zeroBudgets(), [binding]);
    let { doc } = await service.getAgentRun(runId);
    expect(doc?.status).toBe('awaiting-approval');
    expect(doc?.pendingApprovals).toHaveLength(1);

    // Approve
    await service.approveTool({ approvalId: 'apb-lc1', runId, actor: 'human' });
    ({ doc } = await service.getAgentRun(runId));
    expect(doc?.pendingApprovals).toHaveLength(0);
    expect(doc?.approvalHistory).toHaveLength(1);
    expect(doc?.status).toBe('awaiting-approval'); // Status stays until runtime resumes

    // Transition back to running
    await service.transitionToRunning(runId, minimalAgentState(runId), zeroBudgets());
    ({ doc } = await service.getAgentRun(runId));
    expect(doc?.status).toBe('running');
  });
});
