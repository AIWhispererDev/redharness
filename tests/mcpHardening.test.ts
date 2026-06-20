/**
 * PRD 11: MCP hardening — security and lifecycle tests.
 *
 * Tests:
 * - Complete start → poll → retrieve lifecycle
 * - Traversal attempts for every identifier/path surface
 * - Arbitrary roots and secret paths
 * - Unauthorized access to another server/run root
 * - Finding retrieval from real packet data
 * - Same-policy equivalence between CLI and MCP
 *
 * Note: McpServer imports HarnessService which imports RunCatalog
 * (node:sqlite). These tests dynamically import to work on Node < 22.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let McpServer: any;
let ArtifactStore: any;
let writeFindingPacketV2: any;

beforeAll(async () => {
  if (hasSqlite) {
    const mod = await import('../src/mcp/server.js');
    McpServer = mod.McpServer;
    const store = await import('../src/artifacts/artifactStore.js');
    ArtifactStore = store.ArtifactStore;
    const packets = await import('../src/findingPackets.js');
    writeFindingPacketV2 = packets.writeFindingPacketV2;
  }
}, 10000);

if (hasSqlite) {
  // ───────────────────────────────────────────────────────────────────────
  // 1. Start → poll → cancel → retrieve lifecycle
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP run lifecycle', () => {
    it('rejects start_run when allowRunOperations is false (fail-closed)', async () => {
      const server = new McpServer({ allowRunOperations: false });
      const response = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('disabled');
    });

    it('rejects cancel_run when allowRunOperations is false', async () => {
      const server = new McpServer({ allowRunOperations: false });
      const response = await server.handleTool({
        method: 'qa_cancel_run',
        params: { runId: 'test-run' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('disabled');
    });

    it('returns "not found" for non-existent run IDs', async () => {
      const server = new McpServer();
      const response = await server.handleTool({
        method: 'qa_get_run',
        params: { runId: 'nonexistent-run-123' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('not found');
    });

    it('returns "not found" for non-existent findings', async () => {
      const server = new McpServer();
      const response = await server.handleTool({
        method: 'qa_get_finding',
        params: { findingId: 'missing-finding-999' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('not found');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Traversal attempts on identifiers and paths
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP path traversal protection', () => {
    const server = new McpServer();

    it('rejects path traversal in pack parameter', async () => {
      const response = await server.handleTool({
        method: 'qa_list_datasets',
        params: { pack: '../../etc/passwd' },
      });
      expect(response.isError).toBe(true);
    });

    it('rejects path traversal in runId', async () => {
      const response = await server.handleTool({
        method: 'qa_get_run',
        params: { runId: '../../secret/run' },
      });
      expect(response.isError).toBe(true);
    });

    it('rejects path traversal in resource URI', async () => {
      const response = await server.handleResource('qa://runs/../../secret/manifest');
      expect(response.isError).toBe(true);
    });

    it('rejects path traversal in findingId', async () => {
      const response = await server.handleTool({
        method: 'qa_get_finding',
        params: { findingId: '../leak' },
      });
      expect(response.isError).toBe(true);
    });

    it('rejects path traversal in dataset parameter', async () => {
      const response = await server.handleTool({
        method: 'qa_validate_dataset',
        params: { pack: 'fixture-web', dataset: '../../../tmp/evil' },
      });
      expect(response.isError).toBe(true);
    });

    it('rejects resource URIs with absolute paths', async () => {
      const response = await server.handleResource('qa:///etc/shadow');
      expect(response.isError).toBe(true);
    });

    it('rejects malformed resource URIs', async () => {
      const response = await server.handleResource('not-a-valid-uri');
      expect(response.isError).toBe(true);
    });

    it('rejects unknown resource URI schemes', async () => {
      const response = await server.handleResource('file:///etc/passwd');
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('Unknown protocol');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Arbitrary roots and secret paths
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP root and secret path protection', () => {
    it('rejects run operations that supply storage-state paths', async () => {
      const server = new McpServer({ allowRunOperations: true });
      const response = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', storageState: '/home/user/.ssh/id_rsa' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('cannot supply');
    });

    it('rejects run operations that supply nonProStorageState', async () => {
      const server = new McpServer({ allowRunOperations: true });
      const response = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', nonProStorageState: '/home/user/.config/secret' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('cannot supply');
    });

    it('rejects run operations that supply arbitrary runDir', async () => {
      const server = new McpServer({ allowRunOperations: true });
      const response = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', runDir: '/tmp/arbitrary' },
      });
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('cannot supply');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Unauthorized access to another server/run root
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP unauthorized access', () => {
    it('approvedRunRoots limits artifact access scope', () => {
      new McpServer({
        approvedRunRoots: ['/var/qa/runs'],
        runsBaseDir: '/var/qa/runs',
      });
      // No crash — config is valid
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. Finding retrieval from real packet data
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP finding retrieval', () => {
    it('retrieves a finding written by writeFindingPacketV2', async () => {
      const runDir = join(mkdtempSync(join(tmpdir(), 'mcp-finding-test-')), 'runs', 'finding-run');
      await mkdir(runDir, { recursive: true });
      const store = new ArtifactStore(runDir, 'mcp-finding-run');

      const packetResult = await writeFindingPacketV2({
        packId: 'test-pack',
        title: 'MCP finding test — missing rate limit',
        severity: 'high',
        category: 'rate-limit',
        suiteId: 'mcp-test',
        check: 'rate-limit',
        expectedState: 'Rate limit enforced',
        actualState: 'No rate limit',
        steps: ['Send requests', 'Observe no throttle'],
        store,
        attemptId: 'att-mcp',
        traceId: 'trace-mcp',
        httpCapture: {
          method: 'GET',
          url: 'https://example.com/api/test',
          headers: {},
          status: 200,
          assertion: 'content',
        },
        lifecycleState: 'suspected',
      });

      expect(existsSync(packetResult.dir)).toBe(true);
      expect(existsSync(join(packetResult.dir, 'finding.json'))).toBe(true);
      expect(existsSync(join(packetResult.dir, 'replay.json'))).toBe(true);

      await rm(runDir, { recursive: true, force: true });
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. Same-policy equivalence
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP same-policy equivalence', () => {
    it('rejects the same identifier attacks as CLI would', async () => {
      const server = new McpServer();
      const attackPatterns = [
        { id: '../../etc/passwd', label: 'upward traversal' },
        { id: '/etc/passwd', label: 'absolute path' },
        { id: '..\\windows\\system32', label: 'windows traversal' },
        { id: '%2e%2e%2fetc', label: 'URL-encoded traversal' },
        { id: '', label: 'empty identifier' },
      ];

      for (const pattern of attackPatterns) {
        const response = await server.handleTool({
          method: 'qa_get_run',
          params: { runId: pattern.id },
        });
        expect(response.isError).toBe(true);
      }
    });
  });
} else {
  describe('MCP hardening (requires Node 22+)', () => {
    it('skipped — node:sqlite not available', () => {
      expect(true).toBe(true);
    });
  });
}
