/* Private, deployment-key-only nonproduction fixture. It uses random
 * credentials and can only rebuild the
 * organization recorded in its own ownership receipt. Passwords are hashed by
 * the local CLI with Better Auth's own hashPassword; neither plaintext
 * passwords nor a public reset function reach deployment. Normal deployment
 * never runs this fixture. Seed, reset and wipe are explicit operator commands. */
import { getDocumentSize, v } from 'convex/values'
import { components, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { refuseProduction } from '../lib/deployment'
import type { StoredTable } from '../lib/enums'
import { badRequest, conflict, require, rule } from '../lib/functions'
import { DEFAULT_MESSAGE_RETENTION_DAYS, LIMITS, MIB } from '../lib/limits'
import { monthOf } from '../lib/usage'
import { pendingRemoval } from '../model/cascade'
import {
  layoutHash,
  NORTHSTAR_COMMENTS,
  NORTHSTAR_STEPS,
  type NorthstarStep,
  SAMPLE_AVATARS,
  type SampleAvatar,
  writeNorthstarStep,
} from '../model/demoSeed'
import { wipeWorkStep } from '../model/orgDeletion'
import { assertSlugAvailable, insertOrgRows, newOrgDefaults, setCounters } from '../model/orgs'
import {
  assertMarketingAnchor,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingId,
} from './marketingDemoData'

const KEY = 'northstar-labs'
const expectedSite = { expected_site_url: v.string() }
const id = (key: string) => marketingId(KEY, key)
const email = (key: string) => `${key}@demo.qivo.io`

function site(expected: string): string {
  refuseProduction('marketing demo')
  const actual = process.env.SITE_URL
  require(Boolean(actual), rule('marketing demo: SITE_URL is unset'))
  require(actual === expected, rule(
    'marketing demo: deployment SITE_URL does not match the requested target',
  ))
  return expected
}

const isSampleAvatar = (key: string): key is SampleAvatar =>
  (SAMPLE_AVATARS as readonly string[]).includes(key)

/* The refusal while the demo organization has Deleted items. */
const TRASH_LEFT = 'marketing demo: Deleted items must be empty; run the same command again'

/** Whether organization `orgId` keeps anything in Deleted items: an item,
 * or the stored rows a purge that stopped halfway left. */
async function holdsTrash(ctx: QueryCtx, orgId: string): Promise<boolean> {
  const item = await ctx.db
    .query('deleted_items')
    .withIndex('by_org_deleted', (q) => q.eq('org_id', orgId))
    .first()
  const task = await ctx.db
    .query('deleted_tasks')
    .withIndex('by_org_num', (q) => q.eq('org_id', orgId))
    .first()
  const row = await ctx.db
    .query('deleted_rows')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .first()
  return item !== null || task !== null || row !== null
}

async function receipt(ctx: QueryCtx) {
  return await ctx.db
    .query('marketing_demo')
    .withIndex('by_key', (q) => q.eq('key', KEY))
    .unique()
}

async function owned(ctx: QueryCtx) {
  const record = await receipt(ctx)
  require(record !== null, rule('marketing demo: provision the demo before changing it'))
  require(record.org_id === (await id('org')), rule('marketing demo: invalid ownership receipt'))
  const org = await byId(ctx, 'organizations', record.org_id)
  require(org !== null && org.slug === KEY, rule(
    'marketing demo: owned organization missing or its address changed',
  ))
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  require(profiles.length === MARKETING_DEMO.people.length, rule(
    'marketing demo: roster changed; restore the demo roster before resetting',
  ))
  for (const person of MARKETING_DEMO.people) {
    const personId = await id(`person:${person.key}`)
    const profile = profiles.find((p) => p.id === personId)
    require(profile !== undefined && profile.kind === person.kind, rule(
      'marketing demo: owned profile missing or changed',
    ))
    if (person.kind === 'person') {
      require(profile.email === email(person.key) &&
        profile.auth_user_id === record.auth_ids[person.key], rule(
        'marketing demo: login ownership changed',
      ))
    }
  }
  return { record, org, profiles }
}

/** What inspect answers about the owned demo. */
type DemoState = Awaited<ReturnType<typeof inspectCore>>

/** The most tasks an inspection counts, and the bytes it reads for them. A
 * copy grown by manual or contract-test work can hold more than one query
 * may read, and the CLI inspects before it wipes, so past either bound the
 * count stops and says so (`tasks_partial`). Tests lower them. */
export const INSPECT_READ = { tasks: 5000, bytes: 6 * 1024 * 1024 }

/* The organization's tasks counted within INSPECT_READ, and whether more
 * remain. */
async function countTasks(ctx: QueryCtx, orgId: string) {
  let tasks = 0
  let bytes = 0
  const issues = ctx.db.query('issues').withIndex('by_org', (q) => q.eq('org_id', orgId))
  for await (const task of issues) {
    if (tasks >= INSPECT_READ.tasks || bytes >= INSPECT_READ.bytes) return { tasks, partial: true }
    tasks++
    bytes += getDocumentSize(task)
  }
  return { tasks, partial: false }
}

async function inspectCore(ctx: QueryCtx, expected: string) {
  site(expected)
  const record = await receipt(ctx)
  if (record === null) {
    const existing = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', KEY))
      .first()
    require(existing === null &&
      (await byId(ctx, 'organizations', await id('org'))) === null, conflict(
      'marketing demo: an unowned organization occupies the demo address or id',
      'demo_collision',
    ))
    return {
      site_url: expected,
      version: MARKETING_DEMO_VERSION,
      org_id: await id('org'),
      slug: KEY,
      state: 'absent' as const,
      people: MARKETING_DEMO.people.map((p) => ({
        key: p.key,
        name: p.name,
        kind: p.kind,
        ...(p.kind === 'person' ? { email: email(p.key) } : {}),
      })),
      counts: { projects: 0, subprojects: 0, tasks: 0, users: 0, avatars: 0 },
    }
  }
  const { org, profiles } = await owned(ctx)
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const tasks = await countTasks(ctx, org.id)
  return {
    site_url: expected,
    version: record.version,
    org_id: org.id,
    slug: org.slug,
    state: record.state,
    credential_set_id: record.credential_set_id,
    anchor: record.anchor,
    people: await Promise.all(
      MARKETING_DEMO.people.map(async (p) => {
        const personId = await id(`person:${p.key}`)
        const profile = profiles.find((pr) => pr.id === personId)
        return {
          key: p.key,
          name: p.name,
          kind: p.kind,
          ...(p.kind === 'person' ? { email: email(p.key) } : {}),
          avatar_storage_id: profile?.avatar_storage_id,
        }
      }),
    ),
    counts: {
      projects: projects.filter((p) => p.type === 'meta').length,
      subprojects: projects.filter((p) => p.type === 'project').length,
      tasks: tasks.tasks,
      ...(tasks.partial ? { tasks_partial: true as const } : {}),
      users: profiles.length,
      avatars: profiles.filter((p) => p.avatar_storage_id !== undefined).length,
    },
  }
}

export const inspect = internalQuery({
  args: expectedSite,
  handler: async (ctx, args) => await inspectCore(ctx, args.expected_site_url),
})

export const provision = internalMutation({
  args: {
    ...expectedSite,
    credential_set_id: v.string(),
    password_hashes: v.record(v.string(), v.string()),
    // previews have no portraits to upload: mark the bundled samples instead
    sample_avatars: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const before = await inspectCore(ctx, args.expected_site_url)
    require(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(
      args.credential_set_id,
    ), badRequest('marketing demo: invalid credential set id'))
    if (before.state !== 'absent') {
      require(before.credential_set_id === args.credential_set_id, conflict(
        'marketing demo: credential set belongs to a different provisioning run',
        'demo_credentials_mismatch',
      ))
      return before
    }
    const orgId = await id('org')
    await assertSlugAvailable(ctx, KEY)
    const humans = MARKETING_DEMO.people.filter((p) => p.kind === 'person')
    for (const person of MARKETING_DEMO.people) {
      const profileId = await id(`person:${person.key}`)
      // a removed profile keeps its id until its background cleanup ends
      require((await byId(ctx, 'profiles', profileId)) === null &&
        (await pendingRemoval(ctx, profileId)) === null, conflict(
        'marketing demo: a reserved profile id is already in use',
        'demo_id_collision',
      ))
    }
    require(Object.keys(args.password_hashes).length === humans.length, badRequest(
      'marketing demo: supply exactly seven password hashes',
    ))
    for (const p of humans) {
      // Better Auth's current scrypt encoding (salt:derived key). The CLI
      // imports the pinned library, avoiding a home-grown password format.
      require(/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(args.password_hashes[p.key] ?? ''), badRequest(
        'marketing demo: invalid password hash',
      ))
      const user = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: 'email', value: email(p.key) }],
      })
      const profile = await ctx.db
        .query('profiles')
        .withIndex('by_email', (q) => q.eq('email', email(p.key)))
        .first()
      require(user === null && profile === null, conflict(
        'marketing demo: a demo email already belongs to an unowned account',
        'demo_email_collision',
      ))
    }
    const now = new Date().toISOString()
    const authIds: Record<string, string> = {}
    // Component calls made inside a mutation share its transaction: a crash
    // cannot leave half-created logins that a later run would have to adopt.
    for (const p of humans) {
      const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'user',
          data: {
            name: p.name,
            email: email(p.key),
            emailVerified: true,
            role: 'user',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      })) as { _id: string }
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'account',
          data: {
            accountId: user._id,
            providerId: 'credential',
            userId: user._id,
            password: args.password_hashes[p.key],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
        },
      })
      authIds[p.key] = user._id
    }
    await insertOrgRows(ctx, {
      id: orgId,
      name: MARKETING_DEMO.organization.name,
      slug: KEY,
      ...newOrgDefaults(now),
    })
    for (const p of MARKETING_DEMO.people) {
      await ctx.db.insert('profiles', {
        id: await id(`person:${p.key}`),
        org_id: orgId,
        name: p.name,
        initials: p.initials,
        color: p.color,
        org_role: p.role,
        kind: p.kind,
        active: true,
        created_at: now,
        ...(args.sample_avatars === true && isSampleAvatar(p.key) ? { sample_avatar: p.key } : {}),
        ...(p.kind === 'person'
          ? {
              email: email(p.key),
              auth_user_id: authIds[p.key],
              accepted_at: now,
              plannable_hours: newOrgDefaults(now).default_plannable_hours,
              message_retention_days: DEFAULT_MESSAGE_RETENTION_DAYS,
            }
          : {}),
      })
    }
    await ctx.db.insert('marketing_demo', {
      key: KEY,
      org_id: orgId,
      auth_ids: authIds,
      credential_set_id: args.credential_set_id,
      state: 'empty',
      version: MARKETING_DEMO_VERSION,
      created_at: now,
      updated_at: now,
    })
    return await inspectCore(ctx, args.expected_site_url)
  },
})

