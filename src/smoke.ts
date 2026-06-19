import type { QaPack, SmokeResult, SmokeSummary } from './types.js';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : '';
}

function joinUrl(baseUrl: string, routePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

export async function runPublicSmoke(pack: QaPack): Promise<SmokeResult[]> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!pack.smoke?.publicRoutes?.length) throw new Error(`Pack ${pack.id} has no smoke.publicRoutes.`);

  const results: SmokeResult[] = [];

  for (const route of pack.smoke.publicRoutes) {
    const details: string[] = [];
    let ok = true;
    const url = joinUrl(pack.baseUrl, route.path);

    try {
      const response = await fetch(url, { redirect: 'follow' });
      details.push(`HTTP ${response.status} ${response.url}`);
      if (!response.ok) ok = false;

      const html = await response.text();
      const title = extractTitle(html);
      const text = stripHtml(html);

      if (route.titleIncludes) {
        if (title.toLowerCase().includes(route.titleIncludes.toLowerCase())) {
          details.push(`title includes: ${route.titleIncludes}`);
        } else {
          ok = false;
          details.push(`missing title text: ${route.titleIncludes} (actual: ${title || '[no title]'})`);
        }
      }

      for (const expected of route.textIncludes ?? []) {
        if (text.toLowerCase().includes(expected.toLowerCase())) {
          details.push(`text includes: ${expected}`);
        } else {
          ok = false;
          details.push(`missing text: ${expected}`);
        }
      }
    } catch (error) {
      ok = false;
      details.push(`request failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    results.push({ name: route.path, ok, details });
  }

  return results;
}

export function summarizeSmokeResults(results: SmokeResult[]): SmokeSummary {
  const passed = results.filter((result) => result.ok).length;
  const failed = results.length - passed;
  return {
    ok: failed === 0,
    total: results.length,
    passed,
    failed,
  };
}

export function renderSmokeReport(packName: string, results: SmokeResult[]): string {
  const summary = summarizeSmokeResults(results);
  const lines = [`# ${packName} smoke report`, '', `Summary: ${summary.passed}/${summary.total} passed`, ''];

  for (const result of results) {
    lines.push(`## ${result.ok ? '✅' : '❌'} ${result.name}`);
    lines.push('');
    for (const detail of result.details) lines.push(`- ${detail}`);
    lines.push('');
  }

  return lines.join('\n');
}
