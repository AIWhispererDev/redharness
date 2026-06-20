import { describe, it, expect } from 'vitest';
import { FakeModelAdapter } from '../../src/agent/modelAdapter.js';
import { ToolRegistry } from '../../src/agent/toolRegistry.js';
import { ApprovalEngine } from '../../src/agent/approval.js';
import { BudgetTracker } from '../../src/agent/budgets.js';
import { createExploratoryQaIntent } from '../../src/agent/intent.js';
import { RepeatedActionDetector, LoopDetector, StallDetector } from '../../src/agent/stopConditions.js';
import type { AgentDefinition, ToolDefinition, AgentPolicy, ToolExecutionContext, ToolResult } from '../../src/agent/agentTypes.js';

describe('ModelAdapter', () => {
  it('returns configured response from fake adapter', async () => {
    const adapter = new FakeModelAdapter({ content: 'Hello, world!' });
    const response = await adapter.generate(
      { messages: [{ role: 'user', content: 'Hi', timestamp: new Date().toISOString() }] },
      new AbortController().signal,
    );
    expect(response.content).toBe('Hello, world!');
    expect(response.finishReason).toBe('stop');
  });

  it('simulates errors when configured', async () => {
    const adapter = new FakeModelAdapter({ simulateError: true });
    await expect(
      adapter.generate(
        { messages: [{ role: 'user', content: 'Hi', timestamp: new Date().toISOString() }] },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Fake adapter simulated error');
  });

  it('respects abort signal with delay', async () => {
    const adapter = new FakeModelAdapter({ simulateDelayMs: 5000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    await expect(
      adapter.generate(
        { messages: [{ role: 'user', content: 'Hi', timestamp: new Date().toISOString() }] },
        ac.signal,
      ),
    ).rejects.toThrow('Aborted');
  });
});

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'test_tool',
      version: '1.0',
      description: 'A test tool',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
      risk: 'read',
      capabilities: ['http'],
      execute: async (_args: Record<string, unknown>, _ctx: ToolExecutionContext): Promise<ToolResult> => ({
        success: true,
        output: 'done',
        durationMs: 0,
      }),
    };
    registry.register(tool);
    expect(registry.get('test_tool')).toBeDefined();
    expect(registry.getNames()).toContain('test_tool');
  });

  it('rejects duplicate registration', () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'dup',
      version: '1.0',
      description: 'dup',
      inputSchema: {},
      risk: 'read',
      capabilities: [],
      execute: async () => ({ success: true, output: 'done', durationMs: 0 }),
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow('Duplicate tool registration');
  });

  it('validates tool arguments against schema', () => {
    const registry = new ToolRegistry();
    const tool: ToolDefinition = {
      name: 'validator',
      version: '1.0',
      description: 'test validation',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
        },
        required: ['name'],
      },
      risk: 'read',
      capabilities: [],
      execute: async () => ({ success: true, output: 'done', durationMs: 0 }),
    };
    registry.register(tool);

    // Valid
    expect(registry.validateArgs('validator', { name: 'test', count: 5 })).toBeNull();

    // Missing required
    expect(registry.validateArgs('validator', { count: 5 })).not.toBeNull();

    // Unknown field
    expect(registry.validateArgs('validator', { name: 'test', unknownField: true })).not.toBeNull();

    // Unknown tool
    expect(registry.validateArgs('nonexistent', {})).not.toBeNull();
  });
});

describe('ApprovalEngine', () => {
  const registry = new ToolRegistry();
  const readTool: ToolDefinition = {
    name: 'read_tool',
    version: '1.0',
    description: 'read only',
    inputSchema: {},
    risk: 'read',
    capabilities: [],
    execute: async () => ({ success: true, output: 'ok', durationMs: 0 }),
  };
  const highImpactTool: ToolDefinition = {
    name: 'delete_tool',
    version: '1.0',
    description: 'high impact',
    inputSchema: {},
    risk: 'high-impact',
    capabilities: [],
    execute: async () => ({ success: true, output: 'deleted', durationMs: 0 }),
  };
  registry.registerAll([readTool, highImpactTool]);

  const policy: AgentPolicy = {
    defaultToolApproval: 'auto',
    toolPolicies: [],
    allowedOrigins: ['https://example.com'],
    prohibitedActions: ['delete'],
    requireHumanForStateChanges: true,
  };

  const intent = createExploratoryQaIntent({
    userGoal: 'Test exploration',
    baseUrl: 'https://example.com',
  });

  it('auto-approves read tools', () => {
    // browser_observe is in the intent's allowedActions and NOT prohibited.
    // Register it as a read-risk tool.
    const obsTool: ToolDefinition = {
      name: 'browser_observe',
      version: '1.0',
      description: 'browser observation',
      inputSchema: {},
      risk: 'read',
      capabilities: ['browser'],
      execute: async () => ({ success: true, output: 'observed', durationMs: 0 }),
    };
    const testRegistry = new ToolRegistry();
    testRegistry.register(obsTool);
    const engine = new ApprovalEngine({ registry: testRegistry, policy });
    const decision = engine.evaluate('browser_observe', {}, intent, false);
    expect(decision.allowed).toBe(true);
    expect(decision.policy).toBe('auto');
  });

  it('denies unknown tools', () => {
    const engine = new ApprovalEngine({ registry, policy });
    const decision = engine.evaluate('unknown_tool', {}, intent, false);
    expect(decision.allowed).toBe(false);
  });

  it('denies high-impact tools in CI mode', () => {
    // http_get IS in the intent's allowed actions, so intent validation passes.
    // We register it with high-impact risk to test the auto-policy gate.
    const hiTool: ToolDefinition = {
      name: 'http_get',
      version: '1.0',
      description: 'high impact write',
      inputSchema: {},
      risk: 'high-impact',
      capabilities: [],
      execute: async () => ({ success: true, output: 'ok', durationMs: 0 }),
    };
    const testRegistry = new ToolRegistry();
    testRegistry.register(hiTool);
    const eng = new ApprovalEngine({
      registry: testRegistry,
      policy: { ...policy, prohibitedActions: [], toolPolicies: [] },
    });
    const decision = eng.evaluate('http_get', {}, intent, true);
    expect(decision.allowed).toBe(false);
    expect(decision.requiresHuman).toBe(true);
  });

  it('denies prohibited actions', () => {
    const engine = new ApprovalEngine({ registry, policy });
    // delete_tool matches prohibited action 'delete'
    const decision = engine.evaluate('delete_tool', {}, intent, false);
    expect(decision.allowed).toBe(false);
  });
});

