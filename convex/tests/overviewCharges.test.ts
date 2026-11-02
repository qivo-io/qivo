/* The fixed-size charges of the Overview's My view lists (lib/overview.ts
 * charges): every task a read returned in a project the reader may not see
 * counts at lib/limits.ts TASK_ROW_MAX_BYTES once for each time a read
 * returned it, so its text moves no answer. Each read is counted through a
 * database that tallies the tasks every query returns, and each charge
 * through the view budget, wrapped here. In a file of its own, as the
 * wrapper holds for every test of its file. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { type ListAnswer, readPaused } from '../lib/overview'
import { newT, plantIssue, plantSeat, type T, uuid, withOrg } from './helpers.setup'

process.env.BETTER_AUTH_SECRET ??= 'overview-charges-secret-not-a-deployment-key'

/* The fixed charges standing for each document, by _id: one for each
 * charge, less one for each refund. */
const charged = vi.hoisted(() => new Map<string, number>())

vi.mock('../lib/viewReads', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/viewReads')>()
  const tally = (doc: Record<string, unknown>, by: number) => {
    const id = String(doc._id)
    charged.set(id, (charged.get(id) ?? 0) + by)
  }
  return {
    ...real,
    viewBudget: (...a: Parameters<typeof real.viewBudget>) => {
      const guard = real.viewBudget(...a)
      return {
        ...guard,
        charge: (doc: Record<string, unknown>, size: number) => {
          tally(doc, 1)
          guard.charge(doc, size)
        },
        refund: (doc: Record<string, unknown>, size: number) => {
          tally(doc, -1)
          guard.refund(doc, size)
        },
      }
    },
  }
})

afterEach(() => {
  vi.useRealTimers()
})

/* `db` with each task a query returns tallied in `returned`, by _id, once
 * for each time a query returned it. */
function tallyingDb(db: QueryCtx['db'], returned: Map<string, number>): QueryCtx['db'] {
  const tally = (out: unknown) => {
    for (const doc of Array.isArray(out) ? out : [out])
      if (doc !== null && typeof doc === 'object' && '_id' in doc) {
        const id = String(doc._id)
        returned.set(id, (returned.get(id) ?? 0) + 1)
      }
  }
  // a query of tasks, each step of its chain wrapped, its results tallied
  const wrap = <O extends object>(query: O): O =>
    new Proxy(query, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          const out = value.apply(target, args)
          if (out instanceof Promise)
            return out.then((r: unknown) => {
              tally(r)
              return r
            })
          return out !== null && typeof out === 'object' ? wrap(out) : out
        }
      },
    })
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'query')
        return (table: Parameters<QueryCtx['db']['query']>[0]) =>
          table === 'issues' ? wrap(target.query(table)) : target.query(table)
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/* One batch of `me`'s My view Paused list after `cursor`, with how many
 * times a read returned each task. */
async function pausedBatch(t: T, me: Doc<'profiles'>, cursor?: string) {
  charged.clear()
  const returned = new Map<string, number>()
  const answer = await t.run((ctx) =>
    readPaused(
      { ...ctx, db: tallyingDb(ctx.db, returned) },
      new Map([[me.org_id, me]]),
      'auth_me',
      {
        scope: { kind: 'mine' },
        ...(cursor === undefined ? {} : { cursor }),
      },
    ),
  )
  if (answer.state !== 'ok') throw new Error(JSON.stringify(answer))
  return { answer, returned, charged: new Map(charged) }
}

describe('fixed-size charges', () => {
  it('charges each read of a task the reader may not see, the rows of retried takes past one creation time included', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a member who sees FW only
    const me = await plantSeat(t, { org_id: f.org.id, org_role: 'user', auth_user_id: 'auth_me' })
    await t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: f.sub.id, profile_id: me.id, level: 'user' }),
    )
    // 60 of their undated paused tasks at one creation time, one in four in
    // FW and the rest in PCB, which they cannot see: convex-test gives an
    // insert 0.001 ms after the one before, which rounds away above 2^52 ms
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(2 ** 52)
    const tied: Doc<'issues'>[] = []
    for (let i = 0; i < 60; i++)
      tied.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: i % 4 === 0 ? f.sub.id : f.sub2.id,
          title: `Tied ${uuid()}`,
          assignee_id: me.id,
          paused: true,
        }),
      )
    vi.useRealTimers()
    expect(new Set(tied.map((task) => task._creationTime))).toEqual(new Set([2 ** 52]))
    const hidden = tied.filter((task) => task.project_id === f.sub2.id).map((task) => task._id)
    const shown = tied.filter((task) => task.project_id === f.sub.id).map((task) => task.title)

    const rows: string[] = []
    const batches: (ListAnswer & { state: 'ok' })[] = []
    let rereads = 0
    let cursor: string | undefined
    for (let n = 0; n < 5; n++) {
      const got = await pausedBatch(t, me, cursor)
      // every task the reader may not see counts at the fixed size once for
      // each time a read returned it, and every row of the batch at its own
      for (const id of hidden) expect(got.charged.get(id) ?? 0, id).toBe(got.returned.get(id) ?? 0)
      for (const row of got.answer.rows) {
        const task = tied.find((it) => it.id === row.id) as Doc<'issues'>
        expect(got.charged.get(task._id) ?? 0, row.title).toBe(0)
      }
      rereads += hidden.filter((id) => (got.returned.get(id) ?? 0) > 1).length
      rows.push(...got.answer.rows.map((row) => row.title))
      batches.push(got.answer)
      if (got.answer.next === null) break
      cursor = got.answer.next
    }
    // the second batch's cursor sits among the tied rows, so its reads take
    // again past the rows before it, and every shown task is a row once
    expect(batches.map((b) => b.rows.length)).toEqual([10, 5])
    expect(rereads).toBeGreaterThan(0)
    expect([...rows].sort()).toEqual([...shown].sort())
  })
})
