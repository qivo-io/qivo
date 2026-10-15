/* The wording and parsing that machine/rest.ts, machine/mcp.ts and the domain
 * modules declaring entries for both surfaces (machine/projects.ts) share.
 *
 * The surface modules spread a domain module's entries into TOOLS and
 * ROUTES, so a domain module that imported a value from them would close an
 * import cycle. These rules therefore live here, once, and every module that
 * signs a write's activity row, reads an agent key's name or parses a REST
 * body imports them from this file. */

import { v } from 'convex/values'
import { badRequest } from '../lib/functions'

/** The provenance an MCP write's activity row carries. */
export const MCP_PROVENANCE = 'via MCP'

/** The provenance a REST write's activity row carries. An agent key's writes
 * name the key. A personal token's writes name no token, because the person
 * is the actor and their tokens are private. */
export const restProvenance = (keyName: string | null): string =>
  keyName === null ? 'via the REST API' : `via the REST API (${keyName})`

/** The agent key's name for its writes' provenance, or null for a personal
 * token. */
export const vKeyName = v.union(v.string(), v.null())

/**
 * A REST request body as an object. Body tolerance (rest:196-198, 323-326)
 * means no Content-Type check. Invalid JSON and non-objects get this 400,
 * and arrays pass as objects and fail field by field.
 */
export function needJson(raw: string): Record<string, unknown> {
  let body: unknown = null
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }
  if (body === null || typeof body !== 'object') throw badRequest('request body must be JSON')
  return body as Record<string, unknown>
}

/** A REST request body that may be left out, such as a DELETE's. An empty
 * body reads as {}, and any other body as needJson reads it. */
export const optionalJson = (raw: string): Record<string, unknown> =>
  raw.trim() === '' ? {} : needJson(raw)

/** An MCP tool's result text, the deployed `text()` body. It is 2-space
 * pretty JSON, stringified inside the internal function so the projection's
 * insertion key order survives the Convex value boundary, which sorts
 * object keys. */
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2)
