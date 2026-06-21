/**
 * PRD 10: MCP policy allowlist tests.
 *
 * Tests:
 * - MCP rejects unapproved packs, profiles, suites, tags, roots, and targets
 * - Allowlist enforcement traversal combinations
 * - Same selection policy as CLI
 * - Network target allowlist
 * - Output root containment
 *
 * Note: McpServer imports HarnessService which imports RunCatalog
 * (node:sqlite). These tests dynamically import to work on Node < 22.
 */

import { describe, it, expect, beforeAll } from 'vitest';

const hasSqlite = Number(process.version.slice(1).split('.')[0]) >= 22;

let McpServer: any;
let operationalPolicy: any;

beforeAll(async () => {
  if (hasSqlite) {
    const mod = await import('../src/mcp/server.js');
    McpServer = mod.McpServer;
    operationalPolicy = await import('../src/operations/operationalPolicy.js');
  }
}, 10000);

if (hasSqlite) {
  // ───────────────────────────────────────────────────────────────────────
  // 1. Pack allowlist enforcement
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP pack allowlist', () => {
    it('allows a pack in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { packs: ['fixture-web'] },
        },
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });

      // Should proceed (may fail later if no runs dir, but not at policy level)
      expect(resp.isError).toBeFalsy();
    }, 15000);

    it('rejects a pack not in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { packs: ['fixture-web'] },
        },
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-agent' },
      });

      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('not in the allowed packs');
    });

    it('allows all packs when allowlist is empty', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { packs: [] },
        },
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web' },
      });

      // Empty allowlist means unrestricted
      expect(resp.isError).toBeFalsy();
    }, 15000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 2. Profile allowlist enforcement
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP profile allowlist', () => {
    it('rejects a profile not in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { profiles: ['smoke'] },
        },
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', profile: 'release' },
      });

      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('not in the allowed profiles');
    });

    it('allows a profile in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { profiles: ['release'] },
        },
        runsBaseDir: '/tmp/mcp-policy-profile-test',
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', profile: 'release' },
      });

      // Profile is allowed; remaining results depend on fixture/web startup
      expect(resp.isError).toBeFalsy();
    }, 15000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 3. Suite allowlist enforcement
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP suite allowlist', () => {
    it('rejects a suite not in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { suites: ['public-routes'] },
        },
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', suites: ['unknown-suite'] },
      });

      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('not in allowed');
    });

    it('allows a suite in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { suites: ['public-routes'] },
        },
        runsBaseDir: '/tmp/mcp-policy-suite-test',
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', suites: ['public-routes'] },
      });

      expect(resp.isError).toBeFalsy();
    }, 15000);
  });

  // ───────────────────────────────────────────────────────────────────────
  // 4. Tag allowlist enforcement
  // ───────────────────────────────────────────────────────────────────────

  describe('MCP tag allowlist', () => {
    it('rejects a tag not in the allowlist', async () => {
      const server = new McpServer({
        allowRunOperations: true,
        policy: {
          mcp: { tags: ['smoke'] },
        },
      });

      const resp = await server.handleTool({
        method: 'qa_start_run',
        params: { pack: 'fixture-web', tags: ['release', 'unknown'] },
      });

      expect(resp.isError).toBe(true);
      expect(resp.content[0].text).toContain('not in allowed');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 5. Network target allowlist
  // ───────────────────────────────────────────────────────────────────────

  describe('Network target allowlist', () => {
    it('allows a target with wildcard port', () => {
      const result = operationalPolicy.checkNetworkTargetPolicy(
        'http://127.0.0.1:3000/api/test',
        { networkTargets: ['http://127.0.0.1:*'] },
      );
      expect(result.allowed).toBe(true);
    });

    it('rejects a target not in the allowlist', () => {
      const result = operationalPolicy.checkNetworkTargetPolicy(
        'https://external-api.example.com/data',
        { networkTargets: ['http://127.0.0.1:*'] },
      );
      expect(result.allowed).toBe(false);
    });

    it('allows an exact origin match', () => {
      const result = operationalPolicy.checkNetworkTargetPolicy(
        'https://api.example.com/v1',
        { networkTargets: ['https://api.example.com'] },
      );
      expect(result.allowed).toBe(true);
    });

    it('returns allowed when no network allowlist is configured', () => {
      const result = operationalPolicy.checkNetworkTargetPolicy(
        'https://anything.example.com',
        {},
      );
      expect(result.allowed).toBe(true);
    });

    it('rejects an invalid URL', () => {
      const result = operationalPolicy.checkNetworkTargetPolicy(
        'not-a-url',
        { networkTargets: ['http://127.0.0.1:*'] },
      );
      expect(result.allowed).toBe(false);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 6. Output root allowlist
  // ───────────────────────────────────────────────────────────────────────

  describe('Output root allowlist', () => {
    it('allows a path within an allowed root', () => {
      const result = operationalPolicy.checkOutputRootPolicy(
        '/var/qa/runs/run-123',
        { outputRoots: ['/var/qa/runs'] },
      );
      expect(result.allowed).toBe(true);
    });

    it('rejects a path outside all allowed roots', () => {
      const result = operationalPolicy.checkOutputRootPolicy(
        '/tmp/evil/run',
        { outputRoots: ['/var/qa/runs'] },
      );
      expect(result.allowed).toBe(false);
    });

    it('allows exact root match', () => {
      const result = operationalPolicy.checkOutputRootPolicy(
        '/var/qa/runs',
        { outputRoots: ['/var/qa/runs'] },
      );
      expect(result.allowed).toBe(true);
    });

    it('returns allowed when no output roots are configured', () => {
      const result = operationalPolicy.checkOutputRootPolicy('/tmp/anything', {});
      expect(result.allowed).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 7. Selection policy traversal combinations
  // ───────────────────────────────────────────────────────────────────────

  describe('Selection policy traversal combinations', () => {
    it('rejects pack and profile combination outside allowlist', () => {
      const result = operationalPolicy.checkSelectionPolicy(
        'fixture-web',
        'release',
        [],
        [],
        { packs: ['fixture-agent'], profiles: ['smoke'] },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('fixture-web');
    });

    it('allows pack and profile when both are in allowlist', () => {
      const result = operationalPolicy.checkSelectionPolicy(
        'fixture-web',
        'smoke',
        [],
        [],
        { packs: ['fixture-web'], profiles: ['smoke'] },
      );
      expect(result.allowed).toBe(true);
    });

    it('rejects when suites are outside allowlist even if pack is allowed', () => {
      const result = operationalPolicy.checkSelectionPolicy(
        'fixture-web',
        undefined,
        ['evil-suite'],
        [],
        { packs: ['fixture-web'], suites: ['public-routes'] },
      );
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('evil-suite');
    });

    it('allows when no allowlist is configured', () => {
      const result = operationalPolicy.checkSelectionPolicy(
        'anything',
        'any',
        ['any-suite'],
        ['any-tag'],
        undefined,
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 8. Policy tool-level checks
  // ───────────────────────────────────────────────────────────────────────

  describe('Tool-level policy enforcement', () => {
    it('rejects cancel_run when allowMcpRunOperations is false', () => {
      const result = operationalPolicy.checkMcpToolPolicy(
        'qa_cancel_run',
        {},
        { ...operationalPolicy.DEFAULT_OPERATIONAL_POLICY, allowMcpRunOperations: false },
      );
      expect(result.allowed).toBe(false);
    });

    it('allows cancel_run when policy permits', () => {
      const result = operationalPolicy.checkMcpToolPolicy(
        'qa_cancel_run',
        {},
        { ...operationalPolicy.DEFAULT_OPERATIONAL_POLICY, allowMcpRunOperations: true },
      );
      expect(result.allowed).toBe(true);
    });

    it('rejects approval operations without explicit opt-in', () => {
      const result = operationalPolicy.checkMcpToolPolicy(
        'qa_approve_agent_tool',
        {},
        { ...operationalPolicy.DEFAULT_OPERATIONAL_POLICY, allowMcpApprovals: false },
      );
      expect(result.allowed).toBe(false);
    });

    it('allows read operations regardless of policy', () => {
      const result = operationalPolicy.checkMcpToolPolicy(
        'qa_list_packs',
        {},
        operationalPolicy.DEFAULT_OPERATIONAL_POLICY,
      );
      expect(result.allowed).toBe(true);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // 9. Operational policy schema validation
  // ───────────────────────────────────────────────────────────────────────

  describe('Operational policy schema validation', () => {
    it('parses a minimal policy with defaults', () => {
      const parsed = operationalPolicy.operationalPolicySchema.parse({});
      expect(parsed.allowMcpRunOperations).toBe(false);
      expect(parsed.allowMcpApprovals).toBe(false);
      expect(parsed.allowScheduledRuns).toBe(true);
      expect(parsed.maxScheduledWorkers).toBe(3);
      expect(parsed.otelFailSilently).toBe(true);
      expect(parsed.otelExportTimeoutMs).toBe(5000);
      expect(parsed.retentionDays).toBe(90);
      expect(parsed.retentionDryRun).toBe(true);
    });

    it('parses a full policy with custom values', () => {
      const parsed = operationalPolicy.operationalPolicySchema.parse({
        allowMcpRunOperations: true,
        allowMcpApprovals: true,
        maxScheduledWorkers: 5,
        otelFailSilently: false,
        otelExportTimeoutMs: 10000,
        retentionDays: 180,
        retentionDryRun: false,
        mcp: { packs: ['fixture-web'] },
      });
      expect(parsed.allowMcpRunOperations).toBe(true);
      expect(parsed.allowMcpApprovals).toBe(true);
      expect(parsed.maxScheduledWorkers).toBe(5);
      expect(parsed.otelFailSilently).toBe(false);
      expect(parsed.otelExportTimeoutMs).toBe(10000);
      expect(parsed.retentionDays).toBe(180);
      expect(parsed.retentionDryRun).toBe(false);
      expect(parsed.mcp?.packs).toEqual(['fixture-web']);
    });
  });
} else {
  describe('MCP policy (requires Node 22+)', () => {
    it('skipped — node:sqlite not available', () => {
      expect(true).toBe(true);
    });
  });
}
