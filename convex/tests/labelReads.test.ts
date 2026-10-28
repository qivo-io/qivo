/* The label lists on the server (labels.ts settingsPage, picker and byIds,
 * through model/labels.ts labelBatch) and the bounded label write check
 * (lib/access.ts canWriteOrgLabels): name order with duplicates, batches of
 * LIST_BATCH with an honest end, search over the whole list, budgets that
 * stop a batch without a false end, batches kept live between cursors,
 * usage counts that are never a false zero, exact name lookups, the label
 * write rule read from the caller's own rows, and the refusals. The last
 * suite runs the reads at 20,000 labels under Convex's transaction limits
 * and logs what each call read. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import {
  canWriteOrgLabels,
  isOrgStaff,
  LABEL_WRITE_READ,
  levelRank,
  orgProjects,
  projectLevelsForOrg,
} from '../lib/access'
import { archiveCursorText } from '../lib/archivedTasks'
import { ORG_DELETING } from '../lib/billingAccess'
import { LEVEL_RANK, ORG_ROLES, PROFILE_KINDS } from '../lib/enums'
import { BY_IDS_MAX, LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ, namedCeiling } from '../lib/namedPages'
import { sha256hex } from '../machine/auth'
import { labelCountRun, shownCount } from '../model/labelCounts'
import { LABEL_RIGHTS_UNCHECKED, labelBatch, labelJson, labelListAsk } from '../model/labels'
import { SHAPES } from './accessShapes.setup'
import {
  as,
  expectListCounts,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'label-reads-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_WRITE_READ = { ...LABEL_WRITE_READ }
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(LABEL_WRITE_READ, DEFAULT_WRITE_READ)
})

/* --------------------------------------------------------------- fixtures */

/** Labels of `orgId` planted raw, in this order, with a count row each
 * unless `counts` is false. */
async function plantLabels(
  t: T,
  orgId: string,
  names: readonly string[],
  counts = true,
): Promise<Doc<'labels'>[]> {
  return await t.run(async (ctx) => {
    const out: Doc<'labels'>[] = []
    for (const name of names) out.push(await insertLabel(ctx, orgId, name, counts))
    return out
  })
}

/* One label planted raw, with a count row of 0 when `counted`. */
async function insertLabel(ctx: MutationCtx, orgId: string, name: string, counted = true) {
  const id = uuid()
  const _id = await ctx.db.insert('labels', {
    id,
    org_id: orgId,
    name,
    name_lower: name.toLowerCase(),
    color: '#4C9AFF',
    created_at: NOW,
  })
  if (counted) {
    await ctx.db.insert('label_counts', {
      label_id: id,
      org_id: orgId,
      active_tasks: 0,
      revision: 0,
    })
  }
  return (await ctx.db.get(_id)) as Doc<'labels'>
}

/** `n` names that sort in the order given, `prefix00`, `prefix01`, …, with
 * as many digits as the last needs. */
const names = (prefix: string, n: number) =>
  Array.from(
    { length: n },
    (_, i) => `${prefix}${String(i).padStart(Math.max(2, String(n - 1).length), '0')}`,
  )

type ListArgs = { search?: string; after?: string; through?: string }

const settings = (t: T, who: Doc<'profiles'>, org_id: string, a: ListArgs = {}) =>
  as(t, who).query(api.labels.settingsPage, { org_id, ...a })

const picker = (t: T, who: Doc<'profiles'>, org_id: string, a: ListArgs = {}) =>
  as(t, who).query(api.labels.picker, { org_id, ...a })

/** Every batch of a list from its start, following `next` until it is null. */
async function batches<B extends { rows: { name: string }[]; next: string | null }>(
  read: (after?: string) => Promise<B>,
): Promise<B[]> {
  const out: B[] = []
  let after: string | undefined
  for (let round = 0; round < 10_000; round++) {
    const batch = await read(after)
    out.push(batch)
    if (batch.next === null) return out
    after = batch.next
  }
  throw new Error('the list did not end')
}

const rowNames = (bs: readonly { rows: { name: string }[] }[]) =>
  bs.flatMap((b) => b.rows.map((row) => row.name))

/* A staff person of the fixture's organization with a login. */
const staffSeat = (t: T, f: OrgFixture, name = 'Subject') =>
  plantSeat(t, { org_id: f.org.id, name, org_role: 'user', auth_user_id: `auth_${uuid()}` })

/* ------------------------------------------------------- settingsPage */

