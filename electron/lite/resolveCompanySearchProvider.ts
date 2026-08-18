/**
 * Lite CN build-time replacement for the premium company-search resolver.
 *
 * The Lite flavor intentionally excludes the private premium submodule and its
 * Tavily/Natively search providers. Returning null preserves the upstream
 * resolver contract: callers fall back to their existing LLM-only path instead
 * of trying to load premium search code at runtime.
 */
export function resolveCompanySearchProvider(): null {
  return null;
}
