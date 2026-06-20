/**
 * Execution status model for the QA harness.
 *
 * Every suite, scenario, attempt, check, and grader uses these five statuses.
 * `ok: boolean` is a derived compatibility field, not authoritative.
 */
export type ExecutionStatus = 'passed' | 'failed' | 'skipped' | 'error' | 'cancelled';

/** Ordered precedence for rollup: lower index wins as the worst status. */
const STATUS_ORDER: Record<ExecutionStatus, number> = {
  cancelled: 0,
  error: 1,
  failed: 2,
  skipped: 3,
  passed: 4,
};

/** Compare two statuses. Returns negative if a is worse, positive if a is better, 0 if equal. */
export function compareStatus(a: ExecutionStatus, b: ExecutionStatus): number {
  return STATUS_ORDER[a] - STATUS_ORDER[b];
}

/** Return the worse (lower precedence) of two statuses. */
export function worseStatus(a: ExecutionStatus, b: ExecutionStatus): ExecutionStatus {
  return compareStatus(a, b) <= 0 ? a : b;
}

/** Aggregate multiple statuses into one worst-status rollup. */
export function aggregateStatus(statuses: ExecutionStatus[]): ExecutionStatus {
  return statuses.reduce((worst, current) => worseStatus(worst, current), 'passed');
}

/** Map a traditional `ok: boolean` + `skipped: boolean` to ExecutionStatus. */
export function fromOkSkipped(ok: boolean, skipped?: boolean): ExecutionStatus {
  if (skipped) return 'skipped';
  if (!ok) return 'failed';
  return 'passed';
}

/** Convert ExecutionStatus to a human-readable label. */
export function statusLabel(status: ExecutionStatus): string {
  const labels: Record<ExecutionStatus, string> = {
    passed: 'Passed',
    failed: 'Failed',
    skipped: 'Skipped',
    error: 'Error',
    cancelled: 'Cancelled',
  };
  return labels[status];
}

/** Derive a backward-compatible `ok` value from a status. */
export function statusToOk(status: ExecutionStatus): boolean {
  return status === 'passed' || status === 'skipped';
}
