/* A stand-in for MCP access's two lists (convex/tokens.ts personalTokens
   and convex/connectedApps.ts list) that answers from rows it is given,
   for the jsdom tests and the browser benchmark's server
   (scripts/perf/server.mjs), as store/peopleSettingsStandIn.setup.ts
   answers Settings › Users.

   It applies the reads' rules to the rows:
   - tokens:personalTokens: the tokens of the caller's active seats, newest
     createdAt first, the id breaking ties in descending order, in
     pubToken's shape; the search keeps a token when every
     whitespace-separated word of it is in the name key of its name or of
     its shown prefix;
   - connectedApps:list: the caller's login's approved connections, newest
     approval first, equal approvals newest row first by creation order,
     each deleted one looked at and left out; a row names its seat and
     organization, or "Removed member" and "Removed organization" when the
     world gives none; the search keeps a row when every word is in the
     name key of its app's, organization's or seat's shown name; a gone
     client marks an unrevoked row appGone;
   - at most LIST_BATCH rows a batch, `next` at the last row looked at, null
     at the end, as lib/namedPages.ts readBatch answers it.

   Its cursors are plain JSON of the list, the scope (the login and the
   search's name key) and the position, so equal positions give equal text,
   as the server's sealed cursors do, and a cursor of another list, login
   or search is refused with bad_request in the server's words. A search
   past LIMITS.search is refused with the limit's sentence. It reads no
   read budget, so a stopped batch, a failure and a smaller batch answer
   only when `force` asks for them. src/store/credentialListsParity.test.ts
   compares it with the real queries. It imports nothing the benchmark's
   worker cannot load: types only from the server's modules, values only
   from convex/lib/limits.ts, nameKey.ts and search.ts. */

import { ConvexError, compareValues } from 'convex/values'
import { LIMITS, LIST_BATCH, overText } from '../../convex/lib/limits'
import { nameKey } from '../../convex/lib/nameKey'
import { allWordsMatcher } from '../../convex/lib/search'
import type { ConnectedAppRow } from '../../convex/model/connectedApps'
import type { PersonalTokenRow } from '../../convex/tokens'

/** A personal token as the stand-in holds it: its row and its seat. */
export type StandInToken = PersonalTokenRow & { seat: string }

/** A connection as the stand-in holds it: the fields its row shows, and
    what the server reads to answer them. */
export type StandInConnection = Omit<
  ConnectedAppRow,
  'profileName' | 'orgName' | 'revokedByAdmin' | 'appGone'
> & {
  /** the login that approved it */
  login: string
  /** when it was approved, or null for an unfinished authorization */
  approvedAt: string | null
  /** why it was revoked, 'deleted' for one its owner deleted */
  revocationReason: string | null
  /** its creation time, which orders equal approvals, newest first */
  created: number
  /** its seat's name, or null when the seat is gone or another login's */
  profileName: string | null
  /** its organization's name, or null when the organization is gone */
  orgName: string | null
  /** whether Better Auth no longer has its client */
  clientGone: boolean
}

/** What the server holds for one caller. */
export type CredentialWorld = {
  /** the caller's login */
  login: string
  /** the ids of the caller's active seats outside a deletion */
  seats: readonly string[]
  tokens: readonly StandInToken[]
  connections: readonly StandInConnection[]
}

/** States the stand-in answers whatever the rows say, as the perf page's
    `credlists` parameter names them:
    - `stop`, a batch's read stops after this many rows looked at (at least
      one, as the server always reads its first);
    - `fail`, every read fails;
    - `batch`, a smaller batch. */
export type ForcedCredentialLists = { stop?: number; fail?: boolean; batch?: number }

/** The reads the stand-in answers, by their function names. */
export const CREDENTIAL_LIST_READS = ['tokens:personalTokens', 'connectedApps:list'] as const
export type CredentialListRead = (typeof CREDENTIAL_LIST_READS)[number]

/** Whether `name` is one of the reads the stand-in answers. */
export const isCredentialListRead = (name: string): name is CredentialListRead =>
  (CREDENTIAL_LIST_READS as readonly string[]).includes(name)

/* The server's lists and refusals (convex/tokens.ts and
   convex/model/connectedApps.ts), which the worker cannot import. */
const TOKENS_LIST = 'tokens.personalTokens'
const APPS_LIST = 'connectedApps.list'
const NOT_TOKENS_CURSOR =
  'cursor must come from an earlier answer of your personal tokens, with the same search; start the list again'
const NOT_APPS_CURSOR =
  'cursor must come from an earlier answer of your connected apps, with the same search; start the list again'
const REMOVED_MEMBER = 'Removed member'
const REMOVED_ORGANIZATION = 'Removed organization'

/* A place in a list, just after the row with this key and tie. */
type Position = { key: string; tie: readonly (number | string)[] }

