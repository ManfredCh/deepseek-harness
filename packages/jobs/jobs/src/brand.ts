/**
 * dsh-jobs' owned branded id, carried across the registry, the model-facing
 * control surface, and the client wire.
 *
 * It lives in its own leaf because the package root and `./types` both reach
 * `dsh-agent` through the owner and listener signatures, which a Client program
 * cannot resolve even as a type. A browser-safe consumer imports the id here;
 * `Branded<B>` itself comes from the zero-dependency `@deepseek-ai/dsh-brand`.
 *
 * @module @deepseek-ai/dsh-jobs/brand
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Identifies a background job. The registry generates `<kind>-N`; predictable
 * ids rely on owner authorization rather than secrecy.
 */
export type JobId = Branded<'JobId'>

/** Identifies one registry lifecycle; a repeated job id in another lifecycle names different work. */
export type JobRegistryId = Branded<'JobRegistryId'>

/**
 * Brand a registry-issued lifecycle id.
 * @param id - the provider's opaque lifecycle id.
 * @returns the same string, branded; no validation is performed.
 */
export function JobRegistryId(id: string): JobRegistryId {
  return id as JobRegistryId
}

/**
 * Brand a string as a {@link JobId}.
 * @param id - the raw job-id string (the registry generates `<kind>-N`).
 * @returns the same string, branded; no validation is performed.
 */
export function JobId(id: string): JobId {
  return id as JobId
}
