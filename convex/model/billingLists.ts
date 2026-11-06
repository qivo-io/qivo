/* Billing's lists of accounts, a batch of LIST_BATCH at a time, each read
 * once by the app (convex.query) and never subscribed:
 *
 *   - API calls by account (billing.apiAccounts, apiAccountsBatch): the
 *     accounts with calls in one usage bucket, most calls first, from the
 *     bucket's account rows (billing_usage_accounts by_org_period_calls,
 *     kept by model/billingUsage.ts addRankedCalls), never from the usage
 *     rows. Each row is an account's total over all its credentials, with
 *     its name read from its profile.
 *   - Who counts toward your bill and Who does not count toward your bill
 *     (billing.accountList, accountNamesBatch): the organization's profiles
 *     in name order (model/nameKeys.ts profileIndex), each kept by the rule
 *     that counts them (lib/billableUsers.ts billingStanding), names and
 *     ids only.
 *
 * Both read through the shared name-ordered reader (lib/namedPages.ts).
 * API calls by account reads in descending order with a constant key ''
 * and the tie [calls, profile_id], the fields the index orders a row by
 * after its organization and bucket, so equal calls come in descending
 * profile id order. A cursor is sealed to its list, the organization, the
 * bucket or kind, and the search's name key, and a batch reads under a
 * read share of its own (API_ACCOUNTS, ACCOUNT_NAMES) and answers
 * `stopped` where the share ended it.
 *
 * Calls change while an admin browses, and nothing freezes a snapshot (the
 * owner, 31 October 2026). An account whose calls grow past the cursor
 * between two batches is missed until the list starts again, and one a
 * re-rank lowers past it is answered twice, which the app shows once. The
 * figures never depend on the rows loaded. */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { ReadCeiling } from '../lib/archivedTasks'
import { BILLABLE_STANDINGS, billingStanding } from '../lib/billableUsers'
import type { AccountNames, ApiAccountRow, ApiAccounts } from '../lib/billingTypes'
import { byId } from '../lib/db'
import { badRequest } from '../lib/functions'
import { limitedText } from '../lib/limitRules'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import {
  indexAfter,
  listBatch,
  NAMED_READ,
  type NamedAt,
  type NamedIndex,
  namedCeiling,
  openNamedCursor,
  type ReadGuard,
} from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { allWordsMatcher } from '../lib/search'
import { usageRanked } from './billingUsage'
import { idTieOf, nameKeysReady, profileIndex } from './nameKeys'

/* ------------------------------------------------- API calls by account */

/** What one batch of API calls by account may read, past what the call
 * read before it: NAMED_READ's share, 2,000 index ranges, 8,000 documents
 * and 4 MiB. An account row holds two uuids, a bucket key and a number,
 * about 150 bytes, and each row the batch passes reads its profile, well
 * under 1 KB, in one index range. At the design size a bucket holds up to
 * 1,000 accounts, the organization's people and agents with calls, so even
 * a search that matches only the account with the fewest calls reads about
 * 1,000 rows and 1,000 profiles in about 1,000 ranges, inside the share.
 * Measured in convex/tests/billingLists.test.ts ("reads at the design
 * size"), the reader alone without the caller's seat check, at 1,000
 * accounts with calls a first batch read 52 documents, 27 index ranges and
 * about 14 KB, and a search that matches only the account with the fewest
 * calls read 2,001 documents, 1,002 index ranges and about 535 KB. Past
 * the share the batch answers `stopped` and Load more goes on. Tests lower
 * it. */
export const API_ACCOUNTS: { reads: ReadCeiling } = { reads: { ...NAMED_READ } }

/** The list's name, which seals its cursors (lib/namedPages.ts namedCursor). */
export const API_ACCOUNTS_LIST = 'billing.apiAccounts'

/** The longest bucket key a period can be: `month:YYYY-MM` or an ISO
 * instant, well under it. */
export const PERIOD_KEY_MAX = 64

/** The refusal of a period longer than any bucket key. */
export const NOT_A_PERIOD = 'period must be the key of a usage period, as Billing answers it'

/** The refusal of a cursor that is not one of this list for the same
 * bucket and search. */
export const NOT_ACCOUNTS_CURSOR =
  'cursor must come from an earlier answer of API calls by account, for the same period and search; start the list again'

/** The tie of an API calls by account position: the account row's calls,
 * then its profile id, the fields by_org_period_calls orders a row by
 * after its organization and bucket. One row per organization, bucket and
 * profile (addRankedCalls), so the two name one row. */
type CallsTie = readonly [calls: number, profileId: string]

