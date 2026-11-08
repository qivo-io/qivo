/* The follower popover's reads (issues.subscribers, pickers.taskFollowers)
 * and writes (issues.setSubscriber, subscribe, unsubscribe): who reads the
 * followers as rows, who manages them, and whom the Add list offers. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ } from '../lib/namedPages'
import { MANAGE_FOLLOWERS_RULE, PICKERS } from '../model/pickers'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantSeat,
  plantSubscription,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'subscribers-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_RULE = structuredClone(PICKERS.rule)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(PICKERS.rule, DEFAULT_RULE)
})

async function fixture() {
  const t = newT()
  const f = await withReadingAdmin(t)
  const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
  const ordinary = await plantSeat(t, {
    org_id: f.org.id,
    auth_user_id: uuid(),
    name: 'Ordinary teammate',
  })
  await t.run(async (ctx) => {
    await ctx.db.insert('team_members', {
      team_id: f.team.id,
      profile_id: ordinary.id,
      is_leader: false,
    })
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: ordinary.id,
      level: 'user',
    })
  })
  await keyOrg(t, f.org.id)
  /* The roster with its followers as ids, beside the rows (`rows`). */
  const roster = async (who: Doc<'profiles'>, issue_id = issue.id) => {
    const answer = await as(t, who).query(api.issues.subscribers, { org_id: who.org_id, issue_id })
    return { ...answer, subscribers: answer.subscribers.map((row) => row.id), rows: answer }
  }
  /* The Add list's people for `who`, every batch, as ids; none for a
   * caller it refuses. */
  const candidates = async (who: Doc<'profiles'>, issue_id = issue.id, search?: string) => {
    const ids: string[] = []
    let after: string | undefined
    for (let n = 0; n < 50; n++) {
      const answer = await as(t, who).query(api.pickers.taskFollowers, {
        org_id: who.org_id,
        issue_id,
        ...(search === undefined ? {} : { search }),
        ...(after === undefined ? {} : { after }),
      })
      if (answer.state !== 'ready') return ids
      ids.push(...answer.rows.map((row) => row.id))
      if (answer.next === null) return ids
      after = answer.next
    }
    throw new Error('the list did not end')
  }
  const set = (
    who: Doc<'profiles'>,
    profile_id: string,
    subscribed: boolean,
    issue_id = issue.id,
  ) =>
    as(t, who).mutation(api.issues.setSubscriber, {
      org_id: who.org_id,
      issue_id,
      profile_id,
      subscribed,
    })
  return { t, f, issue, ordinary, roster, candidates, set }
}

