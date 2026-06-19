#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

function getArg(name: string, fallback?: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1) return process.argv[index + 1];
  return fallback;
}

async function main() {
  const endpoint = getArg('endpoint', 'http://127.0.0.1:9222')!;
  const storageState = path.resolve(getArg('save-storage', '.auth/pocket-socrates.json')!);
  const expectedUrlPart = getArg('expected-url-part', 'pocketsoc.me')!;

  await mkdir(path.dirname(storageState), { recursive: true });

  console.log(`Connecting to existing browser via CDP: ${endpoint}`);
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context) throw new Error('No browser context found over CDP.');

  const pages = context.pages();
  const page = pages.find((candidate) => candidate.url().includes(expectedUrlPart)) ?? pages[0];
  if (!page) throw new Error('No open pages found in CDP browser.');

  console.log(`Using page: ${page.url()}`);
  await context.storageState({ path: storageState });
  console.log(`Saved auth storage state: ${storageState}`);

  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