/* The position of account row `row`. */
const callsAt = (row: Doc<'billing_usage_accounts'>): NamedAt<CallsTie> => ({
  key: '',
  tie: [row.calls, row.profile_id],
})

/* An API calls by account position's tie, or null for any other shape. */
function callsTieOf(at: NamedAt): CallsTie | null {
  const [calls, profileId] = at.tie
  return at.key === '' &&
    at.tie.length === 2 &&
    typeof calls === 'number' &&
    typeof profileId === 'string'
    ? [calls, profileId]
    : null
}

/** The account rows of bucket `period` of organization `orgId` with calls,
 * most calls first (billing_usage_accounts by_org_period_calls read
 * descending), equal calls in descending profile id order. A row at 0
 * calls or fewer, which a re-rank or a reseed can leave, is not in it.
 * After a position it reads the rest of its calls before its profile id,
 * then every smaller figure above 0. */
function callsIndex(
  ctx: QueryCtx,
  orgId: string,
  period: string,
): NamedIndex<Doc<'billing_usage_accounts'>, CallsTie> {
  const rows = () => ctx.db.query('billing_usage_accounts')
  return {
    all: () =>
      rows()
        .withIndex('by_org_period_calls', (q) =>
          q.eq('org_id', orgId).eq('period_start', period).gt('calls', 0),
        )
        .order('desc'),
    after: ({ tie: [calls, profileId] }) =>
      calls <= 0
        ? []
        : [
            () =>
              rows()
                .withIndex('by_org_period_calls', (q) =>
                  q
                    .eq('org_id', orgId)
                    .eq('period_start', period)
                    .eq('calls', calls)
                    .lt('profile_id', profileId),
                )
                .order('desc'),
            () =>
              rows()
                .withIndex('by_org_period_calls', (q) =>
                  q
                    .eq('org_id', orgId)
                    .eq('period_start', period)
                    .gt('calls', 0)
                    .lt('calls', calls),
                )
                .order('desc'),
          ],
    at: callsAt,
  }
}

/**
 * One batch of API calls by account for organization `orgId` (the
 * caller's, never the cursor's) in the bucket keyed `a.period`, after
 * `a.cursor` or from the start, matching `a.search` when given.
 *
 * `period` is the bucket key Billing's figures answered (usageFigures'
 * period_key), so the figures, the rows and View credentials name one
 * bucket, also at a boundary or when Convex answers the figures from its
 * cache. Every range starts at `orgId`, so a key reads only that
 * organization's buckets, past ones included, as API access shows them; a
 * key that names no bucket of it answers an empty list. Refuses a period
 * longer than PERIOD_KEY_MAX, a search longer than LIMITS.search and a
 * cursor that is not this list's for the same organization, bucket and
 * search, before it reads anything.
 *
 * Answers `counting`, before any account row, while the bucket's usage
 * rows are not all ranked (model/billingUsage.ts usageRanked), since its
 * account rows then leave calls out; never a partial list as a whole one.
 * A search keeps the accounts whose shown name holds every
 * whitespace-separated fragment of it, ignoring case and accents: the
 * profile's name when it belongs to the organization, else "Removed user",
 * as API access's credential search matches a removed owner. Another
 * organization's profile, which a reused id can name, is never matched or
 * answered by its own name. Reads one profile per row it passes, and no
 * credential, task or file.
 */
export async function apiAccountsBatch(
  ctx: QueryCtx,
  orgId: string,
  a: { period: string; search?: string; cursor?: string },
): Promise<ApiAccounts> {
  if (a.period.length > PERIOD_KEY_MAX) throw badRequest(NOT_A_PERIOD)
  const search = limitedText(LIMITS.search, a.search ?? '')
  const scope = [orgId, a.period, nameKey(search)]
  let after: NamedAt<CallsTie> | null = null
  if (a.cursor !== undefined) {
    const at = await openNamedCursor(a.cursor, API_ACCOUNTS_LIST, scope)
    const tie = at === null ? null : callsTieOf(at)
    if (tie === null) throw badRequest(NOT_ACCOUNTS_CURSOR)
    after = { key: '', tie }
  }
  if (!(await usageRanked(ctx, orgId, a.period))) return { state: 'counting' }
  const matches = allWordsMatcher(nameKey(search))
  const batch = await listBatch(
    ctx,
    { list: API_ACCOUNTS_LIST, scope, after, through: null },
    {
      stream: indexAfter(callsIndex(ctx, orgId, a.period), after, 'desc'),
      keep: async (
        row: Doc<'billing_usage_accounts'>,
        guard: ReadGuard,
      ): Promise<ApiAccountRow | null> => {
        const profile = await guard.lookup(() => byId(ctx, 'profiles', row.profile_id))
        const own = profile?.org_id === orgId
        const name = own ? profile.name : 'Removed user'
        // the shown name only, so no search tells another organization's names
        if (search !== '' && !matches(nameKey(name))) return null
        return { profile_id: row.profile_id, name, removed: !own, calls: row.calls }
      },
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx, API_ACCOUNTS.reads),
      order: 'desc',
    },
  )
  return { state: 'ready', ...batch }
}

