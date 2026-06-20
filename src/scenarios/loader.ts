import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import type { ScenarioDefinition } from './schema.js';

/**
 * Loads scenario definitions from a dataset directory.
 *
 * Expected layout:
 *   packs/<pack-id>/datasets/<dataset-id>/
 *     dataset.yaml          (manifest — loaded separately)
 *     scenarios/
 *       <scenario-id>.yaml  (one file per scenario)
 *     fixtures/
 *     rubrics/
 */

/** Load a single scenario YAML file. */
export async function loadScenario(scenarioPath: string): Promise<ScenarioDefinition> {
  const raw = await readFile(scenarioPath, 'utf8');
  const parsed = YAML.parse(raw) as ScenarioDefinition;

  if (!parsed.id) {
    // Derive id from filename if not set in the file
    parsed.id = path.basename(scenarioPath, path.extname(scenarioPath));
  }

  return parsed;
}

/** Load all scenarios from a dataset's scenarios directory. */
export async function loadScenariosFromDir(datasetDir: string): Promise<ScenarioDefinition[]> {
  const scenariosDir = path.join(datasetDir, 'scenarios');
  const files: ScenarioDefinition[] = [];

  try {
    const entries = await readdir(scenariosDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      const scenario = await loadScenario(path.join(scenariosDir, entry.name));
      files.push(scenario);
    }
  } catch {
    // scenarios dir may not exist yet
  }

  return files;
}

/** Load the dataset manifest YAML. */
export async function loadDatasetManifest(datasetDir: string): Promise<Record<string, unknown> | null> {
  try {
    const manifestPath = path.join(datasetDir, 'dataset.yaml');
    const raw = await readFile(manifestPath, 'utf8');
    return YAML.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate a scenario definition has required fields. */
export function validateScenario(s: ScenarioDefinition): string[] {
  const errors: string[] = [];
  if (!s.id) errors.push('Scenario missing id');
  if (!s.title) errors.push('Scenario missing title');
  if (!s.target?.kind) errors.push('Scenario missing target.kind');
  if (!Array.isArray(s.steps) || s.steps.length === 0) errors.push('Scenario steps must be a non-empty array');
  if (!Array.isArray(s.expected) || s.expected.length === 0) errors.push('Scenario expected must be a non-empty array');
  if (s.setup !== undefined && !Array.isArray(s.setup)) errors.push('Scenario setup must be an array if provided');
  if (s.trials !== undefined && s.trials < 1) errors.push('trials must be >= 1');
  if (s.target.route && !s.target.route.startsWith('/')) errors.push('target.route must start with /');
  return errors;
}
