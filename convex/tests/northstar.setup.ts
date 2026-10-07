/* Northstar Labs inside convex-test — the whole dataset through the same
 * writeNorthstarWork the importer (internal/marketingDemo) and the public
 * demo use, without the auth component, the ownership receipt or scrypt: the
 * organization and its eight profiles are planted raw, each person carrying
 * the fake login `auth_<key>` so `t.withIdentity({ subject: 'auth_nora' })`
 * walks through the public doors as Nora. About a second per call — plant
 * once per test, never in a loop; the generic suites keep the tiny
 * helpers.setup fixture.
 *
 * Named *.setup.ts: two dots in the basename is the Convex CLI's skip rule
 * (see helpers.setup.ts). */

import type { Doc } from '../_generated/dataModel'
import { MARKETING_DEMO, marketingId } from '../internal/marketingDemoData'
import { writeNorthstarWork } from '../model/demoSeed'
import { newOrgDefaults } from '../model/orgs'
import { NOW, type T } from './helpers.setup'

export const NORTHSTAR = 'northstar-labs'
/* The production scenario's anchor Monday (docs/marketing-demo.md). */
export const NORTHSTAR_ANCHOR = '2026-09-07'

/* The deterministic id of any dataset row: `id('issue:pcb-revb')`,
 * `id('team:northstar')`, `id('person:leo')`, … */
export const northstarId = (key: string): Promise<string> => marketingId(NORTHSTAR, key)

export async function plantNorthstar(
  t: T,
  anchor = NORTHSTAR_ANCHOR,
): Promise<{ org: Doc<'organizations'>; profiles: Doc<'profiles'>[] }> {
  return await t.run(async (ctx) => {
    const orgId = await northstarId('org')
    const orgDoc = await ctx.db.insert('organizations', {
      id: orgId,
      name: MARKETING_DEMO.organization.name,
      slug: NORTHSTAR,
      ...newOrgDefaults(NOW),
      gravatar_avatars: false,
    })
    const org = (await ctx.db.get(orgDoc)) as Doc<'organizations'>
    const profiles: Doc<'profiles'>[] = []
    for (const p of MARKETING_DEMO.people) {
      const _id = await ctx.db.insert('profiles', {
        id: await northstarId(`person:${p.key}`),
        org_id: orgId,
        name: p.name,
        initials: p.initials,
        color: p.color,
        org_role: p.role,
        kind: p.kind,
        active: true,
        created_at: NOW,
        ...(p.kind === 'person'
          ? {
              email: `${p.key}@demo.qivo.io`,
              auth_user_id: `auth_${p.key}`,
              accepted_at: NOW,
              plannable_hours: org.default_plannable_hours,
              message_retention_days: 7,
            }
          : {}),
      })
      profiles.push((await ctx.db.get(_id)) as Doc<'profiles'>)
    }
    await writeNorthstarWork(ctx, { org, profiles, namespace: NORTHSTAR, anchor, now: NOW })
    return { org, profiles }
  })
}
