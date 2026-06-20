/**
 * PRD 06: MCP protocol adapter tests.
 *
 * Note: McpServer imports HarnessService which imports RunCatalog
 * (node:sqlite). These tests dynamically import to work on Node < 22.
 */

import { describe, expect, it, beforeAll } from 'vitest';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let McpServer: any;

beforeAll(async () => {
  if (hasSqlite) {
    const mod = await import('../src/mcp/server.js');
    McpServer = mod.McpServer;
  }
}, 10000);

if (hasSqlite) {
  describe('MCP protocol adapter', () => {
    it('supports standard initialize and tools/list requests', async () => {
      const server = new McpServer();
      const initialized = JSON.parse(await server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      }));
      const listed = JSON.parse(await server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      }));

      expect(initialized.result.serverInfo.name).toBe('qa-harness');
      expect(listed.result.tools.some(
        (tool: { name: string }) => tool.name === 'qa_start_run',
      )).toBe(true);
      expect(listed.result.tools.some(
        (tool: { name: string }) => tool.name === 'qa_list_baselines',
      )).toBe(true);
      expect(listed.result.tools.some(
        (tool: { name: string }) => tool.name === 'qa_get_baseline',
      )).toBe(true);
    });

    it('dispatches standard tools/call requests', async () => {
      const server = new McpServer();
      const response = JSON.parse(await server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'qa_list_suites', arguments: {} },
      }));

      expect(response.result.isError).not.toBe(true);
      expect(JSON.parse(response.result.content[0].text).length).toBeGreaterThan(0);
    });

    it('rejects secret-bearing path parameters on MCP runs', async () => {
      const server = new McpServer({ allowRunOperations: true });
      const response = await server.handleTool({
        method: 'qa_start_run',
        params: {
          pack: 'pocket-socrates',
          storageState: 'outside/auth.json',
        },
      });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('cannot supply storage-state');
    });

    it('rejects traversal in runId parameters', async () => {
      const server = new McpServer();
      const response = await server.handleTool({
        method: 'qa_get_run',
        params: { runId: '../../../etc/shadow' },
      });
      expect(response.isError).toBe(true);
    });

    it('rejects traversal in findingId parameters', async () => {
      const server = new McpServer();
      const response = await server.handleTool({
        method: 'qa_get_finding',
        params: { findingId: '../../../etc/passwd' },
      });
      expect(response.isError).toBe(true);
    });
  });
} else {
  describe('MCP protocol adapter (requires Node 22+)', () => {
    it('skipped — node:sqlite not available', () => {
      expect(true).toBe(true);
    });
  });
}
