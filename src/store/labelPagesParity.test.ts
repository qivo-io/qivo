/* Settings › Labels' stand-in (store/labelPagesStandIn.setup.ts) against
 * the real query (convex/labels.ts settingsPage) on convex-test, as
 * overviewParity.test.ts holds the Overview's stand-in to its queries. Over
 * Northstar's labels as Nora, its admin, with a few planted names whose
 * UTF-8 byte order differs from localeCompare and from JavaScript's `<`
 * (convex/lib/namedPages.ts), each on a live task, it compares the first
 * batch, the batch after it, searches, a batch kept live between two
 * cursors as a label lands inside it, `exact` and the counts, and the
 * refusal of a seat that is not an admin. Cursors are compared by where
 * they lead, as the server seals its own. Every labelled task is in a live
 * project, since the stand-in counts the workspace's tasks. */

import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import {
  as,
  NOW,
  newT,
  plantSeat,
  type T,
  uuid,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import {
  type LabelPageAnswer,
  type LabelPageArgs,
  type LabelPickerAnswer,
  labelPickerStandIn,
  labelSettingsStandIn,
  labelsByIdsStandIn,
} from './labelPagesStandIn.setup'

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= 'label-pages-parity-secret-not-a-deployment-key'
})

/* Names whose name_lower sorts in a different order by UTF-8 bytes, which
   Convex orders strings by, than by localeCompare or UTF-16 code units. */
const PLANTED = ['Zulu check', 'Émile review', 'Øresund test', '😀 Launch', '￮ Ring']
/* Ordinary names, so the list holds more than one batch. */
const MORE = ['Bench rig', 'Cable harness', 'Enclosure fit', 'Field test 07', 'Gasket supply']

type Fixture = { t: T; org: Doc<'organizations'>; nora: Doc<'profiles'>; leo: Doc<'profiles'> }

/** Northstar with the planted labels, each made by Nora and put on a live
    task, the first of them on three. */
async function northstar(): Promise<Fixture> {
  const t = newT()
  const { org, profiles } = await plantNorthstar(t)
  const person = (name: string) => {
    const p = profiles.find((profile) => profile.name === name)
    if (!p) throw new Error(`no ${name}`)
    return p
  }
  const nora = person('Nora Berg')
  const leo = person('Leo Martins')
  const ws = await workspaceOf(as(t, nora))
  if (!ws) throw new Error('no workspace')
  const live = new Set(ws.projects.filter((p) => !p.archived_at).map((p) => p.id))
  const tasks = ws.issues.filter((i) => i.org_id === org.id && live.has(i.project_id))
  let n = 0
  for (const name of [...PLANTED, ...MORE]) {
    const id = uuid()
    await as(t, nora).mutation(api.labels.create, { org_id: org.id, id, name, color: '#4C9AFF' })
    const on = name === PLANTED[0] ? 3 : n % 3
    for (let k = 0; k < on; k++) {
      const task = tasks[(n * 3 + k) % tasks.length]
      if (task)
        await as(t, nora).mutation(api.labels.toggle, {
          org_id: org.id,
          issue_id: task.id,
          label_id: id,
          on: true,
        })
    }
    n++
  }
  return { t, org, nora, leo }
}

/** The refusal code `read` throws with, or null when it answers. */
function refusal(read: () => unknown): string | null {
  try {
    read()
    return null
  } catch (error) {
    return (error as { data?: { code?: string } }).data?.code ?? 'error'
  }
}

/** What both answer, with each cursor replaced by whether it is there. */
const shape = (a: LabelPageAnswer | LabelPickerAnswer) => ({ ...a, next: a.next !== null })

/** The query's answer and the stand-in's for the same arguments, each
    following its own cursors (`at`, from earlier answers of each). */
async function both(
  f: Fixture,
  args: Omit<LabelPageArgs, 'org_id'> = {},
  at: { server?: Partial<LabelPageArgs>; stand?: Partial<LabelPageArgs> } = {},
) {
  const ws = await workspaceOf(as(f.t, f.nora))
  if (!ws) throw new Error('no workspace')
  const server = await as(f.t, f.nora).query(api.labels.settingsPage, {
    org_id: f.org.id,
    ...args,
    ...at.server,
  })
  const stand = labelSettingsStandIn(ws, { org_id: f.org.id, ...args, ...at.stand })
  return { server, stand }
}

