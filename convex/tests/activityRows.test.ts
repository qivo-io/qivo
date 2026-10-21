/* internal/activityRows.ts, the one-time migration of rows written before
 * October 2026: it removes `seq` and gives a task row stored without
 * named_task_nums the list its text names, and namedTaskNums, the grammar it
 * reads that text with. */
/// <reference types="vite/client" />

import type { WithoutSystemFields } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { ACTIVITY_ROWS_PAGE, namedTaskNums } from '../internal/activityRows'
import { as, newT, plantIssue, uuid, withOrg } from './helpers.setup'

describe('the activity rows migration', () => {
  it('reports, then removes seq and lists the tasks old rows name, a page at a time', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const visible = await plantIssue(t, { org_id: f.org.id, project_id: f.sub2.id })
    const hidden = await plantIssue(t, { org_id: f.org.id, project_id: f.hidden.id })
    const rows: Partial<WithoutSystemFields<Doc<'activity_events'>>>[] = [
      // numbered rows with their list, a task's and a project's
      { seq: 1, verb: 'renamed', detail: 'from “Old”', named_task_nums: [] },
      { seq: 1, target_type: 'project', target_id: f.sub.id },
      // rows from before numbering, in both wordings
      { detail: `— blocks QN-${visible.num} — via MCP` },
      { verb: 'detached', detail: `from QN-${visible.num}, via the REST API (CI key)` },
      { verb: 'renamed', detail: 'from “Fix QN-999999”' },
      { detail: `(blocks QN-${hidden.num})` },
      // wording no writer produced, which keeps no list
      { detail: '— blocks PCB-12' },
    ]
    const ids = await t.run(async (ctx) => {
      const out: string[] = []
      for (const [i, row] of rows.entries()) {
        const id = uuid()
        await ctx.db.insert('activity_events', {
          id,
          org_id: f.org.id,
          ts: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
          actor_id: f.user.id,
          verb: 'linked',
          target_type: 'issue',
          target_id: task.id,
          label: task.title,
          project_id: f.sub.id,
          ...row,
        })
        out.push(id)
      }
      return out
    })
    const seen = async () =>
      (
        await as(t, f.guest).query(api.snapshot.commentThread, {
          org_id: f.org.id,
          issue_id: task.id,
        })
      ).events.map((row) => row.id)
    expect(await seen()).toEqual([ids[0]])

    const all = { scanned: 7, numbered: 2, unlisted: 5, unparsed: 1 }
    expect(await t.query(internal.internal.activityRows.check, {})).toEqual({
      ...all,
      cursor: null,
    })
    // check changes nothing
    expect(await seen()).toEqual([ids[0]])

    const page = ACTIVITY_ROWS_PAGE.rows
    ACTIVITY_ROWS_PAGE.rows = 4
    try {
      const first = await t.mutation(internal.internal.activityRows.run, {})
      expect(first).toMatchObject({ scanned: 4 })
      expect(first.cursor).not.toBeNull()
      const rest = await t.mutation(internal.internal.activityRows.run, {
        cursor: first.cursor ?? undefined,
      })
      expect(rest).toMatchObject({ scanned: 3, cursor: null })
      for (const key of ['numbered', 'unlisted', 'unparsed'] as const)
        expect(first[key] + rest[key], key).toBe(all[key])
    } finally {
      ACTIVITY_ROWS_PAGE.rows = page
    }

    const stored = await t.run((ctx) => ctx.db.query('activity_events').collect())
    expect(stored.filter((row) => row.seq !== undefined)).toEqual([])
    expect(stored.map((row) => row.named_task_nums)).toEqual([
      [],
      undefined,
      [visible.num],
      [visible.num],
      [],
      [hidden.num],
      undefined,
    ])
    // the guest now receives the old rows that name what it can read
    expect(await seen()).toEqual([ids[0], ids[2], ids[3], ids[4]])
    // a second run finds nothing to change but the unparsed row
    expect(await t.query(internal.internal.activityRows.check, {})).toEqual({
      scanned: 7,
      numbered: 0,
      unlisted: 1,
      unparsed: 1,
      cursor: null,
    })
  })
})

