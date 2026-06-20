import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { ArtifactRef, EvidenceManifest } from '../trace/traceTypes.js';

/**
 * Artifact store: writes and tracks evidence files with integrity hashes.
 *
 * Each artifact gets a unique ID, SHA-256 hash, and entry in an evidence
 * manifest. The manifest is stored alongside the artifacts.
 */
export class ArtifactStore {
  private artifacts: ArtifactRef[] = [];
  private baseDir: string;

  constructor(baseDir: string, private runId: string = '') {
    this.baseDir = path.resolve(baseDir);
  }

  /** Write an artifact from a Buffer or string, returning its ref. */
  async write(params: {
    kind: string;
    data: Buffer | string;
    filename: string;
    mediaType?: string;
    traceId?: string;
    spanId?: string;
    redacted?: boolean;
    subDir?: string;
  }): Promise<ArtifactRef> {
    const buf = typeof params.data === 'string' ? Buffer.from(params.data, 'utf8') : params.data;
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const relDir = params.subDir ?? 'artifacts';
    const relativePath = path.join(relDir, params.filename);
    const absPath = path.join(this.baseDir, relativePath);

    await mkdir(path.dirname(absPath), { recursive: true });
    await writeFile(absPath, buf);

    const ref: ArtifactRef = {
      id,
      kind: params.kind,
      relativePath,
      mediaType: params.mediaType ?? 'application/octet-stream',
      sha256,
      bytes: buf.length,
      createdAt: new Date().toISOString(),
      traceId: params.traceId,
      spanId: params.spanId,
      redacted: params.redacted ?? false,
    };

    this.artifacts.push(ref);
    return ref;
  }

  /** Write a JSON artifact. */
  async writeJson(
    kind: string,
    data: unknown,
    filename: string,
    extra?: Partial<Parameters<ArtifactStore['write']>[0]>,
  ): Promise<ArtifactRef> {
    return this.write({
      kind,
      data: JSON.stringify(data, null, 2),
      filename,
      mediaType: 'application/json',
      ...extra,
    });
  }

  /** Write a text artifact. */
  async writeText(
    kind: string,
    text: string,
    filename: string,
    extra?: Partial<Parameters<ArtifactStore['write']>[0]>,
  ): Promise<ArtifactRef> {
    return this.write({
      kind,
      data: text,
      filename,
      mediaType: 'text/plain',
      ...extra,
    });
  }

  /** Copy an existing file into the artifact store. */
  async copy(existingPath: string, kind: string, filename?: string, extra?: Partial<Parameters<ArtifactStore['write']>[0]>): Promise<ArtifactRef> {
    const data = await readFile(existingPath);
    const name = filename ?? path.basename(existingPath);
    return this.write({ kind, data, filename: name, ...extra });
  }

  /** Build the evidence manifest for the current run/attempt. */
  buildManifest(params: { attemptId: string; traceId: string }): EvidenceManifest {
    return {
      runId: this.runId,
      attemptId: params.attemptId,
      traceId: params.traceId,
      artifacts: [...this.artifacts],
      redactionSummary: [],
    };
  }

  /** Persist the evidence manifest. */
  async saveManifest(attemptId: string, traceId: string): Promise<ArtifactRef> {
    const manifest = this.buildManifest({ attemptId, traceId });
    return this.writeJson('evidence-manifest', manifest, 'evidence-manifest.json', { subDir: 'evidence' });
  }

  /** Get all tracked artifact refs. */
  getArtifacts(): ArtifactRef[] {
    return [...this.artifacts];
  }
}
