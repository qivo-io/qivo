import { afterEach, describe, expect, it } from 'vitest'
import type { Doc } from '../_generated/dataModel'
import { RELATION_READ, snapshotRelations } from '../lib/snapshotRelations'
import { invokeSnapshot } from './backendPerformance.setup'
import { as, NOW, newT, type T, withOrg } from './helpers.setup'

/* Two reads differ in their delivery time; everything else must match. */
const sameDelivery = <S extends { delivered_at: string } | null>(snapshot: S): S =>
  snapshot === null ? snapshot : { ...snapshot, delivered_at: '' }

const DEFAULT_READ = { ...RELATION_READ }
afterEach(() => {
  Object.assign(RELATION_READ, DEFAULT_READ)
})

/* Every view reads each table in bulk and in full. */
const ALL_BULK = { ...DEFAULT_READ, tasks: 0, ranges: 0 }
/* Every view reads task by task, which is main's read for a view it did not
 * read in bulk. */
const ALL_SELECTIVE = { ...DEFAULT_READ, tasks: Number.POSITIVE_INFINITY, ratio: 0, ranges: 0 }

/* The caller's snapshot with the transaction's read counts. */
const read = (t: T, profile: Doc<'profiles'>) =>
  as(t, profile).query(async (ctx) => ({
    snapshot: await invokeSnapshot(ctx),
    metrics: await ctx.meta.getTransactionMetrics(),
  }))

/* The same read with RELATION_READ set to `rule` for its duration. */
const readWith = async (t: T, profile: Doc<'profiles'>, rule: typeof DEFAULT_READ) => {
  Object.assign(RELATION_READ, rule)
  try {
    return await read(t, profile)
  } finally {
    Object.assign(RELATION_READ, DEFAULT_READ)
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
        // are unmarked, as rows stored before marks existed are. task-12 was
        // restored and its marks are not cleared yet: its label, its links
        // with task-11 and task-13, and a link from task-4 are still marked.
        const archived = i === 2
        const restored = i === 12
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
          relations_marked: archived || restored ? true : undefined,
          parent_id: i === 0 ? 'task-3' : undefined,
          created_at: NOW,
          updated_at: NOW,
        })
        await ctx.db.insert('issue_labels', {
          org_id: f.org.id,
          issue_id: id,
          label_id: `label-${i}`,
          task_archived: archived || restored ? true : undefined,
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
            task_archived: i === 3 || i === 12 || i === 13 ? true : undefined,
          })
        if (restored)
          await ctx.db.insert('issue_links', {
            id: 'link-4-12',
            org_id: f.org.id,
            source_id: 'task-4',
            target_id: id,
            type: 'relates',
            pair_key: 'task-12:task-4',
            created_at: NOW,
            task_archived: true,
          })
      }
      // Two more links to task-20, the later one from the task whose id sorts
      // first, so the org-wide read (by source) and task-20's own index (by
      // creation) list them in different orders.
      for (const source of ['task-30', 'task-25'])
        await ctx.db.insert('issue_links', {
          id: `link-${source}-20`,
          org_id: f.org.id,
          source_id: source,
          target_id: 'task-20',
          type: 'relates',
          pair_key: `task-20:${source}`,
          created_at: NOW,
        })
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
      // every view here holds at least half the active tasks, so it reads in
      // bulk, and every table fits its cap
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
      // the restored task's marked rows are back
      expect(rows.issues.some((row) => row.id === 'task-12')).toBe(true)
      expect(rows.issueLabels.some((row) => row.issue_id === 'task-12')).toBe(true)
      expect(rows.links.map((row) => row.id)).toEqual(
        expect.arrayContaining(['link-12', 'link-13', 'link-4-12']),
      )
      for (const row of rows.issues) expect(row).not.toHaveProperty('relations_marked')
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
        const row = (await (table === 'issue_links'
          ? ctx.db
              .query(table)
              .withIndex('by_org_task_archived_source', (q) =>
                q.eq('org_id', f.org.id).eq('task_archived', undefined),
              )
          : ctx.db
              .query(table)
              .withIndex('by_org_task_archived_issue', (q) =>
                q.eq('org_id', f.org.id).eq('task_archived', undefined),
              )
        ).first())!
        ids.push(row._id)
        await ctx.db.patch(row._id, { org_id: undefined })
      }
      return ids
    })
    // the view's own rows without org_id join the bulk reads, and more of
    // them than RELATION_READ.legacy send a table task by task
    const legacy = await read(t, f.admin)
    expect(sameDelivery(legacy.snapshot)).toEqual(sameDelivery(scoped.snapshot))
    expect(legacy.metrics.databaseQueries.used).toBe(scoped.metrics.databaseQueries.used)
    const overflow = await readWith(t, f.admin, { ...DEFAULT_READ, legacy: 0 })
    expect(sameDelivery(overflow.snapshot)).toEqual(sameDelivery(scoped.snapshot))
    expect(overflow.metrics.databaseQueries.used).toBeGreaterThan(
      scoped.metrics.databaseQueries.used,
    )
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
      // Rows without org_id of another organization's tasks, or of tasks
      // that are gone, stay out of the view and keep the bulk reads.
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
    expect(foreignLegacy.metrics.databaseQueries.used).toBe(scoped.metrics.databaseQueries.used)
  })

  it('read a small view of a larger organization task by task, and a larger one in bulk', async () => {
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
    // the same view reads in bulk once it counts as larger than `tasks`
    const large = await readWith(t, f.guest, { ...DEFAULT_READ, tasks: 3 })
    expect(large.metrics.databaseQueries.used).toBe(bulk.metrics.databaseQueries.used)
    expect(sameDelivery(large.snapshot)).toEqual(sameDelivery(usual.snapshot))
  })

  it('read a dense table task by task for a small view, and in full for a large one, never truncated', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantTasks(t, f.org.id, () => f.sub.id, 32)
    // more rows in one table than BULK_ROWS_PER_RANGE (4) per range its
    // task-by-task read costs
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
    // without ranges to spend task by task the table is read in full: its
    // probe and full read replace the capped read and 32 ranges task by task
    const large = await readWith(t, f.admin, ALL_BULK)
    expect(large.snapshot!.issueLabels.map((row) => row.label_id)).toEqual(labels)
    expect(small.metrics.databaseQueries.used - large.metrics.databaseQueries.used).toBe(31)
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
    expect(snapshot!.messages).toHaveLength(200)
    // The task-by-task read this replaced took four ranges per visible task,
    // over 6,000 here. The read takes 230 now; the activity feed it no
    // longer reads took 331.
    expect(metrics.databaseQueries.used).toBeLessThan(300)
    expect(metrics.documentsRead.used).toBeLessThan(12_000)
  }, 120_000)
})

