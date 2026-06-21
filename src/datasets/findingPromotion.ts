import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { DatasetManifest, DatasetSplit } from './manifest.js';
import { computeDatasetHash } from './manifest.js';
import { loadScenariosFromDir } from '../scenarios/loader.js';
import type {
  ScenarioAction,
  ScenarioAssertion,
  ScenarioDefinition,
} from '../scenarios/schema.js';
import type {
  AssertionRecipe,
  BrowserReplaySpec,
  FindingLifecycleState,
  LocatorRecipe,
  RecordedAction,
} from '../trace/traceTypes.js';

const PROMOTABLE_STATES = new Set<FindingLifecycleState>([
  'confirmed-semantic',
  'confirmed-evidence',
  'confirmed-state-harm',
  'regression',
]);
const DATASET_SPLITS = new Set<DatasetSplit>([
  'smoke',
  'release',
  'exploratory',
  'security',
  'adversarial',
  'holdout',
]);

export type FindingPromotionInput = {
  findingId: string;
  runId: string;
  title: string;
  lifecycleState: string;
  originatingSuiteId?: string;
  expectedState?: string;
  traceId?: string;
  replaySpec: BrowserReplaySpec;
};

export type PromoteFindingOptions = {
  datasetDir: string;
  finding: FindingPromotionInput;
  reviewerId: string;
  reviewNotes?: string;
  split?: DatasetSplit;
  scenarioId?: string;
};

export type FindingPromotionResult = {
  scenarioId: string;
  scenarioPath: string;
  split: DatasetSplit;
  datasetContentHash: string;
};

