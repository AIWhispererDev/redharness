import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { QaPack } from '../types.js';
import { runScenario, type ScenarioRunResult } from '../scenarios/runner.js';
import { runSecuritySmoke, type SecuritySmokeResult } from '../securitySmoke.js';
import { runBlackboxPentest, type PentestResult } from '../pentest.js';
import {
  discoverUrl,
  writeDiscoveredPack,
  type UrlDiscoveryOptions,
  type UrlDiscoveryResult,
} from './urlDiscovery.js';

export type UrlTestOptions = UrlDiscoveryOptions & {
  outputDir?: string;
  packId?: string;
  packName?: string;
  security?: boolean;
  blackbox?: boolean;
};

export type UrlTestResult = {
  status: 'passed' | 'failed' | 'error';
  outputDir: string;
  packDir: string;
  discovery: UrlDiscoveryResult;
  functional: ScenarioRunResult[];
  security?: SecuritySmokeResult;
  blackbox?: PentestResult;
};

export async function testUrl(
  url: string,
  options: UrlTestOptions = {},
): Promise<UrlTestResult> {
  const packId = options.packId ?? packIdFromUrl(url);
  const outputDir = path.resolve(
    options.outputDir
      ?? path.join('artifacts', 'url-tests', `${packId}-${Date.now()}`),
  );
  const packDir = path.join(outputDir, 'generated-pack');
  await mkdir(outputDir, { recursive: true });

  const discovery = await discoverUrl(url, options);
  const generatedPack = await writeDiscoveredPack(discovery, {
    outputDir: packDir,
    packId,
    packName: options.packName,
  });

  const functionalDir = path.join(outputDir, 'functional');
  const functional: ScenarioRunResult[] = [];
  for (const scenario of discovery.executableScenarios) {
    functional.push(await runScenario(scenario, {
      packDir,
      baseUrl: discovery.origin,
      storageState: options.storageState,
      headless: options.headless,
      outputDir: functionalDir,
      dataset: {
        id: 'discovered',
        version: '1.0.0',
        contentHash: generatedPack.datasetContentHash,
      },
    }));
  }

  const pack = buildRuntimePack(
    packId,
    options.packName,
    discovery,
  );
  const security = options.security === false
    ? undefined
    : await runSecuritySmoke(pack, {
        storageState: options.storageState,
        headless: options.headless,
        outputDir: path.join(outputDir, 'security'),
        writeFindings: true,
      });
  const blackbox = options.blackbox === false
    ? undefined
    : await runBlackboxPentest(pack, {
        outputDir: path.join(outputDir, 'blackbox'),
        routes: discovery.pages.map((page) => page.route),
      });
  const interactionFailures = discovery.interactions.filter(
    (interaction) => interaction.outcome === 'no-change' || interaction.outcome === 'error',
  );

  const status = functional.some((result) => result.status === 'error')
    ? 'error'
    : functional.some((result) => result.status !== 'passed')
      || interactionFailures.length > 0
      || security?.ok === false
      || blackbox?.ok === false
        ? 'failed'
        : 'passed';

  const result: UrlTestResult = {
    status,
    outputDir,
    packDir,
    discovery,
    functional,
    security,
    blackbox,
  };
  await writeFile(
    path.join(outputDir, 'summary.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  await writeFile(
    path.join(outputDir, 'summary.md'),
    renderUrlTestSummary(result),
    'utf8',
  );
  return result;
}

export function renderUrlTestSummary(result: UrlTestResult): string {
  const passedFunctional = result.functional.filter((item) => item.status === 'passed').length;
  const functionalFailures = result.functional.flatMap((scenario) =>
    scenario.trials.flatMap((trial) =>
      trial.assertions
        .filter((assertion) => !assertion.passed)
        .map((assertion) => `${scenario.title}: ${assertion.message}`),
    ),
  );
  const securityFailures = result.security?.checks.filter((check) => !check.ok) ?? [];
  const blackboxChecks = result.blackbox?.checks ?? [];
  const interactionFailures = suspectedInteractionFailures(result);
  const lines = [
    `# URL test — ${result.discovery.origin}`,
    '',
    `Status: ${result.status}`,
    `Pages discovered: ${result.discovery.pages.length}`,
    `Safe interactions explored: ${result.discovery.interactions.length}`,
    `Functional page checks: ${passedFunctional}/${result.functional.length} passed`,
    `Interaction drafts awaiting review: ${result.discovery.interactionDrafts.length}`,
  ];
  if (result.security) {
    lines.push(
      `Security smoke: ${result.security.checks.filter((check) => check.ok).length}/${result.security.checks.length} passed`,
    );
  }
  if (result.blackbox) {
    lines.push(blackboxChecks.length === 0
      ? 'Blackbox checks: not applicable — no additional probeable routes discovered'
      : `Blackbox checks: ${blackboxChecks.filter((check) => check.ok).length}/${blackboxChecks.length} passed`);
  }
  if (result.discovery.interactions.length > 0) {
    lines.push('', '## Explored interactions', '');
    lines.push(...result.discovery.interactions.map((interaction) => {
      const label = interaction.control.name ?? interaction.control.text ?? 'unnamed control';
      const destination = interaction.finalRoute ?? interaction.finalUrl;
      return `- ${label}: ${interaction.outcome}${destination ? ` → ${destination}` : ''}${interaction.error ? ` (${interaction.error})` : ''}`;
    }));
  }

  if (functionalFailures.length > 0) {
    lines.push('', '## Functional failures', '');
    lines.push(...functionalFailures.map((failure) => `- ${failure}`));
  }
  if (interactionFailures.length > 0) {
    lines.push('', '## Suspected functional findings', '');
    lines.push(...interactionFailures.map((interaction) => {
      const label = interaction.control.name ?? interaction.control.text ?? 'unnamed control';
      return `- ${label}: ${interaction.outcome === 'error' ? interaction.error : 'click produced no observable result'}`;
    }));
  }
  if (securityFailures.length > 0) {
    lines.push('', '## Security findings', '');
    lines.push(...securityFailures.map((check) =>
      `- [${check.severity ?? 'info'}] ${check.name}: ${check.details.join('; ')}`,
    ));
  }
  if (result.discovery.interactionDrafts.length > 0) {
    lines.push('', '## Workflows awaiting safe review', '');
    lines.push(...result.discovery.interactionDrafts.map((draft) => `- ${draft.title}`));
  }

  lines.push('', '## What this means', '');
  if (result.status === 'passed') {
    lines.push('- The automatically executable checks passed.');
  } else {
    lines.push('- At least one automatically executable functional or security check failed.');
  }
  if (result.discovery.interactionDrafts.length > 0) {
    lines.push('- The listed interactions were discovered but not executed because their expected outcome or side effects require review.');
  }
  lines.push('', `Evidence: ${result.outputDir}`, '');
  return lines.join('\n');
}

export function terminalUrlTestSummary(result: UrlTestResult): string[] {
  const lines = [
    `Status: ${result.status}`,
    `Pages discovered: ${result.discovery.pages.length}`,
    `Safe interactions explored: ${result.discovery.interactions.length}`,
    `Functional checks: ${result.functional.filter((item) => item.status === 'passed').length}/${result.functional.length} passed`,
  ];
  for (const scenario of result.functional) {
    for (const trial of scenario.trials) {
      for (const assertion of trial.assertions.filter((item) => !item.passed)) {
        lines.push(`  FAIL functional: ${scenario.title} — ${assertion.message}`);
      }
    }
  }
  for (const interaction of suspectedInteractionFailures(result)) {
    const label = interaction.control.name ?? interaction.control.text ?? 'unnamed control';
    lines.push(
      `  SUSPECT functional: ${label} — ${
        interaction.outcome === 'error'
          ? interaction.error ?? 'interaction error'
          : 'click produced no navigation, visible content, dialog, or scroll change'
      }`,
    );
  }
  if (result.security) {
    lines.push(`Security: ${result.security.checks.filter((check) => check.ok).length}/${result.security.checks.length} passed`);
    for (const check of result.security.checks.filter((item) => !item.ok)) {
      lines.push(`  FINDING ${check.severity ?? 'info'}: ${check.name}`);
    }
  }
  if (result.blackbox) {
    lines.push(result.blackbox.checks.length === 0
      ? 'Blackbox: not applicable — no additional probeable routes discovered'
      : `Blackbox: ${result.blackbox.checks.filter((check) => check.ok).length}/${result.blackbox.checks.length} passed`);
  }
  lines.push(`Review queue: ${result.discovery.interactionDrafts.length} interaction draft(s)`);
  for (const interaction of result.discovery.interactions) {
    const label = interaction.control.name ?? interaction.control.text ?? 'unnamed control';
    const destination = interaction.finalRoute ?? interaction.finalUrl;
    lines.push(`  EXPLORED: ${label} — ${interaction.outcome}${destination ? ` → ${destination}` : ''}`);
  }
  for (const draft of result.discovery.interactionDrafts) {
    lines.push(`  REVIEW: ${draft.title}`);
  }
  lines.push(`Evidence: ${result.outputDir}`);
  return lines;
}

function suspectedInteractionFailures(result: UrlTestResult) {
  return result.discovery.interactions.filter(
    (interaction) => interaction.outcome === 'no-change' || interaction.outcome === 'error',
  );
}

export function packIdFromUrl(input: string): string {
  const value = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`;
  return new URL(value).hostname
    .replace(/^www\./, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function buildRuntimePack(
  packId: string,
  packName: string | undefined,
  discovery: UrlDiscoveryResult,
): QaPack {
  return {
    id: packId,
    name: packName ?? new URL(discovery.origin).hostname,
    type: 'discovered-web',
    baseUrl: discovery.origin,
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
      publicRoutes: discovery.pages.map((page) => ({
        path: page.route,
        titleIncludes: page.title || undefined,
        textIncludes: page.headings.slice(0, 2),
      })),
    },
  };
}
