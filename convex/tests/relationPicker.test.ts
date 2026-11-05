/* The task window's relation pickers (taskWindow.ts relationCandidates,
 * lib/relationPicker.ts). The cases cover the arguments and the cursor,
 * one unavailable answer for every task the reader may not open, the
 * writes' levels in every access shape, no hidden task by title or by
 * number, the Parent, Subtasks and Linked tasks rules, the search, the
 * order and its continuation, the budgets, and what hidden data may not
 * move. The reads at the design size are in relationPickerScale.test.ts. */

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { OWN_READS, projectLevel } from '../lib/access'
import { byId } from '../lib/db'
import { type AccessLevel, LEVEL_RANK } from '../lib/enums'
import { LIMITS } from '../lib/limits'
import {
  RELATION_CURSOR_REFUSAL,
  RELATION_PICKER,
  type RelationCandidates,
  type RelationKind,
} from '../lib/relationPicker'
import { issueKey } from '../lib/taskRefs'
import { PROJECT_ASK, PROJECT_READ } from '../lib/viewReads'
import { NO_WRITE_ACCESS } from '../model/issues'
import { SHAPES } from './accessShapes.setup'
import { plantTasks } from './board.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'

const DEFAULT_PICKER = structuredClone(RELATION_PICKER)
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(RELATION_PICKER, structuredClone(DEFAULT_PICKER))
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/** One batch of `who`'s picker of `kind` for the task with id `issueId`. */
const pick = (
  t: T,
  who: Doc<'profiles'>,
  issueId: string,
  kind: RelationKind,
  o: { search?: string; cursor?: string } = {},
) =>
  as(t, who).query(api.taskWindow.relationCandidates, {
    org_id: who.org_id,
    issue_id: issueId,
    kind,
    ...o,
  })

type Batch = Extract<RelationCandidates, { state: 'ok' }>

/* `answer` as a batch, or a failure naming what it was. */
function okOf(answer: RelationCandidates): Batch {
  if (answer.state !== 'ok') throw new Error(`the picker answered ${JSON.stringify(answer)}`)
  return answer
}

/** Every batch of a picker from its first to its end, and with `all` on
 * through Search all your projects to the organization's end. */
async function batches(
  t: T,
  who: Doc<'profiles'>,
  issueId: string,
  kind: RelationKind,
  o: { search?: string; all?: boolean } = {},
): Promise<Batch[]> {
  const out: Batch[] = []
  let cursor: string | undefined
  for (let n = 0; n < 500; n++) {
    const batch = okOf(await pick(t, who, issueId, kind, { search: o.search, cursor }))
    out.push(batch)
    if (batch.next !== null) cursor = batch.next
    else if (o.all === true && batch.all_projects !== null) cursor = batch.all_projects
    else return out
  }
  throw new Error('the picker never ended')
}

/** The ids of every row of `list`, in order. */
const idsOf = (list: readonly Batch[]): string[] => list.flatMap((b) => b.rows.map((r) => r.id))

/** The ids of every row from the first batch to the end. */
const allIds = async (
  t: T,
  who: Doc<'profiles'>,
  issueId: string,
  kind: RelationKind,
  o: { search?: string; all?: boolean } = {},
) => idsOf(await batches(t, who, issueId, kind, o))

/* A task of `project` in the fixture's organization. */
const task = (t: T, f: OrgFixture, project: Doc<'projects'>, extra: Partial<Doc<'issues'>> = {}) =>
  plantIssue(t, { org_id: f.org.id, project_id: project.id, ...extra })

/* `n` active subtasks of `parent` in `project`. */
const subtasksOf = (t: T, project: Doc<'projects'>, parent: Doc<'issues'>, n: number) =>
  plantTasks(t, project, n, () => ({ parent_id: parent.id }))

/* A seat of the fixture's organization with a login. */
const seat = async (t: T, f: OrgFixture, org_role: Doc<'profiles'>['org_role'] = 'user') =>
  await plantLogin(t, await plantSeat(t, { org_id: f.org.id, org_role, accepted_at: NOW }))

/* A link row from `source` to `target`, as a writer stores it. */
const linkRow = (
  f: OrgFixture,
  source: Pick<Doc<'issues'>, 'id' | 'window_key'>,
  targetId: string,
  type: 'blocks' | 'relates' = 'blocks',
) => ({
  org_id: f.org.id,
  id: uuid(),
  source_id: source.id,
  target_id: targetId,
  type,
  pair_key: [source.id, targetId].sort().join(':'),
  created_at: NOW,
  task_key: source.window_key,
})

