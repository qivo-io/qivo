/* The view filter's Assignee menu's people (pickers.orgPeople,
 * model/pickers.ts orgPeopleOf): who they offer, the match over names and
 * initials, never an email, the order and continuation of the batches, the
 * arguments and cursors, who may read them, readiness and the read
 * budget's stops. The reads at the design size close the file, one figure
 * a case. The editor's @ mention popup reads pickers.mentions, which
 * tests/mentionAccess.test.ts holds to its task's project. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { ORG_DELETING } from '../lib/billingAccess'
import { LIMITS, MENTION_BATCH } from '../lib/limits'
import { NAMED_READ } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { matchesAllWords } from '../lib/search'
import { type OrgPeopleBatch, orgPeopleOf } from '../model/pickers'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

const DEFAULT_READ = structuredClone(NAMED_READ)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
})

type Ready = Extract<OrgPeopleBatch, { state: 'ready' }>
type Row = Ready['rows'][number]
type Args = { search?: string; after?: string; through?: string }

const mentions = (t: T, caller: Doc<'profiles'>, a: Args = {}, org = caller.org_id) =>
  as(t, caller).query(api.pickers.orgPeople, { org_id: org, ...a })

function ready(answer: OrgPeopleBatch): Ready {
  if (answer.state !== 'ready') throw new Error(`expected a batch, got ${JSON.stringify(answer)}`)
  return answer
}

/* Every batch of a list from its start to its end, and the rows it listed
 * in order. A stopped batch never answers an end it did not reach. */
async function listAll(
  read: (after?: string) => Promise<OrgPeopleBatch>,
): Promise<{ rows: Row[]; batches: Ready[] }> {
  const batches: Ready[] = []
  let after: string | undefined
  for (let round = 0; round < 500; round++) {
    const batch = ready(await read(after))
    batches.push(batch)
    if (batch.stopped) expect(batch.next).not.toBeNull()
    if (batch.next === null) return { rows: batches.flatMap((b) => b.rows), batches }
    after = batch.next
  }
  throw new Error('the list did not end')
}

/* Every person a search finds for `caller`, by id, read to the end. */
const found = async (t: T, caller: Doc<'profiles'>, search: string) =>
  (await listAll((after) => mentions(t, caller, { search, after }))).rows.map((r) => r.id).sort()

/* withOrg with a person planter. Its people are admin, user, viewer and
 * guest (each `<name>@testbed.test`), the agent Relay and, in the other
 * organization, otherAdmin. `keyed` keys every name of both organizations
 * and stamps them ready; call it once everything is planted. */
async function base(t: T = newT()) {
  const f = await withOrg(t)
  const person = (name: string, extra: Partial<Doc<'profiles'>> = {}) =>
    plantSeat(t, {
      org_id: f.org.id,
      name,
      initials: name
        .split(/\s+/)
        .map((w) => w[0])
        .join('')
        .toUpperCase(),
      accepted_at: NOW,
      auth_user_id: uuid(),
      ...extra,
    })
  const keyed = async () => {
    await keyOrg(t, f.org.id)
    await keyOrg(t, f.otherOrg.id)
  }
  return { t, f, person, keyed }
}

describe('who the list offers', () => {
  it('offers every profile of the organization and none of another', async () => {
    const { t, f, person, keyed } = await base()
    const off = await person('Switched Off', { active: false })
    const unclaimed = await plantSeat(t, { org_id: f.org.id, name: 'Unclaimed Seat' })
    const anna = await person('Anna Fält', { email: 'anna@qivo.test', initials: 'AF' })
    await plantSeat(t, { org_id: f.otherOrg.id, name: 'Anna Home', email: 'anna@home.test' })
    await keyed()
    const all = (await listAll((after) => mentions(t, f.user, { after }))).rows
    const ids = all.map((r) => r.id).sort()
    // the caller, the admin, a viewer, a guest, an agent, a switched-off
    // person and an unclaimed seat alike
    expect(ids).toEqual(
      [f.admin, f.user, f.viewer, f.guest, f.agent, off, unclaimed, anna].map((p) => p.id).sort(),
    )
    expect(all.map((r) => r.name)).not.toContain('Anna Home')
    expect(all.map((r) => r.name)).not.toContain('otherAdmin')
  })

  it("answers a login's second seat only its own organization's people", async () => {
    const { t, f, keyed } = await base()
    // user's login also holds a guest seat in the other organization
    const second = await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'user',
      org_role: 'guest',
      auth_user_id: f.user.auth_user_id,
      accepted_at: NOW,
    })
    await keyed()
    const there = (await listAll((after) => mentions(t, second, { after }))).rows
    expect(there.map((r) => r.id).sort()).toEqual([f.otherAdmin.id, second.id].sort())
    const here = (await listAll((after) => mentions(t, f.user, { after }))).rows
    expect(here.map((r) => r.id)).not.toContain(second.id)
    expect(here.map((r) => r.id)).not.toContain(f.otherAdmin.id)
  })
})

