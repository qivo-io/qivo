/* A task's people pickers (pickers.taskOwners, pickers.syncRecipients and
 * pickers.canOwn, model/pickers.ts): their arguments and cursors, the gate
 * every one runs before it reads a person, the order and continuation of
 * the lists, the search, the owner and recipient rules, canOwn's checks,
 * and the stops of both read budgets. tests/pickerParity.test.ts holds the
 * rules to the writes over every access shape. The reads at the design
 * size close the file, one figure a case. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import type { GrantLevel } from '../lib/enums'
import { BY_IDS_MAX, LIMITS, LIST_BATCH } from '../lib/limits'
import { NAMED_READ } from '../lib/namedPages'
import { nameKey } from '../lib/nameKey'
import { NO_WRITE_ACCESS, REVIEWER_ON_GROUP } from '../model/issues'
import {
  canOwnOf,
  type OwnerChecks,
  type PeopleBatch,
  PICKERS,
  type PickerField,
  syncRecipientsOf,
  taskOwnersOf,
} from '../model/pickers'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

const DEFAULT_READ = structuredClone(NAMED_READ)
const DEFAULT_RULE = structuredClone(PICKERS.rule)
afterEach(() => {
  Object.assign(NAMED_READ, DEFAULT_READ)
  Object.assign(PICKERS.rule, DEFAULT_RULE)
})

type Ready = Extract<PeopleBatch, { state: 'ready' }>
type Checked = Extract<OwnerChecks, { state: 'ready' }>
type ListArgs = { search?: string; after?: string; through?: string }
type OwnerField = Exclude<PickerField, 'recipient'>

const owners = (
  t: T,
  caller: Doc<'profiles'>,
  issueId: string,
  field: OwnerField,
  a: ListArgs = {},
) =>
  as(t, caller).query(api.pickers.taskOwners, {
    org_id: caller.org_id,
    issue_id: issueId,
    field,
    ...a,
  })

const recipients = (t: T, caller: Doc<'profiles'>, issueId: string, a: ListArgs = {}) =>
  as(t, caller).query(api.pickers.syncRecipients, {
    org_id: caller.org_id,
    issue_id: issueId,
    ...a,
  })

const canOwn = (
  t: T,
  caller: Doc<'profiles'>,
  issueId: string,
  field: PickerField,
  ids: string[],
) =>
  as(t, caller).query(api.pickers.canOwn, { org_id: caller.org_id, issue_id: issueId, field, ids })

/* Every answer the three queries give `caller` about task `issueId`: the
 * owner list for both fields, the recipient list and canOwn for every
 * field with `ids`. */
const everyAnswer = async (
  t: T,
  caller: Doc<'profiles'>,
  issueId: string,
  ids: string[] = [],
): Promise<(PeopleBatch | OwnerChecks)[]> => [
  await owners(t, caller, issueId, 'assignee'),
  await owners(t, caller, issueId, 'reviewer'),
  await recipients(t, caller, issueId),
  await canOwn(t, caller, issueId, 'assignee', ids),
  await canOwn(t, caller, issueId, 'reviewer', ids),
  await canOwn(t, caller, issueId, 'recipient', ids),
]

function ready(answer: PeopleBatch): Ready {
  if (answer.state !== 'ready') throw new Error(`expected a batch, got ${JSON.stringify(answer)}`)
  return answer
}

function checked(answer: OwnerChecks): Checked {
  if (answer.state !== 'ready') throw new Error(`expected checks, got ${JSON.stringify(answer)}`)
  return answer
}

/* Every batch of a list from its start to its end, and the rows it listed
 * in order. */
async function listAll(
  read: (after?: string) => Promise<PeopleBatch>,
): Promise<{ rows: Ready['rows']; batches: Ready[] }> {
  const batches: Ready[] = []
  let after: string | undefined
  for (let round = 0; round < 500; round++) {
    const batch = ready(await read(after))
    batches.push(batch)
    // a stopped batch never answers an end it did not reach
    if (batch.stopped) expect(batch.next).not.toBeNull()
    if (batch.next === null) return { rows: batches.flatMap((b) => b.rows), batches }
    after = batch.next
  }
  throw new Error('the list did not end')
}

/* The names listed, sorted. */
const namesOf = (rows: readonly { name: string }[]) => rows.map((r) => r.name).sort()

/* withOrg with helpers that plant people, grants, team shares, memberships
 * and tasks, and Pia's task in Firmware, which the tests pick for. TBED's
 * lead `user` edits it, and so do the organization admin and the guest,
 * who holds User on TBED. `keyed` keys every name and stamps the
 * organization ready; call it once everything is planted. */
async function base(t: T = newT()) {
  const f = await withOrg(t)
  const person = (name: string, extra: Partial<Doc<'profiles'>> = {}) =>
    plantSeat(t, { org_id: f.org.id, name, accepted_at: NOW, auth_user_id: uuid(), ...extra })
  const grant = (project: Doc<'projects'>, who: Doc<'profiles'>, level: GrantLevel = 'user') =>
    t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: project.id, profile_id: who.id, level }),
    )
  const task = (project: Doc<'projects'>, fields: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: project.org_id, project_id: project.id, ...fields })
  /* A new top-level project led by the organization admin, with one
   * sub-project. */
  const elsewhere = async (extra: Partial<Doc<'projects'>> = {}) => {
    const meta = await plantProject(t, {
      org_id: f.org.id,
      name: 'Elsewhere',
      lead_id: f.admin.id,
      ...extra,
    })
    const sub = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: meta.id,
      name: 'Elsewhere sub',
    })
    return { meta, sub }
  }
  const issue = await task(f.sub, { title: 'Flash the bootloader' })
  const keyed = () => keyOrg(t, f.org.id)
  return { t, f, person, grant, task, elsewhere, issue, keyed }
}

/* base with 30 more people who edit Firmware, Person 00 to Person 29, and
 * Zoë Ångström, who sorts after them: 34 owners with the admin, the lead
 * and the guest. */
async function crowded() {
  const b = await base()
  const crowd: Doc<'profiles'>[] = []
  for (let i = 0; i < 30; i++) {
    const p = await b.person(`Person ${String(i).padStart(2, '0')}`)
    await b.grant(b.f.sub, p)
    crowd.push(p)
  }
  const zoe = await b.person('Zoë Ångström')
  await b.grant(b.f.sub, zoe)
  await b.keyed()
  return { ...b, crowd, zoe }
}