describe('arguments', () => {
  it('refuses an unknown picker, a search past its limit and every cursor but an earlier batch of the same picker, task, search and person', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const other = await task(t, f, f.sub)
    for (let i = 0; i < 3; i++) await task(t, f, f.sub2, { title: `Board ${i}` })
    RELATION_PICKER.rows = 1
    const first = okOf(await pick(t, f.user, open.id, 'link', { search: 'board' }))
    const cursor = first.next as string
    expect(cursor).toEqual(expect.any(String))
    // the same picker goes on
    expect(
      okOf(await pick(t, f.user, open.id, 'link', { search: 'board', cursor })).rows,
    ).toHaveLength(1)
    await expect(
      as(t, f.user).query(api.taskWindow.relationCandidates, {
        org_id: f.org.id,
        issue_id: open.id,
        kind: 'sibling' as RelationKind,
      }),
    ).rejects.toThrow()
    const long = await expectRefusal(
      pick(t, f.user, open.id, 'link', { search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(long.data.message).toBe(LIMITS.search.refusal)
    // a search of exactly the limit is no refusal
    okOf(await pick(t, f.user, open.id, 'link', { search: 'x'.repeat(LIMITS.search.max) }))
    const refused: [string, Promise<unknown>][] = [
      ['another picker', pick(t, f.user, open.id, 'subtask', { search: 'board', cursor })],
      ['another task', pick(t, f.user, other.id, 'link', { search: 'board', cursor })],
      ['another search', pick(t, f.user, open.id, 'link', { search: 'boards', cursor })],
      ['another person', pick(t, f.admin, open.id, 'link', { search: 'board', cursor })],
      [
        'a changed cursor',
        pick(t, f.user, open.id, 'link', {
          search: 'board',
          cursor: `${cursor.slice(0, -1)}${cursor.endsWith('0') ? '1' : '0'}`,
        }),
      ],
      ['junk', pick(t, f.user, open.id, 'link', { search: 'board', cursor: 'rp2~zz' })],
      ['no prefix', pick(t, f.user, open.id, 'link', { search: 'board', cursor: cursor.slice(4) })],
    ]
    for (const [why, call] of refused)
      await expectRefusal(call, 'bad_request', new RegExp(RELATION_CURSOR_REFUSAL)).catch((e) => {
        throw new Error(`${why}: ${String(e)}`)
      })
  })
})

describe('access', () => {
  it('answers one unavailable for every task the reader may not open, for each picker', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    const deleted = await task(t, f, f.sub)
    await as(t, f.admin).mutation(api.issues.deleteDeep, { org_id: f.org.id, id: deleted.id })
    const refusals: [string, Doc<'profiles'>, string][] = [
      ['an unknown uuid', f.admin, uuid()],
      [
        'a task number, which the picker does not take',
        f.admin,
        issueKey((await task(t, f, f.sub)).num),
      ],
      ["another organization's task", f.admin, foreign.id],
      ['a task moved to Deleted items', f.admin, deleted.id],
      ['an archived task', f.admin, (await task(t, f, f.sub, { archived_at: NOW })).id],
      ['a task in an archived project', f.admin, (await task(t, f, shelved)).id],
      ['a task in a project the reader cannot see', f.guest, (await task(t, f, f.hidden)).id],
    ]
    for (const [why, who, id] of refusals)
      for (const kind of ['parent', 'subtask', 'link'] as const)
        expect(await pick(t, who, id, kind), `${why}, ${kind}`).toEqual({ state: 'unavailable' })
    // the same reader opens a task they hold
    expect((await pick(t, f.guest, (await task(t, f, f.sub)).id, 'link')).state).toBe('ok')
  })

  /* OWN_READS under which the check of a project shared with one of the
   * reader's teams stops at a bound (lib/access.ts accessUnchecked), as
   * convex/tests/taskWindow.test.ts lowers them, and so does navigation to
   * the top-level project on the legacy path, which would otherwise read
   * the team's shares first; and one bound up. */
  const UNCHECKED = { projectShares: 0, rows: 0, lookups: 0, teamReads: 0, navRows: 0 }
  const ONE_UP = { projectShares: 0, rows: 0, lookups: 1, teamReads: 2, navRows: 1 }

  it('answers access_unchecked where a bound stops the check of the family, unavailable where it stops the opened task, and as usual one bound up', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a user grant on FW, which no team shares, and a team that shares PCB
    const me = await seat(t, f)
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
    const open = await task(t, f, f.sub)
    const onPcb = await task(t, f, f.sub2)
    const usual = await allIds(t, me, open.id, 'parent')
    expect(usual).toEqual([onPcb.id])
    Object.assign(OWN_READS, UNCHECKED)
    for (const kind of ['parent', 'subtask', 'link'] as const)
      expect(await pick(t, me, open.id, kind)).toEqual({
        state: 'unavailable',
        reason: 'access_unchecked',
        message: expect.stringContaining('could not finish checking'),
      })
    // with the task in PCB opened, its own check stops
    expect(await pick(t, me, onPcb.id, 'link')).toEqual({ state: 'unavailable' })
    Object.assign(OWN_READS, ONE_UP)
    expect(await allIds(t, me, open.id, 'parent')).toEqual(usual)
  })

  it("answers a typed task ID whose project's check a bound stops as a hidden one, and finds its task in all your projects", async () => {
    const t = newT()
    const f = await withOrg(t)
    // a user grant on TBED, which needs no team share, and a team that
    // shares Skunkworks
    const me = await seat(t, f)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.meta.id,
        profile_id: me.id,
        level: 'user',
      })
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.hidden.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const open = await task(t, f, f.sub, { num: 1 })
    const far = await task(t, f, f.hidden, { num: 940_001 })
    const search = issueKey(far.num)
    expect(okOf(await pick(t, me, open.id, 'link', { search })).rows).toEqual([
      expect.objectContaining({ id: far.id, exact: true }),
    ])
    Object.assign(OWN_READS, UNCHECKED)
    const first = await pick(t, me, open.id, 'link', { search })
    expect(first).toEqual({
      state: 'ok',
      rows: [],
      next: null,
      all_projects: expect.any(String),
      stopped: false,
      blocked: null,
    })
    // the catalogue reads its levels without that bound, so Search all
    // your projects meets the task and offers it, never an ended list
    // without it
    const beyond = okOf(
      await pick(t, me, open.id, 'link', { search, cursor: okOf(first).all_projects as string }),
    )
    expect(beyond).toMatchObject({ next: null, all_projects: null, stopped: false })
    expect(beyond.rows.map((r) => r.id)).toEqual([far.id])
    expect(beyond.rows[0]).not.toHaveProperty('exact')
  })

  it('refuses Parent and Subtasks to a reader without Edit on the task, whose Linked tasks lists only the projects they edit', async () => {
    const t = newT()
    const f = await withOrg(t)
    // Viewer on FW and User on PCB, nothing on TBED itself
    const me = await seat(t, f)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: me.id,
        level: 'viewer',
      })
      await ctx.db.insert('project_access', {
        project_id: f.sub2.id,
        profile_id: me.id,
        level: 'user',
      })
    })
    const open = await task(t, f, f.sub)
    const inFw = await task(t, f, f.sub)
    const inPcb = await task(t, f, f.sub2)
    await task(t, f, f.meta)
    for (const kind of ['parent', 'subtask'] as const)
      expect(await pick(t, me, open.id, kind)).toEqual({
        state: 'refused',
        message: NO_WRITE_ACCESS,
      })
    expect(await allIds(t, me, open.id, 'link', { all: true })).toEqual([inPcb.id])
    // from the task in PCB, which they edit, every task they see
    const fromPcb = await allIds(t, me, inPcb.id, 'link', { all: true })
    expect(fromPcb).toEqual(expect.arrayContaining([open.id, inFw.id]))
    expect(fromPcb).toHaveLength(3)
  })

  /* What the write would accept for `who` from task `open`, by the
   * per-project predicate (lib/access.ts projectLevel), in the picker's
   * order, the family first and then the rest of the organization for
   * Linked tasks. */
  async function expected(
    t: T,
    who: Doc<'profiles'>,
    open: Doc<'issues'>,
    tasks: readonly Doc<'issues'>[],
  ) {
    return await t.run(async (ctx) => {
      const me = (await ctx.db.get(who._id)) as Doc<'profiles'>
      const projectOf = async (id: string) => (await byId(ctx, 'projects', id)) as Doc<'projects'>
      const levelOf = async (id: string) => await projectLevel(ctx, me, await projectOf(id))
      const rank = (l: AccessLevel | null) => (l === null ? 0 : LEVEL_RANK[l])
      const topOf = async (id: string) => (await projectOf(id)).parent_id ?? id
      const own = await levelOf(open.project_id)
      if (own === null) return null
      const edits = rank(own) >= LEVEL_RANK.user
      const family = await topOf(open.project_id)
      // the picker's order is the own project, the family's sub-projects
      // by creation and the top-level project, and then each other
      // top-level project by creation, its sub-projects first
      const place = async (x: Doc<'issues'>) => {
        const p = await projectOf(x.project_id)
        const top = await projectOf(p.parent_id ?? p.id)
        if (top.id === family)
          return [
            0,
            p.id === open.project_id ? 0 : p.parent_id === undefined ? 2 : 1,
            p._creationTime,
            x._creationTime,
          ]
        return [
          1,
          top._creationTime,
          p.parent_id === undefined ? 1 : 0,
          p._creationTime,
          x._creationTime,
        ]
      }
      const sorted = async (xs: Doc<'issues'>[]) => {
        const keyed = await Promise.all(xs.map(async (x) => ({ x, k: await place(x) })))
        keyed.sort((a, b) => {
          for (let i = 0; i < Math.min(a.k.length, b.k.length); i++)
            if (a.k[i] !== b.k[i]) return (a.k[i] as number) - (b.k[i] as number)
          return a.k.length - b.k.length
        })
        return keyed.map((e) => e.x.id)
      }
      const parentish: Doc<'issues'>[] = []
      const linkFamily: Doc<'issues'>[] = []
      const linkOthers: Doc<'issues'>[] = []
      for (const x of tasks) {
        if (x.id === open.id || x.org_id !== open.org_id) continue
        if ((await projectOf(x.project_id)).archived_at !== undefined) continue
        const level = await levelOf(x.project_id)
        if (level === null) continue
        const inFamily = (await topOf(x.project_id)) === family
        if (inFamily && rank(level) >= LEVEL_RANK.user) parentish.push(x)
        if (edits || rank(level) >= LEVEL_RANK.user) (inFamily ? linkFamily : linkOthers).push(x)
      }
      return {
        edits,
        parent: await sorted(parentish),
        link: [...(await sorted(linkFamily)), ...(await sorted(linkOthers))],
      }
    })
  }

  /* The fewest opened tasks a role's case holds and the fewest of them with
   * rows, so a case that compares nothing fails. */
  const MOST_SHAPES = { opened: 10, rows: 5 }

  for (const role of ['guest', 'viewer', 'user', 'admin'] as const)
    it(`offers what the write accepts, at its level, in every access shape, for a seat of role ${role}`, async () => {
      let opened = 0
      let withRows = 0
      for (const [name, plant] of SHAPES) {
        const t = newT()
        const f = await withOrg(t)
        const me = await seat(t, f, role)
        await t.run((ctx) => plant(ctx, f, me).then(() => undefined))
        const archived = await t.run(async (ctx) => {
          const out: string[] = []
          for (const p of [f.meta, f.sub, f.sub2, f.hidden])
            if ((await ctx.db.get(p._id))?.archived_at !== undefined) out.push(p.id)
          return out
        })
        const tasks = [
          await task(t, f, f.sub),
          await task(t, f, f.sub2),
          await task(t, f, f.meta),
          await task(t, f, f.hidden),
          await task(t, f, f.sub),
        ]
        for (const open of tasks.slice(0, 4)) {
          const want = await expected(t, me, open, tasks)
          const what = `${name}, ${role}, from ${open.project_id}`
          if (want === null || archived.includes(open.project_id)) {
            for (const kind of ['parent', 'subtask', 'link'] as const)
              expect(await pick(t, me, open.id, kind), what).toEqual({ state: 'unavailable' })
            continue
          }
          opened += 1
          for (const kind of ['parent', 'subtask'] as const) {
            if (!want.edits) {
              expect(await pick(t, me, open.id, kind), what).toEqual({
                state: 'refused',
                message: NO_WRITE_ACCESS,
              })
              continue
            }
            expect(await allIds(t, me, open.id, kind), `${what}, ${kind}`).toEqual(want.parent)
          }
          const link = await allIds(t, me, open.id, 'link', { all: true })
          expect(link, `${what}, link`).toEqual(want.link)
          if (link.length > 0) withRows += 1
        }
      }
      // the shapes give every role tasks to open and to offer
      expect(opened).toBeGreaterThanOrEqual(
        role === 'admin' ? 4 * SHAPES.length - 4 : MOST_SHAPES.opened,
      )
      expect(withRows).toBeGreaterThanOrEqual(role === 'viewer' ? 0 : MOST_SHAPES.rows)
    })
})

