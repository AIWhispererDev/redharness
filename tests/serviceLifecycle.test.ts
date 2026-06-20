/**
 * HarnessService lifecycle tests.
 *
 * Note: HarnessService creates a RunCatalog which uses node:sqlite.
 * These tests dynamically import to work on Node < 22.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let HarnessService: any;
let registry: any;

beforeAll(async () => {
  if (hasSqlite) {
    const harness = await import('../src/service/harnessService.js');
    HarnessService = harness.HarnessService;
    const core = await import('../src/core/suiteRegistry.js');
    registry = core.registry;
  }
}, 10000);

if (hasSqlite) {
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
          async run(context: any): Promise<any> {
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
} else {
  describe('HarnessService lifecycle (requires Node 22+)', () => {
    it('skipped — node:sqlite not available', () => {
      expect(true).toBe(true);
    });
  });
}
