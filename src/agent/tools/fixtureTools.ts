/**
 * Governed fixture tools: read/mutate fixture state for approved test environments.
 *
 * Rules:
 * - Fixture tools are only available in fixture/test profiles
 * - State mutation requires explicit policy approval
 * - State reads are always allowed
 * - Reset is a high-impact action
 */

import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../agentTypes.js';

export const fixtureReadStateTool: ToolDefinition = {
  name: 'fixture_read_state',
  version: '1.0.0',
  description: 'Read the current fixture application state',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  risk: 'read',
  capabilities: ['fixture'],
  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    // The baseUrl must be set in the agent config or tool context
    const baseUrl = (context as any).fixtureBaseUrl as string | undefined;
    if (!baseUrl) {
      return { success: false, error: 'No fixture baseUrl configured', durationMs: 0 };
    }

    try {
      const resp = await fetch(`${baseUrl}/state`);
      const state = await resp.json();
      return {
        success: true,
        output: state,
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to read fixture state: ${message}`, durationMs: 0 };
    }
  },
};

export const fixtureActTool: ToolDefinition = {
  name: 'fixture_act',
  version: '1.0.0',
  description: 'Execute an action against a fixture agent app',
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'Tool name to execute on the agent fixture' },
      args: { type: 'object', description: 'Arguments for the tool' },
    },
    required: ['tool'],
  },
  risk: 'write',
  capabilities: ['fixture', 'mutation'],
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const baseUrl = (context as any).fixtureBaseUrl as string | undefined;
    if (!baseUrl) {
      return { success: false, error: 'No fixture baseUrl configured', durationMs: 0 };
    }

    try {
      const resp = await fetch(`${baseUrl}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: args.tool as string,
          args: (args.args as Record<string, unknown>) ?? {},
        }),
      });

      const result = await resp.json();
      return {
        success: resp.ok,
        output: result,
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Fixture action failed: ${message}`, durationMs: 0 };
    }
  },
};

export const fixtureResetTool: ToolDefinition = {
  name: 'fixture_reset',
  version: '1.0.0',
  description: 'Reset the fixture application to its initial state',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  risk: 'high-impact',
  capabilities: ['fixture', 'mutation'],
  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const baseUrl = (context as any).fixtureBaseUrl as string | undefined;
    if (!baseUrl) {
      return { success: false, error: 'No fixture baseUrl configured', durationMs: 0 };
    }

    try {
      await fetch(`${baseUrl}/reset`, { method: 'POST' });
      return {
        success: true,
        output: { status: 'reset' },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Fixture reset failed: ${message}`, durationMs: 0 };
    }
  },
};
