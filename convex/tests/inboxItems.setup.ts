/* Shared by the inbox items suites (inboxItems.test.ts, inboxReads.test.ts,
 * inboxPage.test.ts): posting a message through the single insert path,
 * the check that every stored inbox_items row equals what its messages make
 * (drift), planting tasks with an item each (plantItems), messages from
 * before the items (plantLegacy), grants, archives without the archive's
 * read steps, and what one read costs (measure).
 *
 * Named *.setup.ts, as two dots in the basename is the Convex CLI's skip
 * rule (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId, newWindowKey } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { insertTask } from '../model/descriptions'
import { covers, type ItemFields, itemOf } from '../model/inboxItems'
import { postMessage } from '../model/messages'
import { NOW, type OrgFixture, type T, uuid } from './helpers.setup'

const MINUTE = 60_000

/** An ISO instant `minutes` after NOW. */
export const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * MINUTE).toISOString()

/* The key of one item. */
const keyOf = (pair: { recipient_id: string; issue_id: string }) =>
  `${pair.recipient_id}:${pair.issue_id}`

/** Every difference between the stored items and what the messages make,
 * for every pair a recipient's build state covers, and every stored item
 * that no covered pair makes or that has a twin. [] when all are exact. */
export const drift = (t: T): Promise<string[]> =>
  t.run(async (ctx) => {
    const out: string[] = []
    const states = new Map(
      (await ctx.db.query('inbox_state').collect()).map((s) => [s.profile_id, s] as const),
    )
    const pairs = new Map<string, Doc<'messages'>[]>()
    for (const m of await ctx.db.query('messages').collect()) {
      const rows = pairs.get(keyOf(m)) ?? []
      rows.push(m)
      pairs.set(keyOf(m), rows)
    }
    const items = new Map<string, Doc<'inbox_items'>>()
    for (const item of await ctx.db.query('inbox_items').collect()) {
      if (items.has(keyOf(item))) out.push(`twin ${keyOf(item)}`)
      items.set(keyOf(item), item)
      if (!covers(states.get(item.recipient_id) ?? null, item.issue_id))
        out.push(`uncovered ${keyOf(item)}`)
      if (!pairs.has(keyOf(item))) out.push(`no messages ${keyOf(item)}`)
    }
    for (const [key, rows] of pairs) {
      const pair = { recipient_id: rows[0].recipient_id, issue_id: rows[0].issue_id }
      if (!covers(states.get(pair.recipient_id) ?? null, pair.issue_id)) continue
      const task = await byId(ctx, 'issues', pair.issue_id)
      const want = itemOf(pair, rows, task?.project_id) as ItemFields
      const got = items.get(key)
      if (got === undefined) {
        out.push(`missing ${key}`)
        continue
      }
      for (const field of Object.keys(want) as (keyof ItemFields)[])
        if (want[field] !== got[field])
          out.push(`${key} ${field}: ${String(got[field])}, not ${String(want[field])}`)
    }
    return out
  })

/** Posts one message through postMessage, the single insert path, at
 * minute `minute`, with detail `body` ("Update minute" by default), and
 * answers its row, or null when postMessage stored none (a recipient who
 * cannot see the task). */
export async function post(
  t: T,
  f: Pick<OrgFixture, 'org' | 'admin'>,
  a: {
    to: Doc<'profiles'>
    task: Doc<'issues'>
    minute: number
    kind?: MessageKind
    body?: string
  },
): Promise<Doc<'messages'> | null> {
  return await t.run(async (ctx) => {
    const posted = await postMessage(ctx, {
      org_id: f.org.id,
      recipient_id: a.to.id,
      issue_id: a.task.id,
      kind: a.kind ?? 'change',
      body: a.body ?? `Update ${a.minute}`,
      actor_id: f.admin.id,
      now: at(a.minute),
    })
    if (!posted) return null
    const rows = await ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) =>
        q.eq('recipient_id', a.to.id).eq('issue_id', a.task.id),
      )
      .collect()
    return rows.reduce((newest, r) => (r._creationTime > newest._creationTime ? r : newest))
  })
}

/** Gives `who` a grant on project `projectId` and answers a function that
 * takes it away again. */
export async function grant(t: T, who: Doc<'profiles'>, projectId: string) {
  const _id = await t.run((ctx) =>
    ctx.db.insert('project_access', { project_id: projectId, profile_id: who.id, level: 'user' }),
  )
  return () => t.run((ctx) => ctx.db.delete(_id))
}

let planted = 50_000

/** `n` new tasks in project `projectId` with fields `task`, each with one
 * message to `to` from the fixture's admin, `chunk` tasks a transaction.
 * Answers the tasks in the order planted. */
export async function plantItems(
  t: T,
  f: Pick<OrgFixture, 'org' | 'admin'>,
  to: Doc<'profiles'>,
  n: number,
  projectId: string,
  task: Partial<Doc<'issues'>> = {},
  chunk = 50,
): Promise<Doc<'issues'>[]> {
  const out: Doc<'issues'>[] = []
  for (let from = 0; from < n; from += chunk) {
    const made = await t.run(async (ctx) => {
      const rows: Doc<'issues'>[] = []
      for (let i = from; i < Math.min(n, from + chunk); i++) {
        // with its description row and the used_ids row of its id, as every
        // writer stores a task
        const _id = await insertTask(
          ctx.db,
          {
            id: uuid(),
            org_id: f.org.id,
            project_id: projectId,
            num: planted++,
            title: `Item ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...task,
          },
          'restore',
        )
        const issue = (await ctx.db.get(_id)) as Doc<'issues'>
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: to.id,
          issue_id: issue.id,
          kind: 'change',
          body: `Update ${i}`,
          actor_id: f.admin.id,
          now: at(i),
        })
        rows.push(issue)
      }
      return rows
    })
    out.push(...made)
  }
  return out
}

/** Stores `n` messages of `kind` for `to` about `task` raw, as releases
 * before the item cap and the items stored them, so `to` has no build
 * state. Each is about 1 KB, a long change line. */
export async function plantLegacy(
  t: T,
  f: OrgFixture,
  to: Doc<'profiles'>,
  task: Doc<'issues'>,
  n: number,
  kind: (i: number) => 'change' | 'comment',
) {
  for (let from = 0; from < n; from += 500)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 500); i++)
        await ctx.db.insert('messages', {
          id: uuid(),
          org_id: f.org.id,
          recipient_id: to.id,
          issue_id: task.id,
          issue_title: task.title,
          kind: kind(i),
          detail: `Legacy update ${i}: ${'a long change line '.repeat(50)}`,
          created_at: at(i),
        })
    })
}

/** Archives the tasks without the archive's read steps, as a task archived
 * before its step ran is, so their messages stay unread. */
export const archiveRaw = (t: T, tasks: readonly Doc<'issues'>[]) =>
  t.run(async (ctx) => {
    for (const task of tasks) await ctx.db.patch(task._id, { archived_at: NOW })
  })

/** `read` run in one transaction, with what the transaction read in all,
 * as Convex counts it. */
export const measure = <A>(t: T, read: (ctx: QueryCtx) => Promise<A>) =>
  t.run(async (ctx) => {
    const answer = await read(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      answer,
      ranges: m.databaseQueries.used,
      documents: m.documentsRead.used,
      bytes: m.bytesRead.used,
    }
  })
