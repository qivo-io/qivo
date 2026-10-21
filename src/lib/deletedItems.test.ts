import { describe, expect, it } from 'vitest'
import {
  ANYONE,
  blockedText,
  chosenProfile,
  type DeletedMatch,
  type DeletedRow,
  type Deleter,
  deletedAlong,
  deletedBy,
  deletedByOptions,
  destinations,
  fold,
  foldText,
  hitItem,
  itemSuffix,
  type Line,
  matchHasText,
  type Piece,
  placeText,
  shownMatch,
  shownRow,
  viaText,
} from './deletedItems'

/* Rows as deletedItems.list projects them, at local times on 16 Oct 2026. */
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
    if (!line || line.kind !== 'fold') throw new Error('no fold line')
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

  it('offers each person, then each way they deleted when there is more than one', () => {
    const you: Deleter = {
      you: true,
      profile_id: 'a',
      name: 'Aisha Khan',
      kind: 'app',
      who: 'a|app',
    }
    const gone: Deleter = { you: false, kind: 'app', who: '|app' }
    const rows = [
      row('1', { deleter: CURSOR }),
      row('2', { deleter: HIDDEN }),
      row('3', { deleter: DANIEL }),
      row('4', { deleter: gone }),
      row('5', { deleter: you }),
    ]
    expect(deletedByOptions(rows, false).map((o) => o.label)).toEqual([
      'Deleted by anyone',
      'You',
      'Daniel Berg',
      'Daniel Berg via a personal token',
      'Daniel Berg via Cursor',
      'Someone',
    ])
    // a person who deleted one way only gets no "via" choice
    expect(deletedByOptions([row('1')], false).map((o) => o.label)).toEqual([
      'Deleted by anyone',
      'Daniel Berg',
    ])
    const [, , person, hidden] = deletedByOptions(rows, false)
    const by = (deleter: Deleter, value: string) => deletedBy(row('x', { deleter }), value)
    expect(by(CURSOR, person.value) && by(DANIEL, person.value)).toBe(true)
    expect(by(HIDDEN, hidden.value)).toBe(true)
    expect(by(CURSOR, hidden.value)).toBe(false)
    expect(by(you, person.value)).toBe(false)
    expect(by(you, ANYONE)).toBe(true)
  })

  it('keeps people of two organizations apart, and names the organization last', () => {
    const gone: Deleter = { you: false, kind: 'app', who: '|app' }
    const claude: Deleter = {
      you: true,
      profile_id: 'me-a',
      name: 'Aisha Khan',
      kind: 'oauth_connections',
      credential_name: 'Claude',
      who: 'me-a|oauth_connections:c1',
    }
    const acme = { org_id: 'acme', org_name: 'Acme' }
    const rows = [
      row('1', { ...acme, deleter: gone }),
      row('2', { deleter: gone }),
      row('3', { deleter: claude }),
      row('4', { deleter: { ...claude, kind: 'app', who: 'me-a|app' } }),
    ]
    const options = deletedByOptions(rows, true)
    expect(options.map((o) => o.label)).toEqual([
      'Deleted by anyone',
      'You, Northstar Labs',
      'You via Claude, Northstar Labs',
      'Someone, Acme',
      'Someone, Northstar Labs',
    ])
    // every choice has its own value, so the select can tell them apart
    const values = options.map((o) => o.value)
    expect(new Set(values).size).toBe(values.length)
    // a "Someone" choice filters its own organization only
    const acmeSomeone = options[3].value
    expect(deletedBy(rows[0], acmeSomeone)).toBe(true)
    expect(deletedBy(rows[1], acmeSomeone)).toBe(false)
    expect(chosenProfile(acmeSomeone, rows)).toBeUndefined()
    // a "via" choice names the profile the server can narrow to
    expect(chosenProfile(options[2].value, rows)).toBe('me-a')
    expect(deletedBy(rows[2], options[2].value)).toBe(true)
    expect(deletedBy(rows[3], options[2].value)).toBe(false)
    expect(deletedBy(rows[2], 'person:')).toBe(false)
  })
})

