#!/usr/bin/env node

/**
 * PRD 06: MCP Server — exposes harness capabilities through the
 * Model Context Protocol (MCP) for AI agents (Claude Code, Cursor, etc.).
 *
 * Tools:
 *   qa_list_packs, qa_list_suites, qa_list_datasets,
 *   qa_validate_dataset, qa_start_run, qa_get_run,
 *   qa_cancel_run, qa_compare_runs, qa_list_findings, qa_get_finding,
 *   qa_list_baselines, qa_get_baseline,
 *   qa_approve_agent_tool, qa_deny_agent_tool,
 *   qa_get_agent_run, qa_list_agent_runs, qa_cancel_agent_run
 *   qa_get_finding_detail, qa_get_schema_version, qa_rebuild_catalog
 *
 * Resources:
 *   qa://runs/<run-id>/summary
 *   qa://runs/<run-id>/manifest
 *   qa://runs/<run-id>/attempts
 *   qa://findings/<finding-id>
 *   qa://datasets/<pack>/<dataset>/<version>
 *   qa://baselines/<name>
 *   qa://baselines/<name>/run
 *
 * Security:
 *   - Read operations are default
 *   - Run/cancel operations require explicit server configuration
 *   - No raw storage-state or secrets are exposed
 *   - Artifact access is scoped to approved run roots
 *   - All user-supplied identifiers are validated against a strict pattern
 *   - Resource URIs are validated for path containment within approved roots
 */

import path from 'node:path';
import { HarnessService } from '../service/harnessService.js';
import { registerAllSuites } from '../suites/registerSuites.js';
import {
  DEFAULT_OPERATIONAL_POLICY,
  checkMcpToolPolicy,
  checkSelectionPolicy,
  checkNetworkTargetPolicy,
  checkOutputRootPolicy,
  operationalPolicySchema,
  type OperationalPolicy,
  type McpAllowlist,
} from '../operations/operationalPolicy.js';

