import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, QaPack } from './types.js';

type RecordExportSmokeResult = { ok: boolean; skipped: boolean; checks: BrowserSmokeCheck[]; artifacts: string[] };
function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck { return { name, ok, details }; }
function joinUrl(baseUrl: string, routePath: string): string { return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`; }
async function fileExists(filePath: string): Promise<boolean> { try { await access(filePath); return true; } catch { return false; } }
async function writeJson(outputDir: string, artifacts: string[], name: string, data: unknown): Promise<void> {
  const filePath = path.join(outputDir, name);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  artifacts.push(filePath);
}
async function bodyText(page: import('playwright').Page): Promise<string> { return page.evaluate(() => document.body.innerText); }

export async function runRecordExportSmoke(pack: QaPack, options: { storageState?: string; outputDir?: string; headless?: boolean } = {}): Promise<RecordExportSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!options.storageState) return { ok: true, skipped: true, checks: [check('Record/export smoke skipped', true, ['No --storage-state provided.'])], artifacts: [] };
  const storageStatePath = path.resolve(options.storageState);
  if (!(await fileExists(storageStatePath))) return { ok: true, skipped: true, checks: [check('Record/export smoke skipped', true, [`Storage state file not found: ${storageStatePath}`])], artifacts: [] };
  const baseUrl = pack.baseUrl;
  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, 'record-export-smoke');
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({ storageState: storageStatePath, acceptDownloads: true });
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
    await page.goto(joinUrl(baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
    const understand = page.getByRole('button', { name: /I understand/i }).first();
    if (await understand.isVisible().catch(() => false)) {
      await understand.click();
      await page.waitForTimeout(500);
    }
    const docNav = page.getByRole('button', { name: /^DOCUMENT$/i }).first();
    if (await docNav.isVisible().catch(() => false)) {
      await docNav.click({ force: true });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    } else {
      const docLink = page.getByRole('link', { name: /document|record|journey/i }).last();
      if (await docLink.isVisible().catch(() => false)) {
        await docLink.click();
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
      } else {
        await page.goto(joinUrl(baseUrl, '/en/journey'), { waitUntil: 'networkidle', timeout: 30_000 }).catch(async () => {
          await page.goto(joinUrl(baseUrl, '/en/dashboard'), { waitUntil: 'networkidle', timeout: 30_000 });
        });
      }
    }
    await page.waitForTimeout(1000);
    const text = await bodyText(page);
    const onDocSurface = /document|record|journey|ariadne/i.test(text) && !/sign in/i.test(text);
    checks.push(check('Document/Records route opens', onDocSurface, [`url ${page.url()}`, `rendered ${text.length} chars`]));

    const documentShot = path.join(outputDir, 'document.png');
    await page.screenshot({ path: documentShot, fullPage: true });
    artifacts.push(documentShot);

    const recordCandidate = page.getByRole('button', { name: /open|view|record|thread/i }).first();
    if (await recordCandidate.isVisible().catch(() => false)) {
      await recordCandidate.click().catch(() => undefined);
      await page.waitForTimeout(1000);
    }
    const afterOpen = await bodyText(page);
    checks.push(check('Record list/detail is graceful', afterOpen.length > 100 && !/500|application error|something went wrong/i.test(afterOpen), [afterOpen.length > 100 ? `rendered ${afterOpen.length} chars` : 'very little text rendered']));

    const exportButton = page.getByRole('button', { name: /export|download|pdf/i }).first();
    const exportVisible = await exportButton.isVisible().catch(() => false);
    let downloadPath = '';
    let exportText = afterOpen;
    if (exportVisible) {
      const download = page.waitForEvent('download', { timeout: 5000 }).catch(() => null);
      await exportButton.click().catch(() => undefined);
      const downloaded = await download;
      if (downloaded) {
        downloadPath = path.join(outputDir, downloaded.suggestedFilename());
        await downloaded.saveAs(downloadPath);
        artifacts.push(downloadPath);
      }
      await page.waitForTimeout(1000);
      exportText = await bodyText(page);
    }
    const gracefulExport = exportVisible || /no summary|export|record|document|nothing/i.test(exportText);
    checks.push(check('Export control is graceful', gracefulExport, [exportVisible ? 'export/download control visible' : 'export control not visible', downloadPath ? `downloaded ${downloadPath}` : 'no download captured']));

    const afterShot = path.join(outputDir, 'record-export-after.png');
    await page.screenshot({ path: afterShot, fullPage: true });
    artifacts.push(afterShot);
  } finally {
    await writeJson(outputDir, artifacts, 'console.json', consoleEntries);
    await writeJson(outputDir, artifacts, 'network-failures.json', failedRequests);
    await writeJson(outputDir, artifacts, 'network-4xx-5xx.json', badResponses);
    const consoleErrors = consoleEntries.filter((entry) => entry.type === 'error');
    const actionableFailedRequests = failedRequests.filter((entry) => entry.failure !== 'net::ERR_ABORTED');
    checks.push(check('Console errors', consoleErrors.length === 0, [`${consoleErrors.length} console error(s) captured`, consoleErrors[0]?.text ?? 'none']));
    checks.push(check('Network failures', actionableFailedRequests.length === 0, [`${actionableFailedRequests.length} non-aborted failed request(s) captured`]));
    checks.push(check('HTTP 5xx responses', badResponses.filter((entry) => entry.status >= 500).length === 0, [`${badResponses.filter((entry) => entry.status >= 500).length} HTTP 5xx response(s) captured`]));
    await browser.close();
  }
  return { ok: checks.every((item) => item.ok), skipped: false, checks, artifacts };
}

export function renderRecordExportSmokeReport(packName: string, result: RecordExportSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const status = result.skipped ? 'skipped' : result.ok ? 'passed' : 'failed';
  const lines = [`# ${packName} Record/export smoke report`, '', `Status: ${status}`, `Summary: ${passed}/${result.checks.length} passed`, ''];
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
