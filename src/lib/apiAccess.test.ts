import { describe, expect, it } from 'vitest'
import {
  type ApiCredentialRow,
  type ApiUsagePeriod,
  credentialPrefix,
  expiryNote,
  lastUsedLabel,
  periodLabel,
  planLine,
  rangeLabel,
  revokeSentence,
  stateTag,
} from './apiAccess'

/* Local times, so every label reads the same in any time zone; the default
   date format is day first ("6 Oct"). */
const NOW = new Date(2026, 9, 15, 10, 0)
const local = (y: number, m: number, d: number, h = 12, min = 0, s = 0) =>
  new Date(y, m - 1, d, h, min, s).toISOString()

const row = (name: string, patch: Partial<ApiCredentialRow> = {}): ApiCredentialRow => ({
  table: 'mcp_tokens',
  id: name,
  name,
  prefix: `qvt_${name.slice(0, 7)}`,
  profile_id: 'daniel',
  person: 'Daniel Berg',
  agent: false,
  removed: false,
  access: 'write',
  expires_at: null,
  last_used_at: null,
  revoked_at: null,
  revoked_by_admin: false,
  state: 'active',
  calls: 0,
  ...patch,
})

describe('API access labels', () => {
  it('says when a credential was last used, from minutes to dates', () => {
    expect(lastUsedLabel(null, NOW)).toBe('Never')
    expect(lastUsedLabel(local(2026, 10, 15, 9, 59, 30), NOW)).toBe('Just now')
    expect(lastUsedLabel(local(2026, 10, 15, 9, 48), NOW)).toBe('12 min ago')
    expect(lastUsedLabel(local(2026, 10, 15, 8, 30), NOW)).toBe('1 h ago')
    expect(lastUsedLabel(local(2026, 10, 14, 8), NOW)).toBe('Yesterday')
    expect(lastUsedLabel(local(2026, 10, 12, 8), NOW)).toBe('3 days ago')
    expect(lastUsedLabel(local(2026, 10, 6), NOW)).toBe('6 Oct')
    expect(lastUsedLabel(local(2025, 12, 30), NOW)).toBe('30 Dec 2025')
  })

  it('names a period by its days, a calendar month by its UTC days', () => {
    const period = (patch: Partial<ApiUsagePeriod>): ApiUsagePeriod => ({
      key: 'k',
      kind: 'paid',
      start: local(2026, 9, 15),
      end: local(2026, 10, 15),
      current: false,
      ...patch,
    })
    expect(periodLabel(period({}), NOW)).toBe('15 Sep to 15 Oct')
    // the month's first and last UTC day, whatever the viewer's zone
    const month = period({
      kind: 'month',
      start: '2026-10-01T00:00:00.000Z',
      end: '2026-10-31T00:00:00.000Z',
    })
    expect(periodLabel(month, NOW)).toBe('1 Oct to 31 Oct')
    expect(
      periodLabel(
        { ...month, start: '2025-10-01T00:00:00.000Z', end: '2025-10-31T00:00:00.000Z' },
        NOW,
      ),
    ).toBe('1 Oct 2025 to 31 Oct 2025')
    expect(periodLabel(period({ kind: 'open', start: local(2026, 7, 2), end: null }), NOW)).toBe(
      'From 2 Jul',
    )
  })

  it('quotes the plan, or says why the calls are not charged', () => {
    const plan = {
      currency: 'usd',
      api_calls_per_seat: 25_000,
      api_block_size: 25_000,
      api_block_price_cents: 100,
    }
    const paid: ApiUsagePeriod = { key: 'p', kind: 'paid', start: '', end: '', current: true }
    const summary = { calls: 1, included_calls: 175_000, plan, waived: false }
    expect(planLine(summary, paid)).toBe(
      '25,000 calls per seat, shared by the organization. Each started 25,000 above that costs $1.',
    )
    expect(planLine({ ...summary, plan: { ...plan, api_block_price_cents: 150 } }, paid)).toMatch(
      /costs \$1\.50\.$/,
    )
    expect(planLine({ ...summary, waived: true }, { ...paid, kind: 'month' })).toBe(
      '25,000 calls per seat, shared by the organization. Calls are not charged without a paid period.',
    )
    expect(planLine({ ...summary, waived: true }, paid)).toMatch(
      /Calls in this period are not charged\.$/,
    )
    expect(planLine({ ...summary, plan: null, included_calls: null }, paid)).toBeNull()
  })

  it('names the last day a working token works, as its owner sees it', () => {
    const expiring = (y: number, m: number, d: number) =>
      row('a', { expires_at: local(y, m, d, 0) })
    // stored as the start of 3 Dec, so 2 Dec is the last day
    expect(expiryNote(expiring(2026, 12, 3), NOW)).toBe('expires 2 Dec')
    expect(expiryNote(expiring(2026, 10, 17), NOW)).toBe('expires tomorrow')
    expect(expiryNote(expiring(2026, 10, 20), NOW)).toBe('expires in 4 days')
    expect(expiryNote(row('a'), NOW)).toBeNull()
    expect(
      expiryNote(row('a', { state: 'revoked', expires_at: local(2026, 12, 3, 0) }), NOW),
    ).toBeNull()
  })

  it('tags credentials that do not work and shortens a connected app client id', () => {
    expect(stateTag(row('a'), NOW)).toBeNull()
    expect(stateTag(row('a', { state: 'revoked', revoked_at: local(2026, 10, 6) }), NOW)).toBe(
      'revoked 6 Oct',
    )
    // a token stores the start of the day after its last one; the tag names
    // the last day it worked, as its owner's list does
    expect(stateTag(row('a', { state: 'expired', expires_at: local(2026, 9, 10, 0) }), NOW)).toBe(
      'expired 9 Sep',
    )
    expect(stateTag(row('a', { state: 'inactive' }), NOW)).toBe('account inactive')
    expect(stateTag(row('a', { state: 'deleted', prefix: null }), NOW)).toBe('deleted')
    const app = row('Claude', { table: 'oauth_connections', prefix: '4f1c2b7d9e0a1c3fa90e' })
    expect(credentialPrefix(app)).toBe('client 4f1c…a90e')
    expect(credentialPrefix({ ...app, prefix: 'short' })).toBe('client short')
    expect(credentialPrefix(row('Cursor'))).toBe('qvt_Cursor')
    expect(credentialPrefix(row('gone', { prefix: null }))).toBeNull()
  })
})