describe("the pickers' arguments", () => {
  it('refuses a search past LIMITS.search with its sentence, on both lists', async () => {
    const c = await crowded()
    const search = 'x'.repeat(LIMITS.search.max + 1)
    for (const read of [
      () => owners(c.t, c.f.user, c.issue.id, 'assignee', { search }),
      () => recipients(c.t, c.f.user, c.issue.id, { search }),
    ]) {
      const e = await expectRefusal(read(), 'rule')
      expect(e.data.message).toBe(LIMITS.search.refusal)
    }
    // the longest search passes
    const longest = 'x'.repeat(LIMITS.search.max)
    expect(ready(await recipients(c.t, c.f.user, c.issue.id, { search: longest })).rows).toEqual([])
  })

  it('answers every match up to `through`, and refuses a `through` not after `after`', async () => {
    const b = await base()
    // 57 people who edit Firmware make 60 owners with the admin, the lead
    // and the guest, and 60 recipients with the admin, the guest and the
    // organization viewer, since the lead is the caller, so each list runs
    // past two batches
    for (let i = 0; i < 57; i++)
      await b.grant(b.f.sub, await b.person(`Member ${String(i).padStart(2, '0')}`))
    await b.keyed()
    for (const read of [
      (a: ListArgs) => owners(b.t, b.f.user, b.issue.id, 'assignee', a),
      (a: ListArgs) => recipients(b.t, b.f.user, b.issue.id, a),
    ]) {
      const all = await listAll((after) => read({ after }))
      expect(all.batches.map((x) => x.rows.length)).toEqual([25, 25, 10])
      const [one, two] = all.batches
      const second = two.next as string
      // from the start up to the second batch's end, more rows than one
      // batch holds, so only a reader that passes `through` on answers them
      const kept = ready(await read({ through: second }))
      expect(kept.rows).toEqual([...one.rows, ...two.rows])
      expect(kept.stopped).toBe(false)
      expect(kept.next).toBe(second)
      // between the two cursors, the second batch alone
      const between = ready(await read({ after: one.next as string, through: second }))
      expect(between.rows).toEqual(two.rows)
      await expectRefusal(
        read({ after: second, through: second }),
        'bad_request',
        /through must be a cursor after the one in after/,
      )
    }
  })

  it('opens a cursor only for its list, organization, task, field and search', async () => {
    const c = await crowded()
    const other = await c.task(c.f.sub, { title: 'Another task' })
    const next = ready(await owners(c.t, c.f.user, c.issue.id, 'assignee')).next as string
    const recipientsNext = ready(await recipients(c.t, c.f.user, c.issue.id)).next as string
    // one character of the cursor changed
    const changed = `${next.slice(0, -1)}${next.endsWith('0') ? '1' : '0'}`
    for (const read of [
      () => owners(c.t, c.f.user, c.issue.id, 'assignee', { after: recipientsNext }),
      () => owners(c.t, c.f.user, other.id, 'assignee', { after: next }),
      () => owners(c.t, c.f.user, c.issue.id, 'reviewer', { after: next }),
      () => owners(c.t, c.f.user, c.issue.id, 'assignee', { search: 'person', after: next }),
      () => owners(c.t, c.f.user, c.issue.id, 'assignee', { after: changed }),
      () => owners(c.t, c.f.user, c.issue.id, 'assignee', { through: 'not a cursor' }),
    ])
      await expectRefusal(read(), 'bad_request', /for the same task, field and search/)
    for (const read of [
      () => recipients(c.t, c.f.user, c.issue.id, { after: next }),
      () => recipients(c.t, c.f.user, other.id, { after: recipientsNext }),
      () => recipients(c.t, c.f.user, c.issue.id, { search: 'person', after: recipientsNext }),
    ])
      await expectRefusal(read(), 'bad_request', /for the same task and search/)
    // the cursor itself opens
    expect(
      ready(await owners(c.t, c.f.user, c.issue.id, 'assignee', { after: next })).rows,
    ).toHaveLength(34 - LIST_BATCH)
  })

  it('shares cursors between two searches with one name key, such as "Café" and "cafe"', async () => {
    const b = await base()
    for (let i = 0; i < 30; i++)
      await b.grant(b.f.sub, await b.person(`Café crew ${String(i).padStart(2, '0')}`))
    await b.keyed()
    const first = ready(await owners(b.t, b.f.user, b.issue.id, 'assignee', { search: 'Café' }))
    expect(first.rows).toHaveLength(LIST_BATCH)
    const rest = ready(
      await owners(b.t, b.f.user, b.issue.id, 'assignee', {
        search: 'CAFE',
        after: first.next as string,
      }),
    )
    expect(namesOf(rest.rows)).toEqual(['25', '26', '27', '28', '29'].map((n) => `Café crew ${n}`))
    expect(rest.next).toBeNull()
  })

  it(`refuses more than ${BY_IDS_MAX} ids as sent, and answers repeated ids once, in the order asked`, async () => {
    const b = await base()
    await b.keyed()
    for (const ids of [
      Array.from({ length: BY_IDS_MAX + 1 }, () => uuid()),
      Array.from({ length: BY_IDS_MAX + 1 }, () => b.f.guest.id),
    ])
      await expectRefusal(
        canOwn(b.t, b.f.user, b.issue.id, 'assignee', ids),
        'bad_request',
        /at most 100 people/,
      )
    const answer = checked(
      await canOwn(b.t, b.f.user, b.issue.id, 'assignee', [
        b.f.guest.id,
        b.f.admin.id,
        b.f.guest.id,
        b.f.viewer.id,
        b.f.admin.id,
      ]),
    )
    expect(answer.rows.map((r) => [r.person?.name, r.eligible])).toEqual([
      ['guest', true],
      ['admin', true],
      ['viewer', false],
    ])
    expect(
      checked(
        await canOwn(b.t, b.f.user, b.issue.id, 'assignee', Array(BY_IDS_MAX).fill(b.f.guest.id)),
      ).rows,
    ).toHaveLength(1)
  })
})

