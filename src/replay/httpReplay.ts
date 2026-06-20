import { compileHttpCurl, compileHttpSpec } from './replayCompiler.js';
import type { ReplaySpec, ArtifactRef } from '../trace/traceTypes.js';
import type { ArtifactStore } from '../artifacts/artifactStore.js';

/**
 * HTTP replay: generates an executable replay from a captured HTTP request.
 * Uses the replayCompiler to produce both curl and Playwright forms.
 */

export type HttpCapture = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  status: number;
  assertion: string;
};

/**
 * Write HTTP replay artifacts (curl + Playwright spec) to the artifact store.
 * Returns the generated specs for embedding in the finding packet.
 */
export async function writeHttpReplay(
  capture: HttpCapture,
  findingId: string,
  store: ArtifactStore,
): Promise<{ spec: ReplaySpec; artifacts: ArtifactRef[] }> {
  const spec: ReplaySpec = {
    mode: 'http',
    method: capture.method,
    url: capture.url,
    headers: capture.headers,
    body: capture.body,
    expectedStatus: capture.status,
    assertion: capture.assertion,
  };

  // Sanitize headers for replay (strip sensitive ones)
  const sanitizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(capture.headers)) {
    if (!/cookie|authorization|token|key|set-cookie/i.test(k)) {
      sanitizedHeaders[k] = v;
    } else {
      sanitizedHeaders[k] = '<redacted>';
    }
  }
  spec.headers = sanitizedHeaders;

  // Write curl replay
  const curlRef = await store.writeText(
    'replay-curl',
    compileHttpCurl(spec),
    `replay.curl.sh`,
    { subDir: `findings/${findingId}` },
  );

  // Write Playwright spec
  const pwSpec = compileHttpSpec(spec);
  const pwRef = await store.writeText(
    'replay-spec',
    pwSpec,
    `replay.spec.ts`,
    { subDir: `findings/${findingId}` },
  );

  return { spec, artifacts: [curlRef, pwRef] };
}
