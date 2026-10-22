import { describe, expect, it } from 'vitest'
import { LIMITS } from '../convex/lib/limits'
import {
  parseSeedArgs,
  planSeed,
  runBoardScaleSeed,
  seededNumbers,
  seededTask,
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
    expect(Math.max(...tasks.map((task) => task.title.length))).toBe(LIMITS.title.max)
    expect(tasks.every((task) => task.title.startsWith('Board scale '))).toBe(true)
  })

  it('plans only the task numbers still missing, family by family', () => {
    const fresh = planSeed(60, new Set())
    expect(fresh.added).toBe(60)
    // a family every 25th task: its first task, a parent and three more
    expect(fresh.list.filter((job) => job.family).map((job) => job.first)).toEqual([0, 25, 50])
    // a re-run finds 0 to 9 and 30 to 59, and adds 10 to 29 without repeats
    const present = new Set([...Array(10).keys(), ...Array.from({ length: 30 }, (_, i) => i + 30)])
    const resumed = planSeed(60, present)
    expect(resumed.list.map((job) => job.first)).toEqual([
      ...Array.from({ length: 15 }, (_, i) => i + 10),
      25,
      29,
    ])
    expect(resumed.added).toBe(20)
    // a family whose first task exists is not made again
    expect(planSeed(30, new Set([25])).list.some((job) => job.first === 25)).toBe(false)
    expect(planSeed(60, new Set(Array(60).keys())).added).toBe(0)
  })

  it('reads the seeded numbers from the titles, not the parents or other tasks', () => {
    const numbers = seededNumbers([
      { title: 'Board scale ship task 12' },
      { title: 'Board scale parent 26' },
      { title: 'Board scale calibrate task 1 with a longer note on the work it covers' },
      { title: 'Order the pilot batch' },
    ])
    expect([...numbers].sort((a, b) => a - b)).toEqual([0, 11])
  })
})
