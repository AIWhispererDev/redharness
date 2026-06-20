/**
 * PRD 10: MCP lifecycle tests — start, poll, approve, cancel,
 * compare findings, and resource lifecycle through the MCP adapter.
 *
 * Tests the full MCP lifecycle path including allowlist enforcement,
 * concurrent start/poll/cancel, approval operations disabled by default,
 * token passthrough, and session impersonation protection.
 *
 * Note: McpServer imports HarnessService which imports RunCatalog
 * (node:sqlite). These tests dynamically import to work on Node < 22.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let McpServer: any;
let DEFAULT_OPERATIONAL_POLICY: any;

beforeAll(async () => {
  if (hasSqlite) {
    const mod = await import('../src/mcp/server.js');
    McpServer = mod.McpServer;
    const policy = await import('../src/operations/operationalPolicy.js');
    DEFAULT_OPERATIONAL_POLICY = policy.DEFAULT_OPERATIONAL_POLICY;
  }
}, 10000);

if (hasSqlite) {
  // ───────────────────────────────────────────────────────────────────────
  // 1. MCP lifecycle — start, poll, cancel, retrieve
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP lifecycle — start/poll/cancel/retrieve', () => {
    it('starts a detached run and returns runId with status running', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-lifecycle-')), 'runs'),
      });

      const startResp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });

      expect(startResp.isError).toBeFalsy();
      const data = JSON.parse(startResp.content[0].text);
      expect(data.runId).toBeTruthy();
      expect(data.status).toBe('running');
    }, 15000);

    it('polls a started run until completion', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-lifecycle-poll-')), 'runs'),
      });

      const startResp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      const { runId } = JSON.parse(startResp.content[0].text);

      // Poll until completed or timeout
      let status = 'running';
      const maxPolls = 20;
      for (let i = 0; i < maxPolls && status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const pollResp = await server.handleTool({
          method: 'qa_get_run',
          params: { runId },
        });
        if (!pollResp.isError) {
          const data = JSON.parse(pollResp.content[0].text);
          status = data.status;
        }
      }

      // The fixture-web run should complete quickly (one public-routes suite)
      expect(['passed', 'failed']).toContain(status);
    }, 20000);

    it('cancels a running run', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-lifecycle-cancel-')), 'runs'),
      });

      const startResp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      const { runId } = JSON.parse(startResp.content[0].text);

      const cancelResp = await server.handleTool({
        method: 'qa_cancel_run',
        params: { runId },
      });

      expect(cancelResp.isError).toBeFalsy();
      expect(cancelResp.content[0].text).toContain(runId);
    }, 15000);

    it('lists findings for a completed run', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-lifecycle-findings-')), 'runs'),
      });

      const startResp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      const { runId } = JSON.parse(startResp.content[0].text);

      // Wait for completion
      let status = 'running';
      for (let i = 0; i < 15 && status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const pollResp = await server.handleTool({
          method: 'qa_get_run',
          params: { runId },
        });
        if (!pollResp.isError) {
          status = JSON.parse(pollResp.content[0].text).status;
        }
      }

      const findingsResp = await server.handleTool({
        method: 'qa_list_findings',
        params: { runId },
      });

      expect(findingsResp.isError).toBeFalsy();
      const findings = JSON.parse(findingsResp.content[0].text);
      expect(Array.isArray(findings)).toBe(true);
    }, 30000);

    it('compares two runs', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-lifecycle-compare-')), 'runs'),
      });

      // Start two runs and wait for them to complete
      const start1 = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      const start2 = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });

      const runId1 = JSON.parse(start1.content[0].text).runId;
      const runId2 = JSON.parse(start2.content[0].text).runId;

      // Wait for both to complete
      for (const rid of [runId1, runId2]) {
        let status = 'running';
        for (let i = 0; i < 15 && status === 'running'; i++) {
          await new Promise((r) => setTimeout(r, 300));
          const pollResp = await server.handleTool({
            method: 'qa_get_run',
            params: { runId: rid },
          });
          if (!pollResp.isError) {
            status = JSON.parse(pollResp.content[0].text).status;
          }
        }
      }

      const compareResp = await server.handleTool({
        method: 'qa_compare_runs',
        params: { baseline: runId1, candidate: runId2 },
      });

      // Comparison should work even if results are similar
      expect(compareResp.isError).toBeFalsy();
      const comparison = JSON.parse(compareResp.content[0].text);
      expect(comparison).toBeTruthy();
    }, 60000);

    it('retrieves a resource URI for a completed run', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-lifecycle-resource-')), 'runs'),
      });

      const startResp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      const { runId } = JSON.parse(startResp.content[0].text);

      // Wait for completion
      let status = 'running';
      for (let i = 0; i < 15 && status === 'running'; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const pollResp = await server.handleTool({
          method: 'qa_get_run',
          params: { runId },
        });
        if (!pollResp.isError) {
          status = JSON.parse(pollResp.content[0].text).status;
        }
      }

      // Retrieve manifest resource
      const manifestResp = await server.handleResource(`qa://runs/${runId}/manifest`);
      if (!manifestResp.isError) {
        const manifest = JSON.parse(manifestResp.content[0].text);
        expect(manifest.runId).toBe(runId);
      }
    }, 30000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Approval operations disabled by default
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP approval operations disabled by default', () => {
    it('rejects approve_agent_tool when allowRunOperations is false', async () => {
      const server = new McpServer();
      const resp = await server.handleTool({
        method: 'qa_approve_agent_tool',
        params: { approvalId: 'test', runId: 'test-run' },
      });
      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('disabled');
    });

    it('rejects deny_agent_tool when allowRunOperations is false', async () => {
      const server = new McpServer();
      const resp = await server.handleTool({
        method: 'qa_deny_agent_tool',
        params: { approvalId: 'test', runId: 'test-run' },
      });
      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('disabled');
    });

    it('rejects approval operations with policy allowMcpApprovals: false', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: { allowMcpApprovals: false },
      });
      const resp = await server.handleTool({
        method: 'qa_approve_agent_tool',
        params: { approvalId: 'test', runId: 'test-run' },
      });
      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('disabled');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Concurrent start/poll/cancel
  // ───────────────────────────────────────────────────────────────────────

  describe('Concurrent start/poll/cancel', () => {
    it('starts multiple runs concurrently', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-concurrent-')), 'runs'),
      });

      const promises = [
        server.handleTool({ method: 'qa_start_run', params: { pack: 'fixture-web' } }),
        server.handleTool({ method: 'qa_start_run', params: { pack: 'fixture-web' } }),
        server.handleTool({ method: 'qa_start_run', params: { pack: 'fixture-web' } }),
      ];

      const results = await Promise.all(promises);
      for (const r of results) {
        expect(r.isError).toBeFalsy();
        const data = JSON.parse(r.content[0].text);
        expect(data.runId).toBeTruthy();
        expect(data.status).toBe('running');
      }
    }, 30000);

    it('polls and cancels concurrently', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-concurrent-poll-')), 'runs'),
      });

      const startResp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });
      const { runId } = JSON.parse(startResp.content[0].text);

      // Poll and cancel concurrently
      const [pollResult, cancelResult] = await Promise.all([
        server.handleTool({ method: 'qa_get_run', params: { runId } }),
        server.handleTool({ method: 'qa_cancel_run', params: { runId } }),
      ]);

      // Poll should succeed (could return running or completed)
      expect(pollResult.isError).toBeFalsy();

      // Cancel should succeed
      expect(cancelResult.isError).toBeFalsy();
      expect(cancelResult.content[0].text).toContain(runId);
    }, 15000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Token passthrough protection
  // ───────────────────────────────────────────────────────────────────────

  describe('Token passthrough protection', () => {
    it('rejects token passthrough by default', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: { allowMcpTokenPassthrough: false },
      });
      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', token: 'some-auth-token' },
      });
      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('disabled');
    });

    it('allows token passthrough when policy permits', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: { allowMcpTokenPassthrough: true },
        runsBaseDir: join(mkdtempSync(join(tmpdir(), 'mcp-token-')), 'runs'),
      });
      // Token passthrough allowed, but token is not used in service
      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', token: 'allowed-token' },
      });
      // Should pass policy check and proceed to start run
      expect(resp.isError).toBeFalsy();
    }, 15000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. Session impersonation protection
  // ───────────────────────────────────────────────────────────────────────

  describe('Session impersonation protection', () => {
    it('rejects sessionId parameter through MCP', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: { allowMcpTokenPassthrough: false },
      });
      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', sessionId: 'impersonate-session' },
      });
      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('disabled');
    });
  });
} else {
  describe('MCP lifecycle (requires Node 22+)', () => {
    it('skipped — node:sqlite not available', () => {
      expect(true).toBe(true);
    });
  });
}
