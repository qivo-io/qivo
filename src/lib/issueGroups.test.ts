import { describe, expect, it } from 'vitest'
import { type GroupIssue, groupProgress, isIssueDone, isIssueGroup } from './issueGroups'

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