/* Clears one bounded batch of WORK (model/orgDeletion.ts wipeWorkStep),
 * deliberately preserving login/profile UUIDs and portraits. Manual demo
 * tasks, files, comments, inbox entries and view preferences are removed
 * too. Once nothing is left it rewinds the counters, and it returns whether
 * it got there. A Northstar copy grown by manual or contract-test work takes
 * several calls, so apply's wipe says whether to call it again. */
async function clearWork(
  ctx: MutationCtx,
  org: Doc<'organizations'>,
  profiles: Doc<'profiles'>[],
): Promise<boolean> {
  const done = await wipeWorkStep(
    ctx,
    org.id,
    profiles.map((p) => p.id),
    WIPE_BUDGET,
  )
  if (done) {
    await setCounters(ctx, org, { next_issue_num: 0, next_project_num: 0 })
  }
  return done
}

/* Every uuid the seed writes that another organization could hold, in the
 * order the check reads them. */
const RESERVED = [
  ...MARKETING_DEMO.projects.map((p) => ({ kind: 'project' as const, key: `project:${p.key}` })),
  ...MARKETING_DEMO.issues.map((i) => ({ kind: 'issue' as const, key: `issue:${i.key}` })),
  ...MARKETING_DEMO.labels.map((l) => ({ kind: 'label' as const, key: `label:${l.key}` })),
  ...MARKETING_DEMO.teams.map((t) => ({ kind: 'team' as const, key: `team:${t.key}` })),
  ...MARKETING_DEMO.comments.map((c) => ({ kind: 'comment' as const, key: `comment:${c.key}` })),
  ...MARKETING_DEMO.milestones.map((m) => ({
    kind: 'milestone' as const,
    key: `milestone:${m.key}`,
  })),
  ...MARKETING_DEMO.links.map((l) => ({
    kind: 'link' as const,
    key: `link:${l.source}:${l.target}`,
  })),
  ...MARKETING_DEMO.issues.map((i) => ({
    kind: 'activity' as const,
    key: `activity:import:${i.key}`,
  })),
  ...MARKETING_DEMO.history.map((c) => ({
    kind: 'activity' as const,
    key: `activity:change:${c.key}`,
  })),
]

