/* Team sync: the sitting rule (lib/teamSync.ts), the per-person stamp in
 * sync_stamps (model/syncStamps.ts), and the page's latest-comment read,
 * which asks only about the projects its owners' tasks name. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS } from '../lib/access'
import {
  firstSittingDay,
  firstSittingSince,
  isReadingDay,
  nextSyncStamp,
  previousWorkingDayStart,
  SYNC_OWNERS_MAX,
  SYNC_SITTING_MS,
  syncSince,
} from '../lib/teamSync'
import { LAST_COMMENTS, latestComments } from '../teamSync'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantCopiedIssue,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  tick,
  uuid,
  withReadingAdmin,
} from './helpers.setup'
import { orgProjectView } from './orgProjectView.setup'

/* Local wall-clock instants: previousWorkingDayStart reads local midnight,
 * so the fixtures are built in local time too. September 2026: Mon 28. */
const local = (day: number, hour = 0, minute = 0, month = 8) =>
  new Date(2026, month, day, hour, minute).getTime()
const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()
const DEFAULT_LAST_COMMENTS = structuredClone(LAST_COMMENTS)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)

describe('previousWorkingDayStart', () => {
  it('reads the latest working day before today, at local midnight (Monday week start)', () => {
    expect(previousWorkingDayStart(local(28, 10, 30))).toBe(local(25)) // Mon -> Fri
    expect(previousWorkingDayStart(local(28))).toBe(local(25)) // Mon 00:00 -> Fri
    expect(previousWorkingDayStart(local(29, 23, 59))).toBe(local(28)) // Tue -> Mon
    expect(previousWorkingDayStart(local(3, 9, 0, 9))).toBe(local(2, 0, 0, 9)) // Sat -> Fri
    expect(previousWorkingDayStart(local(4, 9, 0, 9))).toBe(local(2, 0, 0, 9)) // Sun -> Fri
    // never a weekend day, never today
    expect(previousWorkingDayStart(local(28, 10))).not.toBe(local(27))
    expect(previousWorkingDayStart(local(29, 10))).not.toBe(local(29))
  })

  it("follows the organization's week start", () => {
    // Sunday start: Sunday to Thursday are the working days
    expect(previousWorkingDayStart(local(27, 9), 0)).toBe(local(24)) // Sun -> Thu
    expect(previousWorkingDayStart(local(28, 9), 0)).toBe(local(27)) // Mon -> Sun
    expect(previousWorkingDayStart(local(26, 9), 0)).toBe(local(24)) // Sat -> Thu
    // Saturday start: Saturday to Wednesday
    expect(previousWorkingDayStart(local(27, 9), 6)).toBe(local(26)) // Sun -> Sat
    expect(previousWorkingDayStart(local(26, 9), 6)).toBe(local(23)) // Sat -> Wed
    expect(previousWorkingDayStart(local(26, 9), 6)).not.toBe(local(25))
  })
})

describe('nextSyncStamp', () => {
  const at = '2026-09-28T09:00:00.000Z'
  const later = (ms: number) => iso(Date.parse(at) + ms)

  it('a first stamp carries no since', () => {
    expect(nextSyncStamp(null, at)).toStrictEqual({ at })
  })

  it('a change inside the sitting moves at and keeps since, absent included', () => {
    const now = later(HOUR)
    expect(nextSyncStamp({ at, since: '2026-09-25T08:00:00.000Z' }, now)).toStrictEqual({
      at: now,
      since: '2026-09-25T08:00:00.000Z',
    })
    expect(nextSyncStamp({ at }, now)).toStrictEqual({ at: now })
    const edge = later(SYNC_SITTING_MS)
    expect(nextSyncStamp({ at }, edge)).toStrictEqual({ at: edge })
  })

  it('a change after the sitting rolls the previous at into since', () => {
    const now = later(SYNC_SITTING_MS + 1)
    expect(nextSyncStamp({ at }, now)).toStrictEqual({ at: now, since: at })
    expect(nextSyncStamp({ at, since: '2026-09-25T08:00:00.000Z' }, now)).toStrictEqual({
      at: now,
      since: at,
    })
    // a first sitting's reading day gives way to the real sync too
    expect(nextSyncStamp({ at, since: '2026-09-25' }, now)).toStrictEqual({ at: now, since: at })
  })

  it("a first stamp keeps the page's reading day; later stamps never take one", () => {
    expect(nextSyncStamp(null, at, '2026-09-25')).toStrictEqual({ at, since: '2026-09-25' })
    const now = later(HOUR)
    expect(nextSyncStamp({ at }, now, '2026-09-25')).toStrictEqual({ at: now })
    expect(nextSyncStamp({ at, since: '2026-09-24' }, now, '2026-09-25')).toStrictEqual({
      at: now,
      since: '2026-09-24',
    })
  })
})

