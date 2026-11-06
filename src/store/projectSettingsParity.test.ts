/* The project settings stand-in (store/projectSettingsStandIn.setup.ts)
 * against the real queries (convex/projectSettings.ts) on convex-test, as
 * labelPagesParity.test.ts holds Settings › Labels' stand-in to its query.
 * Over Northstar as Nora, its admin, with a few planted people and teams
 * whose names' UTF-8 byte order differs from localeCompare, each granted or
 * sharing one project, it compares get, both lists from their start to
 * their end and with searches, the Add team or user picker of a project and
 * of a new project, the three lead pickers and the invite lookup, cursors
 * compared by where they lead, as the server seals its own. It holds get's
 * fields and rights to the server for a user, a guest and a Viewer in
 * every access shape (convex/tests/accessShapes.setup.ts), and the New
 * sub-project dialog's parent checks (get and the lead picker with a
 * parent) for a lead who is not an admin. It runs the pickers, the New
 * project and New sub-project dialogs' included, with the people figure at
 * the design size, 1,000 people, the New project dialog's with the teams
 * figure at its 50, and the users list with the grants on one project at
 * the organization's 995, each beside everyday values of the other
 * figures. */

import { makeFunctionReference } from 'convex/server'
import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { nameKey } from '../../convex/lib/nameKey'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { keyOrg } from '../../convex/tests/nameKeys.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import {
  type ProjectSettingsRead,
  projectSettingsStandIn,
  type SettingsWorkspace,
} from './projectSettingsStandIn.setup'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'project-settings-parity-secret-not-a-deployment-key'
})

/* Names whose name keys sort in a different order by UTF-8 bytes, which
   Convex orders strings by, than by localeCompare or UTF-16 code units. */
const PLANTED = ['Zoë Lind', 'Émile Roux', 'Øystein Berg', '😀 Bot Friend', '￮ Ring Holm']
const TEAMS = ['Østfold crew', 'Zulu team', 'Émile squad']

type Args = Record<string, unknown>
type Answer = { state: string; next?: string | null; rows?: { id: string }[] }

/** What both answer, with each cursor replaced by whether it is there. */
const shape = (a: unknown) => {
  const answer = a as Answer
  return 'next' in answer ? { ...answer, next: answer.next !== null } : answer
}

/** The query's answer and the stand-in's for read `name` with `args`, each
    following its own cursors through every batch when `all`, as `who`
    over the workspace `ws`. */
async function both(
  t: T,
  who: Doc<'profiles'>,
  ws: SettingsWorkspace,
  name: ProjectSettingsRead,
  args: Args,
  all = false,
): Promise<{ server: unknown[]; stand: unknown[] }> {
  const server: unknown[] = []
  const stand: unknown[] = []
  let at: { server?: string; stand?: string } = {}
  for (let round = 0; round < 100; round++) {
    const s = (await as(t, who).query(makeFunctionReference<'query'>(name), {
      ...args,
      ...(at.server === undefined ? {} : { after: at.server }),
    })) as Answer
    const o = projectSettingsStandIn(ws, name, {
      ...args,
      ...(at.stand === undefined ? {} : { after: at.stand }),
    }) as Answer
    server.push(s)
    stand.push(o)
    if (!all || !s.next || !o.next) return { server, stand }
    at = { server: s.next, stand: o.next }
  }
  throw new Error('the list did not end')
}

/** Expects the stand-in to answer read `name` with `args` as the server
    does, through every batch when `all`. Answers the server's batches. */
async function same(
  t: T,
  who: Doc<'profiles'>,
  ws: SettingsWorkspace,
  name: ProjectSettingsRead,
  args: Args,
  all = false,
) {
  const { server, stand } = await both(t, who, ws, name, args, all)
  expect(stand.map(shape), `${name} ${JSON.stringify(args)}`).toEqual(server.map(shape))
  return server as Answer[]
}

/** Northstar keyed, with the planted people granted User on its first
    top-level project Nora sees, and the planted teams sharing it. */
