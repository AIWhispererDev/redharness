#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import YAML from 'yaml';
import { loadPackFromDir } from './pack.js';
import { validateReport } from './report.js';
import { scanText } from './scanner.js';
import { renderSmokeReport, runPublicSmoke, summarizeSmokeResults } from './smoke.js';
import { renderBrowserSmokeReport, runBrowserSmoke } from './browserSmoke.js';
import { draftCoreReportsFromBrowserSmoke } from './draftReports.js';
import { renderAuthSmokeReport, runAuthSmoke } from './authSmoke.js';
import { renderCrucibleSmokeReport, runCrucibleSmoke } from './crucibleSmoke.js';
import { renderPublicNavSmokeReport, runPublicNavSmoke } from './publicNavSmoke.js';
import { buildRunSummaryJson, renderRunSummary, type RunSection } from './runSummary.js';
import { draftSmokeFailureReports } from './genericDrafts.js';
import { renderCompactRunSummary, resolveRunDir } from './runDir.js';
import { renderProRegressionSmokeReport, runProRegressionSmoke } from './proRegressionSmoke.js';
import { renderLongThreadSmokeReport, runLongThreadSmoke } from './longThreadSmoke.js';
import { renderMobileAuthSmokeReport, runMobileAuthSmoke } from './mobileAuthSmoke.js';
import { renderRecordExportSmokeReport, runRecordExportSmoke } from './recordExportSmoke.js';
import { renderCompletionSmokeReport, runCompletionSmoke } from './completionSmoke.js';
import { renderSimpleSmokeReport, runBillingSmoke, runLanguageSmoke, runWorkshopSmoke } from './additionalSmoke.js';
import { renderTargetedChangelogSmokeReport, runTargetedChangelogSmoke } from './targetedChangelogSmoke.js';
import { renderChaosSmokeReport, runChaosSmoke } from './chaosSmoke.js';
import { renderSecuritySmokeReport, runSecuritySmoke } from './securitySmoke.js';
import { renderPentestReport, runBlackboxPentest } from './pentest.js';
import { runWhiteboxPentest } from './whiteboxPentest.js';

const program = new Command();

function defaultPackDir(packId: string): string {
  return path.resolve(process.cwd(), 'packs', packId);
}

async function writeGenericDrafts(params: {
  packName: string;
  suiteName: string;
  checks: Array<{ name: string; ok: boolean; details: string[] }>;
  artifacts?: string[];
  draftDir: string;
}): Promise<string[]> {
  const drafts = draftSmokeFailureReports(params);
  await mkdir(params.draftDir, { recursive: true });
  const written: string[] = [];
  for (const draft of drafts) {
    const mdPath = path.join(params.draftDir, `${draft.slug}.md`);
    const yamlPath = path.join(params.draftDir, `${draft.slug}.yaml`);
    await writeFile(mdPath, draft.markdown, 'utf8');
    await writeFile(yamlPath, draft.yaml, 'utf8');
    written.push(mdPath, yamlPath);
  }
  return written;
}

program
  .name('qa-harness')
  .description('General QA harness with app-specific QA packs')
  .version('0.1.0');

program
  .command('checklist')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .argument('<track>', 'track name, e.g. basics')
  .description('Print a pack track checklist')
  .action(async (packId, trackName) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const track = pack.tracks[trackName];
    if (!track) throw new Error(`Unknown track: ${trackName}`);
    console.log(`# ${pack.name} ${trackName} checklist\n`);
    for (const task of track.tasks) {
      console.log(`- [ ] ${task.mapsTo} — ${task.name}`);
    }
  });

program
  .command('scan')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .argument('<file>', 'text file to scan')
  .option('--target <target>', 'rule target', 'ai_response')
  .description('Scan text against pack rules')
  .action(async (packId, file, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const text = await readFile(path.resolve(process.cwd(), file), 'utf8');
    const findings = scanText(pack, options.target, text);
    if (findings.length === 0) {
      console.log('PASS: no findings');
      return;
    }
    console.log(`FAIL: ${findings.length} finding(s)\n`);
    for (const finding of findings) {
      console.log(`- [${finding.severity}] ${finding.ruleId}: ${finding.label}`);
      console.log(`  match: ${finding.match}`);
    }
  });

