import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';
import { writeFindingPacket } from './findingPackets.js';

export type SecuritySeverity = 'info' | 'low' | 'medium' | 'high';
export type SecurityCategory = 'headers' | 'cookies' | 'exposure' | 'auth' | 'cors' | 'bundle';
export type SecurityCheck = BrowserSmokeCheck & { severity?: SecuritySeverity; category?: SecurityCategory };
export type SecuritySmokeResult = { ok: boolean; skipped: boolean; checks: SecurityCheck[]; artifacts: string[] };

function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
function securityCheck(name: string, ok: boolean, details: string[], severity: SecuritySeverity, category: SecurityCategory): SecurityCheck { return { name, ok, details, severity, category }; }
async function saveJson(dir: string, artifacts: string[], name: string, data: unknown) { const p = path.join(dir, name); await writeFile(p, JSON.stringify(data, null, 2), 'utf8'); artifacts.push(p); }

export function securitySeverityRank(severity: SecuritySeverity | undefined): number {
  return { info: 0, low: 1, medium: 2, high: 3 }[severity ?? 'info'];
}

export async function runSecuritySmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean; writeFindings?: boolean } = {}): Promise<SecuritySmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'security-smoke');
  await mkdir(outputDir, { recursive: true });
  const checks: SecurityCheck[] = [];
  const artifacts: string[] = [];
  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    const context = await browser.newContext({ storageState: options.storageState, ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const responses: Array<{ url: string; status: number; headers: Record<string, string> }> = [];
    page.on('response', (response) => responses.push({ url: response.url(), status: response.status(), headers: response.headers() }));
    await page.goto(pack.baseUrl, { waitUntil: 'networkidle', timeout: 30_000 });
    const main = responses.find((r) => r.url.replace(/\/$/, '') === pack.baseUrl!.replace(/\/$/, '')) ?? responses[0];
    const headers = main?.headers ?? {};
    await saveJson(outputDir, artifacts, 'headers.json', headers);

    checks.push(securityCheck('Content-Security-Policy header present', !!headers['content-security-policy'], ['CSP is missing or present based on response headers'], 'medium', 'headers'));
    checks.push(securityCheck('HSTS header present', !!headers['strict-transport-security'], ['Strict-Transport-Security protects HTTPS downgrade on supported browsers'], 'medium', 'headers'));
    checks.push(securityCheck('Frame embedding protection present', !!headers['x-frame-options'] || /frame-ancestors/i.test(headers['content-security-policy'] ?? ''), ['X-Frame-Options or CSP frame-ancestors expected'], 'medium', 'headers'));
    checks.push(securityCheck('Referrer-Policy header present', !!headers['referrer-policy'], ['Referrer-Policy limits referrer leakage'], 'low', 'headers'));
    checks.push(securityCheck('Permissions-Policy header present', !!headers['permissions-policy'], ['Permissions-Policy limits browser features'], 'low', 'headers'));

    const cookieHeaders = Object.entries(headers).filter(([key]) => key.toLowerCase() === 'set-cookie').map(([, value]) => value);
    const cookieText = cookieHeaders.join('\n');
    const sessionCookieObserved = /session|auth|clerk|token/i.test(cookieText);
    checks.push(securityCheck('Session cookies use Secure/SameSite when observable', !sessionCookieObserved || (/secure/i.test(cookieText) && /samesite/i.test(cookieText)), [sessionCookieObserved ? cookieText.slice(0, 300) : 'No session-like Set-Cookie observed on main response'], 'medium', 'cookies'));

    for (const route of ['/.env', '/.git/config']) {
      const res = await page.request.get(joinUrl(pack.baseUrl, route), { timeout: 15_000 });
      const body = await res.text().catch(() => '');
      const exposed = res.status() === 200 && /(DB_|API_KEY|PRIVATE|repositoryformatversion)/i.test(body);
      checks.push(securityCheck(`Sensitive public file not exposed: ${route}`, !exposed, [`status ${res.status()}`, body.slice(0, 120)], 'high', 'exposure'));
    }

    for (const route of ['/robots.txt', '/sitemap.xml']) {
      const res = await page.request.get(joinUrl(pack.baseUrl, route), { timeout: 15_000 });
      checks.push(securityCheck(`Public discovery file reachable/graceful: ${route}`, res.status() < 500, [`status ${res.status()}`], 'info', 'exposure'));
    }

    const fresh = await browser.newContext();
    const freshPage = await fresh.newPage();
    for (const route of ['/en/dashboard', '/en/account']) {
      await freshPage.goto(joinUrl(pack.baseUrl, route), { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => undefined);
      const body = await freshPage.evaluate(() => document.body.innerText).catch(() => '');
      const gated = /sign in|sign up|invite|early access|log in|continue/i.test(body) || !/THE CRUCIBLE|Account settings|DOCUMENT/i.test(body);
      checks.push(securityCheck(`Unauthenticated protected route gated: ${route}`, gated, [`url ${freshPage.url()}`, body.slice(0, 180)], 'high', 'auth'));
    }
    await fresh.close();

    const scripts = await page.locator('script[src]').evaluateAll((nodes) => nodes.map((node) => (node as HTMLScriptElement).src)).catch(() => [] as string[]);
    const secretPatterns = [/sk_live_[A-Za-z0-9]+/, /AKIA[0-9A-Z]{16}/, /-----BEGIN PRIVATE KEY-----/, /OPENAI_API_KEY/, /ANTHROPIC_API_KEY/];
    const bundleFindings: Array<{ url: string; match: string }> = [];
    for (const src of scripts.slice(0, 12)) {
      const res = await page.request.get(src, { timeout: 20_000 }).catch(() => null);
      const js = res ? await res.text().catch(() => '') : '';
      for (const pattern of secretPatterns) {
        const match = js.match(pattern)?.[0];
        if (match) bundleFindings.push({ url: src, match });
      }
      if (src.endsWith('.js')) {
        const sm = await page.request.get(`${src}.map`, { timeout: 10_000 }).catch(() => null);
        if (sm && sm.status() === 200) bundleFindings.push({ url: `${src}.map`, match: 'public sourcemap' });
      }
    }
    await saveJson(outputDir, artifacts, 'bundle-findings.json', bundleFindings);
    checks.push(securityCheck('Public bundles do not expose obvious private secrets', bundleFindings.filter((f) => f.match !== 'public sourcemap').length === 0, bundleFindings.map((f) => `${f.match} at ${f.url}`).slice(0, 5).concat(bundleFindings.length ? [] : ['none']), 'high', 'bundle'));

    if (options.writeFindings) {
      for (const failed of checks.filter((c) => !c.ok && securitySeverityRank(c.severity) >= 2)) {
        const packet = await writeFindingPacket({
          outputDir,
          packName: pack.name,
          finding: {
            title: failed.name,
            severity: failed.severity ?? 'medium',
            type: `Security/${failed.category ?? 'general'}`,
            steps: [`Open ${pack.baseUrl}`, `Run security smoke check: ${failed.name}`],
            expected: 'Security control is present or protected behavior is enforced.',
            actual: failed.details.join('\n'),
            evidence: artifacts,
          },
        });
        artifacts.push(packet.markdownPath, packet.jsonPath, packet.replayPath);
      }
    }
    await context.close();
  } finally {
    await browser.close();
  }
  return { ok: checks.every((c) => c.ok), skipped: false, checks, artifacts };
}

export function renderSecuritySmokeReport(packName: string, result: SecuritySmokeResult): string {
  const passed = result.checks.filter((c) => c.ok).length;
  const findings = result.checks.filter((c) => !c.ok && securitySeverityRank(c.severity) >= 1).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const sorted = [...result.checks].sort((a, b) => securitySeverityRank(b.severity) - securitySeverityRank(a.severity));
  const lines = [`# ${packName} security smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, `Potential security findings: ${findings}`, ''];
  for (const check of sorted) {
    lines.push(`## ${check.ok ? '✅' : '❌'} [${check.severity ?? 'info'}/${check.category ?? 'general'}] ${check.name}`, '');
    for (const detail of check.details) lines.push(`- ${detail}`);
    lines.push('');
  }
  if (result.artifacts.length) {
    lines.push('## Artifacts', '');
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }
  return lines.join('\n');
}
