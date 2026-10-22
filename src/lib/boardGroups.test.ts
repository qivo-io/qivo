import { describe, expect, it } from 'vitest'
import { taskOwnerId } from '../../convex/lib/review'
import {
  type BoardCellGroup,
  type BoardCellIssue,
  boardDropPatch,
  eagerCounts,
  estimateCardHeight,
  groupBoardAssignees,
  groupBoardCell,
  type MetaItem,
  MIN_CARD_PITCH,
  sideEagerCounts,
} from './boardGroups'

describe('groupBoardAssignees', () => {
  const nameOf = (id: string) =>
    ({ person: 'Zoë', agent: 'Atlas', other: 'Zoë' })[id] || 'Unknown user'

  it('groups scoped tasks by profile, sorts people and agents by name, and puts Unassigned last', () => {
    const tasks = [
      { id: 'a', owner: 'person' },
      { id: 'b', owner: null },
      { id: 'c', owner: 'agent' },
      { id: 'd', owner: 'person' },
    ]
    const lanes = groupBoardAssignees(tasks, tasks, nameOf)
    expect(lanes.map((lane) => [lane.owner, lane.items.map((task) => task.id)])).toEqual([
      ['agent', ['c']],
      ['person', ['a', 'd']],
      [null, ['b']],
    ])
  })

  it('files a task waiting In Review under its reviewer, and under its assignee otherwise', () => {
    const task = (id: string, status: 'review' | 'progress', reviewer?: string) => ({
      id,
      owner: taskOwnerId({ status, assignee_id: 'person', reviewer_id: reviewer }),
    })
    const tasks = [
      task('reviewed', 'review', 'agent'),
      task('working', 'progress', 'agent'),
      task('unreviewed', 'review'),
    ]
    const lanes = groupBoardAssignees(tasks, tasks, nameOf)
    expect(lanes.map((lane) => [lane.key, lane.items.map((item) => item.id)])).toEqual([
      ['assignee:agent', ['reviewed']],
      ['assignee:person', ['working', 'unreviewed']],
    ])
  })

  it('retains scoped lanes emptied by Focus without restoring their filtered tasks', () => {
    const tasks = [
      { id: 'a', owner: 'person' },
      { id: 'b', owner: 'agent' },
      { id: 'c', owner: null },
    ]
    const lanes = groupBoardAssignees(tasks, [tasks[0]], nameOf)
    expect(lanes.map((lane) => [lane.owner, lane.items.length])).toEqual([
      ['agent', 0],
      ['person', 1],
      [null, 0],
    ])
    expect(groupBoardAssignees([tasks[0]], [tasks[0]], nameOf)).toHaveLength(1)
  })

  it('keeps same-name and historical profiles distinct from each other and Unassigned', () => {
    const tasks = [
      { id: 'a', owner: 'person' },
      { id: 'b', owner: 'other' },
      { id: 'c', owner: 'historical' },
      { id: 'd' },
      { id: 'e', owner: null },
    ]
    const lanes = groupBoardAssignees(tasks, tasks, nameOf)
    expect(lanes.map((lane) => lane.key)).toEqual([
      'assignee:historical',
      'assignee:other',
      'assignee:person',
      'assignee:unassigned',
    ])
    expect(lanes[3].items.map((task) => task.id)).toEqual(['d', 'e'])
  })

  it('splits siblings by owner while retaining the accessible parent as context', () => {
    const parent = issue('parent', { children: ['a', 'b'] })
    const a = { ...issue('a', { parent: parent.id }), owner: 'person' }
    const b = { ...issue('b', { parent: parent.id }), owner: 'agent' }
    const byId = index([parent, a, b])
    const lanes = groupBoardAssignees([a, b], [a, b], nameOf)
    const cells = lanes.map((lane) => groupBoardCell<Issue>(lane.items, byId))
    expect(cells.map((cell) => cell[0].parent?.id)).toEqual(['parent', 'parent'])
    expect(cells.map((cell) => cell[0].issues.map((task) => task.id))).toEqual([['b'], ['a']])
  })
})

