import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, Finding, QaPack } from './types.js';
import { scanText } from './scanner.js';

type ProRegressionSmokeResult = {
  ok: boolean;
  skipped: boolean;
  checks: BrowserSmokeCheck[];
  socResponses: string[];
  styleFindings: Finding[];
  artifacts: string[];
};

function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck {
  return { name, ok, details };
}

function joinUrl(baseUrl: string, routePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function extractLatestSocResponse(bodyText: string): string {
  const socParts = bodyText.split(/\bSOC\b/);
  if (socParts.length < 2) return '';
  return socParts
    .at(-1)!
    .split(/\bYOU\b|START NEW SESSION|ARIADNE’S THREAD|WORKSHOP|↑|↓/)[0]
    .trim();
}

async function visibleText(page: import('playwright').Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

async function writeArtifacts(outputDir: string, artifacts: string[], name: string, data: unknown): Promise<void> {
  const filePath = path.join(outputDir, name);
  await writeFile(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  artifacts.push(filePath);
}

async function captureScreenshot(page: import('playwright').Page, outputDir: string, artifacts: string[], name: string): Promise<void> {
  const filePath = path.join(outputDir, name);
  await page.screenshot({ path: filePath, fullPage: true });
  artifacts.push(filePath);
}

export async function runProRegressionSmoke(
  pack: QaPack,
  options: { storageState?: string; outputDir?: string; headless?: boolean; turns?: number } = {},
): Promise<ProRegressionSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) {
    return { ok: true, skipped: true, checks: [check('Pro regression skipped', true, ['No --storage-state provided.'])], socResponses: [], styleFindings: [], artifacts: [] };
  }
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) {
    return { ok: true, skipped: true, checks: [check('Pro regression skipped', true, [`Storage state file not found: ${storageStatePath}`])], socResponses: [], styleFindings: [], artifacts: [] };
  }

  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'pro-regression-smoke');
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const socResponses: string[] = [];
  let styleFindings: Finding[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];

  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }));
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() });
  });

  try {
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    checks.push(check('Dashboard authenticated', !/\/sign-in/.test(page.url()), [`current URL: ${page.url()}`]));

    const understand = page.getByRole('button', { name: /I understand/i }).first();
    if (await understand.isVisible().catch(() => false)) await understand.click();

    const start = page.getByRole('button', { name: /start new session/i }).first();
    if (await start.isVisible().catch(() => false)) {
      await start.click();
      await page.waitForTimeout(1200);
      checks.push(check('Start new session opens Solo setup', true, ['clicked Start new session']));
    } else {
      checks.push(check('Start new session opens Solo setup', true, ['Start new session not visible; using current session']));
    }

    let body = await visibleText(page);
    const proPaywall = body.includes('Solo sessions are a Pro feature') || body.includes('UPGRADE TO PRO');
    checks.push(check('Solo Pro access', !proPaywall, [proPaywall ? 'Pro paywall is still visible' : 'no Pro paywall visible']));

    const input = page.locator('textarea, [contenteditable="true"]').last();
    const inputVisible = await input.isVisible().catch(() => false);
    checks.push(check('Solo message input visible', inputVisible, [inputVisible ? 'textarea/contenteditable visible' : 'no visible message input']));

    if (!proPaywall && inputVisible) {
      const prompts = [
        'QA regression smoke: ask me one short question about choosing a small project.',
        'I notice I avoid choosing because I worry I will waste time.',
        'What is one sharper question I should answer next?',
      ].slice(0, options.turns ?? 3);

      let firstResponse = '';
      for (const [index, prompt] of prompts.entries()) {
        const before = await visibleText(page);
        await input.fill(prompt).catch(async () => {
          await input.click();
          await page.keyboard.type(prompt);
        });
        const send = page.getByRole('button', { name: /^send$/i }).last();
        if (await send.isVisible().catch(() => false)) await send.click();
        else await page.keyboard.press('Enter');

        await page.waitForFunction((oldText) => document.body.innerText !== oldText && document.body.innerText.includes('SOC'), before, { timeout: 60_000 }).catch(() => undefined);
        await page.waitForTimeout(3000);
        let response = '';
        for (let attempt = 0; attempt < 30; attempt += 1) {
          response = extractLatestSocResponse(await visibleText(page));
          const looksLikeChromeOnly =
            !response ||
            response.includes('THINKING') ||
            response.includes('FRAME') ||
            response.includes('MODE') ||
            response.includes('SEND');
          if (!looksLikeChromeOnly && response.length > 10) break;
          await page.waitForTimeout(2000);
        }
        const validResponse =
          response.length > 10 &&
          !response.includes('THINKING') &&
          !response.includes('FRAME') &&
          !response.includes('MODE') &&
          !response.includes('SEND');
        if (validResponse) socResponses.push(response);
        if (index === 0 && validResponse) firstResponse = response;
        checks.push(check(`Soc response turn ${index + 1}`, validResponse, [validResponse ? `captured ${response.length} chars` : `no valid Soc response captured; last text was ${response.length} chars`]));
      }

      styleFindings = socResponses.flatMap((response) => scanText(pack, 'ai_response', response));
      checks.push(check('Soc response style scan', styleFindings.length === 0, [`${styleFindings.length} style finding(s)`]));

      const textBeforeRefresh = firstResponse || socResponses[0] || '';
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      await page.waitForTimeout(1500);
      const textAfterRefresh = await visibleText(page);
      checks.push(check('Soc replies persist after refresh', !textBeforeRefresh || textAfterRefresh.includes(textBeforeRefresh.slice(0, 60)), [textBeforeRefresh ? 'first response fragment checked after refresh' : 'no first response captured to verify']));
      checks.push(check('No premature SESSION COMPLETE', !textAfterRefresh.includes('SESSION COMPLETE'), [textAfterRefresh.includes('SESSION COMPLETE') ? 'SESSION COMPLETE visible before Landing verification' : 'SESSION COMPLETE not visible']));

      const exportText = textAfterRefresh.includes('No summary to export yet');
      const exportButton = page.getByRole('button', { name: /export/i }).first();
      if (await exportButton.isVisible().catch(() => false)) {
        await exportButton.click().catch(() => undefined);
        await page.waitForTimeout(1000);
      }
      const afterExport = await visibleText(page);
      checks.push(check('Export before completed summary is graceful', exportText || afterExport.includes('No summary to export yet') || !afterExport.includes('generic failure'), ['looked for “No summary to export yet” or absence of generic failure']));
    }

    await captureScreenshot(page, outputDir, artifacts, 'pro-regression.png');
    await writeArtifacts(outputDir, artifacts, 'soc-responses.json', socResponses);
    await writeArtifacts(outputDir, artifacts, 'style-findings.json', styleFindings);
  } finally {
    await writeArtifacts(outputDir, artifacts, 'console.json', consoleEntries);
    await writeArtifacts(outputDir, artifacts, 'network-failures.json', failedRequests);
    await writeArtifacts(outputDir, artifacts, 'network-4xx-5xx.json', badResponses);

    const consoleErrors = consoleEntries.filter((entry) => entry.type === 'error');
    const actionableFailedRequests = failedRequests.filter((entry) => entry.failure !== 'net::ERR_ABORTED');
    checks.push(check('Console errors', consoleErrors.length === 0, [`${consoleErrors.length} console error(s) captured`, consoleErrors[0]?.text ?? 'none']));
    checks.push(check('Network failures', actionableFailedRequests.length === 0, [`${actionableFailedRequests.length} non-aborted failed request(s) captured`]));
    checks.push(check('HTTP 5xx responses', badResponses.filter((entry) => entry.status >= 500).length === 0, [`${badResponses.filter((entry) => entry.status >= 500).length} HTTP 5xx response(s) captured`]));
    await browser.close();
  }

  return { ok: checks.every((item) => item.ok), skipped: false, checks, socResponses, styleFindings, artifacts };
}

export function renderProRegressionSmokeReport(packName: string, result: ProRegressionSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} Pro regression smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
  for (const item of result.checks) {
    lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`, '');
    for (const detail of item.details) lines.push(`- ${detail}`);
    lines.push('');
  }
  if (result.socResponses.length) {
    lines.push('## Captured Soc responses', '');
    result.socResponses.forEach((response, index) => lines.push(`### Turn ${index + 1}`, '', '```text', response, '```', ''));
  }
  if (result.styleFindings.length) {
    lines.push('## Style findings', '');
    for (const finding of result.styleFindings) lines.push(`- [${finding.severity}] ${finding.ruleId}: ${finding.label} (match: ${finding.match})`);
    lines.push('');
  }
  if (result.artifacts.length) {
    lines.push('## Artifacts', '');
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }
  return lines.join('\n');
}