describe('the match', () => {
  it('matches names and initials, never an email, ignoring case but not accents', async () => {
    const { t, f, person, keyed } = await base()
    const anna = await person('Anna Fält', { email: 'anna@qivo.test', initials: 'AF' })
    const erik = await person('Erik Holm', { email: 'erik@qivo.test', initials: 'EH' })
    await plantSeat(t, {
      org_id: f.otherOrg.id,
      name: 'Anna Fält',
      initials: 'AF',
      email: 'anna@home.test',
    })
    await keyed()
    // reordered name fragments, case and blanks, and initials
    for (const search of ['ält ann', '  FÄ\tNA ', 'af'])
      expect(await found(t, f.user, search), search).toEqual([anna.id])
    // an email finds nobody, whole or as a word beside a name word
    for (const search of ['anna@qivo.test', 'test ann', 'QIVO.TEST anna', 'qivo'])
      expect(await found(t, f.user, search), search).toEqual([])
    // every word must occur, and another organization's Anna is not here
    for (const search of ['anna home', 'anna erik'])
      expect(await found(t, f.user, search), search).toEqual([])
    // accents stay: "falt" does not find Fält
    expect(await found(t, f.user, 'falt')).toEqual([])
    // an agent is found by name and initials
    expect(await found(t, f.user, 'relay')).toEqual([f.agent.id])
    expect(await found(t, f.user, 'ry')).toEqual([f.agent.id])
    expect(await found(t, f.user, 'holm erik')).toEqual([erik.id])
  })

  it('finds what the rule finds over 40 varied people, paged to the end', async () => {
    const { t, f, person, keyed } = await base()
    const firsts = ['Ana', 'Åsa', 'Björn', 'Chloé', 'Dmitri', 'Élise', 'Fatima', 'Göran']
    const lasts = ['Lind', 'Öberg', 'Nakamura', "O'Neil", 'Smith-Jones']
    for (let i = 0; i < 40; i++) {
      const name = `${firsts[i % firsts.length]} ${lasts[i % lasts.length]} ${i}`
      const initials = `${firsts[i % firsts.length][0]}${lasts[i % lasts.length][0]}`
      // every seventh is an agent, without an email
      if (i % 7 === 0) await plantSeat(t, { org_id: f.org.id, name, initials, kind: 'agent' })
      else
        await person(name, {
          initials,
          email: `p${i}.${lasts[i % lasts.length].toLowerCase()}@ex.test`,
        })
    }
    await keyed()
    const everyone = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    )
    expect(everyone.length).toBe(45)
    for (const search of ['', 'a', 'lind', 'ÖB', 'åsa', 'asa', 'ex.test 1', 'go', 'é', 'nobody'])
      expect(await found(t, f.user, search), search).toEqual(
        everyone
          .filter((p) => matchesAllWords(`${p.name}\n${p.initials}`, search))
          .map((p) => p.id)
          .sort(),
      )
  })
})

