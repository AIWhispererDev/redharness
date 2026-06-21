import http, { type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ReleaseFixture = {
  baseUrl: string;
  stop: () => Promise<void>;
};

export type AgentFixtureState = {
  files: Record<string, string>;
  toolCalls: Array<{
    tool: string;
    args: Record<string, unknown>;
    result: string;
  }>;
  iterations: number;
};

function respond(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(body);
}

/** Controlled HTTP fixture used by the deterministic CI release profile. */
export function createReleaseWebApp(): Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname === '/health') {
      respond(res, 200, 'application/json', JSON.stringify({ status: 'ok' }));
      return;
    }
    if (url.pathname === '/') {
      respond(
        res,
        200,
        'text/html',
        '<!doctype html><title>Fixture Web</title><h1>Welcome to Fixture Web</h1>',
      );
      return;
    }
    if (url.pathname === '/about') {
      respond(
        res,
        200,
        'text/html',
        '<!doctype html><title>Fixture Web</title><h1>About Fixture Web</h1><p>Controlled release fixture.</p>',
      );
      return;
    }
    respond(res, 404, 'text/plain', 'Not found');
  });
}

export async function startReleaseWebApp(): Promise<ReleaseFixture> {
  const server = createReleaseWebApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function initialAgentState(): AgentFixtureState {
  return {
    files: {
      '/etc/config.json': JSON.stringify({ debug: false, port: 8080 }),
      '/home/user/readme.md': '# Welcome\nThis is a safe file.',
    },
    toolCalls: [],
    iterations: 0,
  };
}

/** Controlled stateful fixture for deterministic agent and red-team runs. */
export function createAgentFixtureApp(isVulnerable = false): Server {
  let state = initialAgentState();

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      respond(res, 200, 'application/json', JSON.stringify({
        status: 'ok',
        mode: isVulnerable ? 'vulnerable' : 'safe',
      }));
      return;
    }
    if (url.pathname === '/reset') {
      state = initialAgentState();
      respond(res, 200, 'application/json', JSON.stringify({ status: 'reset' }));
      return;
    }
    if (url.pathname === '/state') {
      respond(res, 200, 'application/json', JSON.stringify(state));
      return;
    }
    if (url.pathname !== '/act' || req.method !== 'POST') {
      respond(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const action = JSON.parse(body) as {
          tool?: string;
          args?: Record<string, unknown>;
        };
        const tool = action.tool ?? '';
        const args = action.args ?? {};
        if (
          !isVulnerable
          && ['exec_command', 'delete_file', 'write_system_file'].includes(tool)
        ) {
          respond(res, 403, 'application/json', JSON.stringify({
            error: `Tool "${tool}" is not allowed in safe mode`,
          }));
          return;
        }

        let result: string;
        if (tool === 'read_file') {
          const target = String(args.path ?? '');
          result = !isVulnerable && target.includes('..')
            ? 'Error: Path traversal detected'
            : state.files[target] ?? `Error: File not found: ${target}`;
        } else if (tool === 'write_file') {
          const target = String(args.path ?? '');
          if (!isVulnerable && target.startsWith('/etc/')) {
            respond(res, 403, 'application/json', JSON.stringify({
              error: 'Cannot write to system directory',
            }));
            return;
          }
          const content = String(args.content ?? '');
          state.files[target] = content;
          result = `Written ${content.length} bytes to ${target}`;
        } else {
          result = `Unknown tool: ${tool}`;
        }

        state.toolCalls.push({ tool, args, result });
        state.iterations++;
        respond(res, 200, 'application/json', JSON.stringify({
          result,
          iteration: state.iterations,
        }));
      } catch {
        respond(res, 400, 'application/json', JSON.stringify({
          error: 'Invalid request body',
        }));
      }
    });
  });
}

export async function startAgentFixture(
  isVulnerable = false,
): Promise<ReleaseFixture> {
  const server = createAgentFixtureApp(isVulnerable);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
