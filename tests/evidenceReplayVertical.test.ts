/**
 * PRD 08: Evidence/replay vertical slice integration test.
 *
 * Tests the full chain:
 *   fixture → browser scenario with planted defect → screenshot/trace evidence
 *   → finding packet → HTTP+browser replay confirmation → confirmation evidence
 *   → lifecycle state update → redaction at write time
 *
 * Every scenario plants a real defect, runs through the entire pipeline,
 * and verifies evidence at each stage.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createFixtureApp } from './fixtures/web-app/index.js';
import { startFixtureWithHealthCheck, type FixtureHandle } from './fixtures/fixtureLifecycle.js';
import { TraceWriter } from '../src/trace/traceWriter.js';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';
import { BrowserInstrumentation } from '../src/trace/browserInstrumentation.js';
import { writeFindingPacketV2 } from '../src/findingPackets.js';
import { confirmFinding, confirmFromPacket } from '../src/replay/confirmationRunner.js';
import type { ReplaySpec, FindingPacketV2, RecordedAction, AssertionRecipe } from '../src/trace/traceTypes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Read a finding packet from disk. */
async function readFindingPacket(dir: string): Promise<FindingPacketV2> {
  return JSON.parse(await readFile(join(dir, 'finding.json'), 'utf8')) as FindingPacketV2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let v1Fixture: FixtureHandle;
let v2Fixture: FixtureHandle;
let tmpDir: string;

describe('Evidence/replay vertical slice', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evidence-replay-'));
    v1Fixture = await startFixtureWithHealthCheck(() => createFixtureApp(false));
    v2Fixture = await startFixtureWithHealthCheck(() => createFixtureApp(true));
  }, 15000);

  afterAll(async () => {
    await v1Fixture.stop();
    await v2Fixture.stop();
    await rm(tmpDir, { recursive: true, force: true });
  }, 10000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 1. Planted browser defect → capture trace + screenshot → replay → confirm
  // ─────────────────────────────────────────────────────────────────────────────

  it('1. plants a browser-visible defect, traces it, replays, and confirms', async () => {
    const runDir = join(tmpDir, '1-browser-defect');
    await mkdir(runDir, { recursive: true });
    const store = new ArtifactStore(runDir, 'run-browser-defect');
    const traceWriter = new TraceWriter(runDir, 'trace-browser-defect');

    // Use v2 fixture which has a regression: /dashboard returns 403 "Access Denied"
    // instead of 401 "Sign In Required". We'll detect the wrong status/message.
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    const inst = new BrowserInstrumentation(traceWriter, store, runDir);
    await inst.instrument(context, page);

    // Planted defect: navigate to /dashboard without auth on v2
    await page.goto(`${v2Fixture.baseUrl}/dashboard`);
    const pageText = await page.locator('body').innerText();

    // v2 returns 403 "Access Denied" — this is the regression we detect
    const hasAccessDenied = pageText.includes('Access Denied');
    expect(hasAccessDenied).toBe(true);

    // The correct v1 behavior is 401 "Sign In Required" — v2 breaks it
    const hasCorrectMessage = pageText.includes('Sign In Required');
    expect(hasCorrectMessage).toBe(false);

    // Capture evidence (simulating defect found)
    await inst.captureEvidence(page, 'failed');

    // Verify screenshot was written to artifact store
    const screenshotArtifacts = store.getArtifacts().filter((a) => a.kind === 'screenshot');
    expect(screenshotArtifacts.length).toBeGreaterThanOrEqual(1);
    expect(screenshotArtifacts[0].bytes).toBeGreaterThan(0);

    const traceArtifacts = store.getArtifacts().filter((a) => a.kind === 'playwright-trace');
    expect(traceArtifacts).toHaveLength(1);
    expect(existsSync(join(runDir, traceArtifacts[0].relativePath))).toBe(true);
    expect(statSync(join(runDir, traceArtifacts[0].relativePath)).size).toBeGreaterThan(0);

    // Verify action log
    const actionLog = inst.getActionLog();
    expect(actionLog.length).toBeGreaterThanOrEqual(1);
    expect(actionLog.some((a) => a.type === 'goto' || a.type === 'click')).toBe(true);

    await inst.flush();
    await traceWriter.flush();
    await browser.close();

    // Write finding packet for the v2 regression
    const recordedActions: RecordedAction[] = [
      { type: 'goto', url: `${v2Fixture.baseUrl}/dashboard` },
    ];
    const assertion: AssertionRecipe = {
      type: 'text',
      locator: { css: 'h1' },
      value: 'Access Denied',
    };

    const packetResult = await writeFindingPacketV2({
      packId: 'test-pack',
      title: 'V2 dashboard auth regression — returns 403 Access Denied instead of 401 Sign In',
      severity: 'high',
      category: 'regression',
      suiteId: 'vertical-slice',
      check: 'auth-regression',
      expectedState: 'Unauthenticated dashboard access returns 401 with "Sign In Required"',
      actualState: 'Unauthenticated dashboard access returns 403 with "Access Denied"',
      steps: ['Open /dashboard without auth header', 'Observe 403 status and "Access Denied" text'],
      store,
      attemptId: 'attempt-1',
      traceId: traceWriter.getTraceId(),
      recordedActions,
      assertion,
      lifecycleState: 'suspected',
    });

    // Confirm the browser defect via replay
    const confirmResult = await confirmFromPacket(packetResult.dir, {
      maxAttempts: 1,
    });

    expect(confirmResult.reproduced).toBe(true);
    expect(confirmResult.lifecycleState).toBe('confirmed-semantic');
    expect(confirmResult.attempts).toBe(1);

    // Verify confirmation evidence directory has attempt data
    const confirmDir = join(packetResult.dir, 'confirmations');
    expect(existsSync(confirmDir)).toBe(true);

    // Verify the persisted finding.json reflects the confirmation
    const updatedPacket = await readFindingPacket(packetResult.dir);
    expect(updatedPacket.lifecycleState).toBe('confirmed-semantic');
    expect(updatedPacket.confirmationAttemptIds).toHaveLength(1);
    expect(updatedPacket.reproductionCount).toBe(2);

    // Verify evidence manifest has link to trace
    expect(updatedPacket.evidenceManifest.traceId).toBeTruthy();
    expect(updatedPacket.evidenceManifest.artifacts.length).toBeGreaterThanOrEqual(1);
  }, 60000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. Planted HTTP fixture defect → finding → replay → state update
  // ─────────────────────────────────────────────────────────────────────────────

  it('2. plants an HTTP defect, finds it, persists findings with replay-linked evidence, and updates lifecycle state', async () => {
    const runDir = join(tmpDir, '2-http-defect');
    await mkdir(runDir, { recursive: true });
    const store = new ArtifactStore(runDir, 'run-http-defect');

    // Planted defect: v2 accepts an empty form submission that v1 rejects.
    const httpCapture = {
      method: 'POST' as const,
      url: `${v2Fixture.baseUrl}/submit`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: '127.0.0.1',
      },
      body: 'name=&email=',
      status: 200,
      assertion: 'Thank You',
    };

    const expectedResp = await fetch(`${v1Fixture.baseUrl}/submit`, {
      method: 'POST',
      headers: httpCapture.headers,
      body: httpCapture.body,
    });
    expect(expectedResp.status).toBe(400);

    const verifyResp = await fetch(httpCapture.url, {
      method: httpCapture.method,
      headers: httpCapture.headers,
      body: httpCapture.body,
    });
    expect(verifyResp.status).toBe(200);
    expect(await verifyResp.text()).toContain('Thank You');

    const result = await writeFindingPacketV2({
      packId: 'test-pack',
      title: 'V2 accepts an empty form submission',
      severity: 'medium',
      category: 'validation',
      suiteId: 'vertical-slice',
      check: 'empty-form-validation',
      expectedState: 'POST /submit with empty fields returns 400 Validation Error',
      actualState: 'POST /submit with empty fields returns 200 Thank You',
      steps: ['POST empty name and email fields to /submit', 'Observe the submission is accepted'],
      store,
      attemptId: 'attempt-1',
      traceId: 'trace-http-defect',
      httpCapture,
      lifecycleState: 'suspected',
    });

    expect(result.packet.lifecycleState).toBe('suspected');
    expect(result.packet.replaySpec?.mode).toBe('http');

    // Confirm via replay
    const confirmResult = await confirmFromPacket(result.dir, {
      maxAttempts: 2,
    });

    expect(confirmResult.reproduced).toBe(true);
    expect(confirmResult.lifecycleState).toBe('confirmed-semantic');
    expect(confirmResult.attempts).toBeGreaterThanOrEqual(1);

    // Verify persisted state
    const updatedPacket = await readFindingPacket(result.dir);
    expect(updatedPacket.lifecycleState).toBe('confirmed-semantic');
    // reproductionCount starts at 1 from writeFindingPacketV2, then we added
    // confirmResult.attempts so it should be 2 (1 original + 1 confirmation)
    expect(updatedPacket.reproductionCount).toBe(2);

    // Verify confirmation evidence on disk
    const confirmDir = join(result.dir, 'confirmations');
    expect(existsSync(confirmDir)).toBe(true);
    const attemptDirs = readdirSync(confirmDir).filter((d) => d.startsWith('attempt-'));
    expect(attemptDirs.length).toBeGreaterThanOrEqual(1);

    // Each attempt dir should contain response.json or error.json
    for (const attemptDir of attemptDirs) {
      const dirPath = join(confirmDir, attemptDir);
      const files = readdirSync(dirPath);
      const hasResponse = files.includes('response.json');
      const hasError = files.includes('error.json');
      expect(hasResponse || hasError).toBe(true);
    }
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. Automatic redaction before artifact write
  // ─────────────────────────────────────────────────────────────────────────────

  it('3. redacts planted secrets automatically before artifacts are written', async () => {
    const runDir = join(tmpDir, '3-redaction');
    await mkdir(runDir, { recursive: true });
    const traceWriter = new TraceWriter(runDir, 'trace-redaction');
    const store = new ArtifactStore(runDir, 'run-redaction', {
      traceWriter,
      attemptId: 'att-redact',
    });

    // Plant a secret in a trace span attribute
    const secretToken = 'ghp_planted_test_token_abc123';
    const spanId = traceWriter.startSpan({
      name: 'api-request',
      kind: 'http.request',
      attributes: {
        'headers.authorization': `Bearer ${secretToken}`,
        url: `${v1Fixture.baseUrl}/api/secret`,
      },
    });
    traceWriter.endSpan(spanId, 'ok');

    const redactions = traceWriter.getRedactionSummary();
    expect(redactions.length).toBe(1);
    expect(redactions[0].ruleId).toContain('authorization');

    await traceWriter.flush();

    // Verify the written trace file does NOT contain the secret
    const traceDir = join(runDir, 'traces');
    const traceFiles = readdirSync(traceDir).filter((f) => f.endsWith('.jsonl'));
    expect(traceFiles.length).toBeGreaterThanOrEqual(1);

    const traceContent = readFileSync(join(traceDir, traceFiles[0]), 'utf8');
    expect(traceContent).not.toContain(secretToken);
    expect(traceContent).toContain('[REDACTED]');

    // Now write an artifact with the raw secret; the store redacts at write time.
    const rawPayload = {
      url: v1Fixture.baseUrl,
      headers: { authorization: `Bearer ${secretToken}` },
      body: { password: 'hunter2' },
    };
    const artifactRef = await store.writeJson(
      'http-request',
      rawPayload,
      'request-redacted.json',
      { traceId: traceWriter.getTraceId(), spanId },
    );

    // Verify the written file has redacted values
    const storedContent = JSON.parse(
      await readFile(join(store.getBaseDir(), 'artifacts', 'request-redacted.json'), 'utf8'),
    );
    expect(storedContent.headers.authorization).toBe('[REDACTED]');
    expect(storedContent.body.password).toBe('[REDACTED]');
    expect(storedContent.url).toBe(v1Fixture.baseUrl);

    // Verify the secret is not present anywhere in the artifact file
    const rawArtifact = readFileSync(
      join(store.getBaseDir(), 'artifacts', 'request-redacted.json'),
      'utf8',
    );
    expect(rawArtifact).not.toContain(secretToken);
    expect(rawArtifact).not.toContain('hunter2');

    // Verify redaction summary in the packet
    const findDir = join(runDir, 'findings', 'redaction-test');
    await mkdir(findDir, { recursive: true });
    const findingPacket: FindingPacketV2 = {
      findingId: 'redaction-auto-test',
      lifecycleState: 'suspected',
      title: 'Redaction auto-test',
      severity: 'low',
      category: 'security',
      originatingSuiteId: 'vertical-slice',
      originatingCheck: 'redaction',
      initialAttemptId: 'att-redact',
      confirmationAttemptIds: [],
      reproductionCount: 1,
      environment: { packId: 'test-pack' },
      evidenceManifest: store.buildManifest({ attemptId: 'att-redact', traceId: traceWriter.getTraceId() }),
      redactionSummary: store.buildManifest({
        attemptId: 'att-redact',
        traceId: traceWriter.getTraceId(),
      }).redactionSummary,
      expectedState: 'Secrets redacted',
      actualState: 'Secrets redacted',
      steps: ['Write secret', 'Redact', 'Persist'],
    };

    await writeFile(join(findDir, 'finding.json'), JSON.stringify(findingPacket, null, 2), 'utf8');

    // Verify the persisted finding.json has the redaction summary
    const persistedFinding = JSON.parse(
      readFileSync(join(findDir, 'finding.json'), 'utf8'),
    ) as FindingPacketV2;
    expect(persistedFinding.redactionSummary.length).toBeGreaterThanOrEqual(3);
    expect(persistedFinding.redactionSummary.some(
      (entry) => entry.ruleId === 'authorization-header',
    )).toBe(true);

    // Run a confirmation replay on the health endpoint to verify state persistence
    const healthSpec: ReplaySpec = {
      mode: 'http',
      method: 'GET',
      url: `${v1Fixture.baseUrl}/health`,
      headers: {},
      expectedStatus: 200,
      assertion: 'ok',
    };
    const confirmResult = await confirmFinding(findingPacket, healthSpec, { maxAttempts: 1 });
    expect(confirmResult.reproduced).toBe(true);
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. Multiple findings from one scope do not share artifact identities
  // ─────────────────────────────────────────────────────────────────────────────

  it('4. two findings from the same run scope produce unique artifact refs and isolated directories', async () => {
    const runDir = join(tmpDir, '4-unique-artifacts');
    await mkdir(runDir, { recursive: true });

    // Write two finding packets using the same base store — proving artifact IDs are unique
    const storeA = new ArtifactStore(runDir, 'run-unique');
    const packetA = await writeFindingPacketV2({
      packId: 'test-pack',
      title: 'Finding A — missing CSRF token',
      severity: 'medium',
      category: 'csrf',
      suiteId: 'unique-test',
      check: 'csrf-validation',
      expectedState: 'Form requires CSRF token',
      actualState: 'Form accepted without CSRF token',
      steps: ['Submit form without token', 'Observe acceptance'],
      store: storeA,
      attemptId: 'attempt-a',
      traceId: 'trace-a',
      lifecycleState: 'suspected',
    });

    const storeB = new ArtifactStore(runDir, 'run-unique');
    const packetB = await writeFindingPacketV2({
      packId: 'test-pack',
      title: 'Finding B — missing rate limiting',
      severity: 'high',
      category: 'rate-limit',
      suiteId: 'unique-test',
      check: 'rate-limit',
      expectedState: 'Rate limit enforced after 10 requests',
      actualState: 'No rate limit observed',
      steps: ['Send 20 rapid requests', 'Observe no throttling'],
      store: storeB,
      attemptId: 'attempt-b',
      traceId: 'trace-b',
      lifecycleState: 'suspected',
    });

    // IDs must be unique
    expect(packetA.findingId).not.toBe(packetB.findingId);
    expect(packetA.dir).not.toBe(packetB.dir);

    // Evidence manifests must not share artifact IDs
    const idSetA = new Set(packetA.packet.evidenceManifest.artifacts.map((a) => a.id));
    const idSetB = new Set(packetB.packet.evidenceManifest.artifacts.map((a) => a.id));
    for (const idA of idSetA) {
      expect(idSetB.has(idA)).toBe(false);
    }

    // Attempt IDs must differ
    expect(packetA.packet.initialAttemptId).not.toBe(packetB.packet.initialAttemptId);

    // Their finding directories must be separate on disk
    const dirsA = readdirSync(join(runDir, 'findings'));
    expect(dirsA.length).toBe(2);

    // Confirm both packets exist with the correct data
    const packetOnDiskA = JSON.parse(
      readFileSync(join(packetA.dir, 'finding.json'), 'utf8'),
    );
    expect(packetOnDiskA.title).toBe('Finding A — missing CSRF token');

    const packetOnDiskB = JSON.parse(
      readFileSync(join(packetB.dir, 'finding.json'), 'utf8'),
    );
    expect(packetOnDiskB.title).toBe('Finding B — missing rate limiting');
  }, 15000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. Lifecycle state persistence through confirmation → update → re-read
  // ─────────────────────────────────────────────────────────────────────────────

  it('5. lifecycle state transitions from suspected to confirmed-semantic with disk persistence', async () => {
    const runDir = join(tmpDir, '5-lifecycle');
    await mkdir(runDir, { recursive: true });
    const store = new ArtifactStore(runDir, 'run-lifecycle');

    // Start in suspected state
    const suspectPacket: FindingPacketV2 = {
      findingId: 'lifecycle-persistence',
      lifecycleState: 'suspected',
      title: 'Lifecycle persistence test',
      severity: 'low',
      category: 'test',
      originatingSuiteId: 'lifecycle-test',
      originatingCheck: 'persistence',
      initialAttemptId: 'att-cycle-1',
      confirmationAttemptIds: [],
      reproductionCount: 0,
      environment: { packId: 'test-pack' },
      evidenceManifest: store.buildManifest({ attemptId: 'att-cycle-1', traceId: 'trace-cycle' }),
      redactionSummary: [],
      expectedState: 'Health returns ok',
      actualState: 'Health returns ok',
      steps: ['GET /health'],
      replaySpec: {
        mode: 'http',
        method: 'GET',
        url: `${v1Fixture.baseUrl}/health`,
        headers: {},
        expectedStatus: 200,
        assertion: 'ok',
      },
    };

    // Write initial state
    const findDir = join(runDir, 'findings', 'lifecycle-persistence');
    await mkdir(findDir, { recursive: true });
    await writeFile(join(findDir, 'finding.json'), JSON.stringify(suspectPacket, null, 2), 'utf8');

    // Confirm via replay
    const confirmResult = await confirmFromPacket(findDir, {
      maxAttempts: 2,
    });

    expect(confirmResult.reproduced).toBe(true);
    expect(confirmResult.lifecycleState).toBe('confirmed-semantic');

    // Re-read from disk and verify
    const persisted = await readFindingPacket(findDir);
    expect(persisted.lifecycleState).toBe('confirmed-semantic');
    expect(persisted.confirmationAttemptIds).toHaveLength(1);
    expect(persisted.reproductionCount).toBe(1);

    // Confirm a second time
    const confirmResult2 = await confirmFromPacket(findDir, {
      maxAttempts: 2,
      evidenceDir: join(findDir, 'confirmations-2'),
    });

    expect(confirmResult2.reproduced).toBe(true);

    // Verify cumulative counts
    const persisted2 = await readFindingPacket(findDir);
    expect(persisted2.confirmationAttemptIds.length).toBe(2);
    expect(persisted2.reproductionCount).toBe(2);
    expect(persisted2.lifecycleState).toBe('confirmed-semantic');
  }, 30000);

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. V2 regression detection with trace-linked evidence and lifecycle update
  // ─────────────────────────────────────────────────────────────────────────────

  it('6. dataset comparison: v2 regression detected via HTTP state with trace IDs in evidence', async () => {
    const runDir = join(tmpDir, '6-v2-regression');
    await mkdir(runDir, { recursive: true });
    const traceWriter = new TraceWriter(runDir, 'trace-regression');
    const store = new ArtifactStore(runDir, 'run-regression');

    // Step A: Run v1 and capture correct behavior
    const v1Resp = await fetch(`${v1Fixture.baseUrl}/dashboard`, {
      headers: { accept: 'text/html' },
    });
    const v1Body = await v1Resp.text();
    const v1SpanId = traceWriter.startSpan({
      name: 'v1-dashboard',
      kind: 'http.request',
      attributes: { url: `${v1Fixture.baseUrl}/dashboard`, status: v1Resp.status },
    });
    traceWriter.endSpan(v1SpanId, 'ok');

    // v1: 401 "Sign In Required"
    expect(v1Resp.status).toBe(401);
    expect(v1Body).toContain('Sign In Required');

    // Step B: Run v2 and capture regressed behavior
    const v2Resp = await fetch(`${v2Fixture.baseUrl}/dashboard`, {
      headers: { accept: 'text/html' },
    });
    const v2Body = await v2Resp.text();
    const v2SpanId = traceWriter.startSpan({
      name: 'v2-dashboard',
      kind: 'http.request',
      attributes: { url: `${v2Fixture.baseUrl}/dashboard`, status: v2Resp.status },
    });
    traceWriter.endSpan(v2SpanId, 'ok');

    // v2: 403 "Access Denied" (regression)
    expect(v2Resp.status).toBe(403);
    expect(v2Body).toContain('Access Denied');

    // Step C: Write evidence artifacts with trace IDs
    await store.writeText('v1-response', v1Body, 'v1-response.html', {
      traceId: traceWriter.getTraceId(), spanId: v1SpanId, subDir: 'comparison',
    });
    await store.writeText('v2-response', v2Body, 'v2-response.html', {
      traceId: traceWriter.getTraceId(), spanId: v2SpanId, subDir: 'comparison',
    });
    await store.writeJson('comparison-result', {
      statusRegression: true,
      v1Status: v1Resp.status,
      v2Status: v2Resp.status,
      v1BodyPreview: v1Body.slice(0, 100),
      v2BodyPreview: v2Body.slice(0, 100),
      detail: 'v2 returns 403 "Access Denied" instead of 401 "Sign In Required"',
    }, 'comparison.json', { traceId: traceWriter.getTraceId(), subDir: 'comparison' });

    await traceWriter.flush();

    // Step D: Create a finding packet for the regression with trace evidence
    const packetResult = await writeFindingPacketV2({
      packId: 'test-pack',
      baseUrl: v2Fixture.baseUrl,
      title: 'Dashboard auth regression in v2 — 403 instead of 401',
      severity: 'high',
      category: 'regression',
      suiteId: 'vertical-slice',
      check: 'auth-regression-v2',
      expectedState: 'v1: 401 with "Sign In Required"',
      actualState: 'v2: 403 with "Access Denied"',
      steps: [
        'Compare GET /dashboard on v1 (401, Sign In Required)',
        'Compare GET /dashboard on v2 (403, Access Denied)',
      ],
      store,
      attemptId: 'att-regression',
      traceId: traceWriter.getTraceId(),
      httpCapture: {
        method: 'GET',
        url: `${v2Fixture.baseUrl}/dashboard`,
        headers: { accept: 'text/html', host: '127.0.0.1' },
        status: 403,
        assertion: 'Access Denied',
      },
      lifecycleState: 'suspected',
    });

    // Step E: Confirm the regression finding
    const confirmResult = await confirmFromPacket(packetResult.dir, {
      maxAttempts: 2,
    });

    // v2 actually returns 403 with "Access Denied" so the replay confirms
    expect(confirmResult.reproduced).toBe(true);
    expect(confirmResult.lifecycleState).toBe('confirmed-semantic');

    // Verify evidence files have trace IDs
    const evidenceFiles = store.getArtifacts().filter((a) => a.traceId);
    expect(evidenceFiles.length).toBeGreaterThanOrEqual(3); // v1, v2, comparison

    // Verify the trace file was written and contains both spans
    const loadedSpans = await TraceWriter.load(runDir);
    const v1Span = loadedSpans.find((s) => s.name === 'v1-dashboard');
    const v2Span = loadedSpans.find((s) => s.name === 'v2-dashboard');
    expect(v1Span).toBeTruthy();
    expect(v2Span).toBeTruthy();
    expect(v1Span!.attributes.status).toBe(401);
    expect(v2Span!.attributes.status).toBe(403);
    expect(v1Span!.traceId).toBe(v2Span!.traceId); // Same trace
  }, 30000);
});
