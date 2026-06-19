import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';

type SimpleSmokeResult = { ok: boolean; skipped: boolean; checks: BrowserSmokeCheck[]; artifacts: string[] };
function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck { return { name, ok, details }; }
function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
async function fileExists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
async function text(page: import('playwright').Page): Promise<string> { return page.evaluate(() => document.body.innerText); }
async function writeJson(outputDir: string, artifacts: string[], name: string, data: unknown): Promise<void> { const p = path.join(outputDir, name); await writeFile(p, JSON.stringify(data, null, 2), 'utf8'); artifacts.push(p); }
async function setup(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean }, suffix: string) {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) return { skipped: { ok: true, skipped: true, checks: [check(`${suffix} skipped`, true, ['No --storage-state provided.'])], artifacts: [] } as SimpleSmokeResult };
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) return { skipped: { ok: true, skipped: true, checks: [check(`${suffix} skipped`, true, [`Storage state file not found: ${storageStatePath}`])], artifacts: [] } as SimpleSmokeResult };
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, suffix.toLowerCase().replaceAll(' ', '-'));
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath, acceptDownloads: true });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];
  page.on('console', (m) => consoleEntries.push({ type: m.type(), text: m.text(), location: m.location() }));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), method: r.method(), failure: r.failure()?.errorText ?? null }));
  page.on('response', (r) => { if (r.status() >= 400) badResponses.push({ url: r.url(), status: r.status(), statusText: r.statusText() }); });
  return { browser, context, page, checks, artifacts, outputDir, consoleEntries, failedRequests, badResponses };
}
async function finish(env: any): Promise<SimpleSmokeResult> {
  await writeJson(env.outputDir, env.artifacts, 'console.json', env.consoleEntries);
  await writeJson(env.outputDir, env.artifacts, 'network-failures.json', env.failedRequests);
  await writeJson(env.outputDir, env.artifacts, 'network-4xx-5xx.json', env.badResponses);
  const consoleErrors = env.consoleEntries.filter((e: any) => e.type === 'error');
  const actionable = env.failedRequests.filter((e: any) => e.failure !== 'net::ERR_ABORTED');
  env.checks.push(check('Console errors', consoleErrors.length === 0, [`${consoleErrors.length} console error(s) captured`, consoleErrors[0]?.text ?? 'none']));
  env.checks.push(check('Network failures', actionable.length === 0, [`${actionable.length} non-aborted failed request(s) captured`]));
  env.checks.push(check('HTTP 5xx responses', env.badResponses.filter((e: any) => e.status >= 500).length === 0, [`${env.badResponses.filter((e: any) => e.status >= 500).length} HTTP 5xx response(s) captured`]));
  await env.browser.close();
  return { ok: env.checks.every((c: BrowserSmokeCheck) => c.ok), skipped: false, checks: env.checks, artifacts: env.artifacts };
}

export async function runBillingSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean } = {}): Promise<SimpleSmokeResult> {
  const env = await setup(pack, options, 'Billing smoke'); if ('skipped' in env) return env.skipped as SimpleSmokeResult;
  try {
    await env.page.goto(joinUrl(pack.baseUrl!, '/en/account'), { waitUntil: 'networkidle', timeout: 30_000 });
    const body = await text(env.page);
    env.checks.push(check('Account page opens', !/404|sign in/i.test(body) && body.length > 100, [`url ${env.page.url()}`, `rendered ${body.length} chars`]));
    const shot = path.join(env.outputDir, 'account.png'); await env.page.screenshot({ path: shot, fullPage: true }); env.artifacts.push(shot);
    const billing = env.page.getByRole('button', { name: /billing|manage|subscription|portal|upgrade|pro/i }).first();
    const visible = await billing.isVisible().catch(() => false);
    if (visible) {
      await Promise.all([
        env.page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined),
        billing.click().catch(() => undefined),
      ]);
      await env.page.waitForTimeout(1500);
    }
    const after = await text(env.page).catch(() => '');
    env.checks.push(check('Billing portal graceful', visible || /pro|subscription|billing|account|spark/i.test(after), [visible ? 'billing/subscription control visible' : 'no billing control visible', `url ${env.page.url()}`]));
    return await finish(env);
  } catch (e) { env.checks.push(check('Billing smoke exception', false, [String(e)])); return await finish(env); }
}

