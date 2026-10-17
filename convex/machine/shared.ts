/* The wording and parsing that machine/rest.ts, machine/mcp.ts and the domain
 * modules declaring entries for both surfaces (machine/records.ts,
 * machine/discussion.ts, machine/projects.ts, machine/teams.ts) share.
 *
 * The surface modules spread a domain module's entries into TOOLS and
 * ROUTES, so a domain module that imported a value from them would close an
 * import cycle. These rules therefore live here, once, and every module that
 * names the caller, signs a write's activity row, reads an agent key's name
 * or parses a REST body or query parameter imports them from this file. */

import { v } from 'convex/values'
import type { ProfileKind } from '../lib/enums'
import { badRequest } from '../lib/functions'
import { REST_AUTH_401, REST_PERSON_AUTH_401 } from './auth'

/** MCP's refusal for a readable project the caller cannot write, which
 * REST's person sentence reuses. */
export const MCP_NO_WRITE = 'your account has no write access to that project'

/* Every REST sentence that names the caller, keyed by who the credential acts
 * as. An agent key acts as its agent and a personal token as its person
 * (machine/auth.ts lookupCredential holds them to that). The agent column is
 * the pinned contract, and the person column follows MCP's wording. The 401
 * sentences of a failed lookup are machine/auth.ts REST_AUTH_401 and
 * REST_PERSON_AUTH_401. */
export const REST_CALLER = {
  agent: {
    gone: REST_AUTH_401.unknown,
    deactivated: REST_AUTH_401.inactive,
    noWrite: 'this agent has no write access to that project',
    commentAuthor:
      'comments cannot be attributed over the API — a comment is always authored by the agent posting it',
  },
  person: {
    gone: REST_PERSON_AUTH_401.unknown,
    deactivated: REST_PERSON_AUTH_401.inactive,
    noWrite: MCP_NO_WRITE,
    commentAuthor:
      'comments cannot be attributed over the API; a comment is always authored by the person posting it',
  },
} as const satisfies Record<
  ProfileKind,
  { gone: string; deactivated: string; noWrite: string; commentAuthor: string }
>

/** The provenance an MCP write's activity row carries. */
export const MCP_PROVENANCE = 'via MCP'

/** The provenance a REST write's activity row carries. An agent key's writes
 * name the key. A personal token's writes name no token, because the person
 * is the actor and only they and organization admins (on API access) see
 * their tokens, while the activity row reaches other members too. */
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

/** A whole-number REST query parameter from `min` to `max`; absent is
 * `fallback`. */
export function wholeParam(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
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

/** An MCP result with `ignored_arguments` appended when the tool dropped
 * arguments its schema does not know, so a client learns they changed
 * nothing. Without any, the result bytes are unchanged. create_task,
 * update_task and update_project report them. */
export function withIgnored(text: string, ignored: readonly string[]): string {
  if (ignored.length === 0) return text
  return pretty({ ...(JSON.parse(text) as Record<string, unknown>), ignored_arguments: ignored })
}
