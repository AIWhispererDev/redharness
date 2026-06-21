import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDiscoveryResult,
  discoverUrl,
  writeDiscoveredPack,
  type DiscoveredPage,
} from '../src/discovery/urlDiscovery.js';
import { loadScenariosFromDir } from '../src/scenarios/loader.js';
import { computeDatasetHash } from '../src/datasets/manifest.js';
import {
  packIdFromUrl,
  renderUrlTestSummary,
  terminalUrlTestSummary,
  testUrl,
} from '../src/discovery/urlTest.js';
import { createFixtureApp } from './fixtures/web-app/index.js';
import { startFixture, type FixtureHandle } from './fixtures/fixtureLifecycle.js';
import http from 'node:http';

const cleanup: string[] = [];
let fixture: FixtureHandle | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('URL discovery', () => {
  it('generates safe page checks and review-required non-destructive interactions', () => {
    const result = buildDiscoveryResult({
      baseUrl: 'https://example.test/',
      origin: 'https://example.test',
      startedAt: '2026-06-21T00:00:00.000Z',
      pages: [page()],
    });

    expect(result.executableScenarios).toHaveLength(1);
    expect(result.executableScenarios[0].expected).toEqual(expect.arrayContaining([
      expect.objectContaining({ assertion: 'no_console_errors' }),
      expect.objectContaining({ assertion: 'no_failed_requests' }),
      { assertion: 'no_server_errors' },
    ]));
    expect(result.interactionDrafts.map((draft) => draft.title)).toContain(
      'Connect Wallet interaction remains healthy',
    );
    expect(result.interactionDrafts.map((draft) => draft.title)).not.toContain(
      'Buy Bananas interaction remains healthy',
    );
  });

  it('writes a runnable pack, immutable dataset hash, and separate review queue', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'url-discovery-'));
    cleanup.push(root);
    const result = buildDiscoveryResult({
      baseUrl: 'https://example.test/',
      origin: 'https://example.test',
      startedAt: '2026-06-21T00:00:00.000Z',
      pages: [page()],
    });

    await writeDiscoveredPack(result, {
      outputDir: root,
      packId: 'example',
      packName: 'Example',
    });

    const datasetDir = path.join(root, 'datasets', 'discovered');
    const manifest = YAML.parse(await readFile(path.join(datasetDir, 'dataset.yaml'), 'utf8'));
    const scenarios = await loadScenariosFromDir(datasetDir);
    const reviewQueue = YAML.parse(await readFile(path.join(root, 'review-queue.yaml'), 'utf8'));

    expect(manifest.splits.smoke).toEqual(['landing-page-health']);
    expect(manifest.contentHash).toBe(computeDatasetHash(scenarios));
    expect(reviewQueue.drafts).toHaveLength(1);
    await expect(readFile(
      path.join(datasetDir, 'drafts', 'landing-connect-wallet.yaml'),
      'utf8',
    )).resolves.toContain('reviewStatus: draft');
  });

  it('crawls same-origin pages in a real browser and excludes API links from interaction drafts', async () => {
    fixture = await startFixture(() => createFixtureApp());
    const result = await discoverUrl(fixture.baseUrl, { maxPages: 5 });

    expect(result.pages.map((candidate) => candidate.route)).toEqual(
      expect.arrayContaining(['/', '/dashboard', '/form']),
    );
    expect(result.pages.every((candidate) => candidate.url.startsWith(fixture!.baseUrl))).toBe(true);
    expect(result.executableScenarios.length).toBe(result.pages.length);
  }, 20_000);

  it('executes safe JavaScript buttons and discovers navigation plus dialogs', async () => {
    fixture = await startFixture(() => http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      if (req.url === '/signin') {
        res.end('<html><head><title>Sign In</title></head><body><h1>Sign In to ScholarXP</h1></body></html>');
        return;
      }
      res.end(`<html><head><title>Interactive App</title></head><body>
        <h1>Welcome</h1>
        <button onclick="location.href='/signin'">Sign In</button>
        <button onclick="document.querySelector('dialog').showModal()">Learn More</button>
        <dialog><h2>How It Works</h2><p>Three simple steps.</p></dialog>
      </body></html>`);
    }));

    const result = await discoverUrl(fixture.baseUrl, { maxPages: 5 });

    expect(result.pages.map((candidate) => candidate.route)).toContain('/signin');
    expect(result.interactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: 'navigation', finalRoute: '/signin' }),
      expect.objectContaining({
        outcome: 'dialog',
        marker: expect.stringContaining('How It Works'),
      }),
    ]));
    expect(result.executableScenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining([
        'landing-sign-in-observed',
        'landing-learn-more-observed',
      ]),
    );
    expect(result.interactionDrafts).toHaveLength(0);
  }, 20_000);

  it('runs the zero-config functional workflow without a pre-authored pack', async () => {
    fixture = await startFixture(() => createFixtureApp());
    const root = await mkdtemp(path.join(tmpdir(), 'url-test-'));
    cleanup.push(root);
    const result = await testUrl(fixture.baseUrl, {
      outputDir: root,
      maxPages: 3,
      security: false,
      blackbox: false,
    });

    expect(result.status).toBe('passed');
    expect(result.functional).toHaveLength(3);
    expect(result.functional.every((item) => item.status === 'passed')).toBe(true);
    await expect(readFile(path.join(root, 'summary.json'), 'utf8')).resolves.toContain(
      '"status": "passed"',
    );
  }, 30_000);

  it('derives stable pack IDs from URLs', () => {
    expect(packIdFromUrl('https://www.gorilla-moverz.xyz/path')).toBe('gorilla-moverz-xyz');
  });

  it('explains findings, review drafts, and empty blackbox coverage', () => {
    const discovery = buildDiscoveryResult({
      baseUrl: 'https://example.test/',
      origin: 'https://example.test',
      startedAt: '2026-06-21T00:00:00.000Z',
      pages: [page()],
    });
    const result = {
      status: 'failed' as const,
      outputDir: 'artifacts/example',
      packDir: 'artifacts/example/generated-pack',
      discovery,
      functional: [{
        scenarioId: 'landing',
        title: 'Landing page',
        status: 'failed' as const,
        trials: [{
          trial: 1,
          status: 'failed' as const,
          assertions: [{
            name: 'no_failed_requests',
            passed: false,
            message: '1 failed request observed',
          }],
          grades: [],
          startedAt: '',
          endedAt: '',
          durationMs: 1,
          evidence: [],
        }],
        startedAt: '',
        endedAt: '',
        durationMs: 1,
        graderVersions: [],
        reliability: {
          attemptedTrials: 1,
          completedTrials: 1,
          successCount: 0,
          successRate: 0,
          passAt1: 0,
          passAtK: 0,
          k: 1,
          medianLatencyMs: 1,
          p95LatencyMs: 1,
          wilsonLower: 0,
          wilsonUpper: 1,
        },
        evidence: [],
      }],
      security: {
        ok: false,
        skipped: false,
        checks: [{
          name: 'Content-Security-Policy header present',
          ok: false,
          details: ['CSP missing'],
          severity: 'medium' as const,
          category: 'headers' as const,
        }],
        artifacts: [],
      },
      blackbox: {
        ok: true,
        checks: [],
        artifacts: [],
        routes: ['/'],
      },
    };

    expect(renderUrlTestSummary(result)).toContain('## Security findings');
    expect(renderUrlTestSummary(result)).toContain('Blackbox checks: not applicable');
    expect(terminalUrlTestSummary(result)).toContain(
      '  FINDING medium: Content-Security-Policy header present',
    );
  });

  it('surfaces observed no-op controls as suspected functional findings', () => {
    const discovery = buildDiscoveryResult({
      baseUrl: 'https://example.test/',
      origin: 'https://example.test',
      startedAt: '2026-06-21T00:00:00.000Z',
      pages: [page()],
      interactions: [{
        sourceUrl: 'https://example.test/',
        sourceRoute: '/',
        control: { kind: 'button', role: 'button', name: 'Learn More' },
        outcome: 'no-change',
        finalUrl: 'https://example.test/',
        finalRoute: '/',
        consoleErrors: [],
        failedRequests: [],
        serverErrors: [],
      }],
    });
    const lines = terminalUrlTestSummary({
      status: 'failed',
      outputDir: 'artifacts/example',
      packDir: 'artifacts/example/generated-pack',
      discovery,
      functional: [],
    });

    expect(lines).toContain(
      '  SUSPECT functional: Learn More — click produced no navigation, visible content, dialog, or scroll change',
    );
  });
});

function page(): DiscoveredPage {
  return {
    url: 'https://example.test/',
    route: '/',
    title: 'Banana Farm',
    headings: ['Welcome to Banana Farm'],
    textSample: 'Welcome to Banana Farm. Connect your wallet to continue.',
    consoleErrors: [],
    failedRequests: [],
    serverErrors: [],
    controls: [
      {
        kind: 'button',
        role: 'button',
        name: 'Connect Wallet',
        text: 'Connect Wallet',
      },
      {
        kind: 'button',
        role: 'button',
        name: 'Buy Bananas',
        text: 'Buy Bananas',
      },
    ],
  };
}
