/* model/messages — the inbox fan-outs, fences and the pair prune — driven
 * through the public issue mutations wherever one exists (create / update /
 * move / archive / unarchive / subscribe) and through t.run + model functions
 * for the phase-5 surfaces (comments, markRead's prune contract).
 *
 * Template sentences are asserted BYTE for byte: the client toasts/renders
 * them raw, Inbox.tsx string-rewrites 'a task in another project', and the
 * change fragments are joined with a period and space. Values retain their
 * display punctuation — ' → ' (U+2192), ' – ' (U+2013), curly “ ”
 * (U+201C/201D). A handful of expectations spell the escape out so an
 * editor's smart-quote pass cannot silently change the contract. */
/// <reference types="vite/client" />

import type { FunctionArgs } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  extractMentions,
  type NotifyPreload,
  notifyCommentInsert,
  notifyIssueUpdate,
  pruneReadMessages,
} from '../model/messages'
import {
  allMessages,
  as,
  drainMessages,
  messagesFor,
  NOW,
  newT,
  plantIssue,
  plantMessage,
  plantProject,
  plantSubscription,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

type Patch = FunctionArgs<typeof api.issues.update>['patch']
type CreateArgs = FunctionArgs<typeof api.issues.create>

/* The eye, pressed by `who` on their own behalf. */
const subscribe = (t: T, who: Doc<'profiles'>, issueId: string) =>
  as(t, who).mutation(api.issues.subscribe, { org_id: who.org_id, issue_id: issueId })

const update = (t: T, actor: Doc<'profiles'>, id: string, patch: Patch) =>
  as(t, actor).mutation(api.issues.update, { org_id: actor.org_id, id, patch })

describe('fan-out: one message per subscriber, minus the actor', () => {
  it('every follower except the actor gets exactly one change message', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    for (const who of [f.admin, f.guest, f.viewer, f.user]) await subscribe(t, who, issue.id)

    await update(t, f.user, issue.id, { status: 'progress' })

    for (const who of [f.admin, f.guest, f.viewer]) {
      const msgs = await messagesFor(t, who.id, issue.id)
      expect(msgs).toHaveLength(1)
      expect(msgs[0].kind).toBe('change')
      expect(msgs[0].detail).toBe('Status: To Do → In Progress')
      expect(msgs[0].actor_id).toBe(f.user.id)
      expect(msgs[0].issue_title).toBe('Planted task')
      expect(msgs[0].org_id).toBe(f.org.id)
    }
    // the actor follows too, but never messages themselves
    expect(await messagesFor(t, f.user.id, issue.id)).toHaveLength(0)
    expect(await allMessages(t)).toHaveLength(3)
  })

  it('zero subscribers: the cheap exit posts nothing at all', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await update(t, f.user, issue.id, { status: 'done' })
    expect(await allMessages(t)).toHaveLength(0)
  })
})

