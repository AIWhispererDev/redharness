/**
 * Feature 02: Run-scoped browser session manager.
 *
 * Owns a Playwright browser and context for a single agent run.
 * Deterministic cleanup on pass, error, timeout, and cancellation.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export type BrowserSessionOptions = {
  /** Whether to run headless (default: true). */
  headless?: boolean;
  /** Viewport dimensions (default: 1280x720). */
  viewport?: { width: number; height: number };
  /** Allowed origins — enforced on navigation and after redirects. */
  allowedOrigins: string[];
  /** Timeout for navigation in ms (default: 15000). */
  navigationTimeoutMs?: number;
};

export type BrowserSessionSnapshot = {
  url: string;
  title: string;
  viewport: { width: number; height: number };
};

/**
 * Run-scoped browser session.
 *
 * Creates a single browser + context per agent run.
 * Call `close()` for deterministic cleanup — invoked on pass, error,
 * timeout, and cancellation.
 */
export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private options: BrowserSessionOptions;
  private closed = false;

  constructor(options: BrowserSessionOptions) {
    this.options = options;
  }

  /** Lazy-init and return the page. */
  async getPage(): Promise<Page> {
    if (this.closed) {
      throw new Error('Browser session is closed');
    }
    if (this.page) return this.page;

    this.browser = await chromium.launch({
      headless: this.options.headless ?? true,
    });

    this.context = await this.browser.newContext({
      viewport: this.options.viewport ?? { width: 1280, height: 720 },
      permissions: [],
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      locale: 'en-US',
    });

    // Create page FIRST so we can reference it in the popup blocker
    this.page = await this.context.newPage();
    this.page.setDefaultNavigationTimeout(this.options.navigationTimeoutMs ?? 15000);
    this.page.setDefaultTimeout(this.options.navigationTimeoutMs ?? 15000);

    // Block popups — only close pages spawned via window.open or target=_blank,
    // NOT the main page created above.
    this.context.on('page', (newPage) => {
      if (newPage === this.page) return;
      newPage.close().catch(() => {});
    });

    // Block download dialog and protocol-escape routes
    await this.context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('file:') || url.startsWith('data:')) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });

    return this.page;
  }

  /**
   * Validate that a URL's origin is in the allowed list.
   * Called before navigation and after every redirect.
   */
  isOriginAllowed(url: string): boolean {
    try {
      const parsed = new URL(url);
      // Never allow javascript:, file:, or data: URLs
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'file:' || parsed.protocol === 'data:') {
        return false;
      }
      return this.options.allowedOrigins.some(
        (allowed) => parsed.origin === allowed || parsed.origin.startsWith(allowed),
      );
    } catch {
      return false;
    }
  }

  /**
   * Navigate to a URL and validate the final origin after redirects.
   * Throws if the origin is not allowed.
   */
  async navigate(url: string): Promise<BrowserSessionSnapshot> {
    if (!this.isOriginAllowed(url)) {
      throw new Error(`Navigation denied: origin of "${url}" is not in the allowed origins list`);
    }

    const page = await this.getPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Re-validate after redirects
    const finalUrl = page.url();
    if (!this.isOriginAllowed(finalUrl)) {
      throw new Error(`Redirect denied: final origin "${new URL(finalUrl).origin}" is not allowed`);
    }

    // Wait a brief moment for dynamic content
    await page.waitForLoadState('networkidle').catch(() => {});
    // Small settle time for SPA content
    await page.waitForTimeout(300);

    return this.snapshot();
  }

  /**
   * Get a snapshot of the current page state.
   */
  async snapshot(): Promise<BrowserSessionSnapshot> {
    const page = await this.getPage();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      viewport,
    };
  }

  /**
   * Take a screenshot and return base64-encoded PNG data.
   */
  async screenshot(): Promise<string> {
    const page = await this.getPage();
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    return buffer.toString('base64');
  }

  /**
   * Get the current page's visible text content.
   * Only visible text — hidden text is excluded.
   */
  async visibleText(): Promise<string> {
    const page = await this.getPage();
    return page.evaluate(() => {
      const isVisible = (el: Element): boolean => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
      };
      // Walk all text nodes and collect only visible ones
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
      );
      const parts: string[] = [];
      let node: Text | null;
      while ((node = walker.nextNode() as Text | null)) {
        const parent = node.parentElement;
        if (parent && isVisible(parent)) {
          const text = node.textContent?.trim();
          if (text) parts.push(text);
        }
      }
      return parts.join('\n');
    });
  }

  /**
   * Get the page's full DOM text (including hidden).
   * Used for security checks — to detect hidden prompt injections.
   */
  async allText(): Promise<string> {
    const page = await this.getPage();
    return page.evaluate(() => document.body.innerText);
  }

  /**
   * Close the browser session deterministically.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    try {
      if (this.context) {
        await this.context.close().catch(() => {});
      }
      if (this.browser) {
        await this.browser.close().catch(() => {});
      }
    } finally {
      this.page = null;
      this.context = null;
      this.browser = null;
    }
  }

  /** Whether the session has been closed. */
  isClosed(): boolean {
    return this.closed;
  }
}