describe("the pickers' gate", () => {
  it('answers unavailable alike for every task the caller cannot pick for, on all three queries', async () => {
    const b = await base()
    const hidden = await b.task(b.f.hidden)
    const foreign = await b.task(b.f.otherProject)
    const archived = await b.task(b.f.sub, { archived_at: NOW })
    const pcb = await b.task(b.f.sub2)
    await b.t.run((ctx) => ctx.db.patch(b.f.sub2._id, { archived_at: NOW }))
    const away = await b.elsewhere({ archived_at: NOW })
    await b.grant(away.meta, b.f.guest)
    const underArchived = await b.task(away.sub)
    const orphanProject = await plantProject(b.t, {
      org_id: b.f.org.id,
      type: 'project',
      parent_id: uuid(),
    })
    const orphan = await b.task(orphanProject)
    const deleted = await b.task(b.f.sub)
    await as(b.t, b.f.user).mutation(api.issues.deleteDeep, { org_id: b.f.org.id, id: deleted.id })
    await b.keyed()
    const ids = [b.f.guest.id, b.f.user.id]
    for (const [name, id] of [
      ['an unknown task', uuid()],
      ["another organization's task", foreign.id],
      ['a deleted task', deleted.id],
      ['an archived task', archived.id],
      ['a task in an archived sub-project', pcb.id],
      ['a task under an archived top-level project', underArchived.id],
      ['a task in a project whose parent is gone', orphan.id],
      ['a task in a project the caller cannot see', hidden.id],
    ] as const)
      for (const answer of await everyAnswer(b.t, b.f.guest, id, ids))
        expect(answer, name).toEqual({ state: 'unavailable' })
    // the guest picks for a task of Firmware
    expect((await everyAnswer(b.t, b.f.guest, b.issue.id, ids)).map((a) => a.state)).toEqual(
      Array(6).fill('ready'),
    )
  })

  it('refuses whoever reads the project without Edit with the write gate’s sentence', async () => {
    const b = await base()
    const vera = await b.person('Vera')
    await b.grant(b.f.sub, vera, 'viewer')
    const gwen = await b.person('Gwen', { org_role: 'guest' })
    await b.grant(b.f.sub, gwen, 'viewer')
    await b.keyed()
    // a Viewer grant, an organization viewer with User on TBED, a guest
    // with a Viewer grant
    for (const caller of [vera, b.f.viewer, gwen])
      for (const answer of await everyAnswer(b.t, caller, b.issue.id, [b.f.guest.id]))
        expect(answer, caller.name).toEqual({ state: 'refused', message: NO_WRITE_ACCESS })
  })

  it('lists for a guest and an agent with User', async () => {
    const b = await base()
    await b.grant(b.f.sub, b.f.agent)
    await b.keyed()
    expect(namesOf(ready(await owners(b.t, b.f.guest, b.issue.id, 'assignee')).rows)).toEqual([
      'Relay',
      'admin',
      'guest',
      'user',
    ])
    // an agent has no login to call through, so it reads the model
    const agent = await b.t.run((ctx) =>
      taskOwnersOf(ctx, b.f.agent, { issue_id: b.issue.id, field: 'reviewer' }),
    )
    expect(namesOf(ready(agent).rows)).toEqual(['Relay', 'admin', 'guest', 'user'])
    const mentions = await b.t.run((ctx) =>
      syncRecipientsOf(ctx, b.f.agent, { issue_id: b.issue.id }),
    )
    expect(namesOf(ready(mentions).rows)).toEqual(['admin', 'guest', 'user', 'viewer'])
  })

  it('refuses a reviewer on a group with its sentence after the Edit check, and lists for the rest', async () => {
    const b = await base()
    const group = await b.task(b.f.sub, { title: 'Bring-up' })
    await b.task(b.f.sub, { parent_id: group.id })
    // a group whose only active subtask sits in an archived project is no
    // group
    const lone = await b.task(b.f.sub, { title: 'Lone' })
    await b.task(b.f.sub2, { parent_id: lone.id })
    await b.task(b.f.sub, { parent_id: lone.id, archived_at: NOW })
    await b.t.run((ctx) => ctx.db.patch(b.f.sub2._id, { archived_at: NOW }))
    const vera = await b.person('Vera')
    await b.grant(b.f.sub, vera, 'viewer')
    await b.keyed()
    const ids = [b.f.guest.id]
    expect((await everyAnswer(b.t, b.f.user, group.id, ids)).map((a) => a.state)).toEqual([
      'ready',
      'refused',
      'ready',
      'ready',
      'refused',
      'ready',
    ])
    const refusal = { state: 'refused', message: REVIEWER_ON_GROUP }
    expect(await owners(b.t, b.f.user, group.id, 'reviewer')).toEqual(refusal)
    expect(await canOwn(b.t, b.f.user, group.id, 'reviewer', ids)).toEqual(refusal)
    expect((await everyAnswer(b.t, b.f.user, lone.id, ids)).map((a) => a.state)).toEqual(
      Array(6).fill('ready'),
    )
    // a caller without Edit learns nothing about the subtasks
    for (const answer of await everyAnswer(b.t, vera, group.id, ids))
      expect(answer).toEqual({ state: 'refused', message: NO_WRITE_ACCESS })
  })

  it('refuses someone not signed in, a seat of another organization and a switched-off seat', async () => {
    const b = await base()
    await b.keyed()
    const args = { org_id: b.f.org.id, issue_id: b.issue.id }
    await expectRefusal(b.t.query(api.pickers.syncRecipients, args), 'forbidden', /not signed in/)
    await expectRefusal(
      as(b.t, b.f.otherAdmin).query(api.pickers.taskOwners, { ...args, field: 'assignee' }),
      'forbidden',
      /no profile in this organization/,
    )
    await b.t.run((ctx) => ctx.db.patch(b.f.guest._id, { active: false }))
    await expectRefusal(
      canOwn(b.t, b.f.guest, b.issue.id, 'assignee', []),
      'forbidden',
      /no profile/,
    )
  })
})