async function northstar() {
  const t = newT()
  const { org, profiles } = await plantNorthstar(t)
  const nora = profiles.find((p) => p.name === 'Nora Berg')
  if (!nora) throw new Error('no Nora')
  const before = await workspaceOf(as(t, nora))
  const project = before?.projects.find((p) => p.type === 'meta' && !p.parent_id && !p.archived_at)
  const sub = before?.projects.find((p) => p.parent_id === project?.id && !p.archived_at)
  if (!project || !sub) throw new Error('no project with a sub-project')
  await t.run(async (ctx) => {
    for (const [i, name] of PLANTED.entries()) {
      const id = uuid()
      await ctx.db.insert('profiles', {
        id,
        org_id: org.id,
        name,
        initials: 'PL',
        color: '#7a7ad0',
        email: `planted-${i}@example.se`,
        org_role: i === 2 ? 'viewer' : i === 3 ? 'user' : 'user',
        active: true,
        kind: i === 3 ? 'agent' : 'person',
        created_at: NOW,
      })
      if (i % 2 === 0)
        await ctx.db.insert('project_access', {
          project_id: project.id,
          profile_id: id,
          level: i === 2 ? 'viewer' : 'user',
        })
    }
    for (const name of TEAMS) {
      const id = uuid()
      await ctx.db.insert('teams', {
        id,
        org_id: org.id,
        name,
        track_delay_default: false,
        created_at: NOW,
      })
      if (name !== TEAMS[1])
        await ctx.db.insert('project_team_access', {
          project_id: project.id,
          team_id: id,
          level: 'viewer',
        })
    }
  })
  await keyOrg(t, org.id)
  const ws = await workspaceOf(as(t, nora))
  if (!ws) throw new Error('no workspace')
  return { t, org, nora, project, sub, ws, profiles }
}

describe('the project settings stand-in', () => {
  it('answers get, both lists, the pickers and the invite lookup over Northstar as the server does', async () => {
    const { t, org, nora, project, sub, ws } = await northstar()
    for (const id of [project.id, sub.id, 'no-such-project'])
      await same(t, nora, ws, 'projectSettings:get', { id })
    const base = { org_id: org.id, project_id: project.id }
    // both lists, every batch, in the server's order, which neither
    // localeCompare nor JavaScript's `<` gives
    const users = await same(t, nora, ws, 'projectSettings:users', base, true)
    const names = users.flatMap((b) => (b.rows ?? []) as unknown as { name: string }[])
    const planted = names.map((r) => r.name).filter((n) => PLANTED.includes(n))
    expect(planted.length).toBeGreaterThan(1)
    const lower = (name: string) => nameKey(name)
    expect(planted).not.toEqual([...planted].sort((a, b) => lower(a).localeCompare(lower(b))))
    await same(t, nora, ws, 'projectSettings:teams', base, true)
    for (const search of ['berg', 'EMILE', 'zoe lind', 'nothing here'])
      await same(t, nora, ws, 'projectSettings:users', { ...base, search })
    await same(t, nora, ws, 'projectSettings:teams', { ...base, search: 'crew' })
    // the pickers, every batch, with admins offered and what the project
    // holds left out
    await same(t, nora, ws, 'projectSettings:candidates', base, true)
    await same(t, nora, ws, 'projectSettings:candidates', { ...base, search: 'emile' })
    await same(t, nora, ws, 'projectSettings:candidates', { org_id: org.id }, true)
    await same(t, nora, ws, 'projectSettings:candidates', { org_id: org.id, lead_id: nora.id })
    await same(t, nora, ws, 'projectSettings:leadCandidates', base, true)
    await same(t, nora, ws, 'projectSettings:leadCandidates', {
      org_id: org.id,
      parent_id: project.id,
    })
    await same(t, nora, ws, 'projectSettings:leadCandidates', { org_id: org.id, search: 'berg' })
    // the invite lookup by any case, for a seat with a grant and an
    // address no seat holds
    for (const email of ['PLANTED-0@example.se', 'planted-1@example.se', 'nobody@example.se'])
      await same(t, nora, ws, 'projectSettings:inviteTarget', { ...base, email })
  })

  it("refuses another list's cursor and a search past its limit as the server does", async () => {
    // 30 grants, more than one batch of 25, so both answer a real cursor
    const { t, org, nora, project, ws } = await grown(40, 30)
    const base = { org_id: org.id, project_id: project.id }
    const first = await both(t, nora, ws, 'projectSettings:users', base)
    const cursor = (answer: unknown) => {
      const next = (answer as Answer).next
      if (typeof next !== 'string') throw new Error('no cursor to a second batch')
      return next
    }
    const after = { server: cursor(first.server[0]), stand: cursor(first.stand[0]) }
    const code = async (read: () => unknown) => {
      try {
        await read()
        return null
      } catch (error) {
        return (error as { data?: { code?: string } }).data?.code ?? 'error'
      }
    }
    const server = (name: ProjectSettingsRead, args: Args) =>
      code(() => as(t, nora).query(makeFunctionReference<'query'>(name), args))
    const stand = (name: ProjectSettingsRead, args: Args) =>
      code(() => projectSettingsStandIn(ws, name, args))
    // each cursor leads on in its own list and search
    expect(await server('projectSettings:users', { ...base, after: after.server })).toBeNull()
    expect(await stand('projectSettings:users', { ...base, after: after.stand })).toBeNull()
    // and is refused in the teams list, and under another search
    for (const [name, extra] of [
      ['projectSettings:teams', {}],
      ['projectSettings:users', { search: 'berg' }],
    ] as const) {
      expect(await server(name, { ...base, ...extra, after: after.server }), name).toBe(
        'bad_request',
      )
      expect(await stand(name, { ...base, ...extra, after: after.stand }), name).toBe('bad_request')
    }
    const long = 'x'.repeat(201)
    expect(await server('projectSettings:users', { ...base, search: long })).toBe('rule')
    expect(await stand('projectSettings:users', { ...base, search: long })).toBe('rule')
  })
})

