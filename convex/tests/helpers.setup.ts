/* convex-test fixture builders + refusal assertion.
 *
 * Named helpers.setup.ts, NOT helpers.ts: the Convex CLI deploys every
 * single-dot .ts file under convex/ as an entry point, and this module
 * imports convex-test (node:async_hooks — impossible in the isolate). Two
 * dots in the basename is the CLI's skip rule, the same one that keeps the
 * *.test.ts files out of the deploy.
 *
 * withOrg builds via raw ctx.db.insert — setup legitimately bypasses the
 * mutation guards, the same trust position as internal mutations. */
/// <reference types="vite/client" />

import { makeFunctionReference, type WithoutSystemFields } from 'convex/server'
import { ConvexError } from 'convex/values'
import { convexTest, type TestConvex } from 'convex-test'
import type { Doc } from '../_generated/dataModel'
import type { OrgRole } from '../lib/enums'
import type { Refusal, RefusalCode } from '../lib/functions'
import schema from '../schema'

export type T = TestConvex<typeof schema>

/* The glob is passed explicitly (per convex-test docs) so the module map is
 * rooted here rather than guessed from node_modules' location. It must reach
 * _generated for convex-test to find the functions root. */
export const newT = (options: { transactionLimits?: boolean } = {}): T =>
  convexTest({
    schema,
    modules: import.meta.glob('../**/*.*s'),
    ...options,
  })

/** Complete bounded outbox expansion without executing network delivery actions. */
export async function flushWebhookEvents(t: T): Promise<void> {
  const expand = makeFunctionReference<'mutation', Record<string, never>, null>(
    'webhookQueue:expand',
  )
  const run = makeFunctionReference<
    'mutation',
    { kind: 'expand' | 'dispatch'; generation: string },
    null
  >('webhookQueue:run')
  const readWorker = () =>
    t.run((ctx) =>
      ctx.db
        .query('webhook_workers')
        .withIndex('by_kind', (q) => q.eq('kind', 'expand'))
        .unique(),
    )
  while (await t.run((ctx) => ctx.db.query('webhook_events').first())) {
    let worker = await readWorker()
    if (!worker) {
      await t.mutation(expand, {})
      worker = await readWorker()
    }
    if (!worker) throw new Error('Expansion did not reserve its worker')
    await t.mutation(run, { kind: 'expand', generation: worker.generation })
  }
}

export const NOW = '2026-01-01T00:00:00.000Z'

/* Web Crypto exists in the edge-runtime VM (and the Convex isolate), but
 * convex/tsconfig's lib is ESNext only, which does not declare the global. */
declare const crypto: { randomUUID(): string }

export const uuid = () => crypto.randomUUID()

/* Mini-Testbed:
 * - team "Hardware" — user leads it, admin is a plain member (sharing group;
 *   no project belongs to it)
 * - profiles: admin, user, viewer, guest (persons), agent (kind 'agent',
 *   org_role 'user', no login, no email)
 * - projects: teamless meta led by `user` with sub + sub2 under it, and hidden — a
 *   second teamless meta, also led by `user`, that guest/viewer hold no
 *   grant on (the control every containment test reads against)
 * - grants: guest→meta 'user', viewer→meta 'user' (the ceiling test's input)
 * - a second org ("other") with one admin + one project for cross-org fences */
