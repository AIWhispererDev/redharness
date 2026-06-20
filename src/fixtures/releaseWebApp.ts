import http, { type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type ReleaseFixture = {
  baseUrl: string;
  stop: () => Promise<void>;
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
