import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';

type ChaosResult = { ok: boolean; skipped: boolean; checks: BrowserSmokeCheck[]; artifacts: string[] };
function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck { return { name, ok, details }; }
function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }
async function txt(page: import('playwright').Page): Promise<string> { return page.evaluate(() => document.body.innerText); }
async function saveJson(dir: string, artifacts: string[], name: string, data: unknown) { const p = path.join(dir, name); await writeFile(p, JSON.stringify(data, null, 2), 'utf8'); artifacts.push(p); }
async function shot(page: import('playwright').Page, dir: string, artifacts: string[], name: string) { const p = path.join(dir, name); await page.screenshot({ path: p, fullPage: true }); artifacts.push(p); }

export function classifyChaosFinding(check: BrowserSmokeCheck): 'pass' | 'potential-bug' {
  return check.ok ? 'pass' : 'potential-bug';
}

async function dismissMedical(page: import('playwright').Page) {
  const btn = page.getByRole('button', { name: /I understand|Anladım|Entiendo|Compris|Verstanden/i }).first();
  if (await btn.isVisible().catch(() => false)) await btn.click({ force: true }).catch(() => undefined);
}

export async function runChaosSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean } = {}): Promise<ChaosResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState || !(await exists(path.resolve(options.storageState)))) {
    return { ok: true, skipped: true, checks: [check('Chaos smoke skipped', true, ['No valid --storage-state provided'])], artifacts: [] };
  }
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'chaos-smoke');
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: path.resolve(options.storageState), viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];
  page.on('console', (m) => consoleEntries.push({ type: m.type(), text: m.text() }));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText ?? null }));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status(), statusText: r.statusText() }); });

  try {
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    await dismissMedical(page);

    // Probe 1: empty + double send should have disabled state or visible validation, not silent no-op.
    const input = page.locator('textarea, [contenteditable="true"]').last();
    const send = page.getByRole('button', { name: /^send$|^gönder$/i }).last();
    let emptyValidation = false;
    if (await input.isVisible().catch(() => false)) {
      await input.fill('').catch(() => undefined);
      const disabled = await send.isDisabled().catch(() => false);
      await send.click({ force: true }).catch(() => undefined);
      await send.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(800);
      const body = await txt(page);
      emptyValidation = disabled || /enter|type|message|required|empty|boş|gerekli/i.test(body);
    }
    checks.push(check('Double send empty prompt has visible guard', emptyValidation, [emptyValidation ? 'disabled or validation visible' : 'no disabled state/validation found after double empty send']));
    await shot(page, outputDir, artifacts, 'empty-double-send.png');

    // Probe 2: refresh while Soc is generating should not lose app state or crash.
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    await dismissMedical(page);
    const input2 = page.locator('textarea, [contenteditable="true"]').last();
    if (await input2.isVisible().catch(() => false)) {
      await input2.fill('Chaos QA: answer slowly with one concise question about choosing under uncertainty.');
      const send2 = page.getByRole('button', { name: /^send$|^gönder$/i }).last();
      if (await send2.isVisible().catch(() => false)) await send2.click({ force: true });
      await page.waitForTimeout(1000);
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
    }
    const afterRefresh = await txt(page);
    checks.push(check('Refresh while generating remains stable', !/500|504|application error|something went wrong/i.test(afterRefresh) && afterRefresh.length > 200, [`rendered ${afterRefresh.length} chars after refresh`]));
    await shot(page, outputDir, artifacts, 'refresh-while-generating.png');

    // Probe 3: rapid tab switching should not crash/blank screen.
    const tabs = [/^SOLO$/i, /PEER|AKRAN/i, /JOURNEY|YOLCULUK/i, /DOCUMENT|BELGE/i, /^SOLO$/i];
    for (const t of tabs) {
      const tab = page.getByRole('button', { name: t }).first();
      if (await tab.isVisible().catch(() => false)) { await tab.click({ force: true }).catch(() => undefined); await page.waitForTimeout(250); }
    }
    const afterTabs = await txt(page);
    checks.push(check('Rapid tab switching stable', !/500|504|application error|something went wrong/i.test(afterTabs) && afterTabs.length > 100, [`rendered ${afterTabs.length} chars after rapid tabs`]));
    await shot(page, outputDir, artifacts, 'rapid-tabs.png');

    // Probe 4: language/theme chaos should not hide text or crash.
    const theme = page.locator('.cf-theme-toggle, button:has-text("☀"), button:has-text("☾")').first();
    const lang = page.locator('.ui-locale-menu-trigger, button[aria-label="Change language"]').first();
    for (let i = 0; i < 3; i += 1) {
      if (await theme.isVisible().catch(() => false)) await theme.click({ force: true }).catch(() => undefined);
      if (await lang.isVisible().catch(() => false)) { await lang.click({ force: true }).catch(() => undefined); await page.keyboard.press('Escape').catch(() => undefined); }
    }
    const styleState = await page.evaluate(() => { const s = getComputedStyle(document.body); return { bg: s.backgroundColor, color: s.color, text: document.body.innerText.length }; });
    checks.push(check('Theme/language toggle chaos keeps text visible', styleState.text > 100 && !!styleState.bg && !!styleState.color, [`bg ${styleState.bg}`, `color ${styleState.color}`, `text chars ${styleState.text}`]));
    await shot(page, outputDir, artifacts, 'theme-language-chaos.png');

    // Probe 5: long/special-character prompt should not immediately crash if input is available.
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    await dismissMedical(page);
    const input3 = page.locator('textarea, [contenteditable="true"]').last();
    let specialOk = true;
    if (await input3.isVisible().catch(() => false)) {
      const payload = 'Chaos QA: Vietnamese tiếng Việt + Turkish ğ ş ı ç + emoji 🧪. '.repeat(20);
      await input3.fill(payload).catch(async () => { await input3.click(); await page.keyboard.type(payload.slice(0, 500)); });
      const send3 = page.getByRole('button', { name: /^send$|^gönder$/i }).last();
      if (await send3.isVisible().catch(() => false)) await send3.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(2000);
      const body = await txt(page);
      specialOk = !/500|504|application error|something went wrong/i.test(body);
    }
    checks.push(check('Long multilingual prompt does not immediate-crash', specialOk, [specialOk ? 'no immediate crash text visible' : 'crash text visible']));
    await shot(page, outputDir, artifacts, 'long-multilingual-prompt.png');

    await saveJson(outputDir, artifacts, 'console.json', consoleEntries);
    await saveJson(outputDir, artifacts, 'network-failures.json', failedRequests);
    await saveJson(outputDir, artifacts, 'network-4xx-5xx.json', badResponses);
    const consoleErrors = consoleEntries.filter((e) => e.type === 'error');
    const actionableFailures = failedRequests.filter((e) => e.failure !== 'net::ERR_ABORTED');
    checks.push(check('Console errors during chaos', consoleErrors.length === 0, [`${consoleErrors.length} console error(s)`, consoleErrors[0]?.text ?? 'none']));
    checks.push(check('Network failures during chaos', actionableFailures.length === 0, [`${actionableFailures.length} non-aborted failed request(s)`]));
    checks.push(check('HTTP 5xx during chaos', badResponses.filter((e) => e.status >= 500).length === 0, [`${badResponses.filter((e) => e.status >= 500).length} HTTP 5xx response(s)`]));
  } finally {
    await context.close();
    await browser.close();
  }

  return { ok: checks.every((c) => c.ok), skipped: false, checks, artifacts };
}

export function renderChaosSmokeReport(packName: string, result: ChaosResult): string {
  const passed = result.checks.filter((c) => c.ok).length;
  const findings = result.checks.filter((c) => classifyChaosFinding(c) === 'potential-bug').length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} chaos smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, `Potential findings: ${findings}`, ''];
  for (const c of result.checks) { lines.push(`## ${c.ok ? '✅' : '❌'} ${c.name}`, ''); for (const d of c.details) lines.push(`- ${d}`); lines.push(''); }
  if (result.artifacts.length) { lines.push('## Artifacts', ''); for (const a of result.artifacts) lines.push(`- ${a}`); lines.push(''); }
  return lines.join('\n');
}
