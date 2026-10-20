/* Bounded profile removal (model/cascade.ts removeProfile and the
 * background steps in profileRemovals.ts).
 *
 * The removal transaction must fit Convex's limits in a large organization
 * and for a profile holding thousands of open tasks, and end access before
 * any background step runs. The steps must finish any amount of history in
 * bounded batches, survive a dropped or repeated step, pick up a row that
 * appears late, and end in the same state the old single transaction
 * reached, where no row names the removed id and the job row is gone.
 * Fake timers keep every scheduled step from running until a test releases
 * it. The cascade.test.ts removeProfile cases pin the row-level end state. */
/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, components, internal } from '../_generated/api'
import type { Doc, TableNames } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { mcpResource } from '../lib/oauth'
import { deleteOrgDeep, REMOVAL_BUDGET, REVOKE_AT_ONCE, removeProfile } from '../model/cascade'
import { STALLED_MS } from '../profileRemovals'
import schema from '../schema'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { assertNoDanglingRefs } from './refs.setup'

declare class Blob {
  constructor(parts: string[])
}

const START = Date.parse('2026-05-04T10:00:00.000Z')
const DEFAULT_BUDGET = { ...REMOVAL_BUDGET }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(START)
})
afterEach(() => {
  Object.assign(REMOVAL_BUDGET, DEFAULT_BUDGET)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const step = (t: T, profile_id: string) => t.mutation(internal.profileRemovals.step, { profile_id })

const jobOf = (t: T, profileId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('profile_removals')
      .withIndex('by_profile', (q) => q.eq('profile_id', profileId))
      .unique(),
  )

const stepsRun = (t: T) =>
  t.run(
    async (ctx) =>
      (await ctx.db.system.query('_scheduled_functions').collect()).filter(
        (job) => job.name.startsWith('profileRemovals') && job.state.kind === 'success',
      ).length,
  )

let nextNum = 10_000

/* n rows in every range the background steps clear for `profile`: archived
 * tasks it holds in all four fields, comments it wrote and edited, messages
 * it sent and received, subscriptions, attachments it uploaded, keys it
 * created for `agent`, and n OAuth connections with one replay hash each. */
async function plantHistory(
  t: T,
  a: {
    org_id: string
    project_id: string
    profile: Doc<'profiles'>
    other: Doc<'profiles'>
    agent: Doc<'profiles'>
  },
  n: number,
  id: () => string = uuid,
): Promise<void> {
  const { org_id, project_id } = a
  const p = a.profile.id
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      const task = id()
      await ctx.db.insert('issues', {
        id: task,
        org_id,
        project_id,
        num: nextNum++,
        title: `Archived ${i}`,
        description: '',
        status: 'done',
        priority: 'medium',
        paused: false,
        assignee_id: p,
        reviewer_id: p,
        created_by: p,
        reporter_id: p,
        done_at: NOW,
        archived_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      })
      await ctx.db.insert('comments', {
        id: id(),
        issue_id: task,
        author: p,
        edited_by: p,
        edited_at: NOW,
        body: `Comment ${i}`,
        created_at: NOW,
      })
      for (const [recipient_id, actor_id] of [
        [a.other.id, p],
        [p, a.other.id],
      ]) {
        await ctx.db.insert('messages', {
          id: id(),
          org_id,
          recipient_id,
          actor_id,
          issue_id: task,
          issue_title: `Archived ${i}`,
          kind: 'comment',
          detail: 'New comment',
          created_at: NOW,
        })
      }
      await ctx.db.insert('issue_subscriptions', { issue_id: task, profile_id: p, created_at: NOW })
      await ctx.db.insert('issue_attachments', {
        org_id,
        id: id(),
        issue_id: task,
        name: `file-${i}.txt`,
        size_bytes: 4,
        mime: 'text/plain',
        storage_id: await ctx.storage.store(new Blob(['file']) as never),
        inline: false,
        uploaded_by: p,
        created_at: NOW,
      })
      await ctx.db.insert('agent_keys', {
        id: id(),
        profile_id: a.agent.id,
        name: `Key ${i}`,
        key_prefix: 'qva_0000000',
        key_hash: id(),
        created_by: p,
        created_at: NOW,
      })
      const connection = id()
      await ctx.db.insert('oauth_connections', {
        id: connection,
        authorization_hash: id(),
        auth_user_id: a.profile.auth_user_id ?? 'login',
        profile_id: p,
        org_id,
        client_id: 'client',
        client_name: 'Client',
        resource: 'https://some.convex.site/mcp',
        requested_scopes: ['qivo:read'],
        scopes: ['qivo:read'],
        created_at: NOW,
        authorization_expires_at: NOW,
        approved_at: NOW,
      })
      await ctx.db.insert('oauth_credential_uses', {
        connection_id: connection,
        credential_hash: id(),
        kind: 'refresh_token',
        used_at: NOW,
      })
    }
  })
}