describe('the count line', () => {
  it('names the rows on screen by their places in the list, with no total', () => {
    expect(rangeLabel(0, 25)).toBe('1–25')
    expect(rangeLabel(25, 25)).toBe('26–50')
    // a page the read budget stopped early holds fewer rows
    expect(rangeLabel(50, 7)).toBe('51–57')
    expect(rangeLabel(57, 1)).toBe('58')
    expect(rangeLabel(0, 0)).toBeNull()
  })
})

describe('the revoke window sentence', () => {
  it('says whose access stops and what they can do next, per kind', () => {
    expect(revokeSentence(row('Cursor'), 'me')).toBe(
      "Daniel Berg's personal token stops working right away. Daniel sees it as revoked by an admin and can create a new one.",
    )
    expect(revokeSentence(row('ChatGPT', { table: 'oauth_connections' }), 'me')).toBe(
      "Daniel Berg's connection to ChatGPT stops working right away. Daniel can connect it again.",
    )
    const key = row('GitHub Actions', { table: 'agent_keys', person: 'Release bot', agent: true })
    expect(revokeSentence(key, 'me')).toBe(
      "Release bot's agent key stops working right away. Create a new key for it in Users.",
    )
    // the viewer's own credential speaks to them
    expect(revokeSentence(row('Cursor', { profile_id: 'me' }), 'me')).toBe(
      'Your personal token stops working right away. You can create a new one.',
    )
    expect(
      revokeSentence(row('Claude', { table: 'oauth_connections', profile_id: 'me' }), 'me'),
    ).toBe('Your connection to Claude stops working right away. You can connect it again.')
  })
})
