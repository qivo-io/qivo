import { describe, expect, it } from 'vitest'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import { createWorkspaceRows } from './rowMap'
import { createTaskIndex, type TaskSources } from './taskIndex'
import { createWorkspaceBase } from './workspaceBase'

/* The task index keeps the tasks up to date a change at a time, and must
   always hold what a full build from the same rows gives. */

const AT = '2026-09-14T08:00:00.000Z'

describe('the task index', () => {
  /** Rows over a base holding `snap`, and the sources the index reads. */
  function workspace(snap: Snapshot) {
    const base = createWorkspaceBase()
    const rows = createWorkspaceRows(base)
    base.stage(structuredClone(snap))
    rows.beginRepaint()
    rows.takeDirty()
    const sources = (): TaskSources => ({
      issues: rows.issues,
      links: rows.links,
      attachments: rows.attachments,
      labels: rows.labels,
      issueLabels: rows.list('issueLabels'),
      issueSubs: rows.list('issueSubs'),
      orgLoad: rows.list('orgLoad'),
      hiddenSubtaskParents: rows.flags('hiddenSubtaskParents'),
      hiddenParentTasks: rows.flags('hiddenParentTasks'),
      homeOrg: snap.orgs[0].id,
      mine: new Set(snap.myProfileIds),
      capacity: new Map(),
      defaultCapacity: 40,
    })
    /** Delivers `next` and answers what the rows say changed, for update. */
    const deliver = (next: Snapshot) => {
      base.stage(structuredClone(next))
      rows.beginRepaint()
      const dirty = rows.takeDirty()
      return {
        issues: dirty.keys.get('issues') ?? new Set<string>(),
        links: dirty.keys.get('links') ?? new Set<string>(),
        attachments: dirty.keys.get('attachments') ?? new Set<string>(),
        labels: dirty.keys.has('labels'),
        issueLabels: dirty.lists.has('issueLabels'),
        issueSubs: dirty.lists.has('issueSubs'),
        orgLoad: dirty.lists.has('orgLoad'),
        flags: dirty.flags,
      }
    }
    return { sources, deliver }
  }

  const task = (snap: Snapshot, id: string, num: number): Snapshot['issues'][number] => ({
    id,
    org_id: snap.orgs[0].id,
    project_id: snap.projects[0].id,
    num,
    title: `Task ${id}`,
    description: '',
    status: 'todo',
    priority: 'medium',
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  })

  it('moves a task whose number changed to its place by number', () => {
    const snap = plannerFixture()
    snap.issues = [task(snap, 'a', 1), task(snap, 'b', 2)]
    const { sources, deliver } = workspace(snap)
    const index = createTaskIndex()
    index.full(sources())
    // a create's preview number moves when another create takes it
    snap.issues[0].num = 3
    const moved = index.update(sources(), deliver(snap))
    expect(moved).toEqual(new Map([['QN-1', 'QN-3']]))
    const fresh = createTaskIndex()
    fresh.full(sources())
    expect(index.issues().map((it) => it.key)).toEqual(['QN-2', 'QN-3'])
    expect(index.issues()).toEqual(fresh.issues())
  })
})