/* Rows that still name `profileId`, one per field, plus the replay hashes of
 * its connections. This is what the background steps have left to clear. */
const references = (t: T, profileId: string) =>
  t.run(async (ctx) => {
    let n = 0
    for (const task of await ctx.db.query('issues').collect())
      for (const field of ['assignee_id', 'reviewer_id', 'created_by', 'reporter_id'] as const)
        if (task[field] === profileId) n++
    for (const c of await ctx.db.query('comments').collect())
      n += Number(c.author === profileId) + Number(c.edited_by === profileId)
    for (const m of await ctx.db.query('messages').collect())
      n += Number(m.actor_id === profileId) + Number(m.recipient_id === profileId)
    for (const s of await ctx.db.query('issue_subscriptions').collect())
      n += Number(s.profile_id === profileId)
    for (const att of await ctx.db.query('issue_attachments').collect())
      n += Number(att.uploaded_by === profileId)
    for (const k of await ctx.db.query('agent_keys').collect())
      n += Number(k.created_by === profileId)
    const connections = new Set<string>()
    for (const c of await ctx.db.query('oauth_connections').collect())
      if (c.profile_id === profileId) connections.add(c.id)
    n += connections.size
    for (const use of await ctx.db.query('oauth_credential_uses').collect())
      n += Number(connections.has(use.connection_id))
    return n
  })

const remove = (t: T, profile: Doc<'profiles'>, now = new Date().toISOString()) =>
  t.run(async (ctx) => {
    await removeProfile(ctx, { profile, now })
  })

describe('the removal transaction under real limits', () => {
  it('removes a fresh invite and cancels another in an organization with 4,200 tasks', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < 4200; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          num: nextNum++,
          title: `Task ${i}`,
          description: '',
          status: i % 2 ? 'done' : 'todo',
          priority: 'medium',
          paused: false,
          archived_at: i % 2 ? NOW : undefined,
          created_at: NOW,
          updated_at: NOW,
        })
    })
    const invited = await plantSeat(t, { org_id: f.org.id, email: 'new@testbed.test' })
    const cancelled = await plantSeat(t, { org_id: f.org.id, email: 'gone@testbed.test' })
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', { auth_user_id: 'operator', note: 'test', created_at: NOW }),
    )
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: invited.id })
    await t
      .withIdentity({ subject: 'operator' })
      .mutation(api.adminOrgs.cancelInvite, { profile_id: cancelled.id })
    for (const seat of [invited, cancelled]) {
      expect(await t.run((ctx) => ctx.db.get(seat._id))).toBeNull()
      expect(await jobOf(t, seat.id)).not.toBeNull()
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await jobOf(t, invited.id)).toBeNull()
    expect(await jobOf(t, cancelled.id)).toBeNull()
  }, 120_000)

  it('clears one budget of an agent with 3,000 open tasks and leaves the rest to the steps', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const agent = f.agent.id
    // The agent created, reports and is assigned every task. Clearing all
    // 9,000 fields in one transaction reads each 2 KiB task twice per field,
    // about 40 MiB against the 16 MiB limit.
    const description = 'x'.repeat(2048)
    await t.run(async (ctx) => {
      for (let i = 0; i < 3000; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: f.sub.id,
          num: nextNum++,
          title: `Imported ${i}`,
          description,
          status: 'todo',
          priority: 'medium',
          paused: false,
          assignee_id: agent,
          created_by: agent,
          reporter_id: agent,
          created_at: NOW,
          updated_at: NOW,
        })
    })
    const held = () =>
      t.run(async (ctx) => {
        const count = { assignee_id: 0, created_by: 0, reporter_id: 0 }
        for (const task of await ctx.db.query('issues').collect())
          for (const field of Object.keys(count) as (keyof typeof count)[])
            if (task[field] === agent) count[field]++
        return count
      })

    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: agent })
    expect(await t.run((ctx) => ctx.db.get(f.agent._id))).toBeNull()
    expect(await jobOf(t, agent)).not.toBeNull()
    // one budget of rows, assignee fields first
    expect(await held()).toEqual({
      assignee_id: 3000 - REMOVAL_BUDGET.rows,
      created_by: 3000,
      reporter_id: 3000,
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await held()).toEqual({ assignee_id: 0, created_by: 0, reporter_id: 0 })
    expect(await jobOf(t, agent)).toBeNull()
  }, 120_000)
})