describe('recipient-relative narration', () => {
  it('assignment reads Assigned-to-you for the assignee, Assigned-to-<name> for everyone else', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.admin, issue.id)

    await update(t, f.user, issue.id, { assignee_id: f.guest.id })

    // the new assignee was subscribed by the assignment itself
    const guestMsgs = await messagesFor(t, f.guest.id, issue.id)
    expect(guestMsgs).toHaveLength(1)
    expect(guestMsgs[0].detail).toBe('Assigned to you')
    expect(guestMsgs[0].kind).toBe('change')
    const adminMsgs = await messagesFor(t, f.admin.id, issue.id)
    expect(adminMsgs).toHaveLength(1)
    expect(adminMsgs[0].detail).toBe('Assigned to guest')

    // being taken off is news you keep hearing: the old assignee stays
    // subscribed, and nobody is "you" in an unassignment
    await drainMessages(t)
    await tick()
    await update(t, f.user, issue.id, { assignee_id: null })
    expect((await messagesFor(t, f.guest.id, issue.id))[0].detail).toBe('Unassigned (was guest)')
    expect((await messagesFor(t, f.admin.id, issue.id))[0].detail).toBe('Unassigned (was guest)')
  })

  it('a fresh mention supersedes the change echo: the mentioned reads the mention, not Description updated', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)

    await update(t, f.user, issue.id, { description: `Ping @[admin](user:${f.admin.id})` })

    // admin: the mention only — their change copy emptied out and was skipped
    const adminMsgs = await messagesFor(t, f.admin.id, issue.id)
    expect(adminMsgs).toHaveLength(1)
    expect(adminMsgs[0].kind).toBe('mention')
    expect(adminMsgs[0].detail).toBe('Mentioned you in the description')
    // guest: the bare description line
    const guestMsgs = await messagesFor(t, f.guest.id, issue.id)
    expect(guestMsgs).toHaveLength(1)
    expect(guestMsgs[0].kind).toBe('change')
    expect(guestMsgs[0].detail).toBe('Description updated')
    // the mention subscribed admin
    const sub = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_profile', (q) =>
          q.eq('issue_id', issue.id).eq('profile_id', f.admin.id),
        )
        .unique(),
    )
    expect(sub).not.toBeNull()

    // an OLD mention does not re-fire: the next description edit reads as a
    // plain change to the (now subscribed) admin
    await drainMessages(t)
    await tick()
    await update(t, f.user, issue.id, {
      description: `Ping @[admin](user:${f.admin.id}) — more`,
    })
    const again = await messagesFor(t, f.admin.id, issue.id)
    expect(again).toHaveLength(1)
    expect(again[0].kind).toBe('change')
    expect(again[0].detail).toBe('Description updated')
  })

  it('a mentioned assignee on a wider edit keeps the documented double message (mention + change without the description line)', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)

    await update(t, f.user, issue.id, {
      description: `Ping @[admin](user:${f.admin.id})`,
      status: 'review',
    })

    const adminMsgs = await messagesFor(t, f.admin.id, issue.id)
    expect(adminMsgs.map((m) => m.kind).sort()).toEqual(['change', 'mention'])
    const change = adminMsgs.find((m) => m.kind === 'change')!
    // entering Review sets the project review time (2 h by default)
    expect(change.detail).toBe('Status: To Do → In Review. Remaining set to 2 h') // no Description updated
    const guestMsgs = await messagesFor(t, f.guest.id, issue.id)
    expect(guestMsgs).toHaveLength(1)
    expect(guestMsgs[0].detail).toBe(
      'Status: To Do → In Review. Description updated. Remaining set to 2 h',
    )
  })

  it('ATTACH_SLOT resolves per recipient: the key for those who may see, the fixed fallback for those who may not', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: hiddenSub.id })
    const child = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.admin, child.id) // admin sees hidden (org admin)
    await subscribe(t, f.guest, child.id) // guest holds no grant on hidden

    await update(t, f.user, child.id, { parent_id: parent.id })

    expect((await messagesFor(t, f.admin.id, child.id))[0].detail).toBe(
      `Attached under QN-${parent.num}`,
    )
    // Inbox.tsx:60 rewrites exactly this string at render time
    expect((await messagesFor(t, f.guest.id, child.id))[0].detail).toBe(
      'Attached under a task in another project',
    )
  })

  it('the attach slot is dropped outright when the parent row vanished', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.admin, issue.id)
    await t.run(async (ctx) => {
      const before = (await ctx.db.get(issue._id)) as Doc<'issues'>
      const after = { ...before, parent_id: uuid() } // an issue that does not exist
      await notifyIssueUpdate(ctx, { before, after, actor: f.user, now: NOW })
    })
    expect(await allMessages(t)).toHaveLength(0) // slot removed, parts empty, nothing posted
  })
})

