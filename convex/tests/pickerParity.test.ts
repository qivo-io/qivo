/* A task's people pickers (model/pickers.ts) against the writes they stand
 * for. A person the owner picker offers for an assignee or a reviewer is
 * one issues.update accepts as the task's new holder (model/issues.ts
 * updateIssueCore), and one it leaves out is one the write refuses; a
 * person the recipient picker offers is one a comment mentioning them
 * notifies (model/comments.ts postComment, the write behind
 * comments.create), agents, switched-off people and the writer aside; and
 * canOwn agrees with both. Each write runs in a transaction that throws at
 * its end, which convex-test rolls back, so it changes nothing for the
 * next and no comment rate or follower row builds up.
 *
 * Levels come from levelsFrom in the pickers and from levelUnder in the
 * writes, and both give an organization admin Lead on every project today,
 * so an admin without any grant is offered and accepted. The admin access
 * split removes both branches, and these expectations change together; a
 * split that removed one branch alone fails here. */
/// <reference types="vite/client" />

import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { byId } from '../lib/db'
import { ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import type { Refusal } from '../lib/functions'
import { postComment } from '../model/comments'
import { ASSIGNEE_SIGHT_RULE, REVIEWER_SIGHT_RULE, updateIssueCore } from '../model/issues'
import {
  canOwnOf,
  type PeopleBatch,
  type PickerField,
  syncRecipientsOf,
  taskOwnersOf,
} from '../model/pickers'
import { SHAPES } from './accessShapes.setup'
import {
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

/* What a write throws at its end so convex-test rolls it back. */
const ROLLED_BACK = 'rolled back on purpose'

/* Runs `write` in a transaction that throws at its end, and answers true
 * when it went through, else the sentence it refused with. Nothing it
 * wrote stays. */
async function attempt(t: T, write: (ctx: MutationCtx) => Promise<void>): Promise<true | string> {
  try {
    await t.run(async (ctx) => {
      await write(ctx)
      throw new Error(ROLLED_BACK)
    })
  } catch (e) {
    if (e instanceof ConvexError) return (e.data as Refusal).message
    if (e instanceof Error && e.message.includes(ROLLED_BACK)) return true
    throw e
  }
  throw new Error('the write neither went through nor was refused')
}

/* Whether issues.update, as `me`, accepts `who` as the new `field` of task
 * `issueId`, or the sentence it refuses with. */
const accepts = (
  t: T,
  me: Doc<'profiles'>,
  issueId: string,
  field: 'assignee' | 'reviewer',
  who: string,
) =>
  attempt(t, async (ctx) => {
    const issue = (await byId(ctx, 'issues', issueId)) as Doc<'issues'>
    const writer = (await byId(ctx, 'profiles', me.id)) as Doc<'profiles'>
    await updateIssueCore(ctx, {
      me: writer,
      issue,
      patch: field === 'assignee' ? { assignee_id: who } : { reviewer_id: who },
      now: NOW,
    })
  })

/* Whether a comment by `me` on task `issueId` that mentions `who` tells
 * them, by a mention message in their inbox. The post itself must go
 * through. */
async function notifies(t: T, me: Doc<'profiles'>, issueId: string, who: Doc<'profiles'>) {
  let told = false
  const posted = await attempt(t, async (ctx) => {
    const issue = (await byId(ctx, 'issues', issueId)) as Doc<'issues'>
    const author = (await byId(ctx, 'profiles', me.id)) as Doc<'profiles'>
    await postComment(ctx, {
      issue,
      author,
      body: `@[${who.name}](user:${who.id}) can you take a look?`,
      now: NOW,
    })
    const messages = await ctx.db
      .query('messages')
      .withIndex('by_recipient_issue', (q) => q.eq('recipient_id', who.id).eq('issue_id', issueId))
      .collect()
    told = messages.some((m) => m.kind === 'mention')
  })
  expect(posted, `the post mentioning ${who.name}`).toBe(true)
  return told
}

/* The ids `read` lists from its start to its end, or the state it answers
 * instead of a batch. */
async function listed(
  read: (after?: string) => Promise<PeopleBatch>,
): Promise<Set<string> | PeopleBatch['state']> {
  const ids = new Set<string>()
  let after: string | undefined
  for (let round = 0; round < 100; round++) {
    const batch = await read(after)
    if (batch.state !== 'ready') return batch.state
    for (const row of batch.rows) ids.add(row.id)
    if (batch.next === null) return ids
    after = batch.next
  }
  throw new Error('the list did not end')
}

/* What the pickers answer `me` about `who` on task `issueId`: whether each
 * list offers them, and canOwn's verdict for each field. */
const pickersOn = (t: T, me: Doc<'profiles'>, issueId: string, who: string) =>
  t.run(async (ctx) => {
    const writer = (await byId(ctx, 'profiles', me.id)) as Doc<'profiles'>
    const lists = {
      assignee: await listed((after) =>
        taskOwnersOf(ctx, writer, { issue_id: issueId, field: 'assignee', after }),
      ),
      reviewer: await listed((after) =>
        taskOwnersOf(ctx, writer, { issue_id: issueId, field: 'reviewer', after }),
      ),
      recipient: await listed((after) =>
        syncRecipientsOf(ctx, writer, { issue_id: issueId, after }),
      ),
    }
    const out: Partial<Record<PickerField, { offered: boolean; checked: boolean }>> = {}
    for (const field of ['assignee', 'reviewer', 'recipient'] as const) {
      const list = lists[field]
      if (typeof list === 'string') throw new Error(`the ${field} list answered ${list}`)
      const check = await canOwnOf(ctx, writer, { issue_id: issueId, field, ids: [who] })
      if (check.state !== 'ready') throw new Error(`canOwn answered ${check.state}`)
      out[field] = { offered: list.has(who), checked: check.rows[0].eligible }
    }
    return out as Record<PickerField, { offered: boolean; checked: boolean }>
  })

/* The roles each kind of profile may hold, where an agent is a user or a
 * viewer (profiles.ts). */
const COMBOS = PROFILE_KINDS.flatMap((kind) =>
  ORG_ROLES.filter((role) => kind === 'person' || role === 'user' || role === 'viewer').flatMap(
    (org_role) => [true, false].map((active) => ({ kind, org_role, active })),
  ),
)

/* withOrg with Writer, who edits TBED and its sub-projects through a grant
 * on TBED, and a task without holders on Firmware, on Board rev and on
 * TBED itself, where older code stored tasks. */
async function scene(t: T) {
  const f = await withOrg(t)
  const writer = await plantSeat(t, {
    org_id: f.org.id,
    name: 'Writer',
    auth_user_id: uuid(),
    accepted_at: NOW,
  })
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: writer.id,
      level: 'user',
    }),
  )
  const tasks = {
    FW: await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id }),
    PCB: await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id }),
    TBED: await plantIssue(t, { org_id: f.org.id, project_id: f.meta.id }),
  }
  return { f, writer, tasks }
}

