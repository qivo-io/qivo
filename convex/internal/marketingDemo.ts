/* Private, deployment-key-only nonproduction fixture. It uses random
 * credentials and can only rebuild the
 * organization recorded in its own ownership receipt. Passwords are hashed by
 * the local CLI with Better Auth's own hashPassword; neither plaintext
 * passwords nor a public reset function reach deployment. Normal deployment
 * never runs this fixture. Seed, reset and wipe are explicit operator commands. */
import { v } from 'convex/values'
import { components } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalMutation, internalQuery } from '../_generated/server'
import { byId } from '../lib/db'
import { refuseProduction } from '../lib/deployment'
import type { StoredTable } from '../lib/enums'
import { badRequest, conflict, require, rule } from '../lib/functions'
import { SAMPLE_AVATARS, type SampleAvatar, writeNorthstarWork } from '../model/demoSeed'
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
  const tasks = await ctx.db
    .query('issues')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
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
      tasks: tasks.length,
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
      require((await byId(ctx, 'profiles', await id(`person:${person.key}`))) === null, conflict(
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
              message_retention_days: 7,
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
  )
  if (done) {
    await setCounters(ctx, org, { next_issue_num: 0, next_project_num: 0 })
    await ctx.db.patch(org._id, { activity_count: undefined })
  }
  return done
}

/* Seeds or wipes the owned demo's work, each call one transaction. There is
 * deliberately no single-call reset: clearing and rebuilding together used
 * nearly all of Convex's 1 s mutation limit and could time out. Callers
 * reset by running 'wipe' and then 'seed' (scripts/marketing-demo.mjs,
 * the explicit fixture CLI). A wipe call deletes one bounded batch, marks
 * the demo empty and answers `wipe_done`, and the CLI calls it again until
 * that is true. The demo is empty between the two steps, a failed seed
 * leaves it as the wipe left it, and repeating the reset is safe (a seed
 * alone refuses work added after a wipe, Deleted items included, and work a
 * wipe left half done). A wipe refuses while the organization holds Deleted
 * items, which the CLI empties first through deletedItems:purgeOrg.
 * Refusals still say "reset" because that is the CLI command an operator
 * runs. */
