import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { components } from '../_generated/api'
import type { Doc, TableNames } from '../_generated/dataModel'
import authSchema from '../betterAuth/schema'
import { MARKETING_DEMO, marketingId } from '../internal/marketingDemoData'
import { moveProjectToTrash, moveTasksToTrash, TRASH_BUDGET } from '../model/deletedItems'
import { demoMonday, PUBLIC_DEMO_STEPS, provisionPublicDemoStep } from '../model/demoSeed'
import { countersRow, tallyRow } from '../model/orgs'
import schema from '../schema'
import { countersFor, expectLiveCounts, expectRefusal, newT, type T, uuid } from './helpers.setup'

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}
declare class TextEncoder {
  encode(input: string): Uint8Array
}
const NOW = Date.parse('2026-09-16T10:00:00Z')
const purge = makeFunctionReference<'mutation', { demo_id: string }, null>(
  'internal/demoCleanup:purge',
)
const recover = makeFunctionReference<'mutation', Record<string, never>, null>(
  'internal/demoCleanup:recover',
)

function testBackend(options: Parameters<typeof newT>[0] = {}) {
  const t = newT(options)
  t.registerComponent('betterAuth', authSchema, import.meta.glob('../betterAuth/**/*.*s'))
  return t
}

/** A demo receipt and its anonymous login, provisioned by `steps` calls of
 * provisionPublicDemoStep (all of them by default, none when false). */
async function makeDemo(t: T, provision: boolean | number = true) {
  const steps = provision === true ? PUBLIC_DEMO_STEPS : provision === false ? 0 : provision
  const made = await t.run(async (ctx) => {
    const id = uuid()
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          email: `${id}@demo.invalid`,
          name: 'Anonymous',
          emailVerified: false,
          isAnonymous: true,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    })) as { _id: string; email: string }
    const receiptId = await ctx.db.insert('demo_sessions', {
      id,
      auth_user_id: user._id,
      status: 'unprovisioned',
      created_at: NOW,
      expires_at: NOW + 86_400_000,
    })
    return { receiptId, user }
  })
  for (let step = 0; step < steps; step++)
    await t.run(async (ctx) =>
      provisionPublicDemoStep(ctx, (await ctx.db.get(made.receiptId))!, made.user),
    )
  return t.run(async (ctx) => (await ctx.db.get(made.receiptId))!)
}

async function rows(t: T, orgId: string) {
  return t.run(async (ctx) => ({
    org: await ctx.db
      .query('organizations')
      .withIndex('by_uuid', (q) => q.eq('id', orgId))
      .unique(),
    profiles: await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
    projects: await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
    tasks: await ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
  }))
}

/** Deletes `receipt`'s demo batch by batch, as its scheduled purges would,
 * and returns the phase each batch started in. */
async function deleteDemo(t: T, receipt: Doc<'demo_sessions'>): Promise<string[]> {
  await t.run((ctx) => ctx.db.patch(receipt._id, { status: 'deleting' }))
  const phases: string[] = []
  for (
    let current = await t.run((ctx) => ctx.db.get(receipt._id));
    current !== null;
    current = await t.run((ctx) => ctx.db.get(receipt._id))
  ) {
    if (phases.length >= 80)
      throw new Error('demo deletion did not finish within its bounded batch target')
    phases.push(current.cleanup_phase ?? 'sessions')
    await t.mutation(purge, { demo_id: receipt.id })
    // each batch keeps the live counts while the organization lasts
    const orgId = receipt.org_id
    if (orgId !== undefined && (await t.run((ctx) => countersRow(ctx, orgId))) !== null)
      await expectLiveCounts(t, orgId)
    const progress = await t.run((ctx) => ctx.db.get(receipt._id))
    if (progress?.cleanup_phase === 'uploads') {
      vi.setSystemTime(
        Math.max(
          Date.now() + 5000,
          progress.cleanup_file_after ?? 0,
          progress.cleanup_file_wait_until ?? 0,
        ),
      )
    }
  }
  return phases
}