describe('Intent validation', () => {
  it('creates exploratory QA intent with correct defaults', () => {
    const intent = createExploratoryQaIntent({
      userGoal: 'Explore the app',
      baseUrl: 'https://pocketsoc.me',
    });
    expect(intent.goalId).toBeTruthy();
    expect(intent.allowedActions.length).toBeGreaterThan(0);
    expect(intent.prohibitedActions).toContain('shell');
    expect(intent.allowedOrigins).toContain('https://pocketsoc.me');
  });
});

describe('BudgetTracker', () => {
  it('tracks basic consumption', () => {
    const tracker = new BudgetTracker({
      wallTimeMs: 10000,
      turns: 10,
      messages: 100,
      toolCalls: 50,
      networkRequests: 20,
    });

    tracker.recordTurn();
    tracker.recordMessage();
    tracker.recordToolCall('browser_navigate');
    tracker.recordNetworkRequest();

    const consumed = tracker.getConsumption();
    expect(consumed.turns).toBe(1);
    expect(consumed.messages).toBe(1);
    expect(consumed.toolCalls).toBe(1);
    expect(consumed.networkRequests).toBe(1);
    expect(consumed.wallTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('detects budget exceeded', () => {
    const tracker = new BudgetTracker({
      wallTimeMs: 100000,
      turns: 2,
      messages: 100,
      toolCalls: 50,
      networkRequests: 20,
    });

    tracker.recordTurn();
    tracker.recordTurn();
    tracker.recordTurn(); // Exceeds turns

    const result = tracker.check();
    expect(result.exceeded).toBe(true);
    expect(result.category).toBe('turns');
  });

  it('tracks per-tool call limits', () => {
    const tracker = new BudgetTracker({
      wallTimeMs: 100000,
      turns: 10,
      messages: 100,
      toolCalls: 50,
      networkRequests: 20,
      perToolCalls: { expensive_tool: 3 },
    });

    tracker.recordToolCall('expensive_tool');
    tracker.recordToolCall('expensive_tool');
    expect(tracker.check().exceeded).toBe(false);

    tracker.recordToolCall('expensive_tool');
    expect(tracker.check().exceeded).toBe(true);
    expect(tracker.check().category).toContain('expensive_tool');
  });

  it('can reset from existing consumption', () => {
    const tracker = new BudgetTracker({
      wallTimeMs: 100000,
      turns: 10,
      messages: 100,
      toolCalls: 50,
      networkRequests: 20,
    });

    tracker.reset({
      wallTimeMs: 5000,
      turns: 3,
      messages: 10,
      toolCalls: 5,
      networkRequests: 2,
    });

    expect(tracker.getConsumption().turns).toBe(3);
    expect(tracker.getConsumption().messages).toBe(10);
  });
});

describe('StopConditions', () => {
  describe('RepeatedActionDetector', () => {
    it('detects repeated identical actions', () => {
      const detector = new RepeatedActionDetector(3, 10);
      expect(detector.recordAndCheck('click', { target: 'button' }).shouldStop).toBe(false);
      expect(detector.recordAndCheck('click', { target: 'button' }).shouldStop).toBe(false);
      expect(detector.recordAndCheck('click', { target: 'button' }).shouldStop).toBe(true);
    });

    it('does not flag different actions', () => {
      const detector = new RepeatedActionDetector(3, 10);
      detector.recordAndCheck('click', { target: 'btn1' });
      detector.recordAndCheck('click', { target: 'btn2' });
      detector.recordAndCheck('click', { target: 'btn3' });
      expect(detector.recordAndCheck('click', { target: 'btn4' }).shouldStop).toBe(false);
    });
  });

  describe('LoopDetector', () => {
    it('detects action loops', () => {
      const detector = new LoopDetector(2, 3);
      // Pattern: click, scroll repeated 3x
      for (let i = 0; i < 3; i++) {
        detector.recordAndCheck('click');
        detector.recordAndCheck('scroll');
      }
      const result = detector.recordAndCheck('click');
      expect(result.shouldStop).toBe(true);
      expect(result.reason).toContain('loop');
    });
  });

  describe('StallDetector', () => {
    it('detects stalled progress', () => {
      const detector = new StallDetector(3);
      detector.recordTurn();
      detector.recordTurn();
      detector.recordTurn();
      detector.recordTurn(); // 4 turns, no distinct action
      const result = detector.check();
      expect(result.shouldStop).toBe(true);
    });

    it('does not trigger with distinct actions', () => {
      const detector = new StallDetector(3);
      detector.recordTurn();
      detector.recordDistinctAction();
      detector.recordTurn();
      detector.recordDistinctAction();
      const result = detector.check();
      expect(result.shouldStop).toBe(false);
    });
  });
});
