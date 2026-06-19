import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';

type MobileAuthSmokeResult = { ok: boolean; skipped: boolean; checks: BrowserSmokeCheck[]; artifacts: string[] };
function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck { return { name, ok, details }; }
function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
async function fileExists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
async function writeArtifact(outputDir: string, artifacts: string[], name: string, data: unknown): Promise<void> {
  const filePath = path.join(outputDir, name);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  artifacts.push(filePath);
}

export async function runMobileAuthSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean } = {}): Promise<MobileAuthSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) return { ok: true, skipped: true, checks: [check('Mobile auth skipped', true, ['No --storage-state provided.'])], artifacts: [] };
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) return { ok: true, skipped: true, checks: [check('Mobile auth skipped', true, [`Storage state file not found: ${storageStatePath}`])], artifacts: [] };
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'mobile-auth-smoke');
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath, viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];
  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }));
  page.on('response', (response) => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() }); });
  try {
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const text = await page.evaluate(() => document.body.innerText);
    checks.push(check('Mobile dashboard renders', !/\/sign-in/.test(page.url()) && text.length > 200, [`viewport 390x844`, `rendered ${text.length} chars`, `url ${page.url()}`]));
    const dashboardShot = path.join(outputDir, 'dashboard-mobile.png');
    await page.screenshot({ path: dashboardShot, fullPage: true });
    artifacts.push(dashboardShot);

    const menuButton = page.getByRole('button', { name: /menu|open|close/i }).first();
    const menuVisible = await menuButton.isVisible().catch(() => false);
    if (menuVisible) {
      await menuButton.click({ force: true }).catch(async () => {
        await page.evaluate(() => (document.querySelector('[aria-label="Open menu"], [aria-label="Close menu"]') as HTMLElement | null)?.click());
      });
      await page.waitForTimeout(500);
    }
    const afterMenu = await page.evaluate(() => document.body.innerText);
    checks.push(check('Mobile drawer/menu accessible', menuVisible || afterMenu.includes('THE CRUCIBLE'), [menuVisible ? 'menu button visible/clicked' : 'no menu button visible', afterMenu.includes('THE CRUCIBLE') ? 'Crucible nav text visible' : 'Crucible nav text not visible']));
    const menuShot = path.join(outputDir, 'drawer-mobile.png');
    await page.screenshot({ path: menuShot, fullPage: true });
    artifacts.push(menuShot);

    const inputVisible = await page.locator('textarea, [contenteditable="true"]').last().isVisible().catch(() => false);
    const paywallVisible = afterMenu.includes('Solo sessions are a Pro feature') || afterMenu.includes('UPGRADE TO PRO');
    checks.push(check('Mobile Crucible input or state visible', inputVisible || paywallVisible || afterMenu.includes('The Crucible'), [inputVisible ? 'input visible' : 'input not visible', paywallVisible ? 'paywall visible' : 'paywall not visible']));
  } finally {
    await writeArtifact(outputDir, artifacts, 'console.json', consoleEntries);
    await writeArtifact(outputDir, artifacts, 'network-failures.json', failedRequests);
    await writeArtifact(outputDir, artifacts, 'network-4xx-5xx.json', badResponses);
    const consoleErrors = consoleEntries.filter((entry) => entry.type === 'error');
    const actionableFailedRequests = failedRequests.filter((entry) => entry.failure !== 'net::ERR_ABORTED');
    checks.push(check('Console errors', consoleErrors.length === 0, [`${consoleErrors.length} console error(s) captured`, consoleErrors[0]?.text ?? 'none']));
    checks.push(check('Network failures', actionableFailedRequests.length === 0, [`${actionableFailedRequests.length} non-aborted failed request(s) captured`]));
    checks.push(check('HTTP 5xx responses', badResponses.filter((entry) => entry.status >= 500).length === 0, [`${badResponses.filter((entry) => entry.status >= 500).length} HTTP 5xx response(s) captured`]));
    await browser.close();
  }
  return { ok: checks.every((item) => item.ok), skipped: false, checks, artifacts };
}

export function renderMobileAuthSmokeReport(packName: string, result: MobileAuthSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} mobile authenticated smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
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
