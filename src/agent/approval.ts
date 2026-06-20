/**
 * PRD 04: Approval engine — policy-mediated tool call authorization.
 *
 * Every tool call passes through:
 *   model proposal -> schema validation -> capability/risk lookup
 *   -> intent/scope validation -> budget check -> approval policy
 *   -> execution -> postcondition and trace
 */

import { createHash, randomBytes } from 'node:crypto';
import type {
  ApprovalPolicy,
  ApprovalRequest,
  AgentPolicy,
  IntentCapsule,
  ToolDefinition,
  ToolRiskLevel,
} from './agentTypes.js';
import type { ApprovalBinding } from './runStateStore.js';
import type { ToolRegistry } from './toolRegistry.js';
import { validateActionAgainstIntent } from './intent.js';
import type { JsonValue } from '../trace/traceTypes.js';

export type ApprovalDecision = {
  allowed: boolean;
  policy: ApprovalPolicy;
  reason: string;
  requiresHuman?: boolean;
  approvalRequest?: ApprovalRequest;
};

export type ApprovalEngineOptions = {
  registry: ToolRegistry;
  policy: AgentPolicy;
};

/**
 * Approval engine evaluates tool call requests against policy.
 */
export class ApprovalEngine {
  private registry: ToolRegistry;
  private policy: AgentPolicy;

  constructor(options: ApprovalEngineOptions) {
    this.registry = options.registry;
    this.policy = options.policy;
  }

  /**
   * Evaluate whether a tool call should be allowed.
   * This is the main policy check pipeline.
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    intent: IntentCapsule,
    isCiEnvironment: boolean = false,
  ): ApprovalDecision {
    // 1. Unknown tool check
    const toolDef = this.registry.get(toolName);
    if (!toolDef) {
      return {
        allowed: false,
        policy: 'deny',
        reason: `Unknown tool: ${toolName}. Available: ${this.registry.getNames().join(', ')}`,
      };
    }

    // 2. Prohibited action check (from policy)
    const prohibitedMatch = this.policy.prohibitedActions.some(
      (p) => toolName.toLowerCase().includes(p.toLowerCase()),
    );
    if (prohibitedMatch) {
      return {
        allowed: false,
        policy: 'deny',
        reason: `Tool "${toolName}" matches prohibited action in policy`,
      };
    }

    // 3. Intent validation
    const targetOrigin = this.extractTargetOrigin(args);
    const intentResult = validateActionAgainstIntent(
      intent,
      toolName,
      args,
      targetOrigin,
    );
    if (!intentResult.allowed) {
      return {
        allowed: false,
        policy: 'deny',
        reason: `Intent validation failed: ${intentResult.reason}`,
      };
    }

    // 4. Risk level and approval policy resolution
    const risk = toolDef.risk;
    const toolPolicy = this.policy.toolPolicies.find((tp) => tp.toolName === toolName);
    const effectivePolicy: ApprovalPolicy = toolPolicy?.approval ?? this.policy.defaultToolApproval;

    if (
      targetOrigin &&
      this.policy.allowedOrigins.length > 0 &&
      !this.policy.allowedOrigins.includes(targetOrigin)
    ) {
      return {
        allowed: false,
        policy: 'deny',
        reason: `Origin "${targetOrigin}" is outside the agent policy allowlist`,
      };
    }

    if (
      this.policy.requireHumanForStateChanges &&
      risk !== 'read' &&
      effectivePolicy !== 'deny'
    ) {
      if (isCiEnvironment) {
        return {
          allowed: false,
          policy: 'deny',
          reason: `CI environment: state-changing tool "${toolName}" requires human approval`,
          requiresHuman: true,
        };
      }
      return {
        allowed: false,
        policy: 'require-human',
        reason: `State-changing tool "${toolName}" requires human approval`,
        requiresHuman: true,
        approvalRequest: this.createApprovalRequest(toolName, args, risk),
      };
    }

    // 5. Evaluate the resolved policy
    switch (effectivePolicy) {
      case 'deny':
        return {
          allowed: false,
          policy: 'deny',
          reason: `Tool "${toolName}" is denied by policy`,
        };

      case 'auto':
        // Auto-approve only for 'read' tools in initial release
        if (risk === 'high-impact') {
          return {
            allowed: false,
            policy: 'require-human',
            reason: `High-impact tool "${toolName}" cannot be auto-approved in the initial release`,
            requiresHuman: true,
          };
        }
        return {
          allowed: true,
          policy: 'auto',
          reason: `Auto-approved (risk: ${risk})`,
        };

      case 'require-human':
        if (isCiEnvironment) {
          return {
            allowed: false,
            policy: 'deny',
            reason: `CI environment: human-required tool "${toolName}" is denied`,
            requiresHuman: true,
          };
        }
        return {
          allowed: false,
          policy: 'require-human',
          reason: `Tool "${toolName}" requires human approval`,
          requiresHuman: true,
          approvalRequest: this.createApprovalRequest(toolName, args, risk),
        };

      case 'require-dry-run':
        return {
          allowed: false,
          policy: 'require-dry-run',
          reason: `Tool "${toolName}" requires a dry run first`,
          requiresHuman: true,
        };

      case 'escalate':
        return {
          allowed: false,
          policy: 'escalate',
          reason: `Tool "${toolName}" escalated for review`,
          requiresHuman: true,
        };
    }
  }

  private extractTargetOrigin(args: Record<string, unknown>): string | undefined {
    for (const key of ['url', 'origin', 'targetUrl']) {
      const value = args[key];
      if (typeof value !== 'string') continue;
      try {
        return new URL(value).origin;
      } catch {
        // Relative URLs are evaluated by the tool against its already-approved
        // base origin.
      }
    }
    return undefined;
  }

  /** Check if a tool is high-impact. */
  isHighImpact(toolName: string): boolean {
    const toolDef = this.registry.get(toolName);
    return toolDef?.risk === 'high-impact';
  }

  /** Create an approval request record. */
  private createApprovalRequest(
    toolName: string,
    args: Record<string, unknown>,
    risk: ToolRiskLevel,
  ): ApprovalRequest {
    const id = `apr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      id,
      toolName,
      arguments: args,
      intendedAction: `Execute ${toolName} with ${Object.keys(args).length} arguments`,
      risk,
      requestedAt: new Date().toISOString(),
    };
  }

  /**
   * Create an approval binding with hashed arguments, expiration, and nonce.
   * This is the durable version used by the control plane.
   */
  createApprovalBinding(
    toolName: string,
    args: Record<string, unknown>,
    risk: ToolRiskLevel,
    runId: string,
    expiresInMs: number = 300_000,
  ): ApprovalBinding {
    const id = `apb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const argumentsHash = createHash('sha256')
      .update(JSON.stringify(args, Object.keys(args).sort()))
      .digest('hex');
    return {
      id,
      runId,
      toolName,
      argumentsHash,
      arguments: args,
      risk,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      nonce: randomBytes(16).toString('hex'),
    };
  }

  /** Resolve a pending approval request. */
  resolveApproval(
    request: ApprovalRequest,
    decision: 'allowed' | 'denied' | 'escalated',
    decidedBy: 'policy' | 'human' | 'ai',
    reason?: string,
  ): ApprovalRequest {
    return {
      ...request,
      decidedAt: new Date().toISOString(),
      decision,
      decidedBy,
      reason,
    };
  }
}
