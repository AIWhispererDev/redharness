import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FindingPacketV2, ReplaySpec, ArtifactRef, FindingLifecycleState } from './trace/traceTypes.js';
import { compileBrowserSpec, compileHttpSpec, compileGuidedSpec } from './replay/replayCompiler.js';
import { ArtifactStore } from './artifacts/artifactStore.js';
import { randomUUID } from 'node:crypto';
import { redactDeep } from './trace/redaction.js';

// ---------------------------------------------------------------------------
// Legacy v1 finding packet (preserved for backward compat)
// ---------------------------------------------------------------------------

export type FindingPacketInput = {
  outputDir: string;
  packName: string;
  finding: {
    title: string;
    severity: string;
    type: string;
    steps: string[];
    expected: string;
    actual: string;
    evidence: string[];
  };
};

export type FindingPacket = {
  dir: string;
  markdownPath: string;
  jsonPath: string;
  replayPath: string;
};

export function slugifyFinding(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 90) || 'finding';
}

export async function writeFindingPacket(input: FindingPacketInput): Promise<FindingPacket> {
  const slug = slugifyFinding(input.finding.title);
  const dir = path.join(input.outputDir, 'findings', slug);
  await mkdir(dir, { recursive: true });
  const markdownPath = path.join(dir, 'finding.md');
  const jsonPath = path.join(dir, 'finding.json');
  const replayPath = path.join(dir, 'replay.pw.ts');

  const md = [
    '# DRAFT ONLY — Review before submitting',
    '',
    `## ${input.finding.title}`,
    '',
    `- App: ${input.packName}`,
    `- Severity: ${input.finding.severity}`,
    `- Type: ${input.finding.type}`,
    '',
    '## Steps to Reproduce',
    '',
    ...input.finding.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Expected',
    '',
    input.finding.expected,
    '',
    '## Actual',
    '',
    input.finding.actual,
    '',
    '## Evidence',
    '',
    ...input.finding.evidence.map((item) => `- ${item}`),
    '',
  ].join('\n');

  const replay = `import { test, expect } from '@playwright/test';\n\ntest('${input.finding.title.replace(/'/g, "\\'")}', async ({ page }) => {\n  test.setTimeout(120000);\n  test.fixme(true, 'Legacy finding — needs automatic replay reconstruction');\n  // TODO: replay the exact finding steps from finding.json.\n});\n`;

  await writeFile(markdownPath, md, 'utf8');
  await writeFile(jsonPath, JSON.stringify({ packName: input.packName, ...input.finding }, null, 2), 'utf8');
  await writeFile(replayPath, replay, 'utf8');
  return { dir, markdownPath, jsonPath, replayPath };
}

// ---------------------------------------------------------------------------
// PRD 02: Finding Packet v2 with trace-integrated evidence and real replay
// ---------------------------------------------------------------------------

export type FindingPacketV2Input = {
  packId: string;
  baseUrl?: string;
  title: string;
  severity: string;
  category: string;
  suiteId: string;
  check: string;
  expectedState: string;
  actualState: string;
  steps: string[];
  lifecycleState?: FindingLifecycleState;
  store: ArtifactStore;
  attemptId: string;
  traceId: string;
  recordedActions?: import('./trace/traceTypes.js').RecordedAction[];
  httpCapture?: import('./replay/httpReplay.js').HttpCapture;
  assertion?: import('./trace/traceTypes.js').AssertionRecipe;
};

/**
 * Write a PRD 02 finding packet with evidence manifest and executable replay.
 *
 * Returns the v2 finding ID and packet directory.
 */
