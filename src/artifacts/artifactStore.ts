import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import type { ArtifactRef, EvidenceManifest, RedactionEntry } from '../trace/traceTypes.js';
import type { TraceWriter } from '../trace/traceWriter.js';
import { redactDeep, redactText } from '../trace/redaction.js';

export type ArtifactStoreTraceContext = {
  traceWriter: TraceWriter;
  parentSpanId?: string;
  attemptId?: string;
};

/**
 * Artifact store: writes and tracks evidence files with integrity hashes.
 *
 * Each artifact gets a unique ID, SHA-256 hash, and entry in an evidence
 * manifest. The manifest is stored alongside the artifacts.
 */
export class ArtifactStore {
  private artifacts: ArtifactRef[] = [];
  private redactions: RedactionEntry[] = [];
  private traceRedactionStart: number;
  private baseDir: string;

  constructor(
    baseDir: string,
    private runId: string = '',
    private traceContext?: ArtifactStoreTraceContext,
  ) {
    this.baseDir = path.resolve(baseDir);
    this.traceRedactionStart =
      traceContext?.traceWriter.getRedactionSummary().length ?? 0;
  }

  /** Absolute root used by this attempt-scoped store. */
  getBaseDir(): string {
    return this.baseDir;
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
    const spanId = this.traceContext?.traceWriter.startSpan({
      name: `artifact:${params.kind}`,
      kind: 'artifact.write',
      parentSpanId: params.spanId ?? this.traceContext?.parentSpanId,
      attemptId: this.traceContext?.attemptId,
      attributes: {
        kind: params.kind,
        filename: params.filename,
        mediaType: params.mediaType ?? 'application/octet-stream',
      },
    });
    const { data, redactions } = this.redactData(
      params.data,
      params.mediaType,
      params.filename,
    );
    this.redactions.push(...redactions);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const sha256 = createHash('sha256').update(buf).digest('hex');
    const id = randomUUID().replace(/-/g, '').slice(0, 16);
    const relDir = params.subDir ?? 'artifacts';
    // Always use forward slashes for relative paths (cross-platform)
    const relativePath = path.join(relDir, params.filename).replace(/\\/g, '/');
    const absPath = path.join(this.baseDir, relativePath);

    try {
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, buf);
    } catch (error) {
      if (spanId) {
        this.traceContext?.traceWriter.endSpan(spanId, 'error', {
          error: String(error),
        });
      }
      throw error;
    }

    const ref: ArtifactRef = {
      id,
      kind: params.kind,
      relativePath,
      mediaType: params.mediaType ?? 'application/octet-stream',
      sha256,
      bytes: buf.length,
      createdAt: new Date().toISOString(),
      traceId: this.traceContext?.traceWriter.getTraceId() ?? params.traceId,
      spanId: spanId ?? params.spanId,
      redacted: (params.redacted ?? false) || redactions.length > 0,
    };

    this.artifacts.push(ref);
    if (spanId) {
      this.traceContext?.traceWriter.endSpan(spanId, 'ok', {
        artifactId: id,
        relativePath,
        sha256,
        bytes: buf.length,
        redacted: ref.redacted,
      });
    }
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
      redactionSummary: [
        ...this.redactions,
        ...(this.traceContext?.traceWriter.getRedactionSummary().slice(
          this.traceRedactionStart,
        ) ?? []),
      ],
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

  private redactData(
    data: Buffer | string,
    mediaType = 'application/octet-stream',
    filename = '',
  ): { data: Buffer | string; redactions: RedactionEntry[] } {
    const textual = typeof data === 'string'
      || mediaType.startsWith('text/')
      || /json|xml|javascript|x-www-form-urlencoded/i.test(mediaType)
      || /\.(json|jsonl|txt|log|md|html|xml|ya?ml|csv)$/i.test(filename);
    if (!textual) return { data, redactions: [] };

    const text = typeof data === 'string' ? data : data.toString('utf8');
    if (/json/i.test(mediaType) || /\.jsonl?$/i.test(filename)) {
      try {
        const parsed = JSON.parse(text);
        const { result, redactions } = redactDeep(parsed);
        return { data: JSON.stringify(result, null, 2), redactions };
      } catch {
        // Malformed or JSONL content still receives text-pattern redaction.
      }
    }
    const redacted = redactText(text);
    return { data: redacted.result, redactions: redacted.redactions };
  }
}
