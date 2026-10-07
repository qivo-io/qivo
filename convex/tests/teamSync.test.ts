/* Team sync: the sitting rule (lib/teamSync.ts), the per-person stamp on
 * profiles.sync_at / sync_since, and the page's latest-comment read. */

import { describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import {
  firstSittingDay,
  firstSittingSince,
  isReadingDay,
  nextSyncStamp,
  previousWorkingDayStart,
  SYNC_SITTING_MS,
  syncSince,
} from '../lib/teamSync'
import {
  activityFor,
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  type T,
  tick,
  uuid,
  withOrg,
} from './helpers.setup'

/* Local wall-clock instants: previousWorkingDayStart reads local midnight,
 * so the fixtures are built in local time too. September 2026: Mon 28. */
const local = (day: number, hour = 0, minute = 0, month = 8) =>
  new Date(2026, month, day, hour, minute).getTime()
const HOUR = 60 * 60 * 1000
const iso = (ms: number) => new Date(ms).toISOString()

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

const stamp = (t: T, f: OrgFixture, caller: Doc<'profiles'>, profile_id: string) =>
  as(t, caller).mutation(api.teamSync.stamp, { org_id: f.org.id, profile_id })

const setStamp = (t: T, profile: Doc<'profiles'>, patch: Partial<Doc<'profiles'>>) =>
  t.run(async (ctx) => {
    await ctx.db.patch(profile._id, patch)
  })

describe('teamSync.stamp', () => {
  it('staff stamp a colleague, themselves and an agent, with no activity row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const before = Date.now()
    await stamp(t, f, f.admin, f.user.id)
    await stamp(t, f, f.user, f.user.id)
    await stamp(t, f, f.user, f.agent.id)
    for (const person of [f.user, f.agent]) {
      const row = await profileRow(t, person.id)
      expect(Date.parse(row.sync_at ?? '')).toBeGreaterThanOrEqual(before)
      expect(row).not.toHaveProperty('sync_since')
    }
    expect(await profileRow(t, f.admin.id)).not.toHaveProperty('sync_at')
    expect(await activityFor(t, f.org.id)).toEqual([])
  })

  it('a viewer and a guest are refused and change nothing', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(stamp(t, f, f.viewer, f.user.id), 'forbidden')
    await expectRefusal(stamp(t, f, f.guest, f.guest.id), 'forbidden')
    expect(await profileRow(t, f.user.id)).toEqual(f.user)
    expect(await profileRow(t, f.guest.id)).toEqual(f.guest)
  })

  it('a foreign-org or unknown profile reads not found', async () => {
    const t = newT()
    const f = await withOrg(t)
    await expectRefusal(stamp(t, f, f.admin, f.otherAdmin.id), 'not_found', /profile not found/)
    await expectRefusal(stamp(t, f, f.admin, uuid()), 'not_found', /profile not found/)
    expect(await profileRow(t, f.otherAdmin.id)).toEqual(f.otherAdmin)
  })

  it('keeps since through a sitting and rolls the last sync into it after one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const earlier = '2025-12-30T09:00:00.000Z'

    await stamp(t, f, f.admin, f.user.id)
    const first = await profileRow(t, f.user.id)
    await tick()
    await stamp(t, f, f.admin, f.user.id)
    const second = await profileRow(t, f.user.id)
    expect(second.sync_at! > first.sync_at!).toBe(true)
    expect(second).not.toHaveProperty('sync_since') // absent stays absent

    await setStamp(t, second, { sync_since: earlier })
    await stamp(t, f, f.user, f.user.id)
    expect((await profileRow(t, f.user.id)).sync_since).toBe(earlier)

    // the last change on this person was seven hours ago: a new sitting
    const lastSync = new Date(Date.now() - 7 * HOUR).toISOString()
    await setStamp(t, second, { sync_at: lastSync, sync_since: earlier })
    await stamp(t, f, f.admin, f.user.id)
    const rolled = await profileRow(t, f.user.id)
    expect(rolled.sync_since).toBe(lastSync)
    expect(rolled.sync_at! > lastSync).toBe(true)
  })

  it("a person's first stamp keeps the caller's valid reading day, and only the first", async () => {
    const t = newT()
    const f = await withOrg(t)
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
    expect((await profileRow(t, f.user.id)).sync_since).toBe(back(3))
    // a later stamp in the sitting keeps it and ignores another reading day
    await firstStamp(f.user, back(1))
    expect((await profileRow(t, f.user.id)).sync_since).toBe(back(3))
    // a reading day in the future or weeks back is ignored
    await firstStamp(f.admin, back(-2))
    expect(await profileRow(t, f.admin.id)).not.toHaveProperty('sync_since')
    await firstStamp(f.agent, back(20))
    expect(await profileRow(t, f.agent.id)).not.toHaveProperty('sync_since')
  })

  it("the stamp rides every member's snapshot profile row", async () => {
    const t = newT()
    const f = await withOrg(t)
    await stamp(t, f, f.admin, f.user.id)
    await setStamp(t, f.user, { sync_since: NOW })
    const row = await profileRow(t, f.user.id)
    const snap = await as(t, f.viewer).query(api.snapshot.forMe, {})
    const shipped = snap?.profiles.find((p) => p.id === f.user.id)
    expect(shipped?.sync_at).toBe(row.sync_at)
    expect(shipped?.sync_since).toBe(NOW)
    expect(snap?.profiles.find((p) => p.id === f.admin.id)).not.toHaveProperty('sync_at')
  })
})