describe('the order and continuation', () => {
  it('answers 20 matches 8 at a time in name order, equal names by id', async () => {
    const { t, f, person, keyed } = await base()
    const same: Doc<'profiles'>[] = []
    for (let i = 0; i < 17; i++) await person(`Member ${String(i).padStart(2, '0')}`)
    for (let i = 0; i < 3; i++) same.push(await person('Member Same'))
    await keyed()
    const all = await listAll((after) => mentions(t, f.user, { search: 'member', after }))
    expect(all.batches.map((b) => b.rows.length)).toEqual([MENTION_BATCH, MENTION_BATCH, 4])
    expect(all.rows.slice(-3).map((r) => r.id)).toEqual(same.map((p) => p.id).sort())
    const keys = all.rows.map((r) => nameKey(r.name))
    expect(keys).toEqual([...keys].sort())
  })

  it('orders by the bytes of the name key, not by localeCompare', async () => {
    const { t, f, person, keyed } = await base()
    const names = ['Zulu Check', 'Émile Review', 'Øresund Test', '😀 Launch', '￮ Ring']
    for (const name of names) await person(name)
    await keyed()
    const rows = (await listAll((after) => mentions(t, f.user, { after }))).rows
    const order = rows.map((r) => r.name).filter((name) => names.includes(name))
    // "Émile" keys as "emile"; ø, ￮ and 😀 take two, three and four bytes
    expect(order).toEqual(['Émile Review', 'Zulu Check', 'Øresund Test', '￮ Ring', '😀 Launch'])
    const keyed2 = [...order].sort((a, b) => nameKey(a).localeCompare(nameKey(b)))
    expect(order).not.toEqual(keyed2)
  })

  it('answers every match up to `through`, and stops past four batches', async () => {
    const { t, f, person, keyed } = await base()
    for (let i = 0; i < 39; i++) await person(`Member ${String(i).padStart(2, '0')}`)
    await keyed()
    const read = (a: Args) => mentions(t, f.user, { search: 'member', ...a })
    const all = await listAll((after) => read({ after }))
    expect(all.batches.map((b) => b.rows.length)).toEqual([8, 8, 8, 8, 7])
    const [one, two, , four] = all.batches
    const kept = ready(await read({ through: two.next as string }))
    expect(kept.rows).toEqual([...one.rows, ...two.rows])
    expect(kept).toMatchObject({ stopped: false, next: two.next })
    // up to the fifth batch's start, 32 rows, the most four batches hold
    const most = ready(await read({ through: four.next as string }))
    expect(most).toMatchObject({ stopped: false, next: four.next })
    expect(most.rows).toHaveLength(32)
    // one row more than four batches is cut, as a stopped batch
    await person('Member 00a')
    await keyed()
    const over = ready(await read({ through: four.next as string }))
    expect(over.rows).toHaveLength(32)
    expect(over.stopped).toBe(true)
    expect(over.next).not.toBe(four.next)
  })

  it('shows a person renamed between batches at their new place', async () => {
    const { t, f, person, keyed } = await base()
    const crowd: Doc<'profiles'>[] = []
    for (let i = 0; i < 12; i++) crowd.push(await person(`Member ${String(i).padStart(2, '0')}`))
    await keyed()
    const first = ready(await mentions(t, f.user, { search: 'member' }))
    expect(first.rows.map((r) => r.id)).toContain(crowd[0].id)
    // the first batch's first person moves past its end
    await t.run((ctx) =>
      ctx.db.patch(crowd[0]._id, { name: 'Member 99', name_key: nameKey('Member 99') }),
    )
    const rest = await listAll((after) =>
      mentions(t, f.user, { search: 'member', after: after ?? (first.next as string) }),
    )
    // read twice, once at each place, so the client keys rows by id
    expect(rest.rows.at(-1)).toMatchObject({ id: crowd[0].id, name: 'Member 99' })
  })
})

