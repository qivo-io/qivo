import { describe, expect, it } from 'vitest'
import type { IssueFilters } from '../../store/planner'
import { boardFilters, boardRequest, STALE_DAYS, staleCutoff } from './boardArgs'

/* What the Board sends tasks.board for the filter row on screen: one key
   for equal selections, a new one for any change. */

const NONE: IssueFilters = {
  mine: false,
  assignees: [],
  priority: null,
  stale: false,
  focus: false,
  search: '',
}
const project = { wide: false, mine: false, id: 'sub', proj: { org: 'org' } }
const MINE = { wide: true, mine: true, id: 'mine', proj: null }
const ALL = { wide: true, mine: false, id: 'all', proj: null }
const CUTOFF = '2026-07-01T10:00:00.000Z'

/** The arguments a request sends, which must be one. */
const sent = (info: Parameters<typeof boardRequest>[0], filters: Partial<IssueFilters>) => {
  const request = boardRequest(info, { ...NONE, ...filters }, CUTOFF)
  if (request.kind !== 'ask') throw new Error(`no request: ${request.kind}`)
  return { key: request.key, args: JSON.parse(request.key) }
}

describe('the Board request', () => {
  it('sends the arguments in one key order, whatever order the filter row holds', () => {
    const { key, args } = sent(project, { priority: 'high', focus: true })
    expect(Object.keys(args)).toEqual(['scope', 'filters'])
    expect(Object.keys(args.scope)).toEqual(['kind', 'org_id', 'project_id'])
    expect(Object.keys(args.filters)).toEqual([
      'mine',
      'owners',
      'priority',
      'stale_before',
      'focus',
      'search',
    ])
    const reordered = boardRequest(
      project,
      { search: '', focus: true, stale: false, priority: 'high', assignees: [], mine: false },
      CUTOFF,
    )
    expect(reordered).toEqual({ kind: 'ask', key })
    // any change is another key
    expect(sent(project, { priority: 'low', focus: true }).key).not.toBe(key)
  })

  it('sends the people deduplicated and sorted, as typed', () => {
    const { args } = sent(project, { assignees: ['b', 'A', 'b', 'a'] })
    expect(args.filters.owners).toEqual(['A', 'a', 'b'])
    expect(sent(project, { assignees: ['a', 'b'] }).key).toBe(
      sent(project, { assignees: ['b', 'a', 'a'] }).key,
    )
  })

  it('sends a known priority only', () => {
    expect(sent(project, { priority: 'urgent' }).args.filters.priority).toBe('urgent')
    expect(sent(project, { priority: 'someday' }).args.filters.priority).toBeNull()
  })

  it('sends the text trimmed, and spaces alone as no text', () => {
    expect(sent(project, { search: '  cable  ' }).args.filters.search).toBe('cable')
    expect(sent(project, { search: '   ' }).key).toBe(sent(project, {}).key)
    // the text to send, which typing delays, may differ from the one shown
    const typed = boardRequest(project, { ...NONE, search: 'cab' }, CUTOFF, 'ca')
    expect(typed.kind === 'ask' && JSON.parse(typed.key).filters.search).toBe('ca')
  })

  it('sends nothing for a text past LIMITS.search, and the longest that fits', () => {
    expect(boardRequest(project, { ...NONE, search: 'x'.repeat(201) }, CUTOFF)).toEqual({
      kind: 'search_limit',
    })
    expect(boardRequest(project, { ...NONE, search: ` ${'x'.repeat(200)} ` }, CUTOFF).kind).toBe(
      'ask',
    )
  })

  it('sends the hour-floored cutoff while Stale is on, and none while it is off', () => {
    expect(sent(project, { stale: true }).args.filters.stale_before).toBe(CUTOFF)
    expect(sent(project, {}).args.filters.stale_before).toBeNull()
  })

  it('asks to choose a project in All projects, and sends My view as the mine scope', () => {
    expect(boardRequest(ALL, NONE, CUTOFF)).toEqual({ kind: 'choose' })
    expect(sent(MINE, {}).args.scope).toEqual({ kind: 'mine' })
    expect(sent(project, {}).args.scope).toEqual({
      kind: 'project',
      org_id: 'org',
      project_id: 'sub',
    })
  })
})

describe('the Stale cutoff', () => {
  const at = (iso: string) => staleCutoff(Date.parse(iso))
  it('is STALE_DAYS before now, floored to the hour', () => {
    const now = Date.parse('2026-10-31T14:35:12.000Z')
    expect(staleCutoff(now)).toBe(
      new Date(Math.floor((now - STALE_DAYS * 86_400_000) / 3_600_000) * 3_600_000).toISOString(),
    )
    expect(Date.parse(staleCutoff(now))).toBeLessThanOrEqual(now - STALE_DAYS * 86_400_000)
  })

  it('stays the same within an hour and moves at the next one', () => {
    expect(at('2026-10-31T14:00:00.000Z')).toBe(at('2026-10-31T14:59:59.999Z'))
    expect(at('2026-10-31T15:00:00.000Z')).not.toBe(at('2026-10-31T14:59:59.999Z'))
  })
})

describe('the filter row the Board applies', () => {
  it('reads no text on the phone, and no people filter in My view', () => {
    const row = { ...NONE, search: 'cable', assignees: ['p'], mine: false }
    expect(boardFilters({ mine: false }, row, 'phone')).toEqual({ ...row, search: '' })
    expect(boardFilters({ mine: false }, row, 'desktop')).toEqual(row)
    expect(boardFilters({ mine: true }, row, 'desktop')).toEqual({
      ...row,
      mine: true,
      assignees: [],
    })
    expect(boardFilters({ mine: true }, row, 'phone')).toEqual({
      ...row,
      search: '',
      mine: true,
      assignees: [],
    })
  })
})
