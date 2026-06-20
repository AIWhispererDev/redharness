/**
 * PRD 04: Tool Registry — discoverable, schema-validated tool definitions.
 *
 * Every tool call passes through the registry for schema validation,
 * capability/risk lookup, and execution. Tools cannot be added at runtime
 * by model output — they must be registered here.
 */

import type { ToolDefinition, ToolHandler, ToolExecutionContext, ToolResult, ToolRiskLevel } from './agentTypes.js';

// ---------------------------------------------------------------------------
// Simple JSON Schema validator (subset for tool argument checking)
// ---------------------------------------------------------------------------

function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const properties = (schema as any).properties as Record<string, { type?: string; required?: string[] }> | undefined;
  const required = (schema as any).required as string[] | undefined;

  if (!properties) return null;

  // Check required fields
  if (required) {
    for (const field of required) {
      if (!(field in args)) {
        return `Missing required field: ${field}`;
      }
    }
  }

  // Type-check each property
  for (const [key, value] of Object.entries(args)) {
    const propSchema = properties[key];
    if (!propSchema) {
      // Unknown field — fail closed in the initial release
      return `Unknown argument: ${key}`;
    }
    const expectedType = propSchema.type;
    if (expectedType && value !== null && value !== undefined) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== expectedType) {
        return `Argument ${key}: expected ${expectedType}, got ${actualType}`;
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool Registry
// ---------------------------------------------------------------------------

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  /** Register a tool definition. Throws on duplicate name. */
  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tool definitions. */
  registerAll(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Get a tool definition by name. */
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  /** Get all registered tool definitions. */
  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Get tool names. */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Validate arguments against a tool's input schema.
   * Returns null if valid, or an error message.
   */
  validateArgs(toolName: string, args: Record<string, unknown>): string | null {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return `Unknown tool: ${toolName}`;
    }
    return validateAgainstSchema(args, tool.inputSchema);
  }

  /**
   * Execute a tool with validated arguments.
   * Does NOT enforce policy — that is the policy engine's job.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        durationMs: 0,
      };
    }

    // Schema validation
    const validationError = this.validateArgs(toolName, args);
    if (validationError) {
      return {
        success: false,
        error: `Argument validation failed: ${validationError}`,
        durationMs: 0,
      };
    }

    // Check abort signal
    if (context.abortSignal.aborted) {
      return {
        success: false,
        error: 'Execution cancelled',
        durationMs: 0,
      };
    }

    // Execute
    const startMs = Date.now();
    try {
      const result = await tool.execute(args, context);
      return {
        ...result,
        durationMs: Date.now() - startMs,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startMs,
      };
    }
  }

  /** Get the risk level for a tool. */
  getRiskLevel(toolName: string): ToolRiskLevel | undefined {
    return this.tools.get(toolName)?.risk;
  }

  /** Check if a tool has a specific capability. */
  hasCapability(toolName: string, capability: string): boolean {
    const tool = this.tools.get(toolName);
    return tool?.capabilities.includes(capability) ?? false;
  }
}

// ---------------------------------------------------------------------------
// Singleton instance — populated during startup
// ---------------------------------------------------------------------------

export const toolRegistry = new ToolRegistry();