describe("the pickers' order and continuation", () => {
  it('lists 60 owners at 25 a batch as 25, 25 and 10, equal names in id order', async () => {
    const b = await base()
    // 57 people and the admin, the lead and the guest; three share a name
    for (let i = 0; i < 54; i++)
      await b.grant(b.f.sub, await b.person(`Member ${String(i).padStart(2, '0')}`))
    for (let i = 0; i < 3; i++) await b.grant(b.f.sub, await b.person('Same Name'))
    await b.keyed()
    const all = await listAll((after) => owners(b.t, b.f.user, b.issue.id, 'assignee', { after }))
    expect(all.batches.map((x) => x.rows.length)).toEqual([25, 25, 10])
    expect(all.batches.map((x) => x.stopped)).toEqual([false, false, false])
    expect(new Set(all.rows.map((r) => r.id)).size).toBe(60)
    const same = all.rows.filter((r) => r.name === 'Same Name').map((r) => r.id)
    expect(same).toEqual([...same].sort())
    // name order, then id
    const keys = all.rows.map((r) => `${nameKey(r.name)}\u0000${r.id}`)
    expect(keys).toEqual([...keys].sort())
  })

  it('places a person renamed between batches by the new name, so one read before shows again', async () => {
    const c = await crowded()
    const first = ready(await owners(c.t, c.f.user, c.issue.id, 'assignee'))
    const read = c.crowd[0]
    const unread = c.crowd[29]
    expect(first.rows.map((r) => r.id)).toContain(read.id)
    expect(first.rows.map((r) => r.id)).not.toContain(unread.id)
    const rename = (p: Doc<'profiles'>, name: string) =>
      c.t.run((ctx) => ctx.db.patch(p._id, { name, name_key: nameKey(name) }))
    await rename(read, 'Zz Read Again')
    await rename(unread, 'Zzz Unread Later')
    const rest = await listAll((after) =>
      owners(c.t, c.f.user, c.issue.id, 'assignee', { after: after ?? (first.next as string) }),
    )
    const seen = [...first.rows, ...rest.rows].map((r) => r.id)
    // every person at least once, the one read before the rename twice, so
    // the app keys its rows by id
    expect(new Set(seen).size).toBe(34)
    expect(seen.filter((id) => id === read.id)).toHaveLength(2)
    expect(seen.filter((id) => id === unread.id)).toHaveLength(1)
    expect(rest.rows.slice(-2).map((r) => r.name)).toEqual(['Zz Read Again', 'Zzz Unread Later'])
  })

  it('offers someone who gains access after the cursor, and not again one before it', async () => {
    const c = await crowded()
    const first = ready(await owners(c.t, c.f.user, c.issue.id, 'assignee'))
    const aaron = await c.person('Aaron', { name_key: nameKey('Aaron') })
    const zed = await c.person('Zed Late', { name_key: nameKey('Zed Late') })
    await c.grant(c.f.sub, aaron)
    await c.grant(c.f.sub, zed)
    const rest = await listAll((after) =>
      owners(c.t, c.f.user, c.issue.id, 'assignee', { after: after ?? (first.next as string) }),
    )
    const ids = rest.rows.map((r) => r.id)
    expect(ids).toContain(zed.id)
    expect(ids).not.toContain(aaron.id)
    // a first batch now starts with Aaron
    expect(ready(await owners(c.t, c.f.user, c.issue.id, 'assignee')).rows[0].id).toBe(aaron.id)
  })
})

describe("the pickers' search", () => {
  it('finds every word anywhere in a name, accents and case ignored, past the first batch', async () => {
    const c = await crowded()
    const first = ready(await owners(c.t, c.f.user, c.issue.id, 'assignee'))
    expect(first.rows.map((r) => r.id)).not.toContain(c.zoe.id)
    const zoe = {
      id: c.zoe.id,
      name: 'Zoë Ångström',
      org_role: 'user',
      kind: 'person',
      active: true,
      pending: false,
    }
    for (const search of ['ström ZOE', 'angstrom', 'oë', '  ZOE   angSTRÖM ']) {
      expect(ready(await owners(c.t, c.f.user, c.issue.id, 'reviewer', { search })).rows).toEqual([
        zoe,
      ])
      expect(ready(await recipients(c.t, c.f.user, c.issue.id, { search })).rows).toEqual([zoe])
    }
  })

  it('matches no fuzzy subsequence, and a search that matches nobody ends with no rows', async () => {
    const b = await base()
    const john = await b.person('John Smith')
    await b.grant(b.f.sub, john)
    await b.keyed()
    expect(
      ready(await owners(b.t, b.f.user, b.issue.id, 'assignee', { search: 'smi jo' })).rows,
    ).toHaveLength(1)
    const none = { state: 'ready', rows: [], next: null, stopped: false }
    expect(await owners(b.t, b.f.user, b.issue.id, 'assignee', { search: 'jsm' })).toEqual(none)
    expect(await recipients(b.t, b.f.user, b.issue.id, { search: 'jsm' })).toEqual(none)
    expect(await recipients(b.t, b.f.user, b.issue.id, { search: 'nobody' })).toEqual(none)
  })
})

describe("the pickers' names", () => {
  it('answers not_ready on both lists until the names are keyed, while canOwn answers', async () => {
    const b = await base()
    expect(await owners(b.t, b.f.user, b.issue.id, 'assignee')).toEqual({ state: 'not_ready' })
    expect(await owners(b.t, b.f.user, b.issue.id, 'reviewer')).toEqual({ state: 'not_ready' })
    expect(await recipients(b.t, b.f.user, b.issue.id)).toEqual({ state: 'not_ready' })
    expect(
      checked(await canOwn(b.t, b.f.user, b.issue.id, 'recipient', [b.f.guest.id])).rows,
    ).toEqual([
      {
        id: b.f.guest.id,
        person: {
          id: b.f.guest.id,
          name: 'guest',
          org_role: 'guest',
          kind: 'person',
          active: true,
          pending: false,
        },
        eligible: true,
      },
    ])
    await b.keyed()
    expect((await owners(b.t, b.f.user, b.issue.id, 'assignee')).state).toBe('ready')
  })
})

