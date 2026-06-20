import type { SuiteDefinition, RunSelection, ProfileDefinition } from './runTypes.js';

class SuiteRegistry {
  private suites = new Map<string, SuiteDefinition>();

  /** Register a suite definition. Throws on duplicate id. */
  register(def: SuiteDefinition): void {
    if (this.suites.has(def.id)) {
      throw new Error(`Duplicate suite id: ${def.id}`);
    }
    this.suites.set(def.id, def);
  }

  /** Register multiple suite definitions. */
  registerAll(defs: SuiteDefinition[]): void {
    for (const def of defs) {
      this.register(def);
    }
  }

  /** Get a single suite by id. Returns undefined if not found. */
  get(id: string): SuiteDefinition | undefined {
    return this.suites.get(id);
  }

  /** Get all registered suite definitions. */
  getAll(): SuiteDefinition[] {
    return Array.from(this.suites.values());
  }

  /** Get all suite ids. */
  getIds(): string[] {
    return Array.from(this.suites.keys());
  }

  /**
   * Select suites based on selection criteria.
   *
   * - If suites[] is non-empty, only those ids are used (tag filtering still applies).
   *   Unknown IDs cause an error — silent empty selections are not allowed.
   * - If tags[] is non-empty, only suites with at least one matching tag are included.
   * - excludedTags[] removes any suite with a matching tag.
   * - If both suites[] and tags[] are empty, returns all suites.
   */
  select(selection: RunSelection): SuiteDefinition[] {
    let candidates = this.getAll();

    if (selection.suites.length > 0) {
      const suiteSet = new Set(selection.suites);
      const unknown = selection.suites.filter((id) => !this.suites.has(id));
      if (unknown.length > 0) {
        throw new Error(
          `Unknown suite ID(s): ${unknown.join(', ')}. Available: ${this.getIds().join(', ')}`,
        );
      }
      candidates = candidates.filter((s) => suiteSet.has(s.id));
    }

    if (selection.tags.length > 0) {
      const tagSet = new Set(selection.tags.map((t) => t.toLowerCase()));
      candidates = candidates.filter((s) => s.tags.some((t) => tagSet.has(t.toLowerCase())));
    }

    if (selection.excludedTags.length > 0) {
      const excludeSet = new Set(selection.excludedTags.map((t) => t.toLowerCase()));
      candidates = candidates.filter((s) => !s.tags.some((t) => excludeSet.has(t.toLowerCase())));
    }

    // Reject empty selection after ALL filtering (including tags/exclusions)
    if (candidates.length === 0 && (selection.tags.length > 0 || selection.suites.length > 0)) {
      throw new Error(
        `No suites match the combined selection criteria.` +
        (selection.tags.length > 0 ? ` Tags: ${selection.tags.join(', ')}.` : '') +
        (selection.suites.length > 0 ? ` Suites: ${selection.suites.join(', ')}.` : '') +
        (selection.excludedTags.length > 0 ? ` Excluded tags: ${selection.excludedTags.join(', ')}.` : '') +
        ` Available suites: ${this.getIds().join(', ')}`,
      );
    }

    return candidates;
  }

  /**
   * Select suites based on a profile definition.
   * Applies includeTags inclusion and excludeTags filtering.
   */
  selectByProfile(
    profile: ProfileDefinition,
    explicitSuites?: string[],
  ): SuiteDefinition[] {
    return this.select({
      suites: explicitSuites ?? [],
      tags: profile.includeTags,
      excludedTags: profile.excludeTags ?? [],
    });
  }

  /**
   * Topological sort of selected suites by dependencies.
   * Throws on circular dependencies or missing dependency ids.
   */
  resolveOrder(selected: SuiteDefinition[]): SuiteDefinition[] {
    const allDefs = new Map(this.suites);
    const selectedIds = new Set(selected.map((s) => s.id));
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const ordered: SuiteDefinition[] = [];

    function visit(id: string, path: string[]): void {
      if (inStack.has(id)) {
        throw new Error(
          `Circular dependency detected: ${[...path, id].join(' -> ')}`,
        );
      }
      if (visited.has(id)) return;
      visited.add(id);

      const def = allDefs.get(id);
      if (!def) {
        throw new Error(`Suite "${id}" has dependency on unknown suite "${id}"`);
      }

      if (def.dependencies) {
        for (const depId of def.dependencies) {
          // Only enforce ordering for also-selected dependencies
          if (selectedIds.has(depId)) {
            inStack.add(id);
            visit(depId, [...path, id]);
            inStack.delete(id);
          }
        }
      }

      ordered.push(def);
    }

    for (const def of selected) {
      visit(def.id, []);
    }

    return ordered;
  }

  /** Check that all dependency references point to registered suites. */
  validateDependencies(): string[] {
    const errors: string[] = [];
    for (const [, def] of this.suites) {
      for (const depId of def.dependencies ?? []) {
        if (!this.suites.has(depId)) {
          errors.push(`Suite "${def.id}" depends on unknown suite "${depId}"`);
        }
      }
    }
    return errors;
  }
}

/** Singleton registry instance. */
export const registry = new SuiteRegistry();