export async function runLanguageSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean; language?: string } = {}): Promise<SimpleSmokeResult> {
  const env = await setup(pack, options, `Language ${options.language ?? 'vi'} smoke`); if ('skipped' in env) return env.skipped as SimpleSmokeResult;
  try {
    await env.page.goto(joinUrl(pack.baseUrl!, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const understand = env.page.getByRole('button', { name: /I understand/i }).first();
    if (await understand.isVisible().catch(() => false)) { await understand.click(); await env.page.waitForTimeout(500); }
    const lang = env.page.locator('.ui-locale-menu-trigger, button[aria-label="Change language"]').first();
    const visible = await lang.isVisible().catch(() => false);
    if (visible) { await lang.click({ force: true }).catch(async () => env.page.evaluate(() => (document.querySelector('.ui-locale-menu-trigger, button[aria-label="Change language"]') as HTMLElement | null)?.click())); await env.page.waitForTimeout(500); }
    const body = await text(env.page);
    const target = options.language ?? 'vi';
    const targetVisible = new RegExp(`${target}|Vietnam|Tiếng|Türk|Turkish|TR`, 'i').test(body);
    env.checks.push(check('Language menu opens', visible && body.length > 100, [visible ? 'language button visible/clicked' : 'language button missing']));
    env.checks.push(check('Target language option discoverable', targetVisible, [`target ${target}`, targetVisible ? 'matching language label visible' : 'no matching language label in visible text']));
    const shot = path.join(env.outputDir, 'language-menu.png'); await env.page.screenshot({ path: shot, fullPage: true }); env.artifacts.push(shot);
    return await finish(env);
  } catch (e) { env.checks.push(check('Language smoke exception', false, [String(e)])); return await finish(env); }
}

export async function runWorkshopSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean } = {}): Promise<SimpleSmokeResult> {
  const env = await setup(pack, options, 'Workshop smoke'); if ('skipped' in env) return env.skipped as SimpleSmokeResult;
  try {
    await env.page.goto(joinUrl(pack.baseUrl!, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const body = await text(env.page);
    const hasRoots = /ROOTS|ECHOES|WORKSHOP|Star this|Bring to Solo/i.test(body);
    env.checks.push(check('Roots/Echoes surface visible', hasRoots, [hasRoots ? 'root/echo/workshop text visible' : 'root/echo/workshop text missing']));
    const star = env.page.getByRole('button', { name: /star this/i }).first();
    const starVisible = await star.isVisible().catch(() => false);
    if (starVisible) { await star.click().catch(() => undefined); await env.page.waitForTimeout(1000); }
    const after = await text(env.page);
    env.checks.push(check('Workshop/star interaction graceful', starVisible || /ROOTS|ECHOES|WORKSHOP/i.test(after), [starVisible ? 'star button visible/clicked' : 'star button not visible']));
    const shot = path.join(env.outputDir, 'workshop.png'); await env.page.screenshot({ path: shot, fullPage: true }); env.artifacts.push(shot);
    return await finish(env);
  } catch (e) { env.checks.push(check('Workshop smoke exception', false, [String(e)])); return await finish(env); }
}

export function renderSimpleSmokeReport(packName: string, suiteName: string, result: SimpleSmokeResult): string {
  const passed = result.checks.filter((c) => c.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} ${suiteName} report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
  for (const item of result.checks) { lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`, ''); for (const detail of item.details) lines.push(`- ${detail}`); lines.push(''); }
  if (result.artifacts.length) { lines.push('## Artifacts', ''); for (const artifact of result.artifacts) lines.push(`- ${artifact}`); lines.push(''); }
  return lines.join('\n');
}