describe('namedTaskNums, the relation grammar of rows stored before their list', () => {
  const row = (verb: string, detail?: string, target_type: 'issue' | 'project' = 'issue') => ({
    verb,
    detail,
    target_type,
  })

  it('reads the task numbers a parent change or link names', () => {
    expect(namedTaskNums(row('moved', 'under QN-5 (from QN-3)'))).toEqual([5, 3])
    expect(namedTaskNums(row('moved', 'under QN-5'))).toEqual([5])
    expect(namedTaskNums(row('moved', 'under its parent (from QN-3)'))).toEqual([3])
    expect(namedTaskNums(row('detached', 'from QN-3'))).toEqual([3])
    expect(namedTaskNums(row('detached', 'from its parent'))).toEqual([])
    expect(namedTaskNums(row('linked', '(blocks QN-6)'))).toEqual([6])
    expect(namedTaskNums(row('linked', '(relates to QN-6)'))).toEqual([6])
    // the wording rows were stored with before October 2026
    expect(namedTaskNums(row('linked', '— blocks QN-6'))).toEqual([6])
    expect(namedTaskNums(row('linked', '— relates to QN-6'))).toEqual([6])
  })

  it('names nothing for other rows', () => {
    expect(namedTaskNums(row('moved', 'from To Do to Done'))).toEqual([])
    expect(namedTaskNums(row('moved', 'to the Firmware sub-project (from Board rev)'))).toEqual([])
    expect(namedTaskNums(row('renamed', 'from “Fix QN-9”'))).toEqual([])
    expect(namedTaskNums(row('linked', '— blocks QN-6', 'project'))).toEqual([])
  })

  it('answers null for relation wording no writer produces, so the row keeps no list', () => {
    expect(namedTaskNums(row('linked', '— blocks PCB-12'))).toBeNull()
    expect(namedTaskNums(row('linked', '(blocks PCB-12)'))).toBeNull()
    expect(namedTaskNums(row('linked', '(blocks QN-6'))).toBeNull()
    expect(namedTaskNums(row('linked', '— (blocks QN-6)'))).toBeNull()
    expect(namedTaskNums(row('linked'))).toBeNull()
    expect(namedTaskNums(row('detached', 'from QN-3 and QN-4'))).toBeNull()
    expect(namedTaskNums(row('moved', 'under QN-5 (from PCB-3)'))).toBeNull()
  })

  it('namedTaskNums reads signed rows and still fails closed on other wording', () => {
    const ev = (verb: string, detail: string) =>
      ({ target_type: 'issue', verb, detail }) as Pick<
        Doc<'activity_events'>,
        'target_type' | 'verb' | 'detail'
      >
    expect(namedTaskNums(ev('linked', '— blocks QN-12 — via MCP'))).toEqual([12])
    expect(namedTaskNums(ev('linked', '— relates to QN-3 — via the REST API (a (b) c)'))).toEqual([
      3,
    ])
    expect(namedTaskNums(ev('moved', 'under QN-4 (from QN-5) — via the REST API'))).toEqual([4, 5])
    expect(namedTaskNums(ev('detached', 'from QN-6 — via MCP'))).toEqual([6])
    // the comma the writers have used since October 2026
    expect(namedTaskNums(ev('linked', '(blocks QN-12), via MCP'))).toEqual([12])
    expect(namedTaskNums(ev('linked', '(relates to QN-3), via the REST API (a (b) c)'))).toEqual([
      3,
    ])
    expect(namedTaskNums(ev('moved', 'under QN-4 (from QN-5), via the REST API'))).toEqual([4, 5])
    expect(namedTaskNums(ev('detached', 'from QN-6, via MCP'))).toEqual([6])
    // anything else that follows the key is not a signature: fail closed
    expect(namedTaskNums(ev('linked', '— blocks QN-12 and QN-13'))).toBeNull()
    expect(namedTaskNums(ev('linked', '— blocks QN-12 — via email'))).toBeNull()
    expect(namedTaskNums(ev('detached', 'from QN-6 — via MCP — via MCP'))).toBeNull()
    expect(namedTaskNums(ev('detached', 'from QN-6, via MCP, via MCP'))).toBeNull()
    expect(namedTaskNums(ev('linked', '(blocks QN-12), via email'))).toBeNull()
    expect(namedTaskNums(ev('detached', 'from QN-6 via MCP'))).toBeNull()
  })
})