/* `total` active tasks, the first `visible` in Firmware, which the guest
 * sees, the rest in Skunkworks, which they do not. Each task has `labels`
 * labels, `attachments` attachments, and a link to each of up to `links`
 * tasks before it. */
async function plantDense(
  t: T,
  a: { total: number; visible: number; labels: number; links: number; attachments?: number },
) {
  const f = await withOrg(t)
  const storage_id = await t.run((ctx) => ctx.storage.store(new Blob() as never))
  const chunk = Math.floor(3000 / (a.labels + a.links + (a.attachments ?? 0) + 1))
  for (let from = 0; from < a.total; from += chunk) {
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(from + chunk, a.total); i++) {
        const id = `task-${i}`
        await ctx.db.insert('issues', {
          id,
          org_id: f.org.id,
          project_id: i < a.visible ? f.sub.id : f.hidden.id,
          num: i + 1,
          title: `Task ${i}`,
          description: '',
          status: 'progress',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
        for (let l = 0; l < a.labels; l++)
          await ctx.db.insert('issue_labels', {
            org_id: f.org.id,
            issue_id: id,
            label_id: `label-${l}`,
          })
        for (let back = 1; back <= Math.min(a.links, i); back++)
          await ctx.db.insert('issue_links', {
            id: `link-${i}-${back}`,
            org_id: f.org.id,
            source_id: id,
            target_id: `task-${i - back}`,
            type: 'blocks',
            pair_key: `task-${i - back}:${id}`,
            created_at: NOW,
          })
        for (let n = 0; n < (a.attachments ?? 0); n++)
          await ctx.db.insert('issue_attachments', {
            id: `file-${i}-${n}`,
            org_id: f.org.id,
            issue_id: id,
            name: 'spec.pdf',
            size_bytes: 1,
            storage_id,
            inline: false,
            created_at: NOW,
          })
      }
    })
  }
  await t.run((ctx) => ctx.db.patch(f.org._id, { next_issue_num: a.total + 1 }))
  return f
}

/* These organizations are a tenth of the size the rules are for, with
 * Convex's document limit and RELATION_READ.tasks (512) lowered to match, so
 * the reads take the same paths in a tenth of the time. */
const TENTH = { transactionLimits: { documentsRead: 3200 } }

