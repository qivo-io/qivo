import { describe, expect, it } from 'vitest'
import {
  parentCandidatesFor,
  type RelationTask,
  type RelationView,
  subtaskCandidatesFor,
} from './relationCandidates'

/* Two top-level projects: WEB with sub-projects FE and BE, and HW with FW.
 * RO is a sub-project of WEB the person can only read. */
const projects: Record<string, string> = { FE: 'WEB', BE: 'WEB', RO: 'WEB', FW: 'HW' }
const task = (id: string, project: string, extra: Partial<RelationTask> = {}): RelationTask => ({
  id,
  org: 'org',
  project,
  ...extra,
})

function scene(extra: RelationTask[] = []) {
  const tasks = [
    task('epic', 'BE', { children: ['open'] }),
    task('open', 'FE', { parent: 'epic', children: ['leaf'] }),
    task('leaf', 'FE', { parent: 'open' }),
    task('sibling', 'FE'),
    task('backend', 'BE'),
    task('firmware', 'FW'),
    task('readonly', 'RO'),
    task('foreign', 'FE', { org: 'other' }),
    ...extra,
  ]
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]))
  const view: RelationView<RelationTask> = {
    byId,
    topLevelOf: (projectId) => projects[projectId],
    canWrite: (projectId) => projectId !== 'RO',
  }
  return { tasks, byId, view }
}
const ids = (list: RelationTask[]) => list.map((t) => t.id)

describe('parent candidates', () => {
  it('offers editable tasks of the same top-level project, own sub-project first', () => {
    const { tasks, byId, view } = scene()
    // the epic is the current parent; backend is a sibling sub-project's task
    expect(ids(parentCandidatesFor(byId.open, tasks, view))).toEqual(['sibling', 'epic', 'backend'])
  })

  it('leaves out tasks of another top-level project, read-only ones and the subtree', () => {
    const { tasks, byId, view } = scene()
    const offered = ids(parentCandidatesFor(byId.open, tasks, view))
    for (const id of ['firmware', 'readonly', 'foreign', 'open', 'leaf']) {
      expect(offered).not.toContain(id)
    }
  })

  it('keeps a current parent in another top-level project so it can be cleared', () => {
    const { tasks, byId, view } = scene([task('legacy', 'FE', { parent: 'firmware' })])
    const offered = ids(parentCandidatesFor(byId.legacy, tasks, view))
    expect(offered).toContain('firmware')
    expect(offered).not.toContain('readonly')
  })

  it('offers nothing beyond the current parent for a project outside this view', () => {
    const { tasks, view } = scene()
    const lost = task('lost', 'GONE', { parent: 'epic' })
    expect(ids(parentCandidatesFor(lost, tasks, view))).toEqual(['epic'])
  })
})

describe('subtask candidates', () => {
  it('offers editable tasks of the same top-level project except the chain above', () => {
    const { tasks, byId, view } = scene()
    // leaf is a current subtask and shows its check; epic is above the task
    expect(ids(subtaskCandidatesFor(byId.open, tasks, view))).toEqual([
      'leaf',
      'sibling',
      'backend',
    ])
  })

  it('leaves out tasks of another top-level project and read-only ones', () => {
    const { tasks, byId, view } = scene()
    const offered = ids(subtaskCandidatesFor(byId.backend, tasks, view))
    expect(offered).toEqual(['epic', 'open', 'leaf', 'sibling'])
  })

  it('keeps a current subtask in another top-level project so it can be removed', () => {
    const { tasks, byId, view } = scene([task('stray', 'FW', { parent: 'sibling' })])
    const offered = ids(subtaskCandidatesFor(byId.sibling, tasks, view))
    expect(offered).toContain('stray')
    expect(offered).not.toContain('firmware')
  })
})