/** One access case: `plant` for a fresh seat of `role`, its workspace,
    and get compared on every project of the fixture. */
async function compareShape(
  plant: (typeof SHAPES)[number][1],
  role: 'user' | 'guest' | 'viewer',
  label: string,
) {
  const t = newT()
  const f: OrgFixture = await withOrg(t)
  const subject = await plantSeat(t, {
    org_id: f.org.id,
    org_role: role,
    auth_user_id: `auth_${uuid()}`,
  })
  await t.run((ctx) => plant(ctx, f, subject))
  await keyOrg(t, f.org.id)
  const ws = await workspaceOf(as(t, subject))
  if (!ws) throw new Error('no workspace')
  const states: string[] = []
  for (const p of [f.meta, f.sub, f.sub2, f.hidden, f.otherProject]) {
    const server = await as(t, subject).query(api.projectSettings.get, { id: p.id })
    const stand = projectSettingsStandIn(ws, 'projectSettings:get', { id: p.id })
    expect(stand, `${label} on ${p.key}`).toEqual(server)
    states.push(server.state)
  }
  return states
}

describe('the rights in every access shape', () => {
  for (const role of ['user', 'guest', 'viewer'] as const)
    it(`answers get's fields and rights for a ${role} as the server does`, async () => {
      let shown = 0
      for (const [name, plant] of SHAPES) {
        const states = await compareShape(plant, role, `${role}, ${name}`)
        if (states.includes('ok')) shown++
      }
      // a guest takes no team shares, so fewer shapes show them anything
      expect(shown).toBeGreaterThan(SHAPES.length / 3)
    })
})

describe("the New sub-project dialog's parent checks", () => {
  it('answers get and the lead picker of a parent as the server does for a lead who is not an admin', async () => {
    const t = newT()
    const f: OrgFixture = await withOrg(t)
    // a project the user sees as User and does not lead
    const seen = await plantProject(t, { org_id: f.org.id, lead_id: f.admin.id })
    await t.run((ctx) =>
      ctx.db.insert('project_access', {
        project_id: seen.id,
        profile_id: f.user.id,
        level: 'user',
      }),
    )
    // Skunkworks, which the user leads, archived
    await t.run((ctx) => ctx.db.patch(f.hidden._id, { archived_at: NOW }))
    await keyOrg(t, f.org.id)
    const ws = await workspaceOf(as(t, f.user))
    if (!ws) throw new Error('no workspace')
    const answers: string[] = []
    for (const parent of [f.meta, seen, f.hidden, f.sub]) {
      await same(t, f.user, ws, 'projectSettings:get', { id: parent.id })
      const [server] = await same(t, f.user, ws, 'projectSettings:leadCandidates', {
        org_id: f.org.id,
        parent_id: parent.id,
      })
      const answer = server as Answer & { message?: string }
      answers.push(answer.message ?? answer.state)
    }
    expect(answers).toEqual([
      'ready',
      'requires lead access to this project',
      'the project is archived, so restore it first',
      'sub-projects live directly under a project, never under another sub-project',
    ])
  })
})

