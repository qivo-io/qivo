import { describe, expect, it } from 'vitest'
import { DELETED_PAGE } from '../../convex/model/deletedItemsPage'
import {
  alongText,
  blockedText,
  type DeletedAction,
  type DeletedItemsOutcome,
  type DeletedRow,
  type Deleter,
  destinations,
  endText,
  faultText,
  fold,
  foldText,
  heldAnswer,
  heldOf,
  itemSuffix,
  type Line,
  lineKey,
  linesOf,
  notesOf,
  PAGE_ROWS,
  type Piece,
  pauseText,
  placeText,
  planOf,
  progressText,
  type RestoreRefusal,
  restoreToast,
  SELECT_MOST,
  stopText,
  subtitleOf,
  viaText,
} from './deletedItems'

/* Rows as deletedItems.page projects them, at local times on 16 Oct 2026.
   The helpers sort, filter and count nothing a page answers; each case
   says what the page shows for one answer, with cases that must pass and
   cases that must not. */
const NOW = new Date(2026, 9, 16, 15, 0)
const at = (h: number, m: number, s = 0) => new Date(2026, 9, 16, h, m, s).toISOString()
const DANIEL: Deleter = {
  you: false,
  profile_id: 'd',
  name: 'Daniel Berg',
  kind: 'app',
  who: 'd|app',
}
const CURSOR: Deleter = {
  ...DANIEL,
  kind: 'mcp_tokens',
  credential_name: 'Cursor',
  who: 'd|mcp_tokens:t1',
}
const HIDDEN: Deleter = { ...DANIEL, kind: 'mcp_tokens', who: 'd|mcp_tokens' }

function row(id: string, patch: Partial<DeletedRow> = {}): DeletedRow {
  return {
    id,
    org_id: 'org',
    org_name: 'Northstar Labs',
    kind: 'task',
    key: `QN-${id}`,
    title: `Task ${id}`,
    counts: { tasks: 1, archived_tasks: 0, subtasks: 0, sub_projects: 0 },
    projects: [],
    path: ['Luma Sensor', 'Firmware'],
    archived: false,
    deleted_at: at(14, 9),
    deleter: CURSOR,
    state: 'ready',
    can_restore: true,
    can_purge: false,
    ...patch,
  }
}
/** `n` task rows a minute apart, newest first, as lines. */
const run = (n: number, deleter = CURSOR, from = 0): Line[] =>
  Array.from({ length: n }, (_, i) => ({
    kind: 'item' as const,
    row: row(String(from + i), { deleter, deleted_at: at(14, 30 - from - i) }),
  }))
const shape = (pieces: Piece[]) => pieces.map((p) => (p.kind === 'line' ? 'row' : p.kind))

describe('folding a run of deletes', () => {
  it('folds 11 rows of one who to 7 and a fold line, and shows them all once open', () => {
    const lines = run(11)
    const closed = fold(lines, new Set())
    expect(shape(closed)).toEqual([...Array(7).fill('row'), 'fold'])
    const line = closed[7]
    if (line.kind !== 'fold') throw new Error('no fold line')
    expect(line.hidden.map((r) => r.id)).toEqual(['7', '8', '9', '10'])
    expect(foldText(line.hidden, NOW)).toBe(
      'and 4 more tasks Daniel Berg deleted via Cursor, today 14:20 to 14:23',
    )
    const open = fold(lines, new Set([line.key]))
    expect(shape(open)).toEqual([...Array(11).fill('row'), 'fewer'])
  })

  it('leaves 10 rows, other credentials, long gaps and project rows unfolded', () => {
    expect(shape(fold(run(10), new Set()))).not.toContain('fold')
    // the same person with a hidden token and a named one are two keys
    const mixed = [...run(6, CURSOR), ...run(6, HIDDEN, 6)]
    expect(shape(fold(mixed, new Set()))).not.toContain('fold')
    // more than 10 minutes between two rows ends the run
    const gap = run(12).map((line, i) =>
      line.kind === 'item' && i >= 6
        ? { ...line, row: { ...line.row, deleted_at: at(13, 50 - i) } }
        : line,
    )
    expect(shape(fold(gap, new Set()))).not.toContain('fold')
    // a project row ends the run
    const lines = run(12)
    lines.splice(6, 0, { kind: 'item', row: row('p', { kind: 'project', deleter: CURSOR }) })
    expect(shape(fold(lines, new Set()))).not.toContain('fold')
  })

  it('keeps an open run open when newer rows arrive, by its who and oldest row', () => {
    const lines = run(12)
    const first = fold(lines, new Set())
    const line = first.find((p) => p.kind === 'fold')
    if (line?.kind !== 'fold') throw new Error('no fold line')
    const newer: Line = { kind: 'item', row: row('new', { deleted_at: at(14, 31) }) }
    expect(shape(fold([newer, ...lines], new Set([line.key])))).toContain('fewer')
    // a run that lost its oldest row is another run
    expect(shape(fold(lines.slice(0, 11), new Set([line.key])))).toContain('fold')
  })
})

