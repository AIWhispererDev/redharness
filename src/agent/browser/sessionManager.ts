/**
 * Feature 02: Browser session manager — singleton that maps run IDs to sessions.
 *
 * Provides lifecycle management: create, get, close, and cleanup-all.
 * Cleanup is deterministic and safe to call multiple times.
 */

import { BrowserSession, type BrowserSessionOptions } from './session.js';

export class BrowserSessionManager {
  private static instance: BrowserSessionManager;
  private sessions = new Map<string, BrowserSession>();

  static getInstance(): BrowserSessionManager {
    if (!BrowserSessionManager.instance) {
      BrowserSessionManager.instance = new BrowserSessionManager();
    }
    return BrowserSessionManager.instance;
  }

  /** Create a new session for a run ID. Throws if one already exists. */
  async createSession(runId: string, options: BrowserSessionOptions): Promise<BrowserSession> {
    if (this.sessions.has(runId)) {
      throw new Error(`Browser session already exists for run: ${runId}`);
    }
    const session = new BrowserSession(options);
    this.sessions.set(runId, session);
    return session;
  }

  /** Get an existing session for a run ID. */
  getSession(runId: string): BrowserSession | undefined {
    return this.sessions.get(runId);
  }

  /** Close the session for a run ID. Safe to call on nonexistent sessions. */
  async closeSession(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (session) {
      await session.close();
      this.sessions.delete(runId);
    }
  }

  /** Close all sessions (called during shutdown). */
  async closeAll(): Promise<void> {
    const runIds = Array.from(this.sessions.keys());
    await Promise.all(runIds.map((id) => this.closeSession(id)));
  }

  /** Get all active run IDs. */
  getActiveRunIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** Reset the singleton (for testing). */
  static reset(): void {
    if (BrowserSessionManager.instance) {
      BrowserSessionManager.instance.sessions.clear();
      BrowserSessionManager.instance = undefined as unknown as BrowserSessionManager;
    }
  }
}