describe("the list's arguments", () => {
  it('refuses a search past LIMITS.search with its sentence', async () => {
    const { t, f, keyed } = await base()
    await keyed()
    const e = await expectRefusal(
      mentions(t, f.user, { search: 'x'.repeat(LIMITS.search.max + 1) }),
      'rule',
    )
    expect(e.data.message).toBe(LIMITS.search.refusal)
    expect(
      ready(await mentions(t, f.user, { search: 'x'.repeat(LIMITS.search.max) })).rows,
    ).toEqual([])
  })

  it('opens a cursor only for its organization and search as the match reads it', async () => {
    const { t, f, person, keyed } = await base()
    for (let i = 0; i < 12; i++) await person(`Cafe Member ${i}`)
    for (let i = 0; i < 12; i++) await person(`Café Member ${i}`)
    await keyed()
    for (let i = 0; i < 12; i++) await plantSeat(t, { org_id: f.otherOrg.id, name: `Other ${i}` })
    await keyOrg(t, f.otherOrg.id)
    const next = (a: Args, who = f.user) => mentions(t, who, a).then((b) => ready(b).next as string)
    const plain = await next({})
    const cafe = await next({ search: 'cafe' })
    const foreign = await next({}, f.otherAdmin)
    const deleted = await as(t, f.user)
      .query(api.deletedItems.people, { org_id: f.org.id })
      .then((b) => (b.state === 'ready' ? (b.next as string) : ''))
    const flipped = `${plain.slice(0, 20)}${plain[20] === 'a' ? 'b' : 'a'}${plain.slice(21)}`
    // a search with the same words in another case or spacing shares it
    expect(ready(await mentions(t, f.user, { search: '  CAFE ', after: cafe })).rows).toHaveLength(
      4,
    )
    const bad: [string, Args][] = [
      ['of Deleted by', { after: deleted }],
      ['of another organization', { after: foreign }],
      ['of another search', { search: 'member', after: cafe }],
      ['of "cafe" for "Café"', { search: 'Café', after: cafe }],
      ['changed by one character', { after: flipped }],
      ['malformed', { through: 'x' }],
    ]
    expect(deleted).not.toBe('')
    for (const [name, a] of bad)
      await expectRefusal(
        mentions(t, f.user, a),
        'bad_request',
        /cursors from an earlier answer of this list/,
      ).catch((e: unknown) => {
        throw new Error(`${name}: ${String(e)}`)
      })
    await expectRefusal(
      mentions(t, f.user, { after: plain, through: plain }),
      'bad_request',
      /through must be a cursor after the one in after/,
    )
  })
})

describe('who may read the list', () => {
  it('answers a guest and a viewer, with the four fields, no email, and a legacy color as gray', async () => {
    const { t, f, person, keyed } = await base()
    const legacy = await person('Legacy Color', { color: 'teal', email: 'legacy@testbed.test' })
    await keyed()
    for (const who of [f.guest, f.viewer]) {
      const rows = (await listAll((after) => mentions(t, who, { after }))).rows
      expect(rows.map((r) => r.id)).toContain(f.admin.id)
    }
    const [row] = ready(await mentions(t, f.guest, { search: 'legacy' })).rows
    expect(row).toEqual({
      id: legacy.id,
      name: 'Legacy Color',
      initials: 'LC',
      color: '#8A8F98',
    })
    const [agent] = ready(await mentions(t, f.guest, { search: 'relay' })).rows
    expect(Object.keys(agent).sort()).toEqual(['color', 'id', 'initials', 'name'])
  })

  it('refuses a login without a seat, a switched-off seat and an organization being deleted', async () => {
    const { t, f, keyed } = await base()
    await keyed()
    await expectRefusal(
      mentions(t, f.otherAdmin, {}, f.org.id),
      'forbidden',
      /no profile in this organization/,
    )
    const off = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Off',
      active: false,
      auth_user_id: uuid(),
    })
    await expectRefusal(mentions(t, off), 'forbidden', /no profile in this organization/)
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
    await expectRefusal(mentions(t, f.admin), 'forbidden', new RegExp(ORG_DELETING))
  })
})

describe('readiness and stops', () => {
  it('answers not_ready, with no row, until the names are keyed', async () => {
    const { t, f, keyed } = await base()
    expect(await mentions(t, f.user)).toEqual({ state: 'not_ready' })
    await keyed()
    expect(ready(await mentions(t, f.user)).rows.length).toBeGreaterThan(0)
  })

  it('stops within a lowered NAMED_READ with a cursor and reaches the end paging on', async () => {
    const { t, f, person, keyed } = await base()
    const crowd: Doc<'profiles'>[] = []
    for (let i = 0; i < 20; i++) crowd.push(await person(`Member ${String(i).padStart(2, '0')}`))
    const last = await person('Zed Last', { email: 'zed.only@testbed.test' })
    await keyed()
    // the request's own reads (the login, its seats, the ready row) come
    // first, so a small document budget stops the walk partway
    NAMED_READ.documents = 6
    const all = await listAll((after) => mentions(t, f.user, { search: 'zed last', after }))
    expect(all.batches.length).toBeGreaterThan(1)
    expect(all.batches.some((b) => b.stopped)).toBe(true)
    expect(all.rows.map((r) => r.id)).toEqual([last.id])
    // never an empty ready batch that claims the end while stopped
    for (const b of all.batches) if (b.stopped) expect(b.next).not.toBeNull()
    const members = await listAll((after) => mentions(t, f.user, { search: 'member', after }))
    expect(members.rows.map((r) => r.id).sort()).toEqual(crowd.map((p) => p.id).sort())
    expect(new Set(members.rows.map((r) => r.id)).size).toBe(20)
  })
})

