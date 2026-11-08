/* Shared by the inbox items suites (inboxItems.test.ts, inboxReads.test.ts,
 * inboxPage.test.ts, machineInbox.test.ts): posting a message through the
 * single insert path, the check that every stored inbox_items row equals
 * what its messages make (drift), planting tasks with an item each
 * (plantItems), messages from before the items (plantLegacy), grants,
 * archives without the archive's read steps, and what one read costs
 * (measure). The Inbox pages' planters follow: messages through the item
 * writer without postMessage's checks (deliver), many groups through it
 * (plantGroups) or raw with their item rows (plantRaw), a reader with
 * grants (reader), a reader of everyday reach (everyday) and the actors of
 * a case (actors).
 *
 * Named *.setup.ts, as two dots in the basename is the Convex CLI's skip
 * rule (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { byId, newWindowKey } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { insertTask } from '../model/descriptions'
import { covers, ensureInboxState, type ItemFields, itemEdits, itemOf } from '../model/inboxItems'
import { postMessage } from '../model/messages'
import { NOW, type OrgFixture, plantLogin, plantSeat, type T, uuid } from './helpers.setup'

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

/** One message an item gets, at minute `minute` after NOW. */
export type Sent = {
  minute: number
  kind?: MessageKind
  body?: string
  /** the actor's profile id; absent for a machine caller */
  actor?: string
  read?: boolean
}

let nums = 200_000

/** Stores `sent` for `to` about `task` through the item writer
 * (model/inboxItems.ts itemEdits) without postMessage's checks, as messages
 * received while `to` could see the task. Answers the rows. */
export async function deliver(t: T, to: Doc<'profiles'>, task: Doc<'issues'>, ...sent: Sent[]) {
  return await t.run(async (ctx) => {
    const edits = itemEdits(ctx)
    await edits.state(to.id, 'ensure')
    const rows = []
    for (const s of sent) {
      const row = {
        id: uuid(),
        org_id: task.org_id,
        recipient_id: to.id,
        actor_id: s.actor,
        issue_id: task.id,
        issue_title: task.title,
        kind: s.kind ?? ('change' as const),
        detail: s.body ?? `Update ${s.minute}`,
        created_at: at(s.minute),
        ...(s.read === true ? { read_at: at(s.minute) } : {}),
      }
      await edits.insert(row, task.project_id)
      rows.push(row)
    }
    await edits.flush()
    return rows
  })
}

/** `n` tasks, the `i`th in project `projectOf(i)` titled `title(i)`, with
 * the fields `task(i)`, each with an item of `to` holding the messages
 * `sent(i)` (one change at minute i by default), `chunk` tasks a
 * transaction through one item writer. Answers the tasks in the order
 * planted, the oldest group first. */