describe('never a hidden task', () => {
  it('leaves out a task in a hidden or archived sub-project, an archived task, a hidden project and another organization, by title and by number', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest's grant on TBED moves to FW and PCB, and a third
    // sub-project the guest cannot see joins them
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const open = await task(t, f, f.sub)
    const shown = await task(t, f, f.sub2, { title: 'Quokka shown' })
    const hidden = [
      await task(t, f, sibling, { title: 'Quokka in the sibling', num: 880_001 }),
      await task(t, f, shelved, { title: 'Quokka shelved', num: 880_002 }),
      await task(t, f, f.sub, { title: 'Quokka archived', archived_at: NOW, num: 880_003 }),
      await task(t, f, f.hidden, { title: 'Quokka in Skunkworks', num: 880_004 }),
    ]
    await plantIssue(t, {
      org_id: f.otherOrg.id,
      project_id: f.otherProject.id,
      title: 'Quokka elsewhere',
      num: 880_005,
    })
    for (const kind of ['parent', 'subtask', 'link'] as const) {
      expect(
        await allIds(t, f.guest, open.id, kind, { search: 'quokka', all: true }),
        kind,
      ).toEqual([shown.id])
      for (const num of [...hidden.map((x) => x.num), 880_005]) {
        const found = await batches(t, f.guest, open.id, kind, { search: issueKey(num), all: true })
        expect(idsOf(found), `${kind} ${num}`).toEqual([])
      }
    }
    // a task the guest is shown is found by its number, outside its
    // sub-project too
    const byNumber = okOf(await pick(t, f.guest, open.id, 'link', { search: issueKey(shown.num) }))
    expect(byNumber.rows).toEqual([expect.objectContaining({ id: shown.id, exact: true })])
  })
})

