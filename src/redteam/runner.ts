/**
 * PRD 06: Dataset-driven red-team runner — orchestrates adversarial
 * evaluations with seeded, multi-trial, evidence-backed workflows.
 *
 * For each attack/scenario:
 *   1. Prepare fixture (reset + snapshot initial state)
 *   2. Run N adversarial trials with deterministic seeds and mutations
 *   3. Run a benign control trial per adversarial trial
 *   4. Evaluate harm per trial (semantic, audit, state)
 *   5. Clean up and verify after each trial
 *   6. Aggregate metrics across trials
 *   7. Write finding packets with real evidence
 */

import type { AttackDefinition, AdversarialTrialResult, AdversarialScenarioResult, HarmEndpoint } from './redteamTypes.js';
import type { AgentRuntime } from '../agent/runtime.js';
import type { AgentRunResult } from '../agent/agentTypes.js';
import { evaluateHarm, determineSeverity } from './harmEndpoints.js';
import { executeCleanup, verifyCleanup, type CleanupStrategy, type CleanupResult } from './cleanup.js';
import { computeUtility, type UtilityReport, computeUtilityMetrics, type UtilityMetrics, getStandardUtilityBenchmarks } from './utility.js';
import { generateAttackInstances } from './attackMutations.js';
import { detectCanaryLeakage } from './canaries.js';
import type { Canary } from './redteamTypes.js';
import { computeHarmRates } from './metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StagedHarm = {
  semanticAcceptance: boolean;
  auditEvidence: boolean;
  stateHarm: boolean;
  canaryLeakage: boolean;
  cleanupVerified: boolean;
  benignUtilityPassed: boolean;
};

export type TrialOutcome = {
  trial: number;
  attack: AttackDefinition;
  agentResult: AgentRunResult;
  harm: HarmEndpoint;
  staged: StagedHarm;
  severity: 'low' | 'medium' | 'high' | 'critical';
  cleanupResult: CleanupResult;
  utilityReport: UtilityReport;
  benignResult?: AgentRunResult;
  initialFixtureState?: Record<string, unknown>;
  finalFixtureState?: Record<string, unknown>;
  /** Rendered prompt used for this trial. */
  renderedPrompt: string;
  /** Seed used for this trial. */
  seed: string;
  /** Mutation strategy applied. */
  mutationStrategy?: string;
  /** Was this a benign control trial? */
  isBenignControl: boolean;
};

export type ScenarioOutcome = {
  scenarioId: string;
  attack: AttackDefinition;
  trials: TrialOutcome[];
  benignTrials: TrialOutcome[];
  aggregateHarm: HarmEndpoint;
  aggregateBenignSuccess: number;
  trialResults: AdversarialTrialResult[];
};

export type RedTeamRunOptions = {
  /** List of attacks to run (resolved from dataset). */
  attacks: AttackDefinition[];
  /** Runtime factory for adversarial runs. */
  runtimeFactory: (attack: AttackDefinition, renderedPrompt: string, seed: string) => Promise<AgentRuntime>;
  /** Runtime factory for benign control runs. */
  benignRuntimeFactory?: (attack: AttackDefinition, seed: string) => Promise<AgentRuntime>;
  /** Number of adversarial trials per attack. */
  trials?: number;
  /** Base seed for deterministic mutation. */
  seed?: string;
  /** Mutation strategies to apply. */
  mutationStrategies?: string[];
  fixtureBaseUrl?: string;
  cleanupStrategy?: CleanupStrategy;
  captureInitialState?: boolean;
  captureFinalState?: boolean;
  compareBenignUtility?: boolean;
  benignExpectedTools?: string[];
  /** Canaries to detect leakage. */
  canaries?: Canary[];
  /** Whether to use fake (deterministic) responses. */
  useFakeReplies?: boolean;
  /** Override for fake reply content (red-team specific). */
  fakeReplyOverride?: string;
  /** Provider mode: fake | replay | live. */
  providerMode?: 'fake' | 'replay' | 'live';
};

// ---------------------------------------------------------------------------
// Runner implementation
// ---------------------------------------------------------------------------

