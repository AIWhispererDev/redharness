/**
 * Feature 02: Semantic locator resolution.
 *
 * Resolves semantic locator recipes into Playwright locators.
 * Prefers role/name selectors, falls back to text and testid.
 */

import type { Page } from 'playwright';

export type LocatorRecipe =
  | { role: string; name: string }
  | { text: string; exact?: boolean }
  | { testid: string }
  | { label: string };

export type ResolvedLocator = {
  recipe: LocatorRecipe;
  /** Human-readable description used in action recording. */
  description: string;
};

/**
 * Resolve a semantic locator recipe into a Playwright locator.
 *
 * Resolution order (preferred first):
 * 1. role/name — most semantic, accessible-first
 * 2. label — for form fields with aria-labels
 * 3. text — visible text content
 * 4. testid — data-testid fallback
 */
export function resolveLocator(page: Page, recipe: LocatorRecipe) {
  if ('role' in recipe) {
    return page.getByRole(recipe.role as any, { name: recipe.name });
  }
  if ('label' in recipe) {
    return page.getByLabel(recipe.label);
  }
  if ('text' in recipe) {
    return recipe.exact
      ? page.getByText(recipe.text, { exact: true })
      : page.getByText(recipe.text);
  }
  if ('testid' in recipe) {
    return page.getByTestId(recipe.testid);
  }

  throw new Error(`Unknown locator recipe: ${JSON.stringify(recipe)}`);
}

/**
 * Resolve a locator and return metadata for action recording.
 */
export function resolveLocatorForAction(
  page: Page,
  recipe: LocatorRecipe,
): { locator: ReturnType<typeof resolveLocator>; description: string } {
  const locator = resolveLocator(page, recipe);

  let description: string;
  if ('role' in recipe) {
    description = `[role=${recipe.role}, name="${recipe.name}"]`;
  } else if ('label' in recipe) {
    description = `[label="${recipe.label}"]`;
  } else if ('text' in recipe) {
    description = recipe.exact
      ? `[text exact="${recipe.text}"]`
      : `[text="${recipe.text}"]`;
  } else {
    description = `[testid="${recipe.testid}"]`;
  }

  return { locator, description };
}

/**
 * Validate a locator recipe object at the schema level.
 * Returns null if valid, or an error message.
 */
export function validateLocatorRecipe(
  value: unknown,
): LocatorRecipe | null {
  if (typeof value !== 'object' || value === null) return null;

  const obj = value as Record<string, unknown>;

  if (typeof obj.role === 'string' && typeof obj.name === 'string') {
    return { role: obj.role, name: obj.name };
  }
  if (typeof obj.text === 'string') {
    const exact = obj.exact === true;
    if (exact) {
      return { text: obj.text, exact: true };
    }
    return { text: obj.text };
  }
  if (typeof obj.testid === 'string') {
    return { testid: obj.testid };
  }
  if (typeof obj.label === 'string') {
    return { label: obj.label };
  }

  return null;
}
