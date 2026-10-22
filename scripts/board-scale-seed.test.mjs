import { describe, expect, it } from 'vitest'
import { LIMITS } from '../convex/lib/limits'
import {
  parseSeedArgs,
  planSeed,
  runBoardScaleSeed,
  seededTask,
  seededTasks,
} from './board-scale-seed.mjs'

const local = ['--local', '--deployment', 'local-scale-3214', '--url', 'http://127.0.0.1:3214']
const env = { QIVO_FIXTURE_LOCAL: 'true', QIVO_LOCAL_ADMIN_KEY: 'local-admin-key-1111' }

describe('board-scale-seed', () => {
  it('takes a local target and a task count', () => {
    expect(parseSeedArgs([...local, '--tasks', '500'])).toMatchObject({
      target: 'local',
      deployment: 'local-scale-3214',
      tasks: 500,
    })
    expect(parseSeedArgs(local).tasks).toBe(10_000)
  })

  it('refuses anything but a disposable local backend before it connects', async () => {
    expect(() => parseSeedArgs(['--url', 'http://127.0.0.1:3214'])).toThrow(/--local backend only/)
    expect(() => parseSeedArgs([...local, '--tasks', '0'])).toThrow(/--tasks/)
    // an organization much larger no longer loads through snapshot:forMe
    expect(() => parseSeedArgs([...local, '--tasks', '10001'])).toThrow(/1 to 10000/)
    expect(parseSeedArgs([...local, '--tasks', '10000']).tasks).toBe(10_000)
    const refused = (args, extra = {}) =>
      runBoardScaleSeed(args, { env: { ...env, ...extra }, log: () => {} })
    await expect(
      refused(['--local', '--deployment', 'local-scale-3214', '--url', 'https://x.convex.cloud']),
    ).rejects.toThrow(/loopback/)
    await expect(refused(local, { QIVO_ENVIRONMENT: 'production' })).rejects.toThrow(/refuses/)
    await expect(refused(local, { CONVEX_DEPLOY_KEY: 'prod:qva_1111111111' })).rejects.toThrow(
      /CONVEX_DEPLOY_KEY/,
    )
    await expect(refused(local, { QIVO_FIXTURE_LOCAL: '' })).rejects.toThrow(/QIVO_FIXTURE_LOCAL/)
  })

  it('mixes statuses, owners, due dates, pauses and long titles the server accepts', () => {
    const tasks = Array.from({ length: 1000 }, (_, n) => seededTask(n, 'org', 'project', 'owner'))
    expect(new Set(tasks.map((task) => task.status)).size).toBe(5)
    expect(tasks.filter((task) => task.assignee_id === null)).toHaveLength(91)
    expect(tasks.filter((task) => task.due_date).length).toBe(143)
    expect(tasks.some((task) => task.due_date && task.due_date < new Date().toISOString())).toBe(
      true,
    )
    expect(
      tasks.filter((task) => task.paused).every((t) => !['backlog', 'done'].includes(t.status)),
    ).toBe(true)
    expect(Math.max(...tasks.map((task) => task.title.length))).toBeLessThanOrEqual(
      LIMITS.title.max,
    )
    expect(Math.max(...tasks.map((task) => task.title.length))).toBeGreaterThan(
      LIMITS.title.max - 20,
    )
    // titles read like Northstar's: words, no numbers, about 40 characters
    const short = tasks.filter((_, n) => n % 13).map((task) => task.title.length)
    const median = short.sort((a, b) => a - b)[short.length >> 1]
    expect(median).toBeGreaterThan(30)
    expect(median).toBeLessThan(55)
    expect(tasks.some((task) => /\d/.test(task.title))).toBe(false)
    expect(new Set(tasks.map((task) => task.title)).size).toBeGreaterThan(300)
    expect(tasks[41].description).toBe('Seeded by board-scale-seed as task 42.')
  })

  it('plans only the tasks still missing, family by family', () => {
    const fresh = planSeed(60, new Map())
    expect(fresh.added).toBe(60)
    // a family every 25th task: its first task, a parent and three more
    expect(fresh.list.filter((job) => job.family).map((job) => job.first)).toEqual([0, 25, 50])
    const done = (numbers, parent = 'parent') =>
      new Map(numbers.map((n) => [n, { task: { id: `task${n}` }, parent: n % 25 ? null : parent }]))
    // a re-run finds 0 to 9 and 30 to 59, and adds 10 to 29 without repeats
    const present = done([...Array(10).keys(), ...Array.from({ length: 30 }, (_, i) => i + 30)])
    const resumed = planSeed(60, present)
    expect(resumed.list.map((job) => job.first)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => i + 10),
      25,
      29,
    ])
    expect(resumed.added).toBe(20)
    expect(planSeed(60, done([...Array(60).keys()])).added).toBe(0)
  })

  it('finishes a family a stopped run left partial, under the parent it made', () => {
    // the first task and its parent, then one of three subtasks
    const partial = planSeed(
      30,
      new Map([
        ...doneUpTo(25),
        [25, { task: { id: 'h' }, parent: 'p' }],
        [26, { task: {}, parent: 'p' }],
      ]),
    )
    expect(partial.list).toEqual([
      { first: 25, family: true, head: false, existing: { id: 'h' }, parent: 'p', missing: [2, 3] },
      { first: 29, family: false },
    ])
    expect(partial.added).toBe(3)
    // the first task alone: its parent and every subtask are still to make
    const headOnly = planSeed(
      30,
      new Map([...doneUpTo(25), [25, { task: { id: 'h' }, parent: null }]]),
    )
    expect(headOnly.list[0]).toEqual({
      first: 25,
      family: true,
      head: false,
      existing: { id: 'h' },
      parent: null,
      missing: [1, 2, 3],
    })
    expect(headOnly.added).toBe(4)
  })

  it('reads the seeded tasks from their marks and old titles, not parents or other tasks', () => {
    const found = seededTasks([
      { title: 'Tune the beta checklist', description: 'Seeded by board-scale-seed as task 12.' },
      { title: 'Board scale ship task 31', parent_id: 'p' },
      { title: 'Board scale parent 26' },
      { title: 'Coordinate sensor readings' },
      { title: 'Order the pilot batch', description: 'Not seeded as task 3.' },
    ])
    expect([...found.keys()].sort((a, b) => a - b)).toEqual([11, 30])
    expect(found.get(30)?.parent).toBe('p')
    expect(found.get(11)?.parent).toBe(null)
  })
})

/** The seeded tasks before `n`, families complete. */
function doneUpTo(n) {
  return Array.from({ length: n }, (_, i) => [
    i,
    { task: { id: `t${i}` }, parent: i % 25 ? null : 'p0' },
  ])
}
