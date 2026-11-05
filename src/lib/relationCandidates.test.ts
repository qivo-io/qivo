import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../convex/lib/limits'
import { parentBlock, type RelationTask, subtaskBlock } from './relationCandidates'

/* The window's own blocks. The tasks each picker offers, with the rules
 * these functions used to apply to the workspace's tasks, are the server's
 * now (convex/tests/relationPicker.test.ts). */
const task = (id: string, extra: Partial<RelationTask> = {}): RelationTask => ({
  id,
  org: 'org',
  project: 'FE',
  ...extra,
})

describe('the parent block', () => {
  it('blocks a task with subtasks, also only hidden ones', () => {
    expect(parentBlock(task('epic', { children: ['kid'] }))).toBe(
      'A task with subtasks cannot become a subtask',
    )
    expect(parentBlock(task('epic', { hasHiddenSubtasks: true }))).toBe(
      'A task with subtasks cannot become a subtask',
    )
  })

  it('leaves a task without subtasks open, a subtask too', () => {
    expect(parentBlock(task('leaf'))).toBeUndefined()
    expect(parentBlock(task('leaf', { parent: 'epic' }))).toBeUndefined()
  })
})

describe('the subtask block', () => {
  it('blocks a subtask, also one under a hidden parent', () => {
    expect(subtaskBlock(task('kid', { parent: 'epic' }))).toBe('A subtask cannot have subtasks')
    expect(subtaskBlock(task('kid', { hasHiddenParent: true }))).toBe(
      'A subtask cannot have subtasks',
    )
  })

  it('blocks a task that already has the most subtasks', () => {
    const children = Array.from({ length: LIMITS.subtasks.max }, (_, n) => `kid-${n}`)
    expect(subtaskBlock(task('full', { children }))).toBe(
      `This task has ${LIMITS.subtasks.max} active subtasks, the most a task can have. Archive or remove one of them first.`,
    )
  })

  it('leaves a top-level task with room for one more open', () => {
    const children = Array.from({ length: LIMITS.subtasks.max - 1 }, (_, n) => `kid-${n}`)
    expect(subtaskBlock(task('room', { children }))).toBeUndefined()
    expect(subtaskBlock(task('leaf'))).toBeUndefined()
  })
})