describe('the Parent picker', () => {
  it('offers top-level tasks with room in projects the reader edits, and never the task, its parent, a subtask, a full task or another project', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    // a sub-project the guest only views
    const viewed = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
    })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: viewed.id,
        profile_id: f.guest.id,
        level: 'viewer',
      }),
    )
    const parent = await task(t, f, f.sub, { title: 'Current parent' })
    const open = await task(t, f, f.sub2, { parent_id: parent.id })
    const inPcb = await task(t, f, f.sub2, { title: 'Top-level in PCB' })
    const inFw = await task(t, f, f.sub, { title: 'Top-level in FW' })
    const subtask = await task(t, f, f.sub, { title: 'A subtask', parent_id: inFw.id })
    // 100 active subtasks, 40 the guest cannot see and 10 in an archived
    // sub-project, count; archived ones do not
    const full = await task(t, f, f.sub, { title: 'Full' })
    await subtasksOf(t, f.sub, full, 50)
    await subtasksOf(t, sibling, full, 40)
    await subtasksOf(t, shelved, full, 10)
    const roomy = await task(t, f, f.sub, { title: 'Roomy' })
    await subtasksOf(t, f.sub, roomy, LIMITS.subtasks.max - 1)
    await plantTasks(t, f.sub, 5, () => ({ parent_id: roomy.id, archived_at: NOW }))
    const readOnly = await task(t, f, viewed, { title: 'Read-only' })
    const elsewhere = await task(t, f, f.hidden, { title: 'Elsewhere' })
    const onMeta = await task(t, f, f.meta, { title: 'On TBED' })
    const rows = await allIds(t, f.guest, open.id, 'parent')
    // PCB first, then FW; TBED, which the guest only navigates, and the
    // viewed sub-project are read-only to the guest
    expect(rows).toEqual([inPcb.id, inFw.id, roomy.id])
    for (const out of [open, parent, subtask, full, readOnly, elsewhere, onMeta])
      expect(rows).not.toContain(out.id)
    // a lead of TBED also gets the task stored on TBED, after its sub-projects
    expect(await allIds(t, f.user, open.id, 'parent')).toEqual(
      expect.arrayContaining([inPcb.id, inFw.id, roomy.id, onMeta.id, readOnly.id]),
    )
    expect((await allIds(t, f.user, open.id, 'parent')).at(-1)).toBe(onMeta.id)
    // by number, the full task and the task elsewhere stay out
    for (const out of [full, elsewhere, subtask])
      expect(await allIds(t, f.user, open.id, 'parent', { search: issueKey(out.num) })).toEqual([])
  })

  it('blocks a task with any subtask, archived ones included, with no row', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const other = await task(t, f, f.sub)
    expect(okOf(await pick(t, f.user, open.id, 'parent'))).toMatchObject({
      rows: [expect.objectContaining({ id: other.id })],
      blocked: null,
    })
    await task(t, f, f.sub, { parent_id: open.id, archived_at: NOW })
    expect(await pick(t, f.user, open.id, 'parent')).toEqual({
      state: 'ok',
      rows: [],
      next: null,
      all_projects: null,
      stopped: false,
      blocked: 'has_subtasks',
    })
  })
})

