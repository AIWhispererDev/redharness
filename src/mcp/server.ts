#!/usr/bin/env node

/**
 * PRD 06: MCP Server — exposes harness capabilities through the
 * Model Context Protocol (MCP) for AI agents (Claude Code, Cursor, etc.).
 *
 * Tools:
 *   qa_list_packs, qa_list_suites, qa_list_datasets,
 *   qa_validate_dataset, qa_start_run, qa_get_run,
 *   qa_cancel_run, qa_compare_runs, qa_list_findings, qa_get_finding
 *
 * Resources:
 *   qa://runs/<run-id>/summary
 *   qa://runs/<run-id>/manifest
 *   qa://findings/<finding-id>
 *   qa://datasets/<pack>/<dataset>/<version>
 *
 * Security:
 *   - Read operations are default
 *   - Run/cancel operations require explicit server configuration
 *   - No raw storage-state or secrets are exposed
 *   - Artifact access is scoped to approved run roots
 */

import path from 'node:path';
import { HarnessService } from '../service/harnessService.js';
import { registerAllSuites } from '../suites/registerSuites.js';

export type McpServerConfig = {
  /** Whether to allow startRun and cancelRun operations. */
  allowRunOperations?: boolean;
  /** Approved run directories for artifact access. */
  approvedRunRoots?: string[];
  /** Pack directory. Defaults to ./packs. */
  packsDir?: string;
  /** Runs base directory. Defaults to ./runs. */
  runsBaseDir?: string;
};

export type McpToolRequest = {
  method: string;
  params: Record<string, unknown>;
};

export type McpToolResponse = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

/**
 * MCP Server — translates MCP tool requests into service calls.
 *
 * This class implements the MCP protocol over stdio (for local execution)
 * or HTTP (for remote execution with authorization).
 *
 * Initial release: stdio transport only.
 */
export class McpServer {
  private service: HarnessService;
  private config: McpServerConfig;

  constructor(config: McpServerConfig = {}) {
    registerAllSuites();
    const runsBaseDir = path.resolve(
      config.runsBaseDir ?? path.resolve(process.cwd(), 'runs'),
    );
    this.config = {
      allowRunOperations: false, // Fail-closed
      approvedRunRoots: [runsBaseDir],
      ...config,
      runsBaseDir,
    };
    this.service = new HarnessService({
      packsDir: config.packsDir,
      runsBaseDir: config.runsBaseDir,
    });
  }

