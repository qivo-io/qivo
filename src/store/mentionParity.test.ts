/* The mention stand-in (store/mentionStandIn.setup.ts) against the real
 * query (convex/pickers.ts mentions) on convex-test, as
 * labelPagesParity.test.ts holds the label stand-ins to theirs. Over
 * Northstar's people as Nora, with planted names whose UTF-8 byte order
 * differs from localeCompare and an agent without an email, it compares
 * every batch from the start to the end for a list of searches, a batch
 * kept between two cursors, and the refusals. Cursors are compared by
 * where they lead, as the server seals its own. */

import { describe, expect, it, vi } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import type { MentionBatch } from '../../convex/model/pickers'
import { as, NOW, newT, plantSeat, type T, workspaceOf } from '../../convex/tests/helpers.setup'
import { keyOrg } from '../../convex/tests/nameKeys.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import { type MentionArgs, mentionStandIn } from './mentionStandIn.setup'

vi.hoisted(() => {
  // cursors are sealed with a key derived from it (lib/archiveCursorSeal.ts)
  process.env.BETTER_AUTH_SECRET ??= 'mention-parity-secret-not-a-deployment-key'
})

/* Names whose name key sorts in a different order by UTF-8 bytes, which
   Convex orders strings by, than by localeCompare or UTF-16 code units. */
const PLANTED = ['Zulu Andersen', 'Émile Roux', 'Øystein Berg', '😀 Lab Bot', '￮ Ring Ops']
/* Ordinary names, so the list holds three batches. */
const MORE = ['Ada Lindqvist', 'Bo Nyström', 'Cleo Park', 'Dag Holm', 'Eva Sund', 'Fia Ek']

type Fixture = { t: T; org: Doc<'organizations'>; nora: Doc<'profiles'> }

/** Northstar with the planted people, keyed, and an agent without an
    email. */
async function northstar(): Promise<Fixture> {
  const t = newT()
  const { org, profiles } = await plantNorthstar(t)
  const nora = profiles.find((p) => p.name === 'Nora Berg')
  if (!nora) throw new Error('no Nora')
  for (const name of [...PLANTED, ...MORE])
    await plantSeat(t, {
      org_id: org.id,
      name,
      initials: name.slice(0, 2).toUpperCase(),
      email: `${name.length}.${name.charCodeAt(0)}@northstar.test`,
      accepted_at: NOW,
    })
  await plantSeat(t, { org_id: org.id, name: 'Relay Agent', initials: 'RA', kind: 'agent' })
  await keyOrg(t, org.id)
  return { t, org, nora }
}

/** What both answer, with each cursor replaced by whether it is there. */
const shape = (a: MentionBatch) => (a.state === 'ready' ? { ...a, next: a.next !== null } : a)

/** Every batch of the query and of the stand-in for `search`, each
    following its own cursors, from the start to the end. */
async function both(f: Fixture, search: string) {
  const ws = await workspaceOf(as(f.t, f.nora))
  if (!ws) throw new Error('no workspace')
  const server: MentionBatch[] = []
  const stand: MentionBatch[] = []
  let at: { server?: string; stand?: string } = {}
  for (let round = 0; round < 50; round++) {
    const args: MentionArgs = { org_id: f.org.id, ...(search ? { search } : {}) }
    const s = await as(f.t, f.nora).query(api.pickers.mentions, {
      ...args,
      ...(at.server ? { after: at.server } : {}),
    })
    const d = mentionStandIn(ws, { ...args, ...(at.stand ? { after: at.stand } : {}) })
    server.push(s)
    stand.push(d)
    if (s.state !== 'ready' || d.state !== 'ready' || s.next === null || d.next === null) break
    at = { server: s.next, stand: d.next }
  }
  return { server, stand }
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

describe("the mention suggestions' stand-in", () => {
  it('answers every batch of every search as pickers.mentions does', async () => {
    const f = await northstar()
    const all = await both(f, '')
    expect(all.server.length).toBeGreaterThan(2)
    expect(all.stand.map(shape)).toEqual(all.server.map(shape))
    // the planted names in the server's order, which localeCompare does
    // not give, so a stand-in sorted that way fails
    const planted = all.server
      .flatMap((b) => (b.state === 'ready' ? b.rows : []))
      .map((row) => row.name)
      .filter((name) => PLANTED.includes(name))
    expect(planted).toHaveLength(PLANTED.length)
    expect(planted).not.toEqual([...planted].sort((a, b) => a.localeCompare(b)))
    // a batch kept between the start and the second batch's end
    const [one, two] = all.server
    const [standOne, standTwo] = all.stand
    if (one?.state !== 'ready' || two?.state !== 'ready') throw new Error('not ready')
    if (standOne?.state !== 'ready' || standTwo?.state !== 'ready') throw new Error('not ready')
    const ws = await workspaceOf(as(f.t, f.nora))
    if (!ws) throw new Error('no workspace')
    const kept = await as(f.t, f.nora).query(api.pickers.mentions, {
      org_id: f.org.id,
      through: two.next ?? '',
    })
    const standKept = mentionStandIn(ws, { org_id: f.org.id, through: standTwo.next ?? '' })
    expect(shape(standKept)).toEqual(shape(kept))
    expect(kept.state === 'ready' && kept.rows).toEqual([...one.rows, ...two.rows])
    // names, initials, email words, case, accents kept, no match
    for (const search of ['berg', 'NB', 'northstar.test', 'émile', 'emile', 'agent ra', 'nobody'])
      expect((await both(f, search)).stand.map(shape), search).toEqual(
        (await both(f, search)).server.map(shape),
      )
  })

  it('refuses a cursor of another search and a long search, as the server does', async () => {
    const f = await northstar()
    const ws = await workspaceOf(as(f.t, f.nora))
    if (!ws) throw new Error('no workspace')
    const first = await both(f, '')
    const [server, stand] = [first.server[0], first.stand[0]]
    if (server?.state !== 'ready' || stand?.state !== 'ready') throw new Error('not ready')
    await expect(
      as(f.t, f.nora).query(api.pickers.mentions, {
        org_id: f.org.id,
        search: 'berg',
        after: server.next ?? '',
      }),
    ).rejects.toMatchObject({ data: { code: 'bad_request' } })
    expect(
      refusal(() =>
        mentionStandIn(ws, { org_id: f.org.id, search: 'berg', after: stand.next ?? '' }),
      ),
    ).toBe('bad_request')
    const long = 'x'.repeat(201)
    await expect(
      as(f.t, f.nora).query(api.pickers.mentions, { org_id: f.org.id, search: long }),
    ).rejects.toMatchObject({ data: { code: 'rule' } })
    expect(refusal(() => mentionStandIn(ws, { org_id: f.org.id, search: long }))).toBe('rule')
  })
})