/** The uuids one part of the reserved-id check reads. Each reads at most
 * three index ranges, so a part reads at most 240: the whole check, about
 * 920 ranges, took up to 2 s in one call on a loaded machine. */
export const RESERVED_PART = 80

/** How many parts the reserved-id check has (checkReserved). */
export const RESERVED_PARTS = Math.ceil(RESERVED.length / RESERVED_PART)

/* The refusal of a seed step when the demo's work changed since the seed
 * began: work added before its setup, a row it writes already there, or
 * anything moved to Deleted items. */
const CHANGED_DURING_SEED = 'marketing demo: work changed during the seed; use reset to replace it'

/* Refuses when a uuid of `items` belongs to another organization, live or
 * in its Deleted items. All app UUIDs are globally unique, so the seed must
 * fail on a matching key in another tenant before it writes anything, and a
 * reset before its wipe deletes anything (checkReserved). A uuid the demo
 * holds itself passes, unless `absent`: a work step, which writes these very
 * rows into a demo its setup proved empty, refuses one the demo already
 * holds (CHANGED_DURING_SEED), since writing it again would duplicate it. */
async function assertReserved(
  ctx: QueryCtx,
  org: Doc<'organizations'>,
  items: readonly (typeof RESERVED)[number][],
  absent = false,
): Promise<void> {
  // The organization of a live comment's or link's task or a live
  // milestone's project, which can be in Deleted items while a delete's
  // steps have not moved that comment, link or milestone yet.
  const ownerOrg = async (table: 'issues' | 'projects', rowId: string) =>
    (await byId(ctx, table, rowId))?.org_id ??
    (
      await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', table).eq('row_id', rowId))
        .first()
    )?.org_id
  for (const item of items) {
    const rowId = await id(item.key)
    const what = item.kind === 'issue' ? 'task' : item.kind
    const collision = conflict(
      `marketing demo: reserved ${what} id belongs to another organization`,
      'demo_id_collision',
    )
    // whether a live row has the uuid, and whether the demo owns it
    let live: { owned: boolean } | null = null
    let trashTable: StoredTable | undefined
    if (item.kind === 'project' || item.kind === 'issue') {
      trashTable = item.kind === 'project' ? 'projects' : 'issues'
      const existing = await byId(ctx, trashTable, rowId)
      if (existing) live = { owned: existing.org_id === org.id }
    } else if (item.kind === 'label' || item.kind === 'team') {
      const existing = await byId(ctx, item.kind === 'label' ? 'labels' : 'teams', rowId)
      if (existing) live = { owned: existing.org_id === org.id }
    } else if (item.kind === 'comment') {
      trashTable = 'comments'
      const existing = await byId(ctx, 'comments', rowId)
      if (existing) live = { owned: (await ownerOrg('issues', existing.issue_id)) === org.id }
    } else if (item.kind === 'milestone') {
      trashTable = 'milestones'
      const existing = await byId(ctx, 'milestones', rowId)
      if (existing) live = { owned: (await ownerOrg('projects', existing.project_id)) === org.id }
    } else if (item.kind === 'link') {
      trashTable = 'issue_links'
      const existing = await byId(ctx, 'issue_links', rowId)
      if (existing)
        live = {
          owned:
            (await ownerOrg('issues', existing.source_id)) === org.id &&
            (await ownerOrg('issues', existing.target_id)) === org.id,
        }
    } else {
      const existing = await byId(ctx, 'activity_events', rowId)
      if (existing) live = { owned: existing.org_id === org.id }
    }
    if (live) {
      require(live.owned, collision)
      require(!absent, rule(CHANGED_DURING_SEED))
      continue
    }
    if (trashTable === undefined) continue
    const table = trashTable
    const trashed = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', table).eq('row_id', rowId))
      .first()
    if (trashed) {
      require(trashed.org_id === org.id, collision)
      require(!absent, rule(CHANGED_DURING_SEED))
    }
  }
}

