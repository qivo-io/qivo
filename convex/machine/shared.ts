/* The wording and parsing that machine/rest.ts, machine/mcp.ts and the domain
 * modules declaring entries for both surfaces (machine/records.ts,
 * machine/discussion.ts, machine/projects.ts, machine/teams.ts) share.
 *
 * The surface modules spread a domain module's entries into TOOLS and
 * ROUTES, so a domain module that imported a value from them would close an
 * import cycle. These rules therefore live here, once, and every module that
 * names the caller, signs a write's activity row, reads an agent key's name,
 * reads a request body or parses a REST body or query parameter imports
 * them from this file. The REST and MCP lists that page through
 * lib/listCursor.ts namedListPage, and the later lists in name order, check
 * their paging with namedPaging here. */

import { v } from 'convex/values'
import type { ProfileKind } from '../lib/enums'
import { badRequest } from '../lib/functions'
import { limitedText, limitedWhole } from '../lib/limitRules'
import { cutText, DEFAULT_PAGE_SIZE, LIMITS, type Limit, MIB } from '../lib/limits'
import { offsetRefusal } from '../lib/listCursor'
import { readLimitedBody } from '../lib/requestBody'
import { plainText } from '../model/activity'
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
      'comments cannot be attributed over the API; a comment is always authored by the agent posting it',
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

/** The refusal reason of a write that kept conflicting with writes made at
 * the same time, or kept running out of time (machine/registry.ts
 * retryConflicts). Its transaction never committed, so the request changed
 * nothing and can be sent again. REST
 * answers it 503 with Retry-After, and MCP as the tool's error result, or
 * as an HTTP 503 when the conflict came before the call ran. */
export const WRITE_CONFLICT = 'write_conflict'

/** The sentence REST and MCP answer for WRITE_CONFLICT. */
export const WRITE_CONFLICT_MESSAGE =
  'the request conflicted with other changes made at the same time and changed nothing; send it again'

/** The sentence REST and MCP answer for WRITE_CONFLICT when the write kept
 * running out of time instead (machine/registry.ts retryConflicts). A busy
 * server can cause it, and so can a change too large to finish in time,
 * which runs out every time, so it also says to change less. */
export const WRITE_TIMEOUT_MESSAGE =
  'the request took too long and changed nothing; send it again, or change less at once if it keeps happening'

/** The seconds REST and MCP ask a caller to wait after WRITE_CONFLICT. */
export const WRITE_CONFLICT_RETRY_AFTER = 1

/** The provenance an MCP write's activity row carries. */
export const MCP_PROVENANCE = 'via MCP'

/** The provenance a REST write's activity row carries. An agent key's writes
 * name the key. A personal token's writes name no token, because the person
 * is the actor and only they and organization admins (on API access) see
 * their tokens, while the activity row reaches other members too. A delete
 * records its credential in Deleted items as well, where a personal token's
 * name shows only to organization admins and to the person who deleted
 * (model/deletedItemsRows.ts). The name is written as plain text
 * (model/activity.ts plainText), as an activity diff's free text is, so it
 * cannot add a status or reviewer clause that the app's feed reader finds
 * (src/lib/teamSync.ts). */
export const restProvenance = (keyName: string | null): string =>
  keyName === null ? 'via the REST API' : `via the REST API (${plainText(keyName)})`

/** The agent key's name for its writes' provenance, or null for a personal
 * token. */
export const vKeyName = v.union(v.string(), v.null())

/** In a /u pattern a whole surrogate pair reads as one code point, so only
 * half a pair matches the Surrogate category. */
export const LONE_SURROGATE = /\p{Surrogate}/u

/** Whether a string anywhere in `x`, an object key included, holds an
 * unpaired surrogate. A JSON escape such as \ud800 can leave one, and Convex
 * cannot pass it to a function or store it. It walks with its own stack, so
 * a deeply nested value cannot overflow the call stack. */
export function hasLoneSurrogate(x: unknown): boolean {
  const stack = [x]
  while (stack.length > 0) {
    const item = stack.pop()
    if (typeof item === 'string') {
      if (LONE_SURROGATE.test(item)) return true
    } else if (typeof item === 'object' && item !== null) {
      for (const [key, value] of Object.entries(item)) {
        if (LONE_SURROGATE.test(key)) return true
        stack.push(value)
      }
    }
  }
  return false
}

/** REST's refusal for a body that holds an unpaired surrogate. */
export const REST_UNPAIRED_SURROGATE =
  'request body holds an unpaired surrogate, which UTF-8 cannot encode'