describe('labels.settingsPage', () => {
  it('orders by name_lower, then creation, with a batch boundary between two labels of one name', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 24 before them, so the first batch ends after the first of the two
    await plantLabels(t, f.org.id, [...names('l', 24), 'Twin', 'zed'])
    // a duplicate stored before names were unique, created after the first
    await plantLabels(t, f.org.id, ['twin'])
    const first = await settings(t, f.admin, f.org.id)
    expect(first.rows).toHaveLength(LIST_BATCH)
    expect(first.rows.at(-1)?.name).toBe('Twin')
    expect(first).toMatchObject({ stopped: false, counting: false, exact: null })
    const second = await settings(t, f.admin, f.org.id, { after: first.next ?? '' })
    expect(second.rows.map((row) => row.name)).toEqual(['twin', 'zed'])
    expect(second.next).toBeNull()
  })

  it('reads 60 labels in batches of 25, each once, and says the end in a batch that ends at the last', async () => {
    const t = newT()
    const f = await withOrg(t)
    const sixty = names('l', 60)
    await plantLabels(t, f.org.id, sixty)
    const read = await batches((after) => settings(t, f.admin, f.org.id, { after }))
    expect(read.map((b) => b.rows.length)).toEqual([25, 25, 10])
    expect(rowNames(read)).toEqual(sixty)
    for (const b of read) expect(b.stopped).toBe(false)

    const u = newT()
    const h = await withOrg(u)
    await plantLabels(u, h.org.id, names('l', 50))
    const fifty = await batches((after) => settings(u, h.admin, h.org.id, { after }))
    // the second batch is full and the last, so no third call is needed
    expect(fifty.map((b) => [b.rows.length, b.next === null])).toEqual([
      [25, false],
      [25, true],
    ])
  })

  it('searches every fragment in any order, ignoring case and accents, over the whole list', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, [...names('a', 60), 'Café', 'UI bug', 'Debug', 'zz cafeteria'])
    const find = async (search: string) =>
      rowNames(await batches((after) => settings(t, f.admin, f.org.id, { search, after })))
    // the matches lie past the first two batches of the plain list
    expect(await find('cafe')).toEqual(['Café', 'zz cafeteria'])
    expect(await find('CAFÉ')).toEqual(['Café', 'zz cafeteria'])
    expect(await find('bug ui')).toEqual(['UI bug'])
    expect(await find('bug')).toEqual(['Debug', 'UI bug'])
    expect(await find('nothing like it')).toEqual([])
    const all = await find('   ')
    expect(all).toHaveLength(64)
    expect((await settings(t, f.admin, f.org.id, { search: 'cafe' })).rows).toHaveLength(2)
  })

  it('stops a search at the read budget with only the matches so far, and goes on to every match and the end', async () => {
    const t = newT()
    const f = await withOrg(t)
    const list = names('l', 40)
    for (const at of [5, 22, 37]) list[at] = `${list[at]} needle`
    await plantLabels(t, f.org.id, list)
    // about ten labels a call
    NAMED_READ.documents = 12
    const read = await batches((after) =>
      settings(t, f.admin, f.org.id, { search: 'needle', after }),
    )
    expect(rowNames(read)).toEqual(['l05 needle', 'l22 needle', 'l37 needle'])
    expect(read.length).toBeGreaterThan(3)
    expect(read.slice(0, -1).every((b) => b.stopped)).toBe(true)
    // a batch that found nothing before the budget ended still goes on
    expect(read.some((b) => b.rows.length === 0 && b.next !== null)).toBe(true)
  })

  it('moves forward by one label a call when the request has no room left', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, names('l', 5))
    NAMED_READ.ranges = 0
    NAMED_READ.documents = 0
    NAMED_READ.bytes = 0
    const read = await batches((after) => settings(t, f.admin, f.org.id, { after }))
    expect(read.map((b) => [b.rows.length, b.stopped])).toEqual([
      [1, true],
      [1, true],
      [1, true],
      [1, true],
      [1, true],
      [0, false],
    ])
    expect(rowNames(read)).toEqual(names('l', 5))
  })

  it('keeps a batch live between two cursors as labels come, go and move', async () => {
    const t = newT()
    const f = await withOrg(t)
    const labels = await plantLabels(t, f.org.id, names('l', 60))
    const first = await settings(t, f.admin, f.org.id)
    const second = await settings(t, f.admin, f.org.id, { after: first.next ?? '' })
    const live = () =>
      settings(t, f.admin, f.org.id, { after: first.next ?? '', through: second.next ?? '' })
    const shown = async () => (await live()).rows.map((row) => row.name)
    expect(await shown()).toEqual(names('l', 60).slice(25, 50))
    const kept = await live()
    expect(kept).toMatchObject({ next: second.next, stopped: false })

    await plantLabels(t, f.org.id, ['l30 added', 'l10 before'])
    await t.run(async (ctx) => {
      await ctx.db.delete(labels[31]._id)
      // renamed past the batch's end
      await ctx.db.patch(labels[40]._id, { name: 'z40', name_lower: 'z40' })
    })
    const after = await shown()
    expect(after).toContain('l30 added')
    expect(after).not.toContain('l10 before')
    expect(after).not.toContain('l31')
    expect(after).not.toContain('z40')
    expect(after).toHaveLength(25 + 1 - 2)
    // the batch ends where it did, so the next one starts where it did
    expect((await live()).next).toBe(second.next)
    await expectRefusal(
      settings(t, f.admin, f.org.id, { after: second.next ?? '', through: first.next ?? '' }),
      'bad_request',
      /through must be a cursor after/,
    )
  })

  it('stops a batch under through that would hold more than four batches, for the app to split', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, names('l', 140))
    // the cursor after five batches, at the 125th label
    const five = (await batches((after) => settings(t, f.admin, f.org.id, { after }))).slice(0, 5)
    const end = five.at(-1)?.next ?? null
    expect(end).not.toBeNull()
    const wide = await settings(t, f.admin, f.org.id, { through: end ?? '' })
    expect(wide.rows).toHaveLength(4 * LIST_BATCH)
    expect(wide.stopped).toBe(true)
    const rest = await settings(t, f.admin, f.org.id, {
      after: wide.next ?? '',
      through: end ?? '',
    })
    expect(rest).toMatchObject({ stopped: false, next: end })
    expect(rest.rows).toHaveLength(125 - 4 * LIST_BATCH)
  })

  it('answers active_tasks from the count rows, and never a missing count as zero', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [counted, plain, foreign] = await t.run(async (ctx) => [
      await insertLabel(ctx, f.org.id, 'Counted'),
      await insertLabel(ctx, f.org.id, 'Plain', false),
      await insertLabel(ctx, f.org.id, 'Foreign', false),
    ])
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('label_counts')
        .withIndex('by_label', (q) => q.eq('label_id', counted.id))
        .unique()
      if (row !== null) await ctx.db.patch(row._id, { active_tasks: 7 })
      // a row that names another organization
      await ctx.db.insert('label_counts', {
        label_id: foreign.id,
        org_id: f.otherOrg.id,
        active_tasks: 3,
        revision: 0,
      })
    })
    const counts = async () =>
      Object.fromEntries(
        (await settings(t, f.admin, f.org.id)).rows.map((row) => [row.name, row.active_tasks]),
      )
    expect(await counts()).toEqual({ Counted: 7, Plain: null, Foreign: null })
    expect(plain.id).not.toBe(counted.id)

    const run = await t.run((ctx) =>
      ctx.db.insert('label_count_runs', { org_id: f.org.id, counting: true, through: 0 }),
    )
    const counting = await settings(t, f.admin, f.org.id, { search: 'counted' })
    expect(counting).toMatchObject({ counting: true })
    expect(counting.rows.map((row) => row.active_tasks)).toEqual([null])
    expect(counting.exact).toMatchObject({ name: 'Counted', active_tasks: null })
    expect(await counts()).toEqual({ Counted: null, Plain: null, Foreign: null })
    await t.run((ctx) => ctx.db.delete(run))
    expect(await counts()).toEqual({ Counted: 7, Plain: null, Foreign: null })
  })

  it('agrees with the counted rows after task writes through the public functions', async () => {
    const t = newT()
    const f = await withOrg(t)
    const label = async (name: string) => {
      const id = uuid()
      await as(t, f.admin).mutation(api.labels.create, {
        org_id: f.org.id,
        id,
        name,
        color: '#4C9AFF',
      })
      return id
    }
    const hw = await label('Hardware')
    const fw = await label('Firmware')
    const task = async (title: string) => {
      const id = uuid()
      await as(t, f.user).mutation(api.issues.create, {
        org_id: f.org.id,
        id,
        project_id: f.sub.id,
        title,
      })
      return id
    }
    const [a, b, c] = [await task('A'), await task('B'), await task('C')]
    const toggle = (issue_id: string, label_id: string, on: boolean) =>
      as(t, f.user).mutation(api.labels.toggle, { org_id: f.org.id, issue_id, label_id, on })
    await toggle(a, hw, true)
    await toggle(b, hw, true)
    await toggle(b, fw, true)
    await toggle(c, fw, true)
    await toggle(c, fw, false)
    await t.mutation(internal.machine.rest.updateIssue, {
      callerId: f.admin.id,
      access: 'write',
      keyName: 'drive',
      ref: c,
      body: JSON.stringify({ add_labels: [fw] }),
    })
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: b })
    const page = await settings(t, f.admin, f.org.id)
    expect(page.rows.map((row) => [row.name, row.active_tasks])).toEqual([
      ['Firmware', 1],
      ['Hardware', 1],
    ])
    expect(await expectListCounts(t, f.org.id)).toBe(2)
    await as(t, f.user).mutation(api.issues.unarchive, { org_id: f.org.id, id: b })
    const back = await settings(t, f.admin, f.org.id)
    expect(back.rows.map((row) => row.active_tasks)).toEqual([2, 2])
  })

  it('finds an exact name in any case that no batch read, and none for a blank search', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, [...names('a', 40), 'Zeta Release'])
    NAMED_READ.documents = 12
    for (const search of ['zeta release', 'ZETA RELEASE', '  Zeta Release ']) {
      const b = await settings(t, f.admin, f.org.id, { search })
      expect(b.rows, search).toEqual([])
      expect(b.stopped, search).toBe(true)
      expect(b.exact, search).toMatchObject({ name: 'Zeta Release', active_tasks: 0 })
    }
    expect((await settings(t, f.admin, f.org.id, { search: 'zeta' })).exact).toBeNull()
    expect((await settings(t, f.admin, f.org.id)).exact).toBeNull()
    expect((await settings(t, f.admin, f.org.id, { search: '   ' })).exact).toBeNull()
  })
})