/* Part `part` of the reserved-id check (RESERVED_PARTS). */
const assertReservedPart = (ctx: QueryCtx, org: Doc<'organizations'>, part: number) =>
  assertReserved(ctx, org, RESERVED.slice(part * RESERVED_PART, (part + 1) * RESERVED_PART))

/* The reserved uuids Northstar step `step` writes. */
function reservedFor(step: NorthstarStep): (typeof RESERVED)[number][] {
  const keys = new Set<string>()
  if (step.kind === 'setup') {
    for (const p of MARKETING_DEMO.projects) keys.add(`project:${p.key}`)
    for (const l of MARKETING_DEMO.labels) keys.add(`label:${l.key}`)
    for (const t of MARKETING_DEMO.teams) keys.add(`team:${t.key}`)
  } else if (step.kind === 'tasks') {
    for (const i of MARKETING_DEMO.issues.slice(step.from, step.to)) {
      keys.add(`issue:${i.key}`)
      keys.add(`activity:import:${i.key}`)
    }
  } else if (step.kind === 'history') {
    for (const l of MARKETING_DEMO.links) keys.add(`link:${l.source}:${l.target}`)
    for (const c of MARKETING_DEMO.history) keys.add(`activity:change:${c.key}`)
    for (const m of MARKETING_DEMO.milestones) keys.add(`milestone:${m.key}`)
  } else if (step.kind === 'comments') {
    for (const c of NORTHSTAR_COMMENTS.slice(step.from, step.to)) keys.add(`comment:${c.key}`)
  }
  return RESERVED.filter((item) => keys.has(item.key))
}

