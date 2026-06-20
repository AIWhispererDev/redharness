import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { confirmFromPacket } from '../src/replay/confirmationRunner.js';
import type { FindingPacketV2 } from '../src/trace/traceTypes.js';

describe('finding confirmation lifecycle persistence', () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('persists successful packet confirmation without caller-side rewriting', async () => {
    const packetDir = mkdtempSync(join(tmpdir(), 'confirmation-packet-'));
    directories.push(packetDir);
    await mkdir(packetDir, { recursive: true });

    const packet: FindingPacketV2 = {
      findingId: 'automatic-lifecycle',
      lifecycleState: 'suspected',
      title: 'Automatic lifecycle persistence',
      severity: 'medium',
      category: 'test',
      originatingSuiteId: 'suite',
      originatingCheck: 'check',
      initialAttemptId: 'attempt-1',
      confirmationAttemptIds: [],
      reproductionCount: 0,
      environment: { packId: 'test-pack' },
      evidenceManifest: {
        runId: 'run',
        attemptId: 'attempt-1',
        traceId: 'trace',
        artifacts: [],
        redactionSummary: [],
      },
      redactionSummary: [],
      expectedState: 'response contains vulnerable',
      actualState: 'response contains vulnerable',
      steps: ['GET /probe'],
      replaySpec: {
        mode: 'http',
        method: 'GET',
        url: 'https://fixture.test/probe',
        headers: {},
        expectedStatus: 200,
        assertion: 'vulnerable',
      },
    };
    await writeFile(join(packetDir, 'finding.json'), JSON.stringify(packet, null, 2));
    await writeFile(
      join(packetDir, 'finding.md'),
      '# Finding\n\n- Lifecycle: suspected\n',
    );
    await writeFile(
      join(packetDir, 'replay.json'),
      JSON.stringify(packet.replaySpec, null, 2),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('vulnerable response', { status: 200 }),
      ),
    );

    const result = await confirmFromPacket(packetDir, { maxAttempts: 1 });

    expect(result.lifecycleState).toBe('confirmed-semantic');
    const persisted = JSON.parse(
      readFileSync(join(packetDir, 'finding.json'), 'utf8'),
    ) as FindingPacketV2;
    expect(persisted.lifecycleState).toBe('confirmed-semantic');
    expect(persisted.confirmationAttemptIds).toHaveLength(1);
    expect(persisted.reproductionCount).toBe(1);
    expect(readFileSync(join(packetDir, 'finding.md'), 'utf8')).toContain(
      '- Lifecycle: confirmed-semantic',
    );
    expect(
      readFileSync(
        join(packetDir, 'confirmations', 'attempt-1', 'response.json'),
        'utf8',
      ),
    ).toContain('"matched": true');
  });
});