/* Negative when `a` comes first in the lists' descending order. */
const before = (a: Position, b: Position) => compareValues([b.key, ...b.tie], [a.key, ...a.tie])

/** One row of a list with its position, and what the batch answers for it,
    or null for a row it looks at and leaves out. */
type Item<Row> = { at: Position; row: Row | null }

/**
 * One batch of `items`, in their order, after the cursor `cursor` of list
 * `list` with scope `scope`, as lib/namedPages.ts listBatch answers it.
 * Refuses a cursor of another list or scope with `refusal`.
 */
function batchOf<Row>(
  items: readonly Item<Row>[],
  list: string,
  scope: readonly string[],
  cursor: unknown,
  refusal: string,
  ties: number,
  force: ForcedCredentialLists,
): { rows: Row[]; next: string | null; stopped: boolean } {
  let after: Position | null = null
  if (cursor !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(cursor))
    } catch {
      parsed = null
    }
    const [of, from, position] = Array.isArray(parsed) ? parsed : []
    const [key, tie] = Array.isArray(position) ? position : []
    if (
      of !== list ||
      JSON.stringify(from) !== JSON.stringify(scope) ||
      typeof key !== 'string' ||
      !Array.isArray(tie) ||
      tie.length !== ties
    )
      throw new ConvexError({ code: 'bad_request', message: refusal })
    after = { key, tie }
  }
  const seal = (p: Position) => JSON.stringify([list, scope, [p.key, p.tie]])
  const limit = force.batch ?? LIST_BATCH
  const rows: Row[] = []
  let at: Position | null = after
  let read = 0
  for (const item of items) {
    if (after !== null && before(item.at, after) <= 0) continue
    // a full batch reads one row more, so a batch that ends with the list
    // says so
    if (rows.length >= limit && at !== null) return { rows, next: seal(at), stopped: false }
    if (force.stop !== undefined && read >= Math.max(1, force.stop) && at !== null)
      return { rows, next: seal(at), stopped: true }
    read++
    at = item.at
    if (item.row !== null) rows.push(item.row)
  }
  return { rows, next: null, stopped: false }
}

/**
 * What read `name` answers for `args` while the server holds `world` for
 * the caller. Throws as the server refuses, and for every read when
 * `force.fail` asks.
 */
export function credentialListsStandIn(
  name: string,
  args: Record<string, unknown>,
  world: CredentialWorld,
  force: ForcedCredentialLists = {},
): unknown {
  if (!isCredentialListRead(name)) throw new Error(`the credential lists do not answer ${name}`)
  if (force.fail) throw new Error(`${name} fails, as the stand-in was asked`)
  const search = String(args.search ?? '').trim()
  if (overText(LIMITS.search, search))
    throw new ConvexError({ code: 'rule', message: LIMITS.search.refusal })
  const scope = [world.login, nameKey(search)]
  const matches = allWordsMatcher(nameKey(search))
  const sorted = <Row>(items: Item<Row>[]) => items.sort((a, b) => before(a.at, b.at))

  if (name === 'tokens:personalTokens') {
    const items = sorted(
      world.tokens
        .filter((t) => world.seats.includes(t.seat))
        .map(({ seat: _seat, ...row }): Item<PersonalTokenRow> => {
          const kept = search === '' || matches(`${nameKey(row.name)}\n${nameKey(row.prefix)}`)
          return { at: { key: row.createdAt, tie: [row.id] }, row: kept ? row : null }
        }),
    )
    return batchOf(items, TOKENS_LIST, scope, args.cursor, NOT_TOKENS_CURSOR, 1, force)
  }

  const items = sorted(
    world.connections
      .filter((c) => c.login === world.login && c.approvedAt !== null && c.approvedAt !== '')
      .map((c): Item<ConnectedAppRow> => {
        const at = { key: c.approvedAt as string, tie: [c.created, c.id] }
        if (c.revocationReason === 'deleted') return { at, row: null }
        const profileName = c.profileName || REMOVED_MEMBER
        const orgName = c.orgName || REMOVED_ORGANIZATION
        const kept =
          search === '' ||
          matches(`${nameKey(c.clientName)}\n${nameKey(orgName)}\n${nameKey(profileName)}`)
        if (!kept) return { at, row: null }
        return {
          at,
          row: {
            id: c.id,
            clientId: c.clientId,
            clientName: c.clientName,
            profileId: c.profileId,
            profileName,
            orgId: c.orgId,
            orgName,
            scopes: c.scopes,
            createdAt: c.createdAt,
            lastUsedAt: c.lastUsedAt,
            revokedAt: c.revokedAt,
            revokedByAdmin: c.revocationReason === 'admin',
            appGone: c.revokedAt === null && c.clientGone,
          },
        }
      }),
  )
  return batchOf(items, APPS_LIST, scope, args.cursor, NOT_APPS_CURSOR, 2, force)
}