/* The refusal of a seed of a demo that is not empty. */
const ADDED_AFTER_WIPE = 'marketing demo: work was added after wipe; use reset to replace it'

/* Whether organization `orgId` has no projects, tasks, teams or labels,
 * live or in Deleted items. */
async function holdsNoWork(ctx: QueryCtx, orgId: string): Promise<boolean> {
  for (const table of ['projects', 'issues', 'teams', 'labels'] as const) {
    const row = await ctx.db
      .query(table)
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .first()
    if (row !== null) return false
  }
  return !(await holdsTrash(ctx, orgId))
}

/* One call of a seed: a part of the reserved-id check, which writes
 * nothing, a step of the Northstar work, or last the usage history
 * (seedUsage). Every part comes first, so a collision refuses before the
 * seed writes anything; each work step checks the uuids it writes again in
 * its own transaction, since a row could take one after the parts ran. */
const SEED_STEPS = [
  ...Array.from({ length: RESERVED_PARTS }, (_, part) => ({ kind: 'check' as const, part })),
  ...NORTHSTAR_STEPS.map((step) => ({ kind: 'work' as const, step })),
  { kind: 'usage' as const },
]

/* REST and MCP calls a month for Qivo Admin's Usage page: Atlas through the
 * team's CI with an agent key, Nora and Leo through their desktop assistant
 * with an MCP token. The demo stores no such credentials, so the
 * organization's API access page lists them as deleted ones, with these
 * calls, and its totals agree with its list. */
const USAGE_CALLERS = [
  { key: 'atlas', table: 'agent_keys', credential: 'Northstar CI', calls: 4200 },
  { key: 'nora', table: 'mcp_tokens', credential: 'Claude Desktop', calls: 380 },
  { key: 'leo', table: 'mcp_tokens', credential: 'Claude Desktop', calls: 150 },
] as const
/* Invitation emails in each of the five closed months, newest first. */
const USAGE_INVITES = [3, 1, 0, 2, 1]

/**
 * The demo's usage history for Qivo Admin's Usage page, the seed's last
 * step: API calls in the month of `now` and the five before it, growing
 * month by month, and the invitation emails of the closed months. It writes
 * exact values, so a reseed leaves the same rows, and a wipe keeps them, as
 * it keeps the logins. Then it stores the five closed months' usage rows of
 * this organization only (usage.ts closeOrgMonth).
 */