/* -------------------------------------------------------------- picker */

describe('labels.picker', () => {
  it('answers every seat, guests and viewers included, with names and colors only', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, ['Bug', 'Chore'])
    for (const who of [f.guest, f.viewer, f.user, f.admin]) {
      const b = await picker(t, who, f.org.id, { search: 'bug' })
      expect(b.rows, who.name).toEqual([{ id: b.rows[0]?.id, name: 'Bug', color: '#4C9AFF' }])
      expect(b.exact, who.name).toEqual(b.rows[0])
      expect(b.next, who.name).toBeNull()
    }
  })

  it('answers can_create in a first batch by the label rule, and leaves it out later', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, names('l', 30))
    const may = async (who: Doc<'profiles'>) => (await picker(t, who, f.org.id)).can_create
    expect(await may(f.admin)).toBe(true)
    expect(await may(f.user)).toBe(true) // leads TBED and SKNK
    expect(await may(f.viewer)).toBe(false) // a user grant on TBED, capped at viewer
    expect(await may(f.guest)).toBe(false) // a user grant on TBED, but not staff
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBe(false)

    const cases: [
      string,
      (ctx: MutationCtx, f: OrgFixture, me: Doc<'profiles'>) => Promise<unknown>,
      boolean,
    ][] = [
      ['nothing', async () => {}, false],
      ['lead of a meta', (ctx, f, me) => ctx.db.patch(f.hidden._id, { lead_id: me.id }), true],
      [
        'a user grant on a meta',
        (ctx, f, me) =>
          ctx.db.insert('project_access', {
            project_id: f.meta.id,
            profile_id: me.id,
            level: 'user',
          }),
        true,
      ],
      [
        'a user team share on a meta',
        async (ctx, f, me) => {
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
        },
        true,
      ],
      [
        'a viewer grant on a meta',
        (ctx, f, me) =>
          ctx.db.insert('project_access', {
            project_id: f.meta.id,
            profile_id: me.id,
            level: 'viewer',
          }),
        false,
      ],
      [
        'a user grant on a sub-project only',
        (ctx, f, me) =>
          ctx.db.insert('project_access', {
            project_id: f.sub.id,
            profile_id: me.id,
            level: 'user',
          }),
        false,
      ],
    ]
    for (const [name, plant, expected] of cases) {
      const u = newT()
      const h = await withOrg(u)
      const me = await staffSeat(u, h)
      await u.run((ctx) => plant(ctx, h, me))
      expect((await picker(u, me, h.org.id)).can_create, name).toBe(expected)
    }

    const first = await picker(t, f.admin, f.org.id)
    const later = await picker(t, f.admin, f.org.id, { after: first.next ?? '' })
    expect(later.rows).toHaveLength(5)
    expect('can_create' in later).toBe(false)
  })
})

