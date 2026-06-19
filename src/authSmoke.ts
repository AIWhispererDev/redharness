import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck } from './types.js';

type AuthSmokeResult = {
  ok: boolean;
  skipped: boolean;
  checks: BrowserSmokeCheck[];
  artifacts: string[];
};

function joinUrl(baseUrl: string, routePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck {
  return { name, ok, details };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function skippedAuthSmokeResult(reason: string): AuthSmokeResult {
  return {
    ok: true,
    skipped: true,
    checks: [check('Authenticated smoke skipped', true, [reason])],
    artifacts: [],
  };
}

export async function runAuthSmoke(options: {
  baseUrl: string;
  storageState?: string;
  outputDir?: string;
  headless?: boolean;
}): Promise<AuthSmokeResult> {
  if (!options.storageState) {
    return skippedAuthSmokeResult('No --storage-state provided. Authenticated checks require a Playwright storage state file.');
  }

  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) {
    return skippedAuthSmokeResult(`Storage state file not found: ${storageStatePath}`);
  }

  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', 'pocket-socrates', 'auth-smoke');
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];

  page.on('console', (message) => {
    consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() });
  });
  page.on('requestfailed', (request) => {
    failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null });
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() });
    }
  });

  try {
    await page.goto(joinUrl(options.baseUrl, '/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const dashboardScreenshot = path.join(outputDir, 'dashboard.png');
    await page.screenshot({ path: dashboardScreenshot, fullPage: true });
    artifacts.push(dashboardScreenshot);

    const url = page.url();
    const bodyText = await page.evaluate(() => document.body.innerText);
    const redirectedToSignIn = /\/sign-in/.test(url);

    checks.push(
      check('Dashboard requires authenticated session', !redirectedToSignIn, [
        redirectedToSignIn ? `redirected to sign-in: ${url}` : `dashboard stayed authenticated: ${url}`,
      ]),
    );

    checks.push(
      check('Dashboard page rendered content', bodyText.trim().length > 0, [
        bodyText.trim().length > 0 ? `rendered ${bodyText.trim().length} chars` : 'empty body text',
      ]),
    );

    const requiredNavLabels = ['POCKET SOC', 'THE CRUCIBLE', 'SOLO', 'PEER', 'JOURNEY', 'DOCUMENT'];
    const missingNavLabels = requiredNavLabels.filter((label) => !bodyText.includes(label));
    checks.push(
      check('Dashboard nav loaded', missingNavLabels.length === 0, [
        missingNavLabels.length === 0
          ? `found: ${requiredNavLabels.join(', ')}`
          : `missing: ${missingNavLabels.join(', ')}`,
      ]),
    );

    const signInMarkers = ['Sign in to Plumb', 'Welcome back! Please sign in to continue', 'Enter your password'];
    const visibleSignInMarkers = signInMarkers.filter((marker) => bodyText.includes(marker));
    checks.push(
      check('No sign-in UI visible', !redirectedToSignIn && visibleSignInMarkers.length === 0, [
        visibleSignInMarkers.length === 0 ? 'sign-in text absent' : `visible sign-in text: ${visibleSignInMarkers.join(', ')}`,
      ]),
    );

    const hasMedicalDisclaimer = bodyText.includes('A note before you begin') && bodyText.includes('I understand');
    checks.push(
      check('Medical disclaimer modal detected or already accepted', true, [
        hasMedicalDisclaimer ? 'medical disclaimer modal visible with I understand button' : 'medical disclaimer not visible; likely already accepted',
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
    checks.push(
      check('Console errors', consoleErrors.length === 0, [
        `${consoleErrors.length} console error(s) captured`,
        consoleErrors.slice(0, 5).map((entry) => entry.text).join('\n') || 'none',
      ]),
    );
    const actionableFailedRequests = failedRequests.filter((entry) => entry.failure !== 'net::ERR_ABORTED');
    checks.push(
      check('Network failures', actionableFailedRequests.length === 0, [
        `${actionableFailedRequests.length} non-aborted failed request(s) captured`,
        failedRequests.length === actionableFailedRequests.length ? 'no aborted requests filtered' : `${failedRequests.length - actionableFailedRequests.length} net::ERR_ABORTED request(s) captured but treated as non-actionable`,
        actionableFailedRequests.slice(0, 5).map((entry) => `${entry.method} ${entry.url}: ${entry.failure}`).join('\n') || 'none',
      ]),
    );
    checks.push(
      check('HTTP 5xx responses', badResponses.filter((entry) => entry.status >= 500).length === 0, [
        `${badResponses.filter((entry) => entry.status >= 500).length} HTTP 5xx response(s) captured`,
        badResponses
          .filter((entry) => entry.status >= 500)
          .slice(0, 5)
          .map((entry) => `${entry.status} ${entry.url}`)
          .join('\n') || 'none',
      ]),
    );

    await browser.close();
  }

  return {
    ok: checks.every((item) => item.ok),
    skipped: false,
    checks,
    artifacts,
  };
}

export function renderAuthSmokeReport(packName: string, result: AuthSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [
    `# ${packName} authenticated smoke report`,
    '',
    `Status: ${status}`,
    `Summary: ${passed}/${result.checks.length} passed`,
    '',
  ];

  for (const item of result.checks) {
    lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`);
    lines.push('');
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
