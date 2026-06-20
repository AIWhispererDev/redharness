import path from 'node:path';
import type { RecordedAction, AssertionRecipe, ReplaySpec, FindingPacketV2, LocatorRecipe } from '../trace/traceTypes.js';

/**
 * Compiles recorded actions into executable replay specs.
 *
 * Supports three modes:
 * - http: standalone HTTP request with assertion
 * - browser: @playwright/test spec using role-based locators
 * - guided: scaffold with unresolved steps as test.fixme
 */

/** Generate a Playwright test spec from recorded actions. */
export function compileBrowserSpec(
  actions: RecordedAction[],
  assertion: AssertionRecipe,
  findingId: string,
): string {
  const lines: string[] = [];

  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push('');
  lines.push(`test('${findingId}', async ({ page }) => {`);

  for (const action of actions) {
    switch (action.type) {
      case 'goto':
        lines.push(`  await page.goto('${escapeQuote(action.url)}');`);
        break;
      case 'click':
        lines.push(`  await page.click('${locatorToSelector(action.locator)}');`);
        break;
      case 'fill':
        lines.push(`  await page.fill('${locatorToSelector(action.locator)}', '${escapeQuote(action.valueRef)}');`);
        break;
      case 'press':
        lines.push(`  await page.press('${locatorToSelector({ css: 'body' })}', '${action.key}');`);
        break;
      case 'reload':
        lines.push(`  await page.reload();`);
        break;
      case 'screenshot':
        lines.push(`  await page.screenshot({ path: '${action.name}.png' });`);
        break;
      case 'waitFor':
        lines.push(`  await page.waitForTimeout(${action.condition.type === 'timeout' ? action.condition.ms : 1000});`);
        break;
      default:
        break;
    }
  }

  // Assertion
  switch (assertion.type) {
    case 'visible':
      lines.push(`  await expect(page.locator('${locatorToSelector(assertion.locator)}')).toBeVisible();`);
      break;
    case 'text':
      lines.push(`  await expect(page.locator('${locatorToSelector(assertion.locator)}')).toContainText('${escapeQuote(assertion.value)}');`);
      break;
    case 'url':
      lines.push(`  await expect(page).toHaveURL(/${escapeRegex(assertion.pattern)}/);`);
      break;
  }

  lines.push('});');
  return lines.join('\n');
}

/** Generate an HTTP replay curl script. */
export function compileHttpCurl(spec: ReplaySpec): string {
  if (spec.mode !== 'http') return '';
  const parts = ['curl', '-i', '-X', spec.method, JSON.stringify(spec.url)];
  for (const [k, v] of Object.entries(spec.headers)) {
    if (/cookie|authorization|token|key/i.test(k)) continue; // don't embed secrets
    parts.push('-H', JSON.stringify(`${k}: ${v}`));
  }
  if (spec.body) parts.push('--data-raw', JSON.stringify(spec.body));
  return parts.join(' ') + '\n';
}

/** Generate an HTTP replay Playwright request spec. */
export function compileHttpSpec(spec: ReplaySpec): string {
  if (spec.mode !== 'http') return '';
  return [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test('${spec.assertion.replace(/'/g, "\\'")}', async ({ request }) => {`,
    `  const resp = await request.${spec.method.toLowerCase() === 'get' ? 'get' : 'fetch'}('${escapeQuote(spec.url)}'${spec.method.toLowerCase() !== 'get' ? `, { method: '${spec.method}'${spec.body ? `, data: ${JSON.stringify(spec.body)}` : ''} }` : ''});`,
    `  expect(resp.status()).toBe(${spec.expectedStatus});`,
    `  const body = await resp.text();`,
    `  expect(body).toMatch(${JSON.stringify(spec.assertion)});`,
    `});`,
  ].join('\n');
}

/** Generate a guided replay scaffold. */
export function compileGuidedSpec(finding: FindingPacketV2, unresolvedSteps: string[]): string {
  return [
    `import { test, expect } from '@playwright/test';`,
    ``,
    `test.describe('${escapeQuote(finding.title)}', () => {`,
    `  test.setTimeout(120000);`,
    `  test('replay scaffold', async ({ page }) => {`,
    `    // Setup hint:`,
    `    // ${escapeQuote(finding.expectedState)}`,
    `    test.fixme(true, 'Cannot deterministically reconstruct actions');`,
    `  });`,
    ``,
    ...unresolvedSteps.map((step) => `  test.fixme('${escapeQuote(step)}', () => {});`),
    `});`,
  ].join('\n');
}

/** Get the finding packet directory. */
export function findingPacketDir(baseDir: string, findingId: string): string {
  return path.join(baseDir, 'findings', findingId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeQuote(s: string): string {
  return s.replace(/'/g, "\\'");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function locatorToSelector(l: LocatorRecipe): string {
  if (l.role && l.name) return `[role="${l.role}"] >> text=${l.name}`;
  if (l.testId) return `[data-testid="${l.testId}"]`;
  if (l.label) return `text=${l.label}`;
  if (l.css) return l.css;
  return 'body';
}
