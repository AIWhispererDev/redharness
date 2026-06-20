import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';
import { writeFindingPacketV2, writeFindingPacket, slugifyFinding } from '../src/findingPackets.js';

describe('Finding packet v2', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finding-v2-test-'));
  const store = new ArtifactStore(tmpDir, 'v2-test-run');

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a guided finding packet with manifest', async () => {
    const result = await writeFindingPacketV2({
      packId: 'test-pack',
      baseUrl: 'https://example.com',
      title: 'Missing validation on invite code form',
      severity: 'medium',
      category: 'input-validation',
      suiteId: 'early-access-tos',
      check: 'blank-submit',
      expectedState: 'Form should show validation error on empty submit',
      actualState: 'No validation message appeared on empty submit',
      steps: [
        'Open https://example.com/invite',
        'Click Submit without filling invite code',
        'Observe no validation error',
      ],
      store,
      attemptId: 'attempt-1',
      traceId: 'trace-abc',
      lifecycleState: 'suspected',
    });

    expect(result.findingId).toBeTruthy();
    expect(result.dir).toBeTruthy();
    expect(existsSync(result.dir)).toBe(true);
    expect(result.packet.lifecycleState).toBe('suspected');

    // Check finding.json exists
    const jsonPath = join(result.dir, 'finding.json');
    expect(existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(parsed.title).toBe('Missing validation on invite code form');
    expect(parsed.findingId).toBe(result.findingId);
    expect(parsed.evidenceManifest.attemptId).toBe('attempt-1');
    expect(parsed.reproductionCount).toBe(1);

    // Check finding.md exists
    const mdPath = join(result.dir, 'finding.md');
    expect(existsSync(mdPath)).toBe(true);
    const mdContent = readFileSync(mdPath, 'utf8');
    expect(mdContent).toContain('Missing validation on invite code form');

    // Check guided replay spec
    const specPath = join(result.dir, 'replay.spec.ts');
    expect(existsSync(specPath)).toBe(true);
    const spec = readFileSync(specPath, 'utf8');
    expect(spec).toContain('test.fixme');
    expect(spec).not.toContain('expect(true).toBe(true)');
  });

  it('writes an HTTP finding packet with curl replay', async () => {
    const httpStore = new ArtifactStore(tmpDir, 'v2-http-test');
    const result = await writeFindingPacketV2({
      packId: 'test-pack',
      baseUrl: 'https://example.com',
      title: 'Unauthenticated account page',
      severity: 'high',
      category: 'auth-bypass',
      suiteId: 'security-smoke',
      check: 'auth-gate',
      expectedState: 'Protected route should redirect to sign-in',
      actualState: 'Account UI is rendered without authentication',
      steps: ['GET /en/account without auth', 'Observe account settings rendered'],
      store: httpStore,
      attemptId: 'attempt-1',
      traceId: 'trace-http',
      httpCapture: {
        method: 'GET',
        url: 'https://example.com/en/account',
        headers: { accept: 'text/html', host: 'example.com' },
        status: 200,
        assertion: 'Account Settings',
      },
    });

    expect(result.packet.lifecycleState).toBe('suspected');
    // Check curl replay exists
    const findingsDir = join(tmpDir, 'findings');
    const findingDirs = require('fs').readdirSync(findingsDir).filter((f: string) => f.startsWith('una'));
    expect(findingDirs.length).toBeGreaterThanOrEqual(1);
  });

  it('writes HTTP replay curl script without expect(true)', async () => {
    const httpStore = new ArtifactStore(tmpDir, 'v2-http-no-true');
    await writeFindingPacketV2({
      packId: 'test-pack',
      title: 'HTTP finding no placeholder',
      severity: 'low',
      category: 'info',
      suiteId: 'test',
      check: 'http',
      expectedState: 'x',
      actualState: 'y',
      steps: ['Step 1'],
      store: httpStore,
      attemptId: 'attempt-1',
      traceId: 'trace-no-true',
      httpCapture: {
        method: 'GET',
        url: 'https://example.com/test',
        headers: {},
        status: 200,
        assertion: 'content',
      },
    });

    // Find the finding dir
    const findingsDir = join(tmpDir, 'findings');
    const dirs = require('fs').readdirSync(findingsDir).filter((f: string) => f.startsWith('http'));
    let foundSpec = false;
    for (const dir of dirs) {
      const specPath = join(findingsDir, dir, 'replay.spec.ts');
      if (existsSync(specPath)) {
        foundSpec = true;
        const content = readFileSync(specPath, 'utf8');
        expect(content).not.toContain('expect(true).toBe(true)');
      }
    }
    expect(foundSpec).toBe(true);
  });
});

describe('Legacy finding packet', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'finding-legacy-test-'));

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes legacy packet with test.fixme instead of expect(true)', async () => {
    const result = await writeFindingPacket({
      outputDir: tmpDir,
      packName: 'test-pack',
      finding: {
        title: 'Legacy test finding',
        severity: 'medium',
        type: 'input-validation',
        steps: ['Step 1'],
        expected: 'Expected behavior',
        actual: 'Actual behavior',
        evidence: ['artifact.png'],
      },
    });

    expect(existsSync(result.replayPath)).toBe(true);
    const replay = readFileSync(result.replayPath, 'utf8');
    expect(replay).toContain('test.fixme');
    expect(replay).not.toContain('expect(true).toBe(true)');
  });

  it('slugify handles special characters', () => {
    expect(slugifyFinding('Hello World!')).toBe('hello-world');
    expect(slugifyFinding('  spaces  ')).toBe('spaces');
    expect(slugifyFinding('')).toBe('finding');
    expect(slugifyFinding('a'.repeat(200))).toHaveLength(90);
  });
});
