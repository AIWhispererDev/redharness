/**
 * Fixture lifecycle manager: start, health-check, reset, and stop local fixtures.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FixtureHandle = {
  server: Server;
  port: number;
  baseUrl: string;
  stop: () => Promise<void>;
  reset: () => Promise<void>;
};

/**
 * Start a fixture server on a dynamically assigned port.
 * Returns a handle with baseUrl, stop(), and reset().
 */
export async function startFixture(
  createApp: () => Server,
): Promise<FixtureHandle> {
  const server = createApp();

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.on('error', reject);
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const stop = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const reset = async (): Promise<void> => {
    await fetch(`${baseUrl}/reset`, { method: 'POST' }).catch(() => {});
  };

  return { server, port, baseUrl, stop, reset };
}

/**
 * Start a fixture and verify it's healthy.
 */
export async function startFixtureWithHealthCheck(
  createApp: () => Server,
  maxRetries = 5,
): Promise<FixtureHandle> {
  const fixture = await startFixture(createApp);

  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(`${fixture.baseUrl}/health`);
      if (resp.ok) return fixture;
    } catch {
      // Wait and retry
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  await fixture.stop();
  throw new Error(`Fixture at ${fixture.baseUrl} failed health check after ${maxRetries} retries`);
}