/**
 * A REST request body as an object. Body tolerance (rest:196-198, 323-326)
 * means no Content-Type check. Invalid JSON, an array and any other value
 * that is not an object get this 400. A body holding an unpaired surrogate
 * gets its own 400, because the write would fail later.
 */
export function needJson(raw: string): Record<string, unknown> {
  let body: unknown = null
  try {
    body = JSON.parse(raw)
  } catch {
    body = null
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('request body must be JSON')
  }
  if (hasLoneSurrogate(body)) throw badRequest(REST_UNPAIRED_SURROGATE)
  return body as Record<string, unknown>
}

/* A REST query parameter, which arrives as text, or an MCP argument, which
 * arrives as a number, as a number. A blank parameter reads as NaN, which
 * every whole-number check refuses. */
const numberOf = (raw: string | number): number =>
  typeof raw === 'number' ? raw : raw.trim() === '' ? Number.NaN : Number(raw)

/** A list's `limit`, the rows of one page, from a REST query parameter or an
 * MCP argument, checked against `range`, the list's registry entry (such as
 * LIMITS.listTasks, listWorkload or listUsers), and refused with its
 * sentence on both surfaces. Absent is DEFAULT_PAGE_SIZE. */
export function pageLimit(range: Limit, raw: string | number | undefined): number {
  return raw === undefined ? DEFAULT_PAGE_SIZE : limitedWhole(range, numberOf(raw))
}

/** Whether a list that pages with a cursor was sent an `offset` other than
 * 0, from a REST query parameter or an MCP argument. Absent is 0, and so is
 * any text that reads as 0, such as `00`; anything else, text that is no
 * number included, is an offset sent. The task lists refuse such an offset
 * in lib/core.ts taskListRequest, REST GET /v1/workload and MCP
 * get_workload in machine/records.ts, and the lists that take a search, a
 * task's and a project's related lists and REST GET /v1/inbox and MCP
 * list_inbox in cursorPaging, with lib/listCursor.ts offsetRefusal. */
export const offsetSent = (raw: string | number | undefined): boolean =>
  raw !== undefined && numberOf(raw) !== 0

/** The paging of a REST or MCP list that pages with a cursor and takes no
 * search, such as a task's related lists (REST GET
 * /v1/tasks/{ref}/subtasks and MCP list_task_related), a project's lists
 * (REST GET /v1/projects/{ref}/users, /milestones, /access/users and
 * /access/teams, MCP list_project_users and list_project_related) and the
 * Inbox (REST GET /v1/inbox and MCP list_inbox, machine/discussion.ts),
 * checked in the order both surfaces document: `limit` against `range`,
 * the list's registry entry (DEFAULT_PAGE_SIZE when absent), then any
 * `offset` but 0, refused with offsetRefusal(noun). An absent cursor is
 * null. REST passes an empty `cursor` as absent; MCP passes it as sent, so
 * its empty cursor is refused when the page opens it. namedPaging checks
 * these first too. */
export function cursorPaging(
  range: Limit,
  noun: string,
  a: { limit?: string | number; offset?: string | number; cursor?: string },
): { limit: number; cursor: string | null } {
  const limit = pageLimit(range, a.limit)
  if (offsetSent(a.offset)) throw badRequest(offsetRefusal(noun))
  return { limit, cursor: a.cursor ?? null }
}

/** The paging of a REST or MCP list that takes a search, such as REST GET
 * /v1/users and MCP list_users in name order (lib/listCursor.ts
 * namedListPage) and REST GET /v1/projects and MCP list_projects in tree
 * order (machine/projects.ts projectPage), checked in the order both
 * surfaces document: `limit` and `offset` as cursorPaging checks them,
 * then the search, trimmed and refused past LIMITS.search with its
 * sentence. An absent cursor or search is null or blank. REST passes an
 * empty `cursor` or `search` as absent; MCP passes them as sent, so its
 * empty cursor is refused when the page opens it. Every later REST and MCP
 * list in name order checks its paging here. */
export function namedPaging(
  range: Limit,
  noun: string,
  a: { limit?: string | number; offset?: string | number; cursor?: string; search?: string },
): { limit: number; cursor: string | null; search: string } {
  const paging = cursorPaging(range, noun, a)
  const search = limitedText(LIMITS.search, a.search ?? '')
  return { ...paging, search }
}

/** A REST request body that may be left out, such as a DELETE's. An empty
 * body reads as {}, and any other body as needJson reads it. */
export const optionalJson = (raw: string): Record<string, unknown> =>
  raw.trim() === '' ? {} : needJson(raw)