describe('side-effect writes notify and touch', () => {
  it('the envelope widen messages each widened ancestor and stamps its updated_at', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      start_week: '2026-01-05',
      end_week: '2026-01-11',
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    await subscribe(t, f.admin, parent.id) // following the PARENT only

    const childAfter = await update(t, f.user, child.id, {
      start_week: '2026-01-19',
      end_week: '2026-01-25',
    })

    const msgs = await messagesFor(t, f.admin.id, parent.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].detail).toBe('Schedule: 5 Jan – 11 Jan → 5 Jan – 25 Jan')
    const parentAfter = await t.run(async (ctx) => (await ctx.db.get(parent._id)) as Doc<'issues'>)
    expect(parentAfter.start_week).toBe('2026-01-05')
    expect(parentAfter.end_week).toBe('2026-01-25')
    expect(parentAfter.updated_at).toBe(childAfter.updated_at) // touched, same instant
    expect(await allMessages(t)).toHaveLength(1) // nobody follows the child
  })

  it('the widen loop cascades: every non-covering ancestor is widened, messaged and touched; a covering one stays silent', async () => {
    const t = newT()
    const f = await withOrg(t)
    const span = { start_week: '2026-01-05', end_week: '2026-01-11' }
    const grandparent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, ...span })
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: grandparent.id,
      ...span,
    })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    await subscribe(t, f.guest, parent.id)
    await subscribe(t, f.admin, grandparent.id)

    // a child landing INSIDE the ancestors' span widens nothing and says nothing
    await update(t, f.user, child.id, span)
    expect(await allMessages(t)).toHaveLength(0)

    await tick()
    const childAfter = await update(t, f.user, child.id, {
      start_week: '2026-01-19',
      end_week: '2026-01-25',
    })

    const expected = 'Schedule: 5 Jan – 11 Jan → 5 Jan – 25 Jan'
    expect((await messagesFor(t, f.guest.id, parent.id)).map((m) => m.detail)).toEqual([expected])
    expect((await messagesFor(t, f.admin.id, grandparent.id)).map((m) => m.detail)).toEqual([
      expected,
    ])
    expect(await allMessages(t)).toHaveLength(2)
    for (const anc of [parent, grandparent]) {
      const after = await t.run(async (ctx) => (await ctx.db.get(anc._id)) as Doc<'issues'>)
      expect(after.start_week).toBe('2026-01-05')
      expect(after.end_week).toBe('2026-01-25')
      expect(after.updated_at).toBe(childAfter.updated_at)
    }
  })

  it('clear-remaining-on-attach messages the parent (Remaining cleared) and clears the stamp pair', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      remaining_hours: 6,
      remaining_set_at: NOW,
    })
    const child = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.admin, parent.id)

    const childAfter = await update(t, f.user, child.id, { parent_id: parent.id })

    const msgs = await messagesFor(t, f.admin.id, parent.id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].detail).toBe('Remaining cleared (was 6 h)')
    const parentAfter = await t.run(async (ctx) => (await ctx.db.get(parent._id)) as Doc<'issues'>)
    expect(parentAfter.remaining_hours).toBeUndefined()
    expect(parentAfter.remaining_set_at).toBeUndefined() // the 0072 pairing held
    expect(parentAfter.updated_at).toBe(childAfter.updated_at)
    expect(await allMessages(t)).toHaveLength(1)
  })
})

describe('archive cascade + the shared instant', () => {
  it('one archive click is one message; the reason comment and every message share the mutation now (spine >= holds as equality)', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)

    const { issue: after } = await as(t, f.user).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: issue.id,
      reason: '  obsolete  ',
    })

    const comments = await t.run(async (ctx) =>
      ctx.db
        .query('comments')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .collect(),
    )
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('obsolete')
    expect(comments[0].author).toBe(f.user.id)

    const msgs = await messagesFor(t, f.guest.id, issue.id)
    expect(msgs.map((m) => m.kind).sort()).toEqual(['change', 'comment'])
    expect(msgs.find((m) => m.kind === 'change')!.detail).toBe('Archived')
    expect(msgs.find((m) => m.kind === 'comment')!.detail).toBe('New comment') // Inbox secondLine key
    for (const m of msgs) {
      expect(m.created_at).toBe(comments[0].created_at) // ONE now — 0111
      expect(m.created_at >= comments[0].created_at).toBe(true) // spine.ts's >=
    }
    expect(after.archived_at).toBe(comments[0].created_at)
    // the author was subscribed by their comment but never self-messaged
    expect(await messagesFor(t, f.user.id, issue.id)).toHaveLength(0)

    // archiving an archived row is a no-op: no second comment, no new messages
    await tick()
    await as(t, f.user).mutation(api.issues.archive, {
      org_id: f.org.id,
      id: issue.id,
      reason: 'again',
    })
    expect(
      await t.run(async (ctx) =>
        ctx.db
          .query('comments')
          .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
          .collect(),
      ),
    ).toHaveLength(1)
    expect(await messagesFor(t, f.guest.id, issue.id)).toHaveLength(2)
  })

  it('descendant/ancestor cascade echoes are suppressed; the root row itself narrates', async () => {
    const t = newT()
    const f = await withOrg(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const child = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    await subscribe(t, f.admin, parent.id)
    await subscribe(t, f.admin, child.id)

    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: parent.id })
    expect((await messagesFor(t, f.admin.id, parent.id)).map((m) => m.detail)).toEqual(['Archived'])
    expect(await messagesFor(t, f.admin.id, child.id)).toHaveLength(0) // descendant echo suppressed

    await drainMessages(t)
    await tick()
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: child.id })
    expect((await messagesFor(t, f.admin.id, child.id)).map((m) => m.detail)).toEqual(['Restored'])
    expect(await messagesFor(t, f.admin.id, parent.id)).toHaveLength(0) // ancestor echo suppressed
    const parentAfter = await t.run(async (ctx) => (await ctx.db.get(parent._id)) as Doc<'issues'>)
    expect(parentAfter.archived_at).toBeUndefined() // but the restore itself happened
  })
})

