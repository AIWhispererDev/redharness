import type { Finding, QaPack } from './types.js';

function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern, 'gim');
}

export function scanText(pack: QaPack, target: string, text: string): Finding[] {
  const findings: Finding[] = [];

  for (const rule of pack.rules) {
    if (rule.type !== 'text' || rule.target !== target) continue;
    const patterns = rule.patterns ?? (rule.pattern ? [rule.pattern] : []);

    for (const pattern of patterns) {
      const regex = compilePattern(pattern);
      const matches = text.match(regex) ?? [];
      for (const match of matches) {
        findings.push({
          ruleId: rule.id,
          label: rule.label,
          severity: rule.severity,
          issueType: rule.issueType,
          match,
        });
      }
    }
  }

  return findings;
}
