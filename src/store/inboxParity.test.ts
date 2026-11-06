/* The inbox reads' stand-in (store/inboxStandIn.setup.ts) against the real
 * queries (convex/inbox.ts summary and item, model/inboxReads.ts) on
 * convex-test, as the other parity suites hold their stand-ins to the
 * server. For every Northstar person with a login it compares the summary
 * and the item of every task they hold a message about, and for planted
 * cases a snoozed group, a read group, a mention in the description alone
 * and a comment mention alone. `through` is the newest message's
 * _creationTime on the server, which the workspace's rows do not carry, so
 * the stand-in takes the created_at's ms and the comparison only asks for
 * a number. One difference is named. A message about a task the seat can
 * no longer see or an archived task, which neither counts, sets the
 * server's flag of the action that reaches it, as markAllRead and
 * removeRead do, and not the stand-in's, which sees only the workspace's
 * messages; convex/tests/inboxReads.test.ts holds the server's flags. So
 * the comparison takes each flag the stand-in raises as one the server
 * raises, and each flag only the server raises as one a message the
 * workspace leaves out explains. Everyday sizes. */

import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { MENTION_DETAILS } from '../../convex/lib/messageDetails'
import type { Workspace } from '../../convex/lib/workspaceJoin'
import {
  as,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  withOrg,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { grant, post } from '../../convex/tests/inboxItems.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import {
  INBOX_NO_ANSWER,
  inboxItemStandIn,
  inboxSummaryStandIn,
  type SummaryAnswer,
} from './inboxStandIn.setup'

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= 'inbox-parity-secret-not-a-deployment-key'
})

/** The workspace `who` holds, or a failure. */
async function workspace(t: T, who: Doc<'profiles'>): Promise<Workspace> {
  const ws = await workspaceOf(as(t, who))
  if (!ws) throw new Error(`no workspace for ${who.name}`)
  return ws
}

/** The unsnoozed messages of `who`, read (`read`) or not, as the server
    holds them, and as the workspace sends them. */
async function unsnoozed(t: T, who: Doc<'profiles'>, ws: Workspace, read: boolean) {
  const all = await t.run((ctx) =>
    ctx.db
      .query('messages')
      .withIndex('by_recipient', (q) => q.eq('recipient_id', who.id))
      .collect(),
  )
  const keep = (m: { snoozed_until?: string; read_at?: string }) =>
    m.snoozed_until === undefined && (m.read_at !== undefined) === read
  return {
    server: all.filter(keep).map((m) => m.id),
    shown: ws.messages.filter(keep).map((m) => m.id),
  }
}

/** An item answer with its `through` replaced by whether it is a number. */
function shape(answer: unknown) {
  if (answer === INBOX_NO_ANSWER || !answer || typeof answer !== 'object') return answer
  if (!('item' in answer) || !answer.item || typeof answer.item !== 'object') return answer
  const { through, ...item } = answer.item as { through: unknown }
  return { ...answer, item: { ...item, through: typeof through } }
}

/** The server's summary and item answers for `who` and the stand-in's, over
    the tasks `tasks`. */
async function both(t: T, who: Doc<'profiles'>, tasks: readonly string[]) {
  const ws = await workspace(t, who)
  const caller = as(t, who)
  const summary = {
    server: await caller.query(api.inbox.summary, {}),
    stand: inboxSummaryStandIn(ws),
  }
  const items = []
  for (const issue_id of tasks) {
    const args = { org_id: who.org_id, issue_id }
    items.push({
      task: issue_id,
      server: shape(await caller.query(api.inbox.item, args)),
      stand: shape(inboxItemStandIn(ws, args)),
    })
  }
  return { summary, items, ws }
}

