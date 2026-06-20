/**
 * Agent actor executor — runs AgentRuntime as a scenario trial.
 *
 * Given a scenario with actor.kind === 'agent', this module:
 * 1. Resolves agent configuration from the scenario
 * 2. Creates a model adapter (fake, replay, or live)
 * 3. Instantiates AgentRuntime and runs it
 * 4. Captures final output, trace, tool sequence, state snapshots, and evidence
 * 5. Returns a structured result for graders to consume
 */

import { type AgentRuntime } from '../agent/runtime.js';
import type { AgentDefinition, AgentRunResult, ModelConfig, IntentCapsule } from '../agent/agentTypes.js';
import type { ModelAdapter } from '../agent/modelAdapter.js';
import type { AgentActorConfig } from './schema.js';
import type { ScenarioDefinition } from './schema.js';
import { createAdapter } from '../agent/modelAdapters/factory.js';
import { createExploratoryQaIntent } from '../agent/intent.js';
import { resolveAgentConfig, hashAgentConfig } from '../agents/loader.js';
import { toolRegistry as defaultRegistry } from '../agent/toolRegistry.js';
import { httpGetTool, httpPostTool } from '../agent/tools/httpTools.js';
import { fixtureReadStateTool, fixtureActTool, fixtureResetTool } from '../agent/tools/fixtureTools.js';
import type { ExecutionStatus } from '../core/status.js';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Agent trial result (what graders consume)
// ---------------------------------------------------------------------------

export type AgentTrialEvidence = {
  /** Full agent run result from runtime. */
  runResult: AgentRunResult;
  /** Before-execution fixture state snapshot (when available). */
  beforeState?: Record<string, unknown>;
  /** After-execution fixture state snapshot (when available). */
  afterState?: Record<string, unknown>;
  /** Sequence of tool call names in execution order. */
  toolSequence: Array<{ turn: number; tool: string; success: boolean; durationMs: number }>;
  /** Agent config hash for version tracking. */
  agentConfigHash: string;
  /** Scenario definition hash for version tracking. */
  scenarioHash: string;
  /** Provider mode used. */
  providerMode: string;
};

/** Result of running an agent trial. */
export type AgentTrialResult = {
  trial: number;
  status: ExecutionStatus;
  evidence: AgentTrialEvidence;
  error?: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
};

/** Options for running an agent trial. */
export type AgentTrialOptions = {
  scenario: ScenarioDefinition;
  trial: number;
  baseUrl: string;
  agentConfig?: AgentActorConfig;
  providerMode?: 'fake' | 'replay' | 'live';
  fixtureBaseUrl?: string;
};

// ---------------------------------------------------------------------------
// Tool registration helper
// ---------------------------------------------------------------------------

function ensureFixtureToolsRegistered(): void {
  const tools = [httpGetTool, httpPostTool, fixtureReadStateTool, fixtureActTool, fixtureResetTool];
  for (const tool of tools) {
    if (!defaultRegistry.get(tool.name)) {
      defaultRegistry.register(tool);
    }
  }
}

// ---------------------------------------------------------------------------
// Agent trial runner
// ---------------------------------------------------------------------------

/**
 * Run a single agent trial for a scenario.
 *
 * Resolves the agent configuration, builds a model adapter, creates an
 * AgentRuntime, runs it, captures evidence, and returns the trial result.
 */
