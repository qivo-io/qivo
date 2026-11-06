/* Settings › Users and Organization › General's creators line read from
 * the server (people.ts settingsPage, get and byIds, tokens.ts agentKeys
 * and orgs.ts projectCreators, through model/peopleSettings.ts):
 *
 *   1. settingsPage: who reads it, the two groups in name key byte order,
 *      25 records a page across both, the search over names and
 *      addresses, cursors, `through`, readiness, the read budget, the
 *      admins count and each row's fields, a guest's projects included.
 *   2. get: one person by id, `unavailable` alike for every profile the
 *      caller's organization does not hold.
 *   3. byIds: the person rows of any member, by id.
 *   4. agentKeys: the keys of up to 25 agents of one organization.
 *   5. projectCreators: who can create projects, two named and the rest
 *      counted exactly up to 100, under the saved setting.
 *   6. The last-admin rule at the writes, over the admins alone.
 *   7. Reads at the design size, one figure a case, logged for the
 *      coordinator's timing and recorded in the report. */

import { compareValues } from 'convex/values'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { deliveries } from '../invites'
import { newWindowKey } from '../lib/db'
import { LIST_BATCH } from '../lib/limits'
import { NAMED_READ, namedCursor } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { activeAdmins, assertNotLastAdmin } from '../model/orgs'
import {
  CREATORS_ADMINS_ONLY,
  GUEST_PROJECTS,
  NOT_PEOPLE_CURSOR,
  PEOPLE_ADMINS_ONLY,
  PEOPLE_LIST,
  type PeoplePageAnswer,
  peopleByIdsOf,
  projectCreatorsOf,
  type SettingsPersonRow,
  settingsPeopleOf,
  settingsPersonOf,
} from '../model/peopleSettings'
import { deactivate, remove, update } from '../profiles'
import { AGENT_KEYS, agentKeysOf } from '../tokens'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

/* Cursors are sealed with a key derived from BETTER_AUTH_SECRET
 * (lib/archiveCursorSeal.ts). */
const g = globalThis as unknown as { process: { env: Record<string, string | undefined> } }
g.process.env.BETTER_AUTH_SECRET ??= 'people-settings-test-secret-not-a-deployment-key'

const DEFAULT_READ = { ...NAMED_READ }
const DEFAULT_GUEST = { ...GUEST_PROJECTS }
const DEFAULT_KEYS = { ...AGENT_KEYS }
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(GUEST_PROJECTS, DEFAULT_GUEST)
  Object.assign(AGENT_KEYS, DEFAULT_KEYS)
  vi.unstubAllEnvs()
})

/* ------------------------------------------------------------- fixture */

type Fx = OrgFixture & { t: T }

/* withOrg with both organizations keyed, as on a deployment. Its people
 * are admin, user, viewer and Relay (an agent with the role user), and
 * the guest, who holds a grant on Testbed platform. */
async function setup(t: T = newT()): Promise<Fx> {
  const f = await withOrg(t)
  await keyOrg(t, f.org.id)
  await keyOrg(t, f.otherOrg.id)
  return { t, ...f }
}

/* People of organization `orgId`, keyed, in one transaction. */
const plantPeople = (
  t: T,
  orgId: string,
  people: (Partial<Doc<'profiles'>> & { name: string })[],
): Promise<Doc<'profiles'>[]> =>
  t.run(async (ctx) => {
    const out: Doc<'profiles'>[] = []
    for (const p of people) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: orgId,
        initials: 'PP',
        color: '#7a7ad0',
        org_role: 'user',
        active: true,
        kind: 'person',
        auth_user_id: 'planted-login',
        plannable_hours: 40,
        created_at: NOW,
        name_key: nameKey(p.name),
        ...p,
      })
      out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    return out
  })

/* An ordinary name of about 20 characters for person `n`. */
const personName = (n: number) => `Person ${String(n).padStart(4, '0')} Example`

/* `count` people named personName(from) and on, with `over` on each. */
const plantMany = (
  t: T,
  orgId: string,
  count: number,
  from = 0,
  over: Partial<Doc<'profiles'>> = {},
) =>
  plantPeople(
    t,
    orgId,
    Array.from({ length: count }, (_, i) => ({ name: personName(from + i), ...over })),
  )

/* Rows in the page's order, by name key in Convex's byte order with the
 * id to break ties. */
const byKey = <R extends { id: string; name: string }>(rows: readonly R[]): R[] =>
  [...rows].sort((a, b) => compareValues([nameKey(a.name), a.id], [nameKey(b.name), b.id]))

/* The organization's profiles. */
const profilesOf = (t: T, orgId: string) =>
  t.run((ctx) =>
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', orgId))
      .collect(),
  )

type PageArgs = { search?: string; after?: string; through?: string }

/* The reads, through the public queries for a caller with a login. */
const read = {
  page: (t: T, me: Doc<'profiles'>, a: PageArgs = {}) =>
    as(t, me).query(api.people.settingsPage, { org_id: me.org_id, ...a }),
  get: (t: T, me: Doc<'profiles'>, id: string) =>
    as(t, me).query(api.people.get, { org_id: me.org_id, id }),
  byIds: (t: T, me: Doc<'profiles'>, ids: string[]) =>
    as(t, me).query(api.people.byIds, { org_id: me.org_id, ids }),
  keys: (t: T, me: Doc<'profiles'>, agent_ids: string[]) =>
    as(t, me).query(api.tokens.agentKeys, { org_id: me.org_id, agent_ids }),
  creators: (t: T, me: Doc<'profiles'>) =>
    as(t, me).query(api.orgs.projectCreators, { org_id: me.org_id }),
}

type Ready = Extract<PeoplePageAnswer, { state: 'ready' }>

/* `answer` as a ready page, failing the test for any other state. */
function ready(answer: PeoplePageAnswer): Ready {
  if (answer.state !== 'ready') throw new Error(`expected a ready page, got ${answer.state}`)
  return answer
}