/** Northstar grown to `total` people with active users named in a spread
    of words, keyed, and its workspace as Nora. The first `grants` of them
    get User on Nora's first top-level project. */
async function grown(total: number, grants: number) {
  const t = newT()
  const { org, profiles } = await plantNorthstar(t)
  const count = total - profiles.length
  const nora = profiles.find((p) => p.name === 'Nora Berg')
  if (!nora) throw new Error('no Nora')
  const before = await workspaceOf(as(t, nora))
  const project = before?.projects.find((p) => p.type === 'meta' && !p.parent_id && !p.archived_at)
  if (!project) throw new Error('no project')
  const words = ['Alder', 'Birch', 'Cedar', 'Dahl', 'Elm', 'Fern', 'Grove', 'Holm']
  for (let from = 0; from < count; from += 500)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + 500); i++) {
        const id = uuid()
        const name = `${words[i % words.length]} ${words[(i * 7) % words.length]} ${i}`
        await ctx.db.insert('profiles', {
          id,
          org_id: org.id,
          name,
          name_key: nameKey(name),
          initials: 'GR',
          color: '#7a7ad0',
          org_role: 'user',
          active: true,
          kind: 'person',
          auth_user_id: `auth_${id}`,
          created_at: NOW,
        })
        if (i < grants)
          await ctx.db.insert('project_access', {
            project_id: project.id,
            profile_id: id,
            level: 'user',
            name_key: nameKey(name),
          })
      }
    })
  await keyOrg(t, org.id)
  const ws = await workspaceOf(as(t, nora))
  if (!ws) throw new Error('no workspace')
  return { t, org, nora, project, ws }
}

describe('at the design size', () => {
  it('offers the same choices among 1,000 people in the pickers', async () => {
    const { t, org, nora, project, ws } = await grown(1000, 0)
    expect(ws.profiles.filter((p) => p.org_id === org.id)).toHaveLength(1000)
    const base = { org_id: org.id, project_id: project.id }
    await same(t, nora, ws, 'projectSettings:candidates', base)
    await same(t, nora, ws, 'projectSettings:candidates', { ...base, search: 'holm 7' })
    await same(t, nora, ws, 'projectSettings:leadCandidates', base)
    await same(t, nora, ws, 'projectSettings:leadCandidates', { ...base, search: 'cedar' })
    // the New project and New sub-project dialogs' pickers among them
    const newProject = { org_id: org.id, lead_id: nora.id }
    await same(t, nora, ws, 'projectSettings:candidates', newProject)
    await same(t, nora, ws, 'projectSettings:candidates', { ...newProject, search: 'holm 7' })
    const newSub = { org_id: org.id, parent_id: project.id }
    await same(t, nora, ws, 'projectSettings:leadCandidates', newSub)
    await same(t, nora, ws, 'projectSettings:leadCandidates', { ...newSub, search: 'cedar' })
  })

  it('offers the New project dialog the same choices among 50 teams, every batch', async () => {
    const { t, org, nora, ws: before } = await northstar()
    const teams = before.teams.filter((team) => team.org_id === org.id).length
    await t.run(async (ctx) => {
      for (let i = teams; i < 50; i++)
        await ctx.db.insert('teams', {
          id: uuid(),
          org_id: org.id,
          name: `Crew ${String(i).padStart(2, '0')}`,
          track_delay_default: false,
          created_at: NOW,
        })
    })
    await keyOrg(t, org.id)
    const ws = await workspaceOf(as(t, nora))
    if (!ws) throw new Error('no workspace')
    expect(ws.teams.filter((team) => team.org_id === org.id)).toHaveLength(50)
    const batches = await same(
      t,
      nora,
      ws,
      'projectSettings:candidates',
      { org_id: org.id, lead_id: nora.id },
      true,
    )
    expect(batches.length).toBeGreaterThan(2)
    await same(t, nora, ws, 'projectSettings:candidates', {
      org_id: org.id,
      lead_id: nora.id,
      search: 'crew 4',
    })
  })

  it('lists the same users among 995 grants on one project', async () => {
    const { t, org, nora, project, ws } = await grown(1000, 995)
    const base = { org_id: org.id, project_id: project.id }
    const first = await same(t, nora, ws, 'projectSettings:users', base)
    expect(first[0]?.rows).toHaveLength(25)
    await same(t, nora, ws, 'projectSettings:users', { ...base, search: 'birch elm' })
  })
})