async function seedUsage(ctx: MutationCtx, org: Doc<'organizations'>, now: string) {
  const d = new Date(now)
  const months = Array.from({ length: 6 }, (_, i) =>
    monthOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)),
  )
  for (const caller of USAGE_CALLERS) {
    const profile_id = await id(`person:${caller.key}`)
    // `<table>:<uuid>`, the form usage rows name a credential in (apiAccess.ts)
    const credential_id = `${caller.table}:${await id(`usage-credential:${caller.key}`)}`
    for (const [i, month] of months.entries()) {
      // The current month is under way, so it holds about a third of a month.
      const calls = Math.round((caller.calls * (i === 0 ? 0.35 : 1)) / (1 + 0.12 * i))
      const period_start = `month:${month}`
      const row = await ctx.db
        .query('billing_usage')
        .withIndex('by_subject_credential_period', (q) =>
          q
            .eq('org_id', org.id)
            .eq('profile_id', profile_id)
            .eq('credential_id', credential_id)
            .eq('period_start', period_start),
        )
        .unique()
      if (row) await ctx.db.patch(row._id, { calls, credential_name: caller.credential })
      else
        await ctx.db.insert('billing_usage', {
          org_id: org.id,
          profile_id,
          credential_id,
          credential_name: caller.credential,
          period_start,
          calls,
        })
    }
  }
  for (const [i, count] of USAGE_INVITES.entries()) {
    const month = months[i + 1]
    const row = await ctx.db
      .query('usage_counts')
      .withIndex('by_org_month_metric', (q) =>
        q.eq('org_id', org.id).eq('month', month).eq('metric', 'mail_invitations'),
      )
      .unique()
    if (row && count === 0) await ctx.db.delete(row._id)
    else if (row) await ctx.db.patch(row._id, { count })
    else if (count > 0)
      await ctx.db.insert('usage_counts', {
        org_id: org.id,
        month,
        metric: 'mail_invitations',
        count,
      })
  }
  for (const month of months.slice(1))
    await ctx.scheduler.runAfter(0, internal.usage.closeOrgMonth, { org_id: org.id, month })
}

/** A fingerprint of SEED_STEPS, the check parts and the dataset's uuids and
 * version. A seed stores it with its step and refuses to resume when it
 * differs: a step index from another layout would write rows twice or
 * skip them. */
export const SEED_LAYOUT = (() => {
  const text = JSON.stringify({
    version: MARKETING_DEMO_VERSION,
    part: RESERVED_PART,
    reserved: RESERVED.map((item) => item.key),
    steps: SEED_STEPS,
  })
  return `${SEED_STEPS.length}:${layoutHash(text)}`
})()

/** Runs part `part` of the reserved-id check (RESERVED_PARTS) for the
 * owned demo and answers how many parts there are. Read only. The CLI runs
 * every part before it wipes, so a reset refuses before its wipe deletes
 * a demo its seed would then refuse; the seed runs the same parts as its
 * own first steps before it writes. */
export const checkReserved = internalQuery({
  args: { ...expectedSite, part: v.number() },
  handler: async (ctx, args): Promise<{ parts: number }> => {
    site(args.expected_site_url)
    require(Number.isInteger(args.part) && args.part >= 0 && args.part < RESERVED_PARTS, badRequest(
      'marketing demo: unknown check part',
    ))
    const { org } = await owned(ctx)
    await assertReservedPart(ctx, org, args.part)
    return { parts: RESERVED_PARTS }
  },
})

/* The refusal of a seed whose dates or dataset version differ from the
 * demo's. */
const RESET_TO_CHANGE = 'marketing demo: use reset to change dates or dataset version'

/** How much one wipe call deletes: half a deletion step's REMOVAL_BUDGET, so
 * a call stays far inside Convex's 1 s mutation limit on a loaded machine. */
export const WIPE_BUDGET = { rows: 128, bytes: 2 * 1024 * 1024 }