describe('boardDropPatch', () => {
  const todo = { status: 'todo', assignee: 'a' } as const
  const working = { status: 'progress', assignee: 'a', reviewer: 'r' } as const
  const inReview = { status: 'review', assignee: 'a', reviewer: 'r' } as const

  it('writes the status alone on a board without lanes', () => {
    expect(boardDropPatch(inReview, 'done')).toEqual({ status: 'done' })
  })

  it('writes the status alone when the card already belongs to the lane', () => {
    expect(boardDropPatch(todo, 'progress', 'a')).toEqual({ status: 'progress' })
    expect(boardDropPatch(working, 'review', 'a')).toEqual({ status: 'review' })
  })

  it("returns a Review card to its assignee without reassigning when it leaves the reviewer's lane", () => {
    expect(boardDropPatch(inReview, 'progress', 'r')).toStrictEqual({ status: 'progress' })
  })

  it('writes the status alone when the status move itself hands the card to the lane', () => {
    expect(boardDropPatch(inReview, 'progress', 'a')).toStrictEqual({ status: 'progress' })
  })

  it('sets the reviewer on a cross-lane drop into the Review column', () => {
    const unreviewed = { status: 'progress', assignee: 'a' } as const
    expect(boardDropPatch(unreviewed, 'review', 'b')).toEqual({ status: 'review', reviewer: 'b' })
    expect(boardDropPatch(inReview, 'review', 'b')).toEqual({ reviewer: 'b' })
  })

  it("clears the reviewer on a Review drop into the assignee's own lane", () => {
    expect(boardDropPatch(inReview, 'review', 'a')).toStrictEqual({ reviewer: null })
  })

  it('refuses a Review drop onto Unassigned while the task has an assignee', () => {
    expect(boardDropPatch(inReview, 'review', null)).toBeNull()
    const noAssignee = { status: 'review', assignee: null, reviewer: 'r' } as const
    expect(boardDropPatch(noAssignee, 'review', null)).toEqual({ reviewer: null })
  })

  it('reassigns on a cross-lane drop outside the Review column', () => {
    expect(boardDropPatch(todo, 'todo', 'b')).toEqual({ assignee: 'b' })
    expect(boardDropPatch(todo, 'todo', null)).toEqual({ assignee: null })
    expect(boardDropPatch(inReview, 'todo', 'b')).toEqual({ status: 'todo', assignee: 'b' })
  })

  it('writes nothing for an identical drop', () => {
    expect(boardDropPatch(inReview, 'review', 'r')).toEqual({})
    expect(boardDropPatch(todo, 'todo')).toEqual({})
  })
})

type Issue = BoardCellIssue & { title: string; status: string; lane: string }

function issue(id: string, extra: Partial<Issue> = {}): Issue {
  return { id, uuid: `uuid-${id}`, title: id, status: 'todo', lane: 'hardware', ...extra }
}

function index(issues: Issue[]): Record<string, Issue> {
  return Object.fromEntries(issues.map((item) => [item.id, item]))
}

function actualIssues(groups: BoardCellGroup<Issue>[]): Issue[] {
  return groups.flatMap((group) => group.issues)
}