describe('notifyIssueInsert via issues.create', () => {
  it('the assignee subscribes and reads Assigned to you; nobody else hears about a fresh row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      title: 'New task',
      assignee_id: f.guest.id,
    })
    const msgs = await messagesFor(t, f.guest.id, id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('change')
    expect(msgs[0].detail).toBe('Assigned to you')
    expect(await allMessages(t)).toHaveLength(1)
    const sub = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue_profile', (q) => q.eq('issue_id', id).eq('profile_id', f.guest.id))
        .unique(),
    )
    expect(sub).not.toBeNull()
  })

  it('a mentioned assignee gets the mention only, and subscribes once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      title: 'New task',
      description: `For @[admin](user:${f.admin.id})`,
      assignee_id: f.admin.id,
    })
    const msgs = await messagesFor(t, f.admin.id, id)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].kind).toBe('mention')
    expect(msgs[0].detail).toBe('Mentioned you in the description')
    const subs = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', id))
        .collect(),
    )
    expect(subs.map((s) => s.profile_id)).toEqual([f.admin.id])
  })

  it('self-assignment subscribes silently', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await as(t, f.user).mutation(api.issues.create, {
      org_id: f.org.id,
      id,
      project_id: f.sub.id,
      title: 'Mine',
      assignee_id: f.user.id,
    })
    expect(await allMessages(t)).toHaveLength(0)
    const subs = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', id))
        .collect(),
    )
    expect(subs.map((s) => s.profile_id)).toEqual([f.user.id])
  })
})

/* #314: whoever the task passes to starts following it. The reviewer owns a
 * task In Review; in every other status they are only a field. */