describe('who deleted it', () => {
  it('names the credential where the viewer may, and its kind where not', () => {
    expect(viaText(CURSOR, 'row')).toBe(' via Cursor, personal token')
    expect(viaText(CURSOR, 'sentence')).toBe(' via Cursor (personal token)')
    expect(viaText(HIDDEN, 'row')).toBe(' via a personal token')
    expect(viaText({ ...HIDDEN, kind: 'agent_keys' }, 'row')).toBe(' via an agent key')
    expect(viaText(DANIEL, 'row')).toBe('')
  })
})

describe('what a row says', () => {
  it('names what a task or project holds and where it sat', () => {
    expect(
      itemSuffix(
        row('1', { counts: { tasks: 3, archived_tasks: 0, subtasks: 2, sub_projects: 0 } }),
      ),
    ).toBe('and 2 subtasks')
    const top = row('p', {
      kind: 'project',
      path: [],
      counts: { tasks: 48, archived_tasks: 9, subtasks: 0, sub_projects: 2 },
    })
    expect(itemSuffix(top)).toBe('with 2 sub-projects and 48 tasks')
    expect(placeText(top)).toBe('')
    const sub = { ...top, path: ['Website'], counts: { ...top.counts, tasks: 12, sub_projects: 0 } }
    expect(itemSuffix(sub)).toBe('and its 12 tasks')
    expect(placeText(sub)).toBe('Sub-project in Website')
    expect(itemSuffix(row('r', { redacted: true, counts: { ...top.counts, subtasks: 2 } }))).toBe(
      '',
    )
  })

  it('says why a row cannot be restored, with the lead when there is one', () => {
    expect(blockedText({ reason: 'view_only', project: 'Website', lead: 'Aisha Khan' })).toBe(
      'You can only view Website now. Ask its lead, Aisha Khan, to restore it.',
    )
    expect(blockedText({ reason: 'view_only', project: 'Website' })).toBe(
      'You can only view Website now. Ask an organization admin to restore it.',
    )
    expect(blockedText({ reason: 'not_lead', project: 'Specs', lead: 'Daniel Berg' })).toBe(
      'Specs has its own lead, Daniel Berg. Ask them or an organization admin to restore it.',
    )
    // no lead passes today's lead rule, so the row names none
    expect(blockedText({ reason: 'not_lead', project: 'Specs' })).toBe(
      'Specs has no lead now. Ask an organization admin to restore it.',
    )
    // a project the row cannot name starts the sentence as "This project"
    expect(blockedText({ reason: 'not_lead' })).toBe(
      'This project has no lead now. Ask an organization admin to restore it.',
    )
    expect(blockedText({ reason: 'project_archived', project: 'Website' })).toBe(
      'Restore Website from Archived projects first.',
    )
    expect(blockedText({ reason: 'read_only' })).toBe(
      'Restoring is paused while the organization is read-only.',
    )
    expect(blockedText({ reason: 'project_deleted', item_id: 'x' }, 'Field trial Q3')).toBe(
      'Its project, Field trial Q3, is in Deleted items too.',
    )
    // the redacted row says it in its own words
    expect(blockedText({ reason: 'no_access' })).toBeNull()
  })
})