/** The most caller-sent names a refusal lists, and the most characters it
 * shows of each, so a refusal stays short whatever the request held. */
export const NAMES_LISTED = 10
export const NAME_SHOWN_MAX = 100

/** `text`, something a caller sent, cut to NAME_SHOWN_MAX characters for a
 * refusal to show, a cut one ending in "…". An emoji at the cut is kept whole
 * or left out. */
export const shownName = (text: string): string =>
  text.length > NAME_SHOWN_MAX ? `${cutText(text, NAME_SHOWN_MAX)}…` : text

/** `names` quoted and joined by ", ", at most NAMES_LISTED of them, each cut
 * by shownName, followed by how many more there were. */
export function quotedNames(names: readonly string[]): string {
  const listed = names
    .slice(0, NAMES_LISTED)
    .map((name) => `"${shownName(name)}"`)
    .join(', ')
  return names.length > NAMES_LISTED ? `${listed} and ${names.length - NAMES_LISTED} more` : listed
}

/** Refuses the fields of a REST body that `known` does not name, so a
 * misspelled field is refused instead of being dropped. Every REST route
 * that reads a body calls it, after the refusals that name a field the body
 * may not write and say where it goes instead. An empty `known` refuses
 * every field of a route that takes no body. */
export function refuseUnknownFields(b: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(b).filter((key) => !known.includes(key))
  if (unknown.length === 0) return
  const takes =
    known.length === 0 ? 'this request takes no body' : `this request takes ${known.join(', ')}`
  throw badRequest(
    `unknown field${unknown.length > 1 ? 's' : ''} ${quotedNames(unknown)}; ${takes}`,
  )
}

/** Refuses the query parameters in `names` that `known` does not name, the
 * query twin of refuseUnknownFields, so a misspelled filter is refused
 * instead of answering an unfiltered list. */
export function refuseUnknownParams(names: Iterable<string>, known: readonly string[]): void {
  const unknown = [...new Set(names)].filter((name) => !known.includes(name))
  if (unknown.length === 0) return
  const takes =
    known.length === 0
      ? 'this request takes no query parameters'
      : `this request takes ${known.join(', ')}`
  throw badRequest(
    `unknown query parameter${unknown.length > 1 ? 's' : ''} ${quotedNames(unknown)}; ${takes}`,
  )
}

/** REST's refusal for a request body whose bytes are not UTF-8. Decoding it
 * would store U+FFFD in place of each bad sequence, so it is refused like a
 * body holding an unpaired surrogate. */
export const REST_NOT_UTF8 = 'request body is not valid UTF-8'

/** The largest REST or MCP request body, in bytes (LIMITS.requestBody, in
 * MiB). A field at the 20,000-character text cap is at most about 120 KB of
 * JSON. Uploaded files go to signed upload URLs, never through these bodies.
 * The at most 256 KiB of UTF-8 that MCP's attach_text_file takes fits as
 * JSON even with every non-ASCII character escaped, unless it is mostly
 * control characters, which JSON escapes to six bytes each. */
export const BODY_MAX_BYTES = LIMITS.requestBody.max * MIB

/* convex/tsconfig's lib is ESNext only, which does not declare the decoder
 * the Convex runtime has. */
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean })
  decode(value: Uint8Array): string
}

/** A request body that readBody read. `text` decodes as request.text()
 * would, with each byte sequence that is not UTF-8 replaced by U+FFFD, and
 * `utf8` says whether the bytes held none. REST and MCP both refuse a body
 * that is not UTF-8. */
export type RequestBody = { text: string; utf8: boolean }

/**
 * A REST or MCP request body, or null when it is longer than
 * BODY_MAX_BYTES (lib/requestBody.ts readLimitedBody). The bytes are counted
 * before decoding, so a byte-order mark counts too. Its handler's
 * answerAfterBody then drops the rest before the 413 goes out. Callers read
 * it after authentication, so an unauthenticated caller learns nothing new
 * and an oversized request still counts as a call.
 */
export async function readBody(request: Request): Promise<RequestBody | null> {
  const read = await readLimitedBody(request, BODY_MAX_BYTES)
  if (read.outcome !== 'read') return read.outcome === 'missing' ? { text: '', utf8: true } : null
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(read.bytes), utf8: true }
  } catch {
    return { text: new TextDecoder().decode(read.bytes), utf8: false }
  }
}

/** An MCP tool's result text, the deployed `text()` body. It is 2-space
 * pretty JSON, stringified inside the internal function so the projection's
 * insertion key order survives the Convex value boundary, which sorts
 * object keys. */
export const pretty = (value: unknown): string => JSON.stringify(value, null, 2)
