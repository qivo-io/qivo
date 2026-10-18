/* The wording and parsing that machine/rest.ts, machine/mcp.ts and the domain
 * modules declaring entries for both surfaces (machine/records.ts,
 * machine/discussion.ts, machine/projects.ts, machine/teams.ts) share.
 *
 * The surface modules spread a domain module's entries into TOOLS and
 * ROUTES, so a domain module that imported a value from them would close an
 * import cycle. These rules therefore live here, once, and every module that
 * names the caller, signs a write's activity row, reads an agent key's name,
 * reads a request body or parses a REST body or query parameter imports
 * them from this file. */

import { v } from 'convex/values'
import type { ProfileKind } from '../lib/enums'
import { badRequest } from '../lib/functions'
import { cutName } from '../lib/textLimits'
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

/** The error REST and MCP answer for a failure that is no refusal, such as
 * a Convex read limit. Such a failure's own text can name source files and
 * hold a stack trace, so only the deployment's log keeps it. */
export const INTERNAL_ERROR = 'internal error'

/** Logs `e`, a failure that is no refusal, and returns INTERNAL_ERROR for
 * the answer. */
export function internalError(e: unknown): string {
  console.error(e)
  return INTERNAL_ERROR
}

/** The provenance an MCP write's activity row carries. */
export const MCP_PROVENANCE = 'via MCP'

/** The provenance a REST write's activity row carries. An agent key's writes
 * name the key, cut to NAME_MAX code points, because a key named before that
 * cap would otherwise repeat a long name in every write's row. A personal
 * token's writes name no token, because the person is the actor and only
 * they and organization admins (on API access) see their tokens, while the
 * activity row reaches other members too. A delete records its credential
 * in Deleted items as well, where a personal token's name shows only to
 * organization admins and to the person who deleted
 * (model/deletedItemsList.ts). */
export const restProvenance = (keyName: string | null): string =>
  keyName === null ? 'via the REST API' : `via the REST API (${cutName(keyName)})`

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

/** Refuses the fields of a REST body that `known` does not name. Used where a
 * dropped field would change whose access a request changes, so a misspelled
 * field is refused instead of falling back to a default. Other routes ignore
 * unknown fields, as the REST docs say. */
export function refuseUnknownFields(b: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(b).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  const names = unknown.map((key) => `"${key}"`).join(', ')
  throw badRequest(
    `unknown field${unknown.length > 1 ? 's' : ''} ${names}; this request takes ${known.join(', ')}`,
  )
}

/** The largest REST or MCP request body, in bytes (1 MiB). A field at the
 * 20,000-character text cap is at most about 120 KB of JSON. Uploaded files
 * go to signed upload URLs, never through these bodies. The at most 256 KiB
 * of UTF-8 that MCP's attach_text_file takes fits as JSON even with every
 * non-ASCII character escaped, unless it is mostly control characters,
 * which JSON escapes to six bytes each. */
export const BODY_MAX_BYTES = 1024 * 1024

/* convex/tsconfig's lib is ESNext only, which declares neither the decoder
 * nor the request body stream the Convex runtime has. */
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean })
  decode(value: Uint8Array): string
}
type BodyStream = {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    cancel(): Promise<void>
  }
}

/** A request body that readBody read. `text` decodes as request.text()
 * would, with each byte sequence that is not UTF-8 replaced by U+FFFD, and
 * `utf8` says whether the bytes held none. MCP refuses a body that is not
 * UTF-8, and REST reads the replaced text. */
export type RequestBody = { text: string; utf8: boolean }

/**
 * A REST or MCP request body, or null when it is longer than
 * BODY_MAX_BYTES. A Content-Length over the cap answers before the body is
 * read. Otherwise the bytes are counted as they arrive, before decoding, so
 * a body sent without Content-Length (chunked) stops being read once it
 * passes the cap, and a byte-order mark counts too. Callers read it after
 * authentication, so an unauthenticated caller learns nothing new and an
 * oversized request still counts as a call.
 */
export async function readBody(request: Request): Promise<RequestBody | null> {
  if (Number(request.headers.get('Content-Length')) > BODY_MAX_BYTES) return null
  const body = (request as Request & { body: BodyStream | null }).body
  if (body === null) return { text: '', utf8: true }
  const reader = body.getReader()
  try {
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      size += value.byteLength
      if (size > BODY_MAX_BYTES) return null
      chunks.push(value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), utf8: true }
    } catch {
      return { text: new TextDecoder().decode(bytes), utf8: false }
    }
  } finally {
    // stops an oversized body; a no-op once the body has been read
    await reader.cancel().catch(() => {})
  }
}

/** An MCP tool's result text, the deployed `text()` body. It is 2-space
 * pretty JSON, stringified inside the internal function so the projection's
 * insertion key order survives the Convex value boundary, which sorts
 * object keys. */
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2)