/* Every outcome the shapes reached, so the comparison is not only of
 * people everyone offers or nobody does. */
const reached = new Set<string>()

describe('the pickers against the writes, over every access shape', () => {
  it.each(SHAPES)(
    'offer exactly whom the writes accept, for every role, kind and state: %s',
    async (name, plant) => {
      const t = newT()
      const { f, writer, tasks } = await scene(t)
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await keyOrg(t, f.org.id)
      const archived = await t.run(async (ctx) =>
        (await ctx.db.query('projects').collect()).filter((p) => p.archived_at !== undefined),
      )
      for (const combo of COMBOS) {
        await t.run((ctx) => ctx.db.patch(subject._id, combo))
        const who = (await t.run((ctx) => ctx.db.get(subject._id))) as Doc<'profiles'>
        for (const [key, task] of Object.entries(tasks)) {
          const why = `${name}: ${combo.active ? 'active' : 'inactive'} ${combo.org_role} ${combo.kind} on ${key}`
          // a task in an archived project is picked for by nobody
          if (archived.some((p) => p.id === task.project_id)) {
            const answer = await t.run((ctx) =>
              taskOwnersOf(ctx, writer, { issue_id: task.id, field: 'assignee' }),
            )
            expect(answer, why).toEqual({ state: 'unavailable' })
            continue
          }
          const pickers = await pickersOn(t, writer, task.id, who.id)
          for (const field of ['assignee', 'reviewer'] as const) {
            const outcome = await accepts(t, writer, task.id, field, who.id)
            expect(pickers[field].offered, `${why}, ${field}: ${outcome}`).toBe(outcome === true)
            expect(pickers[field].checked, `${why}, ${field} check`).toBe(outcome === true)
            reached.add(`${field} ${outcome === true ? 'accepted' : 'refused'}`)
          }
          const told = await notifies(t, writer, task.id, who)
          const recipient = told && who.kind === 'person' && who.active
          expect(pickers.recipient.offered, `${why}, recipient: told ${told}`).toBe(recipient)
          expect(pickers.recipient.checked, `${why}, recipient check`).toBe(recipient)
          reached.add(`recipient ${recipient ? 'offered' : told ? 'told only' : 'left out'}`)
        }
      }
    },
  )

  it('reach both outcomes for each field, and mentions the window leaves out', () => {
    expect([...reached].sort()).toEqual([
      'assignee accepted',
      'assignee refused',
      'recipient left out',
      'recipient offered',
      'recipient told only',
      'reviewer accepted',
      'reviewer refused',
    ])
  })

  it('offers an organization admin without any grant, as the writes accept them', async () => {
    const t = newT()
    const { f, writer, tasks } = await scene(t)
    await keyOrg(t, f.org.id)
    // the split changes both expectations together
    for (const task of Object.values(tasks)) {
      const pickers = await pickersOn(t, writer, task.id, f.admin.id)
      expect(pickers.assignee).toEqual({ offered: true, checked: true })
      expect(pickers.reviewer).toEqual({ offered: true, checked: true })
      expect(await accepts(t, writer, task.id, 'assignee', f.admin.id)).toBe(true)
      expect(await accepts(t, writer, task.id, 'reviewer', f.admin.id)).toBe(true)
    }
  })

  it('offers on a task stored on a top-level project, as a recipient and not as an owner, who reaches only one of its sub-projects', async () => {
    const t = newT()
    const { f, writer, tasks } = await scene(t)
    const sam = await plantSeat(t, { org_id: f.org.id, name: 'Sam', auth_user_id: uuid() })
    await t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: f.sub2.id, profile_id: sam.id, level: 'user' }),
    )
    await keyOrg(t, f.org.id)
    const pickers = await pickersOn(t, writer, tasks.TBED.id, sam.id)
    expect(pickers.recipient).toEqual({ offered: true, checked: true })
    expect(await notifies(t, writer, tasks.TBED.id, sam)).toBe(true)
    expect(pickers.assignee).toEqual({ offered: false, checked: false })
    expect(typeof (await accepts(t, writer, tasks.TBED.id, 'assignee', sam.id))).toBe('string')
  })
})

