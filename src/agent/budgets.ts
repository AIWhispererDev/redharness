/**
 * PRD 04: Budget tracking and enforcement.
 *
 * Tracks consumption across wall time, turns, messages, tool calls,
 * network requests, tokens, and cost. Budget exhaustion produces
 * `cancelled` with reason `budget-exceeded`, not `failed`.
 */

import type { AgentBudgets, BudgetConsumption, AgentState } from './agentTypes.js';

export type BudgetCheckResult = {
  exceeded: boolean;
  reason?: string;
  category?: string;
  consumed: BudgetConsumption;
  limits: AgentBudgets;
};

/**
 * Budget tracker — monitors resource consumption against limits.
 */
export class BudgetTracker {
  private consumption: BudgetConsumption;
  private limits: AgentBudgets;
  private startedAt: number;
  private toolCallCounters: Map<string, number>;

  constructor(limits: AgentBudgets) {
    this.limits = limits;
    this.startedAt = Date.now();
    this.consumption = {
      wallTimeMs: 0,
      turns: 0,
      messages: 0,
      toolCalls: 0,
      networkRequests: 0,
      perToolCalls: {},
    };
    this.toolCallCounters = new Map();
  }

  /** Record a turn. */
  recordTurn(): void {
    this.consumption.turns++;
  }

  /** Record a message. */
  recordMessage(): void {
    this.consumption.messages++;
  }

  /** Record a tool call, optionally by name for per-tool tracking. */
  recordToolCall(toolName?: string): void {
    this.consumption.toolCalls++;
    if (toolName) {
      const current = this.toolCallCounters.get(toolName) ?? 0;
      this.toolCallCounters.set(toolName, current + 1);
      this.consumption.perToolCalls = Object.fromEntries(this.toolCallCounters);
    }
  }

  /** Record a network request. */
  recordNetworkRequest(): void {
    this.consumption.networkRequests++;
  }

  /** Set token usage (optional). */
  setTokenUsage(input: number, output: number): void {
    this.consumption.tokens = (this.consumption.tokens ?? 0) + input + output;
  }

  /** Set cost (optional). */
  addCost(usd: number): void {
    this.consumption.costUsd = (this.consumption.costUsd ?? 0) + usd;
  }

  /** Get current consumption. */
  getConsumption(): BudgetConsumption {
    return {
      ...this.consumption,
      wallTimeMs: Date.now() - this.startedAt,
    };
  }

  /** Check all budget limits. Returns first exceeded budget or null. */
  check(): BudgetCheckResult {
    const elapsed = Date.now() - this.startedAt;
    const consumed = this.getConsumption();

    // Wall time
    if (elapsed > this.limits.wallTimeMs) {
      return {
        exceeded: true,
        reason: `Wall time exceeded: ${elapsed}ms > ${this.limits.wallTimeMs}ms`,
        category: 'wallTimeMs',
        consumed,
        limits: this.limits,
      };
    }

    // Working time (if set) — not precisely tracked in this initial implementation
    // Turns
    if (consumed.turns >= this.limits.turns) {
      return {
        exceeded: true,
        reason: `Turn limit exceeded: ${consumed.turns} >= ${this.limits.turns}`,
        category: 'turns',
        consumed,
        limits: this.limits,
      };
    }

    // Messages
    if (consumed.messages >= this.limits.messages) {
      return {
        exceeded: true,
        reason: `Message limit exceeded: ${consumed.messages} >= ${this.limits.messages}`,
        category: 'messages',
        consumed,
        limits: this.limits,
      };
    }

    // Tool calls
    if (consumed.toolCalls >= this.limits.toolCalls) {
      return {
        exceeded: true,
        reason: `Tool call limit exceeded: ${consumed.toolCalls} >= ${this.limits.toolCalls}`,
        category: 'toolCalls',
        consumed,
        limits: this.limits,
      };
    }

    // Per-tool calls
    if (this.limits.perToolCalls) {
      for (const [toolName, maxCalls] of Object.entries(this.limits.perToolCalls)) {
        const current = this.toolCallCounters.get(toolName) ?? 0;
        if (current >= maxCalls) {
          return {
            exceeded: true,
            reason: `Per-tool call limit exceeded for "${toolName}": ${current} >= ${maxCalls}`,
            category: `perToolCalls:${toolName}`,
            consumed,
            limits: this.limits,
          };
        }
      }
    }

    // Tokens
    if (this.limits.tokens && (consumed.tokens ?? 0) >= this.limits.tokens) {
      return {
        exceeded: true,
        reason: `Token limit exceeded: ${consumed.tokens} >= ${this.limits.tokens}`,
        category: 'tokens',
        consumed,
        limits: this.limits,
      };
    }

    // Cost
    if (this.limits.costUsd && (consumed.costUsd ?? 0) >= this.limits.costUsd) {
      return {
        exceeded: true,
        reason: `Cost limit exceeded: $${consumed.costUsd} >= $${this.limits.costUsd}`,
        category: 'costUsd',
        consumed,
        limits: this.limits,
      };
    }

    // Network requests
    if (consumed.networkRequests >= this.limits.networkRequests) {
      return {
        exceeded: true,
        reason: `Network request limit exceeded: ${consumed.networkRequests} >= ${this.limits.networkRequests}`,
        category: 'networkRequests',
        consumed,
        limits: this.limits,
      };
    }

    return { exceeded: false, consumed, limits: this.limits };
  }

  /** Reset the tracker (for checkpoint resume). */
  reset(consumption: BudgetConsumption): void {
    this.consumption = { ...consumption };
    this.startedAt = Date.now() - consumption.wallTimeMs;
    this.toolCallCounters = new Map(
      Object.entries(consumption.perToolCalls ?? {}),
    );
  }
}