describe("the inbox reads' stand-in", () => {
  it('answers the summary and every item as the server does, for every Northstar person', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    let counted = 0
    let items = 0
    let named = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined)) {
      const ws = await workspace(t, person)
      const tasks = [...new Set(ws.messages.map((m) => m.issue_id))]
      const got = await both(t, person, tasks)
      const { seats: standSeats, ...stand } = got.summary.stand as SummaryAnswer
      const { seats: serverSeats, ...server } = got.summary.server
      expect(stand, person.name).toEqual(server)
      expect(standSeats.map((line) => [line.org_id, line.ready])).toEqual(
        serverSeats.map((line) => [line.org_id, line.ready]),
      )
      for (const [at, line] of serverSeats.entries())
        for (const [flag, read] of [
          ['can_mark_all_read', false],
          ['can_remove_read', true],
        ] as const) {
          const what = `${person.name} ${flag}`
          // the server's flag is whether such a message exists at all
          const rows = await unsnoozed(t, person, ws, read)
          expect(line[flag], what).toBe(rows.server.length > 0)
          if (standSeats[at][flag] === line[flag]) continue
          // only the server raises it, for messages the workspace leaves out
          expect(line[flag], what).toBe(true)
          const left = rows.server.filter((id) => !rows.shown.includes(id))
          expect(left.length, what).toBeGreaterThan(0)
          named++
        }
      for (const item of got.items)
        expect(item.stand, `${person.name} ${item.task}`).toEqual(item.server)
      counted += got.summary.server.unread_count
      items += got.items.filter((i) => (i.server as { item: unknown }).item !== null).length
    }
    // the seed leaves unread items, so the comparison counts something, and
    // read messages about archived tasks, which only the server's flag sees
    expect(counted).toBeGreaterThan(0)
    expect(items).toBeGreaterThanOrEqual(counted)
    expect(named).toBeGreaterThan(0)
  })

  it('answers a snoozed group, a read group and mentions in the description and in a comment alike', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = () => plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const guest = as(t, f.guest)
    const [unread, read, snoozed, described, mentioned, mixed] = [
      await task(),
      await task(),
      await task(),
      await task(),
      await task(),
      await task(),
    ]
    await post(t, f, { to: f.guest, task: unread, minute: 1 })
    await post(t, f, { to: f.guest, task: unread, minute: 2, kind: 'comment', body: 'New comment' })
    const readRow = await post(t, f, { to: f.guest, task: read, minute: 3 })
    if (!readRow) throw new Error('no message')
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [readRow.id] })
    const snoozedRow = await post(t, f, { to: f.guest, task: snoozed, minute: 4 })
    if (!snoozedRow) throw new Error('no message')
    await guest.mutation(api.messages.snooze, {
      org_id: f.org.id,
      ids: [snoozedRow.id],
      until: new Date(Date.now() + 86_400_000).toISOString(),
    })
    // a mention in the description alone tells of a change, a comment's not
    await post(t, f, {
      to: f.guest,
      task: described,
      minute: 5,
      kind: 'mention',
      body: MENTION_DETAILS.description,
    })
    await post(t, f, {
      to: f.guest,
      task: mentioned,
      minute: 6,
      kind: 'mention',
      body: MENTION_DETAILS.comment,
    })
    // a read change and an unread comment mention, so nothing unread tells of one
    const change = await post(t, f, { to: f.guest, task: mixed, minute: 7 })
    if (!change) throw new Error('no message')
    await guest.mutation(api.messages.markRead, { org_id: f.org.id, ids: [change.id] })
    await post(t, f, {
      to: f.guest,
      task: mixed,
      minute: 8,
      kind: 'mention',
      body: MENTION_DETAILS.comment,
    })
    const tasks = [unread, read, snoozed, described, mentioned, mixed].map((x) => x.id)
    const got = await both(t, f.guest, [...tasks, (await task()).id])
    expect(got.summary.stand).toEqual(got.summary.server)
    expect(got.summary.server).toMatchObject({ unread_count: 4, complete: true })
    for (const item of got.items) expect(item.stand, item.task).toEqual(item.server)
    const change_ = (n: number) =>
      (got.items[n].server as { item: { unread_change: boolean } | null }).item?.unread_change
    expect([change_(0), change_(3), change_(4), change_(5)]).toEqual([true, true, false, false])
    // a task with no message holds no item
    expect(got.items[6].server).toEqual({ state: 'ok', item: null })
  })

  it('counts no message about a task the seat lost, where only the server flags it', async () => {
    const t = newT()
    const f: OrgFixture = await withOrg(t)
    const under = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const lost = await plantIssue(t, { org_id: f.org.id, project_id: under.id })
    const revoke = await grant(t, f.guest, f.hidden.id)
    await post(t, f, { to: f.guest, task: lost, minute: 1 })
    await revoke()
    const got = await both(t, f.guest, [lost.id])
    // neither counts it, and neither answers an item the seat is not shown
    expect(got.ws.messages).toEqual([])
    expect(got.summary.server).toMatchObject({ unread_count: 0, complete: true })
    expect(got.summary.stand).toMatchObject({ unread_count: 0, complete: true })
    expect(got.items[0].server).toEqual({ state: 'ok', item: null })
    expect(got.items[0].stand).toEqual({ state: 'ok', item: null })
    // the named difference: Mark all as read reaches it on the server
    expect(got.summary.server.seats).toEqual([
      { org_id: f.org.id, ready: true, can_mark_all_read: true, can_remove_read: false },
    ])
    expect(got.summary.stand).toMatchObject({
      seats: [{ org_id: f.org.id, ready: true, can_mark_all_read: false, can_remove_read: false }],
    })
  })
})
