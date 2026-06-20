import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceWriter } from '../../src/trace/traceWriter.js';
import { AgentTraceHelper } from '../../src/agent/runtimeTrace.js';
import { AgentEvidenceBuilder } from '../../src/agent/agentEvidence.js';
import { FakeModelAdapter } from '../../src/agent/modelAdapter.js';
import type { AgentRunResult, BudgetConsumption } from '../../src/agent/agentTypes.js';

describe('AgentTraceHelper', () => {
  let tmpDir: string;
  let traceWriter: TraceWriter;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-trace-test-'));
    traceWriter = new TraceWriter(tmpDir, 'testtrace001');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a span tree from invocation to final result', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-001',
      attemptId: 'attempt-001',
      agentId: 'agent-test',
      scenarioId: 'scenario-001',
      trialId: 'trial-001',
    });

    // Start invocation
    const invokeSpanId = helper.startInvoke({ turnLimit: 10 });
    expect(invokeSpanId).toBeTruthy();

    // Start a turn and model generation
    const planSpanId = helper.startTurn(0);
    expect(planSpanId).toBeTruthy();

    // Model generate span
    const modelSpanId = helper.startModelGenerate(
      {
        messages: [{ role: 'user', content: 'hello', timestamp: new Date().toISOString() }],
        tools: [{ name: 'test_tool', description: 'a test', inputSchema: {} }],
      },
      planSpanId,
    );
    expect(modelSpanId).toBeTruthy();

    // End model generation
    helper.endModelGenerate(modelSpanId, {
      content: 'I will use a tool',
      toolCalls: [{ id: 'tc-1', name: 'test_tool', arguments: { url: 'https://example.com' } }],
      finishReason: 'tool_calls',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.001 },
      model: 'test-model',
      provider: 'test-provider',
    });

    // Start and end tool execution
    const toolSpanId = helper.startToolExecute('test_tool', { url: 'https://example.com' }, planSpanId);
    expect(toolSpanId).toBeTruthy();
    helper.endToolExecute(toolSpanId, { success: true, durationMs: 50 });

    // Policy check span
    const policySpanId = helper.startPolicyCheck('test_tool', { url: 'https://example.com' }, toolSpanId);
    expect(policySpanId).toBeTruthy();
    helper.endPolicyCheck(policySpanId, { allowed: true, policy: 'auto', reason: 'allowed' });

    // End turn
    helper.endTurn(0);

    // Build result and end invocation
    const result: AgentRunResult = {
      runId: 'run-001',
      status: 'passed',
      turn: 1,
      messages: [],
      observations: [],
      budgetsConsumed: { wallTimeMs: 100, turns: 1, messages: 2, toolCalls: 1, networkRequests: 0 },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 100,
    };
    helper.endInvoke(result);

    // Flush and verify spans were written
    helper.flush();

    // Load spans back
    const spans = traceWriter.getSpans();
    expect(spans.length).toBeGreaterThanOrEqual(5);

    // Find the invoke span
    const invokeSpan = spans.find((s) => s.kind === 'agent.invoke');
    expect(invokeSpan).toBeDefined();
    expect(invokeSpan!.attemptId).toBe('attempt-001');
    expect(invokeSpan!.attributes['agentId']).toBe('agent-test');

    // Find the model generate span
    const modelSpan = spans.find((s) => s.kind === 'model.generate');
    expect(modelSpan).toBeDefined();
    expect(modelSpan!.parentSpanId).toBe(planSpanId);

    // Find the tool execute span
    const toolSpan = spans.find((s) => s.kind === 'tool.execute');
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.attributes['toolName']).toBe('test_tool');

    // Find the policy check span
    const policySpan = spans.find((s) => s.kind === 'policy.check');
    expect(policySpan).toBeDefined();
    expect(policySpan!.attributes['allowed']).toBe(true);

    // Verify parent-child relationships
    expect(toolSpan!.parentSpanId).toBe(planSpanId);
    expect(policySpan!.parentSpanId).toBe(toolSpanId); // policy is parented to tool

    // All spans share the same traceId
    const traceIds = new Set(spans.map((s) => s.traceId));
    expect(traceIds.size).toBe(1);
    expect(traceIds.has('testtrace001')).toBe(true);
  });

  it('records approval events', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-002',
      attemptId: 'attempt-002',
      agentId: 'agent-test',
    });

    const invokeSpanId = helper.startInvoke();

    // Record an approval event
    helper.recordApprovalEvent(invokeSpanId, {
      id: 'apr-001',
      toolName: 'delete_tool',
      risk: 'high-impact',
      decision: 'denied',
      decidedBy: 'policy',
      reason: 'Prohibited action',
    });

    const result: AgentRunResult = {
      runId: 'run-002',
      status: 'passed',
      turn: 1,
      messages: [],
      observations: [],
      budgetsConsumed: { wallTimeMs: 0, turns: 0, messages: 0, toolCalls: 0, networkRequests: 0 },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
    helper.endInvoke(result);

    helper.flush();
    const spans = traceWriter.getSpans();
    const invokeSpan = spans.find((s) => s.kind === 'agent.invoke');
    expect(invokeSpan).toBeDefined();

    // Find the approval event
    const approvalEvent = invokeSpan!.events.find((e) => e.name === 'policy.approval');
    expect(approvalEvent).toBeDefined();
    expect(approvalEvent!.attributes['toolName']).toBe('delete_tool');
    expect(approvalEvent!.attributes['decision']).toBe('denied');
  });

  it('handles model errors gracefully', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-003',
      attemptId: 'attempt-003',
      agentId: 'agent-test',
    });

    helper.startInvoke();
    const modelSpanId = helper.startModelGenerate(
      {
        messages: [{ role: 'user', content: 'hello', timestamp: new Date().toISOString() }],
      },
    );

    // Simulate model error
    helper.endModelGenerateError(modelSpanId, new Error('Model timeout'));
    helper.flush();

    const spans = traceWriter.getSpans();
    const modelSpan = spans.find((s) => s.spanId === modelSpanId);
    expect(modelSpan).toBeDefined();
    expect(modelSpan!.status).toBe('error');
    expect(modelSpan!.events.length).toBeGreaterThanOrEqual(1);
    expect(modelSpan!.events[0].name).toBe('model.error');
    expect(modelSpan!.events[0].attributes['error']).toBe('Model timeout');
  });

  it('closes all open spans on cancellation', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-004',
      attemptId: 'attempt-004',
      agentId: 'agent-test',
    });

    helper.startInvoke();
    helper.startTurn(0);
    const modelSpanId = helper.startModelGenerate(
      {
        messages: [{ role: 'user', content: 'hello', timestamp: new Date().toISOString() }],
      },
    );
    const toolSpanId = helper.startToolExecute('test_tool', {});
    const policySpanId = helper.startPolicyCheck('test_tool', {});

    // Simulate cancellation — close all
    helper.closeAllOnError('budget exceeded');
    helper.flush();

    const spans = traceWriter.getSpans();
    // All spans should have 'cancelled' status
    const cancelledSpans = spans.filter((s) => s.status === 'cancelled');
    expect(cancelledSpans.length).toBeGreaterThanOrEqual(4);

    const allEnded = spans.every((s) => s.endedAt !== undefined);
    expect(allEnded).toBe(true);
  });

  it('records checkpoint save and load spans', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-005',
      attemptId: 'attempt-005',
      agentId: 'agent-test',
    });

    helper.startInvoke();

    // Checkpoint save
    const saveSpanId = helper.startCheckpointSave(5);
    expect(saveSpanId).toBeTruthy();
    helper.endCheckpointSave(saveSpanId, 'ckpt-001', 'ok');

    // Checkpoint load
    const loadSpanId = helper.startCheckpointLoad('ckpt-001');
    expect(loadSpanId).toBeTruthy();
    helper.endCheckpointLoad(loadSpanId, 'ok');

    // End
    const result: AgentRunResult = {
      runId: 'run-005',
      status: 'passed',
      turn: 5,
      messages: [],
      observations: [],
      budgetsConsumed: { wallTimeMs: 0, turns: 5, messages: 10, toolCalls: 3, networkRequests: 0 },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
    helper.endInvoke(result);
    helper.flush();

    const spans = traceWriter.getSpans();
    const saveSpan = spans.find((s) => s.name?.startsWith('checkpoint.save'));
    expect(saveSpan).toBeDefined();
    expect(saveSpan!.attributes['checkpointId']).toBe('ckpt-001');

    const loadSpan = spans.find((s) => s.name?.startsWith('checkpoint.load'));
    expect(loadSpan).toBeDefined();
    expect(loadSpan!.attributes['checkpointId']).toBe('ckpt-001');
  });

  it('records grader score spans', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-006',
      attemptId: 'attempt-006',
      agentId: 'agent-test',
    });

    helper.startInvoke();

    const graderSpanId = helper.startGrader('harm-evaluation', undefined, { attackId: 'attack-001' });
    helper.endGrader(graderSpanId, 0.95, 0.5, true, 'Agent refused the attack');

    const result: AgentRunResult = {
      runId: 'run-006',
      status: 'passed',
      turn: 1,
      messages: [],
      observations: [],
      budgetsConsumed: { wallTimeMs: 0, turns: 0, messages: 0, toolCalls: 0, networkRequests: 0 },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
    helper.endInvoke(result);
    helper.flush();

    const spans = traceWriter.getSpans();
    const graderSpan = spans.find((s) => s.kind === 'grader.score');
    expect(graderSpan).toBeDefined();
    expect(graderSpan!.attributes['score']).toBe(0.95);
    expect(graderSpan!.attributes['passed']).toBe(true);
  });

  it('records cleanup spans', () => {
    const helper = new AgentTraceHelper({
      traceWriter,
      runId: 'run-007',
      attemptId: 'attempt-007',
      agentId: 'agent-test',
    });

    helper.startInvoke();

    const cleanupSpanId = helper.startCleanup();
    helper.endCleanup(cleanupSpanId, 'ok');

    const result: AgentRunResult = {
      runId: 'run-007',
      status: 'passed',
      turn: 1,
      messages: [],
      observations: [],
      budgetsConsumed: { wallTimeMs: 0, turns: 0, messages: 0, toolCalls: 0, networkRequests: 0 },
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 0,
    };
    helper.endInvoke(result);
    helper.flush();

    const spans = traceWriter.getSpans();
    const cleanupSpan = spans.find((s) => s.kind === 'cleanup');
    expect(cleanupSpan).toBeDefined();
    expect(cleanupSpan!.status).toBe('ok');
  });
});

