/**
 * Shared browser session factory that provides consistent browser context
 * creation with tracing, video, console/network capture, and semantic action
 * logging for every suite.
 *
 * Replaces the ad-hoc Playwright setup scattered across individual smoke
 * suites with a unified factory that wires evidence capture and artifact
 * registration in one place.
 */

import path from 'node:path';
import { mkdir, access } from 'node:fs/promises';
import { chromium, type Browser, type BrowserContext, type Page, type BrowserContextOptions } from 'playwright';
import type { ArtifactStore } from '../artifacts/artifactStore.js';
import { BrowserInstrumentation } from './browserInstrumentation.js';
import type { BrowserInstrumentationOptions } from './browserInstrumentation.js';
import type { TraceWriter } from './traceWriter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VideoPolicy = 'on' | 'off' | 'on-failure' | 'retain' | 'retain-on-failure';

export type BrowserSessionConfig = {
  /** Run/scoped output directory. */
  runDir: string;
  /** Attempt-scoped artifact store. */
  artifactStore: ArtifactStore;
  /** Run-scoped trace writer. */
  traceWriter: TraceWriter;
  /** Video recording policy. */
  video?: VideoPolicy;
  /** Playwright storage state path (for authenticated sessions). */
  storageState?: string;
  /** Whether to run headless. */
  headless?: boolean;
  /** Viewport size. */
  viewport?: { width: number; height: number };
  /** Record/replay options. */
  captureConsole?: boolean;
  captureNetwork?: boolean;
  captureScreenshots?: boolean;
  retainTraceOnSuccess?: boolean;
  /** Additional context options passed directly to browser.newContext(). */
  extraContextOptions?: Partial<BrowserContextOptions>;
};

export type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  instrumentation: BrowserInstrumentation;
  /** Full path to the video file if video was enabled, undefined otherwise. */
  videoPath?: string;
  /** Close the session — stops tracing, saves evidence, closes browser. */
  close: (outcome: 'passed' | 'failed' | 'error' | 'cancelled') => Promise<void>;
  /** Flush instrumentation without closing. */
  flush: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Default video retention policy (in days)
// ---------------------------------------------------------------------------

export const VIDEO_RETENTION_DAYS = 14;

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a shared browser session with consistent evidence wiring.
 *
 * Every session gets:
 * - Playwright built-in tracing (screenshots + snapshots)
 * - Console message capture
 * - Network failure/error capture
 * - Semantic action recording
 * - Optional video recording
 * - Proper artifact registration for all captured evidence
 *
 * Call `session.close(outcome)` when done to flush evidence and clean up.
 */
export async function createBrowserSession(
  config: BrowserSessionConfig,
): Promise<BrowserSession> {
  const {
    runDir,
    artifactStore,
    traceWriter,
    video = 'off',
    storageState,
    headless = true,
    viewport = { width: 1280, height: 900 },
    captureConsole = true,
    captureNetwork = true,
    captureScreenshots = true,
    retainTraceOnSuccess = false,
    extraContextOptions,
  } = config;

  // Determine video directory and context options
  const videoDir = path.resolve(runDir, 'videos');
  const contextOptions: BrowserContextOptions = {
    viewport,
    ...extraContextOptions,
    recordVideo: video !== 'off' ? { dir: videoDir } : undefined,
  };

  // Apply storage state if provided
  if (storageState) {
    try {
      await access(storageState);
      contextOptions.storageState = storageState;
    } catch {
      // Storage state file not found — proceed without it
    }
  }

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  // Create instrumentation instance
  const instOptions: BrowserInstrumentationOptions = {
    captureConsole,
    captureNetwork,
    captureScreenshots,
    captureVideo: video !== 'off',
    retainTraceOnSuccess,
  };

  const instrumentation = new BrowserInstrumentation(
    traceWriter,
    artifactStore,
    runDir,
    instOptions,
  );

  // Attach instrumentation to the session
  const spanId = await instrumentation.instrument(context, page);

  // Register video artifact reference when video is enabled
  let videoPath: string | undefined;
  if (video !== 'off') {
    videoPath = videoDir;
  }

  return {
    browser,
    context,
    page,
    instrumentation,
    videoPath,

    close: async (outcome: 'passed' | 'failed' | 'error' | 'cancelled') => {
      // Register video artifact if applicable
      if (video !== 'off' && videoPath) {
        await registerVideoArtifact(
          context,
          artifactStore,
          traceWriter,
          spanId,
          video,
          outcome,
        );
      }

      // Capture evidence (screenshot on failure, trace, console, network)
      await instrumentation.captureEvidence(page, outcome);
      await instrumentation.flush();
      await traceWriter.flush();

      // Close browser
      await context.close();
      await browser.close();
    },

    flush: async () => {
      await instrumentation.flush();
      await traceWriter.flush();
    },
  };
}

// ---------------------------------------------------------------------------
// Video artifact registration
// ---------------------------------------------------------------------------

/**
 * Register the video file as an artifact in the store.
 *
 * Respects the retention policy:
 * - `retain`: always register the video artifact
 * - `retain-on-failure`: register only for non-passed outcomes
 * - `on-failure` / `on`: register video artifact (controlled by policy later)
 */
async function registerVideoArtifact(
  context: BrowserContext,
  store: ArtifactStore,
  traceWriter: TraceWriter,
  spanId: string,
  policy: VideoPolicy,
  outcome: 'passed' | 'failed' | 'error' | 'cancelled',
): Promise<void> {
  // Determine whether to retain based on policy
  const shouldRetain =
    policy === 'retain' ||
    policy === 'retain-on-failure' ||
    (policy === 'on-failure' && outcome !== 'passed') ||
    (policy === 'on' && outcome !== 'passed');

  if (!shouldRetain) return;

  // Find the video file where Playwright stores it.
  // The videoDir is a sibling of the artifact store's base directory.
  const videoDir = path.resolve(store.getBaseDir(), 'videos');
  try {
    const { readdir, stat } = await import('node:fs/promises');
    const files = await readdir(videoDir);
    const videoFiles = files.filter(
      (f) => f.endsWith('.webm'),
    );

    for (const videoFile of videoFiles) {
      const filePath = path.join(videoDir, videoFile);
      try {
        await stat(filePath);
        await store.copy(filePath, 'browser-video', videoFile, {
          traceId: traceWriter.getTraceId(),
          spanId,
          subDir: 'browser-evidence',
        });
      } catch {
        // File may be incomplete if browser closed abruptly
      }
    }
  } catch {
    // Video directory may not exist
  }
}


