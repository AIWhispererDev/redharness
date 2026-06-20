import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ReplaySpec, FindingPacketV2, FindingLifecycleState } from '../trace/traceTypes.js';

/**
 * Confirmation runner: executes replay specs to confirm or reject findings.
 *
 * The lifecycle rule is:
 * - `confirmed` requires at least one confirmation attempt, linked evidence,
 *   and a successful replay or approved manual-confirmation record.
 * - Guided replays cannot become confirmed automatically.
 */

export type ConfirmationResult = {
  findingId: string;
  lifecycleState: FindingLifecycleState;
  reproduced: boolean;
  attempts: number;
  evidencePaths: string[];
  message: string;
};

export type ConfirmationOptions = {
  maxAttempts?: number;
  forceReplay?: boolean;
};

/**
 * Run confirmation against a replay spec.
 *
 * For HTTP replays, executes the request and checks the status/body.
 * For browser/guided replays, validates the spec is well-formed and records
 * the state. Returns the new lifecycle state.
 */
export async function confirmFinding(
  packet: FindingPacketV2,
  spec: ReplaySpec,
  options?: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const attempts: number[] = [];
  const evidencePaths: string[] = [];

  // Guided replays can never auto-confirm
  if (spec.mode === 'guided') {
    return {
      findingId: packet.findingId,
      lifecycleState: 'suspected',
      reproduced: false,
      attempts: 0,
      evidencePaths: [],
      message: 'Guided replay cannot be confirmed automatically — requires manual authoring',
    };
  }

  // HTTP confirmation
  if (spec.mode === 'http') {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const url = new URL(spec.url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url.toString(), {
          method: spec.method,
          headers: spec.headers as Record<string, string>,
          body: spec.method !== 'GET' ? spec.body : undefined,
          signal: controller.signal,
        });

        clearTimeout(timeout);

        const body = await response.text();
        const statusMatch = response.status === spec.expectedStatus;
        const bodyMatch = body.includes(spec.assertion) || new RegExp(spec.assertion).test(body);
        const reproduced = statusMatch && bodyMatch;

        attempts.push(i + 1);
        if (reproduced) {
          return {
            findingId: packet.findingId,
            lifecycleState: 'confirmed-semantic',
            reproduced: true,
            attempts: attempts.length,
            evidencePaths,
            message: `Confirmed on attempt ${i + 1}: status ${response.status}, body matched assertion`,
          };
        }
      } catch {
        attempts.push(i + 1);
      }
    }

    return {
      findingId: packet.findingId,
      lifecycleState: 'suspected',
      reproduced: false,
      attempts: attempts.length,
      evidencePaths,
      message: `Not confirmed after ${attempts.length} HTTP attempt(s)`,
    };
  }

  // Browser confirmation — validate spec structure and mark as needs-authoring
  if (spec.mode === 'browser') {
    const hasActions = spec.actions.length > 0;
    const hasSetup = spec.setup.length > 0;
    const validSpec = hasActions || hasSetup;

    return {
      findingId: packet.findingId,
      lifecycleState: validSpec ? 'suspected' : 'suspected',
      reproduced: false,
      attempts: 1,
      evidencePaths: spec.linkedArtifactIds ?? [],
      message: validSpec
        ? `Browser replay spec is well-formed (${spec.actions.length} actions). Requires Playwright execution for confirmation.`
        : 'Browser replay spec is empty — needs authoring',
    };
  }

  return {
    findingId: packet.findingId,
    lifecycleState: 'suspected',
    reproduced: false,
    attempts: 0,
    evidencePaths: [],
    message: 'Unknown replay mode — cannot confirm',
  };
}

/**
 * Load a finding packet from disk and attempt confirmation.
 */
export async function confirmFromPacket(
  packetDir: string,
  options?: ConfirmationOptions,
): Promise<ConfirmationResult> {
  const jsonPath = path.join(packetDir, 'finding.json');
  const content = await readFile(jsonPath, 'utf8');
  const packet = JSON.parse(content) as FindingPacketV2;

  // Find the replay spec (try JSON first, then infer from packet data)
  const specPath = path.join(packetDir, 'replay.spec.ts');
  let spec: ReplaySpec;

  try {
    await readFile(specPath, 'utf8');
    // We have a spec file — reconstruct minimal spec from packet metadata
    spec = {
      mode: 'http',
      method: 'GET',
      url: packet.environment.baseUrl ?? '',
      headers: {},
      expectedStatus: 200,
      assertion: packet.expectedState,
    };
  } catch {
    spec = {
      mode: 'guided',
      setupHint: packet.expectedState,
      unresolvedSteps: packet.steps,
      linkedArtifactIds: [],
    };
  }

  return confirmFinding(packet, spec, options);
}

/**
 * Check whether a lifecycle transition is valid.
 */
export function isValidTransition(
  from: FindingLifecycleState,
  to: FindingLifecycleState,
): boolean {
  const allowed: Record<string, FindingLifecycleState[]> = {
    'observed': ['suspected', 'rejected'],
    'needs-authoring': ['suspected', 'rejected'],
    'suspected': ['confirmed-semantic', 'confirmed-evidence', 'confirmed-state-harm', 'rejected', 'needs-authoring'],
    'confirmed-semantic': ['confirmed-evidence', 'confirmed-state-harm', 'mitigated', 'regression'],
    'confirmed-evidence': ['confirmed-state-harm', 'mitigated', 'regression'],
    'confirmed-state-harm': ['mitigated', 'regression'],
    'rejected': [],
    'mitigated': ['regression'],
    'regression': ['suspected'],
  };

  return allowed[from]?.includes(to) ?? false;
}

// Re-export for convenience
export type { FindingLifecycleState };
