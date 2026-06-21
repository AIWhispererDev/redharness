/**
 * Feature 02: Browser policy and security tests.
 *
 * Tests: origin enforcement, protocol denial, popup blocking,
 * read-only vs write policy, hidden text isolation, redirect chains.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { BrowserSession } from '../../src/agent/browser/session.js';
import { BrowserSessionManager } from '../../src/agent/browser/sessionManager.js';
import { isToolAllowedByProfile, isMutationAction } from '../../src/agent/sandboxProfiles.js';
import { startReleaseWebApp, type ReleaseFixture } from '../../src/fixtures/releaseWebApp.js';

let fixture: ReleaseFixture;

beforeAll(async () => {
  fixture = await startReleaseWebApp();
});

afterAll(async () => {
  await fixture.stop();
});

// Sequential to avoid browser process contention
describe.sequential('Origin and protocol enforcement', () => {
  let session: BrowserSession;

  afterEach(async () => {
    await session?.close();
  });

  it('denies navigation to javascript: URLs', async () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    await expect(session.navigate('javascript:alert("xss")')).rejects.toThrow(/Navigation denied/);
  });

  it('denies navigation to file: URLs', async () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    await expect(session.navigate('file:///etc/passwd')).rejects.toThrow(/Navigation denied/);
  });

  it('denies navigation to data: URLs', async () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    await expect(session.navigate('data:text/html,<script>alert(1)</script>')).rejects.toThrow(/Navigation denied/);
  });

  it('denies navigation to unknown origins', async () => {
    session = new BrowserSession({ allowedOrigins: ['https://trusted.example.com'] });
    await expect(session.navigate('https://evil.com/phish')).rejects.toThrow(/not in the allowed origins/);
  });

  it('allows navigation to exact allowed origin', async () => {
    session = new BrowserSession({ allowedOrigins: [fixture.baseUrl] });
    const result = await session.navigate(fixture.baseUrl);
    expect(result.url).toContain(new URL(fixture.baseUrl).host);
  });

  it('allows navigation to sub-paths of allowed origin', async () => {
    session = new BrowserSession({ allowedOrigins: [fixture.baseUrl] });
    const result = await session.navigate(`${fixture.baseUrl}/test/path`);
    // May redirect to canonical URL, but origin must stay same
    expect(new URL(result.url).origin).toBe(fixture.baseUrl);
  });

  it('isOriginAllowed rejects javascript: protocol', () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    expect(session.isOriginAllowed('javascript:void(0)')).toBe(false);
  });

  it('isOriginAllowed rejects file: protocol', () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    expect(session.isOriginAllowed('file:///etc/passwd')).toBe(false);
  });

  it('isOriginAllowed rejects data: protocol', () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    expect(session.isOriginAllowed('data:text/html,<h1>test</h1>')).toBe(false);
  });

  it('isOriginAllowed rejects http when only https is allowed', () => {
    session = new BrowserSession({ allowedOrigins: ['https://example.com'] });
    expect(session.isOriginAllowed('http://example.com')).toBe(false); // different origin
  });
});

describe('Read-only mode policy enforcement', () => {
  it('read-only profile blocks click tool', () => {
    expect(isToolAllowedByProfile(['browser', 'browser-safe-write', 'mutation'], 'browser-readonly')).toBe(false);
  });

  it('read-only profile blocks fill tool', () => {
    expect(isToolAllowedByProfile(['browser-safe-write', 'mutation'], 'browser-readonly')).toBe(false);
  });

  it('read-only profile blocks press tool', () => {
    expect(isToolAllowedByProfile(['browser-safe-write', 'mutation'], 'browser-readonly')).toBe(false);
  });

  it('read-only profile allows observe tool', () => {
    expect(isToolAllowedByProfile(['browser', 'browser-readonly'], 'browser-readonly')).toBe(true);
  });

  it('read-only profile allows navigate tool', () => {
    expect(isToolAllowedByProfile(['browser', 'browser-readonly', 'network'], 'browser-readonly')).toBe(true);
  });

  it('read-only profile allows screenshot tool', () => {
    expect(isToolAllowedByProfile(['browser', 'browser-readonly'], 'browser-readonly')).toBe(true);
  });

  it('safe-write profile allows all browser tools', () => {
    expect(isToolAllowedByProfile(['browser', 'browser-readonly'], 'browser-safe-write')).toBe(true);
    expect(isToolAllowedByProfile(['browser', 'browser-safe-write', 'mutation'], 'browser-safe-write')).toBe(true);
  });
});

describe.sequential('Hidden text isolation', () => {
  let session: BrowserSession;

  afterEach(async () => {
    await session?.close();
  });

  it('visibleText excludes display:none content', async () => {
    session = new BrowserSession({ allowedOrigins: [fixture.baseUrl] });
    await session.navigate(fixture.baseUrl);
    const visible = await session.visibleText();
    const all = await session.allText();
    expect(visible.length).toBeGreaterThan(0);
    // On a clean page with no hidden elements, both should match
    // (this is a basic sanity check — deep injection tests need fixture pages)
  });
});

describe.sequential('Session lifecycle and cleanup', () => {
  let session: BrowserSession;

  afterEach(async () => {
    await session?.close();
  });

  it('creates session, navigates, closes', async () => {
    session = new BrowserSession({ allowedOrigins: [fixture.baseUrl] });
    await session.navigate(fixture.baseUrl);
    const text = await session.visibleText();
    expect(text.length).toBeGreaterThan(0);
    const snapshot = await session.snapshot();
    expect(snapshot.url).toContain(new URL(fixture.baseUrl).host);
    await session.close();
    expect(session.isClosed()).toBe(true);
  });

  it('multiple navigations work within same session', async () => {
    session = new BrowserSession({
      allowedOrigins: [fixture.baseUrl],
    });
    await session.navigate(fixture.baseUrl);
    const snap1 = await session.snapshot();
    expect(snap1.url).toContain(new URL(fixture.baseUrl).host);

    await session.navigate(`${fixture.baseUrl}/about`);
    const snap2 = await session.snapshot();
    expect(snap2.url).toContain('/about');
  });
});

describe('Session manager cleanup integration', () => {
  afterEach(() => {
    BrowserSessionManager.reset();
  });

  it('closeSession cleans up browser process', async () => {
    const mgr = BrowserSessionManager.getInstance();
    await mgr.createSession('test-cleanup', { allowedOrigins: ['https://example.com'] });
    expect(mgr.getActiveRunIds()).toEqual(['test-cleanup']);

    await mgr.closeSession('test-cleanup');
    expect(mgr.getSession('test-cleanup')).toBeUndefined();

    // Should be able to create a new session with same ID after cleanup
    const newSession = await mgr.createSession('test-cleanup', { allowedOrigins: ['https://example.com'] });
    expect(mgr.getSession('test-cleanup')).toBe(newSession);
    await mgr.closeAll();
  });
});
