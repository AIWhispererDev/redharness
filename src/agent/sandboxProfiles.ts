/**
 * Feature 02: Sandbox profiles for browser tools.
 *
 * Defines which tool capabilities are allowed per profile.
 * Profiles are checked by the approval engine during policy evaluation.
 */

import type { SandboxProfile } from './agentTypes.js';

/**
 * Registry of sandbox profiles and their capability allowlists.
 */
const sandboxCapabilities: Record<SandboxProfile, string[]> = {
  'browser-readonly': [
    'browser',
    'browser-readonly',
    'network',
  ],
  'browser-safe-write': [
    'browser',
    'browser-readonly',
    'browser-safe-write',
    'mutation',
  ],
  'http-readonly': [
    'http',
    'network',
  ],
  'repo-readonly': [
    'repo',
    'repo-readonly',
  ],
  'container': [
    'http',
    'network',
    'browser',
    'browser-readonly',
    'browser-safe-write',
    'mutation',
    'fixture',
    'repo',
  ],
};

/**
 * Actions that are always forbidden regardless of profile.
 */
export const FORBIDDEN_PROTOCOL_SCHEMES = ['javascript:', 'file:', 'data:'];

/**
 * Check whether a tool capability is allowed by a sandbox profile.
 */
export function isCapabilityAllowedByProfile(
  capability: string,
  profile: SandboxProfile | SandboxProfile[],
): boolean {
  const profiles = Array.isArray(profile) ? profile : [profile];
  return profiles.some((p) => {
    const allowed = sandboxCapabilities[p];
    return allowed?.includes(capability) ?? false;
  });
}

/**
 * Check whether a tool is allowed by a sandbox profile.
 * A tool is allowed if ALL its capabilities are allowed by the profile.
 */
export function isToolAllowedByProfile(
  toolCapabilities: string[],
  profile: SandboxProfile | SandboxProfile[],
): boolean {
  if (toolCapabilities.length === 0) {
    // Tools with no capabilities are not subject to sandbox restrictions
    return true;
  }

  return toolCapabilities.every((cap) => isCapabilityAllowedByProfile(cap, profile));
}

/**
 * Get the effective sandbox profiles for a given profile name.
 * Browser profiles are mutually exclusive; if both are set, safe-write wins.
 */
export function resolveSandboxProfile(profile: SandboxProfile): SandboxProfile[] {
  switch (profile) {
    case 'browser-readonly':
      return ['browser-readonly'];
    case 'browser-safe-write':
      return ['browser-safe-write'];
    case 'http-readonly':
      return ['http-readonly'];
    case 'repo-readonly':
      return ['repo-readonly'];
    case 'container':
      return ['container'];
    default:
      return [profile];
  }
}

/**
 * Determine if an action is a mutation (write).
 */
export function isMutationAction(toolName: string): boolean {
  const mutationTools = [
    'browser_click',
    'browser_fill',
    'browser_press',
    'fixture_act',
    'fixture_reset',
    'http_post',
  ];
  return mutationTools.includes(toolName);
}