describe('the Subtasks picker', () => {
  it('offers tasks without subtasks with their parent as the reader sees it, and never a task with subtasks or a current subtask', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    const open = await task(t, f, f.sub)
    const current = await task(t, f, f.sub, { parent_id: open.id })
    const plain = await task(t, f, f.sub, { title: 'Plain' })
    const shownParent = await task(t, f, f.sub, { title: 'Shown parent' })
    const ofShown = await task(t, f, f.sub2, {
      title: 'Of the shown parent',
      parent_id: shownParent.id,
    })
    const hiddenParent = await task(t, f, sibling, { title: 'Hidden parent' })
    const ofHidden = await task(t, f, f.sub, {
      title: 'Of the hidden parent',
      parent_id: hiddenParent.id,
    })
    // created under the rule of one level, so it reads no subtask
    const recent = await task(t, f, f.sub, {
      title: 'Recent',
      parent_id: shownParent.id,
      created_at: '2026-11-01T00:00:00.000Z',
    })
    const withArchived = await task(t, f, f.sub, { title: 'Only an archived subtask' })
    await task(t, f, f.sub, { parent_id: withArchived.id, archived_at: NOW })
    const withHidden = await task(t, f, f.sub, { title: 'Only a hidden subtask' })
    await task(t, f, sibling, { parent_id: withHidden.id })
    const withShelved = await task(t, f, f.sub, { title: 'Only a shelved subtask' })
    await task(t, f, shelved, { parent_id: withShelved.id })
    const answer = okOf(await pick(t, f.guest, open.id, 'subtask'))
    expect(answer.rows.map((r) => [r.title, r.parent_id ?? null, r.has_hidden_parent])).toEqual([
      ['Plain', null, false],
      ['Of the hidden parent', null, true],
      ['Recent', shownParent.id, false],
      ['Of the shown parent', shownParent.id, false],
    ])
    for (const out of [current, shownParent, withArchived, withHidden, withShelved])
      expect(answer.rows.map((r) => r.id)).not.toContain(out.id)
    expect(answer.rows.find((r) => r.id === ofHidden.id)).not.toHaveProperty('parent_id')
    expect(answer.rows.map((r) => r.id)).toContain(plain.id)
    expect(answer.rows.map((r) => r.id)).toContain(ofShown.id)
    expect(answer.rows.map((r) => r.id)).toContain(recent.id)
    // the rows carry the window's short row fields and the reader's level
    expect(answer.rows[0]).toMatchObject({
      id: plain.id,
      num: plain.num,
      level: 'user',
      project_id: f.sub.id,
    })
    expect(answer.rows[0]).not.toHaveProperty('description')
    expect(answer.rows[0]).not.toHaveProperty('window_key')
  })

  it('blocks a subtask and a task with 100 active subtasks, not one with 99 and an archived one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const above = await task(t, f, f.sub)
    const isSubtask = await task(t, f, f.sub, { parent_id: above.id })
    const full = await task(t, f, f.sub)
    await subtasksOf(t, f.sub, full, LIMITS.subtasks.max)
    const roomy = await task(t, f, f.sub)
    await subtasksOf(t, f.sub, roomy, LIMITS.subtasks.max - 1)
    await task(t, f, f.sub, { parent_id: roomy.id, archived_at: NOW })
    expect(okOf(await pick(t, f.user, isSubtask.id, 'subtask'))).toMatchObject({
      rows: [],
      blocked: 'is_subtask',
    })
    expect(okOf(await pick(t, f.user, full.id, 'subtask'))).toMatchObject({
      rows: [],
      blocked: 'full',
    })
    const open = okOf(await pick(t, f.user, roomy.id, 'subtask'))
    expect(open.blocked).toBeNull()
    expect(open.rows.length).toBeGreaterThan(0)
  })
})

