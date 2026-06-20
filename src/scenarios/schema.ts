/**
 * PRD 03: Declarative scenario schema and action types.
 *
 * A scenario describes intent and success criteria; the runner supplies
 * execution mechanics. Each scenario lives under packs/<id>/datasets/<ds>/.
 */

/** Prerequisite profile requirement. */
export type AuthProfile = 'none' | 'pro' | 'solo' | 'non-pro';

/** A single scripted action step. */
export type ScenarioAction =
  | { action: 'goto'; url: string }
  | { action: 'click'; role?: string; name?: string; selector?: string }
  | { action: 'fill'; selector: string; value: string; secret?: boolean }
  | { action: 'send_message'; value: string }
  | { action: 'press'; key: string }
  | { action: 'reload' }
  | { action: 'wait'; ms: number }
  | { action: 'wait_for_selector'; selector: string; timeoutMs?: number }
  | { action: 'capture'; as: string; selector?: string }
  | { action: 'dismiss_if_visible'; role: string; name: string }
  | { action: 'assert_visible'; role?: string; name?: string; selector?: string }
  | { action: 'assert_text'; selector?: string; value: string }
  | { action: 'assert_url'; pattern: string }
  | { action: 'screenshot'; name: string };

/** An assertion that can be checked. */
export type ScenarioAssertion =
  | { assertion: 'page_contains_capture'; capture: string }
  | { assertion: 'url_matches'; pattern: string }
  | { assertion: 'element_visible'; role?: string; name?: string; selector?: string }
  | { assertion: 'text_present'; text: string }
  | { assertion: 'state_equals'; path: string; expected: unknown };

/** Trajectory constraints. */
export type TrajectoryConstraint = {
  required?: Array<{ tool: string }>;
  forbidden?: Array<{ tool: string }>;
  ordering?: Array<{ before: string; after: string }>;
  maxToolCalls?: number;
  allowEquivalentPaths?: boolean;
};

/** A grader reference within a scenario. */
export type ScenarioGrader = {
  id: string;
  type: 'deterministic' | 'rule-set' | 'state-diff' | 'trajectory' | 'rubric' | 'pairwise';
  target?: string;
  rubricId?: string;
};

/** Complete scenario definition. */
export interface ScenarioDefinition {
  id: string;
  version: number;
  title: string;
  description?: string;
  tags: string[];
  target: {
    kind: 'browser' | 'http' | 'fixture';
    route?: string;
  };
  prerequisites?: {
    authProfile?: AuthProfile;
    requires?: string[];
  };
  setup: ScenarioAction[];
  actor: {
    kind: 'scripted' | 'fixture' | 'human' | 'model-simulated-user';
  };
  steps: ScenarioAction[];
  expected: ScenarioAssertion[];
  graders?: ScenarioGrader[];
  trajectory?: TrajectoryConstraint;
  trials?: number;
  budgets?: {
    wallTimeMs?: number;
    perStepMs?: number;
  };
  cleanup?: {
    strategy: 'reset-session' | 'navigate-home' | 'none';
  };
}