/* ------------------------------------------------------ the account names */

/** Which of Billing's name lists: who counts toward the bill, or who does
 * not. */
export type AccountKind = 'billable' | 'non_billable'

/** What one batch of an account name list may read, past what the call
 * read before it: NAMED_READ's share, 2,000 index ranges, 8,000 documents
 * and 4 MiB. A batch reads profiles in name order, each well under 1 KB,
 * and each active guest's home check reads the profiles of its email in
 * one more range. At the design size an organization holds up to 1,000
 * profiles with everyday guests, so a batch that passes them all, such as
 * the non-billable list with its inactive people named last, answers in
 * one call. Measured in convex/tests/billingLists.test.ts ("reads at the
 * design size"), the reader alone, at 1,000 people with 30 inactive ones
 * named last and 20 guests, half of them billed at home: a first batch of
 * the billable list read 68 documents, 23 index ranges and about 24 KB, a
 * search that matches only its last name 1,001 documents, 2 ranges and
 * about 364 KB, and a first batch of the non-billable list 1,018
 * documents, 23 ranges and about 370 KB. Past the share the batch answers
 * `stopped` and Load more goes on. Tests lower it. */
export const ACCOUNT_NAMES: { reads: ReadCeiling } = { reads: { ...NAMED_READ } }

/** The list's name, which seals its cursors. */
export const ACCOUNT_NAMES_LIST = 'billing.accountList'

/** The refusal of a cursor that is not one of this list for the same kind
 * and search. */
export const NOT_NAMES_CURSOR =
  'cursor must come from an earlier answer of the same account list, with the same search; start the list again'

/**
 * One batch of Billing's names of `a.kind` for organization `orgId` (the
 * caller's, never the cursor's), in name order, after `a.cursor` or from
 * the start, matching `a.search` when given: `billable`, the profiles who
 * count toward the bill, or `non_billable`, the inactive ones and the
 * active guests billed in their home organization. A profile is kept by
 * the rule that counts it (lib/billableUsers.ts billingStanding), so the
 * lists name exactly whom the counters count. Refuses a search longer than
 * LIMITS.search and a cursor that is not this list's for the same
 * organization, kind and search, before it reads anything, and answers
 * `not_ready` until every profile holds its name key (nameKeysReady).
 *
 * It answers the organization's own profiles, names and ids only. A
 * guest's home check reads profiles of its email in other organizations
 * only to decide its standing, counted by the batch's read guard, and
 * answers none of them. A search keeps the profiles whose name holds every
 * whitespace-separated fragment of it, ignoring case and accents.
 */
export async function accountNamesBatch(
  ctx: QueryCtx,
  orgId: string,
  a: { kind: AccountKind; search?: string; cursor?: string },
): Promise<AccountNames> {
  const search = limitedText(LIMITS.search, a.search ?? '')
  const scope = [orgId, a.kind, nameKey(search)]
  let after: NamedAt<readonly [string]> | null = null
  if (a.cursor !== undefined) {
    const at = await openNamedCursor(a.cursor, ACCOUNT_NAMES_LIST, scope)
    const tie = at === null ? null : idTieOf(at)
    if (at === null || tie === null) throw badRequest(NOT_NAMES_CURSOR)
    after = { key: at.key, tie }
  }
  if (!(await nameKeysReady(ctx, orgId))) return { state: 'not_ready' }
  const matches = allWordsMatcher(nameKey(search))
  const billable = a.kind === 'billable'
  const batch = await listBatch(
    ctx,
    { list: ACCOUNT_NAMES_LIST, scope, after, through: null },
    {
      stream: indexAfter(profileIndex(ctx, orgId), after),
      keep: async (profile: Doc<'profiles'>, guard: ReadGuard) => {
        if (search !== '' && !matches(nameKey(profile.name))) return null
        const standing = await billingStanding(ctx, profile, guard)
        if (BILLABLE_STANDINGS.includes(standing) !== billable) return null
        return { profile_id: profile.id, name: profile.name }
      },
      limit: LIST_BATCH,
      ceiling: await namedCeiling(ctx, ACCOUNT_NAMES.reads),
    },
  )
  return { state: 'ready', ...batch }
}
