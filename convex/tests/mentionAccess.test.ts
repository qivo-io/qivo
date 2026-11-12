/* Who the editor's @ mention popup offers (pickers.mentions,
 * model/pickers.ts mentionsOf): only the people with access to the project
 * of the task whose text holds the "@", by name alone, never an email, for
 * every caller (the owner's decision of 12 November 2026). It holds the
 * gate that runs before any person is read, the rule, the rows and the
 * match, the cursors, readiness and the rule's read budget.
 * tests/pickers.test.ts measures its reads at the design size beside the
 * other task pickers', and tests/mentionSuggestions.test.ts holds the view
 * filter's list of every person. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it } from 'vitest'
import { api } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { MENTION_BATCH } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { NO_WRITE_ACCESS } from '../model/issues'
import { type MentionBatch, PICKERS } from '../model/pickers'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { keyOrg } from './nameKeys.setup'

const DEFAULT_RULE = structuredClone(PICKERS.rule)
afterEach(() => {
  Object.assign(PICKERS.rule, DEFAULT_RULE)
})

type Ready = Extract<MentionBatch, { state: 'ready' }>
type Args = { search?: string; after?: string; through?: string }

const mentions = (t: T, caller: Doc<'profiles'>, issueId: string, a: Args = {}) =>
  as(t, caller).query(api.pickers.mentions, { org_id: caller.org_id, issue_id: issueId, ...a })

function ready(answer: MentionBatch): Ready {
  if (answer.state !== 'ready') throw new Error(`expected a batch, got ${JSON.stringify(answer)}`)
  return answer
}

/* Every row of the list for `caller` on task `issueId`, read to its end. */
async function listAll(t: T, caller: Doc<'profiles'>, issueId: string, search?: string) {
  const rows: Ready['rows'] = []
  let after: string | undefined
  for (let round = 0; round < 100; round++) {
    const batch = ready(
      await mentions(t, caller, issueId, {
        ...(search === undefined ? {} : { search }),
        ...(after === undefined ? {} : { after }),
      }),
    )
    rows.push(...batch.rows)
    if (batch.next === null) return rows
    after = batch.next
  }
  throw new Error('the list did not end')
}

const idsOf = (rows: readonly { id: string }[]) => rows.map((r) => r.id).sort()

/* withOrg, whose `user` leads TBED and whose guest and viewer hold a grant
 * on it, with a task in each of its sub-projects (Firmware and Board rev)
 * and one in Skunkworks, which only `user` reaches, and helpers that plant
 * a person, a grant and a team share. `keyed` keys every name; call it
 * once everything is planted. */
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
      email: `${name.toLowerCase().replace(/\s+/g, '.')}@testbed.test`,
      accepted_at: NOW,
      auth_user_id: uuid(),
      ...extra,
    })
  const grant = (
    project: Doc<'projects'>,
    who: Doc<'profiles'>,
    level: 'viewer' | 'user' = 'user',
  ) =>
    t.run((ctx) =>
      ctx.db.insert('project_access', { project_id: project.id, profile_id: who.id, level }),
    )
  const task = (project: Doc<'projects'>, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: project.org_id, project_id: project.id, ...extra })
  const firmware = await task(f.sub)
  const board = await task(f.sub2)
  const skunk = await task(f.hidden)
  const keyed = async () => {
    await keyOrg(t, f.org.id)
    await keyOrg(t, f.otherOrg.id)
  }
  return { t, f, person, grant, task, firmware, board, skunk, keyed }
}

describe('who the mention popup offers', () => {
  it("offers the people with access to the task's project, and nobody else of the organization", async () => {
    const b = await base()
    const { t, f } = b
    // a Viewer grant on Firmware alone, a member of a team that shares it,
    // an agent with a grant, and people who reach nothing or another
    // sub-project
    const lin = await b.person('Lin Park')
    await b.grant(f.sub, lin, 'viewer')
    const tom = await b.person('Tom Reed')
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: tom.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const bot = await plantSeat(t, { org_id: f.org.id, name: 'Build Bot', kind: 'agent' })
    await b.grant(f.sub, bot)
    const outsider = await b.person('Olga Nilsen')
    const other = await b.person('Bo Winter')
    await b.grant(f.sub2, other)
    await plantSeat(t, { org_id: f.otherOrg.id, name: 'Lin Park', email: 'lin@other.test' })
    await b.keyed()

    const rows = await listAll(t, f.user, b.firmware.id)
    // the caller, the guest and the viewer through their grant on the
    // top-level project, the team's members (the admin is one), and Lin,
    // Tom and the agent
    expect(idsOf(rows)).toEqual(
      idsOf([f.user, f.guest, f.viewer, f.admin, lin, tom, bot].map((p) => ({ id: p.id }))),
    )
    for (const left of [outsider, other, f.agent, f.otherAdmin])
      expect(rows.map((r) => r.id)).not.toContain(left.id)
    // in the order of the name keys, as the list pages
    const keys = rows.map((r) => nameKey(r.name))
    expect(keys).toEqual([...keys].sort())

    // a task in the sibling sub-project offers Bo, and neither Lin, Tom
    // nor the agent, who reach Firmware alone
    expect(idsOf(await listAll(t, f.user, b.board.id))).toEqual(
      idsOf([f.user, f.guest, f.viewer, other].map((p) => ({ id: p.id }))),
    )
    // a task in a project only its lead reaches offers the lead alone
    expect(idsOf(await listAll(t, f.user, b.skunk.id))).toEqual([f.user.id])
  })

  it('leaves out a switched-off person and an organization admin without a level, whatever they hold', async () => {
    const b = await base()
    const { t, f } = b
    const off = await b.person('Switched Off', { active: false })
    await b.grant(f.sub, off)
    const invited = await plantSeat(t, { org_id: f.org.id, name: 'Invited Seat' })
    await b.grant(f.sub, invited)
    await b.keyed()
    const ids = (await listAll(t, f.user, b.firmware.id)).map((r) => r.id)
    expect(ids).not.toContain(off.id)
    // withOrg's admin holds no lead, grant or team share on TBED
    expect(ids).not.toContain(f.admin.id)
    // an invitation nobody accepted yet holds its grant and is offered
    expect(ids).toContain(invited.id)
  })

  it('counts whoever reaches a sub-project for a task stored on the top-level project', async () => {
    const b = await base()
    const { t, f } = b
    const lin = await b.person('Lin Park')
    await b.grant(f.sub, lin, 'viewer')
    const onTop = await b.task(f.meta)
    await b.keyed()
    expect((await listAll(t, f.user, onTop.id)).map((r) => r.id)).toContain(lin.id)
  })
})

