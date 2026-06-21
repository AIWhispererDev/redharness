import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import YAML from 'yaml';
import { computeDatasetHash } from '../datasets/manifest.js';
import type { ScenarioDefinition } from '../scenarios/schema.js';

export type DiscoveredControl = {
  kind: 'link' | 'button' | 'input' | 'form';
  text?: string;
  role?: string;
  name?: string;
  href?: string;
  selector?: string;
  inputType?: string;
  required?: boolean;
};

export type DiscoveredPage = {
  url: string;
  route: string;
  title: string;
  headings: string[];
  textSample: string;
  controls: DiscoveredControl[];
  consoleErrors: string[];
  failedRequests: string[];
  serverErrors: string[];
};

export type DiscoveredInteraction = {
  sourceUrl: string;
  sourceRoute: string;
  control: DiscoveredControl;
  outcome: 'navigation' | 'dialog' | 'content-change' | 'scroll' | 'no-change' | 'external' | 'error';
  finalUrl: string;
  finalRoute?: string;
  marker?: string;
  dialogText?: string;
  error?: string;
  consoleErrors: string[];
  failedRequests: string[];
  serverErrors: string[];
};

export type UrlDiscoveryResult = {
  baseUrl: string;
  origin: string;
  startedAt: string;
  endedAt: string;
  pages: DiscoveredPage[];
  interactions: DiscoveredInteraction[];
  executableScenarios: ScenarioDefinition[];
  interactionDrafts: ScenarioDefinition[];
  skippedExternalUrls: string[];
};

export type UrlDiscoveryOptions = {
  maxPages?: number;
  headless?: boolean;
  navigationTimeoutMs?: number;
  storageState?: string;
};

export type WriteDiscoveredPackOptions = {
  outputDir: string;
  packId: string;
  packName?: string;
  owner?: string;
};

const SAFE_INTERACTION = /\b(connect|sign in|log in|login|menu|open|learn|explore|start|started|continue|next|back|close|dismiss|view|details|settings|account|dashboard)\b/i;
const DANGEROUS_INTERACTION = /\b(buy|pay|purchase|checkout|delete|remove|transfer|send|mint|stake|approve|confirm|submit|withdraw|deposit|swap|trade|claim|sign transaction)\b/i;
const PAGE_SNAPSHOT_SCRIPT = `(() => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rect.width > 0
      && rect.height > 0;
  };
  const clean = (value) => {
    const result = value ? value.replace(/\\s+/g, ' ').trim() : '';
    return result || undefined;
  };
  const selectorFor = (element) => {
    const id = element.getAttribute('id');
    if (id) return '#' + CSS.escape(id);
    const testId = element.getAttribute('data-testid');
    if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
    const name = element.getAttribute('name');
    if (name) return element.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]';
    return undefined;
  };
  const controls = [];
  for (const element of [...document.querySelectorAll('a[href], button, input, textarea, select, form')]) {
    if (!visible(element)) continue;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') {
      controls.push({
        kind: 'link',
        text: clean(element.textContent),
        role: 'link',
        name: clean(element.getAttribute('aria-label')) || clean(element.textContent),
        href: element.getAttribute('href') || undefined,
        selector: selectorFor(element),
      });
    } else if (tag === 'button') {
      controls.push({
        kind: 'button',
        text: clean(element.textContent),
        role: 'button',
        name: clean(element.getAttribute('aria-label')) || clean(element.textContent),
        selector: selectorFor(element),
      });
    } else if (tag === 'form') {
      controls.push({
        kind: 'form',
        name: clean(element.getAttribute('aria-label')) || clean(element.getAttribute('name')),
        selector: selectorFor(element),
      });
    } else {
      controls.push({
        kind: 'input',
        name: clean(element.getAttribute('aria-label'))
          || clean(element.getAttribute('placeholder'))
          || clean(element.getAttribute('name')),
        selector: selectorFor(element),
        inputType: element.type || tag,
        required: Boolean(element.required),
      });
    }
  }
  return {
    title: document.title,
    headings: [...document.querySelectorAll('h1, h2')]
      .filter(visible)
      .map((element) => clean(element.textContent))
      .filter(Boolean)
      .slice(0, 8),
    bodyText: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 20000),
    textLines: (document.body?.innerText || '')
      .split('\\n')
      .map((line) => line.replace(/\\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 500),
    textSample: (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1000),
    dialogs: [...document.querySelectorAll('[role="dialog"], dialog[open], [aria-modal="true"]')]
      .filter(visible)
      .map((element) => clean(element.textContent))
      .filter(Boolean)
      .slice(0, 5),
    scrollY: window.scrollY,
    controls,
  };
})()`;

