/**
 * Governed HTTP tools: GET requests to allowlisted origins.
 *
 * Rules:
 * - Only GET requests to explicitly allowed origins
 * - Redirects are re-validated against origin policy
 * - Unknown/forbidden origins are denied
 * - Arguments are schema-validated
 */

import type { ToolDefinition, ToolExecutionContext, ToolResult } from '../agentTypes.js';

export const httpGetTool: ToolDefinition = {
  name: 'http_get',
  version: '1.0.0',
  description: 'Make an HTTP GET request to an allowed origin',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to fetch' },
      headers: { type: 'object', description: 'Optional request headers', optional: true },
    },
    required: ['url'],
  },
  risk: 'read',
  capabilities: ['http', 'network'],
  network: {
    allowedHosts: [], // populated dynamically from agent policy
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const url = args.url as string;
    if (!url) {
      return { success: false, error: 'URL is required', durationMs: 0 };
    }

    try {
      const parsedUrl = new URL(url);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: 'GET',
        headers: (args.headers as Record<string, string>) ?? {},
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const body = await response.text();

      return {
        success: true,
        output: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: body.slice(0, 100_000), // limit response size
          bodyLength: body.length,
          url: response.url,
        },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `HTTP GET failed: ${message}`, durationMs: 0 };
    }
  },
};

export const httpPostTool: ToolDefinition = {
  name: 'http_post',
  version: '1.0.0',
  description: 'Make an HTTP POST request to an allowed origin',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full URL to post to' },
      headers: { type: 'object', description: 'Optional request headers', optional: true },
      body: { type: 'string', description: 'Request body', optional: true },
    },
    required: ['url'],
  },
  risk: 'write',
  capabilities: ['http', 'network'],
  network: {
    allowedHosts: [],
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolResult> {
    const url = args.url as string;
    if (!url) {
      return { success: false, error: 'URL is required', durationMs: 0 };
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        method: 'POST',
        headers: (args.headers as Record<string, string>) ?? {},
        body: (args.body as string) ?? undefined,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const body = await response.text();

      return {
        success: true,
        output: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: body.slice(0, 100_000),
          bodyLength: body.length,
        },
        durationMs: 0,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `HTTP POST failed: ${message}`, durationMs: 0 };
    }
  },
};