describe('the lines of a page', () => {
  const hit = { key: 'QN-12', title: 'Book test sites', archived: false, path: ['Trial', 'Sites'] }
  it('keeps the server’s order, makes hit lines and leaves out an entry without its row', () => {
    const p = row('p', { kind: 'project' })
    const a = row('a')
    const lines = linesOf({
      entries: [
        { item_id: 'p' },
        { item_id: 'p', task: hit },
        { item_id: 'gone' },
        // the server orders it, and it stays where it is
        { item_id: 'a' },
      ],
      items: [a, p],
    })
    expect(lines).toEqual([
      { kind: 'item', row: p },
      { kind: 'hit', hit, item: p },
      { kind: 'item', row: a },
    ])
    expect(lines.map(lineKey)).toEqual(['p', 'p:QN-12', 'a'])
    expect(linesOf(null)).toEqual([])
  })

  it('folds within the lines of one page only', () => {
    // a run of 11 split 6 and 5 over two pages folds on neither
    expect(shape(fold(run(6), new Set()))).not.toContain('fold')
    expect(shape(fold(run(5, CURSOR, 6), new Set()))).not.toContain('fold')
    // a hit line ends a run
    const lines = run(12)
    lines.splice(6, 0, { kind: 'hit', hit, item: row('p', { kind: 'project' }) })
    expect(shape(fold(lines, new Set()))).not.toContain('fold')
  })

  it('pins the page’s 25 to the server’s', () => {
    expect(PAGE_ROWS).toBe(DELETED_PAGE.rows)
    expect(SELECT_MOST.items).toBe(1000)
  })
})

describe('what the page says from the server’s answers', () => {
  it('words the subtitle for each role and each mix of seats', () => {
    expect(subtitleOf([])).toBe('')
    expect(subtitleOf([{ role: 'admin' }])).toBe(
      'Tasks and projects deleted in your organization. Their files count toward its storage until they are deleted for good.',
    )
    expect(subtitleOf([{ role: 'lead' }, { role: 'lead' }])).toBe(
      'Tasks and projects you deleted, and those deleted in projects you lead.',
    )
    expect(subtitleOf([{ role: 'user' }])).toBe('Tasks and projects you deleted.')
    expect(subtitleOf([{ role: 'user' }, { role: 'lead' }])).toBe(
      'Tasks and projects you deleted, and those deleted in projects you lead.',
    )
    expect(subtitleOf([{ role: 'admin' }, { role: 'lead' }])).toBe(
      'Tasks and projects deleted in the organizations you administer, those you deleted and those deleted in projects you lead. Files of items deleted in an organization you administer count toward its storage until they are deleted for good.',
    )
    expect(subtitleOf([{ role: 'admin' }, { role: 'user' }])).toBe(
      'Tasks and projects deleted in the organizations you administer, and those you deleted. Files of items deleted in an organization you administer count toward its storage until they are deleted for good.',
    )
  })

  it('says each note only where the answer does', () => {
    const page = { entries: [{ item_id: 'p' }] }
    expect(notesOf(null, false)).toEqual([])
    expect(notesOf({ ...page, scope_needed: true }, false).map((n) => n.text)).toEqual([
      'Deleted tasks show once you choose projects.',
    ])
    // the scope line of an empty page without a search is the end line's
    expect(notesOf({ entries: [], scope_needed: true }, false)).toEqual([])
    expect(notesOf({ entries: [], scope_needed: true }, true)).toHaveLength(1)
    expect(notesOf({ ...page, missing: 'reads' }, false).map((n) => n.key)).toEqual(['reads'])
    expect(notesOf({ ...page, missing: 'matches', legacy: true }, true)).toEqual([
      { key: 'matches', text: 'Some matching tasks might not be listed.' },
      {
        key: 'legacy',
        text: 'Tasks deleted before this version of Qivo are found by their key or title only, and Assigned to may miss them.',
      },
    ])
    expect(notesOf(page, true)).toEqual([])
  })

  it('holds a scope too wide to list and a part Qivo could not check, never as empty', () => {
    const empty = { entries: [], next_cursor: null }
    expect(heldAnswer({ ...empty, too_wide: true })).toBe(true)
    expect(heldAnswer({ ...empty, missing: 'reads' })).toBe(true)
    // a stopped page with a cursor shows Next, an empty last page its end line
    expect(heldAnswer({ entries: [], next_cursor: 'c', missing: 'reads' })).toBe(false)
    expect(heldAnswer(empty)).toBe(false)
    expect(heldOf({ too_wide: true })).toEqual({
      line: "Qivo can't list the deleted items of these projects together. Choose fewer projects.",
      retry: false,
    })
    expect(heldOf(null)).toEqual({
      line: "Qivo couldn't check the deleted items here. Choose fewer projects.",
      retry: true,
    })
  })

  it('words Delete now’s count for each answer, and keeps it off while counting', () => {
    expect(alongText(undefined)).toEqual({
      text: ' Counting the items deleted from the project earlier…',
      ready: false,
    })
    expect(alongText({ along: 0, exact: true })).toEqual({ text: '', ready: true })
    expect(alongText({ along: 3, exact: true }).text).toBe(
      ' It also deletes 3 items deleted from the project earlier.',
    )
    expect(alongText({ along: 1000, exact: false }).text).toBe(
      ' It also deletes at least 1,000 items deleted from the project earlier.',
    )
    expect(alongText({ along: 0, exact: false }).text).toBe(
      ' It also deletes any items deleted from the project earlier.',
    )
    for (const failed of [null, 'failed'] as const)
      expect(alongText(failed)).toEqual({
        text: " Qivo couldn't count the items deleted from the project earlier. Deleting it for good deletes them too.",
        ready: true,
      })
  })
})

