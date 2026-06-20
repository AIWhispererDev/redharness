/**
 * Feature 02: Governed browser tools.
 *
 * Browser tools are policy-mediated, origin-bound, and replayable.
 * They use semantic locator recipes with role/name first.
 *
 * Action classification:
 * - Read-only: observe, navigate, screenshot, get_page_state
 * - Safe write: click, fill, press, wait (reversible in fixture context)
 * - Rejected: downloads, popups, protocol escapes, file URLs
 */

import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../agentTypes.js';
import { BrowserSessionManager } from '../browser/sessionManager.js';
import { resolveLocatorForAction, validateLocatorRecipe } from '../browser/locator.js';

// ---------------------------------------------------------------------------
// READ-ONLY TOOLS
// ---------------------------------------------------------------------------

export const browserObserveTool: ToolDefinition = {
  name: 'browser_observe',
  version: '2.0.0',
  description: 'Observe the current page state: visible text, URL, title, and viewport',
  inputSchema: {
    type: 'object',
    properties: {
      /** Whether to include hidden text in output (for security scanning). */
      includeHidden: { type: 'boolean', description: 'Whether to include hidden DOM text', optional: true },
    },
    required: [],
  },
  risk: 'read',
  capabilities: ['browser', 'browser-readonly'],
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const session = BrowserSessionManager.getInstance().getSession(context.runId);
    if (!session) {
      return { success: false, error: 'No active browser session. Start with browser_navigate first.', durationMs: 0 };
    }

    try {
      const snapshot = await session.snapshot();
      const visibleText = await session.visibleText();
      const includeHidden = args.includeHidden === true;

      const output: Record<string, unknown> = {
        url: snapshot.url,
        title: snapshot.title,
        viewport: snapshot.viewport,
        visibleText,
      };

      if (includeHidden) {
        output.allText = await session.allText();
      }

      return {
        success: true,
        output,
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to observe page: ${message}`, durationMs: 0 };
    }
  },
};

export const browserNavigateTool: ToolDefinition = {
  name: 'browser_navigate',
  version: '2.0.0',
  description: 'Navigate to a URL within the allowed origins. Origin is validated before navigation and after redirects.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to navigate to' },
    },
    required: ['url'],
  },
  risk: 'read',
  capabilities: ['browser', 'browser-readonly', 'network'],
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const url = args.url as string;
    if (!url) {
      return { success: false, error: 'URL is required', durationMs: 0 };
    }

    // Protocol-level validation before any session interaction
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'javascript:' || parsed.protocol === 'file:' || parsed.protocol === 'data:') {
        return { success: false, error: `Navigation denied: ${parsed.protocol} URLs are not allowed`, durationMs: 0 };
      }
    } catch {
      return { success: false, error: `Invalid URL: ${url}`, durationMs: 0 };
    }

    const mgr = BrowserSessionManager.getInstance();
    let session = mgr.getSession(context.runId);

    try {
      if (!session) {
        // Create session on first navigation
        session = await mgr.createSession(context.runId, {
          allowedOrigins: context.intent.allowedOrigins,
        });
      }

      const snapshot = await session.navigate(url);

      return {
        success: true,
        output: {
          url: snapshot.url,
          title: snapshot.title,
          viewport: snapshot.viewport,
        },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Navigation failed: ${message}`, durationMs: 0 };
    }
  },
};

export const browserScreenshotTool: ToolDefinition = {
  name: 'browser_screenshot',
  version: '2.0.0',
  description: 'Take a screenshot of the current page. Returns base64-encoded PNG data.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  risk: 'read',
  capabilities: ['browser', 'browser-readonly'],
  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const session = BrowserSessionManager.getInstance().getSession(context.runId);
    if (!session) {
      return { success: false, error: 'No active browser session', durationMs: 0 };
    }

    try {
      const base64Png = await session.screenshot();
      return {
        success: true,
        output: { screenshot: base64Png, format: 'png' },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Screenshot failed: ${message}`, durationMs: 0 };
    }
  },
};

export const browserGetPageStateTool: ToolDefinition = {
  name: 'browser_get_page_state',
  version: '2.0.0',
  description: 'Query structured page state: URL, title, visible text, input values, and aria attributes',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  risk: 'read',
  capabilities: ['browser', 'browser-readonly'],
  async execute(_args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const session = BrowserSessionManager.getInstance().getSession(context.runId);
    if (!session) {
      return { success: false, error: 'No active browser session', durationMs: 0 };
    }

    try {
      const snapshot = await session.snapshot();
      const visibleText = await session.visibleText();

      return {
        success: true,
        output: {
          url: snapshot.url,
          title: snapshot.title,
          viewport: snapshot.viewport,
          visibleText,
          state: 'loaded',
        },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Failed to get page state: ${message}`, durationMs: 0 };
    }
  },
};

// ---------------------------------------------------------------------------
// SAFE-WRITE TOOLS
// ---------------------------------------------------------------------------