describe('the Linked tasks picker', () => {
  it("lists the family first, never the task or one it is linked to, and the organization's other projects only once asked", async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const own = await task(t, f, f.sub)
    const inPcb = await task(t, f, f.sub2)
    const onMeta = await task(t, f, f.meta)
    const blocking = await task(t, f, f.sub2)
    const blocked = await task(t, f, f.sub)
    const related = await task(t, f, f.hidden)
    const elsewhere = await task(t, f, f.hidden)
    await t.run(async (ctx) => {
      await ctx.db.insert('issue_links', linkRow(f, blocking, open.id))
      await ctx.db.insert('issue_links', linkRow(f, open, blocked.id))
      await ctx.db.insert('issue_links', linkRow(f, open, related.id, 'relates'))
    })
    const family = await batches(t, f.user, open.id, 'link')
    expect(idsOf(family)).toEqual([own.id, inPcb.id, onMeta.id])
    const end = family.at(-1) as Batch
    expect(end.next).toBeNull()
    expect(end.all_projects).toEqual(expect.any(String))
    const all = await batches(t, f.user, open.id, 'link', { all: true })
    expect(idsOf(all)).toEqual([own.id, inPcb.id, onMeta.id, elsewhere.id])
    expect(all.at(-1)).toMatchObject({ next: null, all_projects: null })
    // a cursor of the other projects opens only for Linked tasks
    await expectRefusal(
      pick(t, f.user, open.id, 'parent', { cursor: end.all_projects as string }),
      'bad_request',
    )
  })

  it('blocks a task with 100 links, whatever their other ends, not one with 99', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const other = await task(t, f, f.sub2)
    const ends = await plantTasks(t, f.hidden, LIMITS.links.max)
    await t.run(async (ctx) => {
      for (const end of ends.slice(0, LIMITS.links.max - 1))
        await ctx.db.insert('issue_links', linkRow(f, end, open.id))
    })
    expect(okOf(await pick(t, f.guest, open.id, 'link'))).toMatchObject({
      rows: [expect.objectContaining({ id: other.id })],
      blocked: null,
    })
    await t.run((ctx) =>
      ctx.db.insert('issue_links', linkRow(f, open, (ends.at(-1) as Doc<'issues'>).id)),
    )
    expect(okOf(await pick(t, f.guest, open.id, 'link'))).toMatchObject({
      rows: [],
      blocked: 'full',
    })
  })

  it('blocks a task with 100 links for a reader without Edit on it only where a batch could offer them a task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    await task(t, f, f.sub2)
    const ends = await plantTasks(t, f.hidden, LIMITS.links.max)
    const far = await task(t, f, f.hidden, { num: 960_001 })
    await t.run(async (ctx) => {
      for (const end of ends) await ctx.db.insert('issue_links', linkRow(f, end, open.id))
    })
    // a Viewer seat edits no project, so neither batch tells them how many
    // links the task has, which counts links to tasks they cannot see
    const unblocked = { state: 'ok', rows: [], next: null, stopped: false, blocked: null }
    const family = okOf(await pick(t, f.viewer, open.id, 'link'))
    expect(family).toEqual({ ...unblocked, all_projects: expect.any(String) })
    const cursor = family.all_projects as string
    expect(await pick(t, f.viewer, open.id, 'link', { cursor })).toEqual({
      ...unblocked,
      all_projects: null,
    })
    // one who views the task and edits Skunkworks gets the block where a
    // batch could offer a Skunkworks task, as their link would be refused
    const me = await seat(t, f)
    await t.run(async (ctx) => {
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: me.id,
        level: 'viewer',
      })
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: me.id,
        level: 'user',
      })
    })
    const mine = okOf(await pick(t, me, open.id, 'link'))
    expect(mine).toEqual({ ...unblocked, all_projects: expect.any(String) })
    const blockedBatch = { ...unblocked, all_projects: null, blocked: 'full' }
    expect(await pick(t, me, open.id, 'link', { cursor: mine.all_projects as string })).toEqual(
      blockedBatch,
    )
    expect(await pick(t, me, open.id, 'link', { search: issueKey(far.num) })).toEqual(blockedBatch)
  })
})

describe('search', () => {
  it('matches every fragment in the ID or the title, in any order and case, inside words, never in the text', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub, { num: 1 })
    const a = await task(t, f, f.sub, { title: 'Check the power rails', num: 43_210 })
    const b = await task(t, f, f.sub2, { title: 'Rail power budget' })
    await task(t, f, f.sub, { title: 'Thermal soak', description: 'power rails drift' })
    const search = (text: string) => allIds(t, f.user, open.id, 'link', { search: text })
    expect(await search('RAIL pow')).toEqual([a.id, b.id])
    expect(await search('ail')).toEqual([a.id, b.id])
    expect(await search('rails power')).toEqual([a.id])
    expect(await search('drift')).toEqual([])
    // a fragment of the task ID
    expect(await search('qn-4321')).toEqual([a.id])
    expect(await search('  ')).toEqual(expect.arrayContaining([a.id, b.id]))
  })

  it("puts a typed task ID's task first and once, outside the order too", async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub, { num: 1 })
    await task(t, f, f.sub, { num: 7 })
    const seventy = await task(t, f, f.sub2, { num: 70 })
    const seven = await task(t, f, f.sub2, { num: 77 })
    const late = await task(t, f, f.meta, { num: 700 })
    RELATION_PICKER.rows = 1
    // QN-700 holds QN-70, and QN-7 and QN-77 do not
    const list = await batches(t, f.user, open.id, 'parent', { search: 'QN-70' })
    expect(list[0]?.rows).toEqual([expect.objectContaining({ id: seventy.id, exact: true })])
    expect(idsOf(list)).toEqual([seventy.id, late.id])
    const bare = await batches(t, f.user, open.id, 'link', { search: '77' })
    expect(idsOf(bare)).toEqual([seven.id])
    expect(bare[0]?.rows[0]?.exact).toBe(true)
  })
})

describe('Done tasks', () => {
  it('offers a Done task not yet archived in every picker, and never an archived Done task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const done = await task(t, f, f.sub2, {
      title: 'Wombat finished',
      status: 'done',
      done_at: NOW,
    })
    await task(t, f, f.sub2, {
      title: 'Wombat filed away',
      status: 'done',
      done_at: NOW,
      archived_at: NOW,
    })
    for (const kind of ['parent', 'subtask', 'link'] as const)
      expect(await allIds(t, f.user, open.id, kind, { search: 'wombat', all: true }), kind).toEqual(
        [done.id],
      )
  })
})