describe('groupBoardCell', () => {
  it('collects siblings under parent context without an actual parent task', () => {
    const parent = issue('parent', { children: ['child-1', 'child-2'] })
    const first = issue('child-1', { parent: parent.id })
    const second = issue('child-2', { parent: parent.id })
    const all = [first, parent, second]

    expect(groupBoardCell(all, index(all))).toEqual([
      {
        key: `parent:${parent.uuid}`,
        parent,
        ancestors: [],
        issues: [first, second],
      },
    ])
  })

  it('repeats only parent context across status and swimlane boundaries', () => {
    const parent = issue('parent', { children: ['todo', 'doing', 'software'] })
    const todo = issue('todo', { parent: parent.id })
    const doing = issue('doing', { parent: parent.id, status: 'doing' })
    const software = issue('software', { parent: parent.id, lane: 'software' })
    const byId = index([parent, todo, doing, software])

    const cells = [
      groupBoardCell([parent, todo], byId),
      groupBoardCell([doing], byId),
      groupBoardCell([software], byId),
    ]
    expect(cells.map((cell) => cell.map((group) => group.parent?.id))).toEqual([
      ['parent'],
      ['parent'],
      ['parent'],
    ])
    expect(cells.flatMap(actualIssues)).toEqual([todo, doing, software])
  })

  it('keeps a filtered-out accessible parent as context without adding hidden siblings', () => {
    const parent = issue('parent', { children: ['visible', 'hidden'] })
    const visible = issue('visible', { parent: parent.id })
    const hidden = issue('hidden', { parent: parent.id })

    const groups = groupBoardCell([visible], index([parent, visible, hidden]))
    expect(groups).toEqual([
      { key: `parent:${parent.uuid}`, parent, ancestors: [], issues: [visible] },
    ])
    expect(actualIssues(groups)).toEqual([visible])
  })

  it('keeps tasks with missing parents independent and can still show their own children', () => {
    const orphan = issue('orphan', { parent: 'inaccessible' })
    const parent = issue('parent', { parent: 'inaccessible', children: ['child'] })
    const child = issue('child', { parent: parent.id })
    const all = [orphan, parent, child]

    expect(groupBoardCell(all, index(all))).toEqual([
      { key: `issue:${orphan.uuid}`, parent: null, ancestors: [], issues: [orphan] },
      { key: `parent:${parent.uuid}`, parent, ancestors: [], issues: [child] },
    ])
  })

  it('ignores a parents own status when its children are outside this cell', () => {
    const parent = issue('parent', { children: ['elsewhere'] })
    const elsewhere = issue('elsewhere', { parent: parent.id, status: 'done' })

    expect(groupBoardCell([parent], index([parent, elsewhere]))).toEqual([])
  })

  it('orders groups by their first visible member and preserves child priority order', () => {
    const parent = issue('parent', { children: ['high', 'low'] })
    const high = issue('high', { parent: parent.id })
    const low = issue('low', { parent: parent.id })
    const solo = issue('solo')
    const otherParent = issue('other-parent', { children: ['other-child'] })
    const otherChild = issue('other-child', { parent: otherParent.id })
    const all = [high, solo, otherChild, low, parent, otherParent]

    const groups = groupBoardCell(all, index(all))
    expect(groups.map((group) => group.key)).toEqual([
      `parent:${parent.uuid}`,
      `issue:${solo.uuid}`,
      `parent:${otherParent.uuid}`,
    ])
    expect(groups[0].issues).toEqual([high, low])
    expect(groups[2].issues).toEqual([otherChild])
  })

  it('retains nested parents and ancestors solely as headings for leaf work', () => {
    const root = issue('root', { children: ['middle'] })
    const middle = issue('middle', { parent: root.id, children: ['leaf'] })
    const leaf = issue('leaf', { parent: middle.id })
    const all = [leaf, middle, root]

    const groups = groupBoardCell(all, index(all))
    expect(groups).toEqual([
      { key: `parent:${middle.uuid}`, parent: middle, ancestors: [root], issues: [leaf] },
    ])
    expect(
      actualIssues(groups)
        .map((item) => item.id)
        .sort(),
    ).toEqual(['leaf'])
  })

  it('does not duplicate a visible parent when its children list is incomplete', () => {
    const parent = issue('parent')
    const child = issue('child', { parent: parent.id })
    const all = [parent, child]

    expect(groupBoardCell(all, index(all))).toEqual([
      { key: `parent:${parent.uuid}`, parent, ancestors: [], issues: [child] },
    ])
  })

  it('keeps UUID keys stable when display handles change', () => {
    const parent = issue('QN-10', { uuid: 'stable-parent', children: ['QN-11'] })
    const child = issue('QN-11', { uuid: 'stable-child', parent: parent.id })
    const solo = issue('QN-12', { uuid: 'stable-solo' })
    const renamedParent = { ...parent, id: 'QN-20', children: ['QN-21'] }
    const renamedChild = { ...child, id: 'QN-21', parent: renamedParent.id }
    const renamedSolo = { ...solo, id: 'QN-22' }
    const before = [parent, child, solo]
    const after = [renamedParent, renamedChild, renamedSolo]

    expect(groupBoardCell(before, index(before)).map((group) => group.key)).toEqual(
      groupBoardCell(after, index(after)).map((group) => group.key),
    )
  })

  it('handles malformed self links, cycles, and duplicate inputs without recursion', () => {
    const self = issue('self', { parent: 'self', children: ['self'] })
    const first = issue('first', { parent: 'second', children: ['second'] })
    const second = issue('second', { parent: 'first', children: ['first'] })
    const all = [self, first, second]

    const groups = groupBoardCell([...all, first], index(all))
    expect(actualIssues(groups)).toEqual([self])
    const leaf = issue('leaf', { parent: first.id })
    const nested = groupBoardCell([leaf, leaf], index([...all, leaf]))
    expect(actualIssues(nested)).toEqual([leaf])
    expect(nested[0].ancestors).toEqual([second])
  })

  it('keeps parents with inaccessible children out of status columns', () => {
    const parent = issue('parent', { isGroup: true, children: [] })
    expect(groupBoardCell([parent], index([parent]))).toEqual([])
  })

  it('restores the parent as an ordinary task when its last child is removed', () => {
    const parent = issue('parent', { status: 'review', children: ['child'] })
    const child = issue('child', { parent: parent.id })
    expect(actualIssues(groupBoardCell([parent, child], index([parent, child])))).toEqual([child])

    const restored: Issue = { ...parent, children: [] }
    expect(groupBoardCell([restored], index([restored]))).toEqual([
      { key: `issue:${parent.uuid}`, parent: null, ancestors: [], issues: [restored] },
    ])
    expect(restored.status).toBe('review')
  })

  it('accepts frozen inputs and leaves issue objects and source order untouched', () => {
    const parent = issue('parent', { children: ['child'] })
    const child = issue('child', { parent: parent.id })
    Object.freeze(parent.children)
    Object.freeze(parent)
    Object.freeze(child)
    const all = Object.freeze([child, parent])
    const byId = Object.freeze(index([parent, child]))

    const groups = groupBoardCell(all, byId)
    expect(groups[0].parent).toBe(parent)
    expect(groups[0].issues[0]).toBe(child)
    expect(all).toEqual([child, parent])
    expect(groupBoardCell([], byId)).toEqual([])
  })
})