describe('reviewer notifications', () => {
  const followers = async (t: T, issueId: string): Promise<string[]> =>
    (
      await t.run(async (ctx) =>
        ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
          .collect(),
      )
    ).map((s) => s.profile_id)
  const details = async (t: T, who: Doc<'profiles'>, issueId: string): Promise<string[]> =>
    (await messagesFor(t, who.id, issueId)).map((m) => m.detail)
  const create = (t: T, actor: Doc<'profiles'>, args: Omit<CreateArgs, 'org_id'>) =>
    as(t, actor).mutation(api.issues.create, { org_id: actor.org_id, ...args })

  it('entering Review hands the task to its reviewer: they start following and read Ready for your review first', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'progress',
      assignee_id: f.guest.id,
      reviewer_id: f.admin.id,
      remaining_hours: 6,
      remaining_set_at: NOW,
    })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.guest.id })

    await update(t, f.user, issue.id, { status: 'review' })

    expect(await followers(t, issue.id)).toContain(f.admin.id)
    const [ready] = await messagesFor(t, f.admin.id, issue.id)
    expect(ready.kind).toBe('change')
    expect(await details(t, f.admin, issue.id)).toEqual([
      'Ready for your review. Status: In Progress → In Review. Remaining: 6 h → 2 h',
    ])
    expect(await details(t, f.guest, issue.id)).toEqual([
      'Status: In Progress → In Review. Remaining: 6 h → 2 h',
    ])
  })

  it('a reviewer set in Review is handed the task once: a re-send posts nothing, later edits read plain', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      assignee_id: f.guest.id,
    })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.guest.id })

    await update(t, f.user, issue.id, { reviewer_id: f.admin.id })
    expect(await followers(t, issue.id)).toContain(f.admin.id)
    expect(await details(t, f.admin, issue.id)).toEqual(['Ready for your review'])
    expect(await details(t, f.guest, issue.id)).toEqual([`Reviewer set to ${f.admin.name}`])

    await drainMessages(t)
    await tick()
    await update(t, f.user, issue.id, { reviewer_id: f.admin.id })
    expect(await allMessages(t)).toHaveLength(0)

    // the reviewer keeps the task: no second hand-off line
    await tick()
    await update(t, f.user, issue.id, { priority: 'high' })
    expect(await details(t, f.admin, issue.id)).toEqual(['Priority: Medium → High'])
  })

  it('changing the reviewer in Review hands over: the new one is told, the old one reads who took it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      reviewer_id: f.admin.id,
    })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.admin.id })

    await update(t, f.user, issue.id, { reviewer_id: f.guest.id })

    expect(await followers(t, issue.id)).toContain(f.guest.id)
    expect(await details(t, f.guest, issue.id)).toEqual(['Ready for your review'])
    expect(await details(t, f.admin, issue.id)).toEqual([`Reviewer set to ${f.guest.name}`])
  })

  it('clearing the reviewer in Review hands the task back: a muted assignee follows again', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the assignee turned their eye off: no subscription row
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      assignee_id: f.guest.id,
      reviewer_id: f.admin.id,
    })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.admin.id })

    await update(t, f.user, issue.id, { reviewer_id: null })

    const removed = `Reviewer removed (was ${f.admin.name})`
    expect((await followers(t, issue.id)).sort()).toEqual([f.admin.id, f.guest.id].sort())
    expect(await details(t, f.admin, issue.id)).toEqual([removed])
    expect(await details(t, f.guest, issue.id)).toEqual([removed])
  })

  it('a group never changes hands: clearing its dormant reviewer, by a write or a move, leaves a muted assignee muted', async () => {
    const t = newT()
    const f = await withOrg(t)
    // groups that kept status Review and a reviewer from their leaf days;
    // the assignee (admin) turned their eye off, the reviewer (guest) follows
    const plantGroup = async () => {
      const base = { org_id: f.org.id, project_id: f.sub.id }
      const group = await plantIssue(t, {
        ...base,
        status: 'review',
        assignee_id: f.admin.id,
        reviewer_id: f.guest.id,
      })
      await plantIssue(t, { ...base, parent_id: group.id })
      await plantSubscription(t, { issue_id: group.id, profile_id: f.guest.id })
      return group
    }
    const removed = `Reviewer removed (was ${f.guest.name})`

    const written = await plantGroup()
    await update(t, f.user, written.id, { reviewer_id: null })
    expect(await followers(t, written.id)).toEqual([f.guest.id])
    expect(await details(t, f.guest, written.id)).toEqual([removed])

    // guest holds no grant under hidden, so the move clears the reviewer
    const moved = await plantGroup()
    const dest = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: moved.id,
      project_id: dest.id,
    })
    expect(await followers(t, moved.id)).toEqual([f.guest.id])
    expect(await messagesFor(t, f.admin.id)).toHaveLength(0)
  })

  it('the task passes back and forth: leaving Review re-subscribes the assignee, re-entering re-subscribes the reviewer', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'review',
      assignee_id: f.guest.id,
      reviewer_id: f.admin.id,
    })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.admin.id })

    // changes requested: back to the assignee, who had unsubscribed
    await update(t, f.user, issue.id, { status: 'progress' })
    expect(await followers(t, issue.id)).toContain(f.guest.id)
    expect(await details(t, f.guest, issue.id)).toEqual(['Status: In Review → In Progress'])

    // the reviewer mutes it while the work is back In Progress
    await as(t, f.admin).mutation(api.issues.unsubscribe, { org_id: f.org.id, issue_id: issue.id })
    expect(await followers(t, issue.id)).not.toContain(f.admin.id)
    await drainMessages(t)
    await tick()

    await update(t, f.user, issue.id, { status: 'review' })
    expect(await followers(t, issue.id)).toContain(f.admin.id)
    expect(await details(t, f.admin, issue.id)).toEqual([
      'Ready for your review. Status: In Progress → In Review. Remaining set to 2 h',
    ])
    expect(await details(t, f.guest, issue.id)).toEqual([
      'Status: In Progress → In Review. Remaining set to 2 h',
    ])
  })

  it('a reviewer who moves the task into Review follows it without messaging themselves', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'progress',
      assignee_id: f.guest.id,
      reviewer_id: f.admin.id,
    })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.guest.id })

    await update(t, f.admin, issue.id, { status: 'review' })

    expect(await followers(t, issue.id)).toContain(f.admin.id)
    expect(await messagesFor(t, f.admin.id, issue.id)).toHaveLength(0)
    expect(await details(t, f.guest, issue.id)).toEqual([
      'Status: In Progress → In Review. Remaining set to 2 h',
    ])
  })

  it('outside Review a reviewer is only a field: not subscribed, told nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)

    await update(t, f.user, issue.id, { reviewer_id: f.admin.id })

    expect(await followers(t, issue.id)).not.toContain(f.admin.id)
    expect(await messagesFor(t, f.admin.id)).toHaveLength(0)
    expect(await details(t, f.guest, issue.id)).toEqual([`Reviewer set to ${f.admin.name}`])
  })

  it('a reviewer already following reads Reviewer set to you outside Review', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.admin, issue.id)

    await update(t, f.user, issue.id, { reviewer_id: f.admin.id })

    expect(await details(t, f.admin, issue.id)).toEqual(['Reviewer set to you'])
  })

  it('a task created In Review belongs to its reviewer: they follow it and read Ready for your review, with no assignee', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await create(t, f.user, {
      id,
      project_id: f.sub.id,
      title: 'Check it',
      status: 'review',
      reviewer_id: f.admin.id,
    })

    expect(await followers(t, id)).toEqual([f.admin.id])
    expect(await details(t, f.admin, id)).toEqual(['Ready for your review'])
    expect(await allMessages(t)).toHaveLength(1)
  })

  it('a task created with the assignee as its own reviewer sends one line: Assigned to you', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await create(t, f.user, {
      id,
      project_id: f.sub.id,
      title: 'Check it',
      status: 'review',
      assignee_id: f.guest.id,
      reviewer_id: f.guest.id,
    })

    expect(await followers(t, id)).toEqual([f.guest.id])
    expect(await details(t, f.guest, id)).toEqual(['Assigned to you'])
    expect(await allMessages(t)).toHaveLength(1)
  })

  it('a task created in any other status leaves its reviewer out', async () => {
    const t = newT()
    const f = await withOrg(t)
    const id = uuid()
    await create(t, f.user, {
      id,
      project_id: f.sub.id,
      title: 'Later',
      status: 'todo',
      assignee_id: f.guest.id,
      reviewer_id: f.admin.id,
    })

    expect(await followers(t, id)).toEqual([f.guest.id])
    expect(await details(t, f.guest, id)).toEqual(['Assigned to you'])
    expect(await messagesFor(t, f.admin.id)).toHaveLength(0)
  })
})

