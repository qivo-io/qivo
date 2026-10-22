/* The one-time migration for stored values the registry's limits refuse
 * (internal/overCapRows.ts): its check and dry run write nothing and name
 * every row that breaks a rule with what a run does to it. The fix cuts
 * names to their UTF-16 limits without splitting an emoji or leaving a
 * trailing space, keeps a file name's extension, lowers remaining hours to
 * the cap, trims task descriptions and writes addresses in punycode. It
 * only reports long texts and addresses it cannot fix, skips a fixed value
 * another row already has, and treats the copies Deleted items keeps like
 * live rows. */

import type { WithoutSystemFields } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { LIMITS, NAME_MAX, TEXT_MAX } from '../lib/limits'
import {
  activityFor,
  NOW,
  newT,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

/* edge-runtime provides Blob; convex/tsconfig's ESNext-only lib does not
 * declare it. */
declare class Blob {
  constructor(parts: string[])
}

/** 80 code points that are 81 UTF-16 units, a name valid before names
 * counted units. */
const POINT_NAME = `${'n'.repeat(79)}😀`

type Found = { table: string; field: string; outcome: string }

/** Runs the whole migration, as a dry run or not, with `page_size` rows a page. */
const fix = (t: T, dry_run: boolean, page_size?: number) =>
  t.action(internal.internal.overCapRows.fix, { dry_run, page_size })

/** Each row found as `table.field outcome`, sorted. */
const summary = (rows: Found[]) => rows.map((r) => `${r.table}.${r.field} ${r.outcome}`).sort()

/** Inserts a label of `name` into `orgId`. */
const plantLabel = (t: T, orgId: string, name: string) =>
  t.run((ctx) =>
    ctx.db.insert('labels', {
      id: uuid(),
      org_id: orgId,
      name,
      name_lower: name.toLowerCase(),
      color: '#336699',
      created_at: NOW,
    }),
  )

/** Inserts a comment of `body` on task `issueId`. */
const plantComment = (t: T, issueId: string, body: string) =>
  t.run((ctx) =>
    ctx.db.insert('comments', { id: uuid(), issue_id: issueId, body, created_at: NOW }),
  )

/** Inserts an attachment named `name` on task `issueId`. */
const plantAttachment = (t: T, orgId: string, issueId: string, name: string) =>
  t.run(async (ctx) =>
    ctx.db.insert('issue_attachments', {
      storage_id: await ctx.storage.store(new Blob(['pdf']) as never),
      org_id: orgId,
      id: uuid(),
      issue_id: issueId,
      name,
      size_bytes: 3,
      inline: false,
      created_at: NOW,
    }),
  )

/** withOrg, with its one address that has capitals lowercased, so only the
 * rows a test plants break a rule. */
async function setup(t: T) {
  const f = await withOrg(t)
  await t.run((ctx) => ctx.db.patch(f.otherAdmin._id, { email: f.otherAdmin.email?.toLowerCase() }))
  return f
}

describe('internal/overCapRows', () => {
  it('reports the rows that break a rule, fixes them, and has nothing to fix after', async () => {
    const t = newT()
    const f = await setup(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const email = `${'e'.repeat(250)}@x.example`
    await t.run(async (ctx) => {
      await ctx.db.patch(f.team._id, { name: POINT_NAME })
      await ctx.db.patch(task._id, { remaining_hours: 150_000 })
      await ctx.db.patch(f.user._id, { email })
    })
    await plantLabel(t, f.org.id, '🏷️'.repeat(14))
    await plantAttachment(t, f.org.id, task.id, `${'é'.repeat(254)}😀.pdf`)

    const dry = await fix(t, true)
    expect(summary(dry.rows)).toEqual([
      'issue_attachments.name would_fix',
      'issues.remaining_hours would_fix',
      'labels.name would_fix',
      'profiles.email reported',
      'teams.name would_fix',
    ])
    // every row is counted, so a run too large to list still says what it found
    expect(dry.counts).toEqual(Object.fromEntries(summary(dry.rows).map((key) => [key, 1])))
    expect(dry.unlisted).toBe(0)
    expect(await t.query(internal.internal.overCapRows.check, { phase: 'teams' })).toMatchObject({
      rows: [{ field: 'name', length: 81, outcome: 'would_fix' }],
      done: true,
    })
    // the dry run wrote nothing
    expect((await t.run((ctx) => ctx.db.get(f.team._id)))?.name).toBe(POINT_NAME)

    expect(summary((await fix(t, false)).rows)).toEqual([
      'issue_attachments.name fixed',
      'issues.remaining_hours fixed',
      'labels.name fixed',
      'profiles.email reported',
      'teams.name fixed',
    ])
    const after = await t.run(async (ctx) => ({
      team: (await ctx.db.get(f.team._id))?.name,
      hours: (await ctx.db.get(task._id))?.remaining_hours,
      label: (await ctx.db.query('labels').collect()).find((l) => l.name.startsWith('🏷'))?.name,
      file: (await ctx.db.query('issue_attachments').first())?.name,
      email: (await ctx.db.get(f.user._id))?.email,
    }))
    expect(after.team).toBe('n'.repeat(79))
    expect(after.hours).toBe(LIMITS.remainingHours.max)
    // thirteen whole tags; the fourteenth would split
    expect(after.label).toBe('🏷️'.repeat(13))
    // the stem is cut, never the extension
    expect(after.file).toBe(`${'é'.repeat(LIMITS.attachmentName.max - 4)}.pdf`)
    // an address is a person's to correct, so it stays as stored
    expect(after.email).toBe(email)
    expect(summary((await fix(t, true)).rows)).toEqual(['profiles.email reported'])
  })

  it('never cuts a long text, and trims a task description without activity', async () => {
    const t = newT()
    const f = await setup(t)
    const long = 'x'.repeat(TEXT_MAX + 1)
    const longTask = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: long,
    })
    const padded = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: '\n\nFix the login\n',
    })
    await plantComment(t, longTask.id, long)
    const project = await plantProject(t, {
      org_id: f.org.id,
      description: 'd'.repeat(LIMITS.projectDescription.max + 1),
    })
    const activity = (await activityFor(t, f.org.id)).length

    expect(summary((await fix(t, false)).rows)).toEqual([
      'comments.body reported',
      'issues.description fixed',
      'issues.description reported',
      'projects.description reported',
    ])
    const after = await t.run(async (ctx) => ({
      long: (await ctx.db.get(longTask._id))?.description,
      padded: (await ctx.db.get(padded._id))?.description,
      comment: (await ctx.db.query('comments').first())?.body,
      project: (await ctx.db.get(project._id))?.description,
    }))
    expect(after).toEqual({
      long,
      padded: 'Fix the login',
      comment: long,
      project: 'd'.repeat(LIMITS.projectDescription.max + 1),
    })
    expect(await activityFor(t, f.org.id)).toHaveLength(activity)
    // the long texts stay reported until a person shortens them
    expect(summary((await fix(t, true)).rows)).toEqual([
      'comments.body reported',
      'issues.description reported',
      'projects.description reported',
    ])
  })

  it('cuts a label after its last whole word and skips a cut name another label has', async () => {
    const t = newT()
    const f = await setup(t)
    const max = LIMITS.labelName.max
    const spaced = await plantLabel(t, f.org.id, 'Waiting on supplier quote for the newer panel')
    await plantLabel(t, f.org.id, 'a'.repeat(max))
    const meetsOld = await plantLabel(t, f.org.id, `${'a'.repeat(max)}b`)
    const first = await plantLabel(t, f.org.id, `${'c'.repeat(max)}1`)
    const second = await plantLabel(t, f.org.id, `${'C'.repeat(max)}2`)
    const outcomes = async (dry_run: boolean) => {
      const { rows } = await fix(t, dry_run)
      return [spaced, meetsOld, first, second].map((id) => rows.find((r) => r.id === id)?.outcome)
    }

    // the dry run shows the collisions the real run meets
    expect(await outcomes(true)).toEqual(['would_fix', 'skipped', 'would_fix', 'skipped'])
    expect(await outcomes(false)).toEqual(['fixed', 'skipped', 'fixed', 'skipped'])
    const names = await t.run(async (ctx) =>
      Promise.all(
        [spaced, meetsOld, first, second].map(async (id) => {
          const label = await ctx.db.get(id)
          return [label?.name, label?.name_lower]
        }),
      ),
    )
    expect(names).toEqual([
      ['Waiting on supplier quote for the newer', 'waiting on supplier quote for the newer'],
      [`${'a'.repeat(max)}b`, `${'a'.repeat(max)}b`],
      ['c'.repeat(max), 'c'.repeat(max)],
      [`${'C'.repeat(max)}2`, `${'c'.repeat(max)}2`],
    ])
  })

  it('writes addresses in punycode unless another seat of the organization has that form', async () => {
    const t = newT()
    const f = await setup(t)
    const anna = await plantSeat(t, { org_id: f.org.id, email: 'anna@bücher.de' })
    await plantSeat(t, { org_id: f.org.id, email: 'ben@xn--bcher-kva.de' })
    const ben = await plantSeat(t, { org_id: f.org.id, email: 'ben@bücher.de' })
    const two = await plantSeat(t, { org_id: f.org.id, email: 'anna,ben@example.test' })
    // the same address in another organization is that organization's seat
    const elsewhere = await plantSeat(t, { org_id: f.otherOrg.id, email: 'anna@bücher.de' })

    const { rows } = await fix(t, false)
    expect(
      [anna, ben, two, elsewhere].map((seat) => rows.find((r) => r.id === seat._id)?.outcome),
    ).toEqual(['fixed', 'skipped', 'reported', 'fixed'])
    const emails = await t.run(async (ctx) =>
      Promise.all([anna, ben, two, elsewhere].map(async (s) => (await ctx.db.get(s._id))?.email)),
    )
    expect(emails).toEqual([
      'anna@xn--bcher-kva.de',
      'ben@bücher.de',
      'anna,ben@example.test',
      'anna@xn--bcher-kva.de',
    ])
  })

  it('fixes the copies Deleted items keeps, so a restore brings back a fixed row', async () => {
    const t = newT()
    const f = await setup(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const project = await plantProject(t, { org_id: f.org.id })
    const { _id: _task, _creationTime: _taskTime, ...taskDoc } = task
    const { _id: _project, _creationTime: _projectTime, ...projectDoc } = project
    const store = (row: Doc<'deleted_rows'>['row'], ownerId: string, rowId: string) =>
      t.run((ctx) =>
        ctx.db.insert('deleted_rows', {
          item_id: uuid(),
          org_id: f.org.id,
          table: row.table,
          owner_id: ownerId,
          row_id: rowId,
          created_ts: 0,
          row,
        }),
      )
    const issueDoc: WithoutSystemFields<Doc<'issues'>> = {
      ...taskDoc,
      id: uuid(),
      description: '\nTrim me ',
      remaining_hours: 150_000,
    }
    const storedIssue = await store({ table: 'issues', doc: issueDoc }, issueDoc.id, issueDoc.id)
    const [projectId, milestoneId, commentId] = [uuid(), uuid(), uuid()]
    const storedProject = await store(
      {
        table: 'projects',
        doc: {
          ...projectDoc,
          id: projectId,
          name: POINT_NAME,
          description: 'd'.repeat(LIMITS.projectDescription.max + 1),
        },
      },
      projectId,
      projectId,
    )
    const storedMilestone = await store(
      {
        table: 'milestones',
        doc: {
          id: milestoneId,
          project_id: f.meta.id,
          name: POINT_NAME,
          week: '2026-01-05',
          created_at: NOW,
        },
      },
      f.meta.id,
      milestoneId,
    )
    await store(
      {
        table: 'comments',
        doc: {
          id: commentId,
          issue_id: issueDoc.id,
          body: 'x'.repeat(TEXT_MAX + 1),
          created_at: NOW,
        },
      },
      issueDoc.id,
      commentId,
    )

    expect(summary((await fix(t, false)).rows)).toEqual([
      'deleted_rows.comments.body reported',
      'deleted_rows.issues.description fixed',
      'deleted_rows.issues.remaining_hours fixed',
      'deleted_rows.milestones.name fixed',
      'deleted_rows.projects.description reported',
      'deleted_rows.projects.name fixed',
    ])
    const docs = await t.run(async (ctx) =>
      Promise.all(
        [storedIssue, storedProject, storedMilestone].map(
          async (id) => (await ctx.db.get(id))?.row,
        ),
      ),
    )
    expect(docs[0]).toMatchObject({
      table: 'issues',
      doc: {
        description: 'Trim me',
        remaining_hours: LIMITS.remainingHours.max,
        title: task.title,
      },
    })
    expect(docs[1]).toMatchObject({
      table: 'projects',
      doc: { name: 'n'.repeat(79), key: project.key },
    })
    expect(docs[2]).toMatchObject({ table: 'milestones', doc: { name: 'n'.repeat(79) } })
  })

  it('walks every page of a phase', async () => {
    const t = newT()
    const f = await setup(t)
    const ids = await t.run(async (ctx) =>
      Promise.all(
        [1, 2, 3].map((week) =>
          ctx.db.insert('milestones', {
            id: uuid(),
            project_id: f.meta.id,
            name: POINT_NAME,
            week: `2026-01-0${week + 4}`,
            created_at: NOW,
          }),
        ),
      ),
    )
    const first = await t.query(internal.internal.overCapRows.check, {
      phase: 'milestones',
      page_size: 1,
    })
    expect(first).toMatchObject({ rows: [{ outcome: 'would_fix' }], done: false })
    const second = await t.query(internal.internal.overCapRows.check, {
      phase: 'milestones',
      cursor: first.cursor,
      page_size: 1,
    })
    expect(second.rows[0]?.id).not.toBe(first.rows[0]?.id)

    expect(summary((await fix(t, false, 1)).rows)).toEqual([
      'milestones.name fixed',
      'milestones.name fixed',
      'milestones.name fixed',
    ])
    const names = await t.run(async (ctx) =>
      Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.name)),
    )
    expect(names).toEqual(['n'.repeat(79), 'n'.repeat(79), 'n'.repeat(79)])
  })

  it('leaves rows within every limit alone', async () => {
    const t = newT()
    const f = await setup(t)
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'd'.repeat(TEXT_MAX),
      remaining_hours: LIMITS.remainingHours.max,
    })
    await plantComment(t, task.id, 'c'.repeat(TEXT_MAX))
    await plantProject(t, {
      org_id: f.org.id,
      name: 'p'.repeat(NAME_MAX),
      description: 'd'.repeat(LIMITS.projectDescription.max),
    })
    await plantLabel(t, f.org.id, 'l'.repeat(LIMITS.labelName.max))
    await plantAttachment(t, f.org.id, task.id, `${'a'.repeat(LIMITS.attachmentName.max - 4)}.pdf`)
    await plantSeat(t, { org_id: f.org.id, email: "sean.o'brien@xn--bcher-kva.de" })
    await t.run((ctx) => ctx.db.patch(f.team._id, { name: `${'t'.repeat(NAME_MAX - 2)}😀` }))

    expect((await fix(t, true)).rows).toEqual([])
    expect((await fix(t, false)).rows).toEqual([])
  })
})
