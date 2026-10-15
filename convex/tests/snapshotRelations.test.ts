import { afterEach, describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { SELECTIVE_READ } from '../lib/snapshotRelations'
import { invokeSnapshot } from './backendPerformance.setup'
import { as, NOW, newT, type T, withOrg } from './helpers.setup'

/* Two reads differ in their delivery time; everything else must match. */
const sameDelivery = <S extends { delivered_at: string } | null>(snapshot: S): S =>
  snapshot === null ? snapshot : { ...snapshot, delivered_at: '' }

const DEFAULT_READ = { ...SELECTIVE_READ }
afterEach(() => {
  Object.assign(SELECTIVE_READ, DEFAULT_READ)
})

/* Every view counts as larger than SELECTIVE_READ.tasks and reads in bulk. */
const ALL_BULK = { tasks: 0, ratio: DEFAULT_READ.ratio }
/* Every view reads task by task. */
const ALL_SELECTIVE = { tasks: Number.POSITIVE_INFINITY, ratio: 0 }

/* The caller's snapshot with the transaction's read counts. */
const read = (t: T, profile: Doc<'profiles'>) =>
  as(t, profile).query(async (ctx) => ({
    snapshot: await invokeSnapshot(ctx),
    metrics: await ctx.meta.getTransactionMetrics(),
  }))

/* The same read with SELECTIVE_READ set to `rule` for its duration. */
const readWith = async (t: T, profile: Doc<'profiles'>, rule: typeof DEFAULT_READ) => {
  Object.assign(SELECTIVE_READ, rule)
  try {
    return await read(t, profile)
  } finally {
    Object.assign(SELECTIVE_READ, DEFAULT_READ)
  }
}

/* `count` active tasks, task-0 onward, in the project `project` picks. */
const plantTasks = (t: T, orgId: string, project: (i: number) => string, count: number) =>
  t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert('issues', {
        id: `task-${i}`,
        org_id: orgId,
        project_id: project(i),
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
  })

describe('snapshot bulk relation reads', () => {
  it('match selective reads exactly, including ordering, permissions, archives, marks and hidden load', async () => {
    const t = newT()
    const f = await withOrg(t)
    await t.run(async (ctx) => {
      const storage_id = await ctx.storage.store(new Blob() as never)
      await ctx.db.patch(f.sub2._id, { archived_at: NOW })
      for (let i = 0; i < 64; i++) {
        const id = `task-${i}`
        // task-2 is archived. Its label and its link from task-3 carry the
        // mark the archive step leaves; its link to task-1 and its attachment
        // are unmarked, as rows stored before marks existed are.
        const archived = i === 2
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
          archived_at: archived ? NOW : undefined,
          parent_id: i === 0 ? 'task-3' : undefined,
          created_at: NOW,
          updated_at: NOW,
        })
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: id,
          label_id: `label-${i}`,
          task_archived: archived ? true : undefined,
        })
        if (i % 4 === 0 || archived)
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
            task_archived: i === 3 ? true : undefined,
          })
      }
      await ctx.db.insert('issue_labels', {
        org_id: f.otherOrg.id,
        issue_id: 'foreign',
        label_id: 'secret',
      })
    })
    for (const profile of [f.admin, f.guest, f.viewer]) {
      const usual = await read(t, profile)
      const bulk = await readWith(t, profile, ALL_BULK)
      const selective = await readWith(t, profile, ALL_SELECTIVE)
      expect(sameDelivery(usual.snapshot)).toEqual(sameDelivery(selective.snapshot))
      expect(sameDelivery(bulk.snapshot)).toEqual(sameDelivery(selective.snapshot))
      // every view here holds at least half the active tasks, so it reads in bulk
      expect(usual.metrics.databaseQueries.used).toBe(bulk.metrics.databaseQueries.used)
      expect(bulk.metrics.databaseQueries.used).toBeLessThan(
        selective.metrics.databaseQueries.used / 2,
      )
      const rows = bulk.snapshot!
      expect(rows.issueLabels.some((row) => row.label_id === 'secret')).toBe(false)
      expect(rows.issueLabels.some((row) => row.issue_id === 'task-2')).toBe(false)
      expect(rows.attachments.some((row) => row.issue_id === 'task-2')).toBe(false)
      expect(
        rows.links.some((row) => row.source_id === 'task-2' || row.target_id === 'task-2'),
      ).toBe(false)
      // the mark and the organization id stay on the server
      for (const row of [...rows.links, ...rows.issueLabels, ...rows.attachments]) {
        expect(row).not.toHaveProperty('task_archived')
        expect(row).not.toHaveProperty('org_id')
      }
    }
    const scoped = await read(t, f.admin)
    const legacyRows = await t.run(async (ctx) => {
      const ids = []
      for (const table of ['issue_links', 'issue_labels', 'issue_attachments'] as const) {
        const row = (await ctx.db
          .query(table)
          .withIndex('by_org_task_archived', (q) =>
            q.eq('org_id', f.org.id).eq('task_archived', undefined),
          )
          .first())!
        ids.push(row._id)
        await ctx.db.patch(row._id, { org_id: undefined })
      }
      return ids
    })
    const legacy = await read(t, f.admin)
    expect(sameDelivery(legacy.snapshot)).toEqual(sameDelivery(scoped.snapshot))
    expect(legacy.metrics.databaseQueries.used).toBeGreaterThan(scoped.metrics.databaseQueries.used)
    await t.run(async (ctx) => {
      for (const id of legacyRows) await ctx.db.patch(id, { org_id: f.org.id })
      // A marked row without org_id belongs to an archived task, which no
      // view reads, so the bulk read stays.
      await ctx.db.insert('issue_labels', {
        issue_id: 'foreign-archived',
        label_id: 'legacy-archived',
        task_archived: true,
      })
    })
    const markedLegacy = await read(t, f.admin)
    expect(sameDelivery(markedLegacy.snapshot)).toEqual(sameDelivery(scoped.snapshot))
    expect(markedLegacy.metrics.databaseQueries.used).toBe(scoped.metrics.databaseQueries.used)
    await t.run(async (ctx) => {
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
    const foreignLegacy = await read(t, f.admin)
    expect(sameDelivery(foreignLegacy.snapshot)).toEqual(sameDelivery(scoped.snapshot))
    expect(foreignLegacy.metrics.databaseQueries.used).toBe(legacy.metrics.databaseQueries.used)
  })

  it('read a small view of a larger organization task by task, and a view past SELECTIVE_READ.tasks in bulk', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest is shown the four tasks in Firmware, not the 36 in Skunkworks
    await plantTasks(t, f.org.id, (i) => (i < 4 ? f.sub.id : f.hidden.id), 40)
    const usual = await read(t, f.guest)
    const bulk = await readWith(t, f.guest, ALL_BULK)
    const selective = await readWith(t, f.guest, ALL_SELECTIVE)
    expect(usual.snapshot!.issues).toHaveLength(4)
    expect(usual.metrics.databaseQueries.used).toBe(selective.metrics.databaseQueries.used)
    expect(usual.metrics.databaseQueries.used).not.toBe(bulk.metrics.databaseQueries.used)
    // the same view counts as large once the bound is below its size
    const large = await readWith(t, f.guest, { ...DEFAULT_READ, tasks: 3 })
    expect(large.metrics.databaseQueries.used).toBe(bulk.metrics.databaseQueries.used)
    expect(sameDelivery(large.snapshot)).toEqual(sameDelivery(usual.snapshot))
  })

  it('read a dense table task by task for a small view, and in full for a large one, never truncated', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f.org.id, () => f.sub.id, 32)
    // more rows in one table than BULK_ROWS_PER_TASK (8) per visible task
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++)
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: 'task-0',
          label_id: `label-${i}`,
        })
    })
    const labels = Array.from({ length: 300 }, (_, i) => `label-${i}`)
    const small = await read(t, f.admin)
    expect(small.snapshot!.issueLabels.map((row) => row.label_id)).toEqual(labels)
    // a view counted as large reads the table in full, with no cap and no
    // fallback costing a range per task
    const large = await readWith(t, f.admin, ALL_BULK)
    expect(large.snapshot!.issueLabels.map((row) => row.label_id)).toEqual(labels)
    expect(small.metrics.databaseQueries.used - large.metrics.databaseQueries.used).toBe(32)
  })
})

