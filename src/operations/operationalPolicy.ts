/**
 * PRD 10: Operational policy configuration — defines the same selection and
 * target policies enforced by service and MCP adapters.
 *
 * Both CLI and MCP use these schemas to validate pack, profile, suite, tag,
 * output root, and network target constraints before any run is accepted.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// MCP allowlist schemas
// ---------------------------------------------------------------------------

/**
 * MCP allowlist: restricts which packs, profiles, suites, tags, output roots,
 * and network targets the MCP server accepts.
 *
 * When a field is omitted or empty, the corresponding dimension is unrestricted.
 * When set, only matching values are permitted.
 */
export const mcpAllowlistSchema = z.object({
  /** Allowed pack IDs (e.g. ["fixture-web", "fixture-agent"]). */
  packs: z.array(z.string()).optional(),
  /** Allowed profile names (e.g. ["smoke", "release"]). */
  profiles: z.array(z.string()).optional(),
  /** Allowed suite IDs (e.g. ["public-routes", "health-check"]). */
  suites: z.array(z.string()).optional(),
  /** Allowed tag values (e.g. ["smoke", "fixture-release"]). */
  tags: z.array(z.string()).optional(),
  /** Allowed output root directories (absolute or relative to cwd). */
  outputRoots: z.array(z.string()).optional(),
  /** Allowed network target origins (e.g. ["http://127.0.0.1:*"]). */
  networkTargets: z.array(z.string()).optional(),
});

export type McpAllowlist = z.infer<typeof mcpAllowlistSchema>;

// ---------------------------------------------------------------------------
// Operational policy schema
// ---------------------------------------------------------------------------

export const operationalPolicySchema = z.object({
  /** MCP-specific allowlist constraints. */
  mcp: mcpAllowlistSchema.optional(),
  /** Whether run operations (start, cancel) are allowed in MCP. */
  allowMcpRunOperations: z.boolean().default(false),
  /** Whether approval operations are enabled in MCP. */
  allowMcpApprovals: z.boolean().default(false),
  /** Whether CLI scheduled runs are enabled. */
  allowScheduledRuns: z.boolean().default(true),
  /** Max concurrent workers for scheduled runs. */
  maxScheduledWorkers: z.number().int().min(1).max(10).default(3),
  /** Default OTel endpoint for trace export. */
  otelEndpoint: z.string().url().optional(),
  /** OTel export timeout in milliseconds. */
  otelExportTimeoutMs: z.number().int().min(1000).max(30000).default(5000),
  /** OTel fail-silently mode — export errors are logged, not raised. */
  otelFailSilently: z.boolean().default(true),
  /** Attribute keys whose values are redacted from OTel export. */
  otelRedactedKeys: z.array(z.string()).default([
    'storageState',
    'nonProStorageState',
    'auth.token',
    'authorization',
    'cookie',
    'apiKey',
    'api_key',
    'password',
    'secret',
    'token',
    'sessionId',
  ]),
  /** Default retention policy in days. */
  retentionDays: z.number().int().min(1).max(365).default(90),
  /** Retention dry-run mode — if true, retention never deletes. */
  retentionDryRun: z.boolean().default(true),
  /** Whether token passthrough is allowed (requires additional auth). */
  allowMcpTokenPassthrough: z.boolean().default(false),
});

export type OperationalPolicy = z.infer<typeof operationalPolicySchema>;

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

export const DEFAULT_OPERATIONAL_POLICY: OperationalPolicy = {
  allowMcpRunOperations: false,
  allowMcpApprovals: false,
  allowScheduledRuns: true,
  maxScheduledWorkers: 3,
  otelFailSilently: true,
  otelExportTimeoutMs: 5000,
  otelRedactedKeys: [
    'storageState',
    'nonProStorageState',
    'auth.token',
    'authorization',
    'cookie',
    'apiKey',
    'api_key',
    'password',
    'secret',
    'token',
    'sessionId',
  ],
  retentionDays: 90,
  retentionDryRun: true,
  allowMcpTokenPassthrough: false,
};

// ---------------------------------------------------------------------------
// Policy validation
// ---------------------------------------------------------------------------

export type PolicyValidationResult = {
  allowed: boolean;
  reason?: string;
};

/**
 * Check whether an MCP tool invocation is allowed by the operational policy.
 */