describe('search hits', () => {
  const hit: DeletedMatch = {
    item_id: 'p',
    item_kind: 'project',
    org_id: 'org',
    org_name: 'Northstar Labs',
    key: 'QN-12',
    title: 'Book test sites in Umeå',
    archived: false,
    path: ['Field trial Q3', 'Site preparation'],
    deleted_at: at(14, 9),
    deleter: CURSOR,
    state: 'ready',
    can_restore: true,
  }
  it('keeps a hit of an older text only while its key or title holds the new one', () => {
    expect(matchHasText(hit, 'book t')).toBe(true)
    expect(matchHasText(hit, 'qn-12')).toBe(true)
    expect(matchHasText(hit, 'zebra')).toBe(false)
    // the path is not what the server searched
    expect(matchHasText(hit, 'field trial')).toBe(false)
  })

  it('stands for a task item as its own task row, and a project item as an unnamed project', () => {
    const blocked = { reason: 'view_only' as const, project: 'Luma Sensor' }
    const task = hitItem({
      ...hit,
      item_id: 't',
      item_kind: 'task',
      path: ['Luma Sensor', 'Firmware'],
      archived: true,
      can_restore: false,
      blocked,
    })
    expect(task).toMatchObject({
      id: 't',
      kind: 'task',
      key: 'QN-12',
      title: 'Book test sites in Umeå',
      path: ['Luma Sensor', 'Firmware'],
      archived: true,
      deleter: CURSOR,
      state: 'ready',
      can_restore: false,
      blocked,
      can_purge: false,
    })
    expect(task.redacted).toBeUndefined()
    expect(placeText(task)).toBe('Luma Sensor › Firmware')
    expect(itemSuffix(task)).toBe('')
    const redacted = hitItem({
      ...hit,
      item_kind: 'task',
      path: [],
      redacted: true,
      can_restore: false,
      blocked: { reason: 'no_access' },
    })
    expect(redacted).toMatchObject({ kind: 'task', redacted: true, path: [], can_restore: false })
    // a subtask's hit stands for its whole task item, named after the root,
    // whose place the hit does not tell
    const subtask = hitItem({
      ...hit,
      item_id: 't',
      item_kind: 'task',
      key: 'QN-15',
      title: 'Log the readings',
      root_key: 'QN-12',
      root_title: 'Calibrate the rig',
      archived: true,
    })
    expect(subtask).toMatchObject({
      id: 't',
      kind: 'task',
      key: 'QN-12',
      title: 'Calibrate the rig',
      path: [],
      archived: false,
    })
    expect(destinations([subtask])).toEqual([
      { key: 't', kind: 'task', name: 'QN-12 Calibrate the rig', count: 'task and its subtasks' },
    ])
    // a project item's hit names only the task, never the project
    expect(hitItem(hit)).toMatchObject({ id: 'p', kind: 'project', key: '', title: '', path: [] })
  })
})

/* Until 2026-10-16 a project took a blank name, and the list answers the
   name as it was stored. */
describe('a project saved with a blank name', () => {
  it('reads as an unnamed project or sub-project in a row and its place', () => {
    const sub = shownRow(row('s', { kind: 'project', title: ' ', path: [''] }))
    expect([sub.title, placeText(sub)]).toEqual([
      'Unnamed sub-project',
      'Sub-project in Unnamed project',
    ])
    expect(shownRow(row('m', { kind: 'project', title: '', path: [] })).title).toBe(
      'Unnamed project',
    )
    const task = shownRow(row('t', { path: ['', 'Firmware'] }))
    expect([task.title, placeText(task)]).toEqual(['Task t', 'Unnamed project › Firmware'])
    expect(placeText(shownRow(row('u', { path: [''] })))).toBe('Unnamed sub-project')
    // a name that is not blank stays as stored
    expect(shownRow(row('n')).path).toEqual(['Luma Sensor', 'Firmware'])
  })

  it('reads so in a search hit, which is a task in a sub-project', () => {
    const hit = (item_kind: 'task' | 'project', path: string[]): DeletedMatch => ({
      item_id: 'i',
      item_kind,
      org_id: 'org',
      org_name: 'Northstar Labs',
      key: 'QN-1',
      title: 'Calibrate',
      archived: false,
      path,
      deleted_at: at(14, 9),
      deleter: CURSOR,
      state: 'ready',
      can_restore: true,
    })
    expect(shownMatch(hit('task', ['', ' '])).path).toEqual([
      'Unnamed project',
      'Unnamed sub-project',
    ])
    // a task of a deleted top-level project saved with a blank name
    expect(shownMatch(hit('project', ['', ''])).path).toEqual([
      'Unnamed project',
      'Unnamed sub-project',
    ])
    expect(shownMatch(hit('project', ['Luma', ''])).path).toEqual(['Luma', 'Unnamed sub-project'])
    expect(blockedText({ reason: 'view_only', project: ' ' })).toBe(
      'You can only view its project now. Ask an organization admin to restore it.',
    )
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

describe('what Delete now deletes along with a project', () => {
  const project = (id: string, patch: Partial<DeletedRow> = {}) =>
    row(id, { kind: 'project', status: undefined, path: [], ...patch })
  const waits = (id: string, holder: string, patch: Partial<DeletedRow> = {}) =>
    row(id, {
      can_restore: false,
      blocked: { reason: 'project_deleted', item_id: holder },
      ...patch,
    })

  it('counts the items that wait for a project item, and those that wait for them', () => {
    const trial = project('trial')
    const blog = project('blog', {
      can_restore: false,
      blocked: { reason: 'parent_deleted', item_id: 'trial' },
    })
    // a row can come before the item it waits for
    const rows = [trial, waits('2', 'blog'), waits('1', 'trial'), blog, waits('3', 'web'), row('4')]
    expect(deletedAlong(trial, rows, false)).toEqual({ count: 3, exact: true })
    expect(deletedAlong(blog, rows, false)).toEqual({ count: 1, exact: true })
    // a task item takes nothing along, whatever the list holds
    expect(deletedAlong(rows[2], rows, true)).toEqual({ count: 0, exact: true })
  })

  it('does not count when the list may hold more than it names', () => {
    const trial = project('trial')
    expect(deletedAlong(trial, [trial, waits('1', 'trial')], true)).toEqual({
      count: 1,
      exact: false,
    })
    const stuck = row('5', { state: 'stuck', can_restore: false })
    expect(deletedAlong(trial, [trial, stuck], false).exact).toBe(false)
    // a stuck row of another organization cannot wait for it, nor can the item itself
    expect(deletedAlong(trial, [trial, { ...stuck, org_id: 'other' }], false).exact).toBe(true)
    const stuckTrial = project('trial', { state: 'stuck', can_restore: false })
    expect(deletedAlong(stuckTrial, [stuckTrial], false).exact).toBe(true)
  })
})