export async function writeFindingPacketV2(input: FindingPacketV2Input): Promise<{ findingId: string; dir: string; packet: FindingPacketV2 }> {
  const findingId = slugifyFinding(input.title) + '-' + randomUUID().replace(/-/g, '').slice(0, 8);
  const findDir = path.join(input.store.getBaseDir(), 'findings', findingId);
  await mkdir(findDir, { recursive: true });

  // Build replay spec
  let replaySpec: ReplaySpec | undefined;
  let specArtifacts: ArtifactRef[] = [];

  if (input.httpCapture) {
    const { writeHttpReplay } = await import('./replay/httpReplay.js');
    const result = await writeHttpReplay(input.httpCapture, findingId, input.store);
    replaySpec = result.spec;
    specArtifacts = result.artifacts;
  } else if (input.recordedActions && input.assertion) {
    const specCode = compileBrowserSpec(input.recordedActions, input.assertion, findingId);
    const specRef = await input.store.writeText('replay-spec', specCode, `replay.spec.ts`, { subDir: `findings/${findingId}` });
    replaySpec = { mode: 'browser', actions: input.recordedActions, assertion: input.assertion, setup: [], linkedArtifactIds: [] };
    specArtifacts = [specRef];
  } else {
    // Guided replay
    const specCode = compileGuidedSpec(
      {
        findingId,
        lifecycleState: 'suspected',
        title: input.title,
        severity: input.severity,
        category: input.category,
        originatingSuiteId: input.suiteId,
        originatingCheck: input.check,
        initialAttemptId: input.attemptId,
        confirmationAttemptIds: [],
        reproductionCount: 0,
        environment: { packId: input.packId, baseUrl: input.baseUrl },
        evidenceManifest: { runId: '', attemptId: input.attemptId, traceId: input.traceId, artifacts: [], redactionSummary: [] },
        redactionSummary: [],
        expectedState: input.expectedState,
        actualState: input.actualState,
        steps: input.steps,
      },
      ['Cannot deterministically reconstruct all steps from available data'],
    );
    const specRef = await input.store.writeText('replay-spec', specCode, `replay.spec.ts`, { subDir: `findings/${findingId}` });
    replaySpec = { mode: 'guided', setupHint: input.expectedState, unresolvedSteps: input.steps, linkedArtifactIds: [] };
    specArtifacts = [specRef];
  }

  // Build evidence manifest (store already tracks all written artifacts)
  const manifest = input.store.buildManifest({ attemptId: input.attemptId, traceId: input.traceId });
  // specArtifacts are already in store.writeText calls above, so no duplicate push needed
  await input.store.saveManifest(input.attemptId, input.traceId);

  // Build finding packet JSON
  const packet: FindingPacketV2 = {
    findingId,
    lifecycleState: input.lifecycleState ?? 'suspected',
    title: input.title,
    severity: input.severity,
    category: input.category,
    originatingSuiteId: input.suiteId,
    originatingCheck: input.check,
    initialAttemptId: input.attemptId,
    confirmationAttemptIds: [],
    reproductionCount: 1,
    environment: { packId: input.packId, baseUrl: input.baseUrl },
    evidenceManifest: manifest,
    redactionSummary: manifest.redactionSummary,
    replaySpec,
    expectedState: input.expectedState,
    actualState: input.actualState,
    steps: input.steps,
  };

  const packetRedaction = redactDeep(packet);
  const persistedPacket = packetRedaction.result as FindingPacketV2;
  const combinedRedactions = [
    ...manifest.redactionSummary,
    ...packetRedaction.redactions,
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.fieldPath === entry.fieldPath
          && candidate.ruleId === entry.ruleId,
      ) === index,
  );
  persistedPacket.redactionSummary = combinedRedactions;
  persistedPacket.evidenceManifest.redactionSummary = combinedRedactions;

  // Write packet JSON
  await writeFile(path.join(findDir, 'finding.json'), JSON.stringify(persistedPacket, null, 2), 'utf8');
  if (persistedPacket.replaySpec) {
    await writeFile(
      path.join(findDir, 'replay.json'),
      JSON.stringify(persistedPacket.replaySpec, null, 2),
      'utf8',
    );
  }

  // Write markdown summary
  const md = [
    `# ${persistedPacket.title}`,
    '',
    `- Finding ID: ${findingId}`,
    `- Lifecycle: ${persistedPacket.lifecycleState}`,
    `- Severity: ${persistedPacket.severity}`,
    `- Category: ${persistedPacket.category}`,
    `- Suite: ${persistedPacket.originatingSuiteId}`,
    '',
    '## Steps',
    '',
    ...persistedPacket.steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    '## Expected',
    '',
    persistedPacket.expectedState,
    '',
    '## Actual',
    '',
    persistedPacket.actualState,
    '',
    '## Replay',
    '',
    persistedPacket.replaySpec ? `- Mode: ${persistedPacket.replaySpec.mode}` : '- No replay available',
    '',
    '## Evidence',
    '',
    ...manifest.artifacts.map((a) => `- ${a.kind}: ${a.relativePath} (${a.sha256.slice(0, 12)}...)`),
    '',
  ].join('\n');
  await writeFile(path.join(findDir, 'finding.md'), md, 'utf8');

  return { findingId, dir: findDir, packet: persistedPacket };
}