describe("the list inside Convex's limits", () => {
  /* What one transaction that runs `step` read, with what it answered. */
  const measured = <R>(t: T, step: (ctx: QueryCtx) => Promise<R>) =>
    t.run(async (ctx) => {
      const answer = await step(ctx)
      const m = await ctx.meta.getTransactionMetrics()
      return {
        answer,
        ranges: m.databaseQueries.used,
        documents: m.documentsRead.used,
        mib: Math.round((m.bytesRead.used / 1024 / 1024) * 1000) / 1000,
      }
    })

  /* A batch read measured, logged under `name` and checked to answer
   * whole, never stopped and, when `end`, at the end of the list. */
  async function whole(
    name: string,
    t: T,
    step: (ctx: QueryCtx) => Promise<OrgPeopleBatch>,
    end = false,
  ) {
    const read = await measured(t, step)
    const batch = ready(read.answer)
    console.info(`org people: ${name}`, {
      ranges: read.ranges,
      documents: read.documents,
      mib: read.mib,
      rows: batch.rows.length,
      stopped: batch.stopped,
      end: batch.next === null,
    })
    expect(batch.stopped, name).toBe(false)
    if (end) expect(batch.next, name).toBeNull()
    return { ...read, batch }
  }

  /* People named `names` with ordinary emails, keyed, planted raw 400 a
   * transaction. */
  async function people(t: T, f: OrgFixture, names: readonly string[]) {
    const out: Doc<'profiles'>[] = []
    for (let from = 0; from < names.length; from += 400)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(names.length, from + 400); i++) {
          const _id = await ctx.db.insert('profiles', {
            id: uuid(),
            org_id: f.org.id,
            name: names[i],
            name_key: nameKey(names[i]),
            email: `${names[i].toLowerCase().replace(/\s+/g, '.')}@northwind.test`,
            initials: 'PP',
            color: '#7a7ad0',
            org_role: 'user',
            active: true,
            kind: 'person',
            auth_user_id: `auth_${uuid()}`,
            plannable_hours: 40,
            accepted_at: NOW,
            created_at: NOW,
          })
          out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
        }
      })
    return out
  }

  it('reads a first batch, a search that matches nobody and the last person in name order among 1,000 people', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    await keyOrg(t, f.org.id)
    await people(
      t,
      f,
      Array.from({ length: 995 }, (_, i) => `Member ${String(i).padStart(3, '0')}`),
    )
    const count = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
        .then((all) => all.length),
    )
    expect(count).toBe(1000)
    const first = await whole('first batch, no search, 1,000 people', t, (ctx) =>
      orgPeopleOf(ctx, f.user, {}),
    )
    expect(first.batch.rows).toHaveLength(MENTION_BATCH)
    const none = await whole(
      'a search that matches nobody, 1,000 people',
      t,
      (ctx) => orgPeopleOf(ctx, f.user, { search: 'nobody has this name' }),
      true,
    )
    expect(none.batch.rows).toEqual([])
    // withOrg's viewer seat sorts last in name order, after every member,
    // the agent Relay and the user seat, and holds the only such name
    const last = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org_name', (q) => q.eq('org_id', f.org.id))
        .order('desc')
        .first(),
    )
    expect(last?.id).toBe(f.viewer.id)
    const lastPerson = await whole(
      'a name only the last person in name order holds, 1,000 people',
      t,
      (ctx) => orgPeopleOf(ctx, f.user, { search: 'viewer' }),
      true,
    )
    expect(lastPerson.batch.rows.map((r) => r.id)).toEqual([f.viewer.id])
    // Load more near the end: the batch after a cursor past 990 names
    const near = await listAll((after) => mentions(t, f.user, { search: 'member 99', after }))
    const before = near.batches.at(-2)?.next as string
    await whole(
      'a Load more batch near the end, 1,000 people',
      t,
      (ctx) => orgPeopleOf(ctx, f.user, { search: 'member 99', after: before }),
      true,
    )
  })
})
