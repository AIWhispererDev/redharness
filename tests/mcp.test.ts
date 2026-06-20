import { describe, expect, it } from 'vitest';
import { McpServer } from '../src/mcp/server.js';

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
});