describe('order and continuation', () => {
  it('answers the scope in its order a batch at a time, every eligible task once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const later = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const open = await task(t, f, f.sub2)
    const inFw = await plantTasks(t, f.sub, 3)
    const inPcb = await plantTasks(t, f.sub2, 4)
    const inLater = await plantTasks(t, later, 2)
    const onMeta = await plantTasks(t, f.meta, 2)
    RELATION_PICKER.rows = 2
    const list = await batches(t, f.user, open.id, 'parent')
    const want = [...inPcb, ...inFw, ...inLater, ...onMeta].map((x) => x.id)
    expect(idsOf(list)).toEqual(want)
    expect(list.slice(0, -1).every((b) => b.rows.length === 2 && !b.stopped)).toBe(true)
    // the scope's last row ends the list without one more batch
    expect(list).toHaveLength(Math.ceil(want.length / 2))
  })

  it('stops after RELATION_PICKER.scan tasks, says so, and goes on', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    await plantTasks(t, f.sub, 7)
    const last = await task(t, f, f.sub2, { title: 'Needle' })
    RELATION_PICKER.scan = 3
    const list = await batches(t, f.user, open.id, 'link', { search: 'needle' })
    expect(idsOf(list)).toEqual([last.id])
    expect(list.slice(0, -1).every((b) => b.stopped && b.next !== null)).toBe(true)
    expect(list.at(-1)).toMatchObject({ next: null, stopped: false })
    // seven tasks and the opened one before the needle, three a batch
    expect(list.slice(0, 2).every((b) => b.rows.length === 0)).toBe(true)
    expect(list.length).toBeGreaterThan(2)
  })

  it('costs no row and repeats none when a project leaves the scope between batches', async () => {
    const t = newT()
    const f = await withOrg(t)
    const later = await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
    const open = await task(t, f, f.sub)
    const [a1, a2, a3] = await plantTasks(t, f.sub, 3)
    const [b1] = await plantTasks(t, f.sub2, 2)
    const [c1, c2] = await plantTasks(t, later, 2)
    RELATION_PICKER.rows = 2
    const first = okOf(await pick(t, f.user, open.id, 'link'))
    expect(first.rows.map((r) => r.id)).toEqual([a1?.id, a2?.id])
    const second = okOf(await pick(t, f.user, open.id, 'link', { cursor: first.next as string }))
    expect(second.rows.map((r) => r.id)).toEqual([a3?.id, b1?.id])
    // PCB is archived while the batch stands inside it
    await t.run((ctx) => ctx.db.patch(f.sub2._id, { archived_at: NOW }))
    const third = okOf(await pick(t, f.user, open.id, 'link', { cursor: second.next as string }))
    expect(third.rows.map((r) => r.id)).toEqual([c1?.id, c2?.id])
  })

  it('refuses a cursor read before the opened task moved, so no row is skipped as if the list ended', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const inFw = await plantTasks(t, f.sub, 2)
    const inPcb = await plantTasks(t, f.sub2, 3)
    RELATION_PICKER.rows = 3
    const first = okOf(await pick(t, f.user, open.id, 'link'))
    // FW's two tasks, then PCB's first, so the batch stands inside PCB
    expect(first.rows.map((r) => r.id)).toEqual([...inFw, inPcb[0]].map((x) => x?.id))
    const cursor = first.next as string
    // the same cursor goes on while the task stays, and the family's end
    // offers Search all your projects
    const second = okOf(await pick(t, f.user, open.id, 'link', { cursor }))
    expect(second.rows.map((r) => r.id)).toEqual(inPcb.slice(1).map((x) => x.id))
    const all = second.all_projects as string
    expect(all).toEqual(expect.any(String))
    // someone moves the opened task into PCB, so the cursors' places no
    // longer name the projects they read. Read on, the first would skip
    // PCB's last tasks and FW and end the list
    await t.run((ctx) => ctx.db.patch(open._id, { project_id: f.sub2.id }))
    for (const [why, at] of [
      ['Load more', cursor],
      ['Search all your projects', all],
    ] as const)
      await expectRefusal(
        pick(t, f.user, open.id, 'link', { cursor: at }),
        'bad_request',
        new RegExp(RELATION_CURSOR_REFUSAL),
      ).catch((e) => {
        throw new Error(`${why}: ${String(e)}`)
      })
    // the list read again from its start reaches every task, PCB's first
    expect(await allIds(t, f.user, open.id, 'link')).toEqual([...inPcb, ...inFw].map((x) => x.id))
  })
})

describe('the budget', () => {
  it('stops with the rows so far under a lowered batch budget, and reaches every eligible task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    const all = await plantTasks(t, f.sub, 6)
    // room for the step's rows and two parent checks
    RELATION_PICKER.reads.bytes = 600 * 1024
    const list = await batches(t, f.user, open.id, 'parent')
    expect(idsOf(list)).toEqual(all.map((x) => x.id))
    expect(list[0]).toMatchObject({ stopped: true })
    expect(list[0]?.rows).toHaveLength(2)
    expect(list.at(-1)?.stopped).toBe(false)
  })

  it('answers over_budget when the reads before the batch leave no room for it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const open = await task(t, f, f.sub)
    await task(t, f, f.sub)
    expect((await pick(t, f.user, open.id, 'link')).state).toBe('ok')
    RELATION_PICKER.whole = { ...RELATION_PICKER.reads }
    for (const kind of ['parent', 'subtask', 'link'] as const)
      expect(await pick(t, f.user, open.id, kind)).toEqual({ state: 'over_budget' })
  })
})