describe('background steps', () => {
  it('clear 2×budget+1 rows per range over many steps, never more than the row budget in one', async () => {
    REMOVAL_BUDGET.rows = 3
    const t = newT()
    const f = await withOrg(t)
    const history = { org_id: f.org.id, project_id: f.sub.id, other: f.admin, agent: f.agent }
    await plantHistory(t, { ...history, profile: f.user }, 7)
    await remove(t, f.user)
    let left = await references(t, f.user.id)
    // 7 tasks in four fields, 7 comments in two, 7 sent, 7 received, 7
    // subscriptions, attachments and keys, 7 connections with one hash each
    const total = 7 * 4 + 7 * 2 + 7 * 5 + 7 * 2
    expect(left).toBe(total)
    const phases = new Set<string>()
    let steps = 0
    for (;;) {
      await step(t, f.user.id)
      steps++
      const job = await jobOf(t, f.user.id)
      const now = await references(t, f.user.id)
      expect(left - now).toBeLessThanOrEqual(REMOVAL_BUDGET.rows)
      if (job === null) break
      expect(left - now, `step ${steps} in ${job.phase}`).toBeGreaterThan(0)
      if (steps === 1) expect(job.phase).toBe('tasks')
      phases.add(job.phase)
      left = now
    }
    expect(await references(t, f.user.id)).toBe(0)
    expect(steps).toBeGreaterThanOrEqual(Math.ceil(total / REMOVAL_BUDGET.rows))
    expect([...phases]).toEqual([
      'tasks',
      'comments',
      'sent_messages',
      'inbox',
      'subscriptions',
      'attachments',
      'agent_keys',
      'oauth',
    ])
    await assertNoDanglingRefs(t, 'after a batched removal')
  })

  it('stop on the byte budget, so very large comments cannot wedge a step', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // 15 comments near the 1 MiB document limit, 15 MiB: one read still fits
    const body = 'x'.repeat(1000 * 1024)
    for (let batch = 0; batch < 3; batch++)
      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++)
          await ctx.db.insert('comments', {
            id: uuid(),
            issue_id: task.id,
            author: f.user.id,
            body,
            created_at: NOW,
          })
      })
    await remove(t, f.user)
    const authored = () =>
      t.run(
        async (ctx) =>
          (
            await ctx.db
              .query('comments')
              .withIndex('by_author', (q) => q.eq('author', f.user.id))
              .collect()
          ).length,
      )
    // control case, a row budget alone reads every comment in one step
    REMOVAL_BUDGET.bytes = Number.POSITIVE_INFINITY
    await expect(step(t, f.user.id)).rejects.toThrow(/Read too much data/)
    expect(await authored()).toBe(15)
    // a budget smaller than one row still clears that row
    REMOVAL_BUDGET.bytes = 1
    await step(t, f.user.id)
    expect(await authored()).toBe(14)
    Object.assign(REMOVAL_BUDGET, DEFAULT_BUDGET)
    const before = await stepsRun(t)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await authored()).toBe(0)
    expect((await stepsRun(t)) - before).toBeGreaterThanOrEqual(3)
    expect(await jobOf(t, f.user.id)).toBeNull()
  }, 60_000)

  it('give the same result when every step runs twice', async () => {
    REMOVAL_BUDGET.rows = 2
    /* The same organization twice, with the same ids, because a
     * deterministic id source replaces uuid() in the fixture. */
    const build = async () => {
      let n = 0
      nextNum = 10_000
      const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
      const t = newT()
      const ids = await t.run(async (ctx) => {
        const org = id()
        await ctx.db.insert('organizations', {
          id: org,
          name: 'Twice',
          slug: 'twice',
          created_at: NOW,
          date_format: 'iso',
          week_start: 1,
          week_one_rule: 'first4day',
          default_plannable_hours: 40,
        })
        const person = (name: string, org_role: 'admin' | 'user') => ({
          id: id(),
          auth_user_id: `login-${name}`,
          org_id: org,
          email: `${name}@twice.test`,
          name,
          initials: name.slice(0, 2).toUpperCase(),
          color: '#7a7ad0',
          org_role,
          active: true,
          kind: 'person' as const,
          accepted_at: NOW,
          created_at: NOW,
        })
        const admin = await ctx.db.insert('profiles', person('admin', 'admin'))
        const doomed = await ctx.db.insert('profiles', person('doomed', 'user'))
        const agentId = await ctx.db.insert('profiles', {
          id: id(),
          org_id: org,
          name: 'Agent',
          initials: 'AG',
          color: '#50b070',
          org_role: 'user',
          active: true,
          kind: 'agent',
          created_at: NOW,
        })
        const project = id()
        await ctx.db.insert('projects', {
          id: project,
          org_id: org,
          type: 'project',
          key: 'TW',
          name: 'Twice',
          description: '',
          sort_order: 1,
          num: 1,
          track_delay: false,
          created_at: NOW,
        })
        return {
          org,
          project,
          admin: (await ctx.db.get(admin))!,
          doomed: (await ctx.db.get(doomed))!,
          agent: (await ctx.db.get(agentId))!,
        }
      })
      const { doomed } = ids
      const history = {
        org_id: ids.org,
        project_id: ids.project,
        other: ids.admin,
        agent: ids.agent,
      }
      await plantHistory(t, { ...history, profile: doomed }, 3, id)
      await remove(t, doomed, NOW)
      return { t, doomed }
    }
    // Everything except system fields and storage ids, which Convex assigns.
    const dump = (t: T) =>
      t.run(async (ctx) => {
        const rows: string[] = []
        for (const table of Object.keys(schema.tables) as TableNames[])
          for (const row of await ctx.db.query(table).collect()) {
            const { _id, _creationTime, ...fields } = row as Record<string, unknown>
            delete fields.storage_id
            rows.push(`${table} ${JSON.stringify(fields)}`)
          }
        return rows.sort()
      })

    const once = await build()
    await once.t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await jobOf(once.t, once.doomed.id)).toBeNull()

    const twice = await build()
    let steps = 0
    while (await jobOf(twice.t, twice.doomed.id)) {
      if (++steps > 100) throw new Error('the removal did not finish')
      await step(twice.t, twice.doomed.id)
      await step(twice.t, twice.doomed.id)
    }
    expect(steps).toBeGreaterThan(5)
    const final = await dump(twice.t)
    expect(final).toEqual(await dump(once.t))
    // and a step after the end changes nothing
    await step(twice.t, twice.doomed.id)
    expect(await dump(twice.t)).toEqual(final)
    expect(await references(twice.t, twice.doomed.id)).toBe(0)
  })

  it('start again from the first phase when the finish check finds a late row', async () => {
    REMOVAL_BUDGET.rows = 2
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const history = { org_id: f.org.id, project_id: f.sub.id, other: f.admin, agent: f.agent }
    await plantHistory(t, { ...history, profile: f.user }, 2)
    await remove(t, f.user)
    while ((await jobOf(t, f.user.id))?.phase !== 'oauth') await step(t, f.user.id)
    // a comment that names the profile after the comments phase has passed
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const late = await t.run(async (ctx) =>
      ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        author: f.user.id,
        body: 'late',
        created_at: NOW,
      }),
    )
    while ((await jobOf(t, f.user.id))?.phase === 'oauth') await step(t, f.user.id)
    expect(warn).toHaveBeenCalledWith('Profile removal starts again', {
      profile_id: f.user.id,
      phase: 'comments',
    })
    expect((await jobOf(t, f.user.id))?.phase).toBe('tasks')
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await t.run((ctx) => ctx.db.get(late)))?.author).toBeUndefined()
    expect(await jobOf(t, f.user.id)).toBeNull()
    await assertNoDanglingRefs(t, 'after a late row')
  })
})

