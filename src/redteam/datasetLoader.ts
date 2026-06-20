/**
 * PRD 06: Dataset-driven red-team evaluation — loads versioned red-team
 * datasets with OWASP attack scenarios, splits, and provenance.
 *
 * Each red-team dataset is a directory under
 * packs/<packId>/datasets/redteam/ with:
 *   dataset.yaml  — dataset manifest with splits and provenance
 *   scenarios/    — one YAML per attack scenario
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { attackRegistry } from './attackRegistry.js';
import type { AttackDefinition, OwaspCategory } from './redteamTypes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RedTeamDatasetSplit = 'smoke' | 'release' | 'exploratory' | 'adversarial' | 'holdout';

export type RedTeamDatasetManifest = {
  id: string;
  version: string;
  description: string;
  splits: Partial<Record<RedTeamDatasetSplit, string[]>>;
  provenance: {
    owner: string;
    createdFrom: 'manual' | 'generated' | 'imported';
    generator?: string;
    generatorVersion?: string;
    lastReviewDate?: string;
    parentDatasetId?: string;
  };
  contentHash: string;
};

export type RedTeamScenarioFile = {
  /** Scenario ID (matches file name). */
  id: string;
  /** Attack definition reference. */
  attackId: string;
  /** Optional override for the attack template. */
  templateOverride?: string;
  /** Environment restrictions. */
  environments?: string[];
  /** Tags for category/selection. */
  tags: string[];
  /** Whether this scenario requires a fixture. */
  requiresFixture?: boolean;
  /** Whether this scenario is safe for all environments. */
  safeForProduction?: boolean;
  /** Human review status. */
  reviewStatus: 'unreviewed' | 'reviewed' | 'approved' | 'blocked';
  /** Review notes. */
  reviewNotes?: string;
  /** Seed for deterministic mutation. */
  seed?: string;
  /** Mutation strategy to apply. */
  mutationStrategy?: string;
  /** Benign control template for utility measurement. */
  benignControl?: string;
  /** Number of trials to run (overrides CLI default). */
  trials?: number;
};

export type RedTeamLoadOptions = {
  dataset?: string;
  split?: RedTeamDatasetSplit;
  category?: OwaspCategory;
  tags?: string[];
  environments?: string[];
  reviewStatus?: 'unreviewed' | 'reviewed' | 'approved';
};

// ---------------------------------------------------------------------------
// Loader implementation
// ---------------------------------------------------------------------------

/**
 * Load the red-team dataset manifest from a pack directory.
 */
export async function loadRedTeamManifest(
  packDir: string,
  datasetId: string = 'redteam',
): Promise<RedTeamDatasetManifest | null> {
  const manifestPath = path.join(packDir, 'datasets', datasetId, 'dataset.yaml');
  try {
    const raw = await readFile(manifestPath, 'utf8');
    return YAML.parse(raw) as RedTeamDatasetManifest;
  } catch {
    return null;
  }
}

/**
 * Load all red-team scenario files from a dataset directory.
 */
export async function loadRedTeamScenarios(
  packDir: string,
  datasetId: string = 'redteam',
): Promise<RedTeamScenarioFile[]> {
  const scenariosDir = path.join(packDir, 'datasets', datasetId, 'scenarios');
  const scenarios: RedTeamScenarioFile[] = [];

  try {
    const entries = await readdir(scenariosDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml'))) continue;
      const raw = await readFile(path.join(scenariosDir, entry.name), 'utf8');
      const parsed = YAML.parse(raw) as RedTeamScenarioFile;
      // Derive id from filename if not set
      if (!parsed.id) {
        parsed.id = path.basename(entry.name, path.extname(entry.name));
      }
      scenarios.push(parsed);
    }
  } catch {
    // scenarios dir may not exist
  }

  return scenarios;
}

/**
 * Resolve scenario files into AttackDefinitions, merging scenario overrides.
 */