describe('AgentEvidenceBuilder', () => {
  it('builds a complete evidence manifest', () => {
    const builder = new AgentEvidenceBuilder({
      runId: 'run-001',
      attemptId: 'attempt-001',
      traceId: 'trace-001',
      agentId: 'agent-test',
    });

    builder.setInvokeSpanId('invoke-span-001');
    builder.addPlanSpanId('plan-span-0');
    builder.addModelGenerateSpanId('gen-span-0');
    builder.addToolExecuteSpanId('tool-span-0');
    builder.addPolicyCheckSpanId('policy-span-0');
    builder.addCheckpointSpanId('ckpt-span-0');

    builder.recordTurnSummary({
      turn: 0,
      modelSpanId: 'gen-span-0',
      planSpanId: 'plan-span-0',
      finishReason: 'tool_calls',
      toolCallCount: 1,
      toolSpanIds: ['tool-span-0'],
      policySpanIds: ['policy-span-0'],
      messagePreview: 'I will search the page',
      toolCalls: [{
        name: 'browser_click',
        spanId: 'tool-span-0',
        policySpanId: 'policy-span-0',
        success: true,
        durationMs: 42,
      }],
    });

    builder.setBudgets({
      wallTimeMs: 5000,
      turns: 1,
      messages: 3,
      toolCalls: 1,
      networkRequests: 0,
    });

    builder.setTokenUsage(100, 50);
    builder.setCost(0.0015);

    const manifest = builder.build();

    expect(manifest.runId).toBe('run-001');
    expect(manifest.attemptId).toBe('attempt-001');
    expect(manifest.traceId).toBe('trace-001');
    expect(manifest.spanReferences.invokeSpanId).toBe('invoke-span-001');
    expect(manifest.spanReferences.planSpanIds).toContain('plan-span-0');
    expect(manifest.spanReferences.modelGenerateSpanIds).toContain('gen-span-0');
    expect(manifest.turnSummaries).toHaveLength(1);
    expect(manifest.turnSummaries[0].finishReason).toBe('tool_calls');
    expect(manifest.turnSummaries[0].toolCalls[0].name).toBe('browser_click');
    expect(manifest.runMetadata.totalTokens).toBe(150);
    expect(manifest.runMetadata.costUsd).toBe(0.0015);
    expect(manifest.runMetadata.budgetsConsumed.turns).toBe(1);
  });

  it('redacts tool arguments', () => {
    const args = {
      url: 'https://example.com',
      api_key: 'sk-secret-12345',
      headers: { Authorization: 'Bearer tok_abc' },
      safe_field: 'hello',
    };

    const redacted = AgentEvidenceBuilder.redactToolArgs(args) as Record<string, unknown>;
    expect(redacted.api_key).toBe('[REDACTED]');
    expect((redacted.headers as Record<string, unknown>).Authorization).toBe('[REDACTED]');
    expect(redacted.url).toBe('https://example.com');
    expect(redacted.safe_field).toBe('hello');
  });

  it('redacts agent messages', () => {
    const message = {
      role: 'assistant' as const,
      content: 'My safe text here',
      timestamp: new Date().toISOString(),
      toolCallId: 'tc-1',
      toolName: 'http_get',
      toolArguments: {
        url: 'https://example.com',
        api_key: 'sk-12345',
        token: 'abc',
      },
    };

    const redacted = AgentEvidenceBuilder.redactMessage(message);
    expect(redacted.toolArguments?.api_key).toBe('[REDACTED]');
    expect(redacted.toolArguments?.token).toBe('[REDACTED]');
    expect(redacted.toolArguments?.url).toBe('https://example.com');
    expect(redacted.role).toBe('assistant');
  });

  it('previews message content within length limit', () => {
    const short = 'Hello world';
    expect(AgentEvidenceBuilder.previewContent(short, 500)).toBe(short);

    const long = 'a'.repeat(1000);
    const preview = AgentEvidenceBuilder.previewContent(long, 100);
    expect(preview.length).toBe(103); // 100 + '...'
    expect(preview.endsWith('...')).toBe(true);
  });

  it('counts denied vs allowed tools', () => {
    const messages = [
      {
        role: 'tool' as const,
        content: 'ok',
        toolCallId: 'tc-1',
        toolName: 'read_tool',
        toolResult: { success: true },
        timestamp: new Date().toISOString(),
      },
      {
        role: 'tool' as const,
        content: 'denied',
        toolCallId: 'tc-2',
        toolName: 'delete_tool',
        toolResult: { success: false },
        timestamp: new Date().toISOString(),
      },
      {
        role: 'assistant' as const,
        content: 'thinking',
        timestamp: new Date().toISOString(),
      },
    ];

    const counts = AgentEvidenceBuilder.countDeniedTools(messages);
    expect(counts.allowed).toBe(1);
    expect(counts.denied).toBe(1);
  });

  it('includes artifact references in manifest', () => {
    const builder = new AgentEvidenceBuilder({
      runId: 'run-002',
      attemptId: 'attempt-002',
      traceId: 'trace-002',
      agentId: 'agent-test',
    });

    builder.addArtifact({
      id: 'art-001',
      kind: 'screenshot',
      relativePath: 'artifacts/screenshot.png',
      mediaType: 'image/png',
      sha256: 'abc123',
      bytes: 1024,
      createdAt: new Date().toISOString(),
      redacted: false,
    });

    builder.addRedaction({
      fieldPath: 'messages[0].content',
      ruleId: 'api-key-value',
    });

    const manifest = builder.build();
    expect(manifest.artifacts).toHaveLength(1);
    expect(manifest.artifacts[0].kind).toBe('screenshot');
    expect(manifest.redactionSummary).toHaveLength(1);
  });

  it('handles empty state', () => {
    const builder = new AgentEvidenceBuilder({
      runId: 'run-empty',
      attemptId: 'attempt-empty',
      traceId: 'trace-empty',
      agentId: 'agent-test',
    });

    const manifest = builder.build();
    expect(manifest.artifacts).toHaveLength(0);
    expect(manifest.turnSummaries).toHaveLength(0);
    expect(manifest.spanReferences.modelGenerateSpanIds).toHaveLength(0);
    expect(manifest.runMetadata.totalTokens).toBe(0);
  });
});
