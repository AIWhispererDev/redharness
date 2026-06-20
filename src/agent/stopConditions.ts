/**
 * PRD 04: Stop conditions — loop/stall detection, repeated action detection,
 * and cancellation enforcement.
 *
 * These are mandatory safety controls that run alongside budget checks.
 */

export type StopConditionCheck = {
  shouldStop: boolean;
  reason?: string;
};

/**
 * Detects repeated identical actions — configurable threshold.
 * Helps prevent infinite loops of the same tool call.
 */
export class RepeatedActionDetector {
  private actionHistory: Array<{ name: string; hash: string }> = [];
  private maxRepeats: number;
  private windowSize: number;

  constructor(maxRepeats: number = 3, windowSize: number = 10) {
    this.maxRepeats = maxRepeats;
    this.windowSize = windowSize;
  }

  /** Record a tool call and check for repeats. */
  recordAndCheck(toolName: string, args: Record<string, unknown>): StopConditionCheck {
    const hash = JSON.stringify({ toolName, args });
    this.actionHistory.push({ name: toolName, hash });

    // Only check within the sliding window
    const window = this.actionHistory.slice(-this.windowSize);

    // Count exact matches
    const matchCount = window.filter((a) => a.hash === hash).length;

    if (matchCount >= this.maxRepeats) {
      return {
        shouldStop: true,
        reason: `Repeated identical action detected: ${toolName} called ${matchCount}x in last ${Math.min(this.windowSize, window.length)} actions`,
      };
    }

    return { shouldStop: false };
  }

  /** Reset detector (for checkpoint resume). */
  reset(): void {
    this.actionHistory = [];
  }
}

/**
 * Detects action loops — alternation between two states.
 */
export class LoopDetector {
  private actionNames: string[] = [];
  private maxPatternLength: number;
  private minRepetitions: number;

  constructor(maxPatternLength: number = 3, minRepetitions: number = 3) {
    this.maxPatternLength = maxPatternLength;
    this.minRepetitions = minRepetitions;
  }

  /** Record an action and check for loops. */
  recordAndCheck(toolName: string): StopConditionCheck {
    this.actionNames.push(toolName);

    if (this.actionNames.length < this.maxPatternLength * this.minRepetitions) {
      return { shouldStop: false };
    }

    // Check for repeating patterns
    for (let patternLen = 1; patternLen <= this.maxPatternLength; patternLen++) {
      const recent = this.actionNames.slice(-patternLen * this.minRepetitions);
      if (recent.length < patternLen * this.minRepetitions) continue;

      let isPattern = true;
      const pattern = recent.slice(0, patternLen);
      for (let i = 0; i < this.minRepetitions; i++) {
        for (let j = 0; j < patternLen; j++) {
          const idx = i * patternLen + j;
          if (recent[idx] !== pattern[j]) {
            isPattern = false;
            break;
          }
        }
        if (!isPattern) break;
      }

      if (isPattern) {
        return {
          shouldStop: true,
          reason: `Action loop detected: pattern [${pattern.join(', ')}] repeated ${this.minRepetitions}x`,
        };
      }
    }

    return { shouldStop: false };
  }

  /** Reset detector. */
  reset(): void {
    this.actionNames = [];
  }
}

/**
 * Stall detector — triggers if no measurable progress after N turns.
 */
export class StallDetector {
  private maxStalledTurns: number;
  private lastDistinctActionTurn: number = 0;
  private distinctActionCount: number = 0;
  private currentTurn: number = 0;

  constructor(maxStalledTurns: number = 5) {
    this.maxStalledTurns = maxStalledTurns;
  }

  /** Record a turn. Call recordDistinctAction when a meaningful change happens. */
  recordTurn(): void {
    this.currentTurn++;
  }

  /** Record a distinct action that represents progress. */
  recordDistinctAction(): void {
    this.lastDistinctActionTurn = this.currentTurn;
    this.distinctActionCount++;
  }

  /** Check if stalled. */
  check(): StopConditionCheck {
    const turnsSinceProgress = this.currentTurn - this.lastDistinctActionTurn;
    if (turnsSinceProgress >= this.maxStalledTurns && this.currentTurn > 0) {
      return {
        shouldStop: true,
        reason: `Stall detected: ${turnsSinceProgress} turns without progress (max: ${this.maxStalledTurns})`,
      };
    }
    return { shouldStop: false };
  }

  /** Get total distinct actions. */
  getDistinctActionCount(): number {
    return this.distinctActionCount;
  }

  /** Reset. */
  reset(): void {
    this.lastDistinctActionTurn = 0;
    this.distinctActionCount = 0;
    this.currentTurn = 0;
  }
}