describe('recovery', () => {
  it('resumes a dropped step after a minute and leaves a waiting step alone', async () => {
    REMOVAL_BUDGET.rows = 2
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const history = { org_id: f.org.id, project_id: f.sub.id, other: f.admin, agent: f.agent }
    await plantHistory(t, { ...history, profile: f.user }, 2)
    await remove(t, f.user)
    const dropped = (await jobOf(t, f.user.id))!
    await t.run((ctx) => ctx.scheduler.cancel(dropped.scheduled_id!))
    // a fresh row is not stalled yet
    await t.mutation(internal.profileRemovals.recover, {})
    expect(await jobOf(t, f.user.id)).toEqual(dropped)
    vi.setSystemTime(START + STALLED_MS + 1)
    await t.mutation(internal.profileRemovals.recover, {})
    const resumed = (await jobOf(t, f.user.id))!
    expect(resumed.scheduled_id).not.toBe(dropped.scheduled_id)
    expect(resumed.progress_at).toBe(new Date(START + STALLED_MS + 1).toISOString())
    // its step waits in the queue, so a later sweep must not start a second chain
    vi.setSystemTime(START + 3 * STALLED_MS)
    await t.mutation(internal.profileRemovals.recover, {})
    expect(await jobOf(t, f.user.id)).toEqual(resumed)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await jobOf(t, f.user.id)).toBeNull()
    expect(await references(t, f.user.id)).toBe(0)
    await assertNoDanglingRefs(t, 'after recovery')
  })
})

