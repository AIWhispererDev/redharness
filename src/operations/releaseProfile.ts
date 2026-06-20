import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { readFile } from 'node:fs/promises';
import { RunCoordinator } from '../core/runCoordinator.js';
import { evaluateRunPolicy } from '../core/resultPolicy.js';
import type { RunManifest } from '../core/runTypes.js';
import { generateJUnitXml } from '../reporters/junit.js';
import { generateSarifReport } from '../reporters/sarif.js';
import {
  generateGitHubAnnotations,
  generateGitHubStepSummary,
} from '../reporters/github.js';
import { startReleaseWebApp, type ReleaseFixture } from '../fixtures/releaseWebApp.js';
import { registerAllSuites } from '../suites/registerSuites.js';

export type ReleaseProfileOptions = {
  packDir: string;
  packId: string;
  outputDir: string;
  profile?: string;
  runId?: string;
  baseUrl?: string;
  startFixture?: boolean;
};

export type ReleaseProfileResult = {
  manifest: RunManifest;
  runDir: string;
  reportPaths: {
    json: string;
    markdown: string;
    junit: string;
    sarif: string;
  };
};

type ProfileConfig = {
  includeTags?: string[];
  excludeTags?: string[];
};

async function loadProfile(
  packDir: string,
  profileName: string,
): Promise<ProfileConfig> {
  const raw = await readFile(path.join(packDir, 'pack.yaml'), 'utf8');
  const parsed = YAML.parse(raw) as {
    profiles?: Record<string, ProfileConfig>;
  };
  const profile = parsed.profiles?.[profileName];
  if (!profile) {
    throw new Error(
      `Unknown profile "${profileName}" for ${packDir}`,
    );
  }
  return profile;
}

/**
 * Execute a real coordinator-backed release profile and persist all CI reports.
 */
export async function runReleaseProfile(
  options: ReleaseProfileOptions,
): Promise<ReleaseProfileResult> {
  registerAllSuites();
  const profileName = options.profile ?? 'release';
  const profile = await loadProfile(options.packDir, profileName);
  const runId = options.runId ?? `${options.packId}-${profileName}`;
  const runDir = path.resolve(options.outputDir, runId);
  let fixture: ReleaseFixture | undefined;

  try {
    if (options.startFixture) {
      fixture = await startReleaseWebApp();
    }
    const baseUrl = options.baseUrl ?? fixture?.baseUrl;
    if (!baseUrl) {
      throw new Error('Release profile requires a base URL or startFixture=true');
    }

    const coordinator = new RunCoordinator({
      packDir: options.packDir,
      packId: options.packId,
      source: 'ci',
      profile: profileName,
      selection: {
        suites: [],
        tags: profile.includeTags ?? [],
        excludedTags: profile.excludeTags ?? [],
      },
      policy: {
        retryErrors: 0,
        maxWorkers: 1,
      },
      baseUrl,
      headless: true,
      runDir,
      runId,
    });
    const manifest = await coordinator.execute();
    const markdown = generateGitHubStepSummary(manifest);
    const reportPaths = {
      json: path.join(runDir, 'run.json'),
      markdown: path.join(runDir, 'summary.md'),
      junit: path.join(runDir, 'junit.xml'),
      sarif: path.join(runDir, 'results.sarif'),
    };

    await mkdir(runDir, { recursive: true });
    await Promise.all([
      writeFile(reportPaths.markdown, markdown, 'utf8'),
      writeFile(reportPaths.junit, generateJUnitXml(manifest, runDir), 'utf8'),
      writeFile(
        reportPaths.sarif,
        JSON.stringify(generateSarifReport(manifest, runDir), null, 2),
        'utf8',
      ),
    ]);

    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8');
    }
    for (const annotation of generateGitHubAnnotations(manifest)) {
      console.log(annotation);
    }

    return { manifest, runDir, reportPaths };
  } finally {
    await fixture?.stop();
  }
}

export function releaseProfilePassed(result: ReleaseProfileResult): boolean {
  return evaluateRunPolicy(result.manifest.suiteResults).isPassing;
}
