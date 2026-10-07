import { makeFunctionReference } from 'convex/server'
import { describe, expect, it } from 'vitest'
import {
  ORG_EXPORT_SECTIONS,
  type OrgExportPage,
  type OrgExportRow,
  type OrgExportSection,
} from '../lib/orgExport'
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

declare class Blob {
  constructor(parts: unknown[], options?: { type?: string })
}

const page = makeFunctionReference<
  'query',
  { org_id: string; section: OrgExportSection; parent_id?: string; cursor: string | null },
  OrgExportPage
>('orgExport:page')

/* Personal surfaces retain their existing owner-only permissions. Account,
 * authentication, operations and shared background data do not belong to an
 * organization. New tables require an explicit export ownership decision. */
const EXCLUDED_TABLES = [
  'webhook_workers', // shared worker reservations are operational state
  'demo_sessions',
  'demo_uploads',
  'demo_admission',
  // Deployment-wide anonymous statistics and sampler progress have no org owner.
  'demo_metrics',
  'demo_metrics_daily',
  'demo_metric_reports',
  'demo_metrics_scans',
  // Expiring undo receipts belong to a login and can span organizations.
  // They are internal capabilities, never organization export content.
  'roadmap_history',
  'account_appearance',
  'custom_backgrounds',
  'background_uploads',
  'marketing_demo',
  'issue_subscriptions',
  'messages',
  'user_prefs',
  'mcp_tokens',
  // Personal callback destinations and encrypted secrets are not portable work.
  'webhook_events',
  'webhook_health',
  'webhook_subscriptions',
  'webhook_deliveries',
  'oauth_connections',
  'oauth_credential_uses',
  'panorama_images',
  'panorama_calendar',
  'panorama_curation_keys',
  'panorama_submissions',
  'panorama_library',
  'panorama_refills',
  'platform_admins',
  'platform_audit_log',
  // The portable work archive excludes the platform catalog and operational
  // billing ledgers: provider/customer IDs, checkout URLs, delivery state and
  // credential usage identifiers stay on their scoped billing surfaces.
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
] as const

async function readAll(
  caller: ReturnType<T['withIdentity']>,
  orgId: string,
  section: OrgExportSection,
  parentId?: string,
): Promise<OrgExportRow[]> {
  const rows: OrgExportRow[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 100; guard++) {
    const result: OrgExportPage = await caller.query(page, {
      org_id: orgId,
      section,
      ...(parentId === undefined ? {} : { parent_id: parentId }),
      cursor,
    })
    rows.push(...result.rows)
    if (result.isDone) return rows
    expect(result.continueCursor).not.toBe(cursor)
    cursor = result.continueCursor
  }
  throw new Error('export pagination did not finish')
}