export async function promoteFindingToDataset(
  options: PromoteFindingOptions,
): Promise<FindingPromotionResult> {
  if (!PROMOTABLE_STATES.has(options.finding.lifecycleState as FindingLifecycleState)) {
    throw new Error(
      `Finding "${options.finding.findingId}" must be confirmed before promotion; current state is "${options.finding.lifecycleState}"`,
    );
  }
  if (!options.reviewerId.trim()) {
    throw new Error('reviewerId is required to promote regression coverage');
  }

  const manifestPath = path.join(options.datasetDir, 'dataset.yaml');
  const manifest = YAML.parse(
    await readFile(manifestPath, 'utf8'),
  ) as DatasetManifest;
  const split = options.split ?? 'release';
  if (!DATASET_SPLITS.has(split)) {
    throw new Error(`Unknown dataset split: ${split}`);
  }
  const scenarioId = options.scenarioId ?? makeScenarioId(options.finding);
  const scenarioPath = path.join(options.datasetDir, 'scenarios', `${scenarioId}.yaml`);

  const scenario = buildScenarioFromFinding(
    options.finding,
    scenarioId,
    options.reviewerId,
    options.reviewNotes,
  );

  await mkdir(path.dirname(scenarioPath), { recursive: true });
  try {
    await readFile(scenarioPath, 'utf8');
    throw new Error(`Scenario already exists: ${scenarioId}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Scenario already exists:')) {
      throw error;
    }
  }

  await writeFile(scenarioPath, YAML.stringify(scenario), 'utf8');

  try {
    const scenarios = await loadScenariosFromDir(options.datasetDir);
    const contentHash = computeDatasetHash(scenarios);
    const splitIds = new Set(manifest.splits[split] ?? []);
    splitIds.add(scenarioId);
    const promotedAt = new Date().toISOString();
    const updatedManifest: DatasetManifest = {
      ...manifest,
      splits: {
        ...manifest.splits,
        [split]: [...splitIds].sort(),
      },
      provenance: {
        ...manifest.provenance,
        lastReviewDate: promotedAt,
      },
      reviewMetadata: {
        lastReviewDate: promotedAt,
        reviewerId: options.reviewerId,
        reviewNotes: options.reviewNotes
          ?? `Promoted confirmed finding ${options.finding.findingId}`,
        nextReviewDue: manifest.reviewMetadata?.nextReviewDue,
      },
      contentHash,
    };
    await writeFile(manifestPath, YAML.stringify(updatedManifest), 'utf8');

    return {
      scenarioId,
      scenarioPath,
      split,
      datasetContentHash: contentHash,
    };
  } catch (error) {
    const { rm } = await import('node:fs/promises');
    await rm(scenarioPath, { force: true });
    throw error;
  }
}

export function buildScenarioFromFinding(
  finding: FindingPromotionInput,
  scenarioId: string,
  reviewerId: string,
  reviewNotes?: string,
): ScenarioDefinition {
  const steps = finding.replaySpec.actions.map(convertAction);
  if (steps.length === 0) {
    throw new Error('Browser replay has no executable actions');
  }

  return {
    id: scenarioId,
    version: 1,
    title: `Regression: ${finding.title}`,
    description: finding.expectedState,
    tags: ['regression', 'promoted-finding'],
    target: {
      kind: 'browser',
      route: inferRoute(finding.replaySpec),
    },
    prerequisites: finding.replaySpec.prerequisiteText
      ? { requires: [finding.replaySpec.prerequisiteText] }
      : undefined,
    setup: finding.replaySpec.setup.map(convertAction),
    actor: { kind: 'scripted' },
    steps,
    expected: [convertAssertion(finding.replaySpec.assertion)],
    cleanup: { strategy: 'reset-session' },
    provenance: {
      source: 'finding',
      findingId: finding.findingId,
      runId: finding.runId,
      traceId: finding.traceId,
      promotedAt: new Date().toISOString(),
      reviewerId,
      reviewNotes,
    },
  };
}

function convertAction(action: RecordedAction): ScenarioAction {
  switch (action.type) {
    case 'goto':
      return { action: 'goto', url: action.url };
    case 'click':
      return { action: 'click', ...convertLocator(action.locator) };
    case 'fill':
      throw new Error(
        `Replay fill action references "${action.valueRef}"; resolve the value before promotion`,
      );
    case 'press':
      return { action: 'press', key: action.key };
    case 'waitFor':
      if (action.condition.type === 'timeout') {
        return { action: 'wait', ms: action.condition.ms };
      }
      if (action.condition.type === 'selector') {
        const locator = convertLocator(action.condition.locator);
        if (!locator.selector) {
          throw new Error('Selector wait requires a replay locator with css or testId');
        }
        return {
          action: 'wait_for_selector',
          selector: locator.selector,
          timeoutMs: action.condition.timeoutMs,
        };
      }
      throw new Error(`Replay wait type "${action.condition.type}" is not promotable`);
    case 'assert': {
      const assertion = convertAssertion(action.assertion);
      if (assertion.assertion === 'element_visible') {
        return { action: 'assert_visible', ...withoutAssertion(assertion) };
      }
      if (assertion.assertion === 'text_present') {
        return { action: 'assert_text', value: assertion.text };
      }
      if (assertion.assertion === 'url_matches') {
        return { action: 'assert_url', pattern: assertion.pattern };
      }
      throw new Error('State assertions cannot be represented as scripted actions');
    }
    case 'screenshot':
      return { action: 'screenshot', name: action.name };
    case 'reload':
      return { action: 'reload' };
    case 'request':
      throw new Error('HTTP request replay actions are not yet promotable as browser scenarios');
  }
}

function convertAssertion(assertion: AssertionRecipe): ScenarioAssertion {
  switch (assertion.type) {
    case 'visible':
      return { assertion: 'element_visible', ...convertLocator(assertion.locator) };
    case 'text':
      return { assertion: 'text_present', text: assertion.value };
    case 'url':
      return { assertion: 'url_matches', pattern: assertion.pattern };
    case 'state':
      return {
        assertion: 'state_equals',
        path: assertion.path,
        expected: assertion.expected,
      };
  }
}

function convertLocator(
  locator: LocatorRecipe,
): { role?: string; name?: string; selector?: string } {
  return {
    role: locator.role,
    name: locator.name ?? locator.label ?? locator.text,
    selector: locator.css ?? (locator.testId ? `[data-testid="${locator.testId}"]` : undefined),
  };
}

function withoutAssertion(
  assertion: Extract<ScenarioAssertion, { assertion: 'element_visible' }>,
): Omit<typeof assertion, 'assertion'> {
  const { assertion: _assertion, ...locator } = assertion;
  return locator;
}

function inferRoute(replay: BrowserReplaySpec): string | undefined {
  const firstGoto = [...replay.setup, ...replay.actions].find(
    (action): action is Extract<RecordedAction, { type: 'goto' }> => action.type === 'goto',
  );
  if (!firstGoto) return undefined;
  try {
    return new URL(firstGoto.url, 'https://qa-harness.invalid').pathname;
  } catch {
    return undefined;
  }
}

function makeScenarioId(finding: FindingPromotionInput): string {
  const base = finding.originatingSuiteId || finding.title || finding.findingId;
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return `${normalized || 'finding'}-regression`;
}