export const apply = internalMutation({
  args: {
    ...expectedSite,
    anchor: v.string(),
    mode: v.union(v.literal('seed'), v.literal('wipe')),
  },
  handler: async (ctx, args): Promise<DemoState & { wipe_done?: boolean }> => {
    site(args.expected_site_url)
    try {
      assertMarketingAnchor(args.anchor)
    } catch {
      throw badRequest('marketing demo: anchor must be a valid ISO date on a Monday')
    }
    const { record, org, profiles } = await owned(ctx)
    // All app UUIDs are globally unique. A matching key in another tenant
    // must fail before any cascade or insertion, including on a wipe, so a
    // reset refuses before its wipe deletes anything. A uuid that another
    // organization's Deleted items keep stays reserved too (lib/db.ts
    // insertUnique), so it collides like a live row; only an absent row
    // needs that look.
    const trashedElsewhere = async (table: StoredTable, rowId: string) => {
      const row = await ctx.db
        .query('deleted_rows')
        .withIndex('by_row', (q) => q.eq('table', table).eq('row_id', rowId))
        .first()
      return row !== null && row.org_id !== org.id
    }
    for (const project of MARKETING_DEMO.projects) {
      const projectId = await id(`project:${project.key}`)
      const existing = await byId(ctx, 'projects', projectId)
      require(existing === null
        ? !(await trashedElsewhere('projects', projectId))
        : existing.org_id === org.id, conflict(
        'marketing demo: reserved project id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const issue of MARKETING_DEMO.issues) {
      const issueId = await id(`issue:${issue.key}`)
      const existing = await byId(ctx, 'issues', issueId)
      require(existing === null
        ? !(await trashedElsewhere('issues', issueId))
        : existing.org_id === org.id, conflict(
        'marketing demo: reserved task id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const label of MARKETING_DEMO.labels) {
      const existing = await byId(ctx, 'labels', await id(`label:${label.key}`))
      require(existing === null || existing.org_id === org.id, conflict(
        'marketing demo: reserved label id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const team of MARKETING_DEMO.teams) {
      const existing = await byId(ctx, 'teams', await id(`team:${team.key}`))
      require(existing === null || existing.org_id === org.id, conflict(
        'marketing demo: reserved team id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const comment of MARKETING_DEMO.comments) {
      const commentId = await id(`comment:${comment.key}`)
      const existing = await byId(ctx, 'comments', commentId)
      const issue = existing ? await byId(ctx, 'issues', existing.issue_id) : null
      require(existing === null
        ? !(await trashedElsewhere('comments', commentId))
        : issue?.org_id === org.id, conflict(
        'marketing demo: reserved comment id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const milestone of MARKETING_DEMO.milestones) {
      const milestoneId = await id(`milestone:${milestone.key}`)
      const existing = await byId(ctx, 'milestones', milestoneId)
      const project = existing ? await byId(ctx, 'projects', existing.project_id) : null
      require(existing === null
        ? !(await trashedElsewhere('milestones', milestoneId))
        : project?.org_id === org.id, conflict(
        'marketing demo: reserved milestone id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const link of MARKETING_DEMO.links) {
      const linkId = await id(`link:${link.source}:${link.target}`)
      const existing = await byId(ctx, 'issue_links', linkId)
      const source = existing ? await byId(ctx, 'issues', existing.source_id) : null
      const target = existing ? await byId(ctx, 'issues', existing.target_id) : null
      require(existing === null
        ? !(await trashedElsewhere('issue_links', linkId))
        : source?.org_id === org.id && target?.org_id === org.id, conflict(
        'marketing demo: reserved link id belongs to another organization',
        'demo_id_collision',
      ))
    }
    for (const issue of MARKETING_DEMO.issues) {
      const existing = await byId(ctx, 'activity_events', await id(`activity:import:${issue.key}`))
      require(existing === null || existing.org_id === org.id, conflict(
        'marketing demo: reserved activity id belongs to another organization',
        'demo_id_collision',
      ))
    }
    if (args.mode === 'seed' && record.state === 'empty') {
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .first()
      const issues = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .first()
      const teams = await ctx.db
        .query('teams')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .first()
      const labels = await ctx.db
        .query('labels')
        .withIndex('by_org', (q) => q.eq('org_id', org.id))
        .first()
      require(projects === null &&
        issues === null &&
        teams === null &&
        labels === null &&
        !(await holdsTrash(ctx, org.id)), rule(
        'marketing demo: work was added after wipe; use reset to replace it',
      ))
    }
    if (args.mode === 'seed' && record.state === 'ready') {
      require(record.anchor === args.anchor && record.version === MARKETING_DEMO_VERSION, rule(
        'marketing demo: use reset to change dates or dataset version',
      ))
      return await inspectCore(ctx, args.expected_site_url)
    }
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
      await ctx.db.patch(record._id, { state: 'empty', anchor: undefined, updated_at: now })
      return { ...(await inspectCore(ctx, args.expected_site_url)), wipe_done: cleared }
    }
    require(cleared, rule('marketing demo: work was added after wipe; use reset to replace it'))
    await writeNorthstarWork(ctx, { org, profiles, namespace: KEY, anchor: args.anchor, now })
    await ctx.db.patch(record._id, {
      state: 'ready',
      version: MARKETING_DEMO_VERSION,
      anchor: args.anchor,
      updated_at: now,
    })
    return await inspectCore(ctx, args.expected_site_url)
  },
})

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
      meta.size <= 2 * 1024 * 1024, badRequest(
      'marketing demo: avatar must be an image of at most 2 MB',
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