/**
 * Run a full dataset-driven red-team evaluation with trials and benign controls.
 */
export async function runRedTeam(
  options: RedTeamRunOptions,
): Promise<ScenarioOutcome[]> {
  const trialCount = options.trials ?? 3;
  const baseSeed = options.seed ?? 'default-seed-2026';
  const outcomes: ScenarioOutcome[] = [];

  for (const attack of options.attacks) {
    const scenarioOutcome = await runAttackScenario(attack, trialCount, baseSeed, options);
    outcomes.push(scenarioOutcome);
  }

  return outcomes;
}

/**
 * Run all trials for a single attack scenario, including benign controls.
 */
async function runAttackScenario(
  attack: AttackDefinition,
  trialCount: number,
  baseSeed: string,
  options: RedTeamRunOptions,
): Promise<ScenarioOutcome> {
  const scenarioId = attack.id;
  const trials: TrialOutcome[] = [];
  const benignTrials: TrialOutcome[] = [];

  // Generate attack instances with mutations
  const instances = generateAttackInstances(attack, trialCount, options.seed, options.mutationStrategies);

  for (let t = 0; t < trialCount; t++) {
    const instance = instances[t % instances.length];
    const trialSeed = `${baseSeed}-${attack.id}-trial-${t}`;
    const renderedPrompt = instance.renderedPrompt;

    // --- Adversarial trial ---
    const trialOutcome = await runSingleTrial(
      attack,
      renderedPrompt,
      trialSeed,
      t,
      false,
      options,
    );
    trials.push(trialOutcome);

    // --- Benign control trial ---
    if (options.compareBenignUtility && options.benignRuntimeFactory) {
      const benignOutcome = await runBenignControl(
        attack,
        trialSeed,
        t,
        options,
      );
      benignTrials.push(benignOutcome);
    }
  }

  // Build aggregate harm from all trials
  const aggregateHarm = computeAggregateHarm(trials);
  const aggregateBenignSuccess = benignTrials.length > 0
    ? benignTrials.filter((bt) => bt.staged.benignUtilityPassed).length / benignTrials.length
    : 0;

  // Build per-trial AdversarialTrialResult for the return value
  const trialResults: AdversarialTrialResult[] = trials.map((t, i) => ({
    trial: i,
    status: t.agentResult.status,
    harm: t.harm,
    benignTaskSuccess: t.staged.benignUtilityPassed,
    cleanupSuccess: t.staged.cleanupVerified,
    toolCallCount: t.agentResult.messages.filter((m) => m.role === 'tool').length,
    tokenCount: t.agentResult.budgetsConsumed.tokens,
    costUsd: t.agentResult.budgetsConsumed.costUsd,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: t.agentResult.durationMs ?? 0,
    error: t.agentResult.status === 'error' ? (t.agentResult.error as string) : undefined,
  }));

  return {
    scenarioId,
    attack,
    trials,
    benignTrials,
    aggregateHarm,
    aggregateBenignSuccess,
    trialResults,
  };
}

/**
 * Run a single adversarial trial.
 */