describe('estimateCardHeight', () => {
  type Task = BoardCellIssue & {
    title: string
    late?: boolean
    placed?: boolean
    meta?: MetaItem[]
  }
  const icon = { width: 11, height: 11 }
  const text = (width: number) => ({ width, height: 17.4 })
  const task = (id: string, title = 'Testbed signed firmware task 12', more: Partial<Task> = {}) =>
    ({ id, uuid: id, title, ...more }) as Task
  const card = (issues: Task[], parent: Task | null = null, ancestors: Task[] = []) => ({
    key: issues[0]?.id ?? parent?.id ?? 'card',
    parent,
    ancestors,
    issues,
  })
  const shown = {
    banner: (it: Task) => !!it.late,
    placed: (it: Task) => !!it.placed,
    // the priority mark and the hours, one line
    meta: (it: Task) => it.meta ?? [icon, text(21)],
  }
  const height = (group: BoardCellGroup<Task>, width = 203) =>
    estimateCardHeight(group, width, shown)

  it('matches the measured plain card, and the pitch is its height and gap', () => {
    // 81.17px measured for a two-line title at 203px (see the constants)
    expect(height(card([task('a')]))).toBe(82)
    // the least card: one title line and the priority mark alone
    expect(height(card([task('a', 'Short', { meta: [icon] })]))).toBe(MIN_CARD_PITCH - 8 + 1)
    expect(height(card([task('a', 'Short', { meta: [] })]))).toBeLessThan(
      height(card([task('a', 'Short')])),
    )
  })

  it('wraps the meta line as the card does', () => {
    // measured at 203px: the mark, then a 156px place on a line of its own
    // (32px), and the mark with 10h, then the place (39px)
    const title = 'Board scale calibrate task 341'
    expect(height(card([task('a', title, { meta: [icon, text(156)] })]))).toBe(
      Math.ceil(2 + 16 + 2 * 18.9 + 8 + 11 + 4 + 17.4),
    )
    expect(height(card([task('a', title, { meta: [icon, text(21), text(156)] })]))).toBe(
      Math.ceil(2 + 16 + 2 * 18.9 + 8 + 17.4 + 4 + 17.4),
    )
    // the mark, the place and a due date that fit one wide card's line
    expect(height(card([task('a', 'Short', { meta: [icon, text(60), text(85)] })]), 400)).toBe(
      Math.ceil(2 + 16 + 18.9 + 8 + 17.4),
    )
  })

  it('never falls for a longer title, a banner, a place, more rows or a narrower card', () => {
    const base = card([task('a')], task('p'), [task('g')])
    const before = height(base)
    const grown = [
      card([task('a', 'A long title '.repeat(6))], task('p'), [task('g')]),
      card([task('a', undefined, { late: true })], task('p'), [task('g')]),
      card([task('a', undefined, { meta: [icon, text(21), text(156)] })], task('p'), [task('g')]),
      card([task('a')], task('p', undefined, { placed: true }), [task('g')]),
      card([task('a'), task('b')], task('p'), [task('g')]),
      card([task('a')], task('p'), [task('g'), task('h')]),
    ]
    for (const group of grown) expect(height(group)).toBeGreaterThan(before)
    expect(height(base, 150)).toBeGreaterThan(before)
    for (let width = 400; width > 60; width -= 7)
      expect(height(base, width - 7)).toBeGreaterThanOrEqual(height(base, width))
  })

  it('caps a title at the four lines a card shows', () => {
    const long = height(card([task('a', 'word '.repeat(200))]))
    expect(height(card([task('a', 'word '.repeat(400))]))).toBe(long)
    // the two-line card and two more 18.9px lines
    expect(long).toBe(Math.ceil(81.17 + 2 * 18.9))
  })
})