export async function plantGroups(
  t: T,
  to: Doc<'profiles'>,
  n: number,
  projectOf: (i: number) => string,
  o: {
    sent?: (i: number) => Sent[]
    title?: (i: number) => string
    task?: (i: number) => Partial<Doc<'issues'>>
    chunk?: number
  } = {},
): Promise<Doc<'issues'>[]> {
  const out: Doc<'issues'>[] = []
  const chunk = o.chunk ?? 250
  for (let from = 0; from < n; from += chunk) {
    const made = await t.run(async (ctx) => {
      const edits = itemEdits(ctx)
      await edits.state(to.id, 'ensure')
      const tasks: Doc<'issues'>[] = []
      for (let i = from; i < Math.min(n, from + chunk); i++) {
        const _id = await insertTask(
          ctx.db,
          {
            id: uuid(),
            org_id: to.org_id,
            project_id: projectOf(i),
            num: nums++,
            title: o.title?.(i) ?? `Calibrate the bench fixture for board revision ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...o.task?.(i),
          },
          'restore',
        )
        const task = (await ctx.db.get(_id)) as Doc<'issues'>
        for (const s of o.sent?.(i) ?? [{ minute: i }]) {
          await edits.insert(
            {
              id: uuid(),
              org_id: task.org_id,
              recipient_id: to.id,
              actor_id: s.actor,
              issue_id: task.id,
              issue_title: task.title,
              kind: s.kind ?? 'change',
              detail: s.body ?? `Status changed from Todo to In progress (${i})`,
              created_at: at(s.minute),
              ...(s.read === true ? { read_at: at(s.minute) } : {}),
            },
            task.project_id,
          )
        }
        tasks.push(task)
      }
      await edits.flush()
      return tasks
    })
    out.push(...made)
  }
  return out
}

/** `n` groups of `to` planted raw, the `i`th about a new task in project
 * `projectOf(i)` titled `title(i)`, with the fields `task(i)`, the one
 * message `sent(i)` and its item row as model/inboxItems.ts itemOf makes
 * it, `chunk` groups a transaction. It writes no description, used_ids or count row, which the
 * page never reads, and runs no query, so the design size's 6,000 groups
 * plant in seconds where plantGroups' writers take minutes. */
export async function plantRaw(
  t: T,
  to: Doc<'profiles'>,
  n: number,
  projectOf: (i: number) => string,
  o: {
    sent: (i: number) => Sent
    title: (i: number) => string
    task?: (i: number) => Partial<Doc<'issues'>>
    chunk?: number
  },
) {
  const chunk = o.chunk ?? 2000
  await t.run((ctx) => ensureInboxState(ctx, to.id))
  for (let from = 0; from < n; from += chunk)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + chunk); i++) {
        const task = {
          id: uuid(),
          org_id: to.org_id,
          project_id: projectOf(i),
          num: nums++,
          title: o.title(i),
          status: 'todo' as const,
          priority: 'medium' as const,
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          window_key: newWindowKey(),
          ...o.task?.(i),
        }
        await ctx.db.insert('issues', task)
        const s = o.sent(i)
        const message = {
          id: uuid(),
          org_id: to.org_id,
          recipient_id: to.id,
          actor_id: s.actor,
          issue_id: task.id,
          issue_title: task.title,
          kind: s.kind ?? ('change' as const),
          detail: s.body ?? `Status changed from Todo to In progress (${i})`,
          created_at: at(s.minute),
          ...(s.read === true ? { read_at: at(s.minute) } : {}),
        }
        const _id = await ctx.db.insert('messages', message)
        const item = itemOf(
          { recipient_id: to.id, issue_id: task.id },
          [{ ...message, _id }],
          task.project_id,
        )
        if (item !== null) await ctx.db.insert('inbox_items', item)
      }
    })
}

/** A seat in the fixture's organization with a login, `role` (guest by
 * default), and a grant on each of `projects`. */
export async function reader(
  t: T,
  f: OrgFixture,
  projects: readonly Doc<'projects'>[],
  role = 'guest',
) {
  const me = await plantLogin(
    t,
    await plantSeat(t, {
      org_id: f.org.id,
      accepted_at: NOW,
      name: 'Reader',
      org_role: role as Doc<'profiles'>['org_role'],
    }),
  )
  for (const p of projects) await grant(t, me, p.id)
  return me
}

/** A reader of everyday reach (AGENTS.md, the design size): a member of the
 * fixture's organization in `teams` teams, each sharing 7 top-level
 * projects of 3 sub-projects, about 20 sub-projects a team, and a grant on
 * each of `more` further top-level projects of 3 sub-projects, the last of
 * them with `last`. Answers the reader and every sub-project it sees,
 * those of one parent in a row. */
export async function everyday(t: T, f: OrgFixture, teams = 3, more = 0, last = 3) {
  const me = await reader(t, f, [], 'user')
  const subs = await t.run(async (ctx) => {
    const out: Doc<'projects'>[] = []
    let num = 1000
    const project = async (parent: Doc<'projects'> | null, name: string) => {
      const _id = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: f.org.id,
        type: parent === null ? 'meta' : 'project',
        ...(parent === null ? {} : { parent_id: parent.id }),
        key: `E${num}`,
        name,
        description: '',
        sort_order: num,
        num: num++,
        track_delay: false,
        created_at: NOW,
        window_key: newWindowKey(),
      })
      return (await ctx.db.get(_id)) as Doc<'projects'>
    }
    const family = async (i: number, children = 3) => {
      const parent = await project(null, `Product line ${i}`)
      for (const name of ['Firmware', 'Hardware', 'Validation'].slice(0, children))
        out.push(await project(parent, `${name} ${i}`))
      return parent
    }
    for (let k = 0; k < teams; k++) {
      const team = uuid()
      await ctx.db.insert('teams', {
        id: team,
        org_id: f.org.id,
        name: `Team ${k}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: team, profile_id: me.id, is_leader: false })
      for (let i = 0; i < 7; i++) {
        const parent = await family(k * 7 + i)
        await ctx.db.insert('project_team_access', {
          project_id: parent.id,
          team_id: team,
          level: 'user',
        })
      }
    }
    for (let i = 0; i < more; i++) {
      const parent = await family(1000 + i, i === more - 1 ? last : 3)
      await ctx.db.insert('project_access', {
        project_id: parent.id,
        profile_id: me.id,
        level: 'user',
      })
    }
    return out
  })
  return { me, subs }
}

/** `n` people of the fixture's organization, the actors of a case. */
export async function actors(t: T, f: OrgFixture, n: number) {
  const out: Doc<'profiles'>[] = []
  for (let i = 0; i < n; i++)
    out.push(await plantSeat(t, { org_id: f.org.id, name: `Engineer ${i}`, accepted_at: NOW }))
  return out
}