program
  .command('report')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .argument('<report>', 'report schema, e.g. core')
  .argument('<file>', 'YAML report data')
  .description('Validate and render a report from YAML')
  .action(async (packId, reportName, file) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const data = YAML.parse(await readFile(path.resolve(process.cwd(), file), 'utf8'));
    const result = validateReport(pack, reportName, data);
    if (!result.ok) {
      console.error('Report validation failed:');
      for (const error of result.errors) console.error(`- ${error}`);
      process.exitCode = 1;
    }
    for (const warning of result.warnings) console.error(`Warning: ${warning}`);
    console.log(result.markdown);
  });

program
  .command('smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--json', 'print JSON instead of markdown')
  .description('Run pack-defined public smoke checks')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const results = await runPublicSmoke(pack);
    const summary = summarizeSmokeResults(results);

    if (options.json) {
      console.log(JSON.stringify({ pack: pack.id, summary, results }, null, 2));
    } else {
      console.log(renderSmokeReport(pack.name, results));
    }

    if (!summary.ok) process.exitCode = 1;
  });

program
  .command('browser-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .option('--draft-dir <dir>', 'write draft-only issue reports for known failures')
  .description('Run pack-defined browser interaction smoke checks')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runBrowserSmoke(pack, {
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderBrowserSmokeReport(pack.name, result));

    if (options.draftDir) {
      const draftDir = path.resolve(process.cwd(), options.draftDir);
      await mkdir(draftDir, { recursive: true });
      const drafts = draftCoreReportsFromBrowserSmoke(result);
      for (const draft of drafts) {
        const yamlPath = path.join(draftDir, `${draft.slug}.yaml`);
        const markdownPath = path.join(draftDir, `${draft.slug}.md`);
        await writeFile(yamlPath, YAML.stringify(draft.data), 'utf8');
        await writeFile(markdownPath, draft.markdown, 'utf8');
        console.log(`\nDraft-only report written: ${markdownPath}`);
        console.log(`Draft-only YAML written: ${yamlPath}`);
      }
      if (drafts.length === 0) console.log('\nNo draft reports generated.');
    }

    if (!result.ok) process.exitCode = 1;
  });

