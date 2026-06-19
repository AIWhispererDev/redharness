import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type FindingPacketInput = {
  outputDir: string;
  packName: string;
  finding: {
    title: string;
    severity: string;
    type: string;
    steps: string[];
    expected: string;
    actual: string;
    evidence: string[];
  };
};

export type FindingPacket = {
  dir: string;
  markdownPath: string;
  jsonPath: string;
  replayPath: string;
};

export function slugifyFinding(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'finding';
}

export async function writeFindingPacket(input: FindingPacketInput): Promise<FindingPacket> {
  const slug = slugifyFinding(input.finding.title);
  const dir = path.join(input.outputDir, 'findings', slug);
  await mkdir(dir, { recursive: true });
  const markdownPath = path.join(dir, 'finding.md');
  const jsonPath = path.join(dir, 'finding.json');
  const replayPath = path.join(dir, 'replay.pw.ts');

  const md = [
    '# DRAFT ONLY — Review before submitting',
    '',
    `## ${input.finding.title}`,
    '',
    `- App: ${input.packName}`,
    `- Severity: ${input.finding.severity}`,
    `- Type: ${input.finding.type}`,
    '',
    '## Steps to Reproduce',
    '',
    ...input.finding.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Expected',
    '',
    input.finding.expected,
    '',
    '## Actual',
    '',
    input.finding.actual,
    '',
    '## Evidence',
    '',
    ...input.finding.evidence.map((item) => `- ${item}`),
    '',
  ].join('\n');

  const replay = `import { test, expect } from '@playwright/test';\n\ntest('${input.finding.title.replace(/'/g, "\\'")}', async ({ page }) => {\n  // TODO: replay the exact finding steps from finding.json.\n  expect(true).toBe(true);\n});\n`;

  await writeFile(markdownPath, md, 'utf8');
  await writeFile(jsonPath, JSON.stringify({ packName: input.packName, ...input.finding }, null, 2), 'utf8');
  await writeFile(replayPath, replay, 'utf8');
  return { dir, markdownPath, jsonPath, replayPath };
}