describe('postMessage fence', () => {
  it('invisible and foreign-org recipients are dropped silently — no row, no error', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // planted RAW past the subscribe fence: the agent cannot see sub, the
    // other admin is not in this org at all
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.agent.id })
    await plantSubscription(t, { issue_id: issue.id, profile_id: f.otherAdmin.id })
    await subscribe(t, f.admin, issue.id)

    await update(t, f.user, issue.id, { priority: 'high' })

    expect((await messagesFor(t, f.admin.id, issue.id))[0].detail).toBe('Priority: Medium → High')
    expect(await messagesFor(t, f.agent.id)).toHaveLength(0)
    expect(await messagesFor(t, f.otherAdmin.id)).toHaveLength(0)
    expect(await allMessages(t)).toHaveLength(1)
  })
})

describe('pruneReadMessages — the 0109 pair invariant', () => {
  it('an arrival retires the read messages it supersedes (the postMessage call site)', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)

    await update(t, f.user, issue.id, { status: 'progress' })
    const [m1] = await messagesFor(t, f.guest.id, issue.id)
    await t.run(async (ctx) => ctx.db.patch(m1._id, { read_at: new Date().toISOString() }))

    await tick()
    await update(t, f.user, issue.id, { status: 'review' })
    let msgs = await messagesFor(t, f.guest.id, issue.id)
    expect(msgs).toHaveLength(1) // the read m1 is gone
    expect(msgs[0].detail).toBe('Status: In Progress → In Review. Remaining set to 2 h')
    expect(msgs[0].read_at).toBeUndefined()

    // unread messages are NEVER pruned: a third arrival stacks
    await tick()
    await update(t, f.user, issue.id, { status: 'done' })
    msgs = await messagesFor(t, f.guest.id, issue.id)
    expect(msgs.map((m) => m.detail)).toEqual([
      'Status: In Progress → In Review. Remaining set to 2 h',
      'Status: In Review → Done',
    ])
  })

  it('the markRead call site: read rows die except the pair newest (kept read or not); unread always stay', async () => {
    const t = newT()
    const f = await withOrg(t)
    const READ = '2026-01-02T00:00:00.000Z'
    const base = { org_id: f.org.id, recipient_id: f.guest.id }

    // pair A: two read + one newer unread → only the unread newest survives
    const issueA = uuid()
    await plantMessage(t, {
      ...base,
      issue_id: issueA,
      created_at: '2026-01-01T00:00:01.000Z',
      read_at: READ,
    })
    await plantMessage(t, {
      ...base,
      issue_id: issueA,
      created_at: '2026-01-01T00:00:02.000Z',
      read_at: READ,
    })
    const a3 = await plantMessage(t, {
      ...base,
      issue_id: issueA,
      created_at: '2026-01-01T00:00:03.000Z',
    })

    // pair B: newest is READ → it is the one kept; the older unread stays too
    const issueB = uuid()
    const b1 = await plantMessage(t, {
      ...base,
      issue_id: issueB,
      created_at: '2026-01-01T00:00:01.000Z',
    })
    const b2 = await plantMessage(t, {
      ...base,
      issue_id: issueB,
      created_at: '2026-01-01T00:00:02.000Z',
      read_at: READ,
    })

    // pair C: identical instants — the id breaks the tie, same as the client's isNewer
    const issueC = uuid()
    await plantMessage(t, { ...base, issue_id: issueC, id: 'aaaa', created_at: NOW, read_at: READ })
    const c2 = await plantMessage(t, {
      ...base,
      issue_id: issueC,
      id: 'bbbb',
      created_at: NOW,
      read_at: READ,
    })

    // a foreign pair is untouched by another pair's prune
    const d1 = await plantMessage(t, {
      org_id: f.org.id,
      recipient_id: f.admin.id,
      issue_id: issueA,
      created_at: '2026-01-01T00:00:01.000Z',
      read_at: READ,
    })

    await t.run(async (ctx) => {
      await pruneReadMessages(ctx, { recipient_id: f.guest.id, issue_id: issueA })
      await pruneReadMessages(ctx, { recipient_id: f.guest.id, issue_id: issueB })
      await pruneReadMessages(ctx, { recipient_id: f.guest.id, issue_id: issueC })
    })

    expect((await messagesFor(t, f.guest.id, issueA)).map((m) => m.id)).toEqual([a3.id])
    expect((await messagesFor(t, f.guest.id, issueB)).map((m) => m.id).sort()).toEqual(
      [b1.id, b2.id].sort(),
    )
    expect((await messagesFor(t, f.guest.id, issueC)).map((m) => m.id)).toEqual([c2.id])
    expect((await messagesFor(t, f.admin.id, issueA)).map((m) => m.id)).toEqual([d1.id])
  })
})

