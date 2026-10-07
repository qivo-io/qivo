/* zzGuestOrg — the cross-organization fixture the guest-access check
 * requires: a fake partner organization holding an UNCLAIMED guest seat that
 * carries a real Northstar login's email.
 *
 * WHY THIS IS NOT DEMO DATA, and cannot become it (the fixture's doctrine):
 *   · The Northstar importer (internal/marketingDemo) is PER-ORGANIZATION; a
 *     second organization is outside its contract, and its reset
 *     correspondingly never touches this fixture either.
 *   · It must not be a migration-equivalent: it plants a partner organization
 *     with a guest seat on a real login. That belongs on a development
 *     deployment on purpose.
 *   · It must not join the demo dataset: "ZZ Guest Org / ZZ Shared Project /
 *     ZZ shared task" is test scaffolding — once the seat is claimed it sits
 *     in that login's sidebar under a foreign-organization header, and in
 *     Settings › Members under Guests, in every screenshot anyone took. The
 *     seat therefore belongs to Ben, a Northstar person no drive or
 *     screenshot signs in as — never to Nora.
 * So it is its own entry point:
 *   npx convex run internal/guestOrg:zzGuestOrg
 *
 * RE-RUNNING IS SAFE and is the intended way to repair it. The build tears
 * the organization down first (deleteOrgDeep, the organizations row
 * included), so the shared task is always that org's FIRST issue — i.e.
 * QN-1, colliding with the home organization's QN-1, which is the whole
 * point of the browser half. Ben's guest seat goes back to UNCLAIMED;
 * claim_my_seats adopts it at his next boot.
 *
 * NO auth half, deliberately: the fixture mints no logins — the guest seat is
 * an unclaimed invitation, and zz-staff@guest.local never signs in. A pure
 * internalMutation is enough, and makes teardown+rebuild one transaction.
 *
 * The fixed ffffffff-… uuids are kept for debuggability; nothing depends on
 * them beyond this file. */

import { internalMutation } from '../_generated/server'
import { byId } from '../lib/db'
import { refuseProduction } from '../lib/deployment'
import type { IssueStatus } from '../lib/enums'
import { deleteOrgDeep } from '../model/cascade'
import { newOrgDefaults, newTeamDefaults } from '../model/orgs'
import { projectDescription } from '../model/projects'

/* The seat's login: `<key>@demo.qivo.io` is the Northstar roster's address
 * pattern (internal/marketingDemo). */
const GUEST = { email: 'ben@demo.qivo.io', name: 'Ben (guest)', initials: 'BG' }

const DAY = 86_400_000
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/* Monday of the current week, UTC — the SQL's date_trunc('week', current_date). */
const monday = (nowMs: number) => {
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
}

const ZZ = {
  org: 'ffffffff-0000-4000-8000-00000000000d',
  team: 'ffffffff-0000-4000-8000-00000000001d',
  sharedMeta: 'ffffffff-0000-4000-8000-00000000003d',
  sharedSub: 'ffffffff-0000-4000-8000-00000000004d',
  hiddenMeta: 'ffffffff-0000-4000-8000-00000000005d',
  sharedTask: 'ffffffff-0000-4000-8000-00000000006d',
  label: 'ffffffff-0000-4000-8000-00000000007d',
  guestSeat: 'ffffffff-0000-4000-8000-00000000008d',
  hiddenSub: 'ffffffff-0000-4000-8000-00000000009d',
  staff: 'ffffffff-0000-4000-8000-0000000000ad',
  sharedLoad: 'ffffffff-0000-4000-8000-0000000000bd',
  hiddenLoad: 'ffffffff-0000-4000-8000-0000000000cd',
} as const