/* ------------------------------------------------------ the write check */

/* The label rule as it was: projectLevelsForOrg over every project of the
 * organization, User standing or more on any meta. */
async function oldRule(ctx: QueryCtx, me: Doc<'profiles'>): Promise<boolean> {
  if (!isOrgStaff(me)) return false
  if (me.org_role === 'admin') return true
  const { levelOf } = await projectLevelsForOrg(ctx, me)
  for (const p of await orgProjects(ctx, me.org_id)) {
    if (p.type === 'meta' && levelRank(levelOf(p)) >= LEVEL_RANK.user) return true
  }
  return false
}

/* Shapes beyond SHAPES that only the label rule tells apart: archived
 * metas still count, and a top-level project that is not a meta never does. */
const LABEL_SHAPES: [
  string,
  (ctx: MutationCtx, f: OrgFixture, me: Doc<'profiles'>) => Promise<unknown>,
][] = [
  [
    'a user grant on an archived meta',
    async (ctx, f, me) => {
      await ctx.db.patch(f.hidden._id, { archived_at: NOW, lead_id: undefined })
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: me.id,
        level: 'user',
      })
    },
  ],
  [
    'lead of an archived meta',
    (ctx, f, me) => ctx.db.patch(f.hidden._id, { archived_at: NOW, lead_id: me.id }),
  ],
  [
    'a user team share on an archived meta',
    async (ctx, f, me) => {
      await ctx.db.patch(f.hidden._id, { archived_at: NOW })
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
    },
  ],
  [
    'a user grant and the lead of a top-level project that is not a meta',
    async (ctx, f, me) => {
      await ctx.db.patch(f.hidden._id, { type: 'project', lead_id: me.id })
      await ctx.db.insert('project_access', {
        project_id: f.hidden.id,
        profile_id: me.id,
        level: 'user',
      })
    },
  ],
]