program
  .command('auth-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for an authenticated tester account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .description('Run authenticated smoke checks using a local Playwright storage-state file')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    if (!pack.baseUrl) throw new Error(`Pack ${pack.id} has no baseUrl.`);
    const result = await runAuthSmoke({
      baseUrl: pack.baseUrl,
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderAuthSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('crucible-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for an authenticated tester account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .option('--prompt <text>', 'smoke prompt to send to Soc')
  .description('Run authenticated Crucible interaction smoke checks and scan Soc response style')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runCrucibleSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      prompt: options.prompt,
    });
    console.log(renderCrucibleSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('public-nav-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .description('Run browser-based public navigation checks')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runPublicNavSmoke(pack, {
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderPublicNavSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('blackbox-pentest')
  .argument('<pack>')
  .option('--url <url>', 'target URL; defaults to pack baseUrl')
  .option('--output-dir <dir>')
  .option('--confirm-runs <n>', 'replay attempts for suspected findings', '2')
  .description('Run safe URL-only blackbox pentest probes with confirmed replay')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runBlackboxPentest(pack, {
      url: options.url,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      confirmRuns: Number(options.confirmRuns ?? 2),
    });
    console.log(renderPentestReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('whitebox-pentest')
  .argument('<pack>')
  .requiredOption('--repo <dir>', 'local repository to inspect')
  .option('--url <url>', 'target URL; defaults to pack baseUrl')
  .option('--output-dir <dir>')
  .option('--confirm-runs <n>', 'replay attempts for suspected findings', '2')
  .description('Run repo-aware whitebox route discovery plus live auth-gate probes')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runWhiteboxPentest(pack, {
      repo: path.resolve(process.cwd(), options.repo),
      url: options.url,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      confirmRuns: Number(options.confirmRuns ?? 2),
    });
    console.log(renderPentestReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('security-smoke')
  .argument('<pack>')
  .option('--storage-state <file>')
  .option('--headed')
  .option('--output-dir <dir>')
  .option('--write-findings', 'write Notion-ready finding packets for medium/high failures')
  .description('Run safe HackZero-style security smoke checks')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runSecuritySmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      writeFindings: options.writeFindings,
    });
    console.log(renderSecuritySmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('chaos-smoke')
  .argument('<pack>')
  .option('--storage-state <file>')
  .option('--headed')
  .option('--output-dir <dir>')
  .description('Run aggressive exploratory/chaos probes to surface likely bugs')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runChaosSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderChaosSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('targeted-changelog-smoke')
  .argument('<pack>')
  .option('--storage-state <file>')
  .option('--non-pro-storage-state <file>', 'optional non-Pro account storage state for Pro bypass test')
  .option('--headed')
  .option('--output-dir <dir>')
  .description('Run targeted checks for selected Round 1 changelog items')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runTargetedChangelogSmoke(pack, {
      storageState: options.storageState,
      nonProStorageState: options.nonProStorageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderTargetedChangelogSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('billing-smoke')
  .argument('<pack>')
  .option('--storage-state <file>')
  .option('--headed')
  .option('--output-dir <dir>')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runBillingSmoke(pack, { storageState: options.storageState, headless: !options.headed, outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined });
    console.log(renderSimpleSmokeReport(pack.name, 'Billing smoke', result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('language-smoke')
  .argument('<pack>')
  .option('--storage-state <file>')
  .option('--language <code>', 'language code/label to look for', 'vi')
  .option('--headed')
  .option('--output-dir <dir>')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runLanguageSmoke(pack, { storageState: options.storageState, headless: !options.headed, outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined, language: options.language });
    console.log(renderSimpleSmokeReport(pack.name, `Language ${options.language} smoke`, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('workshop-smoke')
  .argument('<pack>')
  .option('--storage-state <file>')
  .option('--headed')
  .option('--output-dir <dir>')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runWorkshopSmoke(pack, { storageState: options.storageState, headless: !options.headed, outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined });
    console.log(renderSimpleSmokeReport(pack.name, 'Workshop smoke', result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('completion-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for authenticated Pro account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .option('--max-turns <number>', 'maximum turns to attempt', (value) => Number(value), 20)
  .description('Drive a Pro/Solo thread toward Landing/completion and record stage timeline')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runCompletionSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      maxTurns: options.maxTurns,
    });
    console.log(renderCompletionSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('record-export-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for authenticated account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .description('Run Records/Document and export/download graceful-state checks')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runRecordExportSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderRecordExportSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('mobile-auth-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for authenticated account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .description('Run authenticated mobile dashboard/app-shell smoke checks')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runMobileAuthSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
    });
    console.log(renderMobileAuthSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('long-thread-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for authenticated Pro account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .option('--turns <number>', 'number of turns to attempt', (value) => Number(value), 12)
  .option('--refresh-every <number>', 'refresh after every N turns', (value) => Number(value), 5)
  .description('Run longer Pro/Solo thread stability checks with timing, refresh persistence, console/network capture')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runLongThreadSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      turns: options.turns,
      refreshEvery: options.refreshEvery,
    });
    console.log(renderLongThreadSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('pro-regression-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for an authenticated Pro tester account')
  .option('--headed', 'run browser in headed mode')
  .option('--output-dir <dir>', 'artifact output directory')
  .option('--turns <number>', 'number of Soc turns to attempt', (value) => Number(value), 3)
  .description('Run Pro/Solo Crucible regression checks: send turns, persist after refresh, style scan')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const result = await runProRegressionSmoke(pack, {
      storageState: options.storageState,
      headless: !options.headed,
      outputDir: options.outputDir ? path.resolve(process.cwd(), options.outputDir) : undefined,
      turns: options.turns,
    });
    console.log(renderProRegressionSmokeReport(pack.name, result));
    if (!result.ok) process.exitCode = 1;
  });

program
  .command('all-smoke')
  .argument('<pack>', 'pack id, e.g. pocket-socrates')
  .option('--storage-state <file>', 'Playwright storage state JSON for authenticated checks')
  .option('--output-dir <dir>', 'base artifact output directory', 'artifacts/pocket-socrates/all-smoke')
  .option('--run-dir <dir|auto>', 'write to a specific run directory, or use auto for runs/<pack>/<timestamp>')
  .option('--ci', 'compact CI output; still writes markdown, JSON, artifacts, and drafts')
  .description('Run all currently implemented Pocket Socrates smoke suites')
  .action(async (packId, options) => {
    const pack = await loadPackFromDir(defaultPackDir(packId));
    const baseDir = resolveRunDir({ packId, outputDir: options.outputDir, runDir: options.runDir });
    const sections: RunSection[] = [];
    const draftDir = path.join(baseDir, 'drafts');
    const draftPaths: string[] = [];

    const publicRoutes = await runPublicSmoke(pack);
    const publicSummary = summarizeSmokeResults(publicRoutes);
    sections.push({ name: 'public routes', ok: publicSummary.ok, markdown: renderSmokeReport(pack.name, publicRoutes), artifacts: [] });
    draftPaths.push(
      ...(await writeGenericDrafts({ packName: pack.name, suiteName: 'public routes', checks: publicRoutes, draftDir })),
    );

    const publicNav = await runPublicNavSmoke(pack, { outputDir: path.join(baseDir, 'public-nav') });
    sections.push({ name: 'public nav', ok: publicNav.ok, markdown: renderPublicNavSmokeReport(pack.name, publicNav), artifacts: publicNav.artifacts });
    draftPaths.push(
      ...(await writeGenericDrafts({ packName: pack.name, suiteName: 'public nav', checks: publicNav.checks, artifacts: publicNav.artifacts, draftDir })),
    );

    const browser = await runBrowserSmoke(pack, { outputDir: path.join(baseDir, 'early-access') });
    sections.push({ name: 'early access/TOS', ok: browser.ok, markdown: renderBrowserSmokeReport(pack.name, browser), artifacts: browser.artifacts });
    draftPaths.push(
      ...(await writeGenericDrafts({ packName: pack.name, suiteName: 'early access TOS', checks: browser.checks, artifacts: browser.artifacts, draftDir })),
    );

    const auth = await runAuthSmoke({ baseUrl: pack.baseUrl!, storageState: options.storageState, outputDir: path.join(baseDir, 'auth') });
    sections.push({ name: 'authenticated dashboard', ok: auth.ok, markdown: renderAuthSmokeReport(pack.name, auth), artifacts: auth.artifacts });
    draftPaths.push(
      ...(await writeGenericDrafts({ packName: pack.name, suiteName: 'authenticated dashboard', checks: auth.checks, artifacts: auth.artifacts, draftDir })),
    );

    const crucible = await runCrucibleSmoke(pack, { storageState: options.storageState, outputDir: path.join(baseDir, 'crucible') });
    sections.push({ name: 'crucible', ok: crucible.ok, markdown: renderCrucibleSmokeReport(pack.name, crucible), artifacts: crucible.artifacts });
    draftPaths.push(
      ...(await writeGenericDrafts({ packName: pack.name, suiteName: 'crucible', checks: crucible.checks, artifacts: crucible.artifacts, draftDir })),
    );

    const markdown = renderRunSummary(pack.name, sections);
    const summaryJson = buildRunSummaryJson(pack.name, sections);
    await mkdir(baseDir, { recursive: true });
    const summaryPath = path.join(baseDir, 'summary.md');
    const summaryJsonPath = path.join(baseDir, 'summary.json');
    await writeFile(summaryPath, markdown, 'utf8');
    await writeFile(summaryJsonPath, JSON.stringify(summaryJson, null, 2), 'utf8');
    if (options.ci) {
      console.log(renderCompactRunSummary(pack.name, sections, baseDir));
      console.log(`Summary written: ${summaryPath}`);
      console.log(`JSON written: ${summaryJsonPath}`);
      if (draftPaths.length) console.log(`Draft count: ${draftPaths.length}`);
    } else {
      console.log(markdown);
      console.log(`\nSummary written: ${summaryPath}`);
      console.log(`JSON written: ${summaryJsonPath}`);
      if (draftPaths.length) console.log(`Drafts written:\n${draftPaths.map((item) => `- ${item}`).join('\n')}`);
    }
    if (!sections.every((section) => section.ok)) process.exitCode = 1;
  });

await program.parseAsync(process.argv);
