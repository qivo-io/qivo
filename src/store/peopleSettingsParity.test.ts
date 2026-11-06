/* The Users page's stand-in (store/peopleSettingsStandIn.setup.ts) against
 * the real queries (convex/people.ts settingsPage, get and byIds,
 * convex/tokens.ts agentKeys and convex/orgs.ts projectCreators) on
 * convex-test, as teamSettingsParity.test.ts holds the team pages' stand-in
 * to theirs. Over Northstar, with planted people whose names' UTF-8 byte
 * order differs from localeCompare, it compares every page from its start
 * to its end and with searches, cursors compared by where they lead, as
 * the server seals its own, with one figure at its design size a case:
 * 1,000 people for the list, one person and 100 by id; a guest who reads
 * 200 live sub-projects in an everyday organization; 25 agents with
 * everyday keys; the invitation rows of the seats a page names; and the
 * creators under each setting among 1,000 people. It also compares the
 * refusals. */

import { makeFunctionReference } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import type { InviteDeliveryRow } from '../../convex/invites'
import { newWindowKey } from '../../convex/lib/db'
import { nameKey } from '../../convex/lib/nameKey'
import { newOrgDefaults } from '../../convex/model/orgs'
import {
  as,
  NOW,
  newT,
  plantLogin,
  type T,
  uuid,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { keyOrg } from '../../convex/tests/nameKeys.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import {
  type PeopleSettingsExtra,
  type PeopleSettingsRead,
  type PeopleSettingsWorkspace,
  peopleSettingsStandIn,
  type StandInKey,
} from './peopleSettingsStandIn.setup'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'people-settings-parity-secret-not-a-deployment-key'
})

/* Names whose name keys sort in a different order by UTF-8 bytes, which
   Convex orders strings by, than by localeCompare or UTF-16 code units. */
const PLANTED = ['Zoë Lind', 'Émile Roux', 'Øystein Berg', '😀 Bot Friend', '￮ Ring Holm']

type Args = Record<string, unknown>
type Answer = { state?: string; next?: string | null; rows?: { id: string; name: string }[] }

/** What both answer, with each cursor replaced by whether it is there. */
const shape = (a: unknown) => {
  const answer = a as Answer
  return answer && typeof answer === 'object' && 'next' in answer
    ? { ...answer, next: answer.next !== null }
    : answer
}

/** The query's answer and the stand-in's for read `name` with `args`, each
    following its own cursors through every page when `all`, as `who` over
    the workspace `ws`. */
async function both(
  t: T,
  who: Doc<'profiles'>,
  ws: PeopleSettingsWorkspace,
  name: PeopleSettingsRead,
  args: Args,
  all = false,
  extra: PeopleSettingsExtra = {},
): Promise<{ server: Answer[]; stand: Answer[] }> {
  const server: Answer[] = []
  const stand: Answer[] = []
  let at: { server?: string; stand?: string } = {}
  for (let round = 0; round < 100; round++) {
    const s = (await as(t, who).query(makeFunctionReference<'query'>(name), {
      ...args,
      ...(at.server === undefined ? {} : { after: at.server }),
    })) as Answer
    const o = peopleSettingsStandIn(
      ws,
      name,
      { ...args, ...(at.stand === undefined ? {} : { after: at.stand }) },
      {},
      extra,
    ) as Answer
    server.push(s)
    stand.push(o)
    if (!all || !s.next || !o.next) return { server, stand }
    at = { server: s.next, stand: o.next }
  }
  throw new Error('the list did not end')
}

/** Expects the stand-in to answer read `name` with `args` as the server
    does, through every page when `all`. Answers both walks. */
async function same(
  t: T,
  who: Doc<'profiles'>,
  ws: PeopleSettingsWorkspace,
  name: PeopleSettingsRead,
  args: Args,
  all = false,
  extra: PeopleSettingsExtra = {},
) {
  const walked = await both(t, who, ws, name, args, all, extra)
  expect(walked.stand.map(shape), `${name} ${JSON.stringify(args)}`).toEqual(
    walked.server.map(shape),
  )
  return walked
}

/** Northstar with the planted people, a guest, and more people up to
    `people`, keyed, with Nora, its admin, and her workspace. */