// New tables require a deliberate ownership decision. Disabled capabilities
// are still cleaned defensively if a test/internal operation ever planted them.
const APP_OWNED: TableNames[] = [
  'demo_sessions',
  'demo_write_counts',
  'demo_uploads',
  'roadmap_history',
  'organizations',
  'org_counters',
  'teams',
  'profiles',
  'projects',
  'issues',
  'labels',
  'activity_events',
  'webhook_events',
  'webhook_health',
  'webhook_subscriptions',
  'webhook_deliveries',
  'team_members',
  'project_access',
  'project_team_access',
  'milestones',
  'issue_links',
  'issue_labels',
  'issue_attachments',
  'comments',
  'agent_keys',
  'issue_subscriptions',
  'messages',
  'user_prefs',
  'sync_stamps',
  'mcp_tokens',
  'oauth_connections',
  'oauth_credential_uses',
  'account_appearance',
  'custom_backgrounds',
  'background_uploads',
  'deleted_items',
  'deleted_item_jobs',
  'deleted_item_parents',
  'deleted_rows',
  'deleted_tasks',
]
const APP_SHARED = [
  'webhook_workers', // shared background reservations contain no tenant data
  // REST upload tickets: asMachineCaller refuses every machine call on a demo
  // deployment, so a demo never has one
  'attachment_uploads',
  'demo_admission', // expiring deployment admission windows, no owner/workspace data
  'demo_metrics', // durable anonymous totals, independent of demo lifetime
  'demo_metrics_daily', // aggregate UTC history survives workspace deletion
  'demo_metrics_scans', // deployment sampler progress has no tenant ownership
  'demo_metric_reports', // main deployment's aggregate reporting cache
  'marketing_demo', // private operator fixture; public demos never touch its receipt
  // Keyed by an already removed profile; its own steps delete it, also after
  // the demo organization is gone (profileRemovals.ts).
  'profile_removals',
  // Keyed by an already deleted label; its own steps delete it, also after
  // the demo organization is gone (labelRemovals.ts).
  'label_removals',
  // Keyed by a deleted task; its own steps find no subtasks once the demo
  // organization is gone and delete it (model/deletedItems.ts).
  'archived_detaches',
  // Organization deletion never runs on a demo deployment: an admin's request
  // refuses demos, and billing, which starts every other removal, is off.
  'org_removals',
  'panorama_images',
  'panorama_calendar',
  'panorama_curation_keys',
  'panorama_submissions',
  'panorama_library',
  'panorama_refills',
  'platform_admins',
  'platform_audit_log', // operator and maintenance-job records; demo sessions add none
  // Billing and machine metering never run in APP_MODE=demo. Their production
  // plan catalog, financial ledger and request windows are independent of a
  // public demo session and must not be purged with anonymous workspace data.
  'billing_plans',
  'billing_settings',
  'billing_subscriptions',
  'billing_periods',
  'billing_usage',
  'billing_usage_totals',
  'billing_events',
  'billing_webhooks',
  'billing_notices',
  'machine_rate_limits',
  // The demo runs no OAuth provider, so it records no ended session
  // (lib/oauthProvider.ts endSessionAccess).
  'oauth_ended_sessions',
  // Usage is neither counted nor stored in APP_MODE=demo (model/usage.ts).
  'usage_months',
  'usage_counts',
  'usage_runs',
  'usage_sign_ins',
]
const AUTH_OWNED = [
  'user',
  'session',
  'account',
  'oauthClient',
  'oauthAccessToken',
  'oauthRefreshToken',
  'oauthConsent',
  'oauthClientResource',
]
const AUTH_SHARED = ['jwks', 'oauthResource']
// Anonymous signin and token minting create no verification entries. Demo HTTP
// and auth routes prohibit reset, email verification, social login and OTT.
// The demo runs no OAuth provider, so no client authenticates with an assertion.
const AUTH_IMPOSSIBLE = ['verification', 'oauthClientAssertion']