describe('canWriteOrgLabels', () => {
  it('equals the old rule for every role and kind under every grant shape', async () => {
    const seen = new Set<string>()
    for (const [name, plant] of [...SHAPES, ...LABEL_SHAPES]) {
      const t = newT()
      const f = await withOrg(t)
      // the fixture's user leads both metas; the subject is plain staff
      const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
      await t.run((ctx) => plant(ctx, f, subject))
      await t.run(async (ctx) => {
        const callers = [
          ...ORG_ROLES.flatMap((org_role) =>
            PROFILE_KINDS.map((kind) => ({ ...subject, org_role, kind })),
          ),
          f.admin,
          f.user,
          f.viewer,
          f.guest,
          f.agent,
          f.otherAdmin,
        ]
        for (const me of callers) {
          const answer = await canWriteOrgLabels(ctx, me)
          expect(answer, `${name}: ${me.name} as ${me.org_role} ${me.kind}`).toBe(
            await oldRule(ctx, me),
          )
          if (me.id === subject.id && me.org_role === 'user') seen.add(`${name}: ${answer}`)
        }
      })
    }
    // the shapes reach both answers for plain staff
    const answers = [...seen].map((s) => s.endsWith('true'))
    expect(answers).toContain(true)
    expect(answers).toContain(false)
  }, 120_000)

  it('equals the old rule for every Northstar person', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    const answers = await t.run(async (ctx) => {
      const out: [string, boolean | null, boolean][] = []
      for (const me of profiles)
        out.push([me.name, await canWriteOrgLabels(ctx, me), await oldRule(ctx, me)])
      return out
    })
    for (const [name, answer, expected] of answers) expect(answer, name).toBe(expected)
    expect(answers.some(([, answer]) => answer === true)).toBe(true)
  })

  it('gives no rights through a meta under another meta, which no writer makes', async () => {
    const t = newT()
    const f = await withOrg(t)
    const subject = await plantSeat(t, { org_id: f.org.id, name: 'Subject' })
    await t.run(async (ctx) => {
      // createProjectCore refuses a meta with a parent; only bad data has one
      await ctx.db.patch(f.sub._id, { type: 'meta' })
      await ctx.db.insert('project_access', {
        project_id: f.sub.id,
        profile_id: subject.id,
        level: 'user',
      })
    })
    // the old rule read it as a meta of the tree; the check reads top-level
    // metas only, and fails closed
    expect(await t.run((ctx) => oldRule(ctx, subject))).toBe(true)
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, subject))).toBe(false)
  })

  it('answers null past its row cap or its read guard, and every create refuses with the sentence', async () => {
    const t = newT()
    const f = await withOrg(t)
    const person = await staffSeat(t, f, 'Many grants')
    const SECRET = `qva_${'labelchk'.repeat(6)}`
    const key_hash = await sha256hex(SECRET)
    await t.run(async (ctx) => {
      for (const me of [person, f.agent]) {
        for (let i = 0; i < 6; i++) {
          const project = uuid()
          await ctx.db.insert('project_access', {
            project_id: project,
            profile_id: me.id,
            level: 'viewer',
          })
        }
      }
      await ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'drive',
        key_prefix: SECRET.slice(0, 11),
        key_hash,
        created_at: NOW,
      })
    })
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, person))).toBe(false)
    LABEL_WRITE_READ.rows = 5
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, person))).toBeNull()
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.agent))).toBeNull()
    // proof before the cap still answers
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, f.user))).toBe(true)
    expect((await picker(t, person, f.org.id)).can_create).toBeNull()

    const before = await t.run((ctx) => ctx.db.query('labels').collect())
    await expectRefusal(
      as(t, person).mutation(api.labels.create, {
        org_id: f.org.id,
        id: uuid(),
        name: 'New',
        color: '#4C9AFF',
      }),
      'rule',
      new RegExp(LABEL_RIGHTS_UNCHECKED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    )
    const rest = await post(t, SECRET, '/v1/labels', { name: 'New', color: '#4C9AFF' })
    expect({ status: rest.status, text: await rest.text() }).toEqual({
      status: 400,
      text: JSON.stringify({ error: LABEL_RIGHTS_UNCHECKED }),
    })
    expect(await mcpTool(t, SECRET, 'set_label', { name: 'New', color: '#4C9AFF' })).toMatchObject({
      content: [{ type: 'text', text: LABEL_RIGHTS_UNCHECKED }],
      isError: true,
    })
    expect(await t.run((ctx) => ctx.db.query('labels').collect())).toEqual(before)

    // the read guard stops it too: a person in five teams without shares
    LABEL_WRITE_READ.rows = DEFAULT_WRITE_READ.rows
    const member = await staffSeat(t, f, 'Many teams')
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', {
          team_id: team,
          profile_id: member.id,
          is_leader: false,
        })
      }
    })
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, member))).toBe(false)
    LABEL_WRITE_READ.ranges = 6
    expect(await t.run((ctx) => canWriteOrgLabels(ctx, member))).toBeNull()
  })
})