describe('organization export', () => {
  it('classifies every schema table, with parent tables visited first', () => {
    const sections = Object.keys(ORG_EXPORT_SECTIONS)
    const classified = [...sections, ...EXCLUDED_TABLES]
    expect(new Set(classified).size).toBe(classified.length)
    expect(classified.sort()).toEqual(Object.keys(schema.tables).sort())
    for (const [index, section] of sections.entries()) {
      const parent = ORG_EXPORT_SECTIONS[section as OrgExportSection]
      if (parent !== null) expect(sections.indexOf(parent)).toBeLessThan(index)
    }
  })

  it('requires an active admin in the requested organization on every page', async () => {
    const t = newT()
    const f = await withOrg(t)
    const args = { org_id: f.org.id, section: 'profiles' as const, cursor: null }
    await expectRefusal(t.query(page, args), 'forbidden', /not signed in/)
    for (const profile of [f.user, f.viewer, f.guest]) {
      await expectRefusal(as(t, profile).query(page, args), 'forbidden', /organization admins/)
    }
    await expectRefusal(as(t, f.otherAdmin).query(page, args), 'forbidden', /no profile/)
    const caller = as(t, f.admin)
    expect((await caller.query(page, args)).rows.length).toBeGreaterThan(0)
    await t.run(async (ctx) => await ctx.db.patch(f.admin._id, { active: false }))
    await expectRefusal(caller.query(page, args), 'forbidden', /no profile/)
  })

  it('exports every org-owned section including archived work, files, and safe key metadata', async () => {
    const t = newT()
    const f = await withOrg(t)
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Former colleague',
      active: false,
    })
    const unclaimed = await plantSeat(t, { org_id: f.org.id, name: 'Invited colleague' })
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      archived_at: NOW,
      description: '<p>Archived description</p>',
    })
    const target = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const ids = await t.run(async (ctx) => {
      await ctx.db.patch(f.sub._id, { archived_at: NOW })
      const storageId = await ctx.storage.store(new Blob(['file contents']) as never)
      const avatarId = await ctx.storage.store(new Blob(['portrait']) as never)
      await ctx.db.patch(f.admin._id, { avatar_storage_id: avatarId, message_retention_days: 30 })
      const labelId = uuid()
      await ctx.db.insert('labels', {
        id: labelId,
        org_id: f.org.id,
        name: 'Export me',
        name_lower: 'export me',
        color: '#fff',
        created_at: NOW,
      })
      await ctx.db.insert('issue_labels', {
        org_id: task.org_id,
        issue_id: task.id,
        label_id: labelId,
      })
      const attachmentId = uuid()
      await ctx.db.insert('issue_attachments', {
        org_id: task.org_id,
        id: attachmentId,
        issue_id: task.id,
        name: 'evidence.txt',
        size_bytes: 13,
        mime: 'text/plain',
        storage_id: storageId,
        inline: true,
        uploaded_by: f.admin.id,
        created_at: NOW,
      })
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        author: f.admin.id,
        body: '<p>Remember this.</p>',
        created_at: NOW,
      })
      const linkId = uuid()
      await ctx.db.insert('issue_links', {
        org_id: task.org_id,
        id: linkId,
        source_id: task.id,
        target_id: target.id,
        type: 'blocks',
        pair_key: [task.id, target.id].sort().join(':'),
        created_at: NOW,
      })
      await ctx.db.insert('milestones', {
        id: uuid(),
        project_id: f.sub.id,
        name: 'Past milestone',
        week: '2026-01-05',
        created_at: NOW,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: f.team.id,
        level: 'user',
      })
      await ctx.db.insert('activity_events', {
        id: uuid(),
        org_id: f.org.id,
        ts: NOW,
        verb: 'created',
        target_type: 'issue',
        target_id: task.id,
        label: task.title,
        project_id: f.sub.id,
      })
      const keyId = uuid()
      await ctx.db.insert('agent_keys', {
        id: keyId,
        profile_id: f.agent.id,
        name: 'Automation',
        key_prefix: 'qva_ab...cd',
        key_hash: 'a'.repeat(64),
        created_by: f.admin.id,
        created_at: NOW,
        revoked_at: NOW,
      })
      return { storageId, avatarId, attachmentId, linkId, keyId }
    })
    const caller = as(t, f.admin)
    const exported = {} as Record<OrgExportSection, OrgExportRow[]>
    for (const section of Object.keys(ORG_EXPORT_SECTIONS) as OrgExportSection[]) {
      const parent = ORG_EXPORT_SECTIONS[section]
      exported[section] =
        parent === null
          ? await readAll(caller, f.org.id, section)
          : (
              await Promise.all(
                exported[parent].map((row) => readAll(caller, f.org.id, section, row.id as string)),
              )
            ).flat()
      expect(exported[section].length, section).toBeGreaterThan(0)
      for (const row of exported[section]) {
        expect(row).not.toHaveProperty('_id')
        expect(row).not.toHaveProperty('_creationTime')
        expect(row).not.toHaveProperty('auth_user_id')
        expect(row).not.toHaveProperty('message_retention_days')
        expect(row).not.toHaveProperty('key_hash')
      }
    }
    expect(exported.organizations).toHaveLength(1)
    expect(exported.organizations[0]).toMatchObject({ id: f.org.id, billing: f.org.billing })
    expect(exported.projects.find((row) => row.id === f.sub.id)).toMatchObject({ archived_at: NOW })
    expect(exported.issues.find((row) => row.id === task.id)).toMatchObject({
      archived_at: NOW,
      description: task.description,
    })
    expect(exported.profiles.map((row) => row.id)).toEqual(
      expect.arrayContaining([inactive.id, unclaimed.id, f.agent.id]),
    )
    expect(exported.profiles.find((row) => row.id === f.admin.id)).toHaveProperty(
      'avatar_storage_id',
      ids.avatarId,
    )
    expect(exported.issue_attachments[0]).toMatchObject({
      id: ids.attachmentId,
      storage_id: ids.storageId,
      inline: true,
    })
    expect(exported.issue_links).toHaveLength(1)
    expect(exported.issue_links[0].id).toBe(ids.linkId)
    expect(exported.agent_keys[0]).toMatchObject({
      id: ids.keyId,
      key_prefix: 'qva_ab...cd',
      revoked_at: NOW,
    })
    expect(exported.comments[0].body).toBe('<p>Remember this.</p>')
    expect(JSON.stringify(exported)).not.toContain(f.otherOrg.id)
    expect(JSON.stringify(exported)).not.toContain(f.admin.auth_user_id)
  })

  it('requires owned parents and refuses malformed section scopes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const foreignTask = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
    })
    const foreignTeam = await t.run(async (ctx) => {
      const id = uuid()
      const { _id, _creationTime, ...team } = f.team
      await ctx.db.insert('teams', { ...team, id, org_id: f.otherOrg.id })
      return id
    })
    const caller = as(t, f.admin)
    const foreignParents = {
      teams: foreignTeam,
      profiles: f.otherAdmin.id,
      projects: f.otherProject.id,
      issues: foreignTask.id,
    }
    for (const section of Object.keys(ORG_EXPORT_SECTIONS) as OrgExportSection[]) {
      const parent = ORG_EXPORT_SECTIONS[section]
      if (parent === null) continue
      await expectRefusal(
        caller.query(page, { org_id: f.org.id, section, cursor: null }),
        'bad_request',
        /requires a parent/,
      )
      for (const parentId of [uuid(), foreignParents[parent]]) {
        await expectRefusal(
          caller.query(page, { org_id: f.org.id, section, parent_id: parentId, cursor: null }),
          'not_found',
          /export parent/,
        )
      }
    }
    await expectRefusal(
      caller.query(page, {
        org_id: f.org.id,
        section: 'issues',
        parent_id: f.sub.id,
        cursor: null,
      }),
      'bad_request',
      /does not take a parent/,
    )
  })

  it('does not disclose foreign endpoints through damaged membership, grant, label, or issue links', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const foreignTask = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
    })
    await t.run(async (ctx) => {
      const labelId = uuid()
      await ctx.db.insert('labels', {
        id: labelId,
        org_id: f.otherOrg.id,
        name: 'Private',
        name_lower: 'private',
        color: '#fff',
        created_at: NOW,
      })
      await ctx.db.insert('issue_labels', {
        org_id: task.org_id,
        issue_id: task.id,
        label_id: labelId,
      })
      await ctx.db.insert('issue_links', {
        org_id: task.org_id,
        id: uuid(),
        source_id: task.id,
        target_id: foreignTask.id,
        type: 'blocks',
        pair_key: [task.id, foreignTask.id].sort().join(':'),
        created_at: NOW,
      })
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: f.otherAdmin.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: f.otherAdmin.id,
        is_leader: true,
      })
      const teamId = uuid()
      const { _id, _creationTime, ...team } = f.team
      await ctx.db.insert('teams', { ...team, id: teamId, org_id: f.otherOrg.id })
      await ctx.db.insert('project_team_access', {
        project_id: f.meta.id,
        team_id: teamId,
        level: 'user',
      })
    })
    const caller = as(t, f.admin)
    for (const [section, parentId] of [
      ['issue_labels', task.id],
      ['issue_links', task.id],
      ['project_access', f.sub.id],
      ['project_team_access', f.meta.id],
    ] as const) {
      expect(await readAll(caller, f.org.id, section, parentId)).toEqual([])
    }
    expect(
      (await readAll(caller, f.org.id, 'team_members', f.team.id)).map((row) => row.profile_id),
    ).not.toContain(f.otherAdmin.id)
  })

  it('paginates all retained history beyond the snapshot cap and rechecks demotion mid-export', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      for (let index = 0; index < 603; index++) {
        await ctx.db.insert('activity_events', {
          id: `event-${index}`,
          org_id: f.org.id,
          ts: new Date(Date.parse(NOW) + index).toISOString(),
          verb: 'created',
          target_type: 'project',
          target_id: f.meta.id,
          label: `Event ${index}`,
        })
      }
      await ctx.db.insert('activity_events', {
        id: 'foreign-event',
        org_id: f.otherOrg.id,
        ts: NOW,
        verb: 'created',
        target_type: 'project',
        target_id: f.otherProject.id,
        label: 'Foreign event',
      })
    })
    const caller = as(t, f.admin)
    const args = { org_id: f.org.id, section: 'activity_events' as const, cursor: null }
    const first = await caller.query(page, args)
    expect(first.rows).toHaveLength(100)
    expect(first.isDone).toBe(false)
    const all = await readAll(caller, f.org.id, 'activity_events')
    expect(all).toHaveLength(603)
    expect(new Set(all.map((row) => row.id)).size).toBe(603)
    expect(all.map((row) => row.id)).not.toContain('foreign-event')
    await t.run(async (ctx) => await ctx.db.patch(f.admin._id, { org_role: 'user' }))
    await expectRefusal(
      caller.query(page, { ...args, cursor: first.continueCursor }),
      'forbidden',
      /organization admins/,
    )
    await expectRefusal(
      t.query(page, { ...args, cursor: first.continueCursor }),
      'forbidden',
      /not signed in/,
    )
  })
})