export const zzGuestOrg = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ org_id: string; torn_down: boolean }> => {
    refuseProduction('guestOrg')
    const nowMs = Date.now()
    const now = new Date(nowMs).toISOString()

    /* ---- teardown (also the standalone remove): by fixed id like the SQL,
     * plus a by_slug probe so a half-built stray can never block the slug. */
    let torn_down = false
    const seen = new Set<string>()
    for (const org of [
      await byId(ctx, 'organizations', ZZ.org),
      await ctx.db
        .query('organizations')
        .withIndex('by_slug', (q) => q.eq('slug', 'zz-guest-org'))
        .unique(),
    ]) {
      if (org === null || seen.has(org.id)) continue
      seen.add(org.id)
      await deleteOrgDeep(ctx, org)
      torn_down = true
    }

    /* ---- create. Counters land at the seeded numbering: 3 issues, 4
     * projects — the NEXT insert takes 4/5. Billing exists so "the host
     * organization's billing stays invisible" is a real miss rather than an
     * assertion passing against an empty table. */
    await ctx.db.insert('organizations', {
      id: ZZ.org,
      name: 'ZZ Guest Org',
      slug: 'zz-guest-org',
      ...newOrgDefaults(now),
      next_issue_num: 3,
      next_project_num: 4,
      billing: { plan: 'Team', seats: 5, renewal_date: isoDate(nowMs + 90 * DAY) },
    })

    await ctx.db.insert('teams', {
      id: ZZ.team,
      org_id: ZZ.org,
      name: 'ZZ Guest Team',
      ...newTeamDefaults(now),
    })

    /* The SHARED pair (the guest is invited to the meta; grants inherit) and
     * the HIDDEN sibling they are NOT invited to — the control that proves a
     * grant reaches one project, not the organization. Nums 1..4 in insert
     * order. */
    const project = (
      id: string,
      num: number,
      key: string,
      name: string,
      sort_order: number,
      shape: { parent_id?: string },
    ) =>
      ctx.db.insert('projects', {
        id,
        org_id: ZZ.org,
        type: shape.parent_id === undefined ? 'meta' : 'project',
        parent_id: shape.parent_id,
        key,
        name,
        description: projectDescription(''),
        sort_order,
        num,
        track_delay: true, // the 0064 column default the SQL rows took
        created_at: now,
      })
    await project(ZZ.sharedMeta, 1, 'ZGM', 'ZZ Shared Project', 0, {})
    await project(ZZ.sharedSub, 2, 'ZGS', 'ZZ Shared Sub', 0, { parent_id: ZZ.sharedMeta })
    await project(ZZ.hiddenMeta, 3, 'ZGH', 'ZZ Hidden Project', 1, {})
    await project(ZZ.hiddenSub, 4, 'ZGX', 'ZZ Hidden Sub', 0, { parent_id: ZZ.hiddenMeta })

    /* The STAFF member of the host org — the person whose capacity a guest
     * may and may not read. No login, no accepted_at (the fixture mints no
     * auth). plannable_hours 32 = the org default the 0092 insert trigger
     * stamped; message_retention_days 7 = the PG column default (0110),
     * stamped by hand because absent means Never here. */
    const profile = (
      id: string,
      email: string,
      name: string,
      initials: string,
      org_role: 'user' | 'guest',
    ) =>
      ctx.db.insert('profiles', {
        id,
        org_id: ZZ.org,
        email,
        name,
        initials,
        color: '#888888',
        org_role,
        active: true,
        kind: 'person',
        plannable_hours: 32,
        message_retention_days: 7,
        created_at: now,
      })
    await profile(ZZ.staff, 'zz-staff@guest.local', 'ZZ Staff', 'ZS', 'user')

    /* FIRST issue of this organization on purpose: it takes num 1, so "QN-1"
     * exists twice across the blend and only the org-prefixed URL can name
     * this one. created_by stays absent — the SQL rows had none. */
    const issue = (
      id: string,
      num: number,
      project_id: string,
      title: string,
      status: IssueStatus,
      load?: { remaining_hours: number },
    ) =>
      ctx.db.insert('issues', {
        id,
        project_id,
        org_id: ZZ.org,
        num,
        title,
        description: '',
        status,
        priority: 'low',
        assignee_id: load !== undefined ? ZZ.staff : undefined,
        /* this week's Monday → +7d (the SQL's date_trunc('week', current_date)) */
        start_week: load !== undefined ? isoDate(monday(nowMs)) : undefined,
        end_week: load !== undefined ? isoDate(monday(nowMs) + 7 * DAY) : undefined,
        remaining_hours: load?.remaining_hours,
        /* 0072's insert trigger has no Convex successor: stamp by hand */
        remaining_set_at: load !== undefined ? now : undefined,
        paused: false,
        created_at: now,
        updated_at: now,
      })
    await issue(ZZ.sharedTask, 1, ZZ.sharedSub, 'ZZ shared task', 'backlog')

    /* Scheduled + estimated work for the staff member, one visible to the
     * guest and one not: plan_org_load must hand over the first and never the
     * second. */
    await issue(ZZ.sharedLoad, 2, ZZ.sharedSub, 'ZZ shared load', 'todo', { remaining_hours: 20 })
    await issue(ZZ.hiddenLoad, 3, ZZ.hiddenSub, 'ZZ hidden load', 'todo', { remaining_hours: 30 })

    /* The host org's own vocabulary: selectable by a guest, not curatable (0085). */
    await ctx.db.insert('labels', {
      id: ZZ.label,
      org_id: ZZ.org,
      name: 'ZZGuestLabel',
      name_lower: 'zzguestlabel',
      color: '#888888',
      created_at: now,
    })

    /* The invitation itself: an UNCLAIMED guest seat carrying Ben's email —
     * no auth_user_id, no accepted_at — granted member on the shared project
     * only. claim_my_seats adopts it at his next boot, which is the first
     * thing the check asserts. */
    await profile(ZZ.guestSeat, GUEST.email, GUEST.name, GUEST.initials, 'guest')
    await ctx.db.insert('project_access', {
      project_id: ZZ.sharedMeta,
      profile_id: ZZ.guestSeat,
      level: 'user',
    })

    /* The shared task must be QN-1, or the collision the browser half proves
     * is gone (the SQL do-block's assertion). */
    const shared = await byId(ctx, 'issues', ZZ.sharedTask)
    if (shared === null || shared.num !== 1) {
      throw new Error(
        `ZZ shared task is QN-${shared?.num ?? '?'}, not QN-1 — the fixture must be torn down and rebuilt, not topped up`,
      )
    }

    return { org_id: ZZ.org, torn_down }
  },
})