describe("the owner pickers' rule", () => {
  it('offers active admins, users and guests with Edit, and agents with the user role', async () => {
    const b = await base()
    const plant = async (name: string, extra: Partial<Doc<'profiles'>>, level: GrantLevel) => {
      const p = await b.person(name, extra)
      await b.grant(b.f.sub, p, level)
      return p
    }
    await plant('Ada', {}, 'user')
    await plant('Gil', { org_role: 'guest' }, 'user')
    await plant('Vic', {}, 'viewer')
    await plant('Ola', { org_role: 'viewer' }, 'user')
    await plant('Ivy', { active: false }, 'user')
    // agents and an invited seat nobody has claimed hold no login
    const seat = async (name: string, extra: Partial<Doc<'profiles'>>) => {
      const p = await plantSeat(b.t, { org_id: b.f.org.id, name, ...extra })
      await b.grant(b.f.sub, p)
      return p
    }
    await seat('Bot viewer', { kind: 'agent', org_role: 'viewer' })
    await seat('Bot user', { kind: 'agent' })
    const pending = await seat('Pending Pat', {})
    await b.keyed()
    for (const field of ['assignee', 'reviewer'] as const) {
      const all = await listAll((after) => owners(b.t, b.f.user, b.issue.id, field, { after }))
      expect(namesOf(all.rows), field).toEqual([
        'Ada',
        'Bot user',
        'Gil',
        'Pending Pat',
        'admin',
        'guest',
        'user',
      ])
      expect(all.rows.find((r) => r.id === pending.id)?.pending).toBe(true)
    }
  })

  it("offers for a subtask only who sees its parent's sub-project, also one the caller cannot see", async () => {
    const b = await base()
    // Lena leads Firmware alone and cannot see Board rev
    const lena = await b.person('Lena')
    await b.t.run((ctx) => ctx.db.patch(b.f.sub._id, { lead_id: lena.id }))
    const parent = await b.task(b.f.sub2, { title: 'Board bring-up' })
    const subtask = await b.task(b.f.sub, { parent_id: parent.id })
    const quinn = await b.person('Quinn')
    await b.grant(b.f.sub, quinn)
    const rae = await b.person('Rae')
    await b.grant(b.f.sub, rae)
    await b.grant(b.f.sub2, rae, 'viewer')
    await b.keyed()
    const all = await listAll((after) => owners(b.t, lena, subtask.id, 'assignee', { after }))
    // Lena edits the subtask but cannot see its parent, as Quinn
    expect(namesOf(all.rows)).toEqual(['Rae', 'admin', 'guest', 'user'])
  })

  it("offers whoever reaches a parent's top-level project, its own or another through a sub-project", async () => {
    const b = await base()
    // a parent older code stored on TBED itself, which User on Firmware
    // shows for navigation
    const own = await b.task(b.f.meta, { title: 'Legacy plan' })
    const underOwn = await b.task(b.f.sub, { parent_id: own.id })
    const xena = await b.person('Xena')
    await b.grant(b.f.sub, xena)
    // a parent stored on another top-level project, reached through its
    // sub-project only
    const away = await b.elsewhere()
    const far = await b.task(away.meta, { title: 'Far plan' })
    const underFar = await b.task(b.f.sub, { parent_id: far.id })
    const yuri = await b.person('Yuri')
    await b.grant(b.f.sub, yuri)
    await b.grant(away.sub, yuri, 'viewer')
    await b.keyed()
    const list = async (id: string) =>
      namesOf((await listAll((after) => owners(b.t, b.f.user, id, 'reviewer', { after }))).rows)
    expect(await list(underOwn.id)).toEqual(['Xena', 'Yuri', 'admin', 'guest', 'user'])
    // the admin leads Elsewhere; Xena, the guest and the lead do not reach it
    expect(await list(underFar.id)).toEqual(['Yuri', 'admin'])
  })

  it('offers nobody for a subtask whose parent sits in a project that is gone, or under one', async () => {
    const b = await base()
    const gone = await b.task(b.f.sub, { project_id: uuid() })
    const loose = await plantProject(b.t, {
      org_id: b.f.org.id,
      type: 'project',
      parent_id: uuid(),
    })
    const orphaned = await b.task(loose)
    const first = await b.task(b.f.sub, { parent_id: gone.id })
    const second = await b.task(b.f.sub, { parent_id: orphaned.id })
    await b.keyed()
    for (const subtask of [first, second]) {
      expect(await owners(b.t, b.f.user, subtask.id, 'assignee')).toEqual({
        state: 'ready',
        rows: [],
        next: null,
        stopped: false,
      })
      expect(
        checked(await canOwn(b.t, b.f.user, subtask.id, 'reviewer', [b.f.admin.id])).rows[0]
          .eligible,
      ).toBe(false)
      // the recipients ask nothing of the tasks above
      expect(namesOf(ready(await recipients(b.t, b.f.user, subtask.id)).rows)).toEqual([
        'admin',
        'guest',
        'viewer',
      ])
    }
  })
})

describe("the recipient picker's rule", () => {
  it('offers active people who see the task, and leaves out agents, switched-off people and the caller', async () => {
    const b = await base()
    const vic = await b.person('Vic')
    await b.grant(b.f.sub, vic, 'viewer')
    const ola = await b.person('Ola', { org_role: 'viewer' })
    await b.grant(b.f.sub, ola, 'viewer')
    const ivy = await b.person('Ivy', { active: false })
    await b.grant(b.f.sub, ivy)
    await b.grant(b.f.sub, b.f.agent)
    const pcb = await b.person('Pia')
    await b.grant(b.f.sub2, pcb)
    await b.keyed()
    const all = await listAll((after) => recipients(b.t, b.f.user, b.issue.id, { after }))
    expect(namesOf(all.rows)).toEqual(['Ola', 'Vic', 'admin', 'guest', 'viewer'])
    // the guest writing leaves out the guest and lists the lead
    const fromGuest = await listAll((after) => recipients(b.t, b.f.guest, b.issue.id, { after }))
    expect(namesOf(fromGuest.rows)).toEqual(['Ola', 'Vic', 'admin', 'user', 'viewer'])
  })

  it('offers on a task stored on a top-level project whoever reaches one of its sub-projects', async () => {
    const b = await base()
    const legacy = await b.task(b.f.meta, { title: 'Legacy plan' })
    const sam = await b.person('Sam')
    await b.grant(b.f.sub2, sam, 'viewer')
    await b.keyed()
    expect(namesOf(ready(await recipients(b.t, b.f.user, legacy.id)).rows)).toEqual([
      'Sam',
      'admin',
      'guest',
      'viewer',
    ])
    // as an owner Sam needs Edit on TBED itself
    expect(namesOf(ready(await owners(b.t, b.f.user, legacy.id, 'assignee')).rows)).toEqual([
      'admin',
      'guest',
      'user',
    ])
  })

  it("leaves out the caller's own seat in a second organization of the same login", async () => {
    const b = await base()
    const second = await plantSeat(b.t, {
      org_id: b.f.otherOrg.id,
      name: 'user',
      auth_user_id: b.f.user.auth_user_id,
      accepted_at: NOW,
    })
    await b.grant(b.f.otherProject, second)
    const there = await b.task(b.f.otherProject)
    await keyOrg(b.t, b.f.otherOrg.id)
    const list = ready(await recipients(b.t, second, there.id))
    expect(list.rows.map((r) => r.id)).toEqual([b.f.otherAdmin.id])
    expect(
      checked(await canOwn(b.t, second, there.id, 'recipient', [second.id, b.f.user.id])).rows,
    ).toEqual([
      { id: second.id, person: expect.objectContaining({ id: second.id }), eligible: false },
      { id: b.f.user.id, person: null, eligible: false },
    ])
  })
})

