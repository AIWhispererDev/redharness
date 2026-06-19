export type RunSection = {
  name: string;
  ok: boolean;
  markdown: string;
  artifacts?: string[];
};

export type RunSummaryJson = {
  packName: string;
  ok: boolean;
  generatedAt: string;
  sections: Array<{ name: string; ok: boolean; artifacts: string[] }>;
};

export function buildRunSummaryJson(packName: string, sections: RunSection[], generatedAt = new Date().toISOString()): RunSummaryJson {
  return {
    packName,
    ok: sections.every((section) => section.ok),
    generatedAt,
    sections: sections.map((section) => ({ name: section.name, ok: section.ok, artifacts: section.artifacts ?? [] })),
  };
}

export function renderRunSummary(packName: string, sections: RunSection[]): string {
  const ok = sections.every((section) => section.ok);
  const passed = sections.filter((section) => section.ok).length;
  const lines = [
    `# ${packName} QA run summary`,
    '',
    `Overall: ${ok ? 'passed' : 'failed'}`,
    `Summary: ${passed}/${sections.length} sections passed`,
    '',
    '## Sections',
    '',
  ];

  for (const section of sections) lines.push(`- ${section.ok ? '✅' : '❌'} ${section.name}`);
  lines.push('');

  for (const section of sections) {
    lines.push('---', '', section.markdown, '');
  }

  return lines.join('\n');
}
