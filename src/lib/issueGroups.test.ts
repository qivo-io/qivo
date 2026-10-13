import { describe, expect, it } from 'vitest'
import {
  type DatedGroupIssue,
  type GroupIssue,
  groupProgress,
  groupSpan,
  isIssueDone,
  isIssueGroup,
} from './issueGroups'

describe('group task completion', () => {
  it('counts only leaves through nested groups, regardless of group statuses', () => {
    const rows: Record<string, GroupIssue> = {
      root: { id: 'root', status: 'done', children: ['nested', 'open'] },
      nested: { id: 'nested', status: 'backlog', children: ['finished'] },
      open: { id: 'open', status: 'todo' },
      finished: { id: 'finished', status: 'done' },
    }
    expect(groupProgress(rows.root, rows)).toEqual({ total: 2, done: 1, pct: 50, unknown: false })
    expect(isIssueDone(rows.root, rows)).toBe(false)
    expect(isIssueDone(rows.nested, rows)).toBe(true)
    rows.open.status = 'done'
    rows.root.status = 'backlog'
    expect(isIssueDone(rows.root, rows)).toBe(true)
  })

  it('resumes the saved status when the last child is removed', () => {
    const parent = { id: 'parent', status: 'done', children: ['child'] }
    const rows = { child: { id: 'child', status: 'todo' } }
    expect(isIssueGroup(parent)).toBe(true)
    expect(isIssueDone(parent, rows)).toBe(false)
    parent.children = []
    expect(isIssueGroup(parent)).toBe(false)
    expect(isIssueDone(parent, rows)).toBe(true)
  })

  it('does not treat hidden children, missing branches or cycles as completed work', () => {
    const parent: GroupIssue = {
      id: 'parent',
      status: 'done',
      children: ['child'],
      hasHiddenSubtasks: true,
    }
    const rows = { parent, child: { id: 'child', status: 'done' } }
    expect(isIssueDone(parent, rows)).toBe(false)
    expect(groupProgress(parent, rows)).toEqual({ total: 1, done: 1, pct: 100, unknown: true })
    parent.hasHiddenSubtasks = false
    parent.children = ['missing']
    expect(isIssueDone(parent, rows)).toBe(false)
    parent.children = ['parent']
    expect(isIssueDone(parent, rows)).toBe(false)
    expect(groupProgress(parent, rows)).toEqual({ total: 0, done: 0, pct: 0, unknown: true })
    parent.children = []
    parent.hasHiddenSubtasks = true
    expect(isIssueGroup(parent)).toBe(true)
    expect(isIssueDone(parent, rows)).toBe(false)
  })
})

describe('group calculated dates', () => {
  const tree = (): Record<string, DatedGroupIssue> => ({
    root: { id: 'root', status: 'todo', start: 40, end: 50, children: ['nested', 'early'] },
    nested: { id: 'nested', status: 'todo', start: 0, end: 99, children: ['late', 'unplanned'] },
    early: { id: 'early', status: 'done', start: 3, end: 4 },
    late: { id: 'late', status: 'progress', start: 6, end: 9 },
    unplanned: { id: 'unplanned', status: 'todo', start: null, end: null },
  })

  it('spans the visible scheduled leaves and ignores stored group dates at any depth', () => {
    const rows = tree()
    // Done leaves count; the unplanned leaf and both stored group spans do not
    expect(groupSpan(rows.root, rows)).toEqual({ start: 3, end: 9, partial: false })
    expect(groupSpan(rows.nested, rows)).toEqual({ start: 6, end: 9, partial: false })
    rows.late.start = 5
    rows.late.end = 5
    expect(groupSpan(rows.root, rows)).toEqual({ start: 3, end: 5, partial: false })
  })

  it('counts a leaf without an end as its start week', () => {
    const rows = tree()
    rows.late.end = null
    rows.late.start = 12
    expect(groupSpan(rows.root, rows)).toEqual({ start: 3, end: 12, partial: false })
  })

  it('has no dates when no visible leaf is scheduled', () => {
    const rows = tree()
    rows.early.start = null
    rows.early.end = null
    rows.late.start = null
    rows.late.end = null
    expect(groupSpan(rows.root, rows)).toEqual({ start: null, end: null, partial: false })
  })

  it('is partial when subtasks are hidden, missing or cyclic, without widening', () => {
    const rows = tree()
    rows.nested.hasHiddenSubtasks = true
    expect(groupSpan(rows.root, rows)).toEqual({ start: 3, end: 9, partial: true })
    rows.nested.hasHiddenSubtasks = false
    rows.root.children = ['nested', 'early', 'missing']
    expect(groupSpan(rows.root, rows)).toEqual({ start: 3, end: 9, partial: true })
    rows.root.children = ['nested', 'early']
    rows.nested.children = ['late', 'root']
    expect(groupSpan(rows.root, rows)).toEqual({ start: 3, end: 9, partial: true })
    // hidden subtasks alone make a group with nothing to show
    const lone: DatedGroupIssue = {
      id: 'lone',
      status: 'todo',
      start: 1,
      end: 2,
      hasHiddenSubtasks: true,
    }
    expect(groupSpan(lone, { lone })).toEqual({ start: null, end: null, partial: true })
  })

  it('returns null for a leaf, whatever its dates', () => {
    const rows = tree()
    expect(groupSpan(rows.late, rows)).toBeNull()
    expect(groupSpan(rows.unplanned, rows)).toBeNull()
  })

  it('lets datesOf override a leaf, falling back to its own dates', () => {
    const rows = tree()
    const drafts: Record<string, { start: number; end: number }> = { late: { start: 20, end: 22 } }
    expect(groupSpan(rows.root, rows, (leaf) => drafts[leaf.id])).toEqual({
      start: 3,
      end: 22,
      partial: false,
    })
    // a draft can also schedule a leaf the stored rows leave unplanned
    drafts.unplanned = { start: 1, end: 1 }
    expect(groupSpan(rows.root, rows, (leaf) => drafts[leaf.id])).toEqual({
      start: 1,
      end: 22,
      partial: false,
    })
  })
})