export type McpServerConfig = {
  /** Whether to allow startRun and cancelRun operations. */
  allowRunOperations?: boolean;
  /** Approved run directories for artifact access. */
  approvedRunRoots?: string[];
  /** Pack directory. Defaults to ./packs. */
  packsDir?: string;
  /** Runs base directory. Defaults to ./runs. */
  runsBaseDir?: string;
  /** Operational policy (overrides legacy boolean flags). */
  policy?: OperationalPolicy;
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
  private config: McpServerConfig & { policy?: OperationalPolicy };

  constructor(config: McpServerConfig = {}) {
    registerAllSuites();
    const runsBaseDir = path.resolve(
      config.runsBaseDir ?? path.resolve(process.cwd(), 'runs'),
    );

    // Resolve operational policy
    let policy: OperationalPolicy;
    if (config.policy) {
      policy = operationalPolicySchema.parse(config.policy) as OperationalPolicy;
    } else {
      policy = {
        ...DEFAULT_OPERATIONAL_POLICY,
        allowMcpRunOperations: config.allowRunOperations ?? false,
      };
    }

    this.config = {
      allowRunOperations: policy.allowMcpRunOperations,
      approvedRunRoots: [runsBaseDir],
      ...config,
      runsBaseDir,
      policy,
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
   * Validate a user-supplied identifier against the strict safe pattern.
   * This is applied to ALL identifiers that reach filesystem paths,
   * database lookups, or resource URIs.
   *
   * The safe pattern allows only alphanumeric chars, dots, underscores,
   * and hyphens, and must start with a letter or digit.
   *
   * For runId and findingId, which may contain a forward-slash separator
   * (e.g. "run-123/suite-abc"), an extended variant is available.
   */
  private safeIdentifier(value: unknown, label: string): string {
    return this.validateIdentifier(value, label, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  }

  /**
   * Like safeIdentifier but allows a single forward slash separator
   * for compound identifiers (runId/findingId).
   */
  private safeCompoundIdentifier(value: unknown, label: string): string {
    return this.validateIdentifier(value, label, /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/);
  }

  private validateIdentifier(
    value: unknown,
    label: string,
    pattern: RegExp,
  ): string {
    const identifier = String(value ?? '');
    if (!identifier) {
      throw new Error(`${label} must not be empty`);
    }
    if (identifier.length > 256) {
      throw new Error(`${label} must not exceed 256 characters`);
    }
    if (!pattern.test(identifier)) {
      throw new Error(
        `${label} must be a simple identifier matching ${pattern.source}`,
      );
    }
    return identifier;
  }

  /**
   * Validate that a path is contained within one of the approved roots.
   * Resolves symlinks and prevents traversal via .. or absolute paths
   * that escape approved boundaries.
   */
  private checkPathContainment(resolvedPath: string): void {
    const target = path.resolve(resolvedPath);
    const roots = this.config.approvedRunRoots ?? [];
    for (const root of roots) {
      const resolvedRoot = path.resolve(root);
      const relative = path.relative(resolvedRoot, target);
      if (
        relative === '' ||
        (!relative.startsWith('..') && !path.isAbsolute(relative))
      ) {
        return; // Allowed — inside this root
      }
    }
    throw new Error(
      `Path is outside approved roots. Allowed roots: ${roots.join(', ')}`,
    );
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
        case 'qa_list_baselines':
          return await this.handleListBaselines();
        case 'qa_get_baseline':
          return await this.handleGetBaseline(request.params);
        case 'qa_approve_agent_tool':
          return await this.handleApproveAgentTool(request.params);
        case 'qa_deny_agent_tool':
          return await this.handleDenyAgentTool(request.params);
        case 'qa_get_agent_run':
          return await this.handleGetAgentRun(request.params);
        case 'qa_list_agent_runs':
          return await this.handleListAgentRuns(request.params);
        case 'qa_cancel_agent_run':
          return await this.handleCancelAgentRun(request.params);
        case 'qa_get_finding_detail':
          return await this.handleGetFindingDetail(request.params);
        case 'qa_get_schema_version':
          return await this.handleGetSchemaVersion();
        case 'qa_rebuild_catalog':
          return await this.handleRebuildCatalog();
        case 'qa_list_suite_attempts':
          return await this.handleListSuiteAttempts(request.params);
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
   *
   * Security: Every path component from the URI is validated against
   * safeIdentifier rules before use in service calls or filesystem paths.
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

      // All resources must have at least 2 path parts.
      if (pathParts.length < 2) {
        return { content: [{ type: 'text', text: 'Malformed resource URI' }], isError: true };
      }

      // Validate all path parts except the resource type prefix are safe identifiers
      // The first part (resource type: 'runs', 'findings', 'datasets', 'baselines')
      // must also be safe to prevent structural traversal.
      for (const part of pathParts) {
        this.safeIdentifier(part, 'resource path component');
      }

      // qa://runs/<run-id>/summary
      if (pathParts[0] === 'runs' && pathParts.length === 3 && pathParts[2] === 'summary') {
        const runId = pathParts[1];
        const { manifest, entry } = await this.service.getRun(runId);
        if (!manifest) {
          return { content: [{ type: 'text', text: `Run not found: ${runId}` }], isError: true };
        }
        // Verify the run directory is within approved roots
        if (entry?.runDir) {
          this.checkPathContainment(entry.runDir);
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
        const { manifest, entry } = await this.service.getRun(runId);
        if (!manifest) {
          return { content: [{ type: 'text', text: `Run not found: ${runId}` }], isError: true };
        }
        if (entry?.runDir) {
          this.checkPathContainment(entry.runDir);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
        };
      }

      // qa://runs/<run-id>/attempts
      if (pathParts[0] === 'runs' && pathParts.length === 3 && pathParts[2] === 'attempts') {
        const runId = pathParts[1];
        const attempts = await this.service.getCatalog().getSuiteAttempts(runId);
        return {
          content: [{ type: 'text', text: JSON.stringify(attempts, null, 2) }],
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

      // qa://datasets/<pack>/<dataset>
      if (pathParts[0] === 'datasets' && pathParts.length >= 3) {
        const packId = pathParts[1];
        const datasetId = pathParts[2];
        const validation = await this.service.validateDataset(packId, datasetId);
        return {
          content: [{ type: 'text', text: `Dataset ${datasetId} for ${packId}: ${validation.scenarioCount} scenarios, valid: ${validation.valid}` }],
        };
      }

      // qa://baselines/<name>
      if (pathParts[0] === 'baselines' && pathParts.length === 2) {
        const baselineName = pathParts[1];
        const baseline = await this.service.getBaseline(baselineName);
        if (!baseline) {
          return { content: [{ type: 'text', text: `Baseline not found: ${baselineName}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(baseline, null, 2) }],
        };
      }

      // qa://baselines/<name>/run
      if (pathParts[0] === 'baselines' && pathParts.length === 3 && pathParts[2] === 'run') {
        const baselineName = pathParts[1];
        const baseline = await this.service.getBaseline(baselineName);
        if (!baseline) {
          return { content: [{ type: 'text', text: `Baseline not found: ${baselineName}` }], isError: true };
        }
        const { manifest } = await this.service.getRun(baseline.runId);
        if (!manifest) {
          return { content: [{ type: 'text', text: `Run not found for baseline: ${baselineName}` }], isError: true };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
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
    const packId = this.safeIdentifier(params.pack, 'pack');
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
    const packId = this.safeIdentifier(params.pack, 'pack');
    const datasetId = this.safeIdentifier(params.dataset, 'dataset');

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

    // Validate identifiers before policy checks
    const packId = this.safeIdentifier(params.pack, 'pack');
    const profile = params.profile ? String(params.profile) : undefined;
    const suites = params.suites ? (params.suites as string[]) : [];
    const tags = params.tags ? (params.tags as string[]) : [];

    // Check operational policy (tool-level)
    const policy = this.config.policy;
    const toolPolicy = checkMcpToolPolicy('qa_start_run', params, policy ?? DEFAULT_OPERATIONAL_POLICY);
    if (!toolPolicy.allowed) {
      return { content: [{ type: 'text', text: toolPolicy.reason ?? 'Operation denied by policy' }], isError: true };
    }

    // Check selection policy (allowlist for packs/profiles/suites/tags)
    const mcpAllowlist = policy?.mcp;
    const selectionPolicy = checkSelectionPolicy(packId, profile, suites, tags, mcpAllowlist);
    if (!selectionPolicy.allowed) {
      return { content: [{ type: 'text', text: selectionPolicy.reason ?? 'Selection denied by allowlist' }], isError: true };
    }

    const result = await this.service.startRunDetached({
      packId,
      profile,
      suites: suites.length > 0 ? suites : undefined,
      tags: tags.length > 0 ? tags : undefined,
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
    let runId: string;
    try {
      runId = this.safeIdentifier(params.runId, 'runId');
    } catch {
      return { content: [{ type: 'text', text: 'runId parameter is required and must be a simple identifier' }], isError: true };
    }

    const { manifest, entry } = await this.service.getRun(runId);
    if (entry?.runDir) {
      try {
        this.checkPathContainment(entry.runDir);
      } catch {
        return { content: [{ type: 'text', text: 'Run directory is outside approved roots' }], isError: true };
      }
    }
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

    let runId: string;
    try {
      runId = this.safeIdentifier(params.runId, 'runId');
    } catch {
      return { content: [{ type: 'text', text: 'runId parameter is required and must be a simple identifier' }], isError: true };
    }

    const success = await this.service.cancelRun(runId);
    return {
      content: [{ type: 'text', text: success ? `Run ${runId} cancelled` : `Run ${runId} not found` }],
    };
  }

  /**
   * Resolve a baseline name to a run ID if the supplied string matches
   * a promoted baseline name. Otherwise treat it as a raw run ID.
   */
  private async resolveBaselineOrRunId(value: string): Promise<string> {
    try {
      // First check if it matches a simple runId pattern
      this.safeIdentifier(value, 'value');
    } catch {
      throw new Error('Invalid run ID or baseline name');
    }

    // Check if the value is a named baseline
    const baseline = await this.service.getBaseline(value);
    if (baseline) {
      return baseline.runId;
    }

    // Treat as a raw run ID
    return value;
  }

  private async handleCompareRuns(params: Record<string, unknown>): Promise<McpToolResponse> {
    let baselineParam: string;
    let candidateParam: string;
    try {
      baselineParam = this.safeIdentifier(params.baseline, 'baseline');
      candidateParam = this.safeIdentifier(params.candidate, 'candidate');
    } catch {
      return { content: [{ type: 'text', text: 'baseline and candidate parameters must be simple identifiers' }], isError: true };
    }

    // Resolve named baselines to their underlying run IDs
    let baselineRunId: string;
    let candidateRunId: string;
    try {
      baselineRunId = await this.resolveBaselineOrRunId(baselineParam);
      candidateRunId = await this.resolveBaselineOrRunId(candidateParam);
    } catch {
      return { content: [{ type: 'text', text: 'Could not resolve baseline or candidate to a valid run ID' }], isError: true };
    }

    const result = await this.service.compareRuns(baselineRunId, candidateRunId);
    if (result.error) {
      return { content: [{ type: 'text', text: result.error }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result.comparison, null, 2) }],
    };
  }

  private async handleListFindings(params: Record<string, unknown>): Promise<McpToolResponse> {
    let runId: string;
    try {
      runId = this.safeIdentifier(params.runId, 'runId');
    } catch {
      return { content: [{ type: 'text', text: 'runId parameter is required and must be a simple identifier' }], isError: true };
    }

    const findings = await this.service.listFindings(runId);
    return {
      content: [{ type: 'text', text: JSON.stringify(findings, null, 2) }],
    };
  }

  private async handleGetFinding(params: Record<string, unknown>): Promise<McpToolResponse> {
    let findingId: string;
    try {
      // findingId may contain a forward slash (e.g. "run-123/suite-abc")
      findingId = this.safeCompoundIdentifier(params.findingId, 'findingId');
    } catch {
      return { content: [{ type: 'text', text: 'findingId parameter is required and must be a simple identifier' }], isError: true };
    }

    const finding = await this.service.getFinding(findingId);
    if (!finding) {
      return { content: [{ type: 'text', text: `Finding not found: ${findingId}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(finding, null, 2) }],
    };
  }

  // ---------------------------------------------------------------------------
  // Baseline tool handlers
  // ---------------------------------------------------------------------------

  private async handleListBaselines(): Promise<McpToolResponse> {
    const baselines = await this.service.listBaselines();
    return {
      content: [{ type: 'text', text: JSON.stringify(baselines, null, 2) }],
    };
  }

  private async handleGetBaseline(params: Record<string, unknown>): Promise<McpToolResponse> {
    let name: string;
    try {
      name = this.safeIdentifier(params.name, 'baseline name');
    } catch {
      return { content: [{ type: 'text', text: 'name parameter is required and must be a simple identifier' }], isError: true };
    }

    const baseline = await this.service.getBaseline(name);
    if (!baseline) {
      return { content: [{ type: 'text', text: `Baseline not found: ${name}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(baseline, null, 2) }],
    };
  }

  // ---------------------------------------------------------------------------
  // Agent control-plane handlers
  // ---------------------------------------------------------------------------

  private async handleApproveAgentTool(params: Record<string, unknown>): Promise<McpToolResponse> {
    if (!this.config.allowRunOperations) {
      return {
        content: [{ type: 'text', text: 'Run operations are disabled on this server. Set allowRunOperations: true to enable.' }],
        isError: true,
      };
    }

    // Check operational policy for approval operations
    const policy = this.config.policy;
    const toolPolicy = checkMcpToolPolicy('qa_approve_agent_tool', params, policy ?? DEFAULT_OPERATIONAL_POLICY);
    if (!toolPolicy.allowed) {
      return { content: [{ type: 'text', text: toolPolicy.reason ?? 'Approval operations disabled by policy' }], isError: true };
    }

    try {
      const approvalId = this.safeIdentifier(params.approvalId, 'approvalId');
      const runId = this.safeIdentifier(params.runId, 'runId');
      const actor = String(params.actor ?? 'human');
      const reason = params.reason ? String(params.reason) : undefined;

      const result = await this.service.approveAgentTool(approvalId, runId, actor as 'human' | 'ai' | 'policy', reason);
      if (!result.success) {
        return { content: [{ type: 'text', text: result.error ?? 'Approval failed' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Approval ${approvalId} resolved for run ${runId}` }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleDenyAgentTool(params: Record<string, unknown>): Promise<McpToolResponse> {
    if (!this.config.allowRunOperations) {
      return {
        content: [{ type: 'text', text: 'Run operations are disabled on this server. Set allowRunOperations: true to enable.' }],
        isError: true,
      };
    }

    // Check operational policy for approval operations
    const policy = this.config.policy;
    const toolPolicy = checkMcpToolPolicy('qa_deny_agent_tool', params, policy ?? DEFAULT_OPERATIONAL_POLICY);
    if (!toolPolicy.allowed) {
      return { content: [{ type: 'text', text: toolPolicy.reason ?? 'Approval operations disabled by policy' }], isError: true };
    }

    try {
      const approvalId = this.safeIdentifier(params.approvalId, 'approvalId');
      const runId = this.safeIdentifier(params.runId, 'runId');
      const actor = String(params.actor ?? 'human');
      const reason = params.reason ? String(params.reason) : undefined;

      const result = await this.service.denyAgentTool(approvalId, runId, actor as 'human' | 'ai' | 'policy', reason);
      if (!result.success) {
        return { content: [{ type: 'text', text: result.error ?? 'Denial failed' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Approval ${approvalId} denied for run ${runId}` }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleGetAgentRun(params: Record<string, unknown>): Promise<McpToolResponse> {
    try {
      const runId = this.safeIdentifier(params.runId, 'runId');
      const { doc, error } = await this.service.getAgentRun(runId);
      if (!doc || error) {
        return { content: [{ type: 'text', text: error ?? `Agent run not found: ${runId}` }], isError: true };
      }
      const summary = {
        runId: doc.runId,
        status: doc.status,
        previousStatus: doc.previousStatus,
        agentId: doc.agentState.goal.goalId,
        turn: doc.agentState.turn,
        pendingApprovals: doc.pendingApprovals.length,
        pendingApprovalIds: doc.pendingApprovals.map((a) => ({
          id: a.id,
          toolName: a.toolName,
          risk: a.risk,
          expiresAt: a.expiresAt,
          requestedAt: a.requestedAt,
        })),
        startedAt: doc.startedAt,
        updatedAt: doc.updatedAt,
        endedAt: doc.endedAt,
        error: doc.error,
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleListAgentRuns(params: Record<string, unknown>): Promise<McpToolResponse> {
    try {
      const status = params.status ? String(params.status) as any : undefined;
      const runs = await this.service.listAgentRuns(status);
      const summaries = runs.map((doc) => ({
        runId: doc.runId,
        status: doc.status,
        turn: doc.agentState.turn,
        pendingApprovals: doc.pendingApprovals.length,
        startedAt: doc.startedAt,
        updatedAt: doc.updatedAt,
        endedAt: doc.endedAt,
        error: doc.error,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(summaries, null, 2) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }

  private async handleGetFindingDetail(params: Record<string, unknown>): Promise<McpToolResponse> {
    let findingId: string;
    try {
      findingId = this.safeCompoundIdentifier(params.findingId, 'findingId');
    } catch {
      return { content: [{ type: 'text', text: 'findingId parameter is required and must be a simple identifier' }], isError: true };
    }

    const finding = await this.service.getFinding(findingId);
    if (!finding) {
      return { content: [{ type: 'text', text: `Finding not found: ${findingId}` }], isError: true };
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(finding, null, 2) }],
    };
  }

  private async handleGetSchemaVersion(): Promise<McpToolResponse> {
    const versions = await this.service.getSchemaVersion();
    return {
      content: [{ type: 'text', text: JSON.stringify({ schemaVersions: versions }, null, 2) }],
    };
  }

  private async handleRebuildCatalog(): Promise<McpToolResponse> {
    if (!this.config.allowRunOperations) {
      return {
        content: [{ type: 'text', text: 'Run operations are disabled on this server. Set allowRunOperations: true to enable.' }],
        isError: true,
      };
    }
    const count = await this.service.rebuildCatalog();
    return {
      content: [{ type: 'text', text: JSON.stringify({ runsIndexed: count }, null, 2) }],
    };
  }

  private async handleListSuiteAttempts(params: Record<string, unknown>): Promise<McpToolResponse> {
    let runId: string;
    try {
      runId = this.safeIdentifier(params.runId, 'runId');
    } catch {
      return { content: [{ type: 'text', text: 'runId parameter is required and must be a simple identifier' }], isError: true };
    }
    const attempts = await this.service.getCatalog().getSuiteAttempts(runId);
    return {
      content: [{ type: 'text', text: JSON.stringify(attempts, null, 2) }],
    };
  }

  private async handleCancelAgentRun(params: Record<string, unknown>): Promise<McpToolResponse> {
    if (!this.config.allowRunOperations) {
      return {
        content: [{ type: 'text', text: 'Run operations are disabled on this server. Set allowRunOperations: true to enable.' }],
        isError: true,
      };
    }

    try {
      const runId = this.safeIdentifier(params.runId, 'runId');
      const reason = params.reason ? String(params.reason) : undefined;
      const result = await this.service.cancelAgentRun(runId, reason);
      if (!result.success) {
        return { content: [{ type: 'text', text: result.error ?? 'Cancel failed' }], isError: true };
      }
      return { content: [{ type: 'text', text: `Agent run ${runId} cancelled` }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
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
            { uri: 'qa://datasets/{pack}/{dataset}', name: 'Dataset info' },
            { uri: 'qa://baselines/{name}', name: 'Baseline entry' },
            { uri: 'qa://baselines/{name}/run', name: 'Baseline run manifest' },
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
      { name: 'qa_list_baselines', description: 'List all named baselines', inputSchema: objectSchema({}) },
      { name: 'qa_get_baseline', description: 'Resolve a named baseline to its run ID', inputSchema: objectSchema({ name: text }, ['name']) },

      // Feature 04: Agent control-plane tools
      { name: 'qa_approve_agent_tool', description: 'Approve a pending agent tool call', inputSchema: objectSchema({ approvalId: text, runId: text, actor: text, reason: text }, ['approvalId', 'runId']) },
      { name: 'qa_deny_agent_tool', description: 'Deny a pending agent tool call', inputSchema: objectSchema({ approvalId: text, runId: text, actor: text, reason: text }, ['approvalId', 'runId']) },
      { name: 'qa_get_agent_run', description: 'Get agent run status and pending approvals', inputSchema: objectSchema({ runId: text }, ['runId']) },
      { name: 'qa_list_agent_runs', description: 'List agent runs, optionally by status', inputSchema: objectSchema({ status: text }) },
      { name: 'qa_cancel_agent_run', description: 'Cancel an active agent run', inputSchema: objectSchema({ runId: text, reason: text }, ['runId']) },

      // Feature 09: Normalized catalog and finding queries
      { name: 'qa_get_finding_detail', description: 'Get a finding with evidence, replay spec, and lifecycle details', inputSchema: objectSchema({ findingId: text }, ['findingId']) },
      { name: 'qa_get_schema_version', description: 'Get the catalog schema version', inputSchema: objectSchema({}) },
      { name: 'qa_rebuild_catalog', description: 'Rebuild the catalog from run directories (idempotent)', inputSchema: objectSchema({}) },
      { name: 'qa_list_suite_attempts', description: 'List suite attempts for a run', inputSchema: objectSchema({ runId: text }, ['runId']) },
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
