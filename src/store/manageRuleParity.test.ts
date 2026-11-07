/* The store's management rule (P.canManageOwnProjectAccess) against the
 * server's (convex/lib/access.ts managesIn): an active seat of the
 * project's organization, the project a top-level meta or a sub-project of
 * one, and an organization admin or the project's effective lead. The
 * store is booted from a workspace that holds every project of the
 * organization, so it is asked about projects outside a meta tree too,
 * which no opener shows, and about the projects an admin only manages.
 * Everyday sizes. */
/// <reference types="vite/client" />

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Doc } from '../../convex/_generated/dataModel'
import { managesIn } from '../../convex/lib/access'
import {
  as,
  newT,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
  workspaceOf,
} from '../../convex/tests/helpers.setup'
import type { Snapshot } from './plannerFixture.setup'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A fresh store whose first delivery is `snap`. */
async function start(snap: Snapshot) {
  vi.resetModules()
  vi.stubGlobal('window', { showToast: vi.fn() })
  network.query.mockResolvedValue(null)
  network.mutation.mockResolvedValue(null)
  network.onUpdate.mockImplementation((_ref, _args, next) => {
    next(structuredClone(snap))
    return () => {}
  })
  const store = await import('./planner')
  await store.initStore()
  return store.P
}

/** `profile`'s workspace with every project of their organization added, and
    no milestone beside it, as the store tests' whole carries them. */
async function worldOf(t: T, profile: Doc<'profiles'>): Promise<Snapshot> {
  const ws = await workspaceOf(as(t, profile))
  if (ws === null) throw new Error(`no workspace for ${profile.name}`)
  const held = new Set(ws.projects.map((p) => p.id))
  const rest = await t.run((ctx) =>
    ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', profile.org_id))
      .collect(),
  )
  return {
    ...ws,
    milestones: [],
    projects: [...ws.projects, ...rest.filter((p) => !held.has(p.id))],
  }
}

describe('the store’s management rule', () => {
  it('answers managesIn for every seat and project, outside a meta tree and for an admin without rows included', async () => {
    const t = newT()
    const f = await withOrg(t)
    const owen = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Owen',
      auth_user_id: `auth_${uuid()}`,
    })
    // a top-level project that is not a meta, and a sub-project under it,
    // both led by Owen, who therefore manages neither
    const loose = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      key: 'LOOSE',
      lead_id: owen.id,
    })
    await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: loose.id,
      key: 'UNDER',
      lead_id: owen.id,
    })
    // a sub-project of TBED that Owen leads, which he manages
    await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      key: 'OWEN',
      lead_id: owen.id,
    })
    const inactive = await plantSeat(t, {
      org_id: f.org.id,
      name: 'Gone admin',
      org_role: 'admin',
      active: false,
    })
    const projects = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    )
    const byId = new Map(projects.map((p) => [p.id, p]))
    const P = await start(await worldOf(t, f.user))
    let manages = 0
    let refused = 0
    for (const seat of [f.admin, f.user, f.guest, f.viewer, owen, inactive])
      for (const p of projects) {
        const root = p.parent_id === undefined ? p : byId.get(p.parent_id)
        const server = root !== undefined && managesIn(seat, p, root)
        expect(P.canManageOwnProjectAccess(p.id, seat.id), `${seat.name} on ${p.key}`).toBe(server)
        if (server) manages++
        else refused++
      }
    // the admin manages every project in a meta tree, Owen only his own,
    // and nobody manages LOOSE or UNDER
    expect(P.canManageOwnProjectAccess(loose.id, f.admin.id)).toBe(false)
    expect(P.canManageOwnProjectAccess(f.hidden.id, f.admin.id)).toBe(true)
    expect(P.levelOn(f.hidden.id, f.admin.id)).toBeNull()
    expect(manages).toBeGreaterThan(5)
    expect(refused).toBeGreaterThan(5)
  })
})
