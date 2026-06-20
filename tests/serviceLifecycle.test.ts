import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HarnessService } from '../src/service/harnessService.js';
import { registry } from '../src/core/suiteRegistry.js';
import type { SuiteResult } from '../src/core/runTypes.js';

describe('HarnessService lifecycle', () => {
  it('returns a detached run ID and can cancel it before cataloging', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'qa-service-'));
    const packsDir = path.join(root, 'packs');
    const packDir = path.join(packsDir, 'service-test');
    await mkdir(packDir, { recursive: true });
    await writeFile(path.join(packDir, 'pack.yaml'), [
      'id: service-test',
      'name: Service Test',
      'baseUrl: https://example.com',
      'profiles:',
      '  focused:',
      '    includeTags: [service-cancel]',
      '',
    ].join('\n'));

    const suiteId = 'service-cancellation-probe';
    if (!registry.get(suiteId)) {
      registry.register({
        id: suiteId,
        title: 'Service cancellation probe',
        description: 'Waits for the service cancellation signal',
        tags: ['service-cancel'],
        requirement: 'required',
        async run(context): Promise<SuiteResult> {
          await new Promise<void>((resolve) => {
            context.abortSignal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          const now = new Date().toISOString();
          return {
            suiteId,
            status: 'passed',
            requirement: 'required',
            startedAt: now,
            endedAt: now,
            durationMs: 0,
            attempts: [],
            checks: [],
            artifacts: [],
          };
        },
      });
    }

    const service = new HarnessService({
      packsDir,
      runsBaseDir: path.join(root, 'runs'),
      catalogBaseDir: root,
    });
    const started = await service.startRunDetached({
      packId: 'service-test',
      profile: 'focused',
    });

    expect(await service.cancelRun(started.runId)).toBe(true);

    let manifest = (await service.getRun(started.runId)).manifest;
    for (let i = 0; i < 20 && !manifest?.endedAt; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      manifest = (await service.getRun(started.runId)).manifest;
    }

    expect(manifest?.selection.tags).toContain('service-cancel');
    expect(manifest?.status).toBe('cancelled');
    expect(manifest?.suiteResults[0].status).toBe('cancelled');
  });
});
