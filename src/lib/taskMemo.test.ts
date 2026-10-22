import { describe, expect, it } from 'vitest'
import { sameReads } from './taskMemo'

/* A task memo is worked out again only when a task changed in what it reads. */

const read = (task: { id: string; start: number }) => [task.start]
const tasks = Array.from({ length: 5 }, (_, n) => ({ id: `t${n}`, start: n, title: `Task ${n}` }))

describe('sameReads', () => {
  it('holds while the changed tasks read the same', () => {
    expect(sameReads(tasks, tasks, read)).toBe(true)
    const renamed = tasks.map((task, n) => (n === 2 ? { ...task, title: 'Renamed' } : task))
    expect(sameReads(tasks, renamed, read)).toBe(true)
  })

  it('fails for a changed value, another order or another count', () => {
    const moved = tasks.map((task, n) => (n === 2 ? { ...task, start: 9 } : task))
    expect(sameReads(tasks, moved, read)).toBe(false)
    expect(sameReads(tasks, [tasks[1], tasks[0], ...tasks.slice(2)], read)).toBe(false)
    expect(sameReads(tasks, tasks.slice(1), read)).toBe(false)
  })
})