/* Seeds or wipes the owned demo's work, each call one transaction. There is
 * deliberately no single-call reset, and no single-call seed: the whole
 * Northstar work in one transaction came close to Convex's 1 s mutation
 * limit on a loaded machine. Callers reset by running 'wipe' and then 'seed'
 * (scripts/marketing-demo.mjs, the explicit fixture CLI).
 *
 * A wipe call deletes one bounded batch (WIPE_BUDGET), marks the demo empty
 * and answers `wipe_done`, and the CLI calls it again until that is true.
 * The CLI runs checkReserved before the first wipe call, so a reset refuses
 * before it deletes anything. A seed call runs one of SEED_STEPS and
 * answers `seed_done`, and the CLI calls it again until that is true. The
 * first seed call checks and sweeps the empty demo and marks it 'seeding'
 * with the next step and the write time every step uses; the reserved-id
 * check runs in the steps after it, before any step writes, and the last
 * step marks the demo 'ready'. Only the last call of each answers the
 * inspection as well. A seed that stopped resumes at its next step on the
 * next seed call with the same anchor, and a wipe clears a half-seeded demo
 * like any other. The demo is empty between a reset's wipe and seed, and
 * repeating the reset is safe (a seed alone refuses work added after a
 * wipe, Deleted items included, and work a wipe left half done). A wipe
 * refuses while the organization holds Deleted items, which the CLI empties
 * first through deletedItems:purgeOrg. Refusals still say "reset" because
 * that is the CLI command an operator runs. */
