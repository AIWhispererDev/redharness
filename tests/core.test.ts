import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPackFromDir } from '../src/pack.js';
import { scanText } from '../src/scanner.js';
import { validateReport } from '../src/report.js';

const packDir = fileURLToPath(new URL('../packs/pocket-socrates', import.meta.url));

describe('pack loading', () => {
  it('loads the Pocket Socrates pack manifest and exposes reports/rules/tracks', async () => {
    const pack = await loadPackFromDir(packDir);

    expect(pack.id).toBe('pocket-socrates');
    expect(pack.tracks.basics.tasks.map((task) => task.mapsTo)).toContain('0. TOS Gate');
    expect(pack.reports.core.requiredFields).toContain('Soc Exact Response');
    expect(pack.rules.map((rule) => rule.id)).toContain('no-em-dash');
  });
});

describe('text scanning', () => {
  it('flags Pocket Socrates style violations in an AI response', async () => {
    const pack = await loadPackFromDir(packDir);
    const findings = scanText(pack, 'ai_response', "That's significant — the pattern you're describing sounds like **avoidance**.");

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: 'no-em-dash', severity: 'Major' }),
        expect.objectContaining({ ruleId: 'no-validation-openers', severity: 'Major' }),
        expect.objectContaining({ ruleId: 'no-markdown-formatting', severity: 'Major' }),
      ]),
    );
  });
});

describe('report validation', () => {
  it('requires Soc Exact Response for AI Quality reports', async () => {
    const pack = await loadPackFromDir(packDir);
    const result = validateReport(pack, 'core', {
      'Discord Handle': '@tester',
      Task: '7. Style Violations',
      Frame: 'Jungian Psychology',
      Mode: 'Guided',
      Stage: 'Root',
      Section: 'Crucible',
      Component: 'Soc Response',
      'Problem Type': 'AI Quality',
      Severity: 'Major',
      'Steps to Reproduce': 'Reach Root and send a real prompt.',
      'Expected Behavior': 'Soc asks a question without style violations.',
      'Actual Behavior': 'Soc used a banned opener.',
      'Console Errors': 'None observed.',
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('AI Quality reports require Soc Exact Response.');
  });

  it('renders a Notion-ready markdown report when valid', async () => {
    const pack = await loadPackFromDir(packDir);
    const result = validateReport(pack, 'core', {
      'Discord Handle': '@tester',
      Task: '7. Style Violations',
      Frame: 'Jungian Psychology',
      Mode: 'Guided',
      Stage: 'Root',
      Section: 'Crucible',
      Component: 'Soc Response',
      'Problem Type': 'Style Violation',
      Severity: 'Major',
      'Steps to Reproduce': 'Reach Root and send a real prompt.',
      'Expected Behavior': 'Soc asks a question without style violations.',
      'Actual Behavior': 'Soc used a banned opener and em dash.',
      'Soc Exact Response': "That's significant — the pattern you're describing sounds like...",
      'Console Errors': 'None observed.',
    });

    expect(result.ok).toBe(true);
    expect(result.markdown).toContain('# Core QA Feedback');
    expect(result.markdown).toContain('**Task:** 7. Style Violations');
    expect(result.markdown).toContain('Estimated bounty if accepted: $15');
  });
});
