/**
 * PRD 04: Intent Capsule — immutable goal envelope validation.
 *
 * Every tool call is validated against the declared intent. Actions that
 * do not map to the declared goal or allowed scope are denied as "goal drift."
 */

import type { IntentCapsule } from './agentTypes.js';

export type IntentValidationResult = {
  allowed: boolean;
  reason?: string;
  /** If drift is detected, the severity of the drift. */
  driftSeverity?: 'none' | 'minor' | 'major' | 'critical';
};

/**
 * Validate a proposed action against the intent capsule.
 */
export function validateActionAgainstIntent(
  intent: IntentCapsule,
  actionName: string,
  actionArgs: Record<string, unknown>,
  targetOrigin?: string,
): IntentValidationResult {
  // Check expiration
  const expiresAt = new Date(intent.expiresAt).getTime();
  if (Date.now() > expiresAt) {
    return { allowed: false, reason: 'Intent capsule has expired', driftSeverity: 'critical' };
  }

  // Check if action is explicitly prohibited
  if (intent.prohibitedActions.some((p) => actionName.toLowerCase().includes(p.toLowerCase()))) {
    return {
      allowed: false,
      reason: `Action "${actionName}" is in the prohibited list for this goal`,
      driftSeverity: 'critical',
    };
  }

  // Check if action is allowed
  if (intent.allowedActions.length > 0) {
    const isExplicitlyAllowed = intent.allowedActions.some(
      (a) => actionName.toLowerCase().startsWith(a.toLowerCase()),
    );
    if (!isExplicitlyAllowed) {
      return {
        allowed: false,
        reason: `Action "${actionName}" is not in the allowed list for this goal`,
        driftSeverity: 'major',
      };
    }
  }

  // Check target origin
  if (targetOrigin && intent.allowedOrigins.length > 0) {
    const isOriginAllowed = intent.allowedOrigins.some(
      (o) => targetOrigin === o || targetOrigin.startsWith(o),
    );
    if (!isOriginAllowed) {
      return {
        allowed: false,
        reason: `Origin "${targetOrigin}" is not in the allowed origins for this goal`,
        driftSeverity: 'major',
      };
    }
  }

  return { allowed: true, driftSeverity: 'none' };
}

/**
 * Create a standard intent capsule for exploratory QA.
 */
export function createExploratoryQaIntent(params: {
  goalId?: string;
  userGoal: string;
  baseUrl: string;
  allowedTools?: string[];
  expiresInMs?: number;
}): IntentCapsule {
  return {
    goalId: params.goalId ?? `qa-${Date.now()}`,
    userGoal: params.userGoal,
    allowedActions: params.allowedTools ?? [
      'browser_observe', 'browser_navigate', 'browser_click',
      'browser_fill', 'browser_screenshot', 'http_get',
      'http_head', 'http_options', 'artifact_read',
      'artifact_write', 'scenario_query', 'submit_finding',
    ],
    prohibitedActions: [
      'shell', 'exec', 'eval', 'delete', 'rm', 'payment',
      'charge', 'refund', 'send_message', 'create_account',
      'delete_account', 'modify_permissions',
    ],
    allowedOrigins: [new URL(params.baseUrl).origin],
    dataBoundary: 'run-directory',
    expiresAt: new Date(Date.now() + (params.expiresInMs ?? 300_000)).toISOString(),
  };
}
