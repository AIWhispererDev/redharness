import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, Finding, QaPack } from './types.js';
import { scanText } from './scanner.js';

type CrucibleSmokeResult = {
  ok: boolean;
  skipped: boolean;
  checks: BrowserSmokeCheck[];
  socResponse: string;
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

export function summarizeStyleFindings(findings: Finding[]): { ok: boolean; count: number; detail: string } {
  if (findings.length === 0) return { ok: true, count: 0, detail: '0 style finding(s)' };
  return {
    ok: false,
    count: findings.length,
    detail: `${findings.length} style finding(s): ${[...new Set(findings.map((item) => item.ruleId))].join(', ')}`,
  };
}

export async function runCrucibleSmoke(
  pack: QaPack,
  options: { storageState?: string; outputDir?: string; headless?: boolean; prompt?: string } = {},
): Promise<CrucibleSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) {
    return {
      ok: true,
      skipped: true,
      checks: [check('Crucible smoke skipped', true, ['No --storage-state provided.'])],
      socResponse: '',
      styleFindings: [],
      artifacts: [],
    };
  }
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) {
    return {
      ok: true,
      skipped: true,
      checks: [check('Crucible smoke skipped', true, [`Storage state file not found: ${storageStatePath}`])],
      socResponse: '',
      styleFindings: [],
      artifacts: [],
    };
  }

  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'crucible-smoke');
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];
  let socResponse = '';
  let styleFindings: Finding[] = [];

  page.on('console', (message) => {
    consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() });
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() });
  });

  try {
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const bodyText = await page.evaluate(() => document.body.innerText);
    checks.push(check('Dashboard authenticated', !/\/sign-in/.test(page.url()), [`current URL: ${page.url()}`]));
    checks.push(check('Crucible visible', bodyText.includes('THE CRUCIBLE') && bodyText.includes('The Crucible'), ['Crucible labels found']));

    const understand = page.getByRole('button', { name: /I understand/i }).first();
    if (await understand.isVisible().catch(() => false)) {
      await understand.click();
      await page.waitForTimeout(500);
      checks.push(check('Medical disclaimer accepted', true, ['Clicked I understand']));
    } else {
      checks.push(check('Medical disclaimer accepted', true, ['No disclaimer visible']));
    }

    const beforeSocTexts = await page.evaluate(() => {
      const text = document.body.innerText;
      const parts = text.split(/\bSOC\b/);
      return parts.length;
    });

    const prompt = options.prompt ?? 'QA smoke test: ask me one short question about planning a small project.';
    let inputLocator = page.locator('textarea, input[type="text"], [contenteditable="true"]').filter({ hasNotText: 'e.g. Career shift' }).last();
    let inputVisible = await inputLocator.isVisible().catch(() => false);
    if (!inputVisible) {
      const startNewSession = page.getByRole('button', { name: /start new session/i }).first();
      if (await startNewSession.isVisible().catch(() => false)) {
        await startNewSession.click();
        await page.waitForTimeout(1000);
        checks.push(check('Started new Crucible session setup', true, ['Clicked Start new session because no active input was visible']));
      }
      inputLocator = page.locator('textarea, [contenteditable="true"]').last();
      inputVisible = await inputLocator.isVisible().catch(() => false);
    }

    const currentText = await page.evaluate(() => document.body.innerText);
    const proPaywallVisible = currentText.includes('Solo sessions are a Pro feature');
    checks.push(
      check('Crucible input usable or Pro paywall shown', inputVisible || proPaywallVisible, [
        inputVisible ? 'Crucible textarea/contenteditable visible' : 'no visible Crucible input',
        proPaywallVisible ? 'Pro paywall visible for solo sessions' : 'no Pro paywall visible',
      ]),
    );

    if (proPaywallVisible) {
      checks.push(check('Solo Pro paywall blocks non-Pro session', true, ['Solo sessions are blocked behind Pro as expected for this account']));
    }

    if (inputVisible && !proPaywallVisible) {
      await inputLocator.fill(prompt).catch(async () => {
        await inputLocator.click();
        await page.keyboard.type(prompt);
      });
      await page.keyboard.press('Enter');
      checks.push(check('Submitted smoke prompt', true, [prompt]));

      await page.waitForFunction(
        (initialCount) => document.body.innerText.split(/\bSOC\b/).length > Number(initialCount),
        beforeSocTexts,
        { timeout: 45_000 },
      ).catch(() => undefined);

      await page.waitForTimeout(2000);
      socResponse = await page.evaluate(() => {
        const text = document.body.innerText;
        const parts = text.split(/\bSOC\b/).map((part) => part.trim()).filter(Boolean);
        return parts.at(-1)?.split('YOU')[0]?.trim() ?? '';
      });
      checks.push(check('Soc response captured', socResponse.length > 0, [socResponse ? `captured ${socResponse.length} chars` : 'no Soc response text captured']));

      styleFindings = socResponse ? scanText(pack, 'ai_response', socResponse) : [];
      const styleSummary = summarizeStyleFindings(styleFindings);
      checks.push(check('Soc response style scan', styleSummary.ok, [styleSummary.detail]));
    }

    const screenshotPath = path.join(outputDir, 'crucible.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    artifacts.push(screenshotPath);

    const responsePath = path.join(outputDir, 'soc-response.txt');
    await writeFile(responsePath, socResponse, 'utf8');
    artifacts.push(responsePath);

    const findingsPath = path.join(outputDir, 'style-findings.json');
    await writeFile(findingsPath, JSON.stringify(styleFindings, null, 2), 'utf8');
    artifacts.push(findingsPath);
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

  return {
    ok: checks.every((item) => item.ok),
    skipped: false,
    checks,
    socResponse,
    styleFindings,
    artifacts,
  };
}

export function renderCrucibleSmokeReport(packName: string, result: CrucibleSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} Crucible smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];

  for (const item of result.checks) {
    lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`, '');
    for (const detail of item.details) lines.push(`- ${detail}`);
    lines.push('');
  }

  if (result.socResponse) {
    lines.push('## Captured Soc response', '', '```text', result.socResponse, '```', '');
  }

  if (result.styleFindings.length) {
    lines.push('## Style findings', '');
    for (const finding of result.styleFindings) {
      lines.push(`- [${finding.severity}] ${finding.ruleId}: ${finding.label} (match: ${finding.match})`);
    }
    lines.push('');
  }

  if (result.artifacts.length) {
    lines.push('## Artifacts', '');
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }

  return lines.join('\n');
}