/* --------------------------------------------------------------- byIds */

describe('labels.byIds', () => {
  it('answers the labels of the organization among the ids, each once', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [a, b, gone] = await plantLabels(t, f.org.id, ['Alpha', 'Beta', 'Gone'])
    const [foreign] = await plantLabels(t, f.otherOrg.id, ['Elsewhere'])
    await t.run((ctx) => ctx.db.delete(gone._id))
    const { rows } = await as(t, f.viewer).query(api.labels.byIds, {
      org_id: f.org.id,
      ids: [b.id, a.id, b.id, uuid(), foreign.id, gone.id],
    })
    expect(rows).toEqual([labelJson(b), labelJson(a)])
    const ids = Array.from({ length: BY_IDS_MAX }, () => a.id)
    expect((await as(t, f.guest).query(api.labels.byIds, { org_id: f.org.id, ids })).rows).toEqual([
      labelJson(a),
    ])
  })
})

/* ------------------------------------------------------------ refusals */

describe('refusals', () => {
  it('lets only active organization admins read settingsPage', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const who of [f.user, f.viewer, f.guest]) {
      await expectRefusal(
        settings(t, who, f.org.id),
        'forbidden',
        /only organization admins see the label list with its usage/,
      )
    }
  })

  it('refuses a login without a seat and an organization being deleted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const calls = (who: Doc<'profiles'>) => [
      settings(t, who, f.org.id),
      picker(t, who, f.org.id),
      as(t, who).query(api.labels.byIds, { org_id: f.org.id, ids: [] }),
    ]
    for (const call of calls(f.otherAdmin)) {
      await expectRefusal(call, 'forbidden', /no profile in this organization/)
    }
    await t.run((ctx) =>
      ctx.db.insert('org_removals', {
        org_id: f.org.id,
        reason: 'requested',
        ended_at: NOW,
        delete_after: NOW,
        phase: 'profiles',
        created_at: NOW,
      }),
    )
    for (const call of calls(f.admin))
      await expectRefusal(call, 'forbidden', new RegExp(ORG_DELETING))
  })

  it('refuses a long search, foreign or changed cursors and too many ids', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantLabels(t, f.org.id, names('l', 30))
    await plantLabels(t, f.otherOrg.id, names('o', 30))
    await expectRefusal(
      settings(t, f.admin, f.org.id, { search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
      new RegExp(LIMITS.search.refusal.replace(/[.]/g, '\\.')),
    )
    const next = (await settings(t, f.admin, f.org.id)).next ?? ''
    const searched = (await settings(t, f.admin, f.org.id, { search: 'l' })).next ?? ''
    const foreign = (await settings(t, f.otherAdmin, f.otherOrg.id)).next ?? ''
    const fromPicker = (await picker(t, f.admin, f.org.id)).next ?? ''
    const archive = await archiveCursorText({ created: 1, id: 'abc', archived_at: NOW }, f.meta.id)
    const flipped = `${next.slice(0, 20)}${next[20] === 'a' ? 'b' : 'a'}${next.slice(21)}`
    // a search with the same name key shares its cursors
    expect(
      (await settings(t, f.admin, f.org.id, { search: ' L ', after: searched })).rows,
    ).toHaveLength(5)
    const bad: [string, ListArgs][] = [
      ['malformed', { after: 'not a cursor' }],
      ['changed by one character', { after: flipped }],
      ['from another organization', { after: foreign }],
      ['from another search', { after: searched }],
      ['from the picker', { after: fromPicker }],
      ['an archive cursor', { after: archive }],
      ['longer than the bound', { after: `${next}${'0'.repeat(50_000)}` }],
      ['a malformed through', { through: 'x' }],
    ]
    for (const [name, args] of bad) {
      await expectRefusal(
        settings(t, f.admin, f.org.id, args),
        'bad_request',
        /cursors from an earlier answer/,
      ).catch((e: unknown) => {
        throw new Error(`${name}: ${String(e)}`)
      })
    }
    await expectRefusal(picker(t, f.admin, f.org.id, { after: next }), 'bad_request')
    await expectRefusal(
      as(t, f.admin).query(api.labels.byIds, {
        org_id: f.org.id,
        ids: Array.from({ length: BY_IDS_MAX + 1 }, () => uuid()),
      }),
      'bad_request',
      /at most 100 labels/,
    )
  })
})