describe('notifyCommentInsert (model — composed by phase 5 comments.create)', () => {
  it('mentions hear the mention, other followers hear New comment, the author subscribes silently — all at one instant', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)
    await subscribe(t, f.viewer, issue.id)
    const commentNow = '2026-01-05T12:00:00.000Z'

    await t.run(async (ctx) => {
      const _id = await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: issue.id,
        author: f.admin.id,
        body: `@[viewer](user:${f.viewer.id}) take a look`,
        created_at: commentNow,
      })
      const comment = (await ctx.db.get(_id)) as Doc<'comments'>
      const issueDoc = (await ctx.db.get(issue._id)) as Doc<'issues'>
      await notifyCommentInsert(ctx, { comment, issue: issueDoc, actor: f.admin, now: commentNow })
    })

    const viewerMsgs = await messagesFor(t, f.viewer.id, issue.id)
    expect(viewerMsgs).toHaveLength(1)
    expect(viewerMsgs[0].kind).toBe('mention')
    expect(viewerMsgs[0].detail).toBe('Mentioned you in a comment')
    const guestMsgs = await messagesFor(t, f.guest.id, issue.id)
    expect(guestMsgs).toHaveLength(1)
    expect(guestMsgs[0].kind).toBe('comment')
    expect(guestMsgs[0].detail).toBe('New comment')
    expect(await messagesFor(t, f.admin.id, issue.id)).toHaveLength(0) // the author-actor
    for (const m of [...viewerMsgs, ...guestMsgs]) expect(m.created_at).toBe(commentNow)
    const subs = await t.run(async (ctx) =>
      ctx.db
        .query('issue_subscriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', issue.id))
        .collect(),
    )
    expect(subs.map((s) => s.profile_id).sort()).toEqual(
      [f.guest.id, f.viewer.id, f.admin.id].sort(),
    )
  })

  it("a seed's visibility memo answers repeat checks; without a preload each check is live", async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)
    const visibility = new Map<string, boolean>()
    const comment = (withPreload: boolean) =>
      t.run(async (ctx) => {
        const preload: NotifyPreload = {
          orgProfiles: await ctx.db
            .query('profiles')
            .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
            .collect(),
          projects: new Map([[f.sub.id, f.sub]]),
          visibility,
        }
        await notifyCommentInsert(ctx, {
          comment: { body: 'Any news?' },
          issue,
          actor: f.admin,
          now: NOW,
          preload: withPreload ? preload : undefined,
        })
      })

    await comment(true)
    expect(await messagesFor(t, f.guest.id, issue.id)).toHaveLength(1)
    // the author's subscribe check and the guest's delivery check
    expect([...visibility.values()]).toEqual([true, true])

    // The guest loses the grant that let them see the project. The memo
    // still says yes, which is why only a seed that changes no access may
    // pass one; the live check drops the guest.
    await t.run(async (ctx) => {
      const grant = await ctx.db
        .query('project_access')
        .withIndex('by_project_profile', (q) =>
          q.eq('project_id', f.meta.id).eq('profile_id', f.guest.id),
        )
        .unique()
      if (grant === null) throw new Error('fixture grant missing')
      await ctx.db.delete(grant._id)
    })
    await comment(true)
    expect(await messagesFor(t, f.guest.id, issue.id)).toHaveLength(2)
    await comment(false)
    expect(await messagesFor(t, f.guest.id, issue.id)).toHaveLength(2)
  })
})