export async function withOrg(t: T) {
  return await t.run(async (ctx) => {
    const orgId = uuid()
    const load = async <Table extends 'organizations' | 'teams' | 'profiles' | 'projects'>(
      table: Table,
      doc: WithoutSystemFields<Doc<Table>>,
    ): Promise<Doc<Table>> => {
      const _id = await ctx.db.insert(table, doc)
      const loaded = await ctx.db.get(_id)
      if (loaded === null) throw new Error(`fixture insert into ${table} vanished`)
      return loaded as Doc<Table>
    }

    const org = await load('organizations', {
      id: orgId,
      name: 'Testbed Labs',
      slug: 'testbed',
      created_at: NOW,
      next_issue_num: 1,
      next_project_num: 5,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
      gravatar_avatars: false,
      max_attachment_mb: 10,
      billing: { plan: 'team', seats: 5, renewal_date: null },
    })

    const team = await load('teams', {
      id: uuid(),
      org_id: orgId,
      name: 'Hardware',
      stale_days: 14,
      archive_days: 30,
      track_delay_default: false,
      created_at: NOW,
    })

    const person = (name: string, initials: string, org_role: OrgRole, org = orgId) => ({
      id: uuid(),
      auth_user_id: `auth_${name}_${org}`,
      org_id: org,
      email: `${name}@testbed.test`,
      name,
      initials,
      color: '#7a7ad0',
      org_role,
      active: true,
      kind: 'person' as const,
      plannable_hours: 40,
      accepted_at: NOW,
      created_at: NOW,
    })

    const admin = await load('profiles', person('admin', 'AD', 'admin'))
    const user = await load('profiles', person('user', 'US', 'user'))
    const viewer = await load('profiles', person('viewer', 'VW', 'viewer'))
    const guest = await load('profiles', person('guest', 'GU', 'guest'))
    const agent = await load('profiles', {
      id: uuid(),
      org_id: orgId,
      name: 'Relay',
      initials: 'RY',
      color: '#50b070',
      org_role: 'user',
      active: true,
      kind: 'agent',
      created_at: NOW,
    })

    await ctx.db.insert('team_members', { team_id: team.id, profile_id: user.id, is_leader: true })
    await ctx.db.insert('team_members', {
      team_id: team.id,
      profile_id: admin.id,
      is_leader: false,
    })

    const project = (
      num: number,
      key: string,
      name: string,
      extra: Partial<WithoutSystemFields<Doc<'projects'>>> = {},
    ) => ({
      id: uuid(),
      org_id: orgId,
      type: 'meta' as const,
      key,
      name,
      description: '',
      sort_order: num,
      num,
      track_delay: false,
      created_at: NOW,
      ...extra,
    })

    const meta = await load(
      'projects',
      project(1, 'TBED', 'Testbed platform', { lead_id: user.id }),
    )
    const sub = await load(
      'projects',
      project(2, 'FW', 'Firmware', { type: 'project', parent_id: meta.id }),
    )
    const sub2 = await load(
      'projects',
      project(3, 'PCB', 'Board rev', { type: 'project', parent_id: meta.id }),
    )
    const hidden = await load('projects', project(4, 'SKNK', 'Skunkworks', { lead_id: user.id }))

    await ctx.db.insert('project_access', {
      project_id: meta.id,
      profile_id: guest.id,
      level: 'user',
    })
    await ctx.db.insert('project_access', {
      project_id: meta.id,
      profile_id: viewer.id,
      level: 'user',
    })

    const otherOrg = await load('organizations', {
      id: uuid(),
      name: 'Other',
      slug: 'other',
      created_at: NOW,
      next_issue_num: 1,
      next_project_num: 2,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
      gravatar_avatars: false,
    })
    const otherAdmin = await load('profiles', person('otherAdmin', 'OA', 'admin', otherOrg.id))
    const otherProject = await load(
      'projects',
      project(1, 'OTH', 'Elsewhere', { org_id: otherOrg.id }),
    )

    return {
      org,
      team,
      admin,
      user,
      viewer,
      guest,
      agent,
      meta,
      sub,
      sub2,
      hidden,
      otherOrg,
      otherAdmin,
      otherProject,
    }
  })
}

export type OrgFixture = Awaited<ReturnType<typeof withOrg>>

/* An invitation-shaped seat row — unclaimed unless auth_user_id is given.
 * The identity suite plants these beside withOrg; created_at drives the claim
 * loop's order, so callers planting several pass distinct instants. */
export async function plantSeat(
  t: T,
  seat: { org_id: string } & Partial<WithoutSystemFields<Doc<'profiles'>>>,
): Promise<Doc<'profiles'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('profiles', {
      id: uuid(),
      name: 'Seat',
      initials: 'ST',
      color: '#7a7ad0',
      org_role: 'user',
      active: true,
      kind: 'person',
      plannable_hours: 40,
      created_at: NOW,
      ...seat,
    })
    return (await ctx.db.get(_id)) as Doc<'profiles'>
  })
}

/* Distinct nums/keys for planted projects and issues — the read-path suites
 * never assert on them, they only need to not collide. */
let plantedNum = 100

/* A project row beside the withOrg fixture — defaults to a meta; pass
 * type/parent_id for a sub. Same trust position as withOrg (raw insert). */
export async function plantProject(
  t: T,
  proj: { org_id: string } & Partial<WithoutSystemFields<Doc<'projects'>>>,
): Promise<Doc<'projects'>> {
  return await t.run(async (ctx) => {
    const num = plantedNum++
    const _id = await ctx.db.insert('projects', {
      id: uuid(),
      type: 'meta',
      key: `P${num}`,
      name: `Planted ${num}`,
      description: '',
      sort_order: num,
      num,
      track_delay: false,
      created_at: NOW,
      ...proj,
    })
    return (await ctx.db.get(_id)) as Doc<'projects'>
  })
}

/* An issue row — unscheduled backlog-shaped unless overridden. */
export async function plantIssue(
  t: T,
  issue: { org_id: string; project_id: string } & Partial<WithoutSystemFields<Doc<'issues'>>>,
): Promise<Doc<'issues'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('issues', {
      id: uuid(),
      num: plantedNum++,
      title: 'Planted task',
      description: '',
      status: 'todo',
      priority: 'medium',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      ...issue,
    })
    return (await ctx.db.get(_id)) as Doc<'issues'>
  })
}

