import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';

type PublicNavSmokeResult = {
  ok: boolean;
  checks: BrowserSmokeCheck[];
  artifacts: string[];
};

function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck {
  return { name, ok, details };
}

function joinUrl(baseUrl: string, routePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

async function clickAndCheck(page: import('playwright').Page, name: string, label: string | RegExp, expected: RegExp): Promise<BrowserSmokeCheck> {
  const before = page.url();
  await page.getByRole('link', { name: label }).first().click();
  await page.waitForTimeout(1000);
  const after = page.url();
  const ok = expected.test(after);
  return check(name, ok, [`before: ${before}`, `after: ${after}`, ok ? `matched ${expected}` : `did not match ${expected}`]);
}

export async function runPublicNavSmoke(
  pack: QaPack,
  options: { outputDir?: string; headless?: boolean } = {},
): Promise<PublicNavSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'public-nav-smoke');
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];

  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }));
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() });
  });

  try {
    await page.goto(joinUrl(pack.baseUrl, '/landing'), { waitUntil: 'networkidle', timeout: 30_000 });
    checks.push(await clickAndCheck(page, 'Landing Architecture nav', 'Architecture', /\/privacy-architecture$/));

    await page.goto(joinUrl(pack.baseUrl, '/how-it-works'), { waitUntil: 'networkidle', timeout: 30_000 });
    checks.push(await clickAndCheck(page, 'How It Works Pricing nav', 'Pricing', /\/landing#pricing$/));

    await page.goto(joinUrl(pack.baseUrl, '/privacy-architecture'), { waitUntil: 'networkidle', timeout: 30_000 });
    checks.push(await clickAndCheck(page, 'Architecture Privacy nav', 'Privacy', /\/landing#privacy$/));

    await page.goto(joinUrl(pack.baseUrl, '/terms'), { waitUntil: 'networkidle', timeout: 30_000 });
    checks.push(await clickAndCheck(page, 'Terms How It Works nav', 'How It Works', /\/how-it-works$/));

    await page.goto(joinUrl(pack.baseUrl, '/landing'), { waitUntil: 'networkidle', timeout: 30_000 });
    checks.push(await clickAndCheck(page, 'Launch App nav', 'Launch the App', /\/early-access$/));

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(joinUrl(pack.baseUrl, '/landing'), { waitUntil: 'networkidle', timeout: 30_000 });
    const toggle = page.getByRole('button', { name: /toggle menu/i }).first();
    await toggle.click();
    await page.waitForTimeout(500);
    const mobileText = await page.evaluate(() => document.body.innerText);
    const requiredMobileLinks = ['Your Guide', 'Privacy', 'Pricing', 'How It Works', 'Architecture', 'Launch the App'];
    const missingMobile = requiredMobileLinks.filter((label) => !mobileText.includes(label));
    const mobileScreenshot = path.join(outputDir, 'mobile-menu.png');
    await page.screenshot({ path: mobileScreenshot, fullPage: true });
    artifacts.push(mobileScreenshot);
    checks.push(
      check('Mobile hamburger opens', missingMobile.length === 0, [
        missingMobile.length === 0 ? `found: ${requiredMobileLinks.join(', ')}` : `missing: ${missingMobile.join(', ')}`,
      ]),
    );
  } finally {
    const consolePath = path.join(outputDir, 'console.json');
    const networkFailuresPath = path.join(outputDir, 'network-failures.json');
    const networkBadResponsesPath = path.join(outputDir, 'network-4xx-5xx.json');
    await writeFile(consolePath, JSON.stringify(consoleEntries, null, 2), 'utf8');
    await writeFile(networkFailuresPath, JSON.stringify(failedRequests, null, 2), 'utf8');
    await writeFile(networkBadResponsesPath, JSON.stringify(badResponses, null, 2), 'utf8');
    artifacts.push(consolePath, networkFailuresPath, networkBadResponsesPath);

    const consoleErrors = consoleEntries.filter((entry) => entry.type === 'error');
    const actionableFailedRequests = failedRequests.filter((entry) => entry.failure !== 'net::ERR_ABORTED');
    checks.push(check('Console errors', consoleErrors.length === 0, [`${consoleErrors.length} console error(s) captured`, consoleErrors[0]?.text ?? 'none']));
    checks.push(check('Network failures', actionableFailedRequests.length === 0, [`${actionableFailedRequests.length} non-aborted failed request(s) captured`]));
    checks.push(check('HTTP 5xx responses', badResponses.filter((entry) => entry.status >= 500).length === 0, [`${badResponses.filter((entry) => entry.status >= 500).length} HTTP 5xx response(s) captured`]));
    await browser.close();
  }

  return { ok: checks.every((item) => item.ok), checks, artifacts };
}

export function renderPublicNavSmokeReport(packName: string, result: PublicNavSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} public nav smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
  for (const item of result.checks) {
    lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`, '');
    for (const detail of item.details) lines.push(`- ${detail}`);
    lines.push('');
  }
  if (result.artifacts.length) {
    lines.push('## Artifacts', '');
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }
  return lines.join('\n');
}