/* ---------------------------------------------------------- real limits */

/** What one transaction read, from Convex's metrics. */
type Read = { ranges: number; documents: number; bytes: number }

/** `read` run in its own transaction, with what that transaction read. */
async function measured<R>(
  t: T,
  read: (ctx: QueryCtx) => Promise<R>,
): Promise<{ out: R; read: Read }> {
  return await t.run(async (ctx) => {
    const out = await read(ctx)
    const m = await ctx.meta.getTransactionMetrics()
    return {
      out,
      read: {
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        bytes: m.bytesRead.used,
      },
    }
  })
}

/* The settingsPage handler after the seat check, for its metrics. */
const settingsBatch = (ctx: QueryCtx, orgId: string, a: ListArgs) =>
  (async () => {
    const ask = await labelListAsk('labels.settings', orgId, a)
    const ceiling = await namedCeiling(ctx)
    const counting = (await labelCountRun(ctx, orgId)) !== null
    return await labelBatch(ctx, ask, {
      ceiling,
      row: async (label, lookup) => ({
        ...labelJson(label),
        active_tasks: shownCount(
          await lookup(() =>
            ctx.db
              .query('label_counts')
              .withIndex('by_label', (q) => q.eq('label_id', label.id))
              .unique(),
          ),
          label,
          counting,
        ),
      }),
    })
  })()