/* ---- phase-4 message/activity fixtures + readers (issues/messages suites) --
 * Raw inserts hold the same trust position as plantIssue; the readers are
 * plain t.run collects. Non-breaking additions only. */

/* A subscription row planted raw — deliberately BYPASSES subscribeToIssue's
 * visibility fence, so the postMessage-side fence can be tested against a
 * recipient the public subscribe would have refused. */
export async function plantSubscription(
  t: T,
  s: { issue_id: string; profile_id: string },
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert('issue_subscriptions', { ...s, created_at: NOW })
  })
}

/* A message row with a controlled instant/id — the prune suites choose their
 * own survivors. */
export async function plantMessage(
  t: T,
  m: { org_id: string; recipient_id: string; issue_id: string } & Partial<
    WithoutSystemFields<Doc<'messages'>>
  >,
): Promise<Doc<'messages'>> {
  return await t.run(async (ctx) => {
    const _id = await ctx.db.insert('messages', {
      id: uuid(),
      issue_title: 'Planted task',
      kind: 'change',
      detail: 'planted',
      created_at: NOW,
      ...m,
    })
    return (await ctx.db.get(_id)) as Doc<'messages'>
  })
}

/* Everything a recipient holds (optionally narrowed to one issue), in insert
 * order. */
export async function messagesFor(
  t: T,
  recipientId: string,
  issueId?: string,
): Promise<Doc<'messages'>[]> {
  return await t.run(async (ctx) => {
    const rows =
      issueId === undefined
        ? await ctx.db
            .query('messages')
            .withIndex('by_recipient', (q) => q.eq('recipient_id', recipientId))
            .collect()
        : await ctx.db
            .query('messages')
            .withIndex('by_recipient_issue', (q) =>
              q.eq('recipient_id', recipientId).eq('issue_id', issueId),
            )
            .collect()
    return rows.sort((a, b) => a._creationTime - b._creationTime)
  })
}

export const allMessages = (t: T): Promise<Doc<'messages'>[]> =>
  t.run(async (ctx) => await ctx.db.query('messages').collect())

export async function drainMessages(t: T): Promise<void> {
  await t.run(async (ctx) => {
    for (const m of await ctx.db.query('messages').collect()) await ctx.db.delete(m._id)
  })
}

export const activityFor = (t: T, orgId: string): Promise<Doc<'activity_events'>[]> =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('activity_events')
      .withIndex('by_org_ts', (q) => q.eq('org_id', orgId))
      .collect()
    return rows.sort((a, b) => a._creationTime - b._creationTime)
  })

export async function drainActivity(t: T): Promise<void> {
  await t.run(async (ctx) => {
    for (const e of await ctx.db.query('activity_events').collect()) await ctx.db.delete(e._id)
    for (const org of await ctx.db.query('organizations').collect()) {
      await ctx.db.patch(org._id, { activity_count: undefined })
    }
  })
}

/* Mutations stamp their own real-clock `now`; a short sleep guarantees the
 * next one lands at a strictly later ISO millisecond (the prune survivor and
 * created_at-ordering assertions depend on distinct instants). setTimeout is
 * declared by hand like crypto above: it exists in the edge-runtime VM, but
 * convex/tsconfig's ESNext-only lib does not know the global. */
declare function setTimeout(cb: () => void, ms: number): unknown
export const tick = (): Promise<void> => new Promise((r) => setTimeout(() => r(), 5))

/* Person callers only: agents/unclaimed seats have no login to impersonate —
 * their surface is the machine transport, tested via internal functions. */
export function as(t: T, profile: Doc<'profiles'>) {
  if (profile.auth_user_id === undefined) {
    throw new Error(`as(): profile '${profile.name}' has no auth_user_id`)
  }
  return t.withIdentity({ subject: profile.auth_user_id })
}

/* The successor to the drives' refused/noRows/blocked/why: a negative
 * assertion passes only on a THROWN typed refusal — a dead backend or a
 * silent empty result can never satisfy it. */
export async function expectRefusal(
  promise: Promise<unknown>,
  code: RefusalCode,
  msgRe?: RegExp,
): Promise<ConvexError<Refusal>> {
  let caught: unknown
  let value: unknown
  let resolved = false
  try {
    value = await promise
    resolved = true
  } catch (e) {
    caught = e
  }
  if (resolved) {
    throw new Error(
      `expected a '${code}' refusal, but the call resolved with ${JSON.stringify(value)}`,
    )
  }
  if (!(caught instanceof ConvexError)) {
    throw new Error(`expected a ConvexError, got: ${String(caught)}`)
  }
  const data = caught.data as Refusal
  if (data.code !== code) {
    throw new Error(`expected refusal code '${code}', got '${data.code}' ("${data.message}")`)
  }
  if (msgRe !== undefined && !msgRe.test(data.message)) {
    throw new Error(`refusal message "${data.message}" does not match ${String(msgRe)}`)
  }
  return caught as ConvexError<Refusal>
}