export async function discoverUrl(
  inputUrl: string,
  options: UrlDiscoveryOptions = {},
): Promise<UrlDiscoveryResult> {
  const startUrl = normalizeUrl(inputUrl);
  const origin = new URL(startUrl).origin;
  const maxPages = Math.max(1, Math.min(options.maxPages ?? 20, 100));
  const browser = await chromium.launch({ headless: options.headless ?? true });
  const context = await browser.newContext({
    storageState: options.storageState,
    permissions: [],
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(options.navigationTimeoutMs ?? 20_000);
  page.setDefaultTimeout(options.navigationTimeoutMs ?? 10_000);

  const startedAt = new Date().toISOString();
  const queue = [startUrl];
  const visited = new Set<string>();
  const pages: DiscoveredPage[] = [];
  const interactions: DiscoveredInteraction[] = [];
  const skippedExternalUrls = new Set<string>();

  try {
    while (queue.length > 0 && pages.length < maxPages) {
      const url = queue.shift()!;
      const canonical = canonicalUrl(url);
      if (visited.has(canonical)) continue;
      visited.add(canonical);

      const discovered = await inspectPage(page, canonical);
      pages.push(discovered);

      for (const control of discovered.controls) {
        if (control.kind !== 'link' || !control.href) continue;
        const resolved = new URL(control.href, discovered.url);
        if (!['http:', 'https:'].includes(resolved.protocol)) continue;
        resolved.hash = '';
        if (resolved.origin !== origin) {
          skippedExternalUrls.add(resolved.toString());
          continue;
        }
        const next = canonicalUrl(resolved.toString());
        if (!visited.has(next) && !queue.includes(next)) queue.push(next);
      }

      for (const control of safeControls(discovered.controls)) {
        const interaction = await exploreInteraction(
          browser,
          discovered,
          control,
          origin,
          options.navigationTimeoutMs ?? 20_000,
          options.storageState,
        );
        interactions.push(interaction);
        if (interaction.outcome === 'navigation' && interaction.finalUrl.startsWith(origin)) {
          const next = canonicalUrl(interaction.finalUrl);
          if (!visited.has(next) && !queue.includes(next)) queue.push(next);
        }
        if (interaction.outcome === 'external') skippedExternalUrls.add(interaction.finalUrl);
      }
    }
  } finally {
    await browser.close();
  }

  return buildDiscoveryResult({
    baseUrl: startUrl,
    origin,
    startedAt,
    pages,
    interactions,
    skippedExternalUrls: [...skippedExternalUrls].sort(),
  });
}

export function buildDiscoveryResult(input: {
  baseUrl: string;
  origin: string;
  startedAt: string;
  pages: DiscoveredPage[];
  interactions?: DiscoveredInteraction[];
  skippedExternalUrls?: string[];
}): UrlDiscoveryResult {
  const interactions = input.interactions ?? [];
  const executableInteractions = interactions.filter(isExecutableInteraction);
  return {
    baseUrl: input.baseUrl,
    origin: input.origin,
    startedAt: input.startedAt,
    endedAt: new Date().toISOString(),
    pages: input.pages,
    interactions,
    executableScenarios: [
      ...input.pages.map(buildPageHealthScenario),
      ...executableInteractions.map(buildObservedInteractionScenario),
    ],
    interactionDrafts: [
      ...input.pages.flatMap((page) => buildInteractionDrafts(
        page,
        interactions.filter((interaction) => interaction.sourceUrl === page.url),
      )),
    ],
    skippedExternalUrls: input.skippedExternalUrls ?? [],
  };
}

export async function writeDiscoveredPack(
  result: UrlDiscoveryResult,
  options: WriteDiscoveredPackOptions,
): Promise<{
  packDir: string;
  executableScenarioCount: number;
  interactionDraftCount: number;
  datasetContentHash: string;
}> {
  const packDir = path.resolve(options.outputDir);
  const datasetDir = path.join(packDir, 'datasets', 'discovered');
  const scenariosDir = path.join(datasetDir, 'scenarios');
  const draftsDir = path.join(datasetDir, 'drafts');
  await mkdir(scenariosDir, { recursive: true });
  await mkdir(draftsDir, { recursive: true });

  for (const scenario of result.executableScenarios) {
    await writeFile(
      path.join(scenariosDir, `${scenario.id}.yaml`),
      YAML.stringify(scenario),
      'utf8',
    );
  }
  for (const draft of result.interactionDrafts) {
    await writeFile(
      path.join(draftsDir, `${draft.id}.yaml`),
      YAML.stringify({ reviewStatus: 'draft', ...draft }),
      'utf8',
    );
  }

  const contentHash = computeDatasetHash(result.executableScenarios);
  await writeFile(path.join(datasetDir, 'dataset.yaml'), YAML.stringify({
    id: 'discovered',
    version: '1.0.0',
    description: `Automatically discovered safe coverage for ${result.origin}`,
    contentHash,
    splits: {
      smoke: result.executableScenarios.map((scenario) => scenario.id),
      release: result.executableScenarios.map((scenario) => scenario.id),
    },
    provenance: {
      owner: options.owner ?? 'qa',
      createdFrom: 'generated',
      generator: 'qa-harness-url-discovery',
      generatorVersion: '1',
      lastReviewDate: result.endedAt,
    },
  }), 'utf8');

  await writeFile(path.join(packDir, 'pack.yaml'), YAML.stringify({
    id: options.packId,
    name: options.packName ?? titleFromHost(result.origin),
    type: 'discovered-web',
    baseUrl: result.origin,
    issueTypes: [],
    severities: {
      Blocker: 'Blocks release',
      Major: 'Major regression',
      Minor: 'Minor regression',
      Polish: 'Cosmetic issue',
    },
    tracks: {},
    reports: {},
    rules: [],
    smoke: {
      publicRoutes: result.pages.map((page) => ({
        path: page.route,
        titleIncludes: page.title || undefined,
        textIncludes: page.headings.slice(0, 2),
      })),
    },
    profiles: {
      release: { includeTags: ['generated', 'safe'] },
    },
  }), 'utf8');

  await writeFile(
    path.join(packDir, 'discovery.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(packDir, 'review-queue.yaml'),
    YAML.stringify({
      generatedAt: result.endedAt,
      note: 'Review drafts before moving them into datasets/discovered/scenarios and updating dataset.yaml.',
      drafts: result.interactionDrafts.map((draft) => ({
        scenarioId: draft.id,
        path: `datasets/discovered/drafts/${draft.id}.yaml`,
      })),
    }),
    'utf8',
  );

  return {
    packDir,
    executableScenarioCount: result.executableScenarios.length,
    interactionDraftCount: result.interactionDrafts.length,
    datasetContentHash: contentHash,
  };
}

async function inspectPage(page: Page, url: string): Promise<DiscoveredPage> {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const serverErrors: string[] = [];
  const onConsole = (message: { type(): string; text(): string }) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  };
  const onFailed = (request: {
    method(): string;
    url(): string;
    failure(): { errorText: string } | null;
  }) => failedRequests.push(
    `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
  );
  const onResponse = (response: { status(): number; url(): string }) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  };
  page.on('console', onConsole);
  page.on('requestfailed', onFailed);
  page.on('response', onResponse);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(150);
    const snapshot = await snapshotPage(page);

    const finalUrl = page.url();
    return {
      url: finalUrl,
      route: routeFor(finalUrl),
      title: snapshot.title,
      headings: snapshot.headings,
      textSample: snapshot.textSample,
      controls: snapshot.controls,
      consoleErrors,
      failedRequests,
      serverErrors,
    };
  } finally {
    page.off('console', onConsole);
    page.off('requestfailed', onFailed);
    page.off('response', onResponse);
  }
}

async function exploreInteraction(
  browser: Browser,
  source: DiscoveredPage,
  control: DiscoveredControl,
  origin: string,
  timeoutMs: number,
  storageState?: string,
): Promise<DiscoveredInteraction> {
  const context = await browser.newContext({
    storageState,
    permissions: [],
  });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  page.setDefaultTimeout(Math.min(timeoutMs, 8_000));
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const serverErrors: string[] = [];
  let popupUrl: string | undefined;
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on('popup', (popup) => {
    popupUrl = popup.url();
    popup.close().catch(() => {});
  });

  try {
    await page.goto(source.url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(async () => {
      await page.waitForTimeout(1_500);
    });
    await page.waitForTimeout(500);
    const before = await snapshotPage(page);
    const locator = control.role && control.name
      ? page.getByRole(control.role as never, { name: control.name, exact: true })
      : control.selector
        ? page.locator(control.selector)
        : page.getByText(control.text ?? control.name ?? '', { exact: true });
    await locator.first().click({ timeout: 5_000, noWaitAfter: true });
    await page.waitForFunction(
      ({ beforeUrl, beforeText, beforeScrollY }) => {
        const visibleDialog = [...document.querySelectorAll(
          '[role="dialog"], dialog[open], [aria-modal="true"]',
        )].some((element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== 'hidden'
            && style.display !== 'none'
            && rect.width > 0
            && rect.height > 0;
        });
        const currentText = (document.body?.innerText ?? '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 20000);
        return location.href !== beforeUrl
          || currentText !== beforeText
          || Math.abs(window.scrollY - beforeScrollY) > 100
          || visibleDialog;
      },
      {
        beforeUrl: source.url,
        beforeText: before.bodyText,
        beforeScrollY: before.scrollY,
      },
      { timeout: 6_000 },
    ).catch(() => {});
    await page.waitForTimeout(1_500);
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => {});
    const after = await snapshotPage(page);
    const finalUrl = popupUrl || page.url();

    if (new URL(finalUrl, source.url).origin !== origin) {
      return interactionResult('external', finalUrl);
    }
    if (canonicalUrl(finalUrl) !== canonicalUrl(source.url)) {
      return interactionResult('navigation', finalUrl, {
        marker: after.headings[0] || stableTextMarker(after.textSample),
      });
    }
    const newDialog = after.dialogs.find((dialog) => !before.dialogs.includes(dialog));
    if (newDialog) {
      return interactionResult('dialog', finalUrl, {
        dialogText: newDialog,
        marker: stableTextMarker(newDialog),
      });
    }
    const marker = findNewLineMarker(before.textLines, after.textLines)
      ?? findNewTextMarker(before.bodyText, after.bodyText);
    if (marker) return interactionResult('content-change', finalUrl, { marker });
    if (Math.abs(after.scrollY - before.scrollY) > 100) {
      return interactionResult('scroll', finalUrl, {
        marker: after.headings.find((heading) => !before.headings.includes(heading))
          ?? after.headings.at(-1),
      });
    }
    return interactionResult('no-change', finalUrl);
  } catch (error) {
    return interactionResult('error', page.url() || source.url, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await context.close().catch(() => {});
  }

  function interactionResult(
    outcome: DiscoveredInteraction['outcome'],
    finalUrl: string,
    extra: Partial<DiscoveredInteraction> = {},
  ): DiscoveredInteraction {
    return {
      sourceUrl: source.url,
      sourceRoute: source.route,
      control,
      outcome,
      finalUrl,
      finalRoute: finalUrl.startsWith(origin) ? routeFor(finalUrl) : undefined,
      consoleErrors,
      failedRequests,
      serverErrors,
      ...extra,
    };
  }
}

async function snapshotPage(page: Page): Promise<{
  title: string;
  headings: string[];
  bodyText: string;
  textLines: string[];
  textSample: string;
  dialogs: string[];
  scrollY: number;
  controls: DiscoveredControl[];
}> {
  const snapshot = await page.evaluate(PAGE_SNAPSHOT_SCRIPT) as {
    title: string;
    headings: string[];
    bodyText: string;
    textLines: string[];
    textSample: string;
    dialogs: string[];
    scrollY: number;
    controls: DiscoveredControl[];
  };
  const dialogs: string[] = [];
  const candidates = await page.locator('[role="dialog"], dialog[open], [aria-modal="true"]').all();
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      const text = (await candidate.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (text) dialogs.push(text);
    }
  }
  return { ...snapshot, dialogs };
}

function buildPageHealthScenario(page: DiscoveredPage): ScenarioDefinition {
  const marker = page.headings[0] || stableTextMarker(page.textSample) || page.title;
  return {
    id: `${routeSlug(page.route)}-page-health`,
    version: 1,
    title: `${page.title || page.route} loads without browser errors`,
    description: `Generated safe coverage for ${page.url}`,
    tags: ['generated', 'safe', 'navigation'],
    target: { kind: 'browser', route: page.route },
    setup: [],
    actor: { kind: 'scripted' },
    steps: [{ action: 'goto', url: page.route }],
    expected: [
      { assertion: 'url_matches', pattern: escapeRegex(page.route) },
      ...(marker ? [{ assertion: 'text_present' as const, text: marker }] : []),
      {
        assertion: 'no_console_errors',
        ignorePatterns: [
          'Failed to load resource: the server responded with a status of (401|403|404)',
        ],
      },
      {
        assertion: 'no_failed_requests',
        ignorePatterns: [
          '^HEAD .* — net::ERR_ABORTED$',
        ],
      },
      { assertion: 'no_server_errors' },
    ],
    cleanup: { strategy: 'reset-session' },
    provenance: {
      source: 'manual',
      promotedAt: new Date().toISOString(),
      reviewNotes: 'Automatically generated safe navigation coverage',
    },
  };
}

function buildInteractionDrafts(
  page: DiscoveredPage,
  observed: DiscoveredInteraction[],
): ScenarioDefinition[] {
  return page.controls
    .filter((control) => control.kind === 'button' || control.kind === 'link')
    .filter((control) => {
      const label = control.name ?? control.text ?? '';
      return label && SAFE_INTERACTION.test(label) && !DANGEROUS_INTERACTION.test(label);
    })
    .filter((control) => !observed.some((interaction) =>
      sameControl(interaction.control, control) && isExecutableInteraction(interaction),
    ))
    .slice(0, 8)
    .map((control, index) => ({
      id: `${routeSlug(page.route)}-${slug(control.name ?? control.text ?? `interaction-${index + 1}`)}`,
      version: 1,
      title: `${control.name ?? control.text} interaction remains healthy`,
      description: `Review-required generated interaction draft from ${page.url}`,
      tags: ['generated', 'review-required', 'interaction'],
      target: { kind: 'browser', route: page.route },
      setup: [{ action: 'goto', url: page.route }],
      actor: { kind: 'scripted' },
      steps: [{
        action: 'click',
        role: control.role,
        name: control.name,
        selector: control.selector,
      }],
      expected: [
        { assertion: 'element_visible', selector: 'body' },
        { assertion: 'no_console_errors' },
        { assertion: 'no_failed_requests' },
        { assertion: 'no_server_errors' },
      ],
      cleanup: { strategy: 'reset-session' },
      provenance: {
        source: 'manual',
        promotedAt: new Date().toISOString(),
        reviewNotes: 'Generated as draft; review side effects and expected outcome before execution',
      },
    }));
}

function buildObservedInteractionScenario(interaction: DiscoveredInteraction): ScenarioDefinition {
  const label = interaction.control.name ?? interaction.control.text ?? 'interaction';
  const expected: ScenarioDefinition['expected'] = [];
  if (interaction.outcome === 'navigation' && interaction.finalRoute) {
    expected.push({ assertion: 'url_matches', pattern: escapeRegex(interaction.finalRoute) });
  }
  if (interaction.marker) {
    expected.push(interaction.outcome === 'scroll'
      ? { assertion: 'element_in_viewport', text: interaction.marker }
      : { assertion: 'element_visible', text: interaction.marker });
  }
  expected.push(
    {
      assertion: 'no_console_errors',
      ignorePatterns: ['Failed to load resource: the server responded with a status of (401|403|404)'],
    },
    { assertion: 'no_failed_requests', ignorePatterns: ['^HEAD .* — net::ERR_ABORTED$'] },
    { assertion: 'no_server_errors' },
  );
  return {
    id: `${routeSlug(interaction.sourceRoute)}-${slug(label)}-observed`,
    version: 1,
    title: `${label} produces the observed ${interaction.outcome}`,
    description: `Automatically explored safe interaction from ${interaction.sourceUrl}`,
    tags: ['generated', 'safe', 'interaction', 'observed'],
    target: { kind: 'browser', route: interaction.sourceRoute },
    setup: [{ action: 'goto', url: interaction.sourceRoute }],
    actor: { kind: 'scripted' },
    steps: [{
      action: 'click',
      role: interaction.control.role,
      name: interaction.control.name,
      selector: interaction.control.selector,
    }],
    expected,
    cleanup: { strategy: 'reset-session' },
    provenance: {
      source: 'manual',
      promotedAt: new Date().toISOString(),
      reviewNotes: `Automatically executed during discovery; observed outcome=${interaction.outcome}`,
    },
  };
}

function safeControls(controls: DiscoveredControl[]): DiscoveredControl[] {
  return controls
    .filter((control) => control.kind === 'button' || control.kind === 'link')
    .filter((control) => {
      const label = control.name ?? control.text ?? '';
      return label && SAFE_INTERACTION.test(label) && !DANGEROUS_INTERACTION.test(label);
    })
    .slice(0, 12);
}

function isExecutableInteraction(interaction: DiscoveredInteraction): boolean {
  return ['navigation', 'dialog', 'content-change', 'scroll'].includes(interaction.outcome)
    && interaction.consoleErrors.length === 0
    && interaction.serverErrors.length === 0;
}

function sameControl(left: DiscoveredControl, right: DiscoveredControl): boolean {
  return left.kind === right.kind
    && (left.name ?? left.text ?? left.selector) === (right.name ?? right.text ?? right.selector);
}

function findNewTextMarker(before: string, after: string): string | undefined {
  if (before === after) return undefined;
  const beforeParts = new Set(before.split(/[.!?\n]/).map((part) => part.trim()).filter(Boolean));
  return after
    .split(/[.!?\n]/)
    .map((part) => part.trim())
    .find((part) => part.length >= 4 && !beforeParts.has(part))
    ?.slice(0, 100);
}

function findNewLineMarker(before: string[], after: string[]): string | undefined {
  const previous = new Set(before);
  return after.find((line) => line.length >= 4 && !previous.has(line))?.slice(0, 100);
}

function normalizeUrl(input: string): string {
  const value = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only HTTP and HTTPS URLs can be discovered');
  }
  parsed.hash = '';
  return parsed.toString();
}

function canonicalUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.searchParams.sort();
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function routeFor(input: string): string {
  const url = new URL(input);
  return `${url.pathname}${url.search}`;
}

function routeSlug(route: string): string {
  return slug(route === '/' ? 'landing' : route) || 'page';
}

function stableTextMarker(text: string): string | undefined {
  return text.split(/[.!?\n]/).map((part) => part.trim()).find((part) => part.length >= 4)?.slice(0, 100);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleFromHost(origin: string): string {
  return new URL(origin).hostname.split('.').map(
    (part) => part.charAt(0).toUpperCase() + part.slice(1),
  ).join(' ');
}