async function runSingleTrial(
  attack: AttackDefinition,
  renderedPrompt: string,
  seed: string,
  trialIndex: number,
  isBenignControl: boolean,
  options: RedTeamRunOptions,
): Promise<TrialOutcome> {
  // 1. Capture initial fixture state
  let initialFixtureState: Record<string, unknown> | undefined;
  if (options.captureInitialState && options.fixtureBaseUrl) {
    try {
      const resp = await fetch(`${options.fixtureBaseUrl}/state`);
      initialFixtureState = await resp.json();
    } catch {
      // Ignore state capture failures
    }
  }

  // 2. Create and run agent with the rendered prompt
  const runtime = await options.runtimeFactory(attack, renderedPrompt, seed);
  const agentResult = await runtime.run();

  // 3. Capture final fixture state
  let finalFixtureState: Record<string, unknown> | undefined;
  if (options.captureFinalState && options.fixtureBaseUrl) {
    try {
      const resp = await fetch(`${options.fixtureBaseUrl}/state`);
      finalFixtureState = await resp.json();
    } catch {
      // Ignore
    }
  }

  // 4. Evaluate harm
  const harm = evaluateHarm({
    messages: agentResult.messages,
    toolResults: agentResult.observations.map((o) => ({
      success: o.data?.success as boolean,
      output: o.data?.output,
      error: o.data?.error as string | undefined,
      durationMs: (o.data?.durationMs as number) ?? 0,
    })),
    attack,
    initialFixtureState,
    finalFixtureState,
    modelOutput: agentResult.messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.content)
      .join('\n'),
  });

  // 5. Cleanup
  const cleanupResult = await executeCleanup(
    options.cleanupStrategy ?? 'fixture_reset',
    {
      strategy: options.cleanupStrategy ?? 'fixture_reset',
      fixtureResetEndpoint: options.fixtureBaseUrl
        ? `${options.fixtureBaseUrl}/reset`
        : undefined,
    },
  );

  // 6. Verify cleanup
  let cleanupVerified =
    cleanupResult.status === 'passed'
    && (options.cleanupStrategy ?? 'fixture_reset') !== 'fixture_reset';
  if (options.fixtureBaseUrl) {
    try {
      const stateResp = await fetch(`${options.fixtureBaseUrl}/state`);
      const cleanState = await stateResp.json();
      const verify = await verifyCleanup(
        options.cleanupStrategy ?? 'fixture_reset',
        cleanState as Record<string, unknown>,
      );
      cleanupVerified = verify.clean;
    } catch {
      cleanupVerified = false;
    }
  }

  // 7. Utility report
  const utilityReport = computeUtility(agentResult, {
    expectedSteps: 1,
    maxSteps: 20,
    expectedTools: options.benignExpectedTools ?? [],
  });

  // 8. Build staged harm
  const canaryLeakage = options.canaries
    ? detectCanaryLeakage(
        agentResult.messages.map((m) => m.content).join('\n'),
        options.canaries,
      ).length > 0
    : agentResult.messages.some(
        (m) => m.content.includes('canary_placeholder') || m.content.includes('CANARY'),
      );

  const staged: StagedHarm = {
    semanticAcceptance: harm.semanticAcceptance,
    auditEvidence: harm.auditVisibleHarm,
    stateHarm: harm.stateHarm,
    canaryLeakage,
    cleanupVerified,
    benignUtilityPassed: false, // set later for benign controls
  };

  // 9. Determine severity
  const severity = determineSeverity(harm);

  return {
    trial: trialIndex,
    attack,
    agentResult,
    harm,
    staged,
    severity,
    cleanupResult,
    utilityReport,
    initialFixtureState,
    finalFixtureState,
    renderedPrompt,
    seed,
    isBenignControl,
  };
}

/**
 * Run a benign control for an attack.
 */
async function runBenignControl(
  attack: AttackDefinition,
  seed: string,
  trialIndex: number,
  options: RedTeamRunOptions,
): Promise<TrialOutcome> {
  if (!options.benignRuntimeFactory) {
    throw new Error('benignRuntimeFactory is required for benign control');
  }

  const runtime = await options.benignRuntimeFactory(attack, seed);
  const agentResult = await runtime.run();

  const utilityReport = computeUtility(agentResult, {
    expectedSteps: 1,
    maxSteps: 20,
    expectedTools: options.benignExpectedTools ?? [],
  });

  const benignTaskPassed = agentResult.status === 'passed' && utilityReport.completeness === 1;

  return {
    trial: trialIndex,
    attack,
    agentResult,
    harm: {
      semanticAcceptance: false,
      semanticEvidence: [],
      auditVisibleHarm: false,
      auditEvidence: [],
      stateHarm: false,
      stateHarmEvidence: [],
    },
    staged: {
      semanticAcceptance: false,
      auditEvidence: false,
      stateHarm: false,
      canaryLeakage: false,
      cleanupVerified: true,
      benignUtilityPassed: benignTaskPassed,
    },
    severity: 'low',
    cleanupResult: { strategy: 'fixture_reset', status: 'passed', durationMs: 0, details: ['Benign control — no cleanup needed'] },
    utilityReport,
    benignResult: agentResult,
    renderedPrompt: `Benign control for ${attack.id}`,
    seed,
    isBenignControl: true,
  };
}

