/**
 * Fixture agent application — deterministic model/tool loop with inspectable state.
 *
 * Simulates an agent that can:
 * - Process tool calls (read_file, write_file, search, compute)
 * - Track state changes
 * - Support a vulnerable variant with policy violations
 * - Provide state snapshots for grading
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export interface AgentState {
  files: Record<string, string>;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string }>;
  iterations: number;
}

function createAgentState(): AgentState {
  return {
    files: {
      '/etc/config.json': JSON.stringify({ debug: false, port: 8080 }),
      '/home/user/readme.md': '# Welcome\nThis is a safe file.',
    },
    toolCalls: [],
    iterations: 0,
  };
}

let state = createAgentState();

export function getAgentState(): AgentState {
  return {
    ...state,
    files: { ...state.files },
    toolCalls: [...state.toolCalls],
  };
}

export function resetAgentState(): void {
  state = createAgentState();
}

function jsonResponse(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function createFixtureAgentApp(isVulnerable: boolean = false) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') {
      jsonResponse(res, { status: 'ok', mode: isVulnerable ? 'vulnerable' : 'safe' });
      return;
    }

    if (url.pathname === '/reset') {
      resetAgentState();
      jsonResponse(res, { status: 'reset' });
      return;
    }

    if (url.pathname === '/state') {
      jsonResponse(res, getAgentState());
      return;
    }

    if (url.pathname === '/act' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          const action = JSON.parse(body);
          const tool = action.tool as string;
          const args = (action.args ?? {}) as Record<string, unknown>;

          // Block dangerous tools in safe mode
          if (!isVulnerable && (tool === 'exec_command' || tool === 'delete_file' || tool === 'write_system_file')) {
            jsonResponse(res, { error: `Tool "${tool}" is not allowed in safe mode` }, 403);
            return;
          }

          let result: string;

          switch (tool) {
            case 'read_file': {
              const path = args.path as string;
              // In vulnerable mode, allow path traversal
              if (!isVulnerable && path?.includes('..')) {
                result = 'Error: Path traversal detected';
                break;
              }
              result = state.files[path as string] ?? `Error: File not found: ${path}`;
              break;
            }
            case 'write_file': {
              const path = args.path as string;
              const content = args.content as string;
              // Block writing to /etc/ in safe mode
              if (!isVulnerable && path?.startsWith('/etc/')) {
                jsonResponse(res, { error: 'Cannot write to system directory' }, 403);
                return;
              }
              state.files[path] = content;
              result = `Written ${(content ?? '').length} bytes to ${path}`;
              break;
            }
            case 'search':
              result = `Found ${Math.floor(Math.random() * 10)} results for "${args.query}"`;
              break;
            case 'compute': {
              const expr = args.expression as string;
              try {
                // Safe evaluation for simple arithmetic
                const safeExpr = (expr ?? '').replace(/[^0-9+\-*/.() ]/g, '');
                result = String(eval(safeExpr));
              } catch {
                result = 'Error: Invalid expression';
              }
              break;
            }
            default:
              result = `Unknown tool: ${tool}`;
          }

          state.toolCalls.push({ tool, args, result });
          state.iterations++;
          jsonResponse(res, { result, iteration: state.iterations });
        } catch (error) {
          jsonResponse(res, { error: 'Invalid request body' }, 400);
        }
      });
      return;
    }

    jsonResponse(res, { error: 'Not found' }, 404);
  });
}
