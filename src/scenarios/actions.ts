/**
 * PRD 03: Action runner — executes scripted scenario actions against a page.
 *
 * Each action maps to a Playwright operation. Captures are stored for
 * later assertion use.
 */
import type { Page } from 'playwright';
import type { ScenarioAction, ScenarioAssertion } from './schema.js';

export type CaptureStore = Map<string, string>;

/** Resolve a URL against a base URL. */
export function resolveUrl(url: string, baseUrl?: string): string {
  if (!baseUrl) return url;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${url}`;
  return `${baseUrl.replace(/\/$/, '')}/${url}`;
}

/** Execute a single scenario action against a Playwright page. */
export async function executeAction(
  page: Page,
  action: ScenarioAction,
  captures: CaptureStore,
  baseUrl?: string,
): Promise<void> {
  switch (action.action) {
    case 'goto':
      await page.goto(resolveUrl(action.url, baseUrl), { waitUntil: 'networkidle', timeout: 30_000 });
      break;

    case 'click': {
      const locator = action.role
        ? page.getByRole(action.role as any, { name: action.name })
        : action.selector
          ? page.locator(action.selector)
          : page.locator('body');
      await locator.click();
      break;
    }

    case 'fill':
      await page.locator(action.selector).fill(action.value);
      break;

    case 'send_message': {
      const input = page.locator('textarea, [contenteditable="true"]').last();
      await input.fill(action.value);
      const sendBtn = page.getByRole('button', { name: /send/i }).last();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      break;
    }

    case 'press':
      await page.keyboard.press(action.key);
      break;

    case 'reload':
      await page.reload({ waitUntil: 'networkidle', timeout: 30_000 });
      break;

    case 'wait':
      await page.waitForTimeout(action.ms);
      break;

    case 'wait_for_selector':
      await page.waitForSelector(action.selector, { timeout: action.timeoutMs ?? 10_000 });
      break;

    case 'capture': {
      const text = action.selector
        ? await page.locator(action.selector).innerText()
        : await page.evaluate(() => document.body.innerText);
      captures.set(action.as, text);
      break;
    }

    case 'dismiss_if_visible': {
      const btn = page.getByRole(action.role as any, { name: action.name });
      if (await btn.isVisible().catch(() => false)) {
        await btn.click({ force: true });
      }
      break;
    }

    case 'assert_visible': {
      const locator = action.role
        ? page.getByRole(action.role as any, { name: action.name })
        : action.selector
          ? page.locator(action.selector)
          : page.locator('body');
      if (!(await locator.isVisible().catch(() => false))) {
        throw new Error(`Assertion failed: element not visible (role=${action.role}, name=${action.name}, selector=${action.selector})`);
      }
      break;
    }

    case 'assert_text': {
      const text = action.selector
        ? await page.locator(action.selector).innerText()
        : await page.evaluate(() => document.body.innerText);
      if (!text.includes(action.value)) {
        throw new Error(`Assertion failed: expected text "${action.value}" not found`);
      }
      break;
    }

    case 'assert_url': {
      const url = page.url();
      if (!new RegExp(action.pattern).test(url)) {
        throw new Error(`Assertion failed: URL "${url}" does not match pattern "${action.pattern}"`);
      }
      break;
    }

    case 'screenshot':
      await page.screenshot({ path: action.name, fullPage: true });
      break;

    default:
      throw new Error(`Unknown action: ${(action as any).action}`);
  }
}

/** Evaluate a scenario assertion. */
export async function evaluateAssertion(
  page: Page,
  assertion: ScenarioAssertion,
  captures: CaptureStore,
): Promise<{ passed: boolean; message: string }> {
  switch (assertion.assertion) {
    case 'page_contains_capture': {
      const bodyText = await page.evaluate(() => document.body.innerText);
      const expected = captures.get(assertion.capture);
      if (!expected) return { passed: false, message: `Capture "${assertion.capture}" not found` };
      const passed = bodyText.includes(expected.slice(0, 60));
      return { passed, message: passed ? 'Page contains captured text' : `Page does not contain captured text: "${expected.slice(0, 60)}..."` };
    }

    case 'url_matches': {
      const url = page.url();
      const passed = new RegExp(assertion.pattern).test(url);
      return { passed, message: passed ? `URL matches ${assertion.pattern}` : `URL ${url} does not match ${assertion.pattern}` };
    }

    case 'element_visible': {
      const locator = assertion.role
        ? page.getByRole(assertion.role as any, { name: assertion.name })
        : assertion.selector
          ? page.locator(assertion.selector)
          : page.locator('body');
      const visible = await locator.isVisible().catch(() => false);
      return { passed: visible, message: visible ? 'Element visible' : 'Element not visible' };
    }

    case 'text_present': {
      const body = await page.evaluate(() => document.body.innerText);
      const passed = body.includes(assertion.text);
      return { passed, message: passed ? `Text "${assertion.text}" found` : `Text "${assertion.text}" not found` };
    }

    case 'state_equals':
      return { passed: false, message: 'State-diff assertion requires fixture environment' };

    default:
      return { passed: false, message: `Unknown assertion: ${(assertion as any).assertion}` };
  }
}