describe('access ends in the removal transaction', () => {
  it('refuses the session, the personal token, the agent key and the OAuth grant before any step', async () => {
    const t = newT()
    t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // the fixture's real Better Auth login for the user
    const login = { _id: f.user.auth_user_id! }
    const user = f.user
    const tokenHash = 'a1'.repeat(32)
    const keyHash = 'b2'.repeat(32)
    const grantHash = 'c3'.repeat(32)
    const clientId = uuid()
    const connectionId = uuid()
    await t.run(async (ctx) => {
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: user.id,
        name: 'Personal',
        token_prefix: 'qvt_0000000',
        token_hash: tokenHash,
        access: 'write',
        created_at: NOW,
      })
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'Agent key',
        key_prefix: 'qva_0000000',
        key_hash: keyHash,
        created_at: NOW,
      })
      await ctx.db.insert('oauth_connections', {
        id: connectionId,
        authorization_hash: uuid(),
        auth_user_id: login._id,
        profile_id: user.id,
        org_id: f.org.id,
        client_id: clientId,
        client_name: 'Removal test',
        resource: mcpResource(),
        requested_scopes: ['qivo:read'],
        scopes: ['qivo:read'],
        created_at: NOW,
        approved_at: NOW,
        authorization_expires_at: new Date(Date.now() + 60_000).toISOString(),
      })
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthClient',
        data: {
          clientId,
          redirectUris: ['https://client.example/callback'],
          scopes: ['qivo:read'],
        },
      },
    })
    await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: 'oauthAccessToken',
        data: {
          token: grantHash,
          clientId,
          userId: login._id,
          referenceId: connectionId,
          scopes: ['qivo:read'],
          expiresAt: Date.now() + 60_000,
        },
      },
    })
    const session = t.withIdentity({ subject: login._id })
    const probe = async () => ({
      comments: await session
        .query(api.snapshot.commentsForIssue, { org_id: f.org.id, issue_id: task.id })
        .then(
          () => 'ok',
          (e: { data?: { message?: string } }) => e.data?.message,
        ),
      token: await t.query(internal.machine.auth.lookupCredential, {
        hash: tokenHash,
        isAgent: false,
        now: new Date().toISOString(),
      }),
      key: await t.query(internal.machine.auth.lookupCredential, {
        hash: keyHash,
        isAgent: true,
        now: new Date().toISOString(),
      }),
      grant: await t.query(internal.oauthConnections.lookupAccess, {
        tokenHash: grantHash,
        resource: mcpResource(),
      }),
      connections: (await session.query(api.oauthConnections.list, {})).length,
      roster: ((await as(t, f.admin).query(api.snapshot.forMe, {}))?.profiles ?? []).map(
        (p) => p.id,
      ),
    })

    // control case, everything works while both profiles exist
    const before = await probe()
    expect(before).toMatchObject({
      comments: 'ok',
      token: { ok: true },
      key: { ok: true },
      grant: { connectionId },
      connections: 1,
    })
    expect(before.roster).toEqual(expect.arrayContaining([user.id, f.agent.id]))

    for (const profile of [user, f.agent])
      await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: profile.id })
    expect(await stepsRun(t)).toBe(0)
    expect(await jobOf(t, user.id)).not.toBeNull()
    expect(await jobOf(t, f.agent.id)).not.toBeNull()

    const after = await probe()
    expect(after).toMatchObject({
      comments: 'no profile in this organization',
      token: { ok: false, why: 'unknown' },
      key: { ok: false, why: 'unknown' },
      grant: null,
      connections: 0,
    })
    expect(after.roster).not.toContain(user.id)
    expect(after.roster).not.toContain(f.agent.id)
    // the revoked connection still waits for its background step
    expect(
      (await t.run((ctx) => ctx.db.query('oauth_connections').collect())).map((c) => c.id),
    ).toEqual([connectionId])
  })
})