/* Every page of the list from its start, `after` the last's next. */
async function walk(page: (after?: string) => Promise<PeoplePageAnswer>): Promise<Ready[]> {
  const out: Ready[] = []
  let after: string | undefined
  for (let i = 0; i < 100; i++) {
    const one = ready(await page(after))
    out.push(one)
    if (one.next === null) return out
    after = one.next
  }
  throw new Error('the list did not end')
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id)

/* What `run` read in its own transaction, by Convex's counts. */
type Read = { ranges: number; documents: number; bytes: number }
async function measured<R>(
  t: T,
  run: (ctx: QueryCtx) => Promise<R>,
): Promise<{ out: R; read: Read }> {
  return await t.run(async (ctx) => {
    const before = await ctx.meta.getTransactionMetrics()
    let out: R
    try {
      out = await run(ctx)
    } catch (error) {
      const after = await ctx.meta.getTransactionMetrics()
      throw Object.assign(error as object, {
        read: { documents: after.documentsRead.used - before.documentsRead.used },
      })
    }
    const after = await ctx.meta.getTransactionMetrics()
    return {
      out,
      read: {
        ranges: after.databaseQueries.used - before.databaseQueries.used,
        documents: after.documentsRead.used - before.documentsRead.used,
        bytes: after.bytesRead.used - before.bytesRead.used,
      },
    }
  })
}

/* Public function `fn` run as `who`, its wrapper included, as a query or
 * a mutation, with what its transaction read, by Convex's counts. A
 * mutation's writes commit. */
async function measuredCall(
  t: T,
  who: Doc<'profiles'>,
  kind: 'query' | 'mutation',
  fn: unknown,
  args: Record<string, unknown>,
): Promise<{ out: unknown; read: Read }> {
  const { _handler } = fn as {
    _handler: (ctx: QueryCtx, args: Record<string, unknown>) => Promise<unknown>
  }
  const run = async (ctx: QueryCtx) => {
    const before = await ctx.meta.getTransactionMetrics()
    const out = await _handler(ctx, args)
    const after = await ctx.meta.getTransactionMetrics()
    return {
      out,
      read: {
        ranges: after.databaseQueries.used - before.databaseQueries.used,
        documents: after.documentsRead.used - before.documentsRead.used,
        bytes: after.bytesRead.used - before.bytesRead.used,
      },
    }
  }
  return kind === 'query' ? await as(t, who).query(run) : await as(t, who).mutation(run)
}

/* What a refused call read before its refusal. */
async function readBeforeRefusal(t: T, run: (ctx: QueryCtx) => Promise<unknown>) {
  try {
    await measured(t, run)
  } catch (error) {
    return (error as { read: { documents: number } }).read.documents
  }
  throw new Error('expected a refusal')
}

/* ------------------------------------------------------ 1. settingsPage */

