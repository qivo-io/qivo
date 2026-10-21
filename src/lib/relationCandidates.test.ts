import { describe, expect, it } from 'vitest'
import { SUBTASK_MAX } from '../../convex/lib/taskLimits'
import {
  parentBlock,
  parentCandidatesFor,
  type RelationTask,
  type RelationView,
  subtaskBlock,
  subtaskCandidatesFor,
} from './relationCandidates'

/* Two top-level projects: WEB with sub-projects FE and BE, and HW with FW.
 * RO is a sub-project of WEB the person can only read. epic > open > leaf
 * is a legacy chain from before the one level of subtasks. */
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
  it('offers editable top-level tasks of the same top-level project, own sub-project first', () => {
    const { tasks, byId, view } = scene()
    // the epic is the current parent; backend is a sibling sub-project's task
    expect(ids(parentCandidatesFor(byId.sibling, tasks, view))).toEqual(['epic', 'backend'])
  })

  it('leaves out subtasks, tasks of another top-level project and read-only ones', () => {
    const { tasks, byId, view } = scene([task('hidden', 'FE', { hasHiddenParent: true })])
    const offered = ids(parentCandidatesFor(byId.sibling, tasks, view))
    for (const id of ['open', 'leaf', 'hidden', 'firmware', 'readonly', 'foreign', 'sibling']) {
      expect(offered).not.toContain(id)
    }
  })

  it('leaves out a task that already has the most subtasks', () => {
    const full = Array.from({ length: SUBTASK_MAX }, (_, i) => `kid${i}`)
    const { tasks, byId, view } = scene([
      task('full', 'FE', { children: full }),
      task('roomy', 'FE', { children: full.slice(1) }),
    ])
    const offered = ids(parentCandidatesFor(byId.sibling, tasks, view))
    expect(offered).toContain('roomy')
    expect(offered).not.toContain('full')
  })

  it('offers a task with subtasks only its current parent, so it can be cleared', () => {
    const { tasks, byId, view } = scene()
    // open has a subtask and a parent, which stays listed so it can go
    expect(ids(parentCandidatesFor(byId.open, tasks, view))).toEqual(['epic'])
    expect(parentBlock(byId.open)).toBe('A task with subtasks cannot become a subtask')
    expect(parentBlock(byId.epic)).toBe('A task with subtasks cannot become a subtask')
    expect(parentBlock(byId.sibling)).toBeUndefined()
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
  it('offers editable tasks without subtasks of the same top-level project', () => {
    const { tasks, byId, view } = scene()
    // epic and open have subtasks; leaf is a subtask that may change parent
    expect(ids(subtaskCandidatesFor(byId.backend, tasks, view))).toEqual(['leaf', 'sibling'])
  })

  it('offers a subtask only its current subtasks, so they can be removed', () => {
    const { tasks, byId, view } = scene()
    expect(ids(subtaskCandidatesFor(byId.open, tasks, view))).toEqual(['leaf'])
    expect(subtaskBlock(byId.open)).toBe('A subtask cannot have subtasks')
    expect(subtaskBlock(byId.backend)).toBeUndefined()
  })

  it('offers a full task only its current subtasks', () => {
    const kids = Array.from({ length: SUBTASK_MAX }, (_, i) => `kid${i}`)
    const { tasks, byId, view } = scene([
      task('full', 'FE', { children: kids }),
      ...kids.map((id) => task(id, 'FE', { parent: 'full' })),
    ])
    const offered = ids(subtaskCandidatesFor(byId.full, tasks, view))
    expect(offered).toEqual(kids)
    expect(subtaskBlock(byId.full)).toBe(
      `This task has ${SUBTASK_MAX} active subtasks, the most a task can have`,
    )
  })

  it('leaves out tasks of another top-level project and read-only ones', () => {
    const { tasks, byId, view } = scene()
    const offered = ids(subtaskCandidatesFor(byId.sibling, tasks, view))
    for (const id of ['firmware', 'readonly', 'foreign']) expect(offered).not.toContain(id)
  })

  it('keeps a current subtask in another top-level project so it can be removed', () => {
    const { tasks, byId, view } = scene([task('stray', 'FW', { parent: 'sibling' })])
    const offered = ids(subtaskCandidatesFor(byId.sibling, tasks, view))
    expect(offered).toContain('stray')
    expect(offered).not.toContain('firmware')
  })
})