describe('canOwn', () => {
  it('answers a switched-off holder by name and not eligible, and an unknown and a foreign id alike', async () => {
    const b = await base()
    const ivy = await b.person('Ivy')
    await b.grant(b.f.sub, ivy)
    const held = await b.task(b.f.sub, { assignee_id: ivy.id, reviewer_id: ivy.id })
    await b.t.run((ctx) => ctx.db.patch(ivy._id, { active: false }))
    await b.keyed()
    const unknown = uuid()
    for (const field of ['assignee', 'reviewer', 'recipient'] as const)
      expect(
        checked(await canOwn(b.t, b.f.user, held.id, field, [ivy.id, unknown, b.f.otherAdmin.id]))
          .rows,
        field,
      ).toEqual([
        {
          id: ivy.id,
          person: {
            id: ivy.id,
            name: 'Ivy',
            org_role: 'user',
            kind: 'person',
            active: false,
            pending: false,
          },
          eligible: false,
        },
        { id: unknown, person: null, eligible: false },
        { id: b.f.otherAdmin.id, person: null, eligible: false },
      ])
  })

  it("answers the caller's own id as a recipient not eligible, and as an owner by the rule", async () => {
    const b = await base()
    await b.keyed()
    for (const [field, eligible] of [
      ['recipient', false],
      ['assignee', true],
      ['reviewer', true],
    ] as const)
      expect(
        checked(await canOwn(b.t, b.f.user, b.issue.id, field, [b.f.user.id])).rows[0].eligible,
        field,
      ).toBe(eligible)
  })

  it('agrees with each list paged to its end, for every person of the organization', async () => {
    const b = await base()
    const away = await b.elsewhere()
    const parent = await b.task(away.sub, { title: 'Far plan' })
    const subtask = await b.task(b.f.sub, { parent_id: parent.id })
    const plant = async (name: string, extra: Partial<Doc<'profiles'>>, level: GrantLevel) => {
      const p = await b.person(name, extra)
      await b.grant(b.f.sub, p, level)
      return p
    }
    await plant('Ada', {}, 'user')
    await b.grant(away.sub, await plant('Bea', {}, 'user'), 'viewer')
    await plant('Vic', {}, 'viewer')
    await plant('Ivy', { active: false }, 'user')
    await plant('Bot', { kind: 'agent' }, 'user')
    await b.grant(away.meta, await plant('Ola', { org_role: 'viewer' }, 'viewer'), 'viewer')
    await b.keyed()
    const everyone = await b.t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', b.f.org.id))
        .collect(),
    )
    const ids = everyone.map((p) => p.id)
    for (const issue of [b.issue, subtask]) {
      const lists = {
        assignee: () => (after?: string) => owners(b.t, b.f.user, issue.id, 'assignee', { after }),
        reviewer: () => (after?: string) => owners(b.t, b.f.user, issue.id, 'reviewer', { after }),
        recipient: () => (after?: string) => recipients(b.t, b.f.user, issue.id, { after }),
      }
      for (const field of ['assignee', 'reviewer', 'recipient'] as const) {
        const listed = new Set((await listAll(lists[field]())).rows.map((r) => r.id))
        const rows = checked(await canOwn(b.t, b.f.user, issue.id, field, ids)).rows
        expect(rows.map((r) => r.id)).toEqual(ids)
        for (const row of rows)
          expect(row.eligible, `${field} ${row.person?.name}`).toBe(listed.has(row.id))
      }
    }
  })
})

describe("the pickers' read budgets", () => {
  it('stops a batch past NAMED_READ and lists every person once by following its cursors', async () => {
    const c = await crowded()
    const reads = {
      owners: (after?: string) => owners(c.t, c.f.user, c.issue.id, 'assignee', { after }),
      recipients: (after?: string) => recipients(c.t, c.f.user, c.issue.id, { after }),
      search: (after?: string) => recipients(c.t, c.f.user, c.issue.id, { search: 'zoe', after }),
    }
    const whole = {
      owners: await listAll(reads.owners),
      recipients: await listAll(reads.recipients),
      search: await listAll(reads.search),
    }
    expect(whole.search.rows.map((r) => r.id)).toEqual([c.zoe.id])
    Object.assign(NAMED_READ, { documents: 6 })
    for (const name of ['owners', 'recipients', 'search'] as const) {
      const parts = await listAll(reads[name])
      expect(
        parts.batches.some((b) => b.stopped),
        name,
      ).toBe(true)
      expect(parts.batches.length, name).toBeGreaterThan(whole[name].batches.length)
      expect(parts.rows, name).toEqual(whole[name].rows)
    }
  })

  it('answers over_budget with no row on all three queries past PICKERS.rule', async () => {
    const b = await base()
    await b.keyed()
    Object.assign(PICKERS.rule, { ranges: 1 })
    const answers = await everyAnswer(b.t, b.f.user, b.issue.id, [b.f.guest.id])
    expect(answers).toEqual(Array(6).fill({ state: 'over_budget' }))
    Object.assign(PICKERS.rule, DEFAULT_RULE, { documents: 2 })
    expect(await everyAnswer(b.t, b.f.user, b.issue.id, [b.f.guest.id])).toEqual(
      Array(6).fill({ state: 'over_budget' }),
    )
    // canOwn's lookups count against the same share: the fewest ranges
    // the rule needs, and two more, hold one lookup and not twenty
    Object.assign(PICKERS.rule, DEFAULT_RULE)
    const check = (ids: string[]) =>
      b.t.run((ctx) => canOwnOf(ctx, b.f.user, { issue_id: b.issue.id, field: 'recipient', ids }))
    let fewest = 0
    for (let ranges = 1; ranges < 100 && fewest === 0; ranges++) {
      Object.assign(PICKERS.rule, { ranges })
      if ((await check([])).state === 'ready') fewest = ranges
    }
    expect(fewest).toBeGreaterThan(1)
    Object.assign(PICKERS.rule, { ranges: fewest + 2 })
    expect((await check([b.f.guest.id])).state).toBe('ready')
    expect(await check(Array.from({ length: 20 }, () => uuid()))).toEqual({
      state: 'over_budget',
    })
  })
})

