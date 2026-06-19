import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { writeFindingPacket } from '../src/findingPackets.js';

describe('finding packets', () => {
  it('writes Notion-ready markdown, JSON, and replay scaffold', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'finding-packet-'));
    try {
      const packet = await writeFindingPacket({
        outputDir: dir,
        packName: 'Pocket Socrates',
        finding: {
          title: 'Missing Content-Security-Policy header',
          severity: 'medium',
          type: 'Security Header',
          steps: ['Open https://pocketsoc.me', 'Inspect response headers'],
          expected: 'CSP header is present',
          actual: 'CSP header is missing',
          evidence: ['headers.json'],
        },
      });
      const md = await readFile(packet.markdownPath, 'utf8');
      const json = await readFile(packet.jsonPath, 'utf8');
      const replay = await readFile(packet.replayPath, 'utf8');
      expect(md).toContain('DRAFT ONLY');
      expect(md).toContain('Missing Content-Security-Policy header');
      expect(json).toContain('Security Header');
      expect(replay).toContain('test(');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
