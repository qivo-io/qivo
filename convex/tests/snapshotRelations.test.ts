import { describe, expect, it } from 'vitest'
import { invokeSnapshot } from './backendPerformance.setup'
import { as, NOW, newT, withOrg } from './helpers.setup'

describe('snapshot bulk relation reads', () => {
  it('matches selective reads exactly, including ordering, permissions, archives and hidden load', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { next_issue_num: 64 })
      const storage_id = await ctx.storage.store(new Blob() as never)
      await ctx.db.patch(f.sub2._id, { archived_at: NOW })
      for (let i = 0; i < 64; i++) {
        const id = `task-${i}`
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          project_id: i === 1 ? f.sub2.id : i % 8 ? f.sub.id : f.hidden.id,
          num: i + 1,
          title: id,
          description: '',
          status: 'progress',
          priority: 'medium',
          paused: false,
          assignee_id: f.user.id,
          remaining_hours: 8,
          start_week: '2026-01-05',
          end_week: '2026-01-12',
          archived_at: i === 2 ? NOW : undefined,
          parent_id: i === 0 ? 'task-3' : undefined,
          created_at: NOW,
          updated_at: NOW,
        })
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: id,
          label_id: `label-${i}`,
        })
        if (i % 4 === 0)
          await ctx.db.insert('issue_attachments', {
            id: `attachment-${i}`,
            org_id: f.org.id,
            issue_id: id,
            storage_id,
            name: 'x',
            size_bytes: 1,
            inline: false,
            created_at: NOW,
          })
        if (i > 0)
          await ctx.db.insert('issue_links', {
            id: `link-${i}`,
            org_id: f.org.id,
            source_id: id,
            target_id: `task-${i - 1}`,
            type: 'blocks',
            pair_key: `${i}:${i - 1}`,
            created_at: NOW,
          })
      }
      await ctx.db.insert('issue_labels', {
        org_id: f.otherOrg.id,
        issue_id: 'foreign',
        label_id: 'secret',
      })
    })
    const read = (profile: typeof f.admin) =>
      as(t, profile).query(async (ctx) => ({
        snapshot: await invokeSnapshot(ctx),
        metrics: await ctx.meta.getTransactionMetrics(),
      }))
    for (const profile of [f.admin, f.guest, f.viewer]) {
      const bulk = await read(profile)
      await t.run(async (ctx) => ctx.db.patch(f.org._id, { next_issue_num: 10000 }))
      const selective = await read(profile)
      for (const org of selective.snapshot!.orgs) {
        if (org.id === f.org.id) org.next_issue_num = 64
      }
      expect(bulk.snapshot).toEqual(selective.snapshot)
      expect(bulk.metrics.databaseQueries.used).toBeLessThan(
        selective.metrics.databaseQueries.used / 2,
      )
      expect(bulk.snapshot!.issueLabels.some((row) => row.label_id === 'secret')).toBe(false)
      expect(
        bulk.snapshot!.links.some(
          (row) => row.source_id === 'task-2' || row.target_id === 'task-2',
        ),
      ).toBe(false)
      await t.run(async (ctx) => ctx.db.patch(f.org._id, { next_issue_num: 64 }))
    }
    const scoped = await read(f.admin)
    const legacyRows = await t.run(async (ctx) => {
      const ids = []
      for (const table of ['issue_links', 'issue_labels', 'issue_attachments'] as const) {
        const row = (await ctx.db
          .query(table)
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .first())!
        ids.push(row._id)
        await ctx.db.patch(row._id, { org_id: undefined })
      }
      return ids
    })
    const legacy = await read(f.admin)
    expect(legacy.snapshot).toEqual(scoped.snapshot)
    expect(legacy.metrics.databaseQueries.used).toBeGreaterThan(scoped.metrics.databaseQueries.used)
    await t.run(async (ctx) => {
      for (const id of legacyRows) await ctx.db.patch(id, { org_id: f.org.id })
      // Unscoped data in another org must also safely select the fallback.
      await ctx.db.insert('issue_labels', { issue_id: 'foreign', label_id: 'legacy-secret' })
      await ctx.db.insert('issue_links', {
        id: 'foreign-link',
        source_id: 'foreign',
        target_id: 'foreign-peer',
        type: 'blocks',
        pair_key: 'foreign:foreign-peer',
        created_at: NOW,
      })
      const storage_id = await ctx.storage.store(new Blob() as never)
      await ctx.db.insert('issue_attachments', {
        id: 'foreign-file',
        issue_id: 'foreign',
        storage_id,
        name: 'secret',
        size_bytes: 0,
        inline: false,
        created_at: NOW,
      })
    })
    const foreignLegacy = await read(f.admin)
    expect(foreignLegacy.snapshot).toEqual(scoped.snapshot)
    expect(foreignLegacy.metrics.databaseQueries.used).toBe(legacy.metrics.databaseQueries.used)
  })

  it('falls back for dense relation tables without truncating them', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      await ctx.db.patch(f.org._id, { next_issue_num: 32 })
      for (let i = 0; i < 32; i++) {
        await ctx.db.insert('issues', {
          id: `task-${i}`,
          org_id: f.org.id,
          project_id: f.sub.id,
          num: i + 1,
          title: 'Task',
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
      }
      for (let i = 0; i < 100; i++)
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: 'task-0',
          label_id: `label-${i}`,
        })
    })
    const snapshot = await as(t, f.admin).query(async (ctx) => invokeSnapshot(ctx))
    expect(snapshot!.issueLabels.map((row) => row.label_id)).toEqual(
      Array.from({ length: 100 }, (_, i) => `label-${i}`),
    )
  })
})