describe('the reserved id and its end states', () => {
  it('profiles.create refuses an id with a pending removal until the cleanup ends', async () => {
    const t = newT()
    const f = await withOrg(t)
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.viewer.id })
    const create = (id: string, email: string) =>
      as(t, f.admin).mutation(api.profiles.create, {
        org_id: f.org.id,
        id,
        name: 'Newcomer',
        email,
        org_role: 'user',
        kind: 'person',
        color: '#7a7ad0',
      })
    await expectRefusal(
      create(f.viewer.id, 'reuse@testbed.test'),
      'bad_request',
      /^a profile with this id already exists$/,
    )
    await create(uuid(), 'fresh@testbed.test')
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await jobOf(t, f.viewer.id)).toBeNull()
    await create(f.viewer.id, 'reuse@testbed.test')
  })

  it('ends the job when a re-seed created a live profile with the id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = newT()
    const f = await withOrg(t)
    const history = { org_id: f.org.id, project_id: f.sub.id, other: f.admin, agent: f.agent }
    await plantHistory(t, { ...history, profile: f.user }, 1)
    await remove(t, f.user)
    const { _id, _creationTime, ...seat } = f.user
    await t.run((ctx) => ctx.db.insert('profiles', seat))
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(error).toHaveBeenCalledWith(
      'Profile removal stopped because a live profile has its id',
      {
        profile_id: f.user.id,
        phase: 'tasks',
      },
    )
    expect(await jobOf(t, f.user.id)).toBeNull()
    // nothing else ran, so the rows now name the live profile
    expect(await references(t, f.user.id)).toBe(4 + 2 + 5 + 2)
    expect(await stepsRun(t)).toBe(1)
  })

  it('a cancelled invitation can be sent again and claimed at sign-in', async () => {
    const t = newT()
    const f = await withOrg(t)
    const email = 'anna@testbed.test'
    const invite = await plantSeat(t, { org_id: f.org.id, email })
    await t.run((ctx) =>
      ctx.db.insert('platform_admins', { auth_user_id: 'operator', note: 'test', created_at: NOW }),
    )
    await t
      .withIdentity({ subject: 'operator' })
      .mutation(api.adminOrgs.cancelInvite, { profile_id: invite.id })
    const again = uuid()
    await as(t, f.admin).mutation(api.profiles.create, {
      org_id: f.org.id,
      id: again,
      name: 'Anna',
      email,
      org_role: 'user',
      kind: 'person',
      color: '#7a7ad0',
    })
    expect(
      await t.mutation(internal.identity.claimSeatsInternal, {
        userId: 'login-anna',
        email,
        emailVerified: true,
      }),
    ).toBe(1)
    const seat = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_uuid', (q) => q.eq('id', again))
        .unique(),
    )
    expect(seat).toMatchObject({ auth_user_id: 'login-anna', email })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await jobOf(t, invite.id)).toBeNull()
    await assertNoDanglingRefs(t, 'after cancel and re-invite')
  })

  it('finishes after deleteOrgDeep removed the organization', async () => {
    const t = newT()
    const f = await withOrg(t)
    const history = { org_id: f.org.id, project_id: f.sub.id, other: f.admin, agent: f.agent }
    await plantHistory(t, { ...history, profile: f.user }, 2)
    await remove(t, f.user)
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(f.org._id))!
      await deleteOrgDeep(ctx, org)
    })
    // the removed profile's inbox and connections are still the job's
    await expect(assertNoDanglingRefs(t, 'before the steps')).rejects.toThrow(
      /messages\.recipient_id → profiles dangles/,
    )
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await jobOf(t, f.user.id)).toBeNull()
    expect(await references(t, f.user.id)).toBe(0)
    await assertNoDanglingRefs(t, 'after deleteOrgDeep and the steps')
  })

  it('a task restored before its step keeps the stale id until the step clears it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const archived = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      status: 'done',
      done_at: NOW,
      archived_at: NOW,
      assignee_id: f.user.id,
    })
    await as(t, f.admin).mutation(api.profiles.remove, { org_id: f.org.id, id: f.user.id })
    vi.setSystemTime(START + 1000)
    await as(t, f.admin).mutation(api.issues.unarchive, { org_id: f.org.id, id: archived.id })
    const shown = async () =>
      (await as(t, f.admin).query(api.snapshot.forMe, {}))?.issues.find((i) => i.id === archived.id)
    // back on the Board under an id the roster no longer has
    expect(await shown()).toMatchObject({ assignee_id: f.user.id })
    const later = START + 2000
    vi.setSystemTime(later)
    // Only the due steps run.
    await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(0))
    const cleared = await shown()
    expect(cleared?.assignee_id).toBeUndefined()
    expect(cleared?.updated_at).toBe(new Date(later).toISOString())
  })
})

