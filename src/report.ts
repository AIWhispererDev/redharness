import type { QaPack, ReportData, ValidationResult } from './types.js';

function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

export function validateReport(pack: QaPack, reportName: string, data: ReportData): ValidationResult {
  const schema = pack.reports[reportName];
  if (!schema) {
    throw new Error(`Unknown report schema: ${reportName}`);
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const field of schema.requiredFields) {
    if (!asText(data[field])) {
      errors.push(`Missing required field: ${field}.`);
    }
  }

  const problemType = asText(data['Problem Type']);
  const aiQualityTypes = schema.aiQualityTypes ?? ['AI Quality', 'Style Violation'];
  if (aiQualityTypes.includes(problemType) && !asText(data['Soc Exact Response'])) {
    errors.push('AI Quality reports require Soc Exact Response.');
  }

  if (!asText(data['Console Errors'])) {
    warnings.push('Console Errors is blank. Write "None observed" if no red errors were seen.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    markdown: renderReport(pack, reportName, data),
  };
}

export function renderReport(pack: QaPack, reportName: string, data: ReportData): string {
  const schema = pack.reports[reportName];
  if (!schema) throw new Error(`Unknown report schema: ${reportName}`);

  const lines: string[] = [`# ${schema.title}`, ''];
  for (const field of schema.requiredFields) {
    lines.push(`**${field}:** ${asText(data[field]) || '[missing]'}`);
    lines.push('');
  }

  const severity = asText(data.Severity) as keyof NonNullable<typeof pack.bounty>;
  if (pack.bounty?.[severity]) {
    lines.push(`Estimated bounty if accepted: ${pack.bounty[severity]}`);
    lines.push('');
    lines.push('Acceptance depends on reproducibility and team triage.');
  }

  return lines.join('\n');
}