describe('a restore in steps', () => {
  const tasks = (org: string, n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => row(`${org}${from + i}`, { org_id: org }))
  it('plans calls of 25 per organization, projects first, and says when it takes rounds', () => {
    const items = [
      ...tasks('a', 24),
      row('sub', { org_id: 'a', kind: 'project', path: ['Luma'] }),
      row('top', { org_id: 'a', kind: 'project', path: [] }),
      ...tasks('a', 1, 24),
    ]
    const plan = planOf(items, 25)
    expect(plan.total).toBe(27)
    expect(plan.lanes).toHaveLength(1)
    const [lane] = plan.lanes
    expect(lane.calls.map((c) => c.length)).toEqual([25, 2])
    expect(lane.calls[0].slice(0, 3)).toEqual(['top', 'sub', 'a0'])
    // a 26th item never goes in the first call
    expect(lane.calls[1]).toEqual(['a23', 'a24'])
    expect(plan.long).toBe(true)
    // two organizations of one call each are one round at two lanes
    expect(planOf([...tasks('a', 25), ...tasks('b', 25)], 25).long).toBe(false)
    expect(planOf([...tasks('a', 1), ...tasks('b', 1), ...tasks('c', 1)], 25).long).toBe(true)
    // each id once
    expect(planOf([row('x'), row('x')], 25).total).toBe(1)
  })

  const action = (patch: Partial<DeletedAction> = {}): DeletedAction => ({
    kind: 'restore',
    state: 'running',
    long: true,
    noun: '180 tasks',
    total: 180,
    done: 75,
    refused: 0,
    lanes: 1,
    lanesDone: 0,
    pending: [],
    stops: [],
    ...patch,
  })
  it('words the progress line', () => {
    expect(progressText(action())).toBe('Restoring 180 tasks, 75 done')
    expect(progressText(action({ lanes: 2, lanesDone: 1 }))).toBe(
      'Restoring 180 tasks, 75 done, 1 of 2 organizations finished',
    )
    expect(progressText(action({ kind: 'purge', noun: '2 items', done: 1 }))).toBe(
      'Deleting 2 items for good, 1 done',
    )
  })

  it('ends with what the answers confirmed, deferred items following and never restored', () => {
    const asked = tasks('a', 180)
    const tally = { kind: 'restore' as const, asked, stepping: 0, refused: 0 }
    expect(endText({ ...tally, done: 180, following: [], unsent: [] })).toEqual({
      text: 'Restored 180 tasks.',
      tone: 'success',
    })
    expect(endText({ ...tally, done: 180, stepping: 3, following: [], unsent: [] }).text).toBe(
      'Restored 180 tasks. 3 of them finish restoring in the background.',
    )
    expect(endText({ ...tally, done: 178, following: asked.slice(0, 2), unsent: [] })).toEqual({
      text: 'Restored 178 of 180 tasks. 2 follow once their project is back.',
      tone: 'success',
    })
    expect(endText({ ...tally, done: 170, refused: 10, following: [], unsent: [] })).toEqual({
      text: "Restored 170 of 180 tasks. 10 couldn't be restored.",
      tone: 'error',
    })
  })

  it('words a stop by organization and the pause once', () => {
    const stop = {
      org_id: 'a',
      org_name: 'Northstar Labs',
      total: 180,
      done: 100,
      refused: 25,
      unsent: 55,
      reason: 'Restoring is paused while the organization is read-only.',
      paused: false,
    }
    const noun = (n: number) => `${n} tasks`
    expect(stopText('restore', stop, noun)).toBe(
      "Restoring stopped after 100 of 180 tasks in Northstar Labs. 25 couldn't be restored and 55 were not sent. They stay in Deleted items. Restoring is paused while the organization is read-only.",
    )
    expect(stopText('restore', { ...stop, done: 0, refused: 0, unsent: 1 }, noun)).toBe(
      'Restoring stopped in Northstar Labs before it restored any item. 1 was not sent. They stay in Deleted items. Restoring is paused while the organization is read-only.',
    )
    const lane = { org_name: 'Northstar Labs', done: 100, stepping: 0, following: 0 }
    const paused = { ...lane, refused: 0, unsent: 55 }
    expect(
      pauseText(
        'restore',
        [paused, { ...paused, org_name: 'Partner Co', done: 25, unsent: 5 }],
        noun,
        'Qivo is offline.',
      ),
    ).toBe(
      'Restoring stopped after 100 tasks in Northstar Labs and 25 in Partner Co. 60 were not sent. They stay in Deleted items. Qivo is offline.',
    )
    // a finished organization counts, its background restores and
    // deferred items too, and refused and unsent work apart
    expect(
      pauseText(
        'restore',
        [
          { ...lane, done: 30, stepping: 2, following: 1, refused: 0, unsent: 0 },
          { ...lane, org_name: 'Partner Co', done: 0, refused: 25, unsent: 5 },
        ],
        noun,
        'Qivo is offline.',
      ),
    ).toBe(
      "Restoring stopped after 30 tasks in Northstar Labs. 2 of them finish restoring in the background. 1 follows once its project is back. 25 couldn't be restored and 5 were not sent. They stay in Deleted items. Qivo is offline.",
    )
    expect(
      pauseText('purge', [{ ...lane, done: 0, refused: 0, unsent: 3 }], noun, 'Qivo is offline.'),
    ).toBe(
      'Deleting for good stopped before it deleted any item. 3 were not sent. They stay in Deleted items. Qivo is offline.',
    )
    expect(faultText('purge')).toBe(
      'Deleting for good stopped after a fault in Qivo. What it already did stays done.',
    )
  })

  const outcome = (patch: Partial<DeletedItemsOutcome<RestoreRefusal>> = {}) => ({
    done: [],
    stepping: [],
    refused: [],
    deferred: [],
    failed: [],
    unsent: [],
    unknown: [],
    error: null,
    ...patch,
  })
  it('says a restore of one round as the page shows it, a deferred item as following', () => {
    const trial = row('trial', { kind: 'project', title: 'Field trial Q3', path: [] })
    const task = row('12', { key: 'QN-12' })
    expect(
      restoreToast([trial], outcome({ done: ['trial'], deferred: ['12'] }), undefined, [
        trial,
        task,
      ]),
    ).toEqual({ text: 'Restored “Field trial Q3”. QN-12 follows once its project is back.' })
    expect(restoreToast([task], outcome({ done: ['12'] }))).toEqual({ text: 'Restored QN-12.' })
    expect(restoreToast([task], outcome({ done: ['12'], stepping: ['12'] })).text).toBe(
      'Restoring QN-12…',
    )
    expect(restoreToast([task], outcome({ refused: [{ id: '12', reason: 'view_only' }] }))).toEqual(
      { text: "Couldn't restore QN-12. You can only view its project now.", tone: 'error' },
    )
    const three = [task, row('13'), row('14')]
    expect(restoreToast(three, outcome({ done: ['12', '13'], failed: ['14'] }))).toEqual({
      text: "Restored 2 of 3 tasks. 1 couldn't be restored.",
      tone: 'error',
    })
    // a deferred item never counts as restored
    expect(restoreToast(three, outcome({ done: ['12'], deferred: ['13', '14'] })).text).toBe(
      'Restored QN-12. QN-13 and QN-14 follow once their project is back.',
    )
  })
})

describe('the bulk restore window', () => {
  it('lists each project item, then the places tasks go back to, most first', () => {
    const rows = [
      row('1'),
      row('2'),
      row('3', {
        path: ['Website', 'Docs'],
        counts: { tasks: 1, archived_tasks: 0, subtasks: 2, sub_projects: 0 },
      }),
      row('p', {
        kind: 'project',
        title: 'Field trial Q3',
        path: [],
        counts: { tasks: 48, archived_tasks: 0, subtasks: 0, sub_projects: 2 },
      }),
    ]
    expect(destinations(rows).map((d) => [d.name, d.count])).toEqual([
      ['Field trial Q3', 'project with 2 sub-projects and 48 tasks'],
      ['Luma Sensor › Firmware', '2 tasks'],
      ['Website › Docs', '1 task and 2 subtasks'],
    ])
  })
})