describe('settingsPage', () => {
  it('lists people and agents, then guests, in name key byte order, 25 records a page across both groups', async () => {
    const fx = await setup()
    // U+E000 sorts before an emoji in UTF-8 bytes, after it in UTF-16
    // units, so a page sorted by JavaScript's `<` puts them the other way
    const odd = await plantPeople(fx.t, fx.org.id, [{ name: '😀 Smile' }, { name: ' Mark' }])
    expect(nameKey('😀 Smile') < nameKey(' Mark')).toBe(true)
    await plantMany(fx.t, fx.org.id, 24)
    await plantPeople(fx.t, fx.org.id, [
      { name: 'Aaron Guest', org_role: 'guest', email: 'aaron@example.com' },
    ])
    const pages = await walk((after) => read.page(fx.t, fx.admin, after ? { after } : {}))
    const all = await profilesOf(fx.t, fx.org.id)
    const people = byKey(all.filter((p) => p.org_role !== 'guest'))
    const guests = byKey(all.filter((p) => p.org_role === 'guest'))
    expect(people).toHaveLength(30)
    expect(guests).toHaveLength(2)
    expect(pages.map((p) => p.rows.length)).toEqual([LIST_BATCH, 7])
    expect(pages.flatMap((p) => ids(p.rows))).toEqual(ids([...people, ...guests]))
    // the guests, Aaron among them, come after every person and agent
    expect(pages[1].rows.slice(-2).map((r) => r.name)).toEqual(['Aaron Guest', 'guest'])
    const at = (id: string) => pages.flatMap((p) => ids(p.rows)).indexOf(id)
    expect(at(odd[1].id)).toBeLessThan(at(odd[0].id))
    expect(pages.every((p) => !p.stopped)).toBe(true)
  })

  it('searches every word in the name or the address, before the page is cut, guests too', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 30)
    const [nora] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Nora Berg', email: 'nora@example.com' },
      { name: 'Zed Late', email: 'zed@example.com' },
      { name: 'Gail Guest', email: 'gail@example.org', org_role: 'guest' },
    ])
    const found = async (search: string) =>
      ready(await read.page(fx.t, fx.admin, { search })).rows.map((r) => r.name)
    expect(await found('nora')).toEqual(['Nora Berg'])
    // one word in the name and one in the address
    expect(await found('nora example')).toEqual(['Nora Berg'])
    expect(await found('NÓRA')).toEqual(['Nora Berg'])
    // a match past the first 25 records is found on the first page
    expect(await found('example.com')).toEqual(['Nora Berg', 'Zed Late'])
    // a guest by their address, and the fixture's by its domain
    expect(await found('gail@example')).toEqual(['Gail Guest'])
    expect(await found('guest@testbed')).toEqual(['guest'])
    // a word in neither field
    expect(await found('nora zzz')).toEqual([])
    expect(nora.email).toBe('nora@example.com')
  })

  it('refuses anyone but an organization admin before any read', async () => {
    const fx = await setup()
    for (const who of [fx.user, fx.viewer, fx.guest])
      await expectRefusal(read.page(fx.t, who), 'forbidden', new RegExp(`^${PEOPLE_ADMINS_ONLY}$`))
    // agents are never admins, and have no login to read with
    expect(await readBeforeRefusal(fx.t, (ctx) => settingsPeopleOf(ctx, fx.agent, {}))).toBe(0)
    expect(await readBeforeRefusal(fx.t, (ctx) => settingsPeopleOf(ctx, fx.user, {}))).toBe(0)
    expect(
      await readBeforeRefusal(fx.t, (ctx) => settingsPersonOf(ctx, fx.viewer, fx.admin.id)),
    ).toBe(0)
    expect(await readBeforeRefusal(fx.t, (ctx) => projectCreatorsOf(ctx, fx.user))).toBe(0)
    expect(await readBeforeRefusal(fx.t, (ctx) => agentKeysOf(ctx, fx.user, [fx.agent.id]))).toBe(0)
    // an admin of another organization reads only their own
    const other = ready(await read.page(fx.t, fx.otherAdmin))
    expect(ids(other.rows)).toEqual([fx.otherAdmin.id])
  })

  it('refuses cursors of another organization, search or list, and a position without a mark', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 30)
    const first = ready(await read.page(fx.t, fx.admin))
    const next = first.next ?? ''
    expect(ready(await read.page(fx.t, fx.admin, { after: next })).rows).toHaveLength(10)
    const refused = (after: string, search?: string) =>
      expectRefusal(
        read.page(fx.t, fx.admin, { after, ...(search ? { search } : {}) }),
        'bad_request',
        new RegExp(`^${NOT_PEOPLE_CURSOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      )
    // a cursor of this list for another search
    await refused(next, 'person')
    const at = { key: `0${nameKey(fx.user.name)}`, tie: [fx.user.id] }
    await refused(await namedCursor(PEOPLE_LIST, [fx.otherOrg.id, ''], at))
    await refused(await namedCursor('projectSettings.candidates', [fx.org.id, '', '', ''], at))
    // a position the list never hands out, with no mark or a tie of two fields
    await refused(await namedCursor(PEOPLE_LIST, [fx.org.id, ''], { ...at, key: 'user' }))
    await refused(await namedCursor(PEOPLE_LIST, [fx.org.id, ''], { ...at, tie: ['a', 'b'] }))
    // the same position, sealed right, opens
    const ok = ready(
      await read.page(fx.t, fx.admin, {
        after: await namedCursor(PEOPLE_LIST, [fx.org.id, ''], at),
      }),
    )
    expect(ok.rows.map((r) => r.name)).toEqual(['viewer', 'guest'])
  })

  it('keeps a page live with through as a person lands in it', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 30)
    const first = ready(await read.page(fx.t, fx.admin))
    const through = first.next ?? ''
    const [early] = await plantPeople(fx.t, fx.org.id, [{ name: 'Aaron Early' }])
    const pinned = ready(await read.page(fx.t, fx.admin, { through }))
    expect(pinned.rows).toHaveLength(LIST_BATCH + 1)
    expect(pinned.rows[0].id).toBe(early.id)
    expect(pinned.next).toBe(through)
    // the open page instead moves its last row to the next page
    const open = ready(await read.page(fx.t, fx.admin))
    expect(open.rows).toHaveLength(LIST_BATCH)
    expect(open.rows.at(-1)?.id).toBe(first.rows.at(-2)?.id)
  })

  it('answers not_ready until the organization is keyed', async () => {
    const t = newT()
    const f = await withOrg(t)
    expect(await read.page(t, f.admin)).toEqual({ state: 'not_ready' })
    await keyOrg(t, f.org.id)
    expect(ready(await read.page(t, f.admin)).rows).toHaveLength(5)
  })

  it('stops at a lowered read budget with a cursor, never an end', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 40)
    NAMED_READ.documents = 12
    const none = ready(await read.page(fx.t, fx.admin, { search: 'nobody by this name' }))
    expect(none).toMatchObject({ rows: [], stopped: true })
    expect(none.next).not.toBeNull()
    const pages = await walk((after) =>
      read.page(fx.t, fx.admin, { search: 'nobody by this name', ...(after ? { after } : {}) }),
    )
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.slice(0, -1).every((p) => p.stopped && p.next !== null)).toBe(true)
    expect(pages.at(-1)).toMatchObject({ rows: [], next: null, stopped: false })
    // without a search, a stopped page holds fewer rows than a full one
    const part = ready(await read.page(fx.t, fx.admin))
    expect(part.stopped).toBe(true)
    expect(part.rows.length).toBeLessThan(LIST_BATCH)
    // the admins count is read before the walk, outside its budget
    expect(part.admins).toBe(1)
  })

  it('counts the active admins up to two, an inactive admin left out', async () => {
    const fx = await setup()
    const admins = async () => ready(await read.page(fx.t, fx.admin)).admins
    expect(await admins()).toBe(1)
    await plantPeople(fx.t, fx.org.id, [{ name: 'Asleep Admin', org_role: 'admin', active: false }])
    expect(await admins()).toBe(1)
    await plantPeople(fx.t, fx.org.id, [{ name: 'Second Admin', org_role: 'admin' }])
    expect(await admins()).toBe(2)
    await plantPeople(fx.t, fx.org.id, [{ name: 'Third Admin', org_role: 'admin' }])
    expect(await admins()).toBe(2)
    // another organization's admins never count
    expect(ready(await read.page(fx.t, fx.otherAdmin)).admins).toBe(1)
  })

  it("answers each row's fields", async () => {
    const fx = await setup()
    await fx.t.run(async (ctx) => {
      await ctx.db.patch(fx.user._id, { can_create_projects: true, plannable_hours: 32 })
    })
    const invited = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Ina Invited',
      email: 'ina@example.com',
      plannable_hours: undefined,
    })
    await keyOrg(fx.t, fx.org.id)
    const rows = ready(await read.page(fx.t, fx.admin)).rows
    const row = (id: string) => rows.find((r) => r.id === id)
    expect(row(fx.agent.id)).toEqual({
      id: fx.agent.id,
      name: 'Relay',
      org_role: 'user',
      kind: 'agent',
      active: true,
      pending: false,
      email: null,
      can_create_projects: false,
      plannable_hours: null,
      guest: null,
    } satisfies SettingsPersonRow)
    expect(row(fx.user.id)).toMatchObject({
      email: 'user@testbed.test',
      can_create_projects: true,
      plannable_hours: 32,
      pending: false,
      guest: null,
    })
    expect(row(invited.id)).toMatchObject({
      pending: true,
      email: 'ina@example.com',
      plannable_hours: null,
    })
    expect(row(fx.guest.id)?.guest).toEqual({
      projects: [{ id: fx.meta.id, name: 'Testbed platform', level: 'user' }],
      more: false,
    })
    // no face, login or hash field
    for (const r of rows)
      expect(Object.keys(r).sort()).toEqual(
        [
          'active',
          'can_create_projects',
          'email',
          'guest',
          'id',
          'kind',
          'name',
          'org_role',
          'pending',
          'plannable_hours',
        ].sort(),
      )
  })

  it("names a guest's live projects of the organization, a lead before a grant and once, with more past a lowered cap", async () => {
    const fx = await setup()
    const led = await plantProject(fx.t, {
      org_id: fx.org.id,
      name: 'Guest led',
      lead_id: fx.guest.id,
    })
    const archived = await plantProject(fx.t, {
      org_id: fx.org.id,
      name: 'Old share',
      archived_at: NOW,
      archive_state: 'listed',
    })
    const foreign = await plantProject(fx.t, { org_id: fx.otherOrg.id, name: 'Elsewhere share' })
    await fx.t.run(async (ctx) => {
      for (const p of [led, archived, foreign])
        await ctx.db.insert('project_access', {
          project_id: p.id,
          profile_id: fx.guest.id,
          level: 'viewer',
        })
    })
    const guestRow = async () =>
      ready(await read.page(fx.t, fx.admin)).rows.find((r) => r.id === fx.guest.id)?.guest
    expect(await guestRow()).toEqual({
      projects: [
        { id: led.id, name: 'Guest led', level: 'lead' },
        { id: fx.meta.id, name: 'Testbed platform', level: 'user' },
      ],
      more: false,
    })
    GUEST_PROJECTS.shown = 1
    expect(await guestRow()).toEqual({
      projects: [{ id: led.id, name: 'Guest led', level: 'lead' }],
      more: true,
    })
    // a guest whose first grant is on an archived project, with more after it
    const [second] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Second Guest', org_role: 'guest' },
    ])
    await fx.t.run(async (ctx) => {
      for (const p of [archived, fx.meta])
        await ctx.db.insert('project_access', {
          project_id: p.id,
          profile_id: second.id,
          level: 'user',
        })
    })
    const rows = ready(await read.page(fx.t, fx.admin)).rows
    expect(rows.find((r) => r.id === second.id)?.guest).toEqual({ projects: [], more: true })
    GUEST_PROJECTS.shown = 10
    expect(
      ready(await read.page(fx.t, fx.admin)).rows.find((r) => r.id === second.id)?.guest,
    ).toEqual({
      projects: [{ id: fx.meta.id, name: 'Testbed platform', level: 'user' }],
      more: false,
    })
  })
})

/* -------------------------------------------------------------- 2. get */

describe('get', () => {
  it('answers a person on no loaded page, and unavailable alike for every profile the organization lacks', async () => {
    const fx = await setup()
    await plantMany(fx.t, fx.org.id, 40)
    const last = byKey(await profilesOf(fx.t, fx.org.id))
      .filter((p) => p.org_role !== 'guest')
      .at(-1)
    if (!last) throw new Error('no people')
    expect(ids(ready(await read.page(fx.t, fx.admin)).rows)).not.toContain(last.id)
    const got = await read.get(fx.t, fx.admin, last.id)
    expect(got).toMatchObject({ state: 'ok', admins: 1, person: { id: last.id, name: last.name } })
    expect(await read.get(fx.t, fx.admin, fx.guest.id)).toMatchObject({
      state: 'ok',
      person: { org_role: 'guest', guest: { projects: [{ id: fx.meta.id }], more: false } },
    })
    expect(await read.get(fx.t, fx.admin, uuid())).toEqual({ state: 'unavailable' })
    expect(await read.get(fx.t, fx.admin, fx.otherAdmin.id)).toEqual({ state: 'unavailable' })
    for (const who of [fx.user, fx.viewer, fx.guest])
      await expectRefusal(read.get(fx.t, who, fx.admin.id), 'forbidden')
  })
})

/* ------------------------------------------------------------ 3. byIds */

describe('byIds', () => {
  it('answers any member the person rows of the organization among the ids, each once', async () => {
    const fx = await setup()
    const [off] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Off Person', active: false, color: 'teal', initials: 'OP' },
    ])
    const pending = await plantSeat(fx.t, {
      org_id: fx.org.id,
      name: 'Pat Pending',
      email: 'pat@example.com',
    })
    const asked = [
      fx.admin.id,
      off.id,
      pending.id,
      fx.agent.id,
      fx.otherAdmin.id,
      uuid(),
      fx.admin.id,
    ]
    for (const who of [fx.guest, fx.viewer, fx.user]) {
      const { rows } = await read.byIds(fx.t, who, asked)
      expect(ids(rows).sort()).toEqual([fx.admin.id, off.id, pending.id, fx.agent.id].sort())
    }
    const { rows } = await fx.t.run((ctx) => peopleByIdsOf(ctx, fx.agent, asked))
    const row = (id: string) => rows.find((r) => r.id === id)
    expect(row(off.id)).toEqual({
      id: off.id,
      name: 'Off Person',
      org_role: 'user',
      kind: 'person',
      active: false,
      pending: false,
      // an older non-hex color goes out as gray, as the workspace sends it
      color: expect.stringMatching(/^#[0-9a-f]{6}$/i),
      initials: 'OP',
    })
    expect(row(pending.id)).toMatchObject({ pending: true, active: true })
    expect(row(fx.admin.id)).toMatchObject({ color: '#7a7ad0', initials: 'AD' })
    // 101 ids are refused on the raw length, also 101 copies of one id
    await expectRefusal(
      read.byIds(
        fx.t,
        fx.admin,
        Array.from({ length: 101 }, () => uuid()),
      ),
      'bad_request',
    )
    await expectRefusal(
      read.byIds(
        fx.t,
        fx.admin,
        Array.from({ length: 101 }, () => fx.admin.id),
      ),
      'bad_request',
    )
    expect(
      (
        await read.byIds(
          fx.t,
          fx.admin,
          Array.from({ length: 100 }, () => fx.admin.id),
        )
      ).rows,
    ).toHaveLength(1)
  })
})

/* -------------------------------------------------------- 4. agentKeys */

/* Key rows of `agent`, inserted in the order given, each with its own
 * created_at and, for some, a revocation. */
const plantKeys = (
  t: T,
  agent: Doc<'profiles'>,
  keys: { name: string; created_at: string; revoked_at?: string }[],
) =>
  t.run(async (ctx) => {
    const out: string[] = []
    for (const k of keys) {
      const id = uuid()
      await ctx.db.insert('agent_keys', {
        id,
        profile_id: agent.id,
        org_id: agent.org_id,
        name: k.name,
        key_prefix: 'qva_012...abcde',
        key_hash: uuid().replace(/-/g, '').padEnd(64, '0'),
        created_by: agent.id,
        created_at: k.created_at,
        ...(k.revoked_at ? { revoked_at: k.revoked_at } : {}),
      })
      out.push(id)
    }
    return out
  })

describe('agentKeys', () => {
  it("answers an admin each agent's keys newest first, revoked ones included, and no hash", async () => {
    const fx = await setup()
    const [scout] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Scout', kind: 'agent', auth_user_id: undefined },
    ])
    const [foreign] = await plantPeople(fx.t, fx.otherOrg.id, [
      { name: 'Far Bot', kind: 'agent', auth_user_id: undefined },
    ])
    // stored out of their created_at order, as rows ported from 0100 can be
    const relay = await plantKeys(fx.t, fx.agent, [
      { name: 'middle', created_at: '2026-02-01T00:00:00.000Z' },
      { name: 'newest', created_at: '2026-03-01T00:00:00.000Z' },
      { name: 'oldest', created_at: '2026-01-01T00:00:00.000Z', revoked_at: NOW },
    ])
    await plantKeys(fx.t, scout, [{ name: 'only', created_at: NOW }])
    await plantKeys(fx.t, foreign, [{ name: 'far', created_at: NOW }])
    const { agents } = await read.keys(fx.t, fx.admin, [
      fx.agent.id,
      scout.id,
      fx.agent.id,
      fx.user.id,
      foreign.id,
      uuid(),
    ])
    expect(agents.map((a) => a.agent_id)).toEqual([fx.agent.id, scout.id])
    expect(agents[0].keys.map((k) => k.name)).toEqual(['newest', 'middle', 'oldest'])
    expect(agents[0].keys[2]).toMatchObject({ id: relay[2], agentId: fx.agent.id, revokedAt: NOW })
    expect(agents[0].more).toBe(false)
    for (const k of agents.flatMap((a) => a.keys))
      expect(Object.keys(k).sort()).toEqual(
        ['agentId', 'createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt'].sort(),
      )
    // past a lowered bound, the newest and `more`
    AGENT_KEYS.most = 2
    const capped = (await read.keys(fx.t, fx.admin, [fx.agent.id])).agents[0]
    expect(capped.keys.map((k) => k.name)).toEqual(['newest', 'middle'])
    expect(capped.more).toBe(true)
    AGENT_KEYS.most = 3
    expect((await read.keys(fx.t, fx.admin, [fx.agent.id])).agents[0].more).toBe(false)
  })

  it('answers the newest keys by created_at past the bound, also when the newest was stored first', async () => {
    const fx = await setup()
    // stored first, but the newest, as a row ported from 0100 can be
    await plantKeys(fx.t, fx.agent, [
      { name: 'newest', created_at: '2026-04-01T00:00:00.000Z' },
      { name: 'oldest', created_at: '2026-01-01T00:00:00.000Z' },
      { name: 'second', created_at: '2026-03-01T00:00:00.000Z' },
      { name: 'third', created_at: '2026-02-01T00:00:00.000Z' },
    ])
    AGENT_KEYS.most = 2
    const capped = (await read.keys(fx.t, fx.admin, [fx.agent.id])).agents[0]
    expect(capped.keys.map((k) => k.name)).toEqual(['newest', 'second'])
    expect(capped.more).toBe(true)
  })

  it('refuses a non-admin, an empty list, 26 ids and the demo', async () => {
    const fx = await setup()
    for (const who of [fx.user, fx.viewer, fx.guest])
      await expectRefusal(read.keys(fx.t, who, [fx.agent.id]), 'forbidden', /^admin only$/)
    await expectRefusal(read.keys(fx.t, fx.admin, []), 'bad_request')
    await expectRefusal(
      read.keys(
        fx.t,
        fx.admin,
        Array.from({ length: LIST_BATCH + 1 }, () => fx.agent.id),
      ),
      'bad_request',
    )
    expect(
      (
        await read.keys(
          fx.t,
          fx.admin,
          Array.from({ length: LIST_BATCH }, () => fx.agent.id),
        )
      ).agents,
    ).toHaveLength(1)
    vi.stubEnv('APP_MODE', 'demo')
    await expectRefusal(
      fx.t.run((ctx) => agentKeysOf(ctx, fx.admin, [fx.agent.id])),
      'forbidden',
    )
  })
})

/* -------------------------------------------------- 5. projectCreators */

/* Sets the organization's project_creators. */
const setCreators = (
  t: T,
  org: Doc<'organizations'>,
  project_creators: 'admins' | 'users' | 'selected',
) => t.run((ctx) => ctx.db.patch(org._id, { project_creators }))

describe('projectCreators', () => {
  it('names three or fewer in full, admins first and then standard users, each in name order', async () => {
    const fx = await setup()
    expect(await read.creators(fx.t, fx.admin)).toEqual({
      state: 'ok',
      setting: 'users',
      creators: [
        { id: fx.admin.id, name: 'admin', agent: false },
        { id: fx.agent.id, name: 'Relay', agent: true },
        { id: fx.user.id, name: 'user', agent: false },
      ],
      others: 0,
      more: false,
      agents: 0,
    })
    await setCreators(fx.t, fx.org, 'admins')
    expect(await read.creators(fx.t, fx.admin)).toMatchObject({
      setting: 'admins',
      creators: [{ id: fx.admin.id }],
      others: 0,
    })
    await setCreators(fx.t, fx.org, 'selected')
    await fx.t.run((ctx) => ctx.db.patch(fx.agent._id, { can_create_projects: true }))
    expect(await read.creators(fx.t, fx.admin)).toMatchObject({
      setting: 'selected',
      creators: [{ id: fx.admin.id }, { id: fx.agent.id }],
      others: 0,
    })
  })

  it('counts the others past two, agents among them, and never inactive people, viewers or guests', async () => {
    const fx = await setup()
    await plantPeople(fx.t, fx.org.id, [
      { name: 'Ada Admin', org_role: 'admin' },
      { name: 'Bot Standard', kind: 'agent', auth_user_id: undefined },
      { name: 'Bot Viewer', kind: 'agent', org_role: 'viewer', auth_user_id: undefined },
      { name: 'Ivy Invited', auth_user_id: undefined, email: 'ivy@example.com' },
      { name: 'Olaf Off', active: false },
      { name: 'Olga Off Admin', org_role: 'admin', active: false },
      { name: 'Vic Viewer', org_role: 'viewer' },
      { name: 'Gus Guest', org_role: 'guest' },
    ])
    const answer = await read.creators(fx.t, fx.admin)
    // admins (Ada Admin, admin), then the users Bot Standard, Ivy Invited,
    // Relay and user
    expect(answer).toEqual({
      state: 'ok',
      setting: 'users',
      creators: [
        { id: expect.any(String), name: 'Ada Admin', agent: false },
        { id: fx.admin.id, name: 'admin', agent: false },
      ],
      others: 4,
      more: false,
      agents: 2,
    })
    // a lowered budget answers unavailable, never a short count
    NAMED_READ.documents = 4
    expect(await read.creators(fx.t, fx.admin)).toEqual({ state: 'unavailable' })
    for (const who of [fx.user, fx.viewer, fx.guest])
      await expectRefusal(
        read.creators(fx.t, who),
        'forbidden',
        new RegExp(`^${CREATORS_ADMINS_ONLY}$`),
      )
  })
})

/* ----------------------------------------------- 6. the last-admin rule */

describe('the last-admin rule over the admins alone', () => {
  it('refuses demoting and deactivating the last active admin, with the same sentence', async () => {
    const fx = await setup()
    const [second] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Second Admin', org_role: 'admin' },
    ])
    // with two active admins, one may go
    await as(fx.t, fx.admin).mutation(api.profiles.deactivate, { org_id: fx.org.id, id: second.id })
    await expectRefusal(
      as(fx.t, fx.admin).mutation(api.profiles.deactivate, { org_id: fx.org.id, id: fx.admin.id }),
      'rule',
      /^cannot demote the last admin$/,
    )
    await expectRefusal(
      as(fx.t, fx.admin).mutation(api.profiles.update, {
        org_id: fx.org.id,
        id: fx.admin.id,
        patch: { org_role: 'user' },
      }),
      'rule',
      /^cannot demote the last admin$/,
    )
    expect(await fx.t.run((ctx) => activeAdmins(ctx, fx.org.id, 2))).toBe(1)
  })

  it('finds the other active admin after inactive ones in name order, and never counts the subject', async () => {
    const fx = await setup()
    // the subject sorts first; three inactive admins come before the only
    // other active one
    const [first, , , , last] = await plantPeople(fx.t, fx.org.id, [
      { name: 'Aa First', org_role: 'admin' },
      { name: 'Bb Asleep', org_role: 'admin', active: false },
      { name: 'Cc Asleep', org_role: 'admin', active: false },
      { name: 'Dd Asleep', org_role: 'admin', active: false },
      { name: 'Zz Last', org_role: 'admin' },
    ])
    await fx.t.run(async (ctx) => ctx.db.patch(fx.admin._id, { active: false }))
    await fx.t.run((ctx) => assertNotLastAdmin(ctx, first, 'remove'))
    await fx.t.run((ctx) => assertNotLastAdmin(ctx, last, 'demote'))
    await fx.t.run(async (ctx) => ctx.db.patch(last._id, { active: false }))
    await expectRefusal(
      fx.t.run((ctx) => assertNotLastAdmin(ctx, first, 'remove')),
      'rule',
      /^cannot remove the last admin$/,
    )
    // a profile without a name key is still an admin the range holds
    const unkeyed = await plantSeat(fx.t, { org_id: fx.org.id, org_role: 'admin' })
    await fx.t.run((ctx) => assertNotLastAdmin(ctx, first, 'remove'))
    expect(await fx.t.run((ctx) => activeAdmins(ctx, fx.org.id, 5, first.id))).toBe(1)
    expect(unkeyed.name_key).toBeUndefined()
  })
})

/* ------------------------------------------------- 7. the design size */

/* Logs `read` under `name` and checks it inside one call's share. */
function logged(name: string, read: Read, rows: number) {
  console.log(
    `[people settings at the design size] ${name}: ${rows} rows, ${read.ranges} ranges, ` +
      `${read.documents} documents, ${(read.bytes / 1e6).toFixed(2)} MB`,
  )
  expect(read.ranges).toBeLessThanOrEqual(NAMED_READ.ranges + 16)
  expect(read.documents).toBeLessThanOrEqual(NAMED_READ.documents + 64)
  expect(read.bytes).toBeLessThan(NAMED_READ.bytes + 64 * 1024)
}

/* The people figure, withOrg's 5 and 995 more, 1,000 people at the
 * design size, with everyday guests (withOrg's and two more) and agents
 * (Relay and three more), everything else at everyday values. */
async function plantRoster(fx: Fx) {
  const people = await plantMany(fx.t, fx.org.id, 990)
  await plantPeople(fx.t, fx.org.id, [
    { name: 'Guest Ann', org_role: 'guest', email: 'ann@example.com' },
    { name: 'Guest Bo', org_role: 'guest', email: 'bo@example.com' },
    { name: 'Agent One', kind: 'agent', auth_user_id: undefined },
    { name: 'Agent Two', kind: 'agent', auth_user_id: undefined },
    { name: 'Agent Three', kind: 'agent', org_role: 'viewer', auth_user_id: undefined },
  ])
  expect(await profilesOf(fx.t, fx.org.id)).toHaveLength(1000)
  return people
}

describe('at the design size', () => {
  it('reads Settings › Users among 1,000 people: the first page, a later page, the page where guests begin and a search that matches none', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    await plantRoster(fx)
    const page = (a: PageArgs = {}) => measured(fx.t, (ctx) => settingsPeopleOf(ctx, fx.admin, a))
    const first = await page()
    logged('settingsPage, the first page', first.read, ready(first.out).rows.length)
    expect(ready(first.out).rows).toHaveLength(LIST_BATCH)
    let after = ready(first.out).next ?? ''
    let later = first
    let n = 1
    for (; n < 50; n++) {
      later = await page({ after })
      if (n === 19) logged('settingsPage, the 20th page', later.read, ready(later.out).rows.length)
      if (ready(later.out).rows.some((r) => r.org_role === 'guest')) break
      after = ready(later.out).next ?? ''
    }
    logged('settingsPage, the page where guests begin', later.read, ready(later.out).rows.length)
    expect(n).toBe(39)
    expect(ready(later.out).rows.filter((r) => r.org_role === 'guest')).toHaveLength(3)
    expect(ready(later.out).next).toBeNull()
    const none = await page({ search: 'nobody by this name' })
    logged('settingsPage, a search that matches none of 1,000', none.read, 0)
    expect(ready(none.out)).toMatchObject({ rows: [], next: null, stopped: false })
  }, 60_000)

  it('reads one person, 100 people by id and the creators line under each setting among 1,000 people', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const people = await plantRoster(fx)
    const get = await measured(fx.t, (ctx) => settingsPersonOf(ctx, fx.admin, people[600].id))
    logged('get, one person among 1,000', get.read, 1)
    expect(get.out).toMatchObject({ state: 'ok', person: { id: people[600].id } })
    const hundred = people.slice(100, 200).map((p) => p.id)
    const byIds = await measured(fx.t, (ctx) => peopleByIdsOf(ctx, fx.guest, hundred))
    logged('byIds, 100 ids among 1,000', byIds.read, byIds.out.rows.length)
    expect(byIds.out.rows).toHaveLength(100)

    const creators = () => measured(fx.t, (ctx) => projectCreatorsOf(ctx, fx.admin))
    const users = await creators()
    logged('projectCreators, Standard users, 1,000 people', users.read, 2)
    expect(users.out).toMatchObject({
      state: 'ok',
      setting: 'users',
      // Agent One and Agent Two are Standard user agents, before the people
      creators: [{ id: fx.admin.id }, { name: 'Agent One' }],
      others: 100,
      more: true,
      agents: 1,
    })
    // 103 creators found, the walk reads no further
    expect(users.read.documents).toBeLessThan(120)
    await setCreators(fx.t, fx.org, 'selected')
    await fx.t.run(async (ctx) => {
      for (const p of [people[300], people[700]])
        await ctx.db.patch(p._id, { can_create_projects: true })
    })
    const selected = await creators()
    logged('projectCreators, Selected users with two selected, 1,000 people', selected.read, 3)
    expect(selected.out).toMatchObject({
      setting: 'selected',
      creators: [{ id: fx.admin.id }, { id: people[300].id }, { id: people[700].id }],
      others: 0,
    })
    await setCreators(fx.t, fx.org, 'admins')
    const admins = await creators()
    logged('projectCreators, Org admins, 1,000 people', admins.read, 1)
    expect(admins.out).toMatchObject({ setting: 'admins', creators: [{ id: fx.admin.id }] })
  }, 60_000)

  it("reads 25 agents' everyday keys among 1,000 people, and a kept 26th in a second call", async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    await plantMany(fx.t, fx.org.id, 969)
    const agents = await plantPeople(
      fx.t,
      fx.org.id,
      Array.from({ length: 26 }, (_, i) => ({
        name: `Agent ${String(i).padStart(2, '0')} Runner`,
        kind: 'agent' as const,
        auth_user_id: undefined,
      })),
    )
    expect(await profilesOf(fx.t, fx.org.id)).toHaveLength(1000)
    for (const agent of agents)
      await plantKeys(fx.t, agent, [
        { name: 'CI key', created_at: '2026-01-01T00:00:00.000Z' },
        { name: 'Deploy key', created_at: '2026-02-01T00:00:00.000Z' },
        { name: 'Old key', created_at: '2025-06-01T00:00:00.000Z', revoked_at: NOW },
      ])
    const page = await measured(fx.t, (ctx) =>
      agentKeysOf(
        ctx,
        fx.admin,
        agents.slice(0, 25).map((a) => a.id),
      ),
    )
    logged('agentKeys, 25 agents with 3 keys each', page.read, page.out.agents.length)
    expect(page.out.agents).toHaveLength(25)
    expect(page.out.agents.every((a) => a.keys.length === 3 && !a.more)).toBe(true)
    const kept = await measured(fx.t, (ctx) => agentKeysOf(ctx, fx.admin, [agents[25].id]))
    logged('agentKeys, one kept agent', kept.read, kept.out.agents.length)
  }, 60_000)

  it('reads a page holding a guest who reads 200 live sub-projects, in an everyday organization', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    await fx.t.run(async (ctx) => {
      for (let i = 0; i < 200; i++) {
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: fx.org.id,
          type: 'project',
          parent_id: fx.meta.id,
          key: `S${i}`,
          name: `Sub-project ${String(i).padStart(3, '0')}`,
          description: '',
          sort_order: 100 + i,
          num: 100 + i,
          track_delay: false,
          created_at: NOW,
          window_key: newWindowKey(),
        })
        await ctx.db.insert('project_access', {
          project_id: id,
          profile_id: fx.guest.id,
          level: 'viewer',
        })
      }
    })
    const page = await measured(fx.t, (ctx) => settingsPeopleOf(ctx, fx.admin, {}))
    logged(
      'settingsPage, a guest with 200 readable sub-projects',
      page.read,
      ready(page.out).rows.length,
    )
    const guest = ready(page.out).rows.find((r) => r.id === fx.guest.id)?.guest
    expect(guest?.projects).toHaveLength(GUEST_PROJECTS.shown)
    expect(guest?.more).toBe(true)
  }, 60_000)

  it("reports the invitation emails of a page's 25 pending seats among 1,000 people", async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    await plantMany(fx.t, fx.org.id, 970)
    const pending = await plantPeople(
      fx.t,
      fx.org.id,
      Array.from({ length: LIST_BATCH }, (_, i) => ({
        name: `Invited ${String(i).padStart(2, '0')} Example`,
        email: `invited${i}@example.com`,
        auth_user_id: undefined,
      })),
    )
    expect(await profilesOf(fx.t, fx.org.id)).toHaveLength(1000)
    // one send each, which failed, so the row reads when the hourly cap
    // lets it go again
    const sentAt = new Date(Date.now() - 60_000).toISOString()
    await fx.t.run(async (ctx) => {
      for (const seat of pending)
        await ctx.db.insert('platform_audit_log', {
          ts: sentAt,
          actor_email: 'system',
          action: 'invite_email',
          channel: 'app',
          target_org_id: fx.org.id,
          target_profile_id: seat.id,
          detail: { email: seat.email, sent: false, settled: true, resend: false, by: fx.admin.id },
        })
    })
    const page = await measuredCall(fx.t, fx.admin, 'query', deliveries, {
      org_id: fx.org.id,
      profile_ids: pending.map((p) => p.id),
    })
    const rows = page.out as { profile_id: string; state: string; free_at?: string | null }[]
    logged('invites.deliveries, 25 pending seats among 1,000', page.read, rows.length)
    expect(rows).toHaveLength(LIST_BATCH)
    expect(rows.every((r) => r.state === 'unsent' && r.free_at === null)).toBe(true)
    // each seat's lookup and newest send, and the hour's sends once for the
    // page, never once a row
    expect(page.read.documents).toBeLessThan(4 * LIST_BATCH)
  }, 60_000)

  it('checks the last admin over the two admins alone among 1,000 people, for update, deactivate and remove', async () => {
    const fx = await setup(newT({ transactionLimits: true }))
    const people = await plantRoster(fx)
    // one of the 1,000 is the second admin, so the organization stays at
    // the design size
    const second = await fx.t.run(async (ctx) => {
      await ctx.db.patch(people[0]._id, { org_role: 'admin' })
      return (await ctx.db.get(people[0]._id)) as Doc<'profiles'>
    })
    expect(await profilesOf(fx.t, fx.org.id)).toHaveLength(1000)
    const check = await measured(fx.t, (ctx) => assertNotLastAdmin(ctx, second, 'demote'))
    logged('assertNotLastAdmin, one of two admins among 1,000', check.read, 0)
    expect(check.read.ranges).toBe(1)
    expect(check.read.documents).toBeLessThanOrEqual(2)
    const write = (fn: unknown, args: Record<string, unknown>) =>
      measuredCall(fx.t, fx.admin, 'mutation', fn, { org_id: fx.org.id, ...args })
    const demoted = await write(update, { id: second.id, patch: { org_role: 'user' } })
    logged('profiles.update demoting one of two admins among 1,000', demoted.read, 1)
    await as(fx.t, fx.admin).mutation(api.profiles.update, {
      org_id: fx.org.id,
      id: second.id,
      patch: { org_role: 'admin' },
    })
    const off = await write(deactivate, { id: second.id })
    logged('profiles.deactivate of one of two admins among 1,000', off.read, 1)
    await as(fx.t, fx.admin).mutation(api.profiles.update, {
      org_id: fx.org.id,
      id: second.id,
      patch: { active: true },
    })
    const removed = await write(remove, { id: second.id })
    logged('profiles.remove of one of two admins among 1,000', removed.read, 1)
    await expectRefusal(
      as(fx.t, fx.admin).mutation(api.profiles.update, {
        org_id: fx.org.id,
        id: fx.admin.id,
        patch: { org_role: 'user' },
      }),
      'rule',
      /^cannot demote the last admin$/,
    )
  }, 60_000)
})
