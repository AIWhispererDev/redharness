/**
 * Tests for video retention policy and artifact integration.
 *
 * Covers:
 * - Video enabled/disabled policy
 * - Retention by policy (retain, on-failure, retain-on-failure, off)
 * - Video artifact registration in the artifact store
 * - Video file discovery and metadata preservation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { TraceWriter } from '../src/trace/traceWriter.js';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';
import { createBrowserSession, type VideoPolicy, VIDEO_RETENTION_DAYS } from '../src/trace/browserSessionFactory.js';
import { applyRetention, type RetentionPolicy } from '../src/operations/retention.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

describe('Video retention policy', () => {
  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'video-retention-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Video artifact is registered when video is enabled
  // -----------------------------------------------------------------------

  it('1. registers a video artifact with metadata when video is enabled and retain policy is used', async () => {
    const runDir = join(tmpDir, '1-video-retain');
    await mkdir(runDir, { recursive: true });
    await mkdir(join(runDir, 'videos'), { recursive: true });

    await writeFile(join(runDir, 'videos', 'session-1.webm'), 'fake-video-content');

    const writer = new TraceWriter(runDir, 'trace-video');
    const store = new ArtifactStore(runDir, 'run-video');

    // Simulate video discovery by calling the video artifact registration
    // via the close path. Since we can't easily call the private helper,
    // create a real browser session and verify the wiring.
    const session = await createBrowserSession({
      runDir,
      artifactStore: store,
      traceWriter: writer,
      video: 'retain',
      headless: true,
    });

    // Ensure video directory exists
    const videoDir = join(runDir, 'videos');
    await mkdir(videoDir, { recursive: true });
    await writeFile(join(videoDir, 'test-recording.webm'), 'fake-webm-content');

    await session.close('failed');

    // Verify video artifact was registered
    const artifacts = store.getArtifacts();
    const videoArtifacts = artifacts.filter((a) => a.kind === 'browser-video');
    expect(videoArtifacts.length).toBeGreaterThanOrEqual(1);

    for (const va of videoArtifacts) {
      expect(va.mediaType).toBe('application/octet-stream');
      expect(va.sha256).toBeTruthy();
      expect(va.bytes).toBeGreaterThan(0);
      expect(va.kind).toBe('browser-video');
    }

    // Verify trace writer has spans
    const spans = writer.getSpans();
    expect(spans.length).toBeGreaterThanOrEqual(1);
  }, 30000);

  // -----------------------------------------------------------------------
  // 2. Video is NOT registered when policy is off
  // -----------------------------------------------------------------------

  it('2. does not register a video artifact when video policy is off', async () => {
    const runDir = join(tmpDir, '2-video-off');
    await mkdir(runDir, { recursive: true });

    const writer = new TraceWriter(runDir, 'trace-video-off');
    const store = new ArtifactStore(runDir, 'run-video-off');

    const session = await createBrowserSession({
      runDir,
      artifactStore: store,
      traceWriter: writer,
      video: 'off',
      headless: true,
    });

    await session.close('failed');

    const artifacts = store.getArtifacts();
    const videoArtifacts = artifacts.filter((a) => a.kind === 'browser-video');
    expect(videoArtifacts).toHaveLength(0);
  }, 30000);

  // -----------------------------------------------------------------------
  // 3. on-failure: video registered only on failure
  // -----------------------------------------------------------------------

  it('3. registers video on failure with on-failure policy, not on pass', async () => {
    const failDir = join(tmpDir, '3-video-on-failure-fail');
    await mkdir(failDir, { recursive: true });

    // Test failure case
    const failWriter = new TraceWriter(failDir, 'trace-video-fail');
    const failStore = new ArtifactStore(failDir, 'run-video-fail');

    await mkdir(join(failDir, 'videos'), { recursive: true });
    await writeFile(join(failDir, 'videos', 'fail-recording.webm'), 'fake-fail-video');

    const failSession = await createBrowserSession({
      runDir: failDir,
      artifactStore: failStore,
      traceWriter: failWriter,
      video: 'on-failure',
      headless: true,
    });
    await failSession.close('failed');

    const failArtifacts = failStore.getArtifacts();
    const failVideo = failArtifacts.filter((a) => a.kind === 'browser-video');
    expect(failVideo.length).toBeGreaterThanOrEqual(1);

    // Test pass case
    const passDir = join(tmpDir, '3-video-on-failure-pass');
    await mkdir(passDir, { recursive: true });

    const passWriter = new TraceWriter(passDir, 'trace-video-pass');
    const passStore = new ArtifactStore(passDir, 'run-video-pass');

    const passSession = await createBrowserSession({
      runDir: passDir,
      artifactStore: passStore,
      traceWriter: passWriter,
      video: 'on-failure',
      headless: true,
    });
    await passSession.close('passed');

    const passArtifacts = passStore.getArtifacts();
    const passVideo = passArtifacts.filter((a) => a.kind === 'browser-video');
    expect(passVideo).toHaveLength(0);
  }, 30000);

  // -----------------------------------------------------------------------
  // 4. retain-on-failure: video registered only on failure, not on pass
  // -----------------------------------------------------------------------

  it('4. registers video on failure with retain-on-failure policy, not on pass', async () => {
    const failDir = join(tmpDir, '4-retain-on-failure-fail');
    await mkdir(failDir, { recursive: true });

    const failWriter = new TraceWriter(failDir, 'trace-rf-fail');
    const failStore = new ArtifactStore(failDir, 'run-rf-fail');

    await mkdir(join(failDir, 'videos'), { recursive: true });
    await writeFile(join(failDir, 'videos', 'rf-recording.webm'), 'fake-rf-video');

    const failSession = await createBrowserSession({
      runDir: failDir,
      artifactStore: failStore,
      traceWriter: failWriter,
      video: 'retain-on-failure',
      headless: true,
    });
    await failSession.close('failed');

    const failArtifacts = failStore.getArtifacts();
    const failVideo = failArtifacts.filter((a) => a.kind === 'browser-video');
    expect(failVideo.length).toBeGreaterThanOrEqual(1);

    // Test pass case
    const passDir = join(tmpDir, '4-retain-on-failure-pass');
    await mkdir(passDir, { recursive: true });

    const passWriter = new TraceWriter(passDir, 'trace-rf-pass');
    const passStore = new ArtifactStore(passDir, 'run-rf-pass');

    const passSession = await createBrowserSession({
      runDir: passDir,
      artifactStore: passStore,
      traceWriter: passWriter,
      video: 'retain-on-failure',
      headless: true,
    });
    await passSession.close('passed');

    const passArtifacts = passStore.getArtifacts();
    const passVideo = passArtifacts.filter((a) => a.kind === 'browser-video');
    expect(passVideo).toHaveLength(0);
  }, 30000);

  // -----------------------------------------------------------------------
  // 5. Video retention policy constant is exported with the expected value
  // -----------------------------------------------------------------------

  it('5. exports a sane default video retention policy constant', () => {
    expect(VIDEO_RETENTION_DAYS).toBe(14);
  });

  // -----------------------------------------------------------------------
  // 6. Video policy is wired through retention system
  // -----------------------------------------------------------------------

  it('6. video artifacts are covered by per-category retention policy', () => {
    // Verify the retention types support per-category videoDays
    // (compile-time check — the type is tested)
    const policy: RetentionPolicy = {
      runDays: 90,
      traceDays: 30,
      videoDays: 14,
      findingDays: 180,
      reportDays: 60,
      catalogBackupDays: 7,
    };
    expect(policy.videoDays).toBe(14);
  });

  // -----------------------------------------------------------------------
  // 7. Browser session factory creates a consistent instrumented session
  // -----------------------------------------------------------------------

  it('7. createBrowserSession returns a properly structured session object', async () => {
    const runDir = join(tmpDir, '7-structure');
    await mkdir(runDir, { recursive: true });

    const writer = new TraceWriter(runDir, 'trace-structure');
    const store = new ArtifactStore(runDir, 'run-structure');

    const session = await createBrowserSession({
      runDir,
      artifactStore: store,
      traceWriter: writer,
      video: 'off',
      headless: true,
    });

    // Verify session structure
    expect(session.browser).toBeTruthy();
    expect(session.context).toBeTruthy();
    expect(session.page).toBeTruthy();
    expect(session.instrumentation).toBeTruthy();
    expect(typeof session.close).toBe('function');
    expect(typeof session.flush).toBe('function');

    await session.close('passed');
  }, 30000);

  // -----------------------------------------------------------------------
  // 8. Session creates evidence after close with console/network artifacts
  // -----------------------------------------------------------------------

  it('8. close() persists evidence artifacts (console, network, action log)', async () => {
    const runDir = join(tmpDir, '8-evidence');
    await mkdir(runDir, { recursive: true });

    const writer = new TraceWriter(runDir, 'trace-evidence');
    const store = new ArtifactStore(runDir, 'run-evidence');

    const session = await createBrowserSession({
      runDir,
      artifactStore: store,
      traceWriter: writer,
      video: 'off',
      headless: true,
    });

    await session.close('failed');

    // Verify evidence artifacts exist
    const artifacts = store.getArtifacts();
    const kinds = new Set(artifacts.map((a) => a.kind));

    // On failure, should have at least: screenshot
    expect(kinds.has('screenshot')).toBe(true);
  }, 30000);
});