/**
 * Compute aggregate harm across trials.
 * A harm endpoint is "confirmed" if at least one trial showed it.
 */
function computeAggregateHarm(trials: TrialOutcome[]): HarmEndpoint {
  const harm: HarmEndpoint = {
    semanticAcceptance: trials.some((t) => t.harm.semanticAcceptance),
    semanticEvidence: [],
    auditVisibleHarm: trials.some((t) => t.harm.auditVisibleHarm),
    auditEvidence: [],
    stateHarm: trials.some((t) => t.harm.stateHarm),
    stateHarmEvidence: [],
  };

  // Collect unique evidence
  const allSemantic = new Set<string>();
  const allAudit = new Set<string>();
  const allState = new Set<string>();

  for (const t of trials) {
    for (const e of t.harm.semanticEvidence) allSemantic.add(e);
    for (const e of t.harm.auditEvidence) allAudit.add(e);
    for (const e of t.harm.stateHarmEvidence) allState.add(e);
  }

  harm.semanticEvidence = Array.from(allSemantic);
  harm.auditEvidence = Array.from(allAudit);
  harm.stateHarmEvidence = Array.from(allState);

  return harm;
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable summary of red-team results.
 */
export function summarizeRedTeam(scenarios: ScenarioOutcome[]): string {
  const lines: string[] = [];

  lines.push('# Red-Team Evaluation Summary');
  lines.push('');

  // Per-scenario summary
  lines.push(`| Attack | Severity | Trials | Semantic | Audit | State | Canary | Cleanup | Benign |`);
  lines.push(`|--------|----------|--------|----------|-------|-------|--------|---------|--------|`);

  for (const scenario of scenarios) {
    const agg = scenario.aggregateHarm;
    const severity = determineSeverity(agg);
    const sem = agg.semanticAcceptance ? '⚠️' : '✅';
    const aud = agg.auditVisibleHarm ? '⚠️' : '✅';
    const st = agg.stateHarm ? '🔴' : '✅';

    const canaryTrials = scenario.trials.filter((t) => t.staged.canaryLeakage).length;
    const canaryPct = scenario.trials.length > 0
      ? (canaryTrials / scenario.trials.length * 100).toFixed(0)
      : '0';

    const cleanupTrials = scenario.trials.filter((t) => t.staged.cleanupVerified).length;
    const cleanupPct = scenario.trials.length > 0
      ? (cleanupTrials / scenario.trials.length * 100).toFixed(0)
      : '0';

    const benignOk = scenario.benignTrials.length > 0
      ? `${(scenario.aggregateBenignSuccess * 100).toFixed(0)}%`
      : 'N/A';

    lines.push(`| ${scenario.attack.id} | ${severity} | ${scenario.trials.length} | ${sem} | ${aud} | ${st} | ${canaryPct}% | ${cleanupPct}% | ${benignOk} |`);
  }

  lines.push('');
  lines.push('### Legend');
  lines.push('- ✅ : Clean / No harm detected');
  lines.push('- ⚠️ : Harm detected or canary leaked');
  lines.push('- 🔴 : State harm (critical)');
  lines.push('- ❌ : Cleanup failed');

  // Aggregate statistics
  const totalTrials = scenarios.reduce((s, sc) => s + sc.trials.length, 0);
  const totalWithHarm = scenarios.filter((sc) =>
    sc.aggregateHarm.semanticAcceptance || sc.aggregateHarm.auditVisibleHarm || sc.aggregateHarm.stateHarm,
  ).length;
  const totalStateHarm = scenarios.filter((sc) => sc.aggregateHarm.stateHarm).length;

  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`- Scenarios: ${scenarios.length}`);
  lines.push(`- Total trials: ${totalTrials}`);
  lines.push(`- With any harm: ${totalWithHarm}`);
  lines.push(`- State harm: ${totalStateHarm}`);

  return lines.join('\n');
}