export const browserClickTool: ToolDefinition = {
  name: 'browser_click',
  version: '2.0.0',
  description: 'Click an element identified by a semantic locator (role+name preferred)',
  inputSchema: {
    type: 'object',
    properties: {
      locator: {
        type: 'object',
        description: 'Semantic locator: {role, name} preferred, or {text}, {label}, {testid}',
        properties: {
          role: { type: 'string', optional: true },
          name: { type: 'string', optional: true },
          text: { type: 'string', optional: true },
          exact: { type: 'boolean', optional: true },
          label: { type: 'string', optional: true },
          testid: { type: 'string', optional: true },
        },
        required: [],
      },
    },
    required: ['locator'],
  },
  risk: 'write',
  capabilities: ['browser', 'browser-safe-write', 'mutation'],
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const session = BrowserSessionManager.getInstance().getSession(context.runId);
    if (!session) {
      return { success: false, error: 'No active browser session', durationMs: 0 };
    }

    const recipe = validateLocatorRecipe(args.locator);
    if (!recipe) {
      return { success: false, error: `Invalid locator: ${JSON.stringify(args.locator)}`, durationMs: 0 };
    }

    try {
      const page = await session.getPage();
      const { locator, description } = resolveLocatorForAction(page, recipe);
      await locator.click({ timeout: 5000 });

      return {
        success: true,
        output: {
          action: 'click',
          locator: description,
          url: page.url(),
        },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Click failed on ${JSON.stringify(args.locator)}: ${message}`, durationMs: 0 };
    }
  },
};

export const browserFillTool: ToolDefinition = {
  name: 'browser_fill',
  version: '2.0.0',
  description: 'Fill an input field identified by a semantic locator',
  inputSchema: {
    type: 'object',
    properties: {
      locator: {
        type: 'object',
        description: 'Semantic locator: {label} or {role, name} preferred for form fields',
        properties: {
          role: { type: 'string', optional: true },
          name: { type: 'string', optional: true },
          text: { type: 'string', optional: true },
          exact: { type: 'boolean', optional: true },
          label: { type: 'string', optional: true },
          testid: { type: 'string', optional: true },
        },
        required: [],
      },
      value: { type: 'string', description: 'The value to fill into the input' },
    },
    required: ['locator', 'value'],
  },
  risk: 'write',
  capabilities: ['browser', 'browser-safe-write', 'mutation'],
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const session = BrowserSessionManager.getInstance().getSession(context.runId);
    if (!session) {
      return { success: false, error: 'No active browser session', durationMs: 0 };
    }

    const recipe = validateLocatorRecipe(args.locator);
    if (!recipe) {
      return { success: false, error: `Invalid locator: ${JSON.stringify(args.locator)}`, durationMs: 0 };
    }

    const value = args.value as string | undefined;
    if (value === undefined) {
      return { success: false, error: 'value is required', durationMs: 0 };
    }

    try {
      const page = await session.getPage();
      const { locator, description } = resolveLocatorForAction(page, recipe);
      await locator.fill(value, { timeout: 5000 });

      return {
        success: true,
        output: {
          action: 'fill',
          locator: description,
          valueLength: value.length,
        },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Fill failed on ${JSON.stringify(args.locator)}: ${message}`, durationMs: 0 };
    }
  },
};

export const browserPressTool: ToolDefinition = {
  name: 'browser_press',
  version: '2.0.0',
  description: 'Press a keyboard key (e.g. "Enter", "Tab", "Escape")',
  inputSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: 'Key to press (e.g. "Enter", "Tab", "Escape", "ArrowDown")' },
    },
    required: ['key'],
  },
  risk: 'write',
  capabilities: ['browser', 'browser-safe-write', 'mutation'],
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const session = BrowserSessionManager.getInstance().getSession(context.runId);
    if (!session) {
      return { success: false, error: 'No active browser session', durationMs: 0 };
    }

    const key = args.key as string | undefined;
    if (!key) {
      return { success: false, error: 'key is required', durationMs: 0 };
    }

    try {
      const page = await session.getPage();
      await page.keyboard.press(key);

      return {
        success: true,
        output: { action: 'press', key },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `Press "${key}" failed: ${message}`, durationMs: 0 };
    }
  },
};

export const browserWaitTool: ToolDefinition = {
  name: 'browser_wait',
  version: '2.0.0',
  description: 'Wait for a specified duration or for a condition',
  inputSchema: {
    type: 'object',
    properties: {
      ms: { type: 'number', description: 'Duration to wait in milliseconds (max 10000)' },
    },
    required: ['ms'],
  },
  risk: 'read',
  capabilities: ['browser', 'browser-readonly'],
  async execute(args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolResult> {
    const ms = args.ms as number | undefined;
    if (ms === undefined || ms < 0 || ms > 10000) {
      return { success: false, error: 'ms must be between 0 and 10000', durationMs: 0 };
    }

    await new Promise((resolve) => setTimeout(resolve, ms));
    return { success: true, output: { waitedMs: ms }, durationMs: ms };
  },
};