describe('task subscriber popover', () => {
  it('lets every task viewer read subscribers and change only their own subscription', async () => {
    const { t, f, issue, ordinary, roster, set } = await fixture()
    await set(f.admin, f.admin.id, true)
    for (const who of [ordinary, f.viewer, f.guest]) {
      expect((await roster(who)).rows).toEqual({
        canManage: false,
        subscribers: [
          { id: f.admin.id, name: 'admin', initials: 'AD', color: '#7a7ad0', active: true },
        ],
        more: false,
      })
      // the Add list refuses who may not manage, with the write's sentence
      expect(
        await as(t, who).query(api.pickers.taskFollowers, {
          org_id: f.org.id,
          issue_id: issue.id,
        }),
      ).toEqual({ state: 'refused', message: MANAGE_FOLLOWERS_RULE })
      // Existing self APIs remain available to read-only and guest seats.
      await as(t, who).mutation(api.issues.subscribe, {
        org_id: f.org.id,
        issue_id: issue.id,
      })
      expect((await roster(who)).subscribers).toContain(who.id)
      await set(who, who.id, false)
      await set(who, who.id, true)
      await as(t, who).mutation(api.issues.unsubscribe, {
        org_id: f.org.id,
        issue_id: issue.id,
      })
      for (const subscribed of [true, false]) {
        await expectRefusal(
          set(who, f.admin.id, subscribed),
          'forbidden',
          /manage other subscribers/,
        )
      }
    }
    expect((await roster(f.admin)).subscribers).toEqual([f.admin.id])
  })

  it('lets project leads and org admins add and remove viewers idempotently without notifications', async () => {
    const { t, f, issue, ordinary, roster, candidates, set } = await fixture()
    for (const manager of [f.admin, f.user]) {
      expect((await roster(manager)).canManage).toBe(true)
      // the caller is the Me row's, never the Add list's
      expect(await candidates(manager)).not.toContain(manager.id)
      for (const target of [f.viewer, f.guest, ordinary]) {
        expect(await candidates(manager)).toContain(target.id)
        await set(manager, target.id, true)
        await set(manager, target.id, true)
        const subscribed = await roster(manager)
        expect(subscribed.subscribers.filter((id) => id === target.id)).toHaveLength(1)
        expect(await candidates(manager)).not.toContain(target.id)
        await set(manager, target.id, false)
        await set(manager, target.id, false)
        expect((await roster(manager)).subscribers).not.toContain(target.id)
      }
    }
    await t.run(async (ctx) => {
      expect(
        await ctx.db
          .query('issue_subscriptions')
          .withIndex('by_issue_task_archived', (q) => q.eq('issue_id', issue.id))
          .collect(),
      ).toEqual([])
      expect(await ctx.db.query('messages').collect()).toEqual([])
      expect(await ctx.db.query('activity_events').collect()).toEqual([])
    })
  })

  it('does not grant management through ordinary sharing', async () => {
    const { t, f, ordinary, roster, set } = await fixture()
    const ledIssue = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    expect((await roster(f.user, ledIssue.id)).canManage).toBe(true)
    await set(f.user, f.admin.id, true, ledIssue.id)
    expect((await roster(ordinary)).canManage).toBe(false)
    await expectRefusal(set(ordinary, f.viewer.id, true), 'forbidden')
  })

  it('uses current inherited team access for candidates and rechecks it when adding', async () => {
    const { t, f, issue, roster, candidates, set } = await fixture()
    const teammate = await plantSeat(t, { org_id: f.org.id, auth_user_id: uuid() })
    const sharedTeamId = uuid()
    await as(t, f.admin).mutation(api.teams.create, {
      org_id: f.org.id,
      id: sharedTeamId,
      name: 'Shared team',
    })
    await as(t, f.admin).mutation(api.teams.addMember, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: teammate.id,
    })
    await as(t, f.admin).mutation(api.teams.setLeader, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: teammate.id,
      is_leader: true,
    })
    await as(t, f.admin).mutation(api.projects.setAccess, {
      org_id: f.org.id,
      id: f.meta.id,
      team_id: sharedTeamId,
      level: 'viewer',
    })
    await keyOrg(t, f.org.id)
    expect(await candidates(f.user)).toContain(teammate.id)
    // Leadership of a shared team grants visibility, not managing authority.
    expect((await roster(teammate)).canManage).toBe(false)
    await expectRefusal(set(teammate, f.viewer.id, true), 'forbidden')
    await set(f.user, teammate.id, true)
    await as(t, f.admin).mutation(api.teams.removeMember, {
      org_id: f.org.id,
      team_id: sharedTeamId,
      profile_id: teammate.id,
    })
    expect((await roster(f.user)).subscribers).toContain(teammate.id)
    await expectRefusal(set(f.user, teammate.id, true), 'rule', /can see this task/)
    await expectRefusal(roster(teammate), 'not_found', /task not found/)
    await expectRefusal(set(teammate, teammate.id, false), 'not_found', /task not found/)
    // A manager can remove the stale subscription after access is revoked.
    await set(f.user, teammate.id, false)
    expect(await candidates(f.user)).not.toContain(teammate.id)
    expect((await roster(f.user)).subscribers).not.toContain(teammate.id)
    // The preexisting self-only unsubscribe remains usable after access loss.
    await as(t, teammate).mutation(api.issues.unsubscribe, {
      org_id: f.org.id,
      issue_id: issue.id,
    })
  })

  it('excludes inactive, inaccessible and foreign add targets while allowing stale subscriber removal', async () => {
    const { t, f, issue, roster, candidates, set } = await fixture()
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      active: false,
      org_role: 'admin',
    })
    await keyOrg(t, f.org.id)
    const missing = uuid()
    const offered = await candidates(f.user)
    for (const profileId of [inactive.id, f.agent.id, f.otherAdmin.id, missing]) {
      expect(offered).not.toContain(profileId)
    }
    for (const profileId of [inactive.id, f.agent.id]) {
      await expectRefusal(set(f.user, profileId, true), 'rule', /active user who can see/)
    }
    for (const profileId of [f.otherAdmin.id, missing]) {
      for (const subscribed of [true, false]) {
        await expectRefusal(set(f.user, profileId, subscribed), 'not_found', /subscriber not found/)
      }
    }
    for (const profileId of [inactive.id, f.otherAdmin.id, missing]) {
      await plantSubscription(t, { issue_id: issue.id, profile_id: profileId })
    }
    expect((await roster(f.user)).subscribers).toEqual([inactive.id])
    // a switched-off follower stays, marked so
    expect((await roster(f.user)).rows.subscribers[0]).toMatchObject({ active: false })
    await set(f.user, inactive.id, false)
    expect((await roster(f.user)).subscribers).toEqual([])
  })

  it('offers and adds a Standard user agent but never a Viewer agent, which has no inbox', async () => {
    const { t, f, roster, candidates, set } = await fixture()
    const ledger = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Ledger',
      kind: 'agent',
      org_role: 'viewer',
      plannable_hours: undefined,
    })
    await t.run(async (ctx) => {
      for (const p of [f.agent, ledger]) {
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: p.id,
          level: 'user',
        })
      }
    })
    await keyOrg(t, f.org.id)
    const offered = await candidates(f.user)
    expect(offered).toContain(f.agent.id)
    expect(offered).not.toContain(ledger.id)
    await set(f.user, f.agent.id, true)
    await expectRefusal(
      set(f.user, ledger.id, true),
      'rule',
      /a Viewer agent has no inbox and cannot follow tasks/,
    )
    expect((await roster(f.user)).subscribers).toEqual([f.agent.id])
  })

  it('gives hidden, foreign and missing tasks the same refusal on roster and management', async () => {
    const { t, f, roster, set } = await fixture()
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
    })
    for (const issueId of [hidden.id, foreign.id, uuid()]) {
      await expectRefusal(roster(f.guest, issueId), 'not_found', /task not found/)
      // the Add list answers them alike, before it reads any person
      expect(
        await as(t, f.user).query(api.pickers.taskFollowers, {
          org_id: f.org.id,
          issue_id: issueId === hidden.id ? foreign.id : issueId,
        }),
      ).toEqual({ state: 'unavailable' })
      for (const subscribed of [true, false]) {
        await expectRefusal(
          set(f.guest, f.admin.id, subscribed, issueId),
          'not_found',
          /task not found/,
        )
      }
    }
  })

  it('keeps project-lead authority after team leadership changes', async () => {
    const { t, f, roster, set } = await fixture()
    expect((await roster(f.user)).canManage).toBe(true)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: f.user.id,
        level: 'user',
      })
      const membership = await ctx.db
        .query('team_members')
        .withIndex('by_team_profile', (q) => q.eq('team_id', f.team.id).eq('profile_id', f.user.id))
        .unique()
      if (membership === null) throw new Error('missing fixture team membership')
      await ctx.db.patch(membership._id, { is_leader: false })
    })
    expect((await roster(f.user)).canManage).toBe(true)
    for (const subscribed of [true, false]) await set(f.user, f.viewer.id, subscribed)
    await set(f.user, f.user.id, true)
    expect((await roster(f.user)).subscribers).toContain(f.user.id)
  })

  it('searches the Add list by name or email, in any case, without accents, over every person', async () => {
    const { t, f, candidates } = await fixture()
    const zoe = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Zoë Quill',
      email: 'zq@studio.test',
      auth_user_id: uuid(),
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: zoe.id,
        level: 'viewer',
      })
    })
    await keyOrg(t, f.org.id)
    expect(await candidates(f.user, undefined, 'ZOE')).toEqual([zoe.id])
    expect(await candidates(f.user, undefined, 'studio.test')).toEqual([zoe.id])
    expect(await candidates(f.user, undefined, 'quill zq@')).toEqual([zoe.id])
    expect(await candidates(f.user, undefined, 'nobody')).toEqual([])
  })

  it('answers the Add list 25 a batch at the people figure, not_ready before the keys, over_budget past its rule and stopped past its walk', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const ask = (a: { search?: string; after?: string } = {}) =>
      as(t, f.user).query(api.pickers.taskFollowers, {
        org_id: f.org.id,
        issue_id: issue.id,
        ...a,
      })
    expect(await ask()).toEqual({ state: 'not_ready' })
    // the people figure: 1,000 people, every one with a grant on TBED
    await t.run(async (ctx) => {
      for (let i = 0; i < 995; i++) {
        const id = uuid()
        await ctx.db.insert('profiles', {
          id,
          org_id: f.org.id,
          name: `Person ${String(i).padStart(4, '0')}`,
          initials: 'PE',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
        await ctx.db.insert('project_access', {
          project_id: f.meta.id,
          profile_id: id,
          level: 'user',
        })
      }
    })
    await keyOrg(t, f.org.id)
    const first = await ask()
    if (first.state !== 'ready') throw new Error(first.state)
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first.next).not.toBeNull()
    const second = await ask({ after: first.next ?? '' })
    if (second.state !== 'ready') throw new Error(second.state)
    expect(second.rows).toHaveLength(LIST_BATCH)
    expect(second.rows.map((r) => r.id)).not.toContain(first.rows[0].id)
    // a cursor of another search is refused
    await expectRefusal(ask({ after: first.next ?? '', search: 'person' }), 'bad_request')
    // a walk past a lowered ceiling stops and says so
    Object.assign(NAMED_READ, { ranges: 3, documents: 20, bytes: 4 * 1024 * 1024 })
    const stopped = await ask({ search: 'nobody at all' })
    if (stopped.state !== 'ready') throw new Error(stopped.state)
    expect(stopped).toMatchObject({ rows: [], stopped: true })
    expect(stopped.next).not.toBeNull()
    // a rule past its lowered share answers over_budget with no row
    Object.assign(NAMED_READ, DEFAULT_READ)
    Object.assign(PICKERS.rule, { ranges: 1, documents: 1, bytes: 1 })
    expect(await ask()).toEqual({ state: 'over_budget' })
  }, 60_000)

  it('answers at most LIMITS.followers.max followers in name order and says when the task has more', async () => {
    const { t, f, issue, roster } = await fixture()
    const crowd: Doc<'profiles'>[] = []
    for (let i = 0; i < LIMITS.followers.max + 1; i++)
      crowd.push(
        await plantSeat(t, {
          org_id: f.org.id,
          name: `Follower ${String(LIMITS.followers.max - i).padStart(3, '0')}`,
        }),
      )
    for (const p of crowd) await plantSubscription(t, { issue_id: issue.id, profile_id: p.id })
    const answer = (await roster(f.user)).rows
    expect(answer.more).toBe(true)
    expect(answer.subscribers).toHaveLength(LIMITS.followers.max)
    const names = answer.subscribers.map((r) => r.name)
    expect(names).toEqual([...names].sort())
    // the rows hold no email
    expect(Object.keys(answer.subscribers[0]).sort()).toEqual(
      ['active', 'color', 'id', 'initials', 'name'].sort(),
    )
  })
})