  private isApprovedRunDir(runDir: string): boolean {
    const target = path.resolve(runDir);
    return (this.config.approvedRunRoots ?? []).some((root) => {
      const relative = path.relative(path.resolve(root), target);
      return relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  }

  /**
   * Handle an MCP tool invocation.
   * This is the main dispatch for all MCP tools.
   */
  async handleTool(request: McpToolRequest): Promise<McpToolResponse> {
    try {
      switch (request.method) {
        case 'qa_list_packs':
          return await this.handleListPacks();
        case 'qa_list_suites':
          return await this.handleListSuites(request.params);
        case 'qa_list_datasets':
          return await this.handleListDatasets(request.params);
        case 'qa_validate_dataset':
          return await this.handleValidateDataset(request.params);
        case 'qa_start_run':
          return await this.handleStartRun(request.params);
        case 'qa_get_run':
          return await this.handleGetRun(request.params);
        case 'qa_cancel_run':
          return await this.handleCancelRun(request.params);
        case 'qa_compare_runs':
          return await this.handleCompareRuns(request.params);
        case 'qa_list_findings':
          return await this.handleListFindings(request.params);
        case 'qa_get_finding':
          return await this.handleGetFinding(request.params);
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${request.method}` }],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        isError: true,
      };
    }
  }

  /**
   * Handle resource access (qa:// URIs).
   */
  async handleResource(uri: string): Promise<McpToolResponse> {
    try {
      const parsed = new URL(uri);

      if (parsed.protocol !== 'qa:') {
        return { content: [{ type: 'text', text: `Unknown protocol: ${parsed.protocol}` }], isError: true };
      }

      // For custom protocol URLs like qa://runs/<id>/summary, the host
      // (e.g. "runs") is in parsed.host, not pathname. Concatenate them.
      const pathParts = [parsed.host, ...parsed.pathname.replace(/^\//, '').split('/')].filter(Boolean);

      // qa://runs/<run-id>/summary
      if (pathParts[0] === 'runs' && pathParts.length === 3 && pathParts[2] === 'summary') {
        const runId = pathParts[1];
        const { manifest } = await this.service.getRun(runId);
        if (!manifest) {
          return { content: [{ type: 'text', text: `Run not found: ${runId}` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: `# Run ${runId}\nPack: ${manifest.packId}\nStatus: ${manifest.status}\nDuration: ${manifest.durationMs ? `${(manifest.durationMs / 1000).toFixed(1)}s` : 'N/A'}\nSuites: ${manifest.suiteResults.length}`,
          }],
        };
      }

      // qa://runs/<run-id>/manifest
      if (pathParts[0] === 'runs' && pathParts.length === 3 && pathParts[2] === 'manifest') {
        const runId = pathParts[1];
        const { manifest } = await this.service.getRun(runId);
        if (!manifest) {
          return { content: [{ type: 'text', text: `Run not found: ${runId}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
        };
      }

      // qa://findings/<finding-id>
      if (pathParts[0] === 'findings' && pathParts.length === 2) {
        const findingId = pathParts[1];
        const finding = await this.service.getFinding(findingId);
        if (!finding) {
          return { content: [{ type: 'text', text: `Finding not found: ${findingId}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(finding, null, 2) }],
        };
      }

      // qa://datasets/<pack>/<dataset>/<version>
      if (pathParts[0] === 'datasets' && pathParts.length >= 3) {
        const [, packId, datasetId] = pathParts;
        const validation = await this.service.validateDataset(packId, datasetId);
        return {
          content: [{ type: 'text', text: `Dataset ${datasetId} for ${packId}: ${validation.scenarioCount} scenarios, valid: ${validation.valid}` }],
        };
      }

      return { content: [{ type: 'text', text: `Unknown resource: ${uri}` }], isError: true };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error accessing resource: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Tool handlers
  // ---------------------------------------------------------------------------

  private async handleListPacks(): Promise<McpToolResponse> {
    const packs = await this.service.listPacks();
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(packs, null, 2),
      }],
    };
  }

  private async handleListSuites(params: Record<string, unknown>): Promise<McpToolResponse> {
    const suites = this.service.listSuites();
    const filterTags = params.tags ? String(params.tags).split(',') : undefined;

    let filtered = suites;
    if (filterTags && filterTags.length > 0) {
      const tagSet = new Set(filterTags.map((t) => t.trim().toLowerCase()));
      filtered = suites.filter((s) => s.tags.some((t) => tagSet.has(t.toLowerCase())));
    }

    const result = filtered.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description,
      tags: s.tags,
      requirement: s.requirement,
      estimatedDuration: s.estimatedDuration,
      dependencies: s.dependencies,
      requires: s.requires,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async handleListDatasets(params: Record<string, unknown>): Promise<McpToolResponse> {
    const packId = String(params.pack ?? '');
    if (!packId) {
      return { content: [{ type: 'text', text: 'pack parameter is required' }], isError: true };
    }

    const { readdir } = await import('node:fs/promises');
    const dsBase = path.resolve(
      this.config.packsDir ?? path.resolve(process.cwd(), 'packs'),
      packId,
      'datasets',
    );

    try {
      const entries = await readdir(dsBase, { withFileTypes: true });
      const datasets = entries
        .filter((e: any) => e.isDirectory())
        .map((e: any) => e.name);
      return {
        content: [{ type: 'text', text: JSON.stringify({ pack: packId, datasets }) }],
      };
    } catch {
      return {
        content: [{ type: 'text', text: JSON.stringify({ pack: packId, datasets: [], error: 'No datasets found' }) }],
      };
    }
  }

  private async handleValidateDataset(params: Record<string, unknown>): Promise<McpToolResponse> {
    const packId = String(params.pack ?? '');
    const datasetId = String(params.dataset ?? '');

    if (!packId || !datasetId) {
      return { content: [{ type: 'text', text: 'pack and dataset parameters are required' }], isError: true };
    }

    const result = await this.service.validateDataset(packId, datasetId);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async handleStartRun(params: Record<string, unknown>): Promise<McpToolResponse> {
    if (!this.config.allowRunOperations) {
      return {
        content: [{ type: 'text', text: 'Run operations are disabled on this server. Set allowRunOperations: true to enable.' }],
        isError: true,
      };
    }

    if (params.storageState || params.nonProStorageState || params.runDir) {
      return {
        content: [{
          type: 'text',
          text: 'MCP runs cannot supply storage-state or arbitrary run-directory paths.',
        }],
        isError: true,
      };
    }

    const result = await this.service.startRunDetached({
      packId: String(params.pack ?? ''),
      profile: params.profile ? String(params.profile) : undefined,
      suites: params.suites ? (params.suites as string[]) : undefined,
      tags: params.tags ? (params.tags as string[]) : undefined,
      excludedTags: params.excludedTags ? (params.excludedTags as string[]) : undefined,
      headless: params.headless !== false,
      workers: params.workers ? Number(params.workers) : undefined,
      retryErrors: params.retryErrors ? Number(params.retryErrors) : undefined,
      timeoutMs: params.timeoutMs ? Number(params.timeoutMs) : undefined,
      source: 'mcp',
    });

    if (!this.isApprovedRunDir(result.runDir)) {
      await this.service.cancelRun(result.runId);
      return {
        content: [{ type: 'text', text: 'Generated run directory is outside approved roots.' }],
        isError: true,
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          runId: result.runId,
          status: 'running',
        }, null, 2),
      }],
    };
  }

  private async handleGetRun(params: Record<string, unknown>): Promise<McpToolResponse> {
    const runId = String(params.runId ?? '');
    if (!runId) {
      return { content: [{ type: 'text', text: 'runId parameter is required' }], isError: true };
    }

    const { manifest } = await this.service.getRun(runId);
    if (!manifest) {
      return { content: [{ type: 'text', text: `Run not found: ${runId}` }], isError: true };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          runId: manifest.runId,
          packId: manifest.packId,
          status: manifest.status,
          profile: manifest.profile,
          source: manifest.source,
          startedAt: manifest.startedAt,
          endedAt: manifest.endedAt,
          durationMs: manifest.durationMs,
          suiteResults: manifest.suiteResults.map((sr) => ({
            suiteId: sr.suiteId,
            title: sr.title,
            status: sr.status,
            requirement: sr.requirement,
            durationMs: sr.durationMs,
            attemptCount: sr.attemptCount,
          })),
        }, null, 2),
      }],
    };
  }

  private async handleCancelRun(params: Record<string, unknown>): Promise<McpToolResponse> {
    if (!this.config.allowRunOperations) {
      return {
        content: [{ type: 'text', text: 'Run operations are disabled on this server. Set allowRunOperations: true to enable.' }],
        isError: true,
      };
    }

    const runId = String(params.runId ?? '');
    if (!runId) {
      return { content: [{ type: 'text', text: 'runId parameter is required' }], isError: true };
    }

    const success = await this.service.cancelRun(runId);
    return {
      content: [{ type: 'text', text: success ? `Run ${runId} cancelled` : `Run ${runId} not found` }],
    };
  }

  private async handleCompareRuns(params: Record<string, unknown>): Promise<McpToolResponse> {
    const baseline = String(params.baseline ?? '');
    const candidate = String(params.candidate ?? '');

    if (!baseline || !candidate) {
      return { content: [{ type: 'text', text: 'baseline and candidate parameters are required' }], isError: true };
    }

    const result = await this.service.compareRuns(baseline, candidate);
    if (result.error) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.comparison, null, 2) }],
    };
  }

  private async handleListFindings(params: Record<string, unknown>): Promise<McpToolResponse> {
    const runId = String(params.runId ?? '');
    if (!runId) {
      return { content: [{ type: 'text', text: 'runId parameter is required' }], isError: true };
    }

    const findings = await this.service.listFindings(runId);
    return {
      content: [{ type: 'text', text: JSON.stringify(findings, null, 2) }],
    };
  }

  private async handleGetFinding(params: Record<string, unknown>): Promise<McpToolResponse> {
    const findingId = String(params.findingId ?? '');
    if (!findingId) {
      return { content: [{ type: 'text', text: 'findingId parameter is required' }], isError: true };
    }

    const finding = await this.service.getFinding(findingId);
    if (!finding) {
      return { content: [{ type: 'text', text: `Finding not found: ${findingId}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(finding, null, 2) }],
    };
  }

  /**
   * Handle an MCP JSON-RPC request.
   * This is the entry point for stdio/HTTP transport.
   */
  async handleRequest(request: {
    jsonrpc: string;
    id: string | number;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<string> {
    const { method, params = {}, id } = request;

    if (method === 'initialize') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'qa-harness', version: '1.0.0' },
        },
      });
    }

    if (method === 'notifications/initialized') {
      return '';
    }

    if (method === 'tools/list') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: { tools: this.getToolDefinitions() },
      });
    }

    if (method === 'resources/list') {
      return JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            { uri: 'qa://runs/{runId}/summary', name: 'Run summary' },
            { uri: 'qa://runs/{runId}/manifest', name: 'Run manifest' },
            { uri: 'qa://findings/{findingId}', name: 'Finding' },
            { uri: 'qa://datasets/{pack}/{dataset}/{version}', name: 'Dataset' },
          ],
        },
      });
    }

    if (method === 'resources/read') {
      const uri = params.uri as string;
      const response = await this.handleResource(uri);
      return JSON.stringify({ jsonrpc: '2.0', id, result: response });
    }

    if (method === 'tools/call') {
      const name = String(params.name ?? '');
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const response = await this.handleTool({ method: name, params: args });
      return JSON.stringify({ jsonrpc: '2.0', id, result: response });
    }

    // Backward-compatible direct tool invocation.
    const response = await this.handleTool({ method, params });
    return JSON.stringify({ jsonrpc: '2.0', id, result: response });
  }

  private getToolDefinitions(): Array<Record<string, unknown>> {
    const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    });
    const text = { type: 'string' };
    return [
      { name: 'qa_list_packs', description: 'List available QA packs', inputSchema: objectSchema({}) },
      { name: 'qa_list_suites', description: 'List registered QA suites', inputSchema: objectSchema({ tags: text }) },
      { name: 'qa_list_datasets', description: 'List datasets for a pack', inputSchema: objectSchema({ pack: text }, ['pack']) },
      { name: 'qa_validate_dataset', description: 'Validate a dataset', inputSchema: objectSchema({ pack: text, dataset: text }, ['pack', 'dataset']) },
      { name: 'qa_start_run', description: 'Start a bounded QA run', inputSchema: objectSchema({ pack: text, profile: text, suites: { type: 'array', items: text }, tags: { type: 'array', items: text }, excludedTags: { type: 'array', items: text }, headless: { type: 'boolean' }, workers: { type: 'number' }, retryErrors: { type: 'number' }, timeoutMs: { type: 'number' } }, ['pack']) },
      { name: 'qa_get_run', description: 'Get run status and results', inputSchema: objectSchema({ runId: text }, ['runId']) },
      { name: 'qa_cancel_run', description: 'Cancel an active run', inputSchema: objectSchema({ runId: text }, ['runId']) },
      { name: 'qa_compare_runs', description: 'Compare baseline and candidate runs', inputSchema: objectSchema({ baseline: text, candidate: text }, ['baseline', 'candidate']) },
      { name: 'qa_list_findings', description: 'List findings for a run', inputSchema: objectSchema({ runId: text }, ['runId']) },
      { name: 'qa_get_finding', description: 'Get one finding', inputSchema: objectSchema({ findingId: text }, ['findingId']) },
    ];
  }
}

// ---------------------------------------------------------------------------
// Main entry point — stdio transport
// ---------------------------------------------------------------------------

/**
 * Start the MCP server over stdio transport.
 * Reads JSON-RPC requests from stdin and writes responses to stdout.
 */
export async function startStdioServer(config?: McpServerConfig): Promise<void> {
  const server = new McpServer(config);

  // Read requests from stdin
  const readline = (await import('node:readline')).default;
  const rl = readline.createInterface({ input: process.stdin });

  for await (const line of rl) {
    try {
      const request = JSON.parse(line);
      const response = await server.handleRequest(request);
      if (response) process.stdout.write(response + '\n');
    } catch (error) {
      const errorResponse = {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: `Parse error: ${error instanceof Error ? error.message : String(error)}`,
        },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  }
}

// Run if called directly
const isMainModule = process.argv[1]?.includes('mcp/server');
if (isMainModule) {
  startStdioServer({
    allowRunOperations: process.env.QA_MCP_ALLOW_RUN === 'true',
    packsDir: process.env.QA_PACKS_DIR,
    runsBaseDir: process.env.QA_RUNS_DIR,
  }).catch(console.error);
}