describe('firstSittingSince', () => {
  const now = '2026-09-28T09:00:00.000Z'
  it('takes a real day that has begun, at most 14 days back', () => {
    for (const day of ['2026-09-25', '2026-09-28', '2026-09-15']) {
      expect(firstSittingSince(day, now)).toBe(day)
    }
  })
  it('ignores anything else', () => {
    for (const bad of [
      undefined,
      '',
      'garbage',
      '2026-09-29', // not begun yet
      '2026-09-14', // its start is more than 14 days back
      '2026-02-31', // no such day
      '2026-09-25T00:00:00.000Z', // an instant would read as a previous sync
      ' 2026-09-25',
    ]) {
      expect(firstSittingSince(bad, now), String(bad)).toBeUndefined()
    }
    expect(nextSyncStamp(null, now, '2026-09-29')).toStrictEqual({ at: now })
  })
  it('is the day the page reads a person with no stamp from', () => {
    expect(firstSittingDay(local(28, 10, 30))).toBe('2026-09-25') // Mon -> Fri
    expect(firstSittingDay(local(29, 0, 5))).toBe('2026-09-28') // Tue -> Mon
    expect(firstSittingDay(local(27, 9), 0)).toBe('2026-09-24') // Sun -> Thu
    expect(isReadingDay(firstSittingDay(local(28, 10)))).toBe(true)
    expect(isReadingDay('2026-09-25T09:10:00.000Z')).toBe(false)
  })
})

describe('syncSince', () => {
  const now = local(28, 10)

  it('without a stamp reads from the start of the previous working day', () => {
    expect(syncSince(null, now)).toBe(local(25))
    expect(syncSince(null, local(27, 10), 0)).toBe(local(24))
  })

  it("while a sitting is on, reads its since, never the sitting's own stamp", () => {
    const at = iso(now - HOUR)
    expect(syncSince({ at, since: iso(local(24, 9)) }, now)).toBe(local(24, 9))
    // the first sitting of all reads the default of the day it started
    expect(syncSince({ at }, now)).toBe(local(25))
    expect(syncSince({ at }, now)).not.toBe(now - HOUR)
    expect(syncSince({ at: iso(now - SYNC_SITTING_MS) }, now)).toBe(local(25))
  })

  it('after the sitting, reads from the last sync', () => {
    const at = iso(now - SYNC_SITTING_MS - 1)
    expect(syncSince({ at }, now)).toBe(Date.parse(at))
    expect(syncSince({ at, since: iso(local(21, 9)) }, now)).toBe(Date.parse(at))
    expect(syncSince({ at, since: '2026-09-21' }, now)).toBe(Date.parse(at))
  })

  it('keeps a first sitting that runs past midnight on its reading day', () => {
    // Nora, never synced: a change at Mon 23:50 while her page reads from Fri
    const first = nextSyncStamp(null, iso(local(28, 23, 50)), firstSittingDay(local(28, 23, 50)))
    expect(syncSince(first, local(28, 23, 55))).toBe(local(25))
    // another at Tue 00:10, same sitting: still Friday, from local midnight
    const second = nextSyncStamp(first, iso(local(29, 0, 10)))
    expect(syncSince(second, local(29, 0, 15))).toBe(local(25))
    // without the reading day the sitting's own change would move it to Monday
    expect(syncSince({ at: second.at }, local(29, 0, 15))).toBe(local(28))
  })
})

const profileRow = (t: T, id: string): Promise<Doc<'profiles'>> =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('profiles')
      .withIndex('by_uuid', (q) => q.eq('id', id))
      .unique()
    if (row === null) throw new Error(`no profile ${id}`)
    return row
  })

/* The person's stored stamp as the snapshot ships it: sync_at and, when
 * set, sync_since, from their sync_stamps row; {} without one. */