describe('the snapshot of a restricted view in a dense organization', () => {
  it('reads 30 of 600 active tasks with five labels each task by task, within limits', async () => {
    const t = newT(TENTH)
    const f = await plantDense(t, { total: 600, visible: 30, labels: 5, links: 0 })
    const { snapshot, metrics } = await read(t, f.guest)
    expect(snapshot!.issues).toHaveLength(30)
    expect(snapshot!.issueLabels).toHaveLength(150)
    // four ranges per visible task, not the 3,000 labels of the whole org
    expect(metrics.databaseQueries.used).toBeGreaterThanOrEqual(120)
    expect(metrics.databaseQueries.used).toBeLessThan(220)
    expect(metrics.documentsRead.used).toBeLessThan(1000)
  })

  it('reads a dense table task by task and the others in bulk for 60 of 200 tasks, within limits', async () => {
    Object.assign(RELATION_READ, { tasks: 51 })
    const t = newT(TENTH)
    const f = await plantDense(t, { total: 200, visible: 60, labels: 15, links: 1 })
    const { snapshot, metrics } = await read(t, f.guest)
    expect(snapshot!.issues).toHaveLength(60)
    expect(snapshot!.issueLabels).toHaveLength(900)
    expect(snapshot!.links).toHaveLength(59)
    // the labels, over their cap, are read task by task, 60 ranges, and the
    // links stay in bulk, where task by task would add 120
    expect(metrics.databaseQueries.used).toBeGreaterThanOrEqual(60)
    expect(metrics.databaseQueries.used).toBeLessThan(160)
    expect(metrics.documentsRead.used).toBeLessThan(2000)
  })

  it('reads all three tables task by task when each is over its cap, at most 3 ranges above main', async () => {
    Object.assign(RELATION_READ, { tasks: 51 })
    const t = newT(TENTH)
    const f = await plantDense(t, {
      total: 200,
      visible: 60,
      labels: 2,
      attachments: 2,
      links: 3,
    })
    const usual = await read(t, f.guest)
    // main read this view task by task, as the forced read does
    const main = await readWith(t, f.guest, ALL_SELECTIVE)
    expect(sameDelivery(usual.snapshot)).toEqual(sameDelivery(main.snapshot))
    expect(usual.snapshot!.issueLabels).toHaveLength(120)
    expect(usual.snapshot!.attachments).toHaveLength(120)
    // each table first tried its capped bulk read, then read like main
    expect(usual.metrics.databaseQueries.used).toBe(main.metrics.databaseQueries.used + 3)
    expect(usual.metrics.documentsRead.used).toBeLessThan(2000)
  })

  it('reads a dense table task by task for a view of more than 1,024 tasks while those reads fit the range limit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await plantDense(t, { total: 1100, visible: 1100, labels: 5, links: 0 })
    const { snapshot, metrics } = await read(t, f.guest)
    expect(snapshot!.issueLabels).toHaveLength(5500)
    // the labels are over their cap of 4 per task, and 1,100 ranges task by
    // task still fit, so they are read as main read them, not in full
    expect(metrics.databaseQueries.used).toBeGreaterThanOrEqual(1100)
    expect(metrics.databaseQueries.used).toBeLessThan(1200)
    const full = await readWith(t, f.guest, { ...DEFAULT_READ, ranges: 0 })
    expect(full.metrics.databaseQueries.used).toBeLessThan(100)
  }, 120_000)
})

describe('the relation reads of a snapshot that has used most of its ranges', () => {
  /* The labels of 40 visible tasks, all live so the tables decide, read
   * with `left` ranges left, and the ranges the relation reads used. The
   * labels are over their cap, so task by task they cost 40 ranges, and the
   * table reads take up to 6 more. */
  async function readLeaving(left: number) {
    const t = newT({ transactionLimits: true })
    const f = await plantDense(t, { total: 40, visible: 40, labels: 5, links: 0 })
    return await t.run(async (ctx) => {
      const tasks = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
      // earlier reads, as of another organization
      const before = await ctx.meta.getTransactionMetrics()
      for (let i = 0; i < before.databaseQueries.remaining - left; i++)
        await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', `none-${i}`))
          .first()
      const start = (await ctx.meta.getTransactionMetrics()).databaseQueries.used
      const rows = await snapshotRelations(ctx, { orgId: f.org.id, tasks, active: tasks.length })
      let labels = 0
      for (const task of tasks) labels += (await rows(task.id))[2].length
      const used = (await ctx.meta.getTransactionMetrics()).databaseQueries.used - start
      return { labels, used }
    })
  }

  it('reads a dense table task by task while those reads and the table reads fit', async () => {
    const { labels, used } = await readLeaving(46)
    expect(labels).toBe(200)
    expect(used).toBeGreaterThanOrEqual(40)
    expect(used).toBeLessThanOrEqual(46)
  })

  it('reads a dense table in full when task by task would pass the ranges left', async () => {
    const { labels, used } = await readLeaving(45)
    expect(labels).toBe(200)
    expect(used).toBeLessThanOrEqual(6)
  })
})
