/** Managed route discovery policy shared by product-owned provider profiles. */

/**
 * Return a normalized endpoint for exact route comparisons.
 * @param value - configured endpoint URL.
 * @returns URL without trailing slash.
 */
export function normalizeManagedEndpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('managed provider endpoint must be HTTP(S) without credentials, query parameters, or fragments')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  return url.toString().replace(/\/$/, '')
}

/**
 * Reject a draft endpoint that would reuse a managed route credential elsewhere.
 * @param provider - configured route id.
 * @param configuredEndpoint - endpoint allowed for the route.
 * @param draftEndpoint - endpoint supplied by the current discovery draft.
 * @throws Error when the draft endpoint is not the managed endpoint.
 */
export function assertManagedDiscoveryEndpoint(
  provider: string,
  configuredEndpoint: string,
  draftEndpoint: string | undefined,
): void {
  if (draftEndpoint === undefined) return
  let configured: string
  let draft: string
  try {
    configured = normalizeManagedEndpoint(configuredEndpoint)
    draft = normalizeManagedEndpoint(draftEndpoint)
  } catch (error: unknown) {
    throw new Error(
      `llm-pi-ai: managed provider route "${provider}" requires its configured endpoint for model discovery`,
      { cause: error },
    )
  }
  if (configured !== draft) {
    throw new Error(
      `llm-pi-ai: managed provider route "${provider}" cannot discover models at a different endpoint`,
    )
  }
}

/**
 * Bind stored credentials to an exact configured endpoint, not just its origin.
 * @param configuredEndpoint - endpoint captured by the host profile.
 * @param draftEndpoint - endpoint supplied by the configuration draft.
 * @returns false for missing, malformed, or different endpoints.
 */
export function sameManagedEndpoint(configuredEndpoint: string | undefined, draftEndpoint: string): boolean {
  if (configuredEndpoint === undefined) return false
  try {
    return normalizeManagedEndpoint(configuredEndpoint) === normalizeManagedEndpoint(draftEndpoint)
  } catch (_error: unknown) {
    // An invalid endpoint must not authorize credential resolution.
    return false
  }
}

/**
 * Keep managed routes and their effective endpoint bound to host composition.
 * @param providers - resolved profiles from native settings.
 * @param authority - composition profiles, never a caller's settings payload.
 * @throws Error when a settings layer creates, removes, or retargets a managed route.
 */
export function assertManagedProfileAuthority(
  providers: Readonly<Record<string, { baseURL?: string; managedBaseURL?: string }>> | undefined,
  authority: Readonly<Record<string, { baseURL?: string; managedBaseURL?: string }>> | undefined,
): void {
  const routes = new Set([...Object.keys(providers ?? {}), ...Object.keys(authority ?? {})])
  for (const provider of routes) {
    const profile = Object.hasOwn(providers ?? {}, provider) ? providers?.[provider] : undefined
    const owned = Object.hasOwn(authority ?? {}, provider) ? authority?.[provider]?.managedBaseURL : undefined
    if (owned === undefined) {
      if (profile?.managedBaseURL !== undefined) {
        throw new Error(`llm-pi-ai: provider route "${provider}" cannot mark itself as managed from settings`)
      }
      continue
    }
    if (!sameManagedEndpoint(owned, profile?.managedBaseURL ?? '')
      || !sameManagedEndpoint(owned, profile?.baseURL ?? '')) {
      throw new Error(`llm-pi-ai: managed provider route "${provider}" requires its composition endpoint`)
    }
  }
}