const stampOf = (t: T, id: string): Promise<{ sync_at?: string; sync_since?: string }> =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('sync_stamps')
      .withIndex('by_profile', (q) => q.eq('profile_id', id))
      .unique()
    if (row === null) return {}
    return row.since === undefined
      ? { sync_at: row.at }
      : { sync_at: row.at, sync_since: row.since }
  })

const stamp = (t: T, f: OrgFixture, caller: Doc<'profiles'>, profile_id: string) =>
  as(t, caller).mutation(api.teamSync.stamp, { org_id: f.org.id, profile_id })

/* Overwrites the person's stamp row with `at` and `since`. */
const setStamp = (t: T, profile: Doc<'profiles'>, at: string, since?: string) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('sync_stamps')
      .withIndex('by_profile', (q) => q.eq('profile_id', profile.id))
      .unique()
    const next = {
      org_id: profile.org_id,
      profile_id: profile.id,
      at,
      ...(since === undefined ? {} : { since }),
    }
    if (row === null) await ctx.db.insert('sync_stamps', next)
    else await ctx.db.replace(row._id, next)
  })

describe('teamSync.stamp', () => {
  it('staff stamp a colleague, themselves and an agent, with no activity row', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const before = Date.now()
    await stamp(t, f, f.admin, f.user.id)
    await stamp(t, f, f.user, f.user.id)
    await stamp(t, f, f.user, f.agent.id)
    for (const person of [f.user, f.agent]) {
      const row = await stampOf(t, person.id)
      expect(Date.parse(row.sync_at ?? '')).toBeGreaterThanOrEqual(before)
      expect(row).not.toHaveProperty('sync_since')
    }
    expect(await stampOf(t, f.admin.id)).toEqual({})
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('a viewer and a guest are refused and change nothing', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await expectRefusal(stamp(t, f, f.viewer, f.user.id), 'forbidden')
    await expectRefusal(stamp(t, f, f.guest, f.guest.id), 'forbidden')
    expect(await profileRow(t, f.user.id)).toEqual(f.user)
    expect(await profileRow(t, f.guest.id)).toEqual(f.guest)
    expect(await stampOf(t, f.user.id)).toEqual({})
    expect(await stampOf(t, f.guest.id)).toEqual({})
  })

  it('a foreign-org or unknown profile reads not found', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    await expectRefusal(stamp(t, f, f.admin, f.otherAdmin.id), 'not_found', /profile not found/)
    await expectRefusal(stamp(t, f, f.admin, uuid()), 'not_found', /profile not found/)
    expect(await profileRow(t, f.otherAdmin.id)).toEqual(f.otherAdmin)
  })

  it('keeps since through a sitting and rolls the last sync into it after one', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const earlier = '2025-12-30T09:00:00.000Z'

    await stamp(t, f, f.admin, f.user.id)
    const first = await stampOf(t, f.user.id)
    await tick()
    await stamp(t, f, f.admin, f.user.id)
    const second = await stampOf(t, f.user.id)
    expect(second.sync_at! > first.sync_at!).toBe(true)
    expect(second).not.toHaveProperty('sync_since') // absent stays absent

    await setStamp(t, f.user, second.sync_at!, earlier)
    await stamp(t, f, f.user, f.user.id)
    expect((await stampOf(t, f.user.id)).sync_since).toBe(earlier)

    // the last change on this person was seven hours ago: a new sitting
    const lastSync = new Date(Date.now() - 7 * HOUR).toISOString()
    await setStamp(t, f.user, lastSync, earlier)
    await stamp(t, f, f.admin, f.user.id)
    const rolled = await stampOf(t, f.user.id)
    expect(rolled.sync_since).toBe(lastSync)
    expect(rolled.sync_at! > lastSync).toBe(true)
  })

  it("a person's first stamp keeps the caller's valid reading day, and only the first", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const today = new Date()
    const back = (days: number) =>
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days))
        .toISOString()
        .slice(0, 10)
    const firstStamp = (person: Doc<'profiles'>, first_since: string) =>
      as(t, f.admin).mutation(api.teamSync.stamp, {
        org_id: f.org.id,
        profile_id: person.id,
        first_since,
      })
    await firstStamp(f.user, back(3))
    expect((await stampOf(t, f.user.id)).sync_since).toBe(back(3))
    // a later stamp in the sitting keeps it and ignores another reading day
    await firstStamp(f.user, back(1))
    expect((await stampOf(t, f.user.id)).sync_since).toBe(back(3))
    // a reading day in the future or weeks back is ignored
    await firstStamp(f.admin, back(-2))
    expect(await stampOf(t, f.admin.id)).not.toHaveProperty('sync_since')
    await firstStamp(f.agent, back(20))
    expect(await stampOf(t, f.agent.id)).not.toHaveProperty('sync_since')
  })
})