describe("the mention popup's rows and match", () => {
  it('answers the name, initials and color, never an email, and finds nobody by an email', async () => {
    const b = await base()
    const { t, f } = b
    const anna = await b.person('Anna Fält', { color: 'teal', email: 'anna@qivo.test' })
    await b.grant(f.sub, anna)
    await b.keyed()
    for (const caller of [f.user, f.guest]) {
      const [row] = ready(await mentions(t, caller, b.firmware.id, { search: 'anna' })).rows
      expect(row).toEqual({ id: anna.id, name: 'Anna Fält', initials: 'AF', color: '#8A8F98' })
    }
    // reordered fragments, case and blanks, initials; accents stay
    for (const search of ['ält ann', '  FÄ\tNA ', 'af'])
      expect(idsOf(await listAll(t, f.user, b.firmware.id, search)), search).toEqual([anna.id])
    for (const search of ['anna@qivo.test', 'qivo.test', 'qivo anna', 'falt'])
      expect(await listAll(t, f.user, b.firmware.id, search), search).toEqual([])
  })

  it('pages 20 people 8 at a time and opens a cursor only for its task and search', async () => {
    const b = await base()
    const { t, f } = b
    for (let i = 0; i < 20; i++)
      await b.grant(f.meta, await b.person(`Crew ${String(i).padStart(2, '0')}`))
    await b.keyed()
    const one = ready(await mentions(t, f.user, b.firmware.id, { search: 'crew' }))
    expect(one.rows).toHaveLength(MENTION_BATCH)
    expect(one.next).not.toBeNull()
    const cursor = one.next as string
    const two = ready(await mentions(t, f.user, b.firmware.id, { search: 'crew', after: cursor }))
    expect(two.rows.map((r) => r.name)).toEqual(
      Array.from({ length: MENTION_BATCH }, (_, i) => `Crew ${String(i + 8).padStart(2, '0')}`),
    )
    expect(await listAll(t, f.user, b.firmware.id, 'crew')).toHaveLength(20)
    // another task of the same project, and another search
    for (const [issue, search] of [
      [b.board.id, 'crew'],
      [b.firmware.id, 'cre'],
    ] as const)
      await expectRefusal(
        mentions(t, f.user, issue, { search, after: cursor }),
        'bad_request',
        /cursors from an earlier answer of these suggestions, for the same task and search/,
      )
  })
})

describe("the mention popup's gate", () => {
  it('answers unavailable alike for a task the caller cannot write a text in, before any person', async () => {
    const b = await base()
    const { t, f } = b
    const archived = await b.task(f.sub, { archived_at: NOW })
    const foreign = await plantIssue(t, { org_id: f.otherOrg.id, project_id: f.otherProject.id })
    await b.keyed()
    // the names are keyed, so only the gate can hold these back
    for (const [caller, issue] of [
      [f.user, uuid()],
      [f.user, foreign.id],
      [f.user, archived.id],
      // the guest holds nothing on Skunkworks, and the admin nothing at all
      [f.guest, b.skunk.id],
      [f.admin, b.firmware.id],
    ] as const)
      expect(await mentions(t, caller, issue), issue).toEqual({ state: 'unavailable' })
  })

  it('refuses a caller below User with the write gate’s sentence, and answers a guest with User', async () => {
    const b = await base()
    const { t, f } = b
    await b.keyed()
    // the viewer's grant says User, and the organization role caps it
    expect(await mentions(t, f.viewer, b.firmware.id)).toEqual({
      state: 'refused',
      message: NO_WRITE_ACCESS,
    })
    expect(idsOf(ready(await mentions(t, f.guest, b.firmware.id)).rows)).toEqual(
      idsOf([f.user, f.guest, f.viewer]),
    )
  })

  it('refuses a login without a seat in the organization', async () => {
    const b = await base()
    const { t, f } = b
    await b.keyed()
    await expectRefusal(
      as(t, f.otherAdmin).query(api.pickers.mentions, {
        org_id: f.org.id,
        issue_id: b.firmware.id,
      }),
      'forbidden',
    )
  })
})

describe('readiness and the rule’s budget', () => {
  it('answers not_ready, with no row, until the names are keyed', async () => {
    const b = await base()
    expect(await mentions(b.t, b.f.user, b.firmware.id)).toEqual({ state: 'not_ready' })
  })

  it('answers over_budget, with no row, when the rule passes a lowered PICKERS.rule', async () => {
    const b = await base()
    await b.keyed()
    PICKERS.rule.ranges = 1
    PICKERS.rule.documents = 1
    expect(await mentions(b.t, b.f.user, b.firmware.id)).toEqual({ state: 'over_budget' })
  })
})