describe('teamSync.lastComments', () => {
  const comment = (t: T, issue: Doc<'issues'>, author: string, created_at: string) =>
    t.run(async (ctx) => {
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: issue.id,
        author,
        body: 'planted comment',
        created_at,
      })
    })
  const lastComments = (t: T, caller: Doc<'profiles'>, org_id: string) =>
    as(t, caller)
      .query(api.teamSync.lastComments, { org_id })
      .then((rows) => [...rows].sort((a, b) => a.issue_id.localeCompare(b.issue_id)))
  const expected = (rows: { issue_id: string; at: string }[]) =>
    [...rows].sort((a, b) => a.issue_id.localeCompare(b.issue_id))

  it('returns the latest comment of each visible, open, active task only', async () => {
    const t = newT()
    const f = await withOrg(t)
    const base = { org_id: f.org.id, project_id: f.sub.id }
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
    const todo = await plantIssue(t, { ...base, status: 'todo' })
    const progress = await plantIssue(t, { ...base, project_id: f.sub2.id, status: 'progress' })
    const review = await plantIssue(t, { ...base, status: 'review' })
    const silent = await plantIssue(t, { ...base, status: 'progress' })
    const done = await plantIssue(t, { ...base, status: 'done' })
    const backlog = await plantIssue(t, { ...base, status: 'backlog' })
    const archived = await plantIssue(t, { ...base, status: 'todo', archived_at: NOW })
    const hidden = await plantIssue(t, { ...base, project_id: hiddenSub.id, status: 'todo' })
    const shelved = await plantIssue(t, { ...base, project_id: shelvedSub.id, status: 'todo' })
    const foreign = await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      status: 'todo',
    })

    await comment(t, todo, f.admin.id, '2026-01-02T10:00:00.000Z')
    await comment(t, todo, f.user.id, '2026-01-03T11:00:00.000Z') // the later one
    await comment(t, progress, f.user.id, '2026-01-02T12:00:00.000Z')
    await comment(t, review, f.admin.id, '2026-01-02T13:00:00.000Z')
    for (const issue of [done, backlog, archived, shelved, hidden]) {
      await comment(t, issue, f.user.id, '2026-01-04T09:00:00.000Z')
    }
    await comment(t, foreign, f.otherAdmin.id, '2026-01-04T09:00:00.000Z')

    const visible = [
      { issue_id: todo.id, at: '2026-01-03T11:00:00.000Z' },
      { issue_id: progress.id, at: '2026-01-02T12:00:00.000Z' },
      { issue_id: review.id, at: '2026-01-02T13:00:00.000Z' },
    ]
    // viewers read too; the hidden project's task is not theirs to see
    expect(await lastComments(t, f.viewer, f.org.id)).toEqual(expected(visible))
    expect((await lastComments(t, f.viewer, f.org.id)).map((r) => r.issue_id)).not.toContain(
      silent.id,
    )
    // the hidden project's lead sees its task, and still nothing closed or archived
    expect(await lastComments(t, f.user, f.org.id)).toEqual(
      expected([...visible, { issue_id: hidden.id, at: '2026-01-04T09:00:00.000Z' }]),
    )
    // a foreign org's comments stay in that org
    expect(await lastComments(t, f.otherAdmin, f.otherOrg.id)).toEqual([
      { issue_id: foreign.id, at: '2026-01-04T09:00:00.000Z' },
    ])
    expect((await lastComments(t, f.admin, f.org.id)).map((r) => r.issue_id)).not.toContain(
      foreign.id,
    )
  })
})