describe('teamSync.lastComments', () => {
  afterEach(() => {
    Object.assign(LAST_COMMENTS, structuredClone(DEFAULT_LAST_COMMENTS))
    Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
  })

  const comment = (
    t: T,
    issue: Doc<'issues'>,
    author: string,
    created_at: string,
    body = 'planted comment',
  ) =>
    t.run(async (ctx) => {
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: issue.id,
        author,
        body,
        created_at,
      })
    })
  const lastComments = (t: T, caller: Doc<'profiles'>, org_id: string, owner_ids: string[]) =>
    as(t, caller).query(api.teamSync.lastComments, { org_id, owner_ids })
  const sorted = (rows: { issue_id: string; at: string | null }[]) =>
    [...rows].sort((a, b) => a.issue_id.localeCompare(b.issue_id))

  it('answers each open, active task the asked owners hold that the caller can see', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const mine = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const shelvedSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const todo = await plantIssue(t, { ...mine, status: 'todo' })
    const progress = await plantIssue(t, { ...mine, project_id: f.sub2.id, status: 'progress' })
    const review = await plantIssue(t, { ...mine, status: 'review' })
    const silent = await plantIssue(t, { ...mine, status: 'progress' })
    const done = await plantIssue(t, { ...mine, status: 'done' })
    const backlog = await plantIssue(t, { ...mine, status: 'backlog' })
    const archived = await plantIssue(t, { ...mine, status: 'todo', archived_at: NOW })
    const hidden = await plantIssue(t, { ...mine, project_id: hiddenSub.id, status: 'todo' })
    const shelved = await plantIssue(t, { ...mine, project_id: shelvedSub.id, status: 'todo' })
    const theirs = await plantIssue(t, { ...mine, assignee_id: f.admin.id, status: 'todo' })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      assignee_id: f.otherAdmin.id,
      status: 'todo',
    })

    await comment(t, todo, f.admin.id, '2026-01-02T10:00:00.000Z')
    await comment(t, todo, f.user.id, '2026-01-03T11:00:00.000Z') // the later one
    await comment(t, progress, f.user.id, '2026-01-02T12:00:00.000Z')
    await comment(t, review, f.admin.id, '2026-01-02T13:00:00.000Z')
    for (const issue of [done, backlog, archived, shelved, hidden, theirs]) {
      await comment(t, issue, f.user.id, '2026-01-04T09:00:00.000Z')
    }
    await comment(t, foreign, f.otherAdmin.id, '2026-01-04T09:00:00.000Z')

    const visible = [
      { issue_id: todo.id, at: '2026-01-03T11:00:00.000Z' },
      { issue_id: progress.id, at: '2026-01-02T12:00:00.000Z' },
      { issue_id: review.id, at: '2026-01-02T13:00:00.000Z' },
      { issue_id: silent.id, at: null },
    ]
    // viewers read too; the hidden project's task is not theirs to see
    const viewer = await lastComments(t, f.viewer, f.org.id, [f.user.id])
    expect(sorted(viewer.rows)).toEqual(sorted(visible))
    expect(viewer.complete).toBe(true)
    // the hidden project's lead sees its task, and still nothing closed,
    // archived or held by someone not asked for
    const lead = await lastComments(t, f.user, f.org.id, [f.user.id.toUpperCase()])
    expect(sorted(lead.rows)).toEqual(
      sorted([...visible, { issue_id: hidden.id, at: '2026-01-04T09:00:00.000Z' }]),
    )
    // asking for both owners adds the other's task
    const both = await lastComments(t, f.admin, f.org.id, [f.user.id, f.admin.id, f.user.id])
    expect(both.rows.map((r) => r.issue_id)).toContain(theirs.id)
    expect(both.rows).toHaveLength(visible.length + 2)
    // another organization's tasks stay there, even when its people are named
    const named = await lastComments(t, f.admin, f.org.id, [f.otherAdmin.id])
    expect(named).toEqual({ rows: [], complete: true })
    expect((await lastComments(t, f.otherAdmin, f.otherOrg.id, [f.otherAdmin.id])).rows).toEqual([
      { issue_id: foreign.id, at: '2026-01-04T09:00:00.000Z' },
    ])
    expect(await lastComments(t, f.admin, f.org.id, [])).toEqual({ rows: [], complete: true })
  })

  it('gives a task In Review with a reviewer to the reviewer, and any other to its assignee', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const base = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    const reviewing = await plantIssue(t, { ...base, status: 'review', reviewer_id: f.admin.id })
    const unreviewed = await plantIssue(t, { ...base, status: 'review' })
    const planned = await plantIssue(t, { ...base, status: 'todo', reviewer_id: f.admin.id })
    const self = await plantIssue(t, { ...base, status: 'review', reviewer_id: f.user.id })
    const ids = async (owner: string) =>
      (await lastComments(t, f.admin, f.org.id, [owner])).rows.map((r) => r.issue_id).sort()

    expect(await ids(f.admin.id)).toEqual([reviewing.id])
    expect(await ids(f.user.id)).toEqual([unreviewed.id, planned.id, self.id].sort())
  })

  it('answers at most LAST_COMMENTS.tasks tasks and says the answer is cut short', async () => {
    LAST_COMMENTS.tasks = 2
    const t = newT()
    const f = await withReadingAdmin(t)
    const base = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    await plantIssue(t, { ...base, status: 'todo' })
    await plantIssue(t, { ...base, status: 'progress' })
    expect((await lastComments(t, f.admin, f.org.id, [f.user.id])).complete).toBe(true)

    await plantIssue(t, { ...base, status: 'review' })
    const cut = await lastComments(t, f.admin, f.org.id, [f.user.id])
    expect(cut.complete).toBe(false)
    expect(cut.rows).toHaveLength(2)

    // the owners asked for first keep their rows
    const theirs = await plantIssue(t, { ...base, assignee_id: f.admin.id, status: 'todo' })
    const first = await lastComments(t, f.admin, f.org.id, [f.admin.id, f.user.id])
    expect(first.rows[0].issue_id).toBe(theirs.id)
    const last = await lastComments(t, f.admin, f.org.id, [f.user.id, f.admin.id])
    expect(last.rows.map((r) => r.issue_id)).not.toContain(theirs.id)
  })

  it('stops reading comments past LAST_COMMENTS.bytes and leaves the rest out', async () => {
    LAST_COMMENTS.bytes = 50_000
    const t = newT()
    const f = await withReadingAdmin(t)
    const base = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    for (let n = 0; n < 5; n++) {
      const task = await plantIssue(t, { ...base, status: 'todo' })
      await comment(t, task, f.user.id, NOW, 'x'.repeat(20_000))
    }
    const cut = await lastComments(t, f.admin, f.org.id, [f.user.id])
    expect(cut.complete).toBe(false)
    // the third comment passes the budget, so the answer ends there
    expect(cut.rows).toHaveLength(3)
    expect(cut.rows.every((r) => r.at === NOW)).toBe(true)

    // the tasks read spend the same budget, so long ones, whose task rows
    // hold the text as a rollback to the second release writes it, leave no
    // comment read at all
    for (let n = 0; n < 3; n++) {
      await plantCopiedIssue(t, {
        ...base,
        assignee_id: f.admin.id,
        description: 'x'.repeat(20_000),
      })
    }
    const spent = await lastComments(t, f.admin, f.org.id, [f.admin.id])
    expect(spent).toEqual({ rows: [], complete: false })
  })

  it("reads only the asked owners' open tasks, however many others exist", async () => {
    const t = newT({ transactionLimits: { databaseQueries: 100, documentsRead: 300 } })
    const f = await withReadingAdmin(t)
    const others = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.admin.id }
    // 5,000 open tasks someone else holds, and 2,000 the owner closed or
    // has not started. An organization-wide or a status-blind owner read
    // passes the document limit.
    await t.run(async (ctx) => {
      for (let n = 0; n < 7000; n++) {
        await ctx.db.insert('issues', {
          id: uuid(),
          num: 10_000 + n,
          title: 'Bulk task',
          description: '',
          status: n < 5000 ? 'progress' : n % 2 ? 'done' : 'backlog',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          ...others,
          ...(n < 5000 ? {} : { assignee_id: f.user.id, reviewer_id: f.user.id }),
        })
      }
    })
    const owned = []
    for (let n = 0; n < 20; n++) {
      owned.push(await plantIssue(t, { ...others, assignee_id: f.user.id, status: 'progress' }))
    }
    const answer = await lastComments(t, f.viewer, f.org.id, [f.user.id])
    expect(answer.complete).toBe(true)
    expect(answer.rows.map((r) => r.issue_id).sort()).toEqual(owned.map((i) => i.id).sort())
  })

  it('counts every task it reads toward LAST_COMMENTS.taskBytes, kept or not', async () => {
    LAST_COMMENTS.taskBytes = 50_000
    const t = newT()
    const f = await withReadingAdmin(t)
    const hiddenSub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.hidden.id,
    })
    const base = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    // read first (index order), and not the viewer's to see, their text in
    // the task rows too, as a rollback to the second release writes it
    for (let n = 0; n < 3; n++) {
      await plantCopiedIssue(t, {
        ...base,
        project_id: hiddenSub.id,
        status: 'todo',
        description: 'x'.repeat(20_000),
      })
    }
    const shown = await plantIssue(t, { ...base, status: 'todo' })
    // the hidden tasks count at their fixed size for the viewer, so their
    // text moves nothing and the scan reaches the shown task
    const viewer = await lastComments(t, f.viewer, f.org.id, [f.user.id])
    expect(viewer).toEqual({ rows: [{ issue_id: shown.id, at: null }], complete: true })
    // the hidden project's lead keeps the tasks the budget let it read
    const lead = await lastComments(t, f.user, f.org.id, [f.user.id])
    expect(lead.complete).toBe(false)
    expect(lead.rows).toHaveLength(3)
    expect(lead.rows.map((r) => r.issue_id)).not.toContain(shown.id)
  })

  it("stays under Convex's read limit with long tasks and comments, cut short", async () => {
    const t = newT({ transactionLimits: { bytesRead: 16 * 2 ** 20 } })
    const f = await withReadingAdmin(t)
    const base = { org_id: f.org.id, project_id: f.sub.id, assignee_id: f.user.id }
    // 430 open tasks with 20,000 characters each in their description and
    // their latest comment, about 17 MB together
    for (let chunk = 0; chunk < 430; chunk += 86) {
      await t.run(async (ctx) => {
        for (let n = chunk; n < chunk + 86; n++) {
          const id = uuid()
          await ctx.db.insert('issues', {
            id,
            num: 10_000 + n,
            title: 'Long task',
            description: 'd'.repeat(20_000),
            status: 'progress',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            ...base,
          })
          await ctx.db.insert('comments', {
            id: uuid(),
            issue_id: id,
            author: f.user.id,
            body: 'c'.repeat(20_000),
            created_at: NOW,
          })
        }
      })
    }
    const answer = await lastComments(t, f.viewer, f.org.id, [f.user.id])
    expect(answer.complete).toBe(false)
    expect(answer.rows.length).toBeGreaterThan(100)
    expect(answer.rows.every((r) => r.at === NOW)).toBe(true)
  })

  /* What latestComments read for `caller` and `owners`, beside its
   * answer, in one transaction. */
  const measured = (t: T, caller: Doc<'profiles'>, owners: string[]) =>
    t.run(async (ctx) => {
      const answer = await latestComments(ctx, caller, owners)
      const m = await ctx.meta.getTransactionMetrics()
      return { answer, ranges: m.databaseQueries.used, documents: m.documentsRead.used }
    })

  /* How many live top-level projects and live sub-projects the fixture's
   * organization holds, its own included. */
  const projectsOf = (o: { t: T; f: OrgFixture }) =>
    o.t.run(async (ctx) => {
      const all = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', o.f.org.id))
        .collect()
      const live = all.filter((p) => p.archived_at === undefined)
      return {
        tops: live.filter((p) => p.parent_id === undefined).length,
        subs: live.filter((p) => p.parent_id !== undefined).length,
      }
    })

  /* An organization whose user holds open tasks in FW and PCB, with
   * `extra` more top-level projects the tasks do not name, each with a
   * sub-project, led by the admin. */
  async function namedOrg(extra: number) {
    const t = newT()
    const f = await withReadingAdmin(t)
    const base = { org_id: f.org.id, assignee_id: f.user.id }
    for (let n = 0; n < 6; n++)
      await plantIssue(t, { ...base, project_id: n % 2 ? f.sub.id : f.sub2.id, num: 100 + n })
    for (let n = 0; n < extra; n++) {
      const top = await plantProject(t, { org_id: f.org.id, lead_id: f.admin.id })
      await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: top.id })
    }
    return { t, f }
  }

  it("reads only the projects its owners' tasks name, however many the organization holds", async () => {
    const small = await namedOrg(0)
    // with the fixture's TBED and SKNK, 200 live top-level projects, the
    // design size, and 200 live sub-projects
    const large = await namedOrg(198)
    expect(await projectsOf(large)).toEqual({ tops: 200, subs: 200 })
    const a = await measured(small.t, small.f.viewer, [small.f.user.id])
    const b = await measured(large.t, large.f.viewer, [large.f.user.id])
    expect(a.answer.complete).toBe(true)
    expect(a.answer.rows).toHaveLength(6)
    expect(b.answer.rows).toHaveLength(6)
    expect([b.ranges, b.documents]).toEqual([a.ranges, a.documents])
    // this must fail for a read of every project, as the project view was
    const view = (o: typeof small) =>
      o.t.run(async (ctx) => {
        await orgProjectView(ctx, o.f.viewer)
        return (await ctx.meta.getTransactionMetrics()).documentsRead.used
      })
    expect(await view(large)).toBeGreaterThan((await view(small)) + 300)
  })

  it('answers the same whatever the size of tasks in projects the caller cannot see', async () => {
    LAST_COMMENTS.taskBytes = 50_000
    const answers: unknown[] = []
    for (const copied of [false, true]) {
      const t = newT()
      const f = await withReadingAdmin(t)
      const hiddenSub = await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.hidden.id,
      })
      const base = { org_id: f.org.id, assignee_id: f.user.id, status: 'todo' as const }
      for (let n = 0; n < 3; n++) {
        const hidden = { ...base, project_id: hiddenSub.id, num: 100 + n }
        if (copied) await plantCopiedIssue(t, { ...hidden, description: 'x'.repeat(20_000) })
        else await plantIssue(t, hidden)
      }
      await plantIssue(t, { ...base, project_id: f.sub.id, num: 200 })
      const got = await lastComments(t, f.viewer, f.org.id, [f.user.id])
      answers.push({ rows: got.rows.length, complete: got.complete })
    }
    expect(answers[1]).toEqual(answers[0])
    expect(answers[0]).toEqual({ rows: 1, complete: true })
  })

  it('cuts the answer short past LAST_COMMENTS.projects, the tasks of projects past it without a row', async () => {
    const { t, f } = await namedOrg(0)
    LAST_COMMENTS.projects = 1
    const cut = await lastComments(t, f.viewer, f.org.id, [f.user.id])
    expect(cut.complete).toBe(false)
    const projects = await t.run(async (ctx) => {
      const out = new Set<string>()
      for (const row of cut.rows) {
        const task = await ctx.db
          .query('issues')
          .withIndex('by_uuid', (q) => q.eq('id', row.issue_id))
          .unique()
        if (task !== null) out.add(task.project_id)
      }
      return [...out]
    })
    expect(projects).toHaveLength(1)
    expect(cut.rows.length).toBeGreaterThan(0)
    LAST_COMMENTS.projects = 2
    expect(await lastComments(t, f.viewer, f.org.id, [f.user.id])).toMatchObject({
      complete: true,
    })
  })

  it("cuts the answer short where a bound of the caller's own access reads stops a check, never a row for its project", async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const me = await plantSeat(t, {
      org_id: f.org.id,
      org_role: 'user',
      auth_user_id: `auth_${uuid()}`,
      accepted_at: NOW,
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: me.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id, assignee_id: f.user.id })
    expect((await lastComments(t, me, f.org.id, [f.user.id])).rows).toHaveLength(1)
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 })
    expect(await lastComments(t, me, f.org.id, [f.user.id])).toEqual({ rows: [], complete: false })
  })

  it('cuts the answer short where the guard stops a step, the owners decided before it keeping their rows', async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    // the first owner's tasks in one status of one sub-project, the
    // second's in another sub-project, which needs its own access question
    const first: Doc<'issues'>[] = []
    for (let n = 0; n < 3; n++)
      first.push(
        await plantIssue(t, {
          org_id: f.org.id,
          project_id: f.sub.id,
          assignee_id: f.user.id,
          status: 'todo',
          num: 100 + n,
        }),
      )
    for (let n = 0; n < 3; n++)
      await plantIssue(t, {
        org_id: f.org.id,
        project_id: f.sub2.id,
        assignee_id: f.admin.id,
        status: 'todo',
        num: 200 + n,
      })
    const within = (ranges: number) => {
      LAST_COMMENTS.reads.ranges = ranges
      return lastComments(t, f.viewer, f.org.id, [f.user.id, f.admin.id])
    }
    expect((await within(DEFAULT_LAST_COMMENTS.reads.ranges)).rows).toHaveLength(6)
    expect(await within(0)).toEqual({ rows: [], complete: false })
    // the fewest ranges at which the answer holds a row, just past the
    // first owner's step and project questions
    let low = 0
    let high = DEFAULT_LAST_COMMENTS.reads.ranges
    while (high - low > 1) {
      const mid = Math.floor((low + high) / 2)
      if ((await within(mid)).rows.length > 0) high = mid
      else low = mid
    }
    const cut = await within(high)
    expect(cut.complete).toBe(false)
    expect(cut.rows.map((r) => r.issue_id).sort()).toEqual(first.map((i) => i.id).sort())
  })

  it('reads 50 owners whose 1,000 open tasks span 200 sub-projects, with open tasks in archived ones, under real limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withReadingAdmin(t)
    const owners: Doc<'profiles'>[] = []
    for (let n = 0; n < 50; n++)
      owners.push(await plantSeat(t, { org_id: f.org.id, name: `Owner ${n}`, accepted_at: NOW }))
    // 99 top-level projects of 2 sub-projects led by the user, with the
    // fixture's FW and PCB the 200 live sub-projects the user reads, and 20
    // archived sub-projects, each owner's 20 open tasks spread over them
    const subs: Doc<'projects'>[] = [f.sub, f.sub2]
    for (let n = 0; n < 99; n++) {
      const top = await plantProject(t, { org_id: f.org.id, lead_id: f.user.id })
      for (let k = 0; k < 2; k++)
        subs.push(await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: top.id }))
    }
    const archived: Doc<'projects'>[] = []
    for (let n = 0; n < 20; n++)
      archived.push(
        await plantProject(t, {
          org_id: f.org.id,
          type: 'project',
          parent_id: f.meta.id,
          archived_at: NOW,
        }),
      )
    await t.run(async (ctx) => {
      for (const [o, owner] of owners.entries())
        for (let n = 0; n < 22; n++) {
          const project = n < 20 ? subs[(o * 20 + n) % subs.length] : archived[(o + n) % 20]
          await ctx.db.insert('issues', {
            id: uuid(),
            org_id: f.org.id,
            project_id: project.id,
            num: 20_000 + o * 100 + n,
            title:
              'Replace the fan controller on the bench rig and log the readings for the review',
            status: (['todo', 'progress', 'review'] as const)[n % 3],
            priority: 'medium',
            paused: false,
            assignee_id: owner.id,
            created_at: NOW,
            updated_at: NOW,
          })
        }
    })
    expect(await projectsOf({ t, f })).toEqual({ tops: 101, subs: 200 })
    const ids = owners.map((o) => o.id)
    const got = await measured(t, f.user, ids)
    console.log(
      'lastComments figures, 50 owners over 200 sub-projects:',
      JSON.stringify({
        ranges: got.ranges,
        documents: got.documents,
        rows: got.answer.rows.length,
        complete: got.answer.complete,
      }),
    )
    expect(got.answer).toMatchObject({ complete: true })
    expect(got.answer.rows).toHaveLength(1000)
  })

  it(`refuses more than ${SYNC_OWNERS_MAX} people at a time`, async () => {
    const t = newT()
    const f = await withReadingAdmin(t)
    const many = Array.from({ length: SYNC_OWNERS_MAX + 1 }, () => uuid())
    await expectRefusal(
      lastComments(t, f.admin, f.org.id, many),
      'bad_request',
      /at most 50 people at a time/,
    )
    // repeats count once
    const repeated = [...many.slice(0, SYNC_OWNERS_MAX), many[0].toUpperCase()]
    expect((await lastComments(t, f.admin, f.org.id, repeated)).complete).toBe(true)
  })
})
