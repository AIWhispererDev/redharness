import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';
import { extractLatestSocResponse } from './proRegressionSmoke.js';
import { extractStageSnapshot } from './longThreadSmoke.js';

type CompletionTurn = { index: number; prompt: string; response: string; responseMs: number; stage: string; exchanges: number | null };
type CompletionSmokeResult = { ok: boolean; skipped: boolean; reachedLanding: boolean; checks: BrowserSmokeCheck[]; turns: CompletionTurn[]; artifacts: string[] };
function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck { return { name, ok, details }; }
function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
async function fileExists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
async function bodyText(page: import('playwright').Page): Promise<string> { return page.evaluate(() => document.body.innerText); }
async function writeArtifact(outputDir: string, artifacts: string[], name: string, data: unknown): Promise<void> { const filePath = path.join(outputDir, name); await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8'); artifacts.push(filePath); }

export function chooseCompletionPrompt(stage: string, turn: number): string {
  if (stage === 'LANDING') return 'Name one concrete next step I can take after this thread.';
  if (stage === 'ROOT') return 'Help me state the root belief plainly, then ask what landing action follows.';
  if (stage === 'BENEATH') return 'Go beneath the pattern: what fear, shame, or need is driving it?';
  return `Keep tracing the pattern. Ask one precise question that moves from story to pattern. Turn ${turn}.`;
}

async function waitForValidSocResponse(page: import('playwright').Page, previousText: string): Promise<string> {
  await page.waitForFunction((oldText) => document.body.innerText !== oldText && document.body.innerText.includes('SOC'), previousText, { timeout: 90_000 }).catch(() => undefined);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = extractLatestSocResponse(await bodyText(page));
    const chromeOnly = !response || response.includes('THINKING') || response.includes('FRAME') || response.includes('MODE') || response.includes('SEND');
    if (!chromeOnly && response.length > 10) return response;
    await page.waitForTimeout(2000);
  }
  return '';
}

export async function runCompletionSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean; maxTurns?: number } = {}): Promise<CompletionSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) return { ok: true, skipped: true, reachedLanding: false, checks: [check('Completion smoke skipped', true, ['No --storage-state provided.'])], turns: [], artifacts: [] };
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) return { ok: true, skipped: true, reachedLanding: false, checks: [check('Completion smoke skipped', true, [`Storage state file not found: ${storageStatePath}`])], turns: [], artifacts: [] };
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'completion-smoke');
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const turns: CompletionTurn[] = [];
  const artifacts: string[] = [];
  const consoleEntries: Array<{ type: string; text: string; location: unknown }> = [];
  const failedRequests: Array<{ url: string; method: string; failure: string | null }> = [];
  const badResponses: Array<{ url: string; status: number; statusText: string }> = [];
  page.on('console', (message) => consoleEntries.push({ type: message.type(), text: message.text(), location: message.location() }));
  page.on('requestfailed', (request) => failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null }));
  page.on('response', (response) => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status(), statusText: response.statusText() }); });
  let reachedLanding = false;
  try {
    await page.goto(joinUrl(pack.baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const understand = page.getByRole('button', { name: /I understand/i }).first();
    if (await understand.isVisible().catch(() => false)) await understand.click();
    const maxTurns = options.maxTurns ?? 20;
    for (let i = 1; i <= maxTurns; i += 1) {
      const textNow = await bodyText(page);
      const current = extractStageSnapshot(textNow);
      if (current.stage === 'LANDING' || textNow.includes('SESSION COMPLETE') || textNow.includes('The session explored')) { reachedLanding = true; break; }
      const input = page.locator('textarea, [contenteditable="true"]').last();
      if (!(await input.isVisible().catch(() => false))) { checks.push(check(`Turn ${i} input visible`, false, ['message input not visible'])); break; }
      const prompt = chooseCompletionPrompt(current.stage, i);
      const before = await bodyText(page);
      const started = Date.now();
      await input.fill(prompt).catch(async () => { await input.click(); await page.keyboard.type(prompt); });
      const send = page.getByRole('button', { name: /^send$/i }).last();
      if (await send.isVisible().catch(() => false)) await send.click(); else await page.keyboard.press('Enter');
      const response = await waitForValidSocResponse(page, before);
      const responseMs = Date.now() - started;
      const snapshot = extractStageSnapshot(await bodyText(page));
      if (snapshot.stage === 'LANDING') reachedLanding = true;
      turns.push({ index: i, prompt, response, responseMs, stage: snapshot.stage, exchanges: snapshot.exchanges });
      checks.push(check(`Turn ${i} response`, response.length > 0, [`response ${response.length} chars`, `response time ${responseMs}ms`, `stage ${snapshot.stage}`]));
      checks.push(check(`Turn ${i} response time under 90s`, responseMs < 90_000, [`response time ${responseMs}ms`]));
      if (reachedLanding) break;
    }
    const finalText = await bodyText(page);
    checks.push(check('Reached Landing or max turns gracefully', reachedLanding || turns.length > 0, [reachedLanding ? 'Reached LANDING' : `Ended at ${turns.at(-1)?.stage ?? 'unknown'} after ${turns.length} turns`]));
    checks.push(check('No crash state visible', !/500|504|application error|something went wrong/i.test(finalText), ['no generic crash text visible']));
    const screenshot = path.join(outputDir, 'completion.png');
    await page.screenshot({ path: screenshot, fullPage: true }); artifacts.push(screenshot);
    await writeArtifact(outputDir, artifacts, 'timeline.json', turns);
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
  return { ok: checks.every((item) => item.ok), skipped: false, reachedLanding, checks, turns, artifacts };
}

export function renderCompletionSmokeReport(packName: string, result: CompletionSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} completion smoke report`, '', `Status: ${status}`, `Reached Landing: ${result.reachedLanding ? 'yes' : 'no'}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
  for (const item of result.checks) { lines.push(`## ${item.ok ? '✅' : '❌'} ${item.name}`, ''); for (const detail of item.details) lines.push(`- ${detail}`); lines.push(''); }
  if (result.turns.length) { lines.push('## Stage timeline', ''); for (const turn of result.turns) lines.push(`- Turn ${turn.index}: ${turn.stage}, ${turn.responseMs}ms, exchanges ${turn.exchanges ?? 'unknown'} — ${turn.response.slice(0, 100)}`); lines.push(''); }
  if (result.artifacts.length) { lines.push('## Artifacts', ''); for (const artifact of result.artifacts) lines.push(`- ${artifact}`); lines.push(''); }
  return lines.join('\n');
}
