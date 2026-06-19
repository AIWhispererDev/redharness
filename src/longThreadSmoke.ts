import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';
import { extractLatestSocResponse } from './proRegressionSmoke.js';

type StageSnapshot = { stage: string; exchanges: number | null };
type LongThreadTurn = { index: number; prompt: string; response: string; responseMs: number; stage: string; exchanges: number | null };
type LongThreadSmokeResult = {
  ok: boolean;
  skipped: boolean;
  checks: BrowserSmokeCheck[];
  turns: LongThreadTurn[];
  artifacts: string[];
};

function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck {
  return { name, ok, details };
}
function joinUrl(baseUrl: string, routePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}
async function fileExists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}
async function bodyText(page: import('playwright').Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}
async function writeArtifact(outputDir: string, artifacts: string[], name: string, data: unknown): Promise<void> {
  const filePath = path.join(outputDir, name);
  await writeFile(filePath, typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf8');
  artifacts.push(filePath);
}

export function extractStageSnapshot(text: string): StageSnapshot {
  const stage = ['SURFACE', 'BENEATH', 'ROOT', 'LANDING'].find((candidate) => text.includes(candidate)) ?? 'UNKNOWN';
  const exchangeMatch = text.match(/(\d+)\s+EXCHANGES?/i);
  return { stage, exchanges: exchangeMatch ? Number(exchangeMatch[1]) : null };
}

async function waitForValidSocResponse(page: import('playwright').Page, previousText: string): Promise<string> {
  await page.waitForFunction((oldText) => document.body.innerText !== oldText && document.body.innerText.includes('SOC'), previousText, { timeout: 75_000 }).catch(() => undefined);
  let response = '';
  for (let attempt = 0; attempt < 45; attempt += 1) {
    response = extractLatestSocResponse(await bodyText(page));
    const chromeOnly = !response || response.includes('THINKING') || response.includes('FRAME') || response.includes('MODE') || response.includes('SEND');
    if (!chromeOnly && response.length > 10) return response;
    await page.waitForTimeout(2000);
  }
  return '';
}

export async function runLongThreadSmoke(
  pack: QaPack,
  options: { storageState?: string; outputDir?: string; headless?: boolean; turns?: number; refreshEvery?: number } = {},
): Promise<LongThreadSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) return { ok: true, skipped: true, checks: [check('Long-thread smoke skipped', true, ['No --storage-state provided.'])], turns: [], artifacts: [] };
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) return { ok: true, skipped: true, checks: [check('Long-thread smoke skipped', true, [`Storage state file not found: ${storageStatePath}`])], turns: [], artifacts: [] };

  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'long-thread-smoke');
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const turns: LongThreadTurn[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];
  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }));
  page.on('response', (response) => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() }); });

  try {
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const understand = page.getByRole('button', { name: /I understand/i }).first();
    if (await understand.isVisible().catch(() => false)) await understand.click();
    const start = page.getByRole('button', { name: /start new session/i }).first();
    if (await start.isVisible().catch(() => false)) { await start.click(); await page.waitForTimeout(1000); }
    const initialText = await bodyText(page);
    checks.push(check('Solo Pro access', !initialText.includes('Solo sessions are a Pro feature') && !initialText.includes('UPGRADE TO PRO'), ['Pro paywall not visible']));

    const prompts = [
      'QA long-thread test. I feel stuck choosing a small project. Ask one precise question.',
      'I keep switching ideas because I worry the first choice will be wrong.',
      'The fear is wasting time and looking foolish.',
      'I usually respond by researching more instead of deciding.',
      'A smaller decision would be choosing one project for seven days.',
      'The resistance is that seven days still feels like commitment.',
      'Maybe I want certainty before action.',
      'Certainty is impossible, but I still chase it.',
      'If I acted without certainty, I would need to tolerate anxiety.',
      'The concrete next step might be defining a tiny scope.',
      'I can build one landing page and one customer interview script.',
      'Summarize the core tension in one question.',
    ].slice(0, options.turns ?? 12);

    for (const [index, prompt] of prompts.entries()) {
      const input = page.locator('textarea, [contenteditable="true"]').last();
      const visible = await input.isVisible().catch(() => false);
      if (!visible) { checks.push(check(`Turn ${index + 1} input visible`, false, ['message input not visible'])); break; }
      const before = await bodyText(page);
      const started = Date.now();
      await input.fill(prompt).catch(async () => { await input.click(); await page.keyboard.type(prompt); });
      const send = page.getByRole('button', { name: /^send$/i }).last();
      if (await send.isVisible().catch(() => false)) await send.click(); else await page.keyboard.press('Enter');
      const response = await waitForValidSocResponse(page, before);
      const responseMs = Date.now() - started;
      const snapshot = extractStageSnapshot(await bodyText(page));
      turns.push({ index: index + 1, prompt, response, responseMs, stage: snapshot.stage, exchanges: snapshot.exchanges });
      checks.push(check(`Turn ${index + 1} response`, response.length > 0, [`response ${response.length} chars`, `response time ${responseMs}ms`, `stage ${snapshot.stage}`, `exchanges ${snapshot.exchanges ?? 'unknown'}`]));
      checks.push(check(`Turn ${index + 1} response time under 75s`, responseMs < 75_000, [`response time ${responseMs}ms`]));
      if ((options.refreshEvery ?? 5) > 0 && (index + 1) % (options.refreshEvery ?? 5) === 0) {
        const fragment = response.slice(0, 50);
        await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
        await page.waitForTimeout(1500);
        const afterRefresh = await bodyText(page);
        checks.push(check(`Refresh persistence after turn ${index + 1}`, !fragment || afterRefresh.includes(fragment), [fragment ? 'response fragment checked after refresh' : 'no response fragment to check']));
      }
    }

    const finalText = await bodyText(page);
    checks.push(check('No premature SESSION COMPLETE', !finalText.includes('SESSION COMPLETE'), [finalText.includes('SESSION COMPLETE') ? 'SESSION COMPLETE visible' : 'SESSION COMPLETE not visible']));
    const screenshotPath = path.join(outputDir, 'long-thread.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    artifacts.push(screenshotPath);
    await writeArtifact(outputDir, artifacts, 'turns.json', turns);
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

  return { ok: checks.every((item) => item.ok), skipped: false, checks, turns, artifacts };
}

export function renderLongThreadSmokeReport(packName: string, result: LongThreadSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} long-thread smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
  for (const item of result.checks) {
    lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`, '');
    for (const detail of item.details) lines.push(`- ${detail}`);
    lines.push('');
  }
  if (result.turns.length) {
    lines.push('## Turns', '');
    for (const turn of result.turns) lines.push(`- Turn ${turn.index}: ${turn.responseMs}ms, ${turn.stage}, exchanges ${turn.exchanges ?? 'unknown'} — ${turn.response.slice(0, 120)}`);
    lines.push('');
  }
  if (result.artifacts.length) {
    lines.push('## Artifacts', '');
    for (const artifact of result.artifacts) lines.push(`- ${artifact}`);
    lines.push('');
  }
  return lines.join('\n');
}
