import path from 'node:path';
import type { BrowserSmokeResult, ReportData } from './types.js';

type DraftReport = {
  slug: string;
  data: ReportData;
  markdown: string;
};

function findArtifact(result: BrowserSmokeResult, namePart: string): string {
  return result.artifacts.find((artifact) => path.basename(artifact).includes(namePart)) ?? '';
}

function renderDraftMarkdown(title: string, data: ReportData): string {
  const lines = [
    `# ${title}`,
    '',
    '> DRAFT ONLY — Do not submit automatically. Review/edit this before DMing or pasting into a QA form.',
    '',
  ];

  for (const [key, value] of Object.entries(data)) {
    lines.push(`**${key}:** ${String(value).trim() || '[fill in]'}`);
    lines.push('');
  }

  return lines.join('\n');
}

export function draftCoreReportsFromBrowserSmoke(result: BrowserSmokeResult): DraftReport[] {
  const drafts: DraftReport[] = [];
  const blankInviteFailure = result.checks.find(
    (check) => check.name === 'Blank invite submit gives visible validation' && !check.ok,
  );

  if (blankInviteFailure) {
    const screenshot = findArtifact(result, 'blank-invite-submit');
    const data: ReportData = {
      'Discord Handle': '',
      Task: '0. TOS Gate',
      Frame: 'N/A',
      Mode: 'N/A',
      Stage: 'N/A',
      Section: 'TOS Gate',
      Component: 'Invite code form',
      'Problem Type': 'Copy/UX',
      Severity: 'Minor',
      'Steps to Reproduce': [
        '1. Open https://pocketsoc.me/early-access in a fresh session.',
        '2. Accept the TOS modal.',
        '3. Leave invite code blank.',
        '4. Click Submit.',
      ].join('\n'),
      'Expected Behavior': 'Submit should be disabled until a code is entered, or a visible validation message should appear.',
      'Actual Behavior': 'The page remains on the invite-code form with no visible explanation after blank submit.',
      'Soc Exact Response': 'N/A',
      'Console Errors': 'None observed by browser-smoke. Re-check manually before submitting.',
      Attachments: screenshot,
    };

    drafts.push({
      slug: 'blank-invite-code-validation',
      data,
      markdown: renderDraftMarkdown('Core QA Draft — Blank invite-code validation', data),
    });
  }

  return drafts;
}