/* ------------------------------------------------------- the design size */

describe("the pickers inside Convex's limits", () => {
  let num = 30_000

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

  /* A list read measured, logged under `name` and checked to answer whole:
   * never stopped, and, when `end`, the end of the list. */
  async function whole(
    name: string,
    t: T,
    step: (ctx: QueryCtx) => Promise<PeopleBatch>,
    end = false,
  ) {
    const read = await measured(t, step)
    const batch = ready(read.answer)
    console.info(`pickers: ${name}`, {
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

  /* `n` open tasks of ordinary text in `project`, planted raw. */
  async function openTasks(t: T, f: OrgFixture, project: Doc<'projects'>, n: number) {
    await t.run(async (ctx) => {
      for (let i = 0; i < n; i++)
        await ctx.db.insert('issues', {
          id: uuid(),
          org_id: f.org.id,
          project_id: project.id,
          num: num++,
          title: 'Replace the fan controller on the bench rig and log the readings for the review',
          description: '',
          status: 'todo',
          priority: 'medium',
          paused: false,
          created_at: NOW,
          updated_at: NOW,
        })
    })
  }

  /* People named `names`, keyed, planted raw 400 a transaction, each a
   * member of `teams`. */
  async function people(
    t: T,
    f: OrgFixture,
    names: readonly string[],
    teams: readonly string[] = [],
  ): Promise<Doc<'profiles'>[]> {
    const out: Doc<'profiles'>[] = []
    for (let from = 0; from < names.length; from += 400)
      await t.run(async (ctx) => {
        for (let i = from; i < Math.min(names.length, from + 400); i++) {
          const _id = await ctx.db.insert('profiles', {
            id: uuid(),
            org_id: f.org.id,
            name: names[i],
            name_key: nameKey(names[i]),
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
          const p = (await ctx.db.get(_id)) as Doc<'profiles'>
          for (const team_id of teams)
            await ctx.db.insert('team_members', {
              team_id,
              profile_id: p.id,
              is_leader: false,
              name_key: p.name_key,
            })
          out.push(p)
        }
      })
    return out
  }

  /* `n` names that sort in the order given. */
  const names = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, '0')}`)

  /* A keyed team of the organization. */
  async function keyedTeam(t: T, f: OrgFixture, name: string): Promise<string> {
    const id = uuid()
    await t.run((ctx) =>
      ctx.db.insert('teams', {
        id,
        org_id: f.org.id,
        name,
        name_key: nameKey(name),
        track_delay_default: false,
        created_at: NOW,
      }),
    )
    return id
  }

  /* A top-level project with `subs` sub-projects, keyed, and `archived`
   * more archived ones. */
  async function projectWith(t: T, f: OrgFixture, name: string, subs: number, archived = 0) {
    const meta = await plantProject(t, { org_id: f.org.id, name, name_key: nameKey(name) })
    const all: Doc<'projects'>[] = []
    for (let i = 0; i < subs + archived; i++)
      all.push(
        await plantProject(t, {
          org_id: f.org.id,
          type: 'project',
          parent_id: meta.id,
          name: `${name} ${i}`,
          name_key: nameKey(`${name} ${i}`),
          ...(i < subs ? {} : { archived_at: NOW }),
        }),
      )
    return { meta, subs: all.slice(0, subs), all }
  }

  const grant = (t: T, project: Doc<'projects'>, p: Doc<'profiles'>, level: GrantLevel = 'user') =>
    t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: project.id,
        profile_id: p.id,
        level,
        name_key: nameKey(p.name),
      }),
    )

  const NOBODY = 'nobody has this name'

  it('reads the owner and recipient lists among 1,000 people, 995 of them in a team sharing the sub-project', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const platform = await keyedTeam(t, f, 'Platform')
    const ops = await keyedTeam(t, f, 'Ops')
    await t.run((ctx) =>
      ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      }),
    )
    await keyOrg(t, f.org.id)
    const crowd = await people(t, f, names('Member ', 995), [f.team.id, platform, ops])
    await openTasks(t, f, f.sub, 29)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const count = await t.run((ctx) =>
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect()
        .then((all) => all.length),
    )
    expect(count).toBe(1000)
    const first = await whole('owners, first batch, 995 in a sharing team', t, (ctx) =>
      taskOwnersOf(ctx, f.user, { issue_id: issue.id, field: 'assignee' }),
    )
    expect(first.batch.rows).toHaveLength(LIST_BATCH)
    // the walk reads the people of the batch, not the roster: the rule's
    // 997 members and about one profile a row, and a few ranges for the
    // gate, the rule and the three role indexes, not one a person
    expect(first.ranges).toBeLessThanOrEqual(40)
    expect(first.documents).toBeLessThanOrEqual(1200)
    const search = await whole(
      'owners, a search that matches nobody, 995 in a sharing team',
      t,
      (ctx) => taskOwnersOf(ctx, f.user, { issue_id: issue.id, field: 'assignee', search: NOBODY }),
      true,
    )
    expect(search.batch.rows).toEqual([])
    const last = crowd[crowd.length - 1]
    const found = await whole('owners, a search for the last name', t, (ctx) =>
      taskOwnersOf(ctx, f.user, { issue_id: issue.id, field: 'assignee', search: last.name }),
    )
    expect(found.batch.rows.map((r) => r.id)).toEqual([last.id])
    const mentions = await whole('recipients, first batch, 995 in a sharing team', t, (ctx) =>
      syncRecipientsOf(ctx, f.user, { issue_id: issue.id }),
    )
    expect(mentions.batch.rows).toHaveLength(LIST_BATCH)
    const nobody = await whole(
      'recipients, a search that matches nobody among 1,000 people',
      t,
      (ctx) => syncRecipientsOf(ctx, f.user, { issue_id: issue.id, search: NOBODY }),
      true,
    )
    expect(nobody.batch.rows).toEqual([])
    // the public queries answer the same under the deployment's limits
    expect(ready(await owners(t, f.user, issue.id, 'assignee')).rows).toEqual(first.batch.rows)
  }, 60_000)

  it('reads the owners among 1,000 people of whom 3 hold Edit by grants, and canOwn with 100 ids', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const atlas = await projectWith(t, f, 'Atlas', 3)
    const platform = await keyedTeam(t, f, 'Platform')
    const ops = await keyedTeam(t, f, 'Ops')
    await keyOrg(t, f.org.id)
    const crowd = await people(t, f, names('Member ', 995), [f.team.id, platform, ops])
    const keepers = [crowd[100], crowd[500], crowd[900]]
    for (const p of keepers) await grant(t, atlas.subs[0], p)
    await openTasks(t, f, atlas.subs[0], 29)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: atlas.subs[0].id })
    const first = await whole(
      'owners, first batch, 3 of 1,000 with Edit',
      t,
      (ctx) => taskOwnersOf(ctx, f.admin, { issue_id: issue.id, field: 'assignee' }),
      true,
    )
    // the admin, while levelsFrom gives admins Lead, and the three
    expect(first.batch.rows.map((r) => r.id)).toEqual([f.admin.id, ...keepers.map((p) => p.id)])
    const ids = crowd.slice(95, 195).map((p) => p.id)
    expect(ids).toHaveLength(BY_IDS_MAX)
    const check = await measured(t, (ctx) =>
      canOwnOf(ctx, f.admin, { issue_id: issue.id, field: 'assignee', ids }),
    )
    console.info('pickers: canOwn with 100 ids among 1,000 people', {
      ranges: check.ranges,
      documents: check.documents,
      mib: check.mib,
    })
    const rows = checked(check.answer).rows
    expect(rows).toHaveLength(BY_IDS_MAX)
    expect(rows.filter((r) => r.eligible).map((r) => r.id)).toEqual([keepers[0].id])
  }, 60_000)

  it('reads both lists on a sub-project shared with five teams under a top-level project shared with five others', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const teams: string[] = []
    for (let i = 0; i < 10; i++) teams.push(await keyedTeam(t, f, `Crew ${i}`))
    await t.run(async (ctx) => {
      for (const [i, team_id] of teams.entries())
        await ctx.db.insert('project_team_access', {
          project_id: i < 5 ? f.sub.id : f.meta.id,
          team_id,
          level: i % 2 ? 'viewer' : 'user',
          name_key: nameKey(`Crew ${i}`),
        })
    })
    await keyOrg(t, f.org.id)
    // six people a crew, each also in the next two crews, so each person
    // is in three and each crew has 18 members
    for (let i = 0; i < 10; i++)
      await people(t, f, names(`Crew ${i} member `, 6), [
        teams[i],
        teams[(i + 1) % 10],
        teams[(i + 2) % 10],
      ])
    await openTasks(t, f, f.sub, 29)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    const first = await whole('owners, first batch, 5 and 5 teams', t, (ctx) =>
      taskOwnersOf(ctx, f.user, { issue_id: issue.id, field: 'assignee' }),
    )
    expect(first.batch.rows).toHaveLength(LIST_BATCH)
    const mentions = await whole('recipients, first batch, 5 and 5 teams', t, (ctx) =>
      syncRecipientsOf(ctx, f.user, { issue_id: issue.id }),
    )
    expect(mentions.batch.rows).toHaveLength(LIST_BATCH)
  }, 60_000)

  it('reads the reviewers of a subtask whose parent sits on a top-level project of 30 live and 40 archived sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const atlas = await projectWith(t, f, 'Atlas', 30, 40)
    await keyOrg(t, f.org.id)
    const [pia, rae] = await people(t, f, ['Pia', 'Rae'])
    for (const p of [pia, rae]) await grant(t, f.sub, p)
    // the lead and Rae reach Atlas through its last archived sub-project
    for (const p of [f.user, rae]) await grant(t, atlas.all[69], p, 'viewer')
    for (const sub of atlas.subs) await openTasks(t, f, sub, 3)
    const parent = await plantIssue(t, { org_id: f.org.id, project_id: atlas.meta.id })
    const subtask = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      parent_id: parent.id,
    })
    const first = await whole(
      'owners, a reviewer under a parent on 30 and 40 archived sub-projects',
      t,
      (ctx) => taskOwnersOf(ctx, f.user, { issue_id: subtask.id, field: 'reviewer' }),
      true,
    )
    // the admin, the lead and Rae; Pia and the guest do not see Atlas
    expect(namesOf(first.batch.rows)).toEqual(['Rae', 'admin', 'user'])
  }, 60_000)

  it('reads the recipients and the gate of a task stored on a top-level project of 30 live and 40 archived sub-projects', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const atlas = await projectWith(t, f, 'Atlas', 30, 40)
    await keyOrg(t, f.org.id)
    const [kim, lou] = await people(t, f, ['Kim', 'Lou'])
    await grant(t, atlas.meta, kim)
    // Lou reaches Atlas only through its last archived sub-project
    await grant(t, atlas.all[69], lou)
    for (const sub of atlas.subs) await openTasks(t, f, sub, 3)
    const issue = await plantIssue(t, { org_id: f.org.id, project_id: atlas.meta.id })
    const first = await whole(
      'recipients, a task on a top-level project of 30 and 40 archived sub-projects',
      t,
      (ctx) => syncRecipientsOf(ctx, kim, { issue_id: issue.id }),
      true,
    )
    expect(namesOf(first.batch.rows)).toEqual(['Lou', 'admin'])
    const owners_ = await whole(
      'owners, a task on a top-level project of 30 and 40 archived sub-projects',
      t,
      (ctx) => taskOwnersOf(ctx, kim, { issue_id: issue.id, field: 'assignee' }),
      true,
    )
    expect(namesOf(owners_.batch.rows)).toEqual(['Kim', 'admin'])
    // Lou's own gate walks every sub-project before it finds Viewer
    const gate = await measured(t, (ctx) => syncRecipientsOf(ctx, lou, { issue_id: issue.id }))
    console.info('pickers: the gate of a caller who reaches the top-level project last', {
      ranges: gate.ranges,
      documents: gate.documents,
      mib: gate.mib,
      state: gate.answer.state,
    })
    expect(gate.answer).toEqual({ state: 'refused', message: NO_WRITE_ACCESS })
  }, 60_000)
})