describe('eagerCounts', () => {
  // the first screen: a 400px window and 500px more
  const budget = 900
  const fit = Math.floor((budget - 46 - 8) / MIN_CARD_PITCH)

  it('fills one tall lane up to the first screen in every cell', () => {
    expect(eagerCounts([{ headed: true, cells: [5000, 3, 0, 5000] }], budget)).toEqual([
      [fit, 3, 0, fit],
    ])
    // a lane without a heading has its height for cards too
    expect(eagerCounts([{ headed: false, cells: [5000] }], 1000)[0][0]).toBe(
      Math.floor((1000 - 8) / MIN_CARD_PITCH),
    )
    expect(eagerCounts([{ headed: true, cells: [5000] }], 1000)[0][0]).toBe(
      Math.floor((1000 - 46 - 8) / MIN_CARD_PITCH),
    )
  })

  it('walks many short lanes until the first screen is used up', () => {
    const lanes = Array.from({ length: 40 }, () => ({ headed: true, cells: [1, 2, 0] }))
    const counts = eagerCounts(lanes, budget)
    const full = counts.findIndex((row) => row.every((n) => n === 0))
    expect(counts.slice(0, full - 1).every((row) => row.join() === '1,2,0')).toBe(true)
    expect(full).toBeGreaterThan(3)
    expect(counts.slice(full).every((row) => row.every((n) => n === 0))).toBe(true)
    // a lane that starts inside the screen fits what is left of it
    const total = counts.flat().reduce((a, b) => a + b, 0)
    expect(total * MIN_CARD_PITCH).toBeLessThanOrEqual(budget)
  })

  it('mounts no cards of side-boards that start beyond the window', () => {
    const counts = sideEagerCounts(
      Array.from({ length: 8 }, () => [100, 100]),
      budget,
      1000,
    )
    // 20px of inset, then 248px boards 8px apart: four start inside 1000px
    expect(counts.map((row) => row[0] > 0)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
      false,
      false,
    ])
    // each board walks its own statuses: the second gets what the first left
    expect(counts[0][0] + counts[0][1]).toBeLessThanOrEqual(Math.floor(budget / MIN_CARD_PITCH))
    expect(counts[0][1]).toBeLessThan(counts[0][0])
  })
})
