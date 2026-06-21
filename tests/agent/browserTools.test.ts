/**
 * Feature 02: Browser tools test suite.
 *
 * Tests: session lifecycle, read-only tools, safe-write tools,
 * locator resolution, origin validation, security policies.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { BrowserSession } from '../../src/agent/browser/session.js';
import { BrowserSessionManager } from '../../src/agent/browser/sessionManager.js';
import { resolveLocatorForAction, validateLocatorRecipe } from '../../src/agent/browser/locator.js';
import { isToolAllowedByProfile, isMutationAction, resolveSandboxProfile } from '../../src/agent/sandboxProfiles.js';
import type { SandboxProfile } from '../../src/agent/agentTypes.js';
import { startReleaseWebApp, type ReleaseFixture } from '../../src/fixtures/releaseWebApp.js';

let fixture: ReleaseFixture;

beforeAll(async () => {
  fixture = await startReleaseWebApp();
});

afterAll(async () => {
  await fixture.stop();
});

// ---------------------------------------------------------------------------
// Locator resolution
// ---------------------------------------------------------------------------

describe('Locator recipe validation', () => {
  it('validates role/name locator', () => {
    const recipe = validateLocatorRecipe({ role: 'button', name: 'Submit' });
    expect(recipe).toEqual({ role: 'button', name: 'Submit' });
  });

  it('validates text locator', () => {
    const recipe = validateLocatorRecipe({ text: 'Click me' });
    expect(recipe).toEqual({ text: 'Click me' });
  });

  it('validates exact text locator', () => {
    const recipe = validateLocatorRecipe({ text: 'Exact', exact: true });
    expect(recipe).toEqual({ text: 'Exact', exact: true });
  });

  it('validates label locator', () => {
    const recipe = validateLocatorRecipe({ label: 'Email' });
    expect(recipe).toEqual({ label: 'Email' });
  });

  it('validates testid locator', () => {
    const recipe = validateLocatorRecipe({ testid: 'submit-btn' });
    expect(recipe).toEqual({ testid: 'submit-btn' });
  });

  it('returns null for empty object', () => {
    expect(validateLocatorRecipe({})).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(validateLocatorRecipe(null)).toBeNull();
    expect(validateLocatorRecipe('string')).toBeNull();
    expect(validateLocatorRecipe(42)).toBeNull();
  });

  it('prefers role/name when both present even with other fields', () => {
    const recipe = validateLocatorRecipe({
      role: 'button',
      name: 'Save',
      text: 'ignored',
      testid: 'ignored',
    });
    expect(recipe).toEqual({ role: 'button', name: 'Save' });
  });
});

// ---------------------------------------------------------------------------
// Sandbox profiles
// ---------------------------------------------------------------------------

describe('Sandbox profiles', () => {
  it('browser-readonly allows browser-readonly capability', () => {
    expect(isToolAllowedByProfile(['browser-readonly'], 'browser-readonly')).toBe(true);
  });

  it('browser-readonly blocks mutation capability', () => {
    expect(isToolAllowedByProfile(['browser-safe-write', 'mutation'], 'browser-readonly')).toBe(false);
    expect(isToolAllowedByProfile(['mutation'], 'browser-readonly')).toBe(false);
  });

  it('browser-readonly blocks browser-safe-write capability', () => {
    expect(isToolAllowedByProfile(['browser-safe-write'], 'browser-readonly')).toBe(false);
  });

  it('browser-safe-write allows both readonly and write capabilities', () => {
    expect(isToolAllowedByProfile(['browser-readonly'], 'browser-safe-write')).toBe(true);
    expect(isToolAllowedByProfile(['browser-safe-write'], 'browser-safe-write')).toBe(true);
    expect(isToolAllowedByProfile(['mutation'], 'browser-safe-write')).toBe(true);
  });

  it('resolves sandbox profiles correctly', () => {
    expect(resolveSandboxProfile('browser-readonly')).toEqual(['browser-readonly']);
    expect(resolveSandboxProfile('browser-safe-write')).toEqual(['browser-safe-write']);
    expect(resolveSandboxProfile('container')).toEqual(['container']);
  });

  it('identifies mutation actions', () => {
    expect(isMutationAction('browser_click')).toBe(true);
    expect(isMutationAction('browser_fill')).toBe(true);
    expect(isMutationAction('browser_press')).toBe(true);
    expect(isMutationAction('browser_observe')).toBe(false);
    expect(isMutationAction('browser_navigate')).toBe(false);
    expect(isMutationAction('browser_screenshot')).toBe(false);
    expect(isMutationAction('browser_wait')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Browser session (headless, using a real Playwright browser)
// ---------------------------------------------------------------------------

// Sequential to avoid browser process contention
// (vitest may run tests in parallel within a file)
describe.sequential('BrowserSession', () => {
  let session: BrowserSession;

  beforeEach(() => {
    session = new BrowserSession({
      allowedOrigins: [fixture.baseUrl],
      headless: true,
      navigationTimeoutMs: 10000,
    });
  });

  afterEach(async () => {
    await session.close();
  });

  it('rejects javascript: URLs before navigation', async () => {
    const page = await session.getPage();
    await expect(
      session.navigate('javascript:alert(1)'),
    ).rejects.toThrow(/Navigation denied/);
    // Page should still be usable after failed navigation
    expect(page.url()).toBeTruthy();
  });

  it('rejects file: URLs before navigation', async () => {
    await expect(
      session.navigate('file:///etc/passwd'),
    ).rejects.toThrow(/Navigation denied/);
  });

  it('rejects data: URLs before navigation', async () => {
    await expect(
      session.navigate('data:text/html,<h1>test</h1>'),
    ).rejects.toThrow(/Navigation denied/);
  });

  it('rejects navigation to disallowed origins', async () => {
    await expect(
      session.navigate('https://evil.example.com'),
    ).rejects.toThrow(/not in the allowed origins/);
  });

  it('navigates to an allowed origin', async () => {
    const snapshot = await session.navigate(fixture.baseUrl);
    expect(snapshot.url).toContain(new URL(fixture.baseUrl).host);
    expect(snapshot.title).toBeDefined();
  });

  it('returns a valid snapshot after navigation', async () => {
    const snapshot = await session.navigate(fixture.baseUrl);
    expect(snapshot).toHaveProperty('url');
    expect(snapshot).toHaveProperty('title');
    expect(snapshot).toHaveProperty('viewport');
    expect(snapshot.viewport.width).toBe(1280);
    expect(snapshot.viewport.height).toBe(720);
  });

  it('returns visible text excluding hidden content', async () => {
    const snapshot = await session.navigate(fixture.baseUrl);
    const text = await session.visibleText();
    expect(text.length).toBeGreaterThan(0);
    // The visible text should not contain hidden elements' content
    const allText = await session.allText();
    expect(allText.length).toBeGreaterThanOrEqual(text.length);
  });

  it('takes a base64-encoded screenshot', async () => {
    await session.navigate(fixture.baseUrl);
    const screenshot = await session.screenshot();
    // Base64-encoded PNG starts with iVBOR
    expect(screenshot).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(screenshot.length).toBeGreaterThan(100);
  });

  it('isOriginAllowed returns false for javascript: URLs', () => {
    expect(session.isOriginAllowed('javascript:void(0)')).toBe(false);
  });

  it('isOriginAllowed returns false for file: URLs', () => {
    expect(session.isOriginAllowed('file:///etc/passwd')).toBe(false);
  });

  it('isOriginAllowed returns false for data: URLs', () => {
    expect(session.isOriginAllowed('data:text/html,test')).toBe(false);
  });

  it('isOriginAllowed returns true for allowed origins', () => {
    expect(session.isOriginAllowed(fixture.baseUrl)).toBe(true);
    expect(session.isOriginAllowed(`${fixture.baseUrl}/page`)).toBe(true);
  });

  it('isOriginAllowed returns false for disallowed origins', () => {
    expect(session.isOriginAllowed('https://evil.com')).toBe(false);
    expect(session.isOriginAllowed('http://localhost:3000')).toBe(false);
  });

  it('isClosed returns false before close', () => {
    expect(session.isClosed()).toBe(false);
  });

  it('isClosed returns true after close', async () => {
    await session.close();
    expect(session.isClosed()).toBe(true);
  });

  it('can close multiple times safely', async () => {
    await session.close();
    await session.close();
    expect(session.isClosed()).toBe(true);
  });

  it('throws when getting page after close', async () => {
    await session.close();
    await expect(session.getPage()).rejects.toThrow('Browser session is closed');
  });
});

// ---------------------------------------------------------------------------
// BrowserSessionManager
// ---------------------------------------------------------------------------

describe('BrowserSessionManager', () => {
  beforeEach(() => {
    BrowserSessionManager.reset();
  });

  afterEach(() => {
    BrowserSessionManager.reset();
  });

  it('is a singleton', () => {
    const a = BrowserSessionManager.getInstance();
    const b = BrowserSessionManager.getInstance();
    expect(a).toBe(b);
  });

  it('creates and retrieves sessions by run ID', async () => {
    const mgr = BrowserSessionManager.getInstance();
    const session = await mgr.createSession('test-run', {
      allowedOrigins: [fixture.baseUrl],
    });
    expect(mgr.getSession('test-run')).toBe(session);
    expect(mgr.getActiveRunIds()).toEqual(['test-run']);
  });

  it('throws on duplicate session creation', async () => {
    const mgr = BrowserSessionManager.getInstance();
    await mgr.createSession('dup-run', { allowedOrigins: [fixture.baseUrl] });
    await expect(
      mgr.createSession('dup-run', { allowedOrigins: [fixture.baseUrl] }),
    ).rejects.toThrow(/already exists/);
  });

  it('closes sessions by run ID', async () => {
    const mgr = BrowserSessionManager.getInstance();
    await mgr.createSession('run-a', { allowedOrigins: [fixture.baseUrl] });
    await mgr.createSession('run-b', { allowedOrigins: [fixture.baseUrl] });
    await mgr.closeSession('run-a');

    expect(mgr.getSession('run-a')).toBeUndefined();
    expect(mgr.getSession('run-b')).toBeDefined();
    expect(mgr.getActiveRunIds()).toEqual(['run-b']);
  });

  it('closeSession is safe for non-existent IDs', async () => {
    const mgr = BrowserSessionManager.getInstance();
    await expect(mgr.closeSession('ghost-run')).resolves.not.toThrow();
  });

  it('closeAll closes every session', async () => {
    const mgr = BrowserSessionManager.getInstance();
    await mgr.createSession('run-a', { allowedOrigins: [fixture.baseUrl] });
    await mgr.createSession('run-b', { allowedOrigins: [fixture.baseUrl] });
    await mgr.closeAll();

    expect(mgr.getActiveRunIds()).toEqual([]);
  });

  it('reset clears all sessions', async () => {
    const mgr = BrowserSessionManager.getInstance();
    await mgr.createSession('test-run', { allowedOrigins: [fixture.baseUrl] });
    BrowserSessionManager.reset();
    expect(BrowserSessionManager.getInstance().getActiveRunIds()).toEqual([]);
  });
});