export async function runAgentTrial(options: AgentTrialOptions): Promise<AgentTrialResult> {
  const { scenario, trial, baseUrl, providerMode } = options;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Resolve agent configuration
  const agentConfig = options.agentConfig ?? resolveAgentConfig(
    scenario.actor.agentRef,
    scenario.actor.config,
  );

  // Compute content hashes
  const agentConfigHash = hashAgentConfig(agentConfig);
  const scenarioHash = hashScenario(scenario);

  // Ensure tools are registered
  ensureFixtureToolsRegistered();

  // Determine fixture base URL — use baseUrl as fallback
  const fixtureBaseUrl = options.fixtureBaseUrl ?? baseUrl;

  // Capture before state (best-effort)
  let beforeState: Record<string, unknown> | undefined;
  try {
    const resp = await fetch(`${fixtureBaseUrl}/state`);
    if (resp.ok) {
      beforeState = await resp.json() as Record<string, unknown>;
    }
  } catch {
    // Non-fixture targets may not have /state
  }

  // Build model adapter
  const mode = providerMode ?? scenario.providerMode ?? 'fake';
  let modelAdapter: ModelAdapter;

  switch (mode) {
    case 'replay':
      modelAdapter = createAdapter({ provider: 'replay', replayEntries: [] });
      break;
    case 'live':
      modelAdapter = createAdapter({ provider: agentConfig.model.provider === 'fake' ? 'openai' : agentConfig.model.provider });
      break;
    case 'fake':
    default: {
      // Build a deterministic fake adapter from the scenario
      const toolCalls = buildFakeToolCalls(scenario, agentConfig);
      // Wrap the fake adapter so tool calls are emitted only on the first generate() call.
      // Without this, the fake adapter returns tool calls on every call, causing infinite
      // tool-request loops that end when budgets or stop conditions fire prematurely.
      const innerAdapter = createAdapter({
        provider: 'fake',
        fakeConfig: {
          content: scenario.agentGoal ?? scenario.title ?? 'Agent run complete.',
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        },
      });
      modelAdapter = {
        async generate(request, signal) {
          const response = await innerAdapter.generate(request, signal);
          // On second and subsequent calls, strip tool calls so the agent terminates normally
          if (response.toolCalls.length > 0) {
            // Configure inner to return stop on next call
            (innerAdapter as any).config = {
              ...(innerAdapter as any).config,
              toolCalls: [],
              finishReason: 'stop',
            };
          }
          return response;
        },
        estimateCost(usage) {
          return 0;
        },
      };
      break;
    }
  }

  // Build agent definition from config
  const agentDefinition: AgentDefinition = {
    id: agentConfig.agentId,
    version: agentConfig.version,
    instructions: agentConfig.instructions,
    model: {
      provider: agentConfig.model.provider,
      modelId: agentConfig.model.modelId,
      parameters: agentConfig.model.parameters,
    },
    tools: agentConfig.tools,
    policy: {
      defaultToolApproval: agentConfig.policy.defaultToolApproval,
      toolPolicies: agentConfig.policy.toolPolicies ?? [],
      allowedOrigins: agentConfig.policy.allowedOrigins ?? [new URL(baseUrl).origin],
      prohibitedActions: agentConfig.policy.prohibitedActions,
      requireHumanForStateChanges: agentConfig.policy.requireHumanForStateChanges ?? false,
    },
    budgets: {
      wallTimeMs: agentConfig.budgets.wallTimeMs,
      turns: agentConfig.budgets.turns,
      messages: agentConfig.budgets.messages ?? agentConfig.budgets.turns * 4,
      toolCalls: agentConfig.budgets.toolCalls ?? 0,
      networkRequests: agentConfig.budgets.networkRequests ?? 10,
    },
  };

  // Build intent capsule
  const goal = scenario.agentGoal ?? `Execute scenario: ${scenario.title}`;
  const intent: IntentCapsule = {
    goalId: `scenario-${scenario.id}-trial-${trial}`,
    userGoal: goal,
    allowedActions: agentConfig.tools,
    prohibitedActions: agentConfig.policy.prohibitedActions,
    allowedOrigins: agentConfig.policy.allowedOrigins ?? [new URL(baseUrl).origin],
    dataBoundary: 'fixture',
    expiresAt: new Date(Date.now() + agentConfig.budgets.wallTimeMs).toISOString(),
  };

  // Instantiate and run the runtime
  let runResult: AgentRunResult;
  try {
    const { AgentRuntime } = await import('../agent/runtime.js');
    const runtime = new AgentRuntime({
      agent: agentDefinition,
      intent,
      modelAdapter,
      runId: `agent-trial-${scenario.id}-${trial}-${Date.now()}`,
      scenarioId: scenario.id,
      trialId: String(trial),
      isCiEnvironment: false,
      fixtureBaseUrl,
    });

    runResult = await runtime.run();
  } catch (error) {
    const endedAt = new Date().toISOString();
    return {
      trial,
      status: 'error',
      evidence: {
        runResult: null as unknown as AgentRunResult,
        toolSequence: [],
        agentConfigHash,
        scenarioHash,
        providerMode: mode,
      },
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      endedAt,
      durationMs: Date.now() - startMs,
    };
  }

  // Capture after state (best-effort)
  let afterState: Record<string, unknown> | undefined;
  try {
    const resp = await fetch(`${fixtureBaseUrl}/state`);
    if (resp.ok) {
      afterState = await resp.json() as Record<string, unknown>;
    }
  } catch {
    // Non-fixture targets
  }

  // Extract tool sequence from messages
  const toolSequence: Array<{ turn: number; tool: string; success: boolean; durationMs: number }> = [];
  let currentTurn = 0;
  for (const msg of runResult.messages) {
    if (msg.role === 'tool' && msg.toolName) {
      currentTurn = Math.floor(runResult.messages.indexOf(msg) / 2);
      const success = msg.toolResult
        ? (msg.toolResult as Record<string, unknown>).success === true
        : false;
      const durationMs = msg.toolResult
        ? ((msg.toolResult as Record<string, unknown>).durationMs as number) ?? 0
        : 0;
      toolSequence.push({
        turn: currentTurn,
        tool: msg.toolName,
        success,
        durationMs,
      });
    }
  }

  const endedAt = new Date().toISOString();

  return {
    trial,
    status: runResult.status === 'passed' ? 'passed' :
            runResult.status === 'error' ? 'error' :
            runResult.status === 'cancelled' ? 'cancelled' :
            'failed',
    evidence: {
      runResult,
      beforeState,
      afterState,
      toolSequence,
      agentConfigHash,
      scenarioHash,
      providerMode: mode,
    },
    error: runResult.reason,
    startedAt,
    endedAt,
    durationMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute a deterministic hash for a scenario definition. */
function hashScenario(scenario: ScenarioDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify({
      id: scenario.id,
      version: scenario.version,
      title: scenario.title,
      actor: scenario.actor,
      steps: scenario.steps,
      expected: scenario.expected,
      trajectory: scenario.trajectory,
    }))
    .digest('hex')
    .slice(0, 16);
}

/** Build fake tool calls from scenario steps and agent tools. */
function buildFakeToolCalls(
  scenario: ScenarioDefinition,
  agentConfig: AgentActorConfig,
): Array<{ id: string; name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
  let idx = 0;

  // For agent scenarios with a goal but no explicit steps, generate
  // default tool calls based on the agent's allowed tools and trajectory.
  if (scenario.steps.length === 0 && scenario.actor.kind === 'agent' && scenario.agentGoal) {
    // Generate a fixture_read_state call (most common agent action)
    if (agentConfig.tools.includes('fixture_read_state')) {
      calls.push({
        id: `fake-tool-${idx++}`,
        name: 'fixture_read_state',
        arguments: {},
      });
    } else if (agentConfig.tools.includes('http_get')) {
      calls.push({
        id: `fake-tool-${idx++}`,
        name: 'http_get',
        arguments: { url: '/' },
      });
    }
    return calls;
  }

  for (const step of scenario.steps) {
    let toolName: string | null = null;
    const args: Record<string, unknown> = {};

    switch (step.action) {
      case 'goto':
        if (agentConfig.tools.includes('http_get')) {
          toolName = 'http_get';
          args.url = step.url;
        }
        break;
      case 'capture':
        if (agentConfig.tools.includes('fixture_read_state')) {
          toolName = 'fixture_read_state';
        }
        break;
      case 'wait':
        // No tool mapping needed
        break;
      default:
        if (agentConfig.tools.includes('fixture_act')) {
          toolName = 'fixture_act';
          args.tool = step.action;
          args.args = { ...step };
        }
        break;
    }

    if (toolName) {
      calls.push({
        id: `fake-tool-${idx++}`,
        name: toolName,
        arguments: args,
      });
    }
  }

  return calls;
}