export function resolveRedTeamAttacks(
  scenarios: RedTeamScenarioFile[],
  options?: RedTeamLoadOptions,
): { attacks: AttackDefinition[]; scenarioMap: Map<string, RedTeamScenarioFile> } {
  const scenarioMap = new Map<string, RedTeamScenarioFile>();
  const attacks: AttackDefinition[] = [];

  for (const scenario of scenarios) {
    // Apply selection filters
    if (options?.category) {
      const attack = attackRegistry.get(scenario.attackId);
      if (attack && attack.category !== options.category) continue;
    }
    if (options?.tags && options.tags.length > 0) {
      const attack = attackRegistry.get(scenario.attackId);
      if (attack && !options.tags.some((t) => attack.tags.includes(t))) continue;
    }
    if (options?.environments && options.environments.length > 0) {
      if (scenario.environments && !scenario.environments.some((e) => options.environments!.includes(e))) continue;
    }
    if (options?.reviewStatus) {
      if (scenario.reviewStatus !== options.reviewStatus && scenario.reviewStatus !== 'approved') continue;
    }

    const attack = attackRegistry.get(scenario.attackId);
    if (!attack) continue;

    // Clone and apply scenario overrides
    const resolved: AttackDefinition = {
      ...attack,
      template: scenario.templateOverride ?? attack.template,
      tags: [...new Set([...attack.tags, ...scenario.tags])],
      safeForProduction: scenario.safeForProduction ?? attack.safeForProduction,
      requiresFixture: scenario.requiresFixture ?? attack.requiresFixture,
    };

    scenarioMap.set(resolved.id, scenario);
    attacks.push(resolved);
  }

  return { attacks, scenarioMap };
}

/**
 * Select attacks by split from the manifest.
 */
export async function selectRedTeamAttacks(
  packDir: string,
  datasetId: string,
  split?: RedTeamDatasetSplit,
  options?: RedTeamLoadOptions,
): Promise<{ attacks: AttackDefinition[]; scenarios: RedTeamScenarioFile[]; manifest: RedTeamDatasetManifest | null }> {
  const manifest = await loadRedTeamManifest(packDir, datasetId);
  const allScenarios = await loadRedTeamScenarios(packDir, datasetId);

  let filtered: RedTeamScenarioFile[];
  if (split && manifest?.splits[split]) {
    const splitIds = new Set(manifest.splits[split]!);
    filtered = allScenarios.filter((s) => splitIds.has(s.id));
  } else {
    filtered = [...allScenarios];
  }

  const { attacks } = resolveRedTeamAttacks(filtered, options);
  return { attacks, scenarios: filtered, manifest };
}

/**
 * Compute the content hash for a set of attack definitions.
 * Used to verify dataset integrity and enable reproducibility.
 */
export function computeRedTeamContentHash(attacks: AttackDefinition[]): string {
  const hash = createHash('sha256');
  const stable = attacks
    .map((a) => `${a.id}|${a.template}|${a.category}|${a.riskLevel}|${a.tags.sort().join(',')}`)
    .sort()
    .join('\n');
  hash.update(stable);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Validate a red-team manifest against loaded scenarios.
 */
export function validateRedTeamDataset(
  manifest: RedTeamDatasetManifest,
  scenarios: RedTeamScenarioFile[],
): string[] {
  const errors: string[] = [];
  const scenarioIds = new Set(scenarios.map((s) => s.id));

  // Validate split references
  for (const [split, ids] of Object.entries(manifest.splits)) {
    if (!ids) continue;
    for (const id of ids) {
      if (!scenarioIds.has(id)) {
        errors.push(`Split "${split}" references unknown scenario "${id}"`);
      }
      if (!attackRegistry.get(id)) {
        errors.push(`Split "${split}" scenario "${id}" has no matching attack in registry`);
      }
    }
  }

  // Validate each scenario references a known attack
  for (const scenario of scenarios) {
    if (!attackRegistry.get(scenario.attackId)) {
      errors.push(`Scenario "${scenario.id}" references unknown attack "${scenario.attackId}"`);
    }
  }

  return errors;
}