describe('real limits', () => {
  it('reads 20,000 labels inside the limits of one transaction a call', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const total = 20_000
    for (let from = 0; from < total; from += 2000) {
      await t.run(async (ctx) => {
        for (let i = from; i < from + 2000; i++) {
          await insertLabel(ctx, f.org.id, `Label ${String(i).padStart(5, '0')} hardware`)
        }
      })
    }
    // a first batch without search
    const first = await measured(t, (ctx) => settingsBatch(ctx, f.org.id, {}))
    console.log('settingsPage first batch', first.read)
    expect(first.out.rows).toHaveLength(LIST_BATCH)
    expect(first.read.ranges).toBeLessThan(100)
    expect(first.read.documents).toBeLessThan(100)
    expect(first.read.bytes).toBeLessThan(40_000)
    expect((await settings(t, f.admin, f.org.id)).rows).toHaveLength(LIST_BATCH)

    // a search that matches nothing stops with a cursor and reaches the end
    let after: string | undefined
    const calls: (Read & { stopped: boolean })[] = []
    for (;;) {
      const b = await measured(t, (ctx) =>
        settingsBatch(ctx, f.org.id, { search: 'nomatch', after }),
      )
      calls.push({ ...b.read, stopped: b.out.stopped })
      expect(b.out.rows).toEqual([])
      if (b.out.next === null) break
      expect(b.out.stopped).toBe(true)
      // the public query answers the same without a limit error
      const pub = await settings(t, f.admin, f.org.id, { search: 'nomatch', after })
      expect(pub.next !== null).toBe(true)
      after = b.out.next
    }
    console.log('settingsPage search that matches nothing, per call', calls)
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.documents).toBeLessThanOrEqual(NAMED_READ.documents + 16)
      expect(call.bytes).toBeLessThan(NAMED_READ.bytes)
    }

    // the picker's first batch for staff with 2,000 viewer grants and no proof
    const person = await staffSeat(t, f, 'Viewer of many')
    await t.run(async (ctx) => {
      for (let i = 0; i < 2000; i++) {
        await ctx.db.insert('project_access', {
          project_id: uuid(),
          profile_id: person.id,
          level: 'viewer',
        })
      }
    })
    const check = await measured(t, (ctx) => canWriteOrgLabels(ctx, person))
    console.log('canWriteOrgLabels over 2,000 viewer grants', check)
    expect(check.out).toBe(false)
    expect((await picker(t, person, f.org.id)).can_create).toBe(false)
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: uuid(),
        profile_id: person.id,
        level: 'viewer',
      }),
    )
    const past = await measured(t, (ctx) => canWriteOrgLabels(ctx, person))
    console.log('canWriteOrgLabels over 2,001 viewer grants', past)
    expect(past.out).toBeNull()
    const pickerBatch = await picker(t, person, f.org.id)
    expect(pickerBatch).toMatchObject({ can_create: null })
    expect(pickerBatch.rows).toHaveLength(LIST_BATCH)

    // staff in about LABEL_WRITE_READ.rows teams, each sharing a sub-project
    // as User, which costs three ranges a membership and proves nothing: the
    // check stops at its own ceiling, and a picker search that reads the
    // walk's whole share after it still answers inside the limits
    const member = await staffSeat(t, f, 'Member of many')
    await plantTeams(t, f, member, 2000, f.sub.id)
    const both = await measured(t, async (ctx) => {
      const may = await canWriteOrgLabels(ctx, member)
      const checked = await ctx.meta.getTransactionMetrics()
      const ask = await labelListAsk('labels.picker', f.org.id, { search: 'nomatch' })
      const batch = await labelBatch(ctx, ask, {
        ceiling: await namedCeiling(ctx),
        row: async (label) => labelJson(label),
      })
      return { may, checkRanges: checked.databaseQueries.used, stopped: batch.stopped }
    })
    console.log('canWriteOrgLabels over 2,000 shared teams, then a picker search', both)
    expect(both.out).toMatchObject({ may: null, stopped: true })
    expect(both.out.checkRanges).toBeLessThanOrEqual(LABEL_WRITE_READ.ranges + 4)
    expect(both.read.ranges).toBeLessThan(4096 - 16)
    const searched = await picker(t, member, f.org.id, { search: 'nomatch' })
    expect(searched).toMatchObject({ can_create: null, rows: [], stopped: true })
  }, 300_000)

  it("reads the caller's rights once in a REST or MCP create whose proof takes most of the request", async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // a proof past 700 shared teams, three ranges each, more than half of
    // Convex's 4,096, under a ceiling that lets one check read them
    LABEL_WRITE_READ.ranges = 3000
    await plantTeams(t, f, f.agent, 700, f.sub.id)
    await plantTeams(t, f, f.agent, 1, f.meta.id)
    const proof = await measured(t, (ctx) => canWriteOrgLabels(ctx, f.agent))
    console.log('canWriteOrgLabels past 700 shared teams', proof)
    expect(proof.out).toBe(true)
    expect(proof.read.ranges).toBeGreaterThan(2100)
    const SECRET = `qva_${'labelone'.repeat(6)}`
    const key_hash = await sha256hex(SECRET)
    await t.run((ctx) =>
      ctx.db.insert('agent_keys', {
        id: uuid(),
        profile_id: f.agent.id,
        name: 'drive',
        key_prefix: SECRET.slice(0, 11),
        key_hash,
        created_at: NOW,
      }),
    )
    const rest = await post(t, SECRET, '/v1/labels', { name: 'Once', color: '#4C9AFF' })
    expect(rest.status, await rest.text()).toBe(201)
    const mcp = await mcpTool(t, SECRET, 'set_label', { name: 'Twice', color: '#4C9AFF' })
    expect(mcp).not.toHaveProperty('isError')
    const names = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('labels')
          .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
          .collect()
      ).map((label) => label.name),
    )
    expect(names.sort()).toEqual(['Once', 'Twice'])
  }, 300_000)
})

/** `n` teams of the fixture's organization that `me` belongs to, each
 * sharing the project `projectId` with User access. */
async function plantTeams(t: T, f: OrgFixture, me: Doc<'profiles'>, n: number, projectId: string) {
  for (let from = 0; from < n; from += 1000) {
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + 1000); i++) {
        const team = uuid()
        await ctx.db.insert('teams', {
          id: team,
          org_id: f.org.id,
          name: `Team ${i}`,
          track_delay_default: false,
          created_at: NOW,
        })
        await ctx.db.insert('team_members', { team_id: team, profile_id: me.id, is_leader: false })
        await ctx.db.insert('project_team_access', {
          project_id: projectId,
          team_id: team,
          level: 'user',
        })
      }
    })
  }
}

/* The HTTP door of `t`, which convex-test has and its type leaves out. */
type Http = {
  fetch(
    path: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ): Promise<{ status: number; text(): Promise<string> }>
}

/** A POST of `body` as JSON to `path` with the bearer `secret`. */
const post = (t: T, secret: string, path: string, body: unknown, headers = {}) =>
  (t as unknown as Http).fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

/** The result of one MCP tool call over HTTP with the bearer `secret`. */
async function mcpTool(t: T, secret: string, name: string, args: Record<string, unknown>) {
  const res = await post(
    t,
    secret,
    '/mcp',
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'label-reads', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      id: 1,
    },
    {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
  )
  expect(res.status).toBe(200)
  return (JSON.parse(await res.text()) as { result: Record<string, unknown> }).result
}