describe('extractMentions (0075, not 0074)', () => {
  const prof = (id: string) => ({ id }) as unknown as Doc<'profiles'>
  const u1 = uuid()
  const u2 = uuid()
  const profiles = [prof(u1), prof(u2)]

  it('matches @[label](user:uuid), case-insensitively, with space/tab padding', () => {
    expect(extractMentions(`hi @[Ann](user:${u1})`, profiles).map((p) => p.id)).toEqual([u1])
    expect(
      extractMentions(`hi @[Ann]( \tUSER:${u1.toUpperCase()}\t )`, profiles).map((p) => p.id),
    ).toEqual([u1])
  })

  it('a plain link is not a mention, and labels cannot contain brackets', () => {
    expect(extractMentions(`[Ann](user:${u1})`, profiles)).toEqual([])
    expect(extractMentions(`@[An[n](user:${u1})`, profiles)).toEqual([])
  })

  it('code contexts are stripped first: fences (closed or to EOF) and backtick spans', () => {
    expect(
      extractMentions(`\`\`\`\n@[A](user:${u1})\n\`\`\`\n@[B](user:${u2})`, profiles).map(
        (p) => p.id,
      ),
    ).toEqual([u2])
    expect(
      extractMentions(`@[A](user:${u1})\n\`\`\`\n@[B](user:${u2})`, profiles).map((p) => p.id),
    ).toEqual([u1]) // the unclosed fence swallows to EOF
    expect(
      extractMentions(`\`@[A](user:${u1})\` and @[B](user:${u2})`, profiles).map((p) => p.id),
    ).toEqual([u2])
  })

  it('distinct uuids, unknown uuids dropped', () => {
    expect(
      extractMentions(`@[A](user:${u1}) @[A again](user:${u1.toUpperCase()})`, profiles).map(
        (p) => p.id,
      ),
    ).toEqual([u1])
    expect(extractMentions(`@[X](user:${uuid()})`, profiles)).toEqual([])
  })
})

describe('template bytes', () => {
  it('every narration template, byte for byte', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)
    const step = async (patch: Patch, expected: string) => {
      await tick()
      await update(t, f.user, issue.id, patch)
      const msgs = await messagesFor(t, f.guest.id, issue.id)
      expect(msgs.map((m) => m.detail)).toEqual([expected])
      await drainMessages(t)
    }

    await step({ status: 'progress' }, 'Status: To Do → In Progress')
    await step({ priority: 'urgent' }, 'Priority: Medium → Urgent')
    await step({ title: 'Rename me' }, 'Title: “Planted task” → “Rename me”')

    await step({ due_date: '2026-08-05' }, 'Due set to 5 Aug')
    await step({ due_date: '2026-09-12' }, 'Due: 5 Aug → 12 Sep')
    await step({ due_date: null }, 'Due cleared (was 12 Sep)')

    await step({ start_week: '2026-01-05', end_week: '2026-01-11' }, 'Scheduled 5 Jan – 11 Jan')
    await step(
      { start_week: '2026-01-12', end_week: '2026-01-18' },
      'Schedule: 5 Jan – 11 Jan → 12 Jan – 18 Jan',
    )
    await step({ start_week: null, end_week: null }, 'Unscheduled (was 12 Jan – 18 Jan)')

    // FM999990.# is INTEGER rounding on the live deployment (80.5 → 81)
    await step({ remaining_hours: 80.5 }, 'Remaining set to 81 h')
    await step({ remaining_hours: 3 }, 'Remaining: 81 h → 3 h')
    await step({ remaining_hours: null }, 'Remaining cleared (was 3 h)')

    await step({ paused: true }, 'Paused')
    await step({ paused: false }, 'Resumed')

    // move + attach/detach
    await tick()
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: issue.id,
      project_id: f.sub2.id,
    })
    expect((await messagesFor(t, f.guest.id, issue.id)).map((m) => m.detail)).toEqual([
      'Moved to Board rev',
    ])
    await drainMessages(t)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await step({ parent_id: parent.id }, `Attached under QN-${parent.num}`)
    await step({ parent_id: null }, 'Detached from its parent')
  })

  it('multi-part messages join as separate sentences', async () => {
    const t = newT()
    const f = await withOrg(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await subscribe(t, f.guest, issue.id)
    await update(t, f.user, issue.id, { status: 'progress', priority: 'high' })
    const [m] = await messagesFor(t, f.guest.id, issue.id)
    expect(m.detail).toBe('Status: To Do → In Progress. Priority: Medium → High')
    expect(m.detail).toContain('. ')
    expect(m.detail).toContain(' → ')
    expect(m.detail).not.toContain('->')
  })
})