export function checkMcpToolPolicy(
  toolName: string,
  params: Record<string, unknown>,
  policy: OperationalPolicy,
): PolicyValidationResult {
  // Run operations
  if (toolName === 'qa_start_run' || toolName === 'qa_cancel_run') {
    if (!policy.allowMcpRunOperations) {
      return { allowed: false, reason: 'Run operations are disabled by operational policy' };
    }
  }

  // Approval operations
  if (toolName === 'qa_approve_agent_tool' || toolName === 'qa_deny_agent_tool') {
    if (!policy.allowMcpApprovals) {
      return { allowed: false, reason: 'Approval operations are disabled by operational policy' };
    }
  }

  // Token passthrough
  if (params.token !== undefined && !policy.allowMcpTokenPassthrough) {
    return { allowed: false, reason: 'Token passthrough is disabled by operational policy' };
  }

  return { allowed: true };
}

/**
 * Check a pack/profile/suite selection against the MCP allowlist.
 */
export function checkSelectionPolicy(
  packId: string,
  profile: string | undefined,
  suites: string[],
  tags: string[],
  allowlist: McpAllowlist | undefined,
): PolicyValidationResult {
  if (!allowlist) return { allowed: true };

  // Pack check
  if (allowlist.packs && allowlist.packs.length > 0) {
    if (!allowlist.packs.includes(packId)) {
      return { allowed: false, reason: `Pack "${packId}" is not in the allowed packs list` };
    }
  }

  // Profile check
  if (profile && allowlist.profiles && allowlist.profiles.length > 0) {
    if (!allowlist.profiles.includes(profile)) {
      return { allowed: false, reason: `Profile "${profile}" is not in the allowed profiles list` };
    }
  }

  // Suite check
  if (suites.length > 0 && allowlist.suites && allowlist.suites.length > 0) {
    const disallowed = suites.filter((s) => !allowlist.suites!.includes(s));
    if (disallowed.length > 0) {
      return { allowed: false, reason: `Suites not in allowed list: ${disallowed.join(', ')}` };
    }
  }

  // Tag check
  if (tags.length > 0 && allowlist.tags && allowlist.tags.length > 0) {
    const disallowed = tags.filter((t) => !allowlist.tags!.includes(t));
    if (disallowed.length > 0) {
      return { allowed: false, reason: `Tags not in allowed list: ${disallowed.join(', ')}` };
    }
  }

  return { allowed: true };
}

/**
 * Check a network target against the MCP network target allowlist.
 */
export function checkNetworkTargetPolicy(
  targetUrl: string,
  allowlist: McpAllowlist | undefined,
): PolicyValidationResult {
  if (!allowlist?.networkTargets || allowlist.networkTargets.length === 0) {
    return { allowed: true };
  }

  try {
    const parsed = new URL(targetUrl);
    const origin = parsed.origin;

    for (const allowed of allowlist.networkTargets) {
      // Support wildcard port patterns like "http://127.0.0.1:*"
      if (allowed.endsWith(':*')) {
        const prefix = allowed.slice(0, -2);
        if (origin.startsWith(prefix)) {
          return { allowed: true };
        }
      } else if (origin === allowed || targetUrl.startsWith(allowed)) {
        return { allowed: true };
      }
    }

    return { allowed: false, reason: `Network target "${targetUrl}" is not in the allowed targets list` };
  } catch {
    return { allowed: false, reason: `Invalid network target URL: "${targetUrl}"` };
  }
}

/**
 * Check an output root path against the MCP output roots allowlist.
 */
export function checkOutputRootPolicy(
  outputPath: string,
  allowlist: McpAllowlist | undefined,
): PolicyValidationResult {
  if (!allowlist?.outputRoots || allowlist.outputRoots.length === 0) {
    return { allowed: true };
  }

  const resolved = outputPath.replace(/\\/g, '/');

  for (const root of allowlist.outputRoots) {
    const normalizedRoot = root.replace(/\\/g, '/');
    if (resolved === normalizedRoot || resolved.startsWith(normalizedRoot + '/') || resolved.startsWith(normalizedRoot + '\\')) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: `Output path "${outputPath}" is not in the allowed output roots list` };
}

/**
 * Redact sensitive attributes from an OTel export payload.
 * Returns a copy with redacted values; original is not mutated.
 */
export function redactOtelAttributes(
  attributes: Record<string, unknown>,
  redactedKeys: string[],
): Record<string, unknown> {
  const redacted = { ...attributes };
  const lowerKeys = redactedKeys.map((k) => k.toLowerCase());

  for (const key of Object.keys(redacted)) {
    if (lowerKeys.some((rk) => key.toLowerCase().includes(rk))) {
      redacted[key] = '[REDACTED]';
    }
  }

  return redacted;
}
