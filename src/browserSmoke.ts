import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserSmokeCheck, BrowserSmokeResult, QaPack } from './types.js';

function joinUrl(baseUrl: string, routePath: string): string {
  return `${baseUrl.replace(/\/$/, '')}${routePath.startsWith('/') ? routePath : `/${routePath}`}`;
}

function check(name: string, ok: boolean, details: string[]): BrowserSmokeCheck {
  return { name, ok, details };
}

async function safeBodyText(page: import('playwright').Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

export async function runBrowserSmoke(pack: QaPack, options: { outputDir?: string; headless?: boolean } = {}): Promise<BrowserSmokeResult> {
  if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
  if (!pack.browserSmoke?.earlyAccess) throw new Error(`Pack ${pack.id} has no browserSmoke.earlyAccess config.`);

  const outputDir = options.outputDir ?? path.join(process.cwd(), 'artifacts', pack.id, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ headless: options.headless ?? true });
  const page = await browser.newPage();
  const checks: BrowserSmokeCheck[] = [];
  const artifacts: string[] = [];

  try {
    const config = pack.browserSmoke.earlyAccess;
    await page.context().clearCookies();
    await page.goto(joinUrl(pack.baseUrl, config.path), { waitUntil: 'networkidle', timeout: 30_000 });

    const initialText = await safeBodyText(page);
    checks.push(
      check(
        'TOS modal appears',
        config.requiredModalTexts.every((text) => initialText.includes(text)),
        config.requiredModalTexts.map((text) => `${initialText.includes(text) ? 'found' : 'missing'} text: ${text}`),
      ),
    );

    const checkboxCount = await page.locator('input[type="checkbox"]').count();
    checks.push(
      check('TOS checkbox count', checkboxCount === config.requiredCheckboxCount, [
        `expected ${config.requiredCheckboxCount}, found ${checkboxCount}`,
      ]),
    );

    const acceptButton = page.getByRole('button', { name: /accept/i }).first();
    const initialDisabled = await acceptButton.isDisabled();
    const acceptStateDetails = [`initial disabled: ${initialDisabled}`];
    for (let i = 0; i < checkboxCount; i += 1) {
      await page.locator('input[type="checkbox"]').nth(i).check({ force: true });
      acceptStateDetails.push(`after checkbox ${i + 1} disabled: ${await acceptButton.isDisabled()}`);
    }
    const finalDisabled = await acceptButton.isDisabled();
    checks.push(check('Accept button gated by all checkboxes', initialDisabled && !finalDisabled, acceptStateDetails));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const afterEscapeText = await safeBodyText(page);
    checks.push(check('Escape does not dismiss TOS modal', afterEscapeText.includes('Before you continue'), ['modal text still present after Escape']));

    await page.mouse.click(5, 5);
    await page.waitForTimeout(250);
    const afterBackdropText = await safeBodyText(page);
    checks.push(check('Backdrop click does not dismiss TOS modal', afterBackdropText.includes('Before you continue'), ['modal text still present after backdrop click']));

    await acceptButton.click();
    await page.waitForTimeout(500);
    const afterAcceptText = await safeBodyText(page);
    checks.push(check('Accept continues to invite form', afterAcceptText.includes('Enter your invite code'), ['invite form visible after accept']));

    const blankSubmitBefore = await safeBodyText(page);
    await page.getByRole('button', { name: 'Submit' }).click();
    await page.waitForTimeout(1000);
    const blankSubmitAfter = await safeBodyText(page);
    const blankScreenshot = path.join(outputDir, 'blank-invite-submit.png');
    await page.screenshot({ path: blankScreenshot, fullPage: true });
    artifacts.push(blankScreenshot);

    const blankHasVisibleValidation = blankSubmitAfter !== blankSubmitBefore && blankSubmitAfter.includes(config.blankInviteExpectedText);
    checks.push(
      check('Blank invite submit gives visible validation', blankHasVisibleValidation, [
        blankHasVisibleValidation
          ? `visible validation changed and includes: ${config.blankInviteExpectedText}`
          : 'no visible validation appeared after blank submit',
      ]),
    );
  } finally {
    await browser.close();
  }

  return {
    ok: checks.every((item) => item.ok),
    checks,
    artifacts,
  };
}

export function renderBrowserSmokeReport(packName: string, result: BrowserSmokeResult): string {
  const passed = result.checks.filter((item) => item.ok).length;
  const lines = [`# ${packName} browser smoke report`, '', `Summary: ${passed}/${result.checks.length} passed`, ''];

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
