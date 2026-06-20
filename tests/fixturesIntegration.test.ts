/**
 * Integration tests for fixtures, datasets, graders, and scenario runner.
 *
 * These tests prove the complete pipeline:
 *   fixture app → scenario runner → grader → reliability metrics → comparison
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFixtureApp, resetState } from './fixtures/web-app/index.js';
import { createFixtureAgentApp, resetAgentState } from './fixtures/agent-app/index.js';
import { startFixtureWithHealthCheck, type FixtureHandle } from './fixtures/fixtureLifecycle.js';
import { runScenario } from '../src/scenarios/runner.js';
import { loadScenario, loadScenariosFromDir } from '../src/scenarios/loader.js';
import { graderRegistry } from '../src/graders/registry.js';
import { DeterministicGrader } from '../src/graders/deterministic.js';
import { StateDiffGrader } from '../src/graders/stateDiff.js';
import { CompositeGrader } from '../src/graders/composite.js';
import { TrajectoryGrader } from '../src/graders/trajectory.js';
import { computeReliability } from '../src/metrics/reliability.js';
import { computeDatasetHash, validateDatasetContent } from '../src/datasets/manifest.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePackDir = path.resolve(__dirname, '..', 'packs', 'fixture-web');

let fixtureV1: FixtureHandle;
let fixtureV2: FixtureHandle;
let agentFixture: FixtureHandle;

beforeAll(async () => {
  fixtureV1 = await startFixtureWithHealthCheck(() => createFixtureApp(false));
  fixtureV2 = await startFixtureWithHealthCheck(() => createFixtureApp(true));
  agentFixture = await startFixtureWithHealthCheck(() => createFixtureAgentApp(false));
}, 15000);

afterAll(async () => {
  await fixtureV1.stop();
  await fixtureV2.stop();
  await agentFixture.stop();
});

// ---------------------------------------------------------------------------
// Fixture lifecycle
// ---------------------------------------------------------------------------
describe('fixture lifecycle', () => {
  it('starts and reports healthy', () => {
    expect(fixtureV1.baseUrl).toBeTruthy();
    expect(fixtureV1.port).toBeGreaterThan(0);
  });

  it('health endpoint returns ok', async () => {
    const resp = await fetch(`${fixtureV1.baseUrl}/health`);
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.status).toBe('ok');
  });

  it('reset restores initial state', async () => {
    // Mutate state
    await fetch(`${fixtureV1.baseUrl}/api/increment`);
    await fetch(`${fixtureV1.baseUrl}/api/increment`);
    let stateResp = await fetch(`${fixtureV1.baseUrl}/state`);
    let state = await stateResp.json();
    expect(state.counter).toBe(2);

    // Reset
    await fetch(`${fixtureV1.baseUrl}/reset`, { method: 'POST' });
    stateResp = await fetch(`${fixtureV1.baseUrl}/state`);
    state = await stateResp.json();
    expect(state.counter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Dataset integrity
// ---------------------------------------------------------------------------
describe('dataset integrity', () => {
  it('validates dataset content hash', async () => {
    const scenarios = await loadScenariosFromDir(
      path.join(fixturePackDir, 'datasets', 'core'),
    );
    const manifestPath = path.join(fixturePackDir, 'datasets', 'core', 'dataset.yaml');
    const YAML = await import('yaml');
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = YAML.parse(raw);

    const errors = validateDatasetContent(manifest, scenarios);
    expect(errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
describe('scenario runner with fixtures', () => {
  it('runs public-landing scenario successfully', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'public-landing.yaml'),
    );
    const result = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV1.baseUrl,
    });

    expect(result.status).toBe('passed');
    expect(result.trials.length).toBe(1);
    expect(result.trials[0].assertions.every((a) => a.passed)).toBe(true);
  });

  it('runs auth-gate scenario against v1 (correct redirect)', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'auth-gate.yaml'),
    );
    const result = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV1.baseUrl,
    });

    expect(result.status).toBe('passed');
  });

  it('fails auth-gate scenario against v2 (regression — 403 instead of redirect)', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'auth-gate.yaml'),
    );
    const result = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV2.baseUrl,
    });

    // v2 returns 403 Access Denied instead of 401 sign-in page
    expect(result.status).toBe('failed');
  });

  it('runs state-counter scenario with state assertion', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'state-counter.yaml'),
    );
    const result = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV1.baseUrl,
    });

    expect(result.status).toBe('passed');
    expect(result.trials[0].assertions.some((a) => a.name === 'state_equals' && a.passed)).toBe(true);
  });

  it('runs multi-trial-counter with 5 trials', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'multi-trial-counter.yaml'),
    );
    const result = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV1.baseUrl,
    });

    expect(result.trials.length).toBe(5);
  });

  it('runs not-found scenario against 404 route', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'not-found.yaml'),
    );
    const result = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV1.baseUrl,
    });

    expect(result.status).toBe('passed');
  });

  it('about page shows v1 vs v2 version text', async () => {
    const scenario = await loadScenario(
      path.join(fixturePackDir, 'datasets', 'core', 'scenarios', 'about-page.yaml'),
    );

    // v1
    const resultV1 = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV1.baseUrl,
    });
    expect(resultV1.status).toBe('passed');

    // v2
    const resultV2 = await runScenario(scenario, {
      packDir: fixturePackDir,
      baseUrl: fixtureV2.baseUrl,
    });
    // v2 says "version 2" not "version 1"
    expect(resultV2.status).toBe('failed');
  });
});

// ---------------------------------------------------------------------------
// Grader tests
// ---------------------------------------------------------------------------
describe('graders', () => {
  describe('deterministic grader', () => {
    it('passes on exact match', async () => {
      const grader = new DeterministicGrader();
      const grade = await grader.grade({
        response: 'hello world',
        target: 'text',
        expected: 'hello world',
      });
      expect(grade.status).toBe('passed');
      expect(grade.score).toBe(1);
    });

    it('fails on mismatch', async () => {
      const grader = new DeterministicGrader();
      const grade = await grader.grade({
        response: 'hello',
        target: 'text',
        expected: 'world',
      });
      expect(grade.status).toBe('failed');
      expect(grade.score).toBe(0);
    });
  });

  describe('state-diff grader', () => {
    it('detects allowed state changes', async () => {
      const grader = new StateDiffGrader({ allowed: ['counter'] });
      const grade = await grader.grade({
        response: '',
        target: 'state',
        context: {
          beforeState: { counter: 0, users: ['alice'] },
          afterState: { counter: 5, users: ['alice'] },
        },
      });
      expect(grade.status).toBe('passed');
    });

    it('detects prohibited state changes', async () => {
      const grader = new StateDiffGrader({ prohibited: ['counter'] });
      const grade = await grader.grade({
        response: '',
        target: 'state',
        context: {
          beforeState: { counter: 0 },
          afterState: { counter: 5 },
        },
      });
      expect(grade.status).toBe('failed');
    });

    it('detects required changes not made', async () => {
      const grader = new StateDiffGrader({ required: ['counter'] });
      const grade = await grader.grade({
        response: '',
        target: 'state',
        context: {
          beforeState: { counter: 0 },
          afterState: { counter: 0 },
        },
      });
      expect(grade.status).toBe('failed');
      expect(grade.explanation).toContain('Required change not made');
    });

    it('detects unexpected changes', async () => {
      const grader = new StateDiffGrader({ allowed: ['name'], statePaths: [] });
      const grade = await grader.grade({
        response: '',
        target: 'state',
        context: {
          beforeState: { name: 'alice', counter: 0 },
          afterState: { name: 'alice', counter: 5 },
        },
      });
      expect(grade.status).toBe('failed');
      expect(grade.explanation).toContain('Unexpected state change');
    });
  });

  describe('trajectory grader', () => {
    it('passes when all constraints satisfied', async () => {
      const grader = new TrajectoryGrader({
        required: [{ tool: 'read_file' }, { tool: 'compute' }],
        forbidden: [{ tool: 'delete_file' }],
        maxToolCalls: 5,
      });
      const grade = await grader.grade({
        response: '',
        target: 'trajectory',
        context: { toolCalls: ['read_file', 'search', 'compute'] },
      });
      expect(grade.status).toBe('passed');
    });

    it('fails when forbidden tool used', async () => {
      const grader = new TrajectoryGrader({
        forbidden: [{ tool: 'delete_file' }],
      });
      const grade = await grader.grade({
        response: '',
        target: 'trajectory',
        context: { toolCalls: ['read_file', 'delete_file'] },
      });
      expect(grade.status).toBe('failed');
    });

    it('fails when required tool missing', async () => {
      const grader = new TrajectoryGrader({
        required: [{ tool: 'compute' }],
      });
      const grade = await grader.grade({
        response: '',
        target: 'trajectory',
        context: { toolCalls: ['read_file'] },
      });
      expect(grade.status).toBe('failed');
    });

    it('fails when max tool calls exceeded', async () => {
      const grader = new TrajectoryGrader({
        maxToolCalls: 2,
      });
      const grade = await grader.grade({
        response: '',
        target: 'trajectory',
        context: { toolCalls: ['a', 'b', 'c', 'd'] },
      });
      expect(grade.status).toBe('failed');
    });

    it('detects ordering constraint violation', async () => {
      const grader = new TrajectoryGrader({
        ordering: [{ before: 'read_file', after: 'search' }],
      });
      const grade = await grader.grade({
        response: '',
        target: 'trajectory',
        context: { toolCalls: ['search', 'read_file'] }, // read_file should be before search
      });
      expect(grade.status).toBe('failed');
    });

    it('passes when ordering is satisfied', async () => {
      const grader = new TrajectoryGrader({
        ordering: [{ before: 'search', after: 'read_file' }],
      });
      const grade = await grader.grade({
        response: '',
        target: 'trajectory',
        context: { toolCalls: ['search', 'read_file'] }, // search happens before read_file
      });
      expect(grade.status).toBe('passed');
    });
  });

  describe('composite grader', () => {
    it('passes when all sub-graders pass', async () => {
      const dg = new DeterministicGrader();
      const composite = new CompositeGrader([dg]);
      const grade = await composite.grade({
        response: 'exact match',
        target: 'text',
        expected: 'exact match',
      });
      expect(grade.status).toBe('passed');
    });

    it('fails when any sub-grader fails', async () => {
      const dg = new DeterministicGrader();
      const composite = new CompositeGrader([dg]);
      const grade = await composite.grade({
        response: 'hello',
        target: 'text',
        expected: 'world',
      });
      expect(grade.status).toBe('failed');
    });
  });

  describe('grader registry', () => {
    it('has built-in graders', () => {
      expect(graderRegistry.has('deterministic')).toBe(true);
      expect(graderRegistry.has('state-diff')).toBe(true);
      expect(graderRegistry.has('trajectory')).toBe(true);
      expect(graderRegistry.has('composite')).toBe(true);
    });

    it('creates grader instances', () => {
      const grader = graderRegistry.create('deterministic');
      expect(grader.id).toBe('deterministic');
    });

    it('throws for unknown graders', () => {
      expect(() => graderRegistry.create('nonexistent')).toThrow('Unknown grader');
    });
  });
});

// ---------------------------------------------------------------------------
// Reliability metrics
// ---------------------------------------------------------------------------
describe('reliability metrics', () => {
  it('computes success rate and pass@k', () => {
    const stats = ['passed', 'passed', 'failed', 'passed', 'passed'] as const;
    const latencies = [100, 200, 150, 180, 300];
    const report = computeReliability([...stats], latencies, 3);

    expect(report.attemptedTrials).toBe(5);
    expect(report.successCount).toBe(4);
    expect(report.successRate).toBe(0.8);
    expect(report.passAt1).toBe(0.8);
    expect(report.passAtK).toBeCloseTo(0.512, 3);
    expect(report.medianLatencyMs).toBe(180);
    expect(report.p95LatencyMs).toBeGreaterThan(0);
  });

  it('handles all-pass scenario', () => {
    const stats = ['passed', 'passed', 'passed'] as const;
    const report = computeReliability([...stats], [50, 60, 70], 3);
    expect(report.successRate).toBe(1);
    expect(report.passAtK).toBe(1);
  });

  it('separates infrastructure errors from failures', () => {
    // Infrastructure errors should be tracked separately
    const stats = ['passed', 'error', 'passed', 'passed'] as const;
    const report = computeReliability([...stats], [100, 0, 110, 120], 3);
    // error counts as attempted but not completed
    expect(report.attemptedTrials).toBe(4);
    expect(report.completedTrials).toBe(3);
    expect(report.successCount).toBe(3);
    expect(report.successRate).toBe(0.75);
  });
});

// ---------------------------------------------------------------------------
// Fixture agent app
// ---------------------------------------------------------------------------
describe('fixture agent app', () => {
  it('starts and reports healthy', async () => {
    const resp = await fetch(`${agentFixture.baseUrl}/health`);
    expect(resp.ok).toBe(true);
    const data = await resp.json();
    expect(data.status).toBe('ok');
    expect(data.mode).toBe('safe');
  });

  it('executes tool actions and tracks state', async () => {
    // Read a file
    const readResp = await fetch(`${agentFixture.baseUrl}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'read_file', args: { path: '/etc/config.json' } }),
    });
    const readData = await readResp.json();
    expect(readData.result).toContain('debug');
    expect(readData.iteration).toBe(1);

    // Write a file
    const writeResp = await fetch(`${agentFixture.baseUrl}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'write_file', args: { path: '/home/user/note.txt', content: 'hello' } }),
    });
    const writeData = await writeResp.json();
    expect(writeData.result).toContain('bytes');
    expect(writeData.iteration).toBe(2);

    // Check state has tool calls
    const stateResp = await fetch(`${agentFixture.baseUrl}/state`);
    const state = await stateResp.json();
    expect(state.toolCalls.length).toBe(2);
    expect(state.files['/home/user/note.txt']).toBe('hello');
  });

  it('blocks dangerous tools in safe mode', async () => {
    const resp = await fetch(`${agentFixture.baseUrl}/act`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'exec_command', args: { command: 'rm -rf /' } }),
    });
    expect(resp.status).toBe(403);
  });

  it('resets agent state', async () => {
    await fetch(`${agentFixture.baseUrl}/reset`, { method: 'POST' });
    const stateResp = await fetch(`${agentFixture.baseUrl}/state`);
    const state = await stateResp.json();
    expect(state.toolCalls.length).toBe(0);
    expect(state.iterations).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// All scenarios via loader
// ---------------------------------------------------------------------------
describe('all fixture-web scenarios', () => {
  it('loads all scenarios from fixture-web dataset', async () => {
    const scenarios = await loadScenariosFromDir(
      path.join(fixturePackDir, 'datasets', 'core'),
    );
    expect(scenarios.length).toBe(9);
    const ids = scenarios.map((s) => s.id).sort();
    expect(ids).toEqual([
      'about-page', 'api-users', 'auth-gate', 'form-validation',
      'multi-trial-counter', 'not-found', 'public-landing',
      'state-counter', 'state-diff-example',
    ]);
  });

  it('computes stable dataset hash', async () => {
    const scenarios = await loadScenariosFromDir(
      path.join(fixturePackDir, 'datasets', 'core'),
    );
    const hash1 = computeDatasetHash(scenarios);
    const hash2 = computeDatasetHash(scenarios);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(32);
  });
});