/* An organization with a long history, as the nightly sweep leaves it: 5,000
 * tasks created, 3,500 archived, and the 1,500 active ones visible to the
 * admin. Every task has two labels, a link to the one before it, an
 * attachment and the admin's follow. The rows of archived tasks carry the
 * mark the archive steps leave. */
const TOTAL = 5000
const ARCHIVED = 3500
const ACTIVE = TOTAL - ARCHIVED

async function plantHistory(t: T) {
  const f = await withOrg(t)
  const mark = (archived: boolean) => (archived ? true : undefined)
  const storage_id = await t.run((ctx) => ctx.storage.store(new Blob() as never))
  // 30 sub-projects under 3 metas, 20 teams of 3 with a team grant each
  const subs = await t.run(async (ctx) => {
    const ids: string[] = []
    for (let m = 0; m < 3; m++) {
      const meta = `meta-${m}`
      await ctx.db.insert('projects', {
        id: meta,
        org_id: f.org.id,
        type: 'meta',
        key: `M${m}`,
        name: meta,
        description: '',
        sort_order: 10 + m,
        num: 10 + m,
        track_delay: false,
        created_at: NOW,
      })
      for (let s = 0; s < 10; s++) {
        const id = `sub-${m}-${s}`
        ids.push(id)
        await ctx.db.insert('projects', {
          id,
          org_id: f.org.id,
          type: 'project',
          parent_id: meta,
          key: `S${m}${s}`,
          name: id,
          description: '',
          sort_order: 100 + ids.length,
          num: 100 + ids.length,
          track_delay: false,
          created_at: NOW,
        })
        await ctx.db.insert('project_access', {
          project_id: id,
          profile_id: f.user.id,
          level: 'user',
        })
      }
    }
    for (let i = 0; i < 20; i++) {
      const team = `team-${i}`
      await ctx.db.insert('teams', {
        id: team,
        org_id: f.org.id,
        name: team,
        stale_days: 14,
        archive_days: 30,
        track_delay_default: false,
        created_at: NOW,
      })
      for (const p of [f.admin, f.user, f.viewer])
        await ctx.db.insert('team_members', { team_id: team, profile_id: p.id, is_leader: false })
      await ctx.db.insert('project_team_access', {
        project_id: ids[i],
        team_id: team,
        level: 'viewer',
      })
    }
    for (let l = 0; l < 20; l++)
      await ctx.db.insert('labels', {
        id: `label-${l}`,
        org_id: f.org.id,
        name: `L${l}`,
        name_lower: `l${l}`,
        color: '#888888',
        created_at: NOW,
      })
    await ctx.db.patch(f.org._id, { next_issue_num: TOTAL + 1, activity_count: 500 })
    return ids
  })
  // in transactions of 500 tasks, under the write limit
  for (let from = 0; from < TOTAL; from += 500) {
    await t.run(async (ctx) => {
      for (let i = from; i < from + 500; i++) {
        const id = `task-${i}`
        const archived = i < ARCHIVED
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          project_id: subs[i % subs.length],
          num: i + 1,
          title: `Task ${i}`,
          description: 'A task description of ordinary length for the scale case.',
          status: archived ? 'done' : 'progress',
          priority: 'medium',
          paused: false,
          archived_at: archived ? NOW : undefined,
          created_at: NOW,
          updated_at: NOW,
        })
        for (const l of [i % 20, (i + 7) % 20])
          await ctx.db.insert('issue_labels', {
            org_id: f.org.id,
            issue_id: id,
            label_id: `label-${l}`,
            task_archived: mark(archived),
          })
        if (i > 0)
          await ctx.db.insert('issue_links', {
            id: `link-${i}`,
            org_id: f.org.id,
            source_id: id,
            target_id: `task-${i - 1}`,
            type: 'blocks',
            pair_key: `task-${i - 1}:${id}`,
            created_at: NOW,
            // the earlier end is archived whenever this one is
            task_archived: mark(i - 1 < ARCHIVED),
          })
        await ctx.db.insert('issue_attachments', {
          id: `file-${i}`,
          org_id: f.org.id,
          issue_id: id,
          name: 'spec.pdf',
          size_bytes: 1,
          storage_id,
          inline: false,
          uploaded_by: f.user.id,
          created_at: NOW,
          task_archived: mark(archived),
        })
        await ctx.db.insert('issue_subscriptions', {
          issue_id: id,
          profile_id: f.admin.id,
          created_at: NOW,
          task_archived: mark(archived),
        })
      }
    })
  }
  // 500 activity rows, 100 about distinct archived tasks, and 300 messages
  // for the admin, 100 about archived tasks
  await t.run(async (ctx) => {
    for (let i = 0; i < 500; i++) {
      const task = i % 5 === 0 ? i * 7 : ARCHIVED + (i % ACTIVE)
      await ctx.db.insert('activity_events', {
        id: `event-${i}`,
        org_id: f.org.id,
        actor_id: f.user.id,
        ts: new Date(Date.parse(NOW) + i * 1000).toISOString(),
        verb: 'updated',
        target_type: 'issue',
        target_id: `task-${task}`,
        label: 'Task',
        project_id: subs[task % subs.length],
      })
    }
    for (let i = 0; i < 300; i++) {
      const task = i % 3 === 0 ? i * 11 : ARCHIVED + i
      await ctx.db.insert('messages', {
        id: `message-${i}`,
        org_id: f.org.id,
        recipient_id: f.admin.id,
        actor_id: f.user.id,
        issue_id: `task-${task}`,
        issue_title: 'Task',
        kind: 'change',
        detail: 'Changed',
        created_at: NOW,
        read_at: i % 2 === 0 ? NOW : undefined,
      })
    }
  })
  return f
}

describe('the snapshot of an organization with a long archive', () => {
  it('loads for an admin within Convex transaction limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await plantHistory(t)
    const { snapshot, metrics } = await read(t, f.admin)
    expect(snapshot!.issues).toHaveLength(ACTIVE)
    expect(snapshot!.issueLabels).toHaveLength(2 * ACTIVE)
    // link-3500 joins the first active task to an archived one
    expect(snapshot!.links).toHaveLength(ACTIVE - 1)
    expect(snapshot!.attachments).toHaveLength(ACTIVE)
    expect(snapshot!.issueSubs).toHaveLength(ACTIVE)
    expect(snapshot!.activity).toHaveLength(400)
    expect(snapshot!.messages).toHaveLength(200)
    // The task-by-task read this replaced took four ranges per visible task,
    // over 6,000 here.
    expect(metrics.databaseQueries.used).toBeLessThan(400)
    expect(metrics.documentsRead.used).toBeLessThan(12_000)
  }, 120_000)
})
