import type { RedactionEntry } from './traceTypes.js';

/**
 * Redaction rules for trace data.
 *
 * Each rule produces a RedactionEntry with the field path and rule ID.
 * The original value is never stored.
 */

export type RedactionRule = {
  id: string;
  /** JSON Path style pattern to match against attribute keys. */
  pattern: string | RegExp;
  /** Optional test to confirm before redacting. */
  test?: (value: unknown) => boolean;
};

/** Default redaction rules for sensitive data. */
const DEFAULT_RULES: RedactionRule[] = [
  { id: 'cookie-header', pattern: /^headers?\..*cookie/i, test: (v) => typeof v === 'string' },
  { id: 'authorization-header', pattern: /^headers?\..*authorization/i, test: (v) => typeof v === 'string' },
  { id: 'set-cookie-header', pattern: /^headers?\..*set-cookie/i, test: (v) => typeof v === 'string' },
  { id: 'x-api-key', pattern: /x-api-key/i, test: (v) => typeof v === 'string' },
  { id: 'api-key-value', pattern: /api[_-]?key|token|secret|password|auth_token|credential|session|jwt|bearer/i, test: (v) => typeof v === 'string' },
  { id: 'storage-state', pattern: /storage.?state/i },
  { id: 'invite-code', pattern: /invite.?code/i, test: (v) => typeof v === 'string' },
  // Leaf-key rules for deep-object redaction (match on field name alone)
  { id: 'deep-authorization', pattern: /^(auth.?token|authorization|token|jwt)$/i, test: (v) => typeof v === 'string' },
  { id: 'deep-password', pattern: /^(password|passwd|secret|api.?key)$/i, test: (v) => typeof v === 'string' },
];

/** Redact sensitive values from a flat key-value record. */
export function redactAttributes(
  attributes: Record<string, unknown>,
  rules: RedactionRule[] = DEFAULT_RULES,
): { attributes: Record<string, unknown>; redactions: RedactionEntry[] } {
  const redactions: RedactionEntry[] = [];

  for (const [key, value] of Object.entries(attributes)) {
    for (const rule of rules) {
      const matches = typeof rule.pattern === 'string'
        ? key.toLowerCase().includes(rule.pattern.toLowerCase())
        : rule.pattern.test(key);

      if (matches) {
        if (rule.test && !rule.test(value)) continue;
        redactions.push({ fieldPath: key, ruleId: rule.id });
        attributes[key] = '[REDACTED]';
        break;
      }
    }
  }

  return { attributes, redactions };
}

/** Redact values in a nested object by walking all string leaves. */
export function redactDeep(
  obj: unknown,
  rules: RedactionRule[] = DEFAULT_RULES,
  path = '',
): { result: unknown; redactions: RedactionEntry[] } {
  const redactions: RedactionEntry[] = [];

  function walk(value: unknown, currentPath: string): unknown {
    if (typeof value === 'string') {
      for (const rule of rules) {
        // For deep paths, match against both the full path and the leaf key
        const leafKey = currentPath.split('.').pop() ?? currentPath;
        const matches = typeof rule.pattern === 'string'
          ? leafKey.toLowerCase().includes(rule.pattern.toLowerCase()) || currentPath.toLowerCase().includes(rule.pattern.toLowerCase())
          : rule.pattern.test(leafKey) || rule.pattern.test(currentPath);
        if (matches) {
          if (rule.test && !rule.test(value)) continue;
          redactions.push({ fieldPath: currentPath, ruleId: rule.id });
          return '[REDACTED]';
        }
      }
      return value;
    }

    if (value !== null && typeof value === 'object') {
      if (Array.isArray(value)) {
        return value.map((item, i) => walk(item, `${currentPath}[${i}]`));
      }
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        result[k] = walk(v, currentPath ? `${currentPath}.${k}` : k);
      }
      return result;
    }

    return value;
  }

  return { result: walk(obj, path), redactions };
}
