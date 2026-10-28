/* Shared by the inbox items suites (inboxItems.test.ts, inboxReads.test.ts):
 * posting a message through the single insert path, and the check that
 * every stored inbox_items row equals what its messages make (drift).
 *
 * Named *.setup.ts, as two dots in the basename is the Convex CLI's skip
 * rule (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import { byId } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { covers, type ItemFields, itemOf } from '../model/inboxItems'
import { postMessage } from '../model/messages'
import { NOW, type OrgFixture, type T } from './helpers.setup'

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
 * minute `minute`, and answers its row, or null when postMessage stored
 * none (a recipient who cannot see the task). */
export async function post(
  t: T,
  f: Pick<OrgFixture, 'org' | 'admin'>,
  a: { to: Doc<'profiles'>; task: Doc<'issues'>; minute: number; kind?: MessageKind },
): Promise<Doc<'messages'> | null> {
  return await t.run(async (ctx) => {
    const posted = await postMessage(ctx, {
      org_id: f.org.id,
      recipient_id: a.to.id,
      issue_id: a.task.id,
      kind: a.kind ?? 'change',
      body: `Update ${a.minute}`,
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