describe('the owner pickers against the chain check', () => {
  /* Subtasks of Firmware under a parent on Board rev, on Skunkworks, which
   * Writer cannot see, and on Elsewhere, a top-level project some reach
   * only through its sub-project, with people who see some of them. */
  async function chain() {
    const t = newT()
    const { f, writer } = await scene(t)
    const elsewhere = await plantProject(t, {
      org_id: f.org.id,
      name: 'Elsewhere',
      lead_id: f.admin.id,
    })
    const elsewhereSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: elsewhere.id,
      name: 'Elsewhere sub',
    })
    const grant = (project: Doc<'projects'>, who: Doc<'profiles'>, level: 'user' | 'viewer') =>
      t.run((ctx) =>
        ctx.db.insert('project_access', { project_id: project.id, profile_id: who.id, level }),
      )
    const person = async (name: string, sees: Doc<'projects'>[]) => {
      const p = await plantSeat(t, { org_id: f.org.id, name, auth_user_id: uuid() })
      await grant(f.sub, p, 'user')
      for (const project of sees) await grant(project, p, 'viewer')
      return p
    }
    await person('Ann', [])
    await person('Ben', [f.sub2])
    await person('Cy', [f.hidden])
    await person('Di', [elsewhereSub])
    await person('Ed', [elsewhere])
    const subtaskUnder = async (project: Doc<'projects'>) => {
      const parent = await plantIssue(t, { org_id: f.org.id, project_id: project.id })
      return await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, parent_id: parent.id })
    }
    const subtasks = {
      sibling: await subtaskUnder(f.sub2),
      hidden: await subtaskUnder(f.hidden),
      navigation: await subtaskUnder(elsewhere),
    }
    await keyOrg(t, f.org.id)
    return { t, f, writer, subtasks }
  }

  it('offers for each subtask exactly the seats the write accepts, and refuses the rest with the sight rule', async () => {
    const { t, f, writer, subtasks } = await chain()
    const seats = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    )
    const offered: Record<string, string[]> = {}
    for (const [key, subtask] of Object.entries(subtasks)) {
      for (const field of ['assignee', 'reviewer'] as const) {
        // a transaction answers Convex values, so the set comes out as an array
        const read = await t.run(async (ctx) => {
          const ids = await listed((after) =>
            taskOwnersOf(ctx, writer, { issue_id: subtask.id, field, after }),
          )
          return typeof ids === 'string' ? ids : [...ids]
        })
        if (typeof read === 'string') throw new Error(`the list answered ${read}`)
        const list = new Set(read)
        const checks = await t.run((ctx) =>
          canOwnOf(ctx, writer, { issue_id: subtask.id, field, ids: seats.map((s) => s.id) }),
        )
        if (checks.state !== 'ready') throw new Error(`canOwn answered ${checks.state}`)
        const sight = field === 'assignee' ? ASSIGNEE_SIGHT_RULE : REVIEWER_SIGHT_RULE
        let refusedForSight = 0
        for (const [i, seat] of seats.entries()) {
          const outcome = await accepts(t, writer, subtask.id, field, seat.id)
          expect(list.has(seat.id), `${key} ${field} ${seat.name}: ${outcome}`).toBe(
            outcome === true,
          )
          expect(checks.rows[i].eligible, `${key} ${field} ${seat.name}`).toBe(outcome === true)
          if (outcome === sight) refusedForSight++
        }
        expect(refusedForSight, `${key} ${field}`).toBeGreaterThan(0)
        offered[`${key} ${field}`] = seats
          .filter((s) => list.has(s.id))
          .map((s) => s.name)
          .sort()
      }
    }
    // the people with Edit on Firmware, each where they see the parent
    expect(offered['sibling assignee']).toEqual(['Ben', 'Writer', 'admin', 'guest', 'user'])
    expect(offered['hidden assignee']).toEqual(['Cy', 'admin', 'user'])
    expect(offered['navigation assignee']).toEqual(['Di', 'Ed', 'admin'])
    for (const key of Object.keys(subtasks))
      expect(offered[`${key} reviewer`]).toEqual(offered[`${key} assignee`])
  })
})
