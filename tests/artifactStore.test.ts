import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { ArtifactStore } from '../src/artifacts/artifactStore.js';

describe('ArtifactStore', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'artifact-test-'));
  const runId = 'test-run-001';

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a string artifact and returns ref with hash', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.write({
      kind: 'test-evidence',
      data: 'hello world',
      filename: 'hello.txt',
      mediaType: 'text/plain',
    });

    expect(ref.id).toBeTruthy();
    expect(ref.kind).toBe('test-evidence');
    expect(ref.relativePath).toContain('hello.txt');
    expect(ref.sha256).toBeTruthy();
    expect(ref.bytes).toBe(11);
    expect(ref.mediaType).toBe('text/plain');
    expect(ref.redacted).toBe(false);

    // Verify file was written
    const filePath = join(tmpDir, ref.relativePath);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe('hello world');
  });

  it('writes a buffer artifact and computes correct byte count', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const data = Buffer.from('buffer content', 'utf8');
    const ref = await store.write({
      kind: 'binary-evidence',
      data,
      filename: 'data.bin',
      mediaType: 'application/octet-stream',
    });

    expect(ref.bytes).toBe(14);
    expect(ref.sha256.length).toBe(64); // hex-encoded SHA-256
  });

  it('writes JSON artifact with writeJson', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.writeJson('json-evidence', { key: 'value', num: 42 }, 'data.json');

    expect(ref.kind).toBe('json-evidence');
    expect(ref.mediaType).toBe('application/json');
    const filePath = join(tmpDir, ref.relativePath);
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(parsed).toEqual({ key: 'value', num: 42 });
  });

  it('writes text artifact with writeText', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.writeText('text-evidence', 'some text content', 'note.txt');

    expect(ref.mediaType).toBe('text/plain');
    const filePath = join(tmpDir, ref.relativePath);
    expect(readFileSync(filePath, 'utf8')).toBe('some text content');
  });

  it('writes to subdir', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.write({
      kind: 'subdir-evidence',
      data: 'nested content',
      filename: 'nested.txt',
      subDir: 'findings/test-finding',
    });

    expect(ref.relativePath).toContain('findings/test-finding');
    const filePath = join(tmpDir, ref.relativePath);
    expect(existsSync(filePath)).toBe(true);
  });

  it('builds manifest with all artifacts', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    await store.write({ kind: 'a', data: 'content-a', filename: 'a.txt' });
    await store.write({ kind: 'b', data: 'content-b', filename: 'b.txt' });

    const manifest = store.buildManifest({ attemptId: 'attempt-1', traceId: 'trace-abc' });
    expect(manifest.runId).toBe(runId);
    expect(manifest.attemptId).toBe('attempt-1');
    expect(manifest.traceId).toBe('trace-abc');
    expect(manifest.artifacts.length).toBe(2);
    expect(manifest.artifacts[0].kind).toBe('a');
    expect(manifest.artifacts[1].kind).toBe('b');
  });

  it('saves manifest as artifact', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    await store.write({ kind: 'data', data: 'test', filename: 'test.txt' });
    const ref = await store.saveManifest('attempt-1', 'trace-abc');

    expect(ref.kind).toBe('evidence-manifest');
    const filePath = join(tmpDir, ref.relativePath);
    expect(existsSync(filePath)).toBe(true);
    const manifest = JSON.parse(readFileSync(filePath, 'utf8'));
    // Manifest captures artifacts tracked at build time (the data artifact only)
    expect(manifest.artifacts.length).toBe(1);
    expect(manifest.artifacts[0].kind).toBe('data');
    expect(manifest.runId).toBe(runId);
  });

  it('copy copies an existing file', async () => {
    const sourcePath = join(tmpDir, 'source.txt');
    const sourceContent = 'source file content';
    require('fs').writeFileSync(sourcePath, sourceContent, 'utf8');

    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.copy(sourcePath, 'copied-evidence', 'copied.txt');

    expect(ref.kind).toBe('copied-evidence');
    expect(ref.bytes).toBe(sourceContent.length);
    const destPath = join(tmpDir, ref.relativePath);
    expect(readFileSync(destPath, 'utf8')).toBe(sourceContent);
  });

  it('tracks redaction status', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.write({
      kind: 'sensitive',
      data: 'secret data',
      filename: 'secret.txt',
      redacted: true,
    });

    expect(ref.redacted).toBe(true);
  });

  it('tracks trace and span correlation', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    const ref = await store.write({
      kind: 'correlated',
      data: 'trace-linked data',
      filename: 'trace.txt',
      traceId: 'trace-xyz',
      spanId: 'span-123',
    });

    expect(ref.traceId).toBe('trace-xyz');
    expect(ref.spanId).toBe('span-123');
  });

  it('getArtifacts returns snapshot', async () => {
    const store = new ArtifactStore(tmpDir, runId);
    await store.write({ kind: 'a', data: 'x', filename: 'a.txt' });
    const snapshot1 = store.getArtifacts();
    await store.write({ kind: 'b', data: 'y', filename: 'b.txt' });
    const snapshot2 = store.getArtifacts();

    expect(snapshot1.length).toBe(1);
    expect(snapshot2.length).toBe(2);
    // Modifying snapshot should not affect store
    snapshot1.pop();
    expect(store.getArtifacts().length).toBe(2);
  });
});
