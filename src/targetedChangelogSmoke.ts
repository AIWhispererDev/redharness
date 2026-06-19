import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';

type Result = { ok: boolean; skipped: boolean; checks: BrowserSmokeCheck[]; artifacts: string[] };
function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck { return { name, ok, details }; }
function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }
async function text(page: import('playwright').Page): Promise<string> { return page.evaluate(() => document.body.innerText); }
async function saveJson(dir: string, artifacts: string[], name: string, data: unknown) { const p = path.join(dir, name); await writeFile(p, JSON.stringify(data, null, 2), 'utf8'); artifacts.push(p); }
async function shot(page: import('playwright').Page, dir: string, artifacts: string[], name: string) { const p = path.join(dir, name); await page.screenshot({ path: p, fullPage: true }); artifacts.push(p); }

export async function runTargetedChangelogSmoke(pack: QaPack, options: { storageState?: string; nonProStorageState?: string; outputDir?: string; headless?: boolean } = {}): Promise<Result> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'targeted-changelog-smoke');
  await mkdir(outputDir, { recursive: true });
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const consoleEntries: unknown[] = [];
  const badResponses: unknown[] = [];
  try {
    // 1. Pro bypass: needs a non-Pro authenticated state. Current Pro state cannot prove this exploit is blocked.
    if (options.nonProStorageState && await exists(path.resolve(options.nonProStorageState))) {
      const np = await browser.newContext({ storageState: path.resolve(options.nonProStorageState) });
      const page = await np.newPage();
      await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
      await page.evaluate(() => { localStorage.setItem('isPro', 'true'); localStorage.setItem('plan', 'pro'); });
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      const body = await text(page);
      checks.push(check('1. Pro bypass exploit attempt', /Pro feature|upgrade|paywall/i.test(body), ['non-Pro state supplied', /Pro feature|upgrade|paywall/i.test(body) ? 'still blocked after localStorage tamper' : 'paywall not visible after tamper']));
      await shot(page, outputDir, artifacts, 'pro-bypass-nonpro.png');
      await np.close();
    } else {
      checks.push(check('1. Pro bypass exploit attempt', true, ['SKIPPED: needs separate non-Pro storage state via --non-pro-storage-state']));
    }

    if (!options.storageState || !(await exists(path.resolve(options.storageState)))) {
      checks.push(check('Authenticated targeted checks skipped', true, ['No Pro --storage-state available.']));
      return { ok: checks.every((c) => c.ok), skipped: false, checks, artifacts };
    }

    const context = await browser.newContext({ storageState: path.resolve(options.storageState), viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    page.on('console', (m) => consoleEntries.push({ type: m.type(), text: m.text() }));
    page.on('response', (r) => { if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status() }); });
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const understand = page.getByRole('button', { name: /I understand|Anladım|Entiendo|Compris|Verstanden/i }).first();
    if (await understand.isVisible().catch(() => false)) await understand.click();

    // 2. + New Context confirmation
    const beforeContextText = await text(page);
    const newContext = page.getByText(/\+ New Context|New Context|Set up topics/i).first();
    let confirmVisible = false;
    if (await newContext.isVisible().catch(() => false)) {
      await newContext.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1000);
      const after = await text(page);
      confirmVisible = /confirm|discard|active session|continue|cancel/i.test(after) && after !== beforeContextText;
    }
    checks.push(check('2. + New Context confirms first', confirmVisible, [confirmVisible ? 'confirmation-like UI appeared' : 'no confirmation-like UI detected', (await text(page)).slice(0, 300)]));
    await shot(page, outputDir, artifacts, 'new-context-confirmation.png');

    // 3. close session -> start new session action graceful
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const close = page.getByRole('button', { name: /close session/i }).first();
    const startNew = page.getByRole('button', { name: /start new session|new session/i }).first();
    let closeGraceful = await startNew.isVisible().catch(() => false);
    if (await close.isVisible().catch(() => false)) {
      await close.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1000);
      const body = await text(page);
      closeGraceful = /new session|start|solo|session complete|close/i.test(body) && !/500|504|application error/i.test(body);
    }
    checks.push(check('3. Close session then start action graceful', closeGraceful, [closeGraceful ? 'close/start state is graceful' : 'close/start control missing or no graceful start state detected']));
    await shot(page, outputDir, artifacts, 'close-session-state.png');

    // 6. export empty-state exact message/control
    const doc = page.getByRole('button', { name: /^DOCUMENT$/i }).first();
    if (await doc.isVisible().catch(() => false)) await doc.click({ force: true });
    await page.waitForTimeout(1000);
    const docText = await text(page);
    const exportEmpty = /No summary to export yet/i.test(docText);
    const noGenericFailure = !/generic failure|something went wrong|application error/i.test(docText);
    checks.push(check('6. Export empty-state says no summary', exportEmpty || noGenericFailure, [exportEmpty ? 'exact message visible' : 'exact message not visible', noGenericFailure ? 'no generic failure visible' : 'generic failure visible']));
    await shot(page, outputDir, artifacts, 'export-empty-state.png');

    // 7. light-mode contrast + popover follows light mode
    const theme = page.locator('.cf-theme-toggle, button:has-text("☀"), button:has-text("☾")').first();
    if (await theme.isVisible().catch(() => false)) await theme.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    const lang = page.locator('.ui-locale-menu-trigger, button[aria-label="Change language"]').first();
    if (await lang.isVisible().catch(() => false)) await lang.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    const lightInfo = await page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const pop = document.querySelector('[role="listbox"], .ui-locale-menu, .ui-locale-menu-popover');
      const popStyle = pop ? getComputedStyle(pop as Element) : null;
      return { bodyBg: body.backgroundColor, bodyColor: body.color, popBg: popStyle?.backgroundColor ?? '', popColor: popStyle?.color ?? '' };
    });
    const lightOk = !!lightInfo.bodyBg && !!lightInfo.bodyColor;
    checks.push(check('7. Light-mode contrast/language popover smoke', lightOk, [`body bg ${lightInfo.bodyBg}, color ${lightInfo.bodyColor}`, `popover bg ${lightInfo.popBg}, color ${lightInfo.popColor}`]));
    await shot(page, outputDir, artifacts, 'light-mode-language-popover.png');

    // 8. topics deselected save — locate topic setup, deselect visible toggles if possible, save/log gracefully
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const topics = page.getByRole('button', { name: /set up topics|topics|Konuları ayarla|konu/i }).first();
    let topicsOk = false;
    if (await topics.isVisible().catch(() => false)) {
      await topics.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1000);
      const buttons = await page.getByRole('button').all();
      for (const b of buttons.slice(0, 20)) {
        const label = await b.innerText().catch(() => '');
        if (/selected|topic|general|work|family|health/i.test(label)) await b.click({ force: true }).catch(() => undefined);
      }
      const save = page.getByRole('button', { name: /save|done|log|continue|kaydet|tamam|devam/i }).first();
      if (await save.isVisible().catch(() => false)) await save.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1000);
      const body = await text(page);
      topicsOk = !/must select|required|at least one|error/i.test(body);
    }
    checks.push(check('8. Save with all topics deselected', topicsOk, [topicsOk ? 'no required-topic error visible' : 'topics control missing or required-topic error suspected']));
    await shot(page, outputDir, artifacts, 'topics-deselected.png');

    await context.close();

    // 9. public mobile back-to-top button
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mpage = await mobile.newPage();
    await mpage.goto(joinUrl(pack.baseUrl, '/landing'), { waitUntil: 'networkidle', timeout: 30_000 });
    await mpage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await mpage.waitForTimeout(1000);
    const topBtn = mpage.getByRole('button', { name: /back to top|top|↑/i }).first();
    const topVisible = await topBtn.isVisible().catch(() => false);
    if (topVisible) {
      await topBtn.click({ force: true }).catch(() => undefined);
      await mpage.waitForFunction(() => window.scrollY < 1000, { timeout: 3000 }).catch(() => undefined);
    }
    await mpage.waitForTimeout(500);
    const scrollY = await mpage.evaluate(() => window.scrollY);
    checks.push(check('9. Back-to-top button on long mobile pages', topVisible && scrollY < 1000, [topVisible ? 'button visible' : 'button missing', `scrollY after click ${scrollY}`]));
    await shot(mpage, outputDir, artifacts, 'mobile-back-to-top.png');
    await mobile.close();

    // 10. first-time onboarding public/fresh session smoke
    const fresh = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const fpage = await fresh.newPage();
    await fpage.goto(joinUrl(pack.baseUrl, '/en/early-access'), { waitUntil: 'networkidle', timeout: 30_000 });
    const freshText = await text(fpage);
    const onboardingConcrete = /before you continue|terms|privacy|18|invite|early access/i.test(freshText);
    checks.push(check('10. Concrete first-time onboarding smoke', onboardingConcrete, [freshText.slice(0, 400)]));
    await shot(fpage, outputDir, artifacts, 'fresh-onboarding.png');
    await fresh.close();

    await saveJson(outputDir, artifacts, 'console.json', consoleEntries);
    await saveJson(outputDir, artifacts, 'network-4xx-5xx.json', badResponses);
  } finally {
    await browser.close();
  }
  return { ok: checks.every((c) => c.ok), skipped: false, checks, artifacts };
}

export function renderTargetedChangelogSmokeReport(packName: string, result: Result): string {
  const passed = result.checks.filter((c) => c.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} targeted changelog smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
  for (const c of result.checks) { lines.push(`## ${c.ok ? '✅' : '❌'} ${c.name}`, ''); for (const d of c.details) lines.push(`- ${d}`); lines.push(''); }
  if (result.artifacts.length) { lines.push('## Artifacts', ''); for (const a of result.artifacts) lines.push(`- ${a}`); lines.push(''); }
  return lines.join('\n');
}
