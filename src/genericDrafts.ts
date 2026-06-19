import type { BrowserSmokeCheck } from './types.js';

type GenericDraftInput = {
  packName: string;
  suiteName: string;
  checks: BrowserSmokeCheck[];
  artifacts?: string[];
};

type GenericDraft = {
  slug: string;
  markdown: string;
  yaml: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

export function draftSmokeFailureReports(input: GenericDraftInput): GenericDraft[] {
  return input.checks
    .filter((check) => !check.ok)
    .map((failedCheck) => {
      const slug = `${slugify(input.suiteName)}-${slugify(failedCheck.name)}`;
      const artifactLines = input.artifacts?.length ? input.artifacts.map((artifact) => `- ${artifact}`).join('\n') : '- None captured';
      const detailLines = failedCheck.details.map((detail) => `- ${detail}`).join('\n');

      const markdown = [
        `# QA Draft — ${failedCheck.name}`,
        '',
        '> DRAFT ONLY — Do not submit automatically. Review/edit before DMing or pasting into a QA form.',
        '',
        `Pack: ${input.packName}`,
        `Suite: ${input.suiteName}`,
        `Check: ${failedCheck.name}`,
        '',
        '## Observed failure',
        '',
        detailLines,
        '',
        '## Attachments / artifacts',
        '',
        artifactLines,
        '',
        '## Suggested severity',
        '',
        'Triage manually. Default to Minor unless the failure blocks a core flow, causes data loss, exposes private data, or produces a 5xx/crash.',
        '',
      ].join('\n');

      const yaml = [
        `draft_only: true`,
        `pack: ${yamlQuote(input.packName)}`,
        `suite: ${input.suiteName}`,
        `check: ${yamlQuote(failedCheck.name)}`,
        `details:`,
        ...failedCheck.details.map((detail) => `  - ${yamlQuote(detail)}`),
        `artifacts:`,
        ...(input.artifacts ?? []).map((artifact) => `  - ${yamlQuote(artifact)}`),
        '',
      ].join('\n');

      return { slug, markdown, yaml };
    });
}
