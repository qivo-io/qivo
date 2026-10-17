import { describe, expect, it } from 'vitest'
import {
  type ApiAccessFilters,
  type ApiCredentialRow,
  type ApiUsagePeriod,
  credentialPrefix,
  filterCredentials,
  lastUsedLabel,
  periodLabel,
  personOptions,
  planLine,
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

  it('tags credentials that do not work and shortens a connected app client id', () => {
    expect(stateTag(row('a'), NOW)).toBeNull()
    expect(stateTag(row('a', { state: 'revoked', revoked_at: local(2026, 10, 6) }), NOW)).toBe(
      'revoked 6 Oct',
    )
    expect(stateTag(row('a', { state: 'expired', expires_at: local(2026, 9, 9) }), NOW)).toBe(
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

describe('API access filters', () => {
  const rows = [
    row('Cursor', { calls: 18 }),
    row('Claude', { table: 'oauth_connections', profile_id: 'me', person: 'Aisha Khan' }),
    row('GitHub Actions', {
      table: 'agent_keys',
      prefix: 'qva_2...22222',
      profile_id: 'relay',
      person: 'Release bot',
      agent: true,
    }),
    row('Cursor, old', { state: 'revoked' }),
    row('Raycast', { profile_id: 'elin', person: 'Elin Sand', state: 'inactive' }),
    row('Night job', { profile_id: 'gone', person: 'Removed user', state: 'deleted' }),
  ]
  const all: ApiAccessFilters = { kind: 'all', state: 'all', person: '', search: '' }
  const names = (filters: Partial<ApiAccessFilters>) =>
    filterCredentials(rows, { ...all, ...filters }).map((r) => r.name)

  it('narrows by kind, state, person and search, and keeps the server order', () => {
    expect(names({})).toEqual(rows.map((r) => r.name))
    expect(names({ kind: 'agent_keys' })).toEqual(['GitHub Actions'])
    expect(names({ kind: 'oauth_connections' })).toEqual(['Claude'])
    // Active leaves out ended credentials and inactive accounts
    expect(names({ state: 'active' })).toEqual(['Cursor', 'Claude', 'GitHub Actions'])
    expect(names({ person: 'daniel' })).toEqual(['Cursor', 'Cursor, old'])
    // search matches the name, the prefix and the person, every word
    expect(names({ search: 'cursor old' })).toEqual(['Cursor, old'])
    expect(names({ search: '22222' })).toEqual(['GitHub Actions'])
    expect(names({ search: 'elin' })).toEqual(['Raycast'])
    expect(names({ search: 'zapier' })).toEqual([])
    expect(names({ kind: 'agent_keys', person: 'daniel' })).toEqual([])
  })

  it('offers the viewer first, then people, agents and people who left', () => {
    expect(personOptions(rows, 'me')).toEqual([
      { id: 'me', label: 'Aisha Khan (you)' },
      { id: 'daniel', label: 'Daniel Berg' },
      { id: 'elin', label: 'Elin Sand' },
      { id: 'relay', label: 'Release bot' },
      { id: 'gone', label: 'Removed user' },
    ])
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