describe('bounds a long credential and file history', () => {
  it('revokes at most REVOKE_AT_ONCE connections at once and deletes every one in the steps', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let i = 0; i < REVOKE_AT_ONCE + 44; i++) {
        await ctx.db.insert('oauth_connections', {
          id: uuid(),
          authorization_hash: uuid(),
          auth_user_id: f.user.auth_user_id ?? 'login',
          profile_id: f.user.id,
          org_id: f.org.id,
          client_id: 'client',
          client_name: 'Client',
          resource: 'https://some.convex.site/mcp',
          requested_scopes: ['qivo:read'],
          scopes: ['qivo:read'],
          created_at: NOW,
          authorization_expires_at: NOW,
          approved_at: NOW,
        })
      }
    })
    await remove(t, f.user)
    const left = await t.run((ctx) => ctx.db.query('oauth_connections').collect())
    expect(left.filter((c) => c.revocation_reason === 'deleted')).toHaveLength(REVOKE_AT_ONCE)

    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(await t.run((ctx) => ctx.db.query('oauth_connections').collect())).toHaveLength(0)
    expect(await jobOf(t, f.user.id)).toBeNull()
  })

  it('clears attachments with very large names in small reads under real limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    // 25 names of 800 KiB pass the 16 MiB read limit if read in one go
    const name = 'n'.repeat(800 * 1024)
    for (let chunk = 0; chunk < 5; chunk++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 5; i++) {
          await ctx.db.insert('issue_attachments', {
            org_id: f.org.id,
            id: uuid(),
            issue_id: task.id,
            name,
            size_bytes: 4,
            storage_id: await ctx.storage.store(new Blob(['file']) as never),
            inline: false,
            uploaded_by: f.user.id,
            created_at: NOW,
          })
        }
      })
    }
    await remove(t, f.user)
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await jobOf(t, f.user.id)).toBeNull()
    // reading the files back whole would pass the limit too, so ask the index
    const still = await t.run((ctx) =>
      ctx.db
        .query('issue_attachments')
        .withIndex('by_uploaded_by', (q) => q.eq('uploaded_by', f.user.id))
        .first(),
    )
    expect(still).toBeNull()
  })

  it('restarts a failed removal that waits behind more than a batch of waiting ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = newT()
    const iso = (ms: number) => new Date(ms).toISOString()
    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        const profile_id = `waiting-${i}`
        const scheduled_id = await ctx.scheduler.runAfter(
          100 * STALLED_MS,
          internal.profileRemovals.step,
          { profile_id },
        )
        await ctx.db.insert('profile_removals', {
          profile_id,
          removed_at: iso(START),
          phase: 'tasks',
          progress_at: iso(START + i),
          scheduled_id,
        })
      }
      await ctx.db.insert('profile_removals', {
        profile_id: 'failed',
        removed_at: iso(START),
        phase: 'tasks',
        progress_at: iso(START + 100),
      })
    })
    vi.setSystemTime(START + STALLED_MS + 1000)
    await t.mutation(internal.profileRemovals.recover, {})

    expect((await jobOf(t, 'failed'))?.scheduled_id).toBeDefined()
    // the waiting rows keep their step and their place
    expect((await jobOf(t, 'waiting-0'))?.progress_at).toBe(iso(START))
  })
})