async function ownedSnapshot(t: T) {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {}
    for (const table of APP_OWNED) out[table] = await ctx.db.query(table).collect()
    return out
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('APP_MODE', 'demo')
  vi.stubEnv('SITE_URL', 'https://demo.qivo.io')
})
const DEFAULT_TRASH_BUDGET = { ...TRASH_BUDGET }
afterEach(() => {
  Object.assign(TRASH_BUDGET, DEFAULT_TRASH_BUDGET)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('public Northstar provisioning and bounded deletion', () => {
  it('classifies every application and Better Auth table', () => {
    const all = [...APP_OWNED, ...APP_SHARED]
    expect(new Set(all).size).toBe(all.length)
    expect(all.sort()).toEqual(Object.keys(schema.tables).sort())
    expect([...AUTH_OWNED, ...AUTH_SHARED, ...AUTH_IMPOSSIBLE].sort()).toEqual(
      Object.keys(authSchema.tables).sort(),
    )
  })

  it('seeds independent identities, current-week planning and one visitor login', async () => {
    const t = testBackend()
    const a = await makeDemo(t)
    const b = await makeDemo(t)
    const left = await rows(t, a.org_id!)
    const right = await rows(t, b.org_id!)
    expect(left.tasks).toHaveLength(MARKETING_DEMO.issues.length)
    expect(left.projects).toHaveLength(15)
    await expectLiveCounts(t, a.org_id!)
    expect(left.profiles).toHaveLength(8)
    expect(left.profiles.filter((p) => p.auth_user_id)).toHaveLength(1)
    expect(left.profiles.find((p) => p.auth_user_id)?.name).toBe('Nora Berg')
    expect(left.profiles.every((p) => p.sample_avatar && !p.avatar_storage_id)).toBe(true)
    expect(left.profiles.find((p) => p.kind === 'agent')?.email).toBeUndefined()
    const rightIds = new Set(
      [...right.tasks, ...right.projects, ...right.profiles].map((r) => r.id),
    )
    expect(
      [...left.tasks, ...left.projects, ...left.profiles].some((r) => rightIds.has(r.id)),
    ).toBe(false)
    const emails = [...left.profiles, ...right.profiles].flatMap((p) => (p.email ? [p.email] : []))
    expect(new Set(emails).size).toBe(emails.length)
    expect(emails.every((e) => e.endsWith('.invalid'))).toBe(true)
    // each copy holds its own import rows and change history
    const events = await t.run((ctx) => ctx.db.query('activity_events').collect())
    const eventsOf = (org: string) => events.filter((e) => e.org_id === org).map((e) => e.id)
    const [leftEvents, rightEvents] = [eventsOf(a.org_id!), eventsOf(b.org_id!)]
    for (const list of [leftEvents, rightEvents]) {
      expect(list).toHaveLength(MARKETING_DEMO.issues.length + MARKETING_DEMO.history.length)
    }
    expect(leftEvents.some((id) => rightEvents.includes(id))).toBe(false)
    expect(a.anchor).toBe('2026-09-14')
    expect(demoMonday(Date.parse('2026-09-20T23:59:59Z'))).toBe(a.anchor)
    expect(demoMonday(Date.parse('2026-09-21T00:00:00Z'))).toBe('2026-09-21')
    expect(await countersFor(t, a.org_id!)).toEqual({
      next_issue_num: MARKETING_DEMO.issues.length,
      next_project_num: MARKETING_DEMO.projects.length,
    })
    expect(
      left.tasks
        .filter((r) => r.remaining_hours !== undefined)
        .every((r) => r.remaining_set_at === new Date(NOW).toISOString()),
    ).toBe(true)
    const ids = new Set(left.tasks.map((r) => r.id))
    expect(left.tasks.every((r) => !r.parent_id || ids.has(r.parent_id))).toBe(true)
    const projects = new Set(left.projects.map((r) => r.id))
    expect(left.tasks.every((r) => projects.has(r.project_id))).toBe(true)
    const comments = await t.run((ctx) => ctx.db.query('comments').collect())
    for (const task of left.tasks) {
      const thread = comments.filter((comment) => comment.issue_id === task.id)
      expect(thread.length, task.title).toBeGreaterThanOrEqual(1)
      expect(thread.length, task.title).toBeLessThanOrEqual(5)
      expect(
        thread.every((comment) => left.profiles.some((person) => person.id === comment.author)),
      ).toBe(true)
      expect(new Set(thread.map((comment) => comment.created_at)).size, task.title).toBe(
        thread.length,
      )
    }
  }, 30_000)

  it('keeps the fixed seed within the single-transaction document and payload budget', async () => {
    const t = testBackend()
    await makeDemo(t)
    const seed = await ownedSnapshot(t)
    // Full conversations include their notification and subscription rows.
    // These conservative ceilings leave room below Convex's 16,000-document
    // write and 8-MiB write-payload limits; the live seed still verifies the
    // actual transaction, including reads and transient/overwritten writes.
    expect(Object.values(seed).reduce((sum, table) => sum + table.length, 0)).toBeLessThan(2000)
    expect(new TextEncoder().encode(JSON.stringify(seed)).byteLength).toBeLessThan(1024 * 1024)
  })

  it('refuses direct seeding on a normal deployment or a used receipt', async () => {
    const t = testBackend()
    const receipt = await makeDemo(t, false)
    vi.stubEnv('APP_MODE', 'normal')
    await expectRefusal(
      t.run((ctx) =>
        provisionPublicDemoStep(ctx, receipt, {
          _id: receipt.auth_user_id,
          email: 'owner@demo.invalid',
        }),
      ),
      'rule',
      /unavailable/,
    )
    vi.stubEnv('APP_MODE', 'demo')
    const existing = await makeDemo(t)
    await expectRefusal(
      t.run((ctx) =>
        provisionPublicDemoStep(ctx, existing, {
          _id: existing.auth_user_id,
          email: 'owner@demo.invalid',
        }),
      ),
      'rule',
      /cannot be provisioned/,
    )
  })

  it('deletes manual work, dependent rows, auth and private bytes in repeatable batches while preserving another demo', async () => {
    const t = testBackend()
    const b = await makeDemo(t)
    const shared = await t.run(async (ctx) => {
      const file = await ctx.storage.store(new Blob(['another demo avatar']) as never)
      const profile = (await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', b.auth_user_id))
        .first())!
      await ctx.db.patch(profile._id, { avatar_storage_id: file })
      return file
    })
    const allOtherRows = await ownedSnapshot(t)
    const a = await makeDemo(t)
    const otherBefore = await rows(t, b.org_id!)
    const files = await t.run(async (ctx) => {
      const issue = (await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', a.org_id!))
        .first())!
      const profile = (await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', a.auth_user_id))
        .first())!
      const manual = { ...issue, id: uuid(), title: 'Created by visitor', num: 999 }
      const { _id: ignoredId, _creationTime: ignoredTime, ...record } = manual
      void ignoredId
      void ignoredTime
      await ctx.db.insert('issues', record)
      await tallyRow(ctx, 'issues', null, record)
      // a Team sync stamp row whose profile is already gone
      await ctx.db.insert('sync_stamps', {
        org_id: a.org_id!,
        profile_id: uuid(),
        at: new Date(NOW).toISOString(),
      })
      for (let i = 0; i < 150; i++)
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: record.id,
          author: profile.id,
          body: `Manual ${i}`,
          created_at: new Date(NOW).toISOString(),
        })
      const timestamp = new Date(NOW).toISOString()
      await ctx.db.insert('issue_subscriptions', {
        issue_id: record.id,
        profile_id: profile.id,
        created_at: timestamp,
      })
      await ctx.db.insert('messages', {
        id: uuid(),
        org_id: a.org_id!,
        recipient_id: profile.id,
        actor_id: profile.id,
        issue_id: record.id,
        issue_title: record.title,
        kind: 'comment',
        detail: 'Manual message',
        created_at: timestamp,
      })
      const agent = (
        await ctx.db
          .query('profiles')
          .withIndex('by_org', (q) => q.eq('org_id', a.org_id!))
          .collect()
      ).find((p) => p.kind === 'agent')!
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: agent.id,
        name: 'Defensive cleanup fixture',
        key_prefix: 'qva_test',
        key_hash: 'a'.repeat(64),
        created_by: profile.id,
        created_at: timestamp,
      })
      await ctx.db.insert('mcp_tokens', {
        id: uuid(),
        profile_id: profile.id,
        name: 'Defensive cleanup fixture',
        token_prefix: 'qvt_test',
        token_hash: 'b'.repeat(64),
        access: 'read',
        created_at: timestamp,
      })
      const connectionId = uuid()
      await ctx.db.insert('oauth_connections', {
        id: connectionId,
        authorization_hash: 'c'.repeat(64),
        auth_user_id: a.auth_user_id,
        profile_id: profile.id,
        org_id: a.org_id!,
        client_id: 'demo-cleanup-client',
        client_name: 'Defensive fixture',
        resource: 'https://demo.invalid/mcp',
        requested_scopes: [],
        scopes: [],
        created_at: timestamp,
        authorization_expires_at: timestamp,
      })
      await ctx.db.insert('oauth_credential_uses', {
        connection_id: connectionId,
        credential_hash: 'd'.repeat(64),
        kind: 'authorization_code',
      })
      await ctx.db.insert('background_uploads', {
        id: uuid(),
        auth_user_id: a.auth_user_id,
        name: 'Abandoned background',
        expires_at: NOW + 1000,
        expected_revision: uuid(),
      })
      await ctx.db.insert('user_prefs', {
        profile_id: profile.id,
        prefs: { secret: 'view' },
        updated_at: new Date(NOW).toISOString(),
      })
      await ctx.db.insert('roadmap_history', {
        auth_user_id: a.auth_user_id,
        session_key: uuid(),
        position: 1,
        expires_at: NOW + 60_000,
        changes: '{}',
      })
      const attachment = await ctx.storage.store(new Blob(['attachment']) as never)
      const avatar = await ctx.storage.store(new Blob(['avatar']) as never)
      const background = await ctx.storage.store(new Blob(['background']) as never)
      const preview = await ctx.storage.store(new Blob(['preview']) as never)
      await ctx.db.patch(profile._id, { avatar_storage_id: avatar })
      await ctx.db.insert('issue_attachments', {
        org_id: record.org_id,
        id: uuid(),
        issue_id: record.id,
        name: 'manual.txt',
        size_bytes: 10,
        storage_id: attachment,
        inline: false,
        uploaded_by: profile.id,
        created_at: new Date(NOW).toISOString(),
      })
      await ctx.db.insert('custom_backgrounds', {
        id: uuid(),
        auth_user_id: a.auth_user_id,
        storage_id: background,
        preview_storage_id: preview,
        name: 'Custom',
        mime: 'image/jpeg',
        width: 1,
        height: 1,
        byte_size: 10,
        sha256: 'a'.repeat(64),
        uploaded_at: new Date(NOW).toISOString(),
      })
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'session',
          data: {
            userId: a.auth_user_id,
            token: uuid(),
            createdAt: NOW,
            updatedAt: NOW,
            expiresAt: NOW + 1000,
          },
        },
      })
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'account',
          data: {
            userId: a.auth_user_id,
            providerId: 'credential',
            accountId: a.auth_user_id,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      })
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthClient',
          data: { clientId: 'demo-cleanup-client', userId: a.auth_user_id, redirectUris: [] },
        },
      })
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthAccessToken',
          data: {
            token: uuid(),
            clientId: 'demo-cleanup-client',
            userId: a.auth_user_id,
            scopes: [],
          },
        },
      })
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthRefreshToken',
          data: {
            token: uuid(),
            clientId: 'demo-cleanup-client',
            userId: a.auth_user_id,
            scopes: [],
          },
        },
      })
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: {
          model: 'oauthConsent',
          data: { clientId: 'demo-cleanup-client', userId: a.auth_user_id, scopes: [] },
        },
      })
      // the demo's write counters
      await ctx.db.insert('demo_write_counts', { demo_id: a.id, write_count: 3, insert_count: 9 })
      return { attachment, avatar, background, preview, shared }
    })
    expect((await deleteDemo(t, a)).length).toBeGreaterThan(1)
    await t.mutation(purge, { demo_id: a.id }) // lost completion acknowledgement is safe
    expect(await rows(t, b.org_id!)).toEqual(otherBefore)
    expect(await ownedSnapshot(t)).toEqual(allOtherRows)
    for (const model of [
      'session',
      'account',
      'oauthClient',
      'oauthAccessToken',
      'oauthRefreshToken',
      'oauthConsent',
    ] as const) {
      expect(
        await t.run((ctx) =>
          ctx.runQuery(components.betterAuth.adapter.findOne, {
            model,
            where: [{ field: 'userId', value: a.auth_user_id }],
          }),
        ),
      ).toBeNull()
    }
    expect((await rows(t, a.org_id!)).org).toBeNull()
    const remainder = await t.run(async (ctx) => {
      const tables: Record<string, number> = {}
      for (const table of APP_OWNED) tables[table] = (await ctx.db.query(table).collect()).length
      const auth = await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: '_id', value: a.auth_user_id }],
      })
      const bytes = await Promise.all(Object.values(files).map((id) => ctx.db.system.get(id)))
      return { tables, auth, bytes }
    })
    expect(remainder.auth).toBeNull()
    expect(remainder.bytes.slice(0, 4)).toEqual([null, null, null, null])
    expect(remainder.bytes[4]).not.toBeNull()
    expect(remainder.tables.comments).toBe(MARKETING_DEMO.comments.length)
    expect(remainder.tables.roadmap_history).toBe(0)
    expect(remainder.tables.user_prefs).toBe(0)
    expect(remainder.tables.issue_attachments).toBe(0)
    expect(remainder.tables.custom_backgrounds).toBe(0)
    expect(remainder.tables.account_appearance).toBe(1)
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  }, 30_000)

  it('deletes Deleted items still moving, with their leftover rows and bytes, before the tasks', async () => {
    const t = testBackend()
    const b = await makeDemo(t)
    const others = await ownedSnapshot(t)
    const a = await makeDemo(t)
    const bytes = await t.run(async (ctx) => {
      const admin = (await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', a.auth_user_id))
        .first())!
      const projects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', a.org_id!))
        .collect()
      const sub = projects.find((p) => p.type === 'project')!
      const tasks = await ctx.db
        .query('issues')
        .withIndex('by_project', (q) => q.eq('project_id', sub.id))
        .collect()
      const root = tasks.find((task) => task.parent_id === undefined)!
      const file = await ctx.storage.store(new Blob(['trashed attachment']) as never)
      await ctx.db.insert('issue_attachments', {
        org_id: a.org_id!,
        id: uuid(),
        issue_id: root.id,
        name: 'trashed.txt',
        size_bytes: 18,
        storage_id: file,
        inline: false,
        created_at: new Date(NOW).toISOString(),
      })
      const now = new Date(NOW).toISOString()
      // both stop after one row: the task's rows and the project's tasks
      // are still in the live tables, and each job waits for its next step
      Object.assign(TRASH_BUDGET, { rows: 1, ranges: 1 })
      await moveTasksToTrash(ctx, { actor: admin, root, subtasks: [], now })
      const meta = projects.find((p) => p.type === 'meta' && p.id !== sub.parent_id)!
      await moveProjectToTrash(ctx, { actor: admin, project: meta, now })
      return file
    })
    const inFlight = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_org_deleted', (q) => q.eq('org_id', a.org_id!))
        .collect(),
    )
    expect(inFlight.map((item) => item.state)).toEqual(['moving', 'moving'])
    expect(await t.run((ctx) => ctx.db.query('deleted_item_jobs').collect())).toHaveLength(2)

    await deleteDemo(t, a)
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await ownedSnapshot(t)).toEqual(others)
    expect(await t.run((ctx) => ctx.db.system.get(bytes))).toBeNull()
    expect((await rows(t, b.org_id!)).tasks).toHaveLength(MARKETING_DEMO.issues.length)
  }, 60_000)

  it('deletes stored rows of about 900 KB in several batches within the real limits', async () => {
    const t = testBackend({ transactionLimits: true })
    const a = await makeDemo(t)
    const { admin, root } = await t.run(async (ctx) => {
      const admin = (await ctx.db
        .query('profiles')
        .withIndex('by_auth', (q) => q.eq('auth_user_id', a.auth_user_id))
        .first())!
      const root = (await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', a.org_id!))
        .filter((q) => q.eq(q.field('parent_id'), undefined))
        .first())!
      return { admin, root }
    })
    // 24 comments of about 900 KB, over 20 MiB together: a batch of 64
    // rows would read them all
    const body = 'Field note. '.repeat(75_000)
    for (let i = 0; i < 24; i++)
      await t.run(async (ctx) => {
        await ctx.db.insert('comments', {
          id: uuid(),
          issue_id: root.id,
          body,
          created_at: new Date(NOW).toISOString(),
        })
      })
    await t.run((ctx) =>
      moveTasksToTrash(ctx, {
        actor: admin,
        root,
        subtasks: [],
        now: new Date(NOW).toISOString(),
      }),
    )
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const item = await t.run((ctx) =>
      ctx.db
        .query('deleted_items')
        .withIndex('by_target', (q) => q.eq('target_id', root.id))
        .unique(),
    )
    expect(item).toMatchObject({ state: 'ready' })
    expect(item?.dropped_rows).toBeUndefined()

    const phases = await deleteDemo(t, a)
    // the trash phase took several batches, each within 16 MiB
    expect(phases.filter((phase) => phase === 'trash').length).toBeGreaterThan(3)
    for (const table of ['deleted_items', 'deleted_rows', 'deleted_tasks', 'comments'] as const)
      expect(await t.run((ctx) => ctx.db.query(table).collect()), table).toEqual([])
  }, 120_000)

  it('keeps the receipt during an in-flight upload and resumes after its lease', async () => {
    const t = testBackend()
    const receipt = await makeDemo(t, false)
    await t.run(async (ctx) => {
      await ctx.db.patch(receipt._id, { status: 'deleting' })
      await ctx.db.insert('demo_uploads', {
        id: uuid(),
        demo_id: receipt.id,
        auth_user_id: receipt.auth_user_id,
        kind: 'attachment',
        target_id: uuid(),
        expires_at: NOW - 1,
        reserved_bytes: 100,
        state: 'receiving',
        lease_until: NOW + 60_000,
      })
    })
    await t.mutation(purge, { demo_id: receipt.id })
    expect((await t.run((ctx) => ctx.db.get(receipt._id)))?.cleanup_phase).toBe('uploads')
    vi.setSystemTime(NOW + 60_001)
    await t.mutation(purge, { demo_id: receipt.id })
    expect(await t.run((ctx) => ctx.db.get(receipt._id))).not.toBeNull()
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await t.run((ctx) => ctx.db.get(receipt._id))).toBeNull()
  })

  it('recovers abandoned identities and stalled cleanup without touching a live demo', async () => {
    const t = testBackend()
    const abandoned = await makeDemo(t, false)
    // a visitor who left while the demo was being built
    const halfway = await makeDemo(t, 5)
    expect(halfway).toMatchObject({ status: 'unprovisioned', provision: { step: 5 } })
    const stalled = await makeDemo(t, false)
    const live = await makeDemo(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(abandoned._id, { expires_at: NOW - 1 })
      await ctx.db.patch(halfway._id, { expires_at: NOW - 1 })
      await ctx.db.patch(stalled._id, {
        status: 'deleting',
        cleanup_phase: 'tasks',
        cleanup_progress_at: NOW - 120_000,
      })
    })
    await t.mutation(recover, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await t.run((ctx) => ctx.db.get(abandoned._id))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(halfway._id))).toBeNull()
    expect(await rows(t, halfway.org_id!)).toMatchObject({ org: null, profiles: [], tasks: [] })
    expect(await t.run((ctx) => ctx.db.get(stalled._id))).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(live._id))).not.toBeNull()
  })

  it('retires version 1 and 2 copies through owned cleanup while retaining newer and unprovisioned demos', async () => {
    const t = testBackend()
    const current = await makeDemo(t)
    const future = await makeDemo(t)
    const unprovisioned = await makeDemo(t, false)
    const unknown = await makeDemo(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(current._id, { seed_version: 3 })
      await ctx.db.patch(future._id, { seed_version: 4 })
      await ctx.db.patch(unknown._id, { seed_version: undefined })
    })
    const preserved = await ownedSnapshot(t)
    const previous = [await makeDemo(t), await makeDemo(t)]
    const files = await t.run(async (ctx) => {
      const ids = []
      for (const [index, receipt] of previous.entries()) {
        await ctx.db.patch(receipt._id, { seed_version: index + 1 })
        const profile = (await ctx.db
          .query('profiles')
          .withIndex('by_auth', (q) => q.eq('auth_user_id', receipt.auth_user_id))
          .unique())!
        const file = await ctx.storage.store(new Blob(['previous demo avatar']) as never)
        await ctx.db.patch(profile._id, { avatar_storage_id: file })
        ids.push(file)
        await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: 'session',
            data: {
              userId: receipt.auth_user_id,
              token: uuid(),
              createdAt: NOW,
              updatedAt: NOW,
              expiresAt: NOW + 86_400_000,
            },
          },
        })
      }
      return ids
    })
    await t.mutation(recover, {})
    for (const receipt of previous) {
      expect(await t.run((ctx) => ctx.db.get(receipt._id))).toMatchObject({
        expires_at: NOW,
      })
    }
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(await ownedSnapshot(t)).toEqual(preserved)
    for (const receipt of previous) {
      for (const model of ['user', 'session'] as const) {
        expect(
          await t.run((ctx) =>
            ctx.runQuery(components.betterAuth.adapter.findOne, {
              model,
              where: [{ field: model === 'user' ? '_id' : 'userId', value: receipt.auth_user_id }],
            }),
          ),
        ).toBeNull()
      }
    }
    expect(
      await t.run(async (ctx) => Promise.all(files.map((id) => ctx.db.system.get(id)))),
    ).toEqual([null, null])
    for (const receipt of [current, future, unprovisioned, unknown]) {
      expect(await t.run((ctx) => ctx.db.get(receipt._id))).toMatchObject({
        expires_at: NOW + 86_400_000,
      })
    }
  }, 60_000)

  it('bounds the refresh batch without hiding older versions behind current visitors', async () => {
    const t = testBackend()
    const previous = await t.run(async (ctx) => {
      const ids = []
      // Lifecycle-only fixtures isolate the selector and scheduling budget.
      // Current receipts deliberately sort before all the older copies.
      for (let index = 0; index < 70; index++) {
        const id = await ctx.db.insert('demo_sessions', {
          id: uuid(),
          auth_user_id: uuid(),
          status: 'ready',
          seed_version: index < 35 ? 3 : 2,
          created_at: NOW,
          expires_at: NOW + 1000 + index,
        })
        if (index >= 35) ids.push(id)
      }
      return ids
    })
    await t.mutation(recover, {})
    const first = await t.run(async (ctx) => Promise.all(previous.map((id) => ctx.db.get(id))))
    expect(first.filter((receipt) => receipt?.expires_at === NOW)).toHaveLength(32)
    await t.mutation(recover, {})
    const second = await t.run(async (ctx) => Promise.all(previous.map((id) => ctx.db.get(id))))
    expect(second.every((receipt) => receipt?.expires_at === NOW)).toBe(true)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('demo_sessions')
          .filter((q) => q.and(q.eq(q.field('seed_version'), 3), q.eq(q.field('expires_at'), NOW)))
          .collect(),
      ),
    ).toEqual([])
  })

  it('keeps normal deployments untouched and refuses a demo deployment on the main origin', async () => {
    const t = testBackend()
    const old = await makeDemo(t)
    await t.run((ctx) => ctx.db.patch(old._id, { seed_version: 2 }))
    const before = await ownedSnapshot(t)
    vi.stubEnv('APP_MODE', 'normal')
    await t.mutation(recover, {})
    expect(await ownedSnapshot(t)).toEqual(before)
    vi.stubEnv('APP_MODE', 'demo')
    vi.stubEnv('SITE_URL', 'https://qivo.io')
    await expectRefusal(t.mutation(recover, {}), 'forbidden', /main deployment/)
    expect(await ownedSnapshot(t)).toEqual(before)
  }, 30_000)

  it('does not delete live receipts or accept an unrelated organization in an ownership receipt', async () => {
    const t = testBackend()
    const receipt = await makeDemo(t)
    await t.mutation(purge, { demo_id: receipt.id })
    expect(await t.run((ctx) => ctx.db.get(receipt._id))).not.toBeNull()
    await t.run((ctx) => ctx.db.patch(receipt._id, { status: 'deleting', org_id: uuid() }))
    await expectRefusal(t.mutation(purge, { demo_id: receipt.id }), 'rule', /ownership mismatch/)
    expect(receipt.org_id).toBe(await marketingId(`public-demo:${receipt.id}`, 'org'))
  }, 30_000)
})