describe("the label pages' stand-in", () => {
  it('answers the batches, searches, a batch kept live, exact and the counts as labels.settingsPage does', async () => {
    const f = await northstar()
    const first = await both(f)
    expect(first.server.rows.length).toBe(25)
    expect(shape(first.stand)).toEqual(shape(first.server))
    expect(first.server.rows.some((row) => (row.active_tasks ?? 0) > 0)).toBe(true)
    // the planted names in the server's order, which neither localeCompare
    // nor JavaScript's `<` gives, so a stand-in sorted either way fails
    const planted = (a: LabelPageAnswer) =>
      a.rows.map((row) => row.name).filter((name) => PLANTED.includes(name))
    const all = first
    const rest = await both(
      f,
      {},
      { server: { after: first.server.next ?? '' }, stand: { after: first.stand.next ?? '' } },
    )
    expect(shape(rest.stand)).toEqual(shape(rest.server))
    expect(rest.server.next).toBeNull()
    const order = [...planted(all.server), ...planted(rest.server)]
    expect([...planted(all.stand), ...planted(rest.stand)]).toEqual(order)
    const lower = (name: string) => name.toLowerCase()
    expect(order).not.toEqual([...order].sort((a, b) => lower(a).localeCompare(lower(b))))
    expect(order).not.toEqual([...order].sort((a, b) => (lower(a) < lower(b) ? -1 : 1)))
    // searches, by any word in any case and without accents, and none
    for (const search of ['test', 'emile', 'LAUNCH', 'check zulu', 'nothing here']) {
      const found = await both(f, { search })
      expect(shape(found.stand), search).toEqual(shape(found.server))
    }
    // exact, in any case, wherever it falls
    const exact = await both(f, { search: 'ZULU CHECK' })
    expect(exact.server.exact).toMatchObject({ name: 'Zulu check', active_tasks: 3 })
    expect(exact.stand.exact).toEqual(exact.server.exact)
    // a batch kept live up to the first batch's end takes a label made
    // inside it, and the batch after it keeps its start
    await as(f.t, f.nora).mutation(api.labels.create, {
      org_id: f.org.id,
      id: uuid(),
      name: 'Aaa first',
      color: '#4C9AFF',
    })
    const pinned = await both(
      f,
      {},
      { server: { through: first.server.next ?? '' }, stand: { through: first.stand.next ?? '' } },
    )
    expect(pinned.server.rows).toHaveLength(26)
    expect(shape(pinned.stand)).toEqual(shape(pinned.server))
    // its end answers its own cursor, as the page compares them
    expect(pinned.server.next).toBe(first.server.next)
    expect(pinned.stand.next).toBe(first.stand.next)
  })

  it('refuses a seat that is not an admin, and a cursor of another search, as the server does', async () => {
    const f = await northstar()
    const ws = await workspaceOf(as(f.t, f.leo))
    if (!ws) throw new Error('no workspace')
    await expect(
      as(f.t, f.leo).query(api.labels.settingsPage, { org_id: f.org.id }),
    ).rejects.toMatchObject({ data: { code: 'forbidden' } })
    expect(refusal(() => labelSettingsStandIn(ws, { org_id: f.org.id }))).toBe('forbidden')
    const first = await both(f)
    const nora = await workspaceOf(as(f.t, f.nora))
    if (!nora) throw new Error('no workspace')
    await expect(
      as(f.t, f.nora).query(api.labels.settingsPage, {
        org_id: f.org.id,
        search: 'test',
        after: first.server.next ?? '',
      }),
    ).rejects.toMatchObject({ data: { code: 'bad_request' } })
    expect(
      refusal(() =>
        labelSettingsStandIn(nora, {
          org_id: f.org.id,
          search: 'test',
          after: first.stand.next ?? '',
        }),
      ),
    ).toBe('bad_request')
  })
})

describe("the label picker's and byIds' stand-ins", () => {
  it('answers the batches, searches, exact and can_create as labels.picker does, for an admin and a guest', async () => {
    const f = await northstar()
    const guest = await plantSeat(f.t, {
      org_id: f.org.id,
      name: 'Gus Guest',
      org_role: 'guest',
      auth_user_id: uuid(),
      accepted_at: NOW,
    })
    for (const who of [f.nora, guest]) {
      const ws = await workspaceOf(as(f.t, who))
      if (!ws) throw new Error('no workspace')
      const read = async (args: Omit<LabelPageArgs, 'org_id'>, stand = args) => ({
        server: await as(f.t, who).query(api.labels.picker, { org_id: f.org.id, ...args }),
        stand: labelPickerStandIn(ws, { org_id: f.org.id, ...stand }),
      })
      const first = await read({})
      expect(first.server.can_create).toBe(who === f.nora)
      expect(shape(first.stand), who.name).toEqual(shape(first.server))
      // a later batch leaves can_create out
      const rest = await read({ after: first.server.next ?? '' }, { after: first.stand.next ?? '' })
      expect(rest.server).not.toHaveProperty('can_create')
      expect(shape(rest.stand)).toEqual(shape(rest.server))
      for (const search of ['test', 'emile', 'ZULU CHECK', 'nothing here']) {
        const found = await read({ search })
        expect(shape(found.stand), search).toEqual(shape(found.server))
      }
      // a picker cursor is not one of Settings', nor the other way
      if (who === f.nora)
        await expect(
          as(f.t, who).query(api.labels.settingsPage, {
            org_id: f.org.id,
            after: first.server.next ?? '',
          }),
        ).rejects.toMatchObject({ data: { code: 'bad_request' } })
      expect(
        refusal(() =>
          labelSettingsStandIn(ws, { org_id: f.org.id, after: first.stand.next ?? '' }),
        ),
      ).toBe(who === f.nora ? 'bad_request' : 'forbidden')
    }
  })

  it('answers labels by id as labels.byIds does, each once in the order asked', async () => {
    const f = await northstar()
    const ws = await workspaceOf(as(f.t, f.nora))
    if (!ws) throw new Error('no workspace')
    const [a, b, c] = ws.labels.filter((l) => l.org_id === f.org.id)
    const ids = [c.id, 'unknown-id', a.id, c.id, b.id]
    const server = await as(f.t, f.nora).query(api.labels.byIds, { org_id: f.org.id, ids })
    expect(server.rows.map((r) => r.id)).toEqual([c.id, a.id, b.id])
    expect(labelsByIdsStandIn(ws, { org_id: f.org.id, ids })).toEqual(server)
    const many = Array.from({ length: 101 }, () => a.id)
    await expect(
      as(f.t, f.nora).query(api.labels.byIds, { org_id: f.org.id, ids: many }),
    ).rejects.toMatchObject({ data: { code: 'bad_request' } })
    expect(refusal(() => labelsByIdsStandIn(ws, { org_id: f.org.id, ids: many }))).toBe(
      'bad_request',
    )
  })
})
