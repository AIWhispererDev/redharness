#!/usr/bin/env node
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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
  const url = getArg('url', 'https://pocketsoc.me/en/dashboard')!;
  const executablePath = getArg('executable-path', 'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe')!;
  const userDataDir = path.resolve(getArg('user-data-dir', '.auth/pocket-socrates-brave-profile')!);
  const storageState = path.resolve(getArg('save-storage', '.auth/pocket-socrates.json')!);

  await mkdir(path.dirname(storageState), { recursive: true });
  await mkdir(userDataDir, { recursive: true });

  console.log('Opening Brave for manual Pocket Socrates login...');
  console.log(`URL: ${url}`);
  console.log(`Brave: ${executablePath}`);
  console.log(`Profile: ${userDataDir}`);
  console.log(`Will save storage state to: ${storageState}`);
  console.log('');
  console.log('After the dashboard is loaded in Brave, return here and press Enter.');

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    viewport: { width: 1280, height: 900 },
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const rl = createInterface({ input, output });
  await rl.question('Press Enter here after you are logged into Pocket Socrates dashboard...');
  rl.close();

  await context.storageState({ path: storageState });
  console.log(`Saved auth storage state: ${storageState}`);
  console.log(`Current page: ${page.url()}`);

  await context.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