async function northstar(o: { people?: number } = {}) {
  const t = newT()
  const { org, profiles } = await plantNorthstar(t)
  const nora = profiles.find((p) => p.name === 'Nora Berg')
  if (!nora) throw new Error('no Nora')
  const planted = await t.run(async (ctx) => {
    const people: Doc<'profiles'>[] = []
    const extra = Math.max(0, (o.people ?? 0) - profiles.length - PLANTED.length - 1)
    const names = [
      ...PLANTED,
      ...Array.from({ length: extra }, (_, i) => `Person ${String(i).padStart(4, '0')} Example`),
    ]
    for (const [i, name] of names.entries()) {
      const _id = await ctx.db.insert('profiles', {
        id: uuid(),
        org_id: org.id,
        name,
        initials: 'PL',
        color: '#7a7ad0',
        org_role: i === 2 ? 'viewer' : 'user',
        active: i !== 1,
        kind: i === 3 ? 'agent' : 'person',
        ...(i === 3 ? {} : { email: `p${i}@example.test` }),
        ...(i === 4 || i === 3 ? {} : { auth_user_id: `auth_planted_${i}` }),
        plannable_hours: i === 0 ? 32 : undefined,
        can_create_projects: i === 0 ? true : undefined,
        created_at: NOW,
      })
      people.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    const guestId = await ctx.db.insert('profiles', {
      id: uuid(),
      org_id: org.id,
      name: 'Gus Guest',
      email: 'gus@example.test',
      initials: 'GG',
      color: '#7a7ad0',
      org_role: 'guest',
      active: true,
      kind: 'person',
      auth_user_id: 'auth_planted_guest',
      created_at: NOW,
    })
    const guest = (await ctx.db.get(guestId)) as Doc<'profiles'>
    return { people, guest }
  })
  await keyOrg(t, org.id)
  const ws = await workspaceOf(as(t, nora))
  if (!ws) throw new Error('no workspace')
  return { t, org, nora, profiles, ...planted, ws }
}

/** The rows of every page in `walk`, in order. */
const rowsOf = (walk: Answer[]) => walk.flatMap((b) => b.rows ?? [])

describe("the Users page's stand-in", () => {
  it('answers the list among 1,000 people, page by page and searched, as the server does', async () => {
    const { t, org, nora, ws, guest } = await northstar({ people: 1000 })
    const base = { org_id: org.id }
    const list = await same(t, nora, ws, 'people:settingsPage', base, true)
    const rows = rowsOf(list.server)
    expect(rows).toHaveLength(1000)
    expect(list.server).toHaveLength(40)
    // the guest comes last, after every person and agent
    expect(rows.at(-1)?.id).toBe(guest.id)
    // the server's order, which neither localeCompare nor `<` gives
    const planted = rows.map((r) => r.name).filter((n) => PLANTED.includes(n))
    expect(planted).not.toEqual([...planted].sort((a, b) => nameKey(a).localeCompare(nameKey(b))))
    for (const search of ['emile', 'ZOË', 'person 0999', 'example.test p0', 'gus@', 'nobody here'])
      await same(t, nora, ws, 'people:settingsPage', { ...base, search }, true)
    for (const id of [guest.id, rows[600].id, 'no-such-person'])
      await same(t, nora, ws, 'people:get', { ...base, id })
    await same(t, nora, ws, 'people:byIds', {
      ...base,
      ids: rows.slice(100, 200).map((r) => r.id),
    })
  }, 60_000)

  it('answers a guest who reads 200 live sub-projects in an everyday organization as the server does', async () => {
    const { t, org, nora, guest } = await northstar()
    await t.run(async (ctx) => {
      // three sub-projects a project, the everyday value, under 67 new
      // projects, so the organization stays within 200 live projects and
      // 500 live sub-projects
      const parents: string[] = []
      for (let i = 0; i < 200; i++) {
        if (i % 3 === 0) {
          const parent = uuid()
          await ctx.db.insert('projects', {
            id: parent,
            org_id: org.id,
            type: 'meta',
            key: `M${i / 3}`,
            name: `Project ${String(i / 3).padStart(2, '0')}`,
            description: '',
            sort_order: 500 + i,
            num: 500 + i,
            track_delay: false,
            created_at: NOW,
            window_key: newWindowKey(),
          })
          parents.push(parent)
        }
        const id = uuid()
        await ctx.db.insert('projects', {
          id,
          org_id: org.id,
          type: 'project',
          parent_id: parents[parents.length - 1],
          key: `S${i}`,
          name: `Sub-project ${String(i).padStart(3, '0')}`,
          description: '',
          sort_order: 1000 + i,
          num: 1000 + i,
          track_delay: false,
          created_at: new Date(Date.parse(NOW) + i * 1000).toISOString(),
          window_key: newWindowKey(),
        })
        await ctx.db.insert('project_access', {
          project_id: id,
          profile_id: guest.id,
          level: 'viewer',
        })
      }
    })
    await keyOrg(t, org.id)
    const ws = await workspaceOf(as(t, nora))
    if (!ws) throw new Error('no workspace')
    const walk = await same(t, nora, ws, 'people:settingsPage', { org_id: org.id }, true)
    const row = rowsOf(walk.server).find((r) => r.id === guest.id) as unknown as {
      guest: { projects: unknown[]; more: boolean }
    }
    expect(row.guest.projects).toHaveLength(10)
    expect(row.guest.more).toBe(true)
  })

  it("answers 25 agents' everyday keys as the server does", async () => {
    const { t, org, nora } = await northstar()
    const agents = await t.run(async (ctx) => {
      const out: Doc<'profiles'>[] = []
      for (let i = 0; i < 25; i++) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: org.id,
          name: `Agent ${String(i).padStart(2, '0')}`,
          initials: 'AG',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'agent',
          created_at: NOW,
        })
        const agent = (await ctx.db.get(_id)) as Doc<'profiles'>
        for (const [n, revoked] of [
          [1, true],
          [2, false],
          [3, false],
        ] as const)
          await ctx.db.insert('agent_keys', {
            id: uuid(),
            profile_id: agent.id,
            org_id: org.id,
            name: `Key ${n}`,
            key_prefix: `qva_00${n}...abcd${n}`,
            key_hash: uuid().replace(/-/g, '').padEnd(64, '0'),
            created_at: `2026-10-0${n}T08:00:00.000Z`,
            ...(revoked ? { revoked_at: NOW } : {}),
          })
        out.push(agent)
      }
      return out
    })
    await keyOrg(t, org.id)
    const ws = await workspaceOf(as(t, nora))
    if (!ws) throw new Error('no workspace')
    const keys: StandInKey[] = await t.run(async (ctx) =>
      (await ctx.db.query('agent_keys').collect()).map((k) => ({
        id: k.id,
        agentId: k.profile_id,
        name: k.name,
        prefix: k.key_prefix,
        createdAt: k.created_at,
        lastUsedAt: k.last_used_at ?? null,
        revokedAt: k.revoked_at ?? null,
      })),
    )
    const ids = agents.map((a) => a.id)
    const walk = await same(
      t,
      nora,
      ws,
      'tokens:agentKeys',
      { org_id: org.id, agent_ids: ids },
      false,
      {
        keys,
      },
    )
    expect((walk.server[0] as unknown as { agents: unknown[] }).agents).toHaveLength(25)
    // a person's id, the Northstar agent and an unknown id
    const atlas = ws.profiles.find((p) => p.name === 'Atlas')
    await same(
      t,
      nora,
      ws,
      'tokens:agentKeys',
      { org_id: org.id, agent_ids: [nora.id, atlas?.id ?? '', 'no-such-agent'] },
      false,
      { keys },
    )
  })

  it('answers the invitation rows of the seats a page names as the server does', async () => {
    const { t, org, nora, people } = await northstar()
    // a pending seat (no login, an address), a seat claimed after its
    // send, and a pending seat of another organization, each with one
    // failed send Nora's change caused
    const invited = people[4]
    const sentAt = new Date(Date.now() - 60_000).toISOString()
    const [claimed, foreign] = await t.run(async (ctx) => {
      const elsewhere = uuid()
      await ctx.db.insert('organizations', {
        id: elsewhere,
        name: 'Elsewhere',
        slug: 'elsewhere',
        ...newOrgDefaults(NOW),
      })
      const out: Doc<'profiles'>[] = []
      for (const [orgId, name, email] of [
        [org.id, 'Cleo Claimed', 'cleo@example.test'],
        [elsewhere, 'Far Away', 'far@example.test'],
      ] as const) {
        const _id = await ctx.db.insert('profiles', {
          id: uuid(),
          org_id: orgId,
          name,
          email,
          initials: 'PL',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          created_at: NOW,
        })
        out.push((await ctx.db.get(_id)) as Doc<'profiles'>)
      }
      for (const seat of [invited, ...out])
        await ctx.db.insert('platform_audit_log', {
          ts: sentAt,
          actor_email: 'system',
          action: 'invite_email',
          channel: 'app',
          target_org_id: seat.org_id,
          target_profile_id: seat.id,
          detail: { email: seat.email, sent: false, settled: true, resend: false, by: nora.id },
        })
      return out
    })
    await keyOrg(t, org.id)
    const ref = makeFunctionReference<'query'>('invites:deliveries')
    // the rows the server reported while Cleo was pending, and Far Away's,
    // as the stand-in is given them
    const before = (await as(t, nora).query(ref, { org_id: org.id })) as InviteDeliveryRow[]
    expect(before.map((r) => r.profile_id).sort()).toEqual([invited.id, claimed.id].sort())
    const extra = {
      deliveries: [
        ...before,
        {
          profile_id: foreign.id,
          email: 'far@example.test',
          state: 'unsent' as const,
          since: sentAt,
          free_at: null,
        },
      ],
    }
    await t.run((ctx) => ctx.db.patch(claimed._id, { auth_user_id: 'auth_cleo' }))
    const ws = await workspaceOf(as(t, nora))
    if (!ws) throw new Error('no workspace')
    const named = [invited.id, claimed.id, foreign.id, 'no-such-seat']
    const walk = await same(
      t,
      nora,
      ws,
      'invites:deliveries',
      { org_id: org.id, profile_ids: named },
      false,
      extra,
    )
    expect((walk.server[0] as unknown as InviteDeliveryRow[]).map((r) => r.profile_id)).toEqual([
      invited.id,
    ])
    // an empty list names no seat, and walks none
    await same(t, nora, ws, 'invites:deliveries', { org_id: org.id, profile_ids: [] }, false, extra)
    // a standard user sees only the sends their own change caused
    const zoe = await plantLogin(t, people[0])
    const theirs = await workspaceOf(as(t, zoe))
    if (!theirs) throw new Error('no workspace')
    await same(
      t,
      zoe,
      theirs,
      'invites:deliveries',
      { org_id: org.id, profile_ids: named },
      false,
      extra,
    )
  })

  it('answers the creators line under each setting among 1,000 people as the server does', async () => {
    const { t, org, nora, people } = await northstar({ people: 1000 })
    for (const setting of ['users', 'selected', 'admins'] as const) {
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query('organizations')
          .withIndex('by_uuid', (q) => q.eq('id', org.id))
          .unique()
        if (row) await ctx.db.patch(row._id, { project_creators: setting })
      })
      const ws = await workspaceOf(as(t, nora))
      if (!ws) throw new Error('no workspace')
      const walk = await same(t, nora, ws, 'orgs:projectCreators', { org_id: org.id })
      expect(walk.server[0]).toMatchObject({ state: 'ok', setting })
    }
    expect(people[0].can_create_projects).toBe(true)
  }, 60_000)

  it('refuses as the server does', async () => {
    const { t, org, nora, people, ws } = await northstar()
    const code = async (read: () => unknown) => {
      try {
        await read()
        return null
      } catch (error) {
        return (error as { data?: { code?: string } }).data?.code ?? 'error'
      }
    }
    const zoe = await plantLogin(t, people[0])
    const theirs = await workspaceOf(as(t, zoe))
    if (!theirs) throw new Error('no workspace')
    const base = { org_id: org.id }
    for (const [name, args] of [
      ['people:settingsPage', base],
      ['people:get', { ...base, id: nora.id }],
      ['tokens:agentKeys', { ...base, agent_ids: [nora.id] }],
      ['orgs:projectCreators', base],
    ] as const) {
      expect(
        await code(() => as(t, zoe).query(makeFunctionReference<'query'>(name), args)),
        name,
      ).toBe('forbidden')
      expect(await code(() => peopleSettingsStandIn(theirs, name, args)), name).toBe('forbidden')
    }
    // a standard user reads people by id
    await same(t, zoe, theirs, 'people:byIds', { ...base, ids: [nora.id] })
    // a cursor of the list without a search, sent with one
    const many = await northstar({ people: 40 })
    const mine = { org_id: many.org.id }
    const first = await both(many.t, many.nora, many.ws, 'people:settingsPage', mine)
    const after = { server: first.server[0].next ?? '', stand: first.stand[0].next ?? '' }
    expect(after.server).not.toBe('')
    expect(
      await code(() =>
        as(many.t, many.nora).query(makeFunctionReference<'query'>('people:settingsPage'), {
          ...mine,
          search: 'e',
          after: after.server,
        }),
      ),
    ).toBe('bad_request')
    expect(
      await code(() =>
        peopleSettingsStandIn(many.ws, 'people:settingsPage', {
          ...mine,
          search: 'e',
          after: after.stand,
        }),
      ),
    ).toBe('bad_request')
    const long = 'x'.repeat(201)
    expect(
      await code(() =>
        as(t, nora).query(makeFunctionReference<'query'>('people:settingsPage'), {
          ...base,
          search: long,
        }),
      ),
    ).toBe('rule')
    expect(
      await code(() => peopleSettingsStandIn(ws, 'people:settingsPage', { ...base, search: long })),
    ).toBe('rule')
    // past the bounds on ids, and agentKeys with none
    const many101 = Array.from({ length: 101 }, () => nora.id)
    for (const [name, said, args] of [
      ['people:byIds', '101 ids', { ...base, ids: many101 }],
      ['invites:deliveries', '101 ids', { ...base, profile_ids: many101 }],
      ['tokens:agentKeys', 'no ids', { ...base, agent_ids: [] }],
      ['tokens:agentKeys', '26 ids', { ...base, agent_ids: many101.slice(0, 26) }],
    ] as const) {
      expect(
        await code(() => as(t, nora).query(makeFunctionReference<'query'>(name), args)),
        `${name}, ${said}`,
      ).toBe('bad_request')
      expect(await code(() => peopleSettingsStandIn(ws, name, args)), `${name}, ${said}`).toBe(
        'bad_request',
      )
    }
  })
})