export const apply = internalMutation({
  args: {
    ...expectedSite,
    anchor: v.string(),
    mode: v.union(v.literal('seed'), v.literal('wipe')),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | (DemoState & { wipe_done?: true; seed_done?: true })
    | { state: 'empty'; wipe_done: false }
    | { state: 'seeding'; seed_done: false; seed_step: number; seed_steps: number }
  > => {
    site(args.expected_site_url)
    try {
      assertMarketingAnchor(args.anchor)
    } catch {
      throw badRequest('marketing demo: anchor must be a valid ISO date on a Monday')
    }
    const { record, org, profiles } = await owned(ctx)
    if (args.mode === 'seed' && record.state !== 'empty') {
      require(record.anchor === args.anchor && record.version === MARKETING_DEMO_VERSION, rule(
        RESET_TO_CHANGE,
      ))
      if (record.state === 'ready') {
        return { ...(await inspectCore(ctx, args.expected_site_url)), seed_done: true }
      }
      return await seedStep(ctx, record, { org, profiles }, args.expected_site_url)
    }
    if (args.mode === 'seed') require(await holdsNoWork(ctx, org.id), rule(ADDED_AFTER_WIPE))
    // A wipe deletes only live work and rewinds the counters, so it refuses
    // while Deleted items hold anything: their tasks keep numbers the seed
    // hands out again, and an item still moving keeps tasks under projects
    // the wipe cannot reach. The CLI empties them first (deletedItems:purgeOrg).
    if (args.mode === 'wipe') require(!(await holdsTrash(ctx, org.id)), rule(TRASH_LEFT))
    // A seed reaches here only on an empty demo, and still clears: it sweeps
    // leftover activity, messages and view preferences and rewinds the task
    // counters so the rebuilt task numbers match the dataset order. More
    // leftovers than one batch mean a wipe stopped halfway.
    const cleared = await clearWork(ctx, org, profiles)
    const now = new Date().toISOString()
    if (args.mode === 'wipe') {
      await ctx.db.patch(record._id, {
        state: 'empty',
        anchor: undefined,
        seed: undefined,
        updated_at: now,
      })
      // While work remains, inspecting it would read all of it again.
      if (!cleared) return { state: 'empty', wipe_done: false }
      return { ...(await inspectCore(ctx, args.expected_site_url)), wipe_done: true }
    }
    require(cleared, rule(ADDED_AFTER_WIPE))
    await ctx.db.patch(record._id, {
      state: 'seeding',
      version: MARKETING_DEMO_VERSION,
      anchor: args.anchor,
      seed: { step: 0, now, layout: SEED_LAYOUT },
      updated_at: now,
    })
    return { state: 'seeding', seed_done: false, seed_step: 0, seed_steps: SEED_STEPS.length }
  },
})

/* Runs the receipt's next seed step (SEED_STEPS) and moves the receipt on:
 * to the step after it, or to 'ready' after the last, when it answers the
 * inspection. */
async function seedStep(
  ctx: MutationCtx,
  record: Doc<'marketing_demo'>,
  owner: { org: Doc<'organizations'>; profiles: Doc<'profiles'>[] },
  expected: string,
) {
  const { seed, anchor } = record
  const step = seed === undefined ? undefined : SEED_STEPS[seed.step]
  // A receipt from another code version can point past the steps, or into
  // another layout of them.
  require(seed !== undefined &&
    seed.layout === SEED_LAYOUT &&
    anchor !== undefined &&
    step !== undefined, rule(RESET_TO_CHANGE))
  if (step.kind === 'check') await assertReservedPart(ctx, owner.org, step.part)
  else if (step.kind === 'usage') await seedUsage(ctx, owner.org, seed.now)
  else {
    // Between two calls the app can change the demo. Setup resets the
    // counters, so it needs the demo as empty as the first call left it;
    // a later step would write under tasks or projects moved to Deleted
    // items. A collision refuses before this transaction writes.
    if (step.step.kind === 'setup')
      require(await holdsNoWork(ctx, owner.org.id), rule(ADDED_AFTER_WIPE))
    else require(!(await holdsTrash(ctx, owner.org.id)), rule(CHANGED_DURING_SEED))
    await assertReserved(ctx, owner.org, reservedFor(step.step), true)
    await writeNorthstarStep(ctx, { ...owner, namespace: KEY, anchor, now: seed.now }, step.step)
  }
  const next = seed.step + 1
  if (next < SEED_STEPS.length) {
    await ctx.db.patch(record._id, { seed: { ...seed, step: next } })
    return {
      state: 'seeding' as const,
      seed_done: false as const,
      seed_step: next,
      seed_steps: SEED_STEPS.length,
    }
  }
  await ctx.db.patch(record._id, { state: 'ready', seed: undefined, updated_at: seed.now })
  return { ...(await inspectCore(ctx, expected)), seed_done: true as const }
}

async function avatarPerson(ctx: QueryCtx, person: string) {
  const { profiles } = await owned(ctx)
  require(MARKETING_DEMO.people.some((p) => p.key === person), badRequest(
    'marketing demo: unknown person',
  ))
  const profileId = await id(`person:${person}`)
  const profile = profiles.find((p) => p.id === profileId)
  require(profile !== undefined, rule('marketing demo: owned profile missing'))
  return profile
}
export const avatarUpload = internalMutation({
  args: { ...expectedSite, person: v.string() },
  handler: async (ctx, args) => {
    site(args.expected_site_url)
    await avatarPerson(ctx, args.person)
    return await ctx.storage.generateUploadUrl()
  },
})
export const adoptAvatar = internalMutation({
  args: { ...expectedSite, person: v.string(), storage_id: v.id('_storage') },
  handler: async (ctx, args) => {
    site(args.expected_site_url)
    const profile = await avatarPerson(ctx, args.person)
    if (profile.avatar_storage_id === args.storage_id) return null
    const meta = await ctx.db.system.get(args.storage_id)
    require(meta !== null &&
      ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(meta.contentType ?? '') &&
      meta.size <= LIMITS.avatarSize.max * MIB, badRequest(
      `marketing demo: avatar must be an image of at most ${LIMITS.avatarSize.max} MiB`,
    ))
    const other = await ctx.db
      .query('profiles')
      .withIndex('by_avatar', (q) => q.eq('avatar_storage_id', args.storage_id))
      .first()
    const attachment = await ctx.db
      .query('issue_attachments')
      .withIndex('by_storage', (q) => q.eq('storage_id', args.storage_id))
      .first()
    const trashed = await ctx.db
      .query('deleted_rows')
      .withIndex('by_storage', (q) => q.eq('storage_id', args.storage_id))
      .first()
    require(other === null && attachment === null && trashed === null, badRequest(
      'marketing demo: avatar bytes already belong to another record',
    ))
    await ctx.db.patch(profile._id, { avatar_storage_id: args.storage_id })
    if (profile.avatar_storage_id !== undefined) await ctx.storage.delete(profile.avatar_storage_id)
    return null
  },
})