describe('what hidden data moves', () => {
  it('answers the same whatever the hidden tasks hold, how many hidden subtasks a candidate has, and the family a reader cannot see', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const open = await task(t, f, f.sub)
    const candidates = await plantTasks(t, f.sub, 6, (i) => ({ title: `Board ${i}` }))
    const secrets = [
      await task(t, f, sibling, { title: 'Board secret' }),
      await task(t, f, f.hidden, { title: 'Board skunk' }),
    ]
    // a batch of the Parent and Subtasks pickers holds two parent checks
    // by its documents, and one of Linked tasks two ranges
    const read = async () => {
      const out: Batch[][] = []
      for (const kind of ['parent', 'subtask', 'link'] as const) {
        Object.assign(RELATION_PICKER, structuredClone(DEFAULT_PICKER))
        if (kind === 'link') RELATION_PICKER.reads.ranges = 2
        else RELATION_PICKER.reads.documents = 250
        out.push(await batches(t, f.guest, open.id, kind, { search: 'board', all: true }))
      }
      return out
    }
    const before = await read()
    expect(before[0]?.map((b) => b.rows.length)).toEqual([2, 2, 2])
    expect(before[0]?.[0]).toMatchObject({ stopped: true })
    expect(before[2]?.[0]).toMatchObject({ stopped: true })
    // the hidden titles grow to the title limit, each candidate gets 99
    // subtasks the guest cannot see, two candidates' to each of three
    // hidden sub-projects, so none holds more than 300 open tasks, the
    // family gets hidden and archived sub-projects, and the opened task 40
    // links to tasks the guest cannot see
    await t.run(async (ctx) => {
      for (const x of secrets)
        await ctx.db.patch(x._id, { title: `Board ${'x'.repeat(LIMITS.title.max - 6)}` })
    })
    const hiddenSubs = [
      sibling,
      await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id }),
      await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id }),
    ]
    for (const [i, c] of candidates.entries())
      await subtasksOf(
        t,
        hiddenSubs[Math.floor(i / 2)] as Doc<'projects'>,
        c,
        LIMITS.subtasks.max - 1,
      )
    for (let i = 0; i < 5; i++) {
      await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: f.meta.id })
      await plantProject(t, {
        org_id: f.org.id,
        type: 'project',
        parent_id: f.meta.id,
        archived_at: NOW,
      })
    }
    const ends = await plantTasks(t, f.hidden, 40)
    await t.run(async (ctx) => {
      for (const end of ends) await ctx.db.insert('issue_links', linkRow(f, open, end.id))
    })
    // the subtask picker leaves out the candidates that now have subtasks,
    // so it is compared before them
    const after = await read()
    expect(after[0]).toEqual(before[0])
    expect(after[2]).toEqual(before[2])
    expect(idsOf(after[1] ?? [])).toEqual([])
    // one more hidden subtask fills a candidate, which the write would
    // refuse too, so the answer does change
    Object.assign(RELATION_PICKER, structuredClone(DEFAULT_PICKER))
    await subtasksOf(t, sibling, candidates[0] as Doc<'issues'>, 1)
    expect(idsOf(await batches(t, f.guest, open.id, 'parent', { search: 'board' }))).toEqual(
      candidates.slice(1).map((x) => x.id),
    )
  })

  it('stops alike whether Subtasks candidates share a hidden parent or have their own, in the family or outside it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const open = await task(t, f, f.sub)
    const candidates = await plantTasks(t, f.sub, 8, (i) => ({ title: `Board ${i}` }))
    // parents the guest cannot see, in the family's hidden sibling and in
    // Skunkworks, another top-level project, where only data from before
    // the rule that a subtask stays in its parent's top-level project has
    // them
    const inSibling = await plantTasks(t, sibling, candidates.length)
    const inSkunkworks = await plantTasks(t, f.hidden, candidates.length)
    const runs: [string, (i: number) => Doc<'issues'>][] = [
      ['one parent in the family', () => inSibling[0] as Doc<'issues'>],
      ['a parent each in the family', (i) => inSibling[i] as Doc<'issues'>],
      ['one parent outside the family', () => inSkunkworks[0] as Doc<'issues'>],
      ['a parent each outside the family', (i) => inSkunkworks[i] as Doc<'issues'>],
    ]
    // room for the scan's ranges and one candidate's checks a batch, so the
    // batch count decides every stop
    RELATION_PICKER.reads.ranges = 15
    const shapes: [string, unknown][] = []
    for (const [name, parentOf] of runs) {
      await t.run(async (ctx) => {
        for (const [i, c] of candidates.entries())
          await ctx.db.patch(c._id, { parent_id: parentOf(i).id })
      })
      const list = await batches(t, f.guest, open.id, 'subtask', { search: 'board' })
      expect(idsOf(list), name).toEqual(candidates.map((c) => c.id))
      shapes.push([
        name,
        list.map((b) => [
          b.rows.map((r) => [r.id, r.parent_id ?? null, r.has_hidden_parent]),
          b.stopped,
          b.next === null,
        ]),
      ])
    }
    const [, first] = shapes[0] as [string, unknown[]]
    // the count binds, so the runs compare where batches stop
    expect(first.length).toBeGreaterThan(1)
    for (const [name, shape] of shapes.slice(1)) expect(shape, name).toEqual(first)
  })

  it('reads a typed number alike whether it names a hidden, an archived, a foreign or no task', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sibling = await plantHiddenSibling(t, f, f.guest)
    const open = await task(t, f, f.sub)
    await plantTasks(t, f.sub, 9)
    await task(t, f, sibling, { num: 610_001 })
    await task(t, f, f.sub, { num: 610_002, archived_at: NOW })
    await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id, num: 610_003 })
    await task(t, f, f.sub2, { num: 610_005 })
    // room for the typed lookup and two ranges of the scope's tasks
    RELATION_PICKER.reads.ranges = 1 + PROJECT_ASK.ranges + PROJECT_READ.ranges + 2
    const shape = async (num: number) =>
      (await batches(t, f.guest, open.id, 'link', { search: issueKey(num) })).map((b) => [
        b.rows.map((r) => r.num),
        b.stopped,
        b.next === null,
      ])
    const alike = await shape(610_004)
    for (const num of [610_001, 610_002, 610_003])
      expect(await shape(num), String(num)).toEqual(alike)
    // a shown task by its number is a row, so that answer differs
    expect(await shape(610_005)).not.toEqual(alike)
  })
})
