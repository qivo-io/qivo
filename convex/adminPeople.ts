/* The operator console's people reads, the Users page and an organization's
 * page (src/admin/views/Users.tsx and Orgs.tsx). They port admin_list_users
 * (LAST def 0096:425-455) and admin_org_detail (LAST def 0096:377-418), and
 * their response shapes match what the views destructure, field by field.
 *
 * Both are platform actions that page through the data with bounded internal
 * queries, as adminStats.ts does, so no read grows with the deployment or the
 * organization. A page reads at most its PEOPLE_PAGE rows and
 * PEOPLE_PAGE.bytes of its range, and up to one more than PEOPLE_PAGE.invites
 * audit rows of each pending seat or PEOPLE_PAGE.children members and
 * projects of each team on it. A longer list is paged on its own. The answer
 * is built from many snapshots, so a write during a load can show in one
 * page and not yet in another. The console loads on demand, so that is
 * accepted.
 *
 * Two auth.users columns the SQL joined have no Better Auth twin:
 * - last_sign_in_at is about the newest session.createdAt for the login.
 *   Expired sessions vanish from the component, so a long-absent member
 *   reads "—". That is a stated approximation, not a bug.
 * - banned_until keeps its wire name (isBanned() and both views read it) but
 *   is mapped from Better Auth's { banned, banExpires }. Not banned is null,
 *   banned with banExpires is its ISO time, and banned forever is a
 *   far-future sentinel.
 * Both come from the component, PEOPLE_PAGE.logins logins per query, and
 * degrade to null when the login row is unreachable, as the SQL's LEFT JOIN
 * did. */

import { v } from 'convex/values'
import { literals } from 'convex-helpers/validators'
import { components, internal } from './_generated/api'
import type { Doc } from './_generated/dataModel'
import type { QueryCtx } from './_generated/server'
import { internalQuery } from './_generated/server'
import { allOrgs, inParallel, nextOf, type Runner } from './adminStats'
import { subscriptionFor } from './lib/billingAccess'
import { byId } from './lib/db'
import type { OrgRole, ProfileKind } from './lib/enums'
import { badRequest, notFound, platformAction, require } from './lib/functions'
import { allWordsMatcher } from './lib/search'

/** Rows per internal page, and the bytes one page's range may read. Tests
 * lower them. */
export const PEOPLE_PAGE = {
  /** Profiles per page of the Users page. They read nothing per row. */
  profiles: 2000,
  /** An organization's profiles per page. Each pending seat on it reads up
   * to `invites` + 1 audit rows. */
  members: 500,
  /** Audit rows read per pending seat on a members page. A seat with more is
   * left out of the page, and its rows are paged on their own. */
  invites: 20,
  /** A seat's audit rows per page once it is paged on its own. */
  audit: 2000,
  /** Teams per page. Each reads up to `children` + 1 members and projects. */
  teams: 100,
  /** Members or projects counted per team on a teams page. A team with more
   * is counted on its own. */
  children: 50,
  /** Rows per page of one team's members or projects counted on their own. */
  rows: 2000,
  /** Logins whose auth columns one query reads. */
  logins: 50,
  /** Bytes the paged range of one page may read. */
  bytes: 8 * 1024 * 1024,
}

const vCursor = v.union(v.string(), v.null())

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/* banned with no banExpires, "the ban will never expire" (Better Auth admin
 * plugin). Far-future, so isBanned()'s `> Date.now()` reads it as banned
 * forever. */
const BAN_NEVER_EXPIRES = '9999-12-31T00:00:00.000Z'

/* ------------------------------------------------------------- auth columns */

type AuthColumns = { last_sign_in_at: string | null; banned_until: string | null }

const NO_AUTH_COLUMNS: AuthColumns = { last_sign_in_at: null, banned_until: null }

/* The two approximated auth.users columns for one Better Auth login. The
 * catch is the LEFT JOIN's null arm. A vanished or unreadable user row means
 * no auth columns, never a failed console view. */
async function authColumnsFor(ctx: QueryCtx, authUserId: string): Promise<AuthColumns> {
  try {
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
      model: 'user',
      where: [{ field: '_id', value: authUserId }],
    })) as { banned?: boolean | null; banExpires?: number | null } | null
    if (user === null) return NO_AUTH_COLUMNS
    let newestSession = 0
    let cursor: string | null = null
    for (;;) {
      const page = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model: 'session',
        where: [{ field: 'userId', value: authUserId }],
        paginationOpts: { numItems: 200, cursor },
      })) as { page: Array<{ createdAt?: number }>; isDone: boolean; continueCursor: string }
      for (const s of page.page) {
        if (typeof s.createdAt === 'number' && s.createdAt > newestSession)
          newestSession = s.createdAt
      }
      if (page.isDone) break
      cursor = page.continueCursor
    }
    return {
      last_sign_in_at: newestSession > 0 ? new Date(newestSession).toISOString() : null,
      banned_until:
        user.banned !== true
          ? null
          : typeof user.banExpires === 'number'
            ? new Date(user.banExpires).toISOString()
            : BAN_NEVER_EXPIRES,
    }
  } catch {
    return NO_AUTH_COLUMNS
  }
}

type LoginColumns = AuthColumns & { auth_user_id: string }

/** The auth columns of up to PEOPLE_PAGE.logins logins. */
export const loginPage = internalQuery({
  args: { auth_user_ids: v.array(v.string()) },
  handler: async (ctx, { auth_user_ids }): Promise<LoginColumns[]> => {
    require(auth_user_ids.length <= PEOPLE_PAGE.logins, badRequest('too many logins for one page'))
    const rows: LoginColumns[] = []
    for (const auth_user_id of auth_user_ids)
      rows.push({ auth_user_id, ...(await authColumnsFor(ctx, auth_user_id)) })
    return rows
  },
})

/** The auth columns of every distinct login among `ids`, PEOPLE_PAGE.logins
 * per query. */
async function authColumns(
  ctx: Runner,
  ids: ReadonlyArray<string | undefined>,
): Promise<Map<string, AuthColumns>> {
  const distinct = [...new Set(ids.filter((id): id is string => id !== undefined))]
  const batches: string[][] = []
  for (let i = 0; i < distinct.length; i += PEOPLE_PAGE.logins)
    batches.push(distinct.slice(i, i + PEOPLE_PAGE.logins))
  const pages = await inParallel(batches, (auth_user_ids) =>
    ctx.runQuery(internal.adminPeople.loginPage, { auth_user_ids }),
  )
  return new Map(pages.flat().map(({ auth_user_id, ...cols }) => [auth_user_id, cols]))
}

/* ---------------------------------------------------------------- listUsers */

export type AdminUserRow = {
  profile_id: string
  name: string
  email: string | null
  org_id: string
  org_name: string
  org_role: OrgRole
  has_login: boolean
  last_sign_in_at: string | null
  banned_until: string | null
  created_at: string
}

/* The profile fields the Users page and an organization's page show. */
type PersonFields = Pick<
  Doc<'profiles'>,
  | 'id'
  | 'name'
  | 'email'
  | 'org_id'
  | 'org_role'
  | 'kind'
  | 'active'
  | 'auth_user_id'
  | 'created_at'
>

const personFields = (p: Doc<'profiles'>): PersonFields => ({
  id: p.id,
  name: p.name,
  email: p.email,
  org_id: p.org_id,
  org_role: p.org_role,
  kind: p.kind,
  active: p.active,
  auth_user_id: p.auth_user_id,
  created_at: p.created_at,
})

type ProfilePage = { profiles: PersonFields[]; next: string | null }

/** One page of every organization's profiles. */
export const profilePage = internalQuery({
  args: { cursor: vCursor },
  handler: async (ctx, { cursor }): Promise<ProfilePage> => {
    const page = await ctx.db.query('profiles').paginate({
      cursor,
      numItems: PEOPLE_PAGE.profiles,
      maximumBytesRead: PEOPLE_PAGE.bytes,
    })
    return { profiles: page.page.map(personFields), next: nextOf(page) }
  },
})

/* admin_list_users. Cross-organization. An empty search lists everyone, and
 * otherwise every case-insensitive fragment must match the profile name,
 * email or organization name. Ordered by organization name, then profile
 * name. A profile whose organization row is gone drops out, as the SQL's
 * inner join on organizations did. */
export const listUsers = platformAction({
  args: { search: v.string() },
  handler: async (ctx, { search }): Promise<AdminUserRow[]> => {
    const orgNames = new Map((await allOrgs(ctx)).map((o) => [o.id, o.name]))
    const matches = allWordsMatcher(search)
    const matched: Array<{ p: PersonFields; org_name: string }> = []
    let cursor: string | null = null
    do {
      const page: ProfilePage = await ctx.runQuery(internal.adminPeople.profilePage, { cursor })
      for (const p of page.profiles) {
        const org_name = orgNames.get(p.org_id)
        if (org_name !== undefined && matches(`${p.name}\n${p.email ?? ''}\n${org_name}`))
          matched.push({ p, org_name })
      }
      cursor = page.next
    } while (cursor !== null)
    matched.sort((a, b) => cmp(a.org_name, b.org_name) || cmp(a.p.name, b.p.name))

    const auth = await authColumns(
      ctx,
      matched.map(({ p }) => p.auth_user_id),
    )
    return matched.map(({ p, org_name }): AdminUserRow => {
      const cols = p.auth_user_id !== undefined ? auth.get(p.auth_user_id) : undefined
      return {
        profile_id: p.id,
        name: p.name,
        email: p.email ?? null,
        org_id: p.org_id,
        org_name,
        org_role: p.org_role,
        has_login: p.auth_user_id !== undefined,
        last_sign_in_at: cols?.last_sign_in_at ?? null,
        banned_until: cols?.banned_until ?? null,
        created_at: p.created_at,
      }
    })
  },
})

/* ---------------------------------------------------------------- orgDetail */

export type AdminMemberRow = {
  profile_id: string
  name: string
  email: string | null
  org_role: OrgRole
  kind: ProfileKind
  active: boolean
  has_login: boolean
  last_sign_in_at: string | null
  banned_until: string | null
  created_at: string
  /* A pending person's newest invitation email to their current address,
   * sent from the console or the app (invites.ts), or null when none was
   * recorded. */
  invite: { sent: boolean; at: string } | null
}

type Invite = AdminMemberRow['invite']

export type AdminOrgDetail = {
  org: { id: string; name: string; created_at: string }
  billing: { plan: string; seats: number; renewal_date: string | null } | null
  members: AdminMemberRow[]
  teams: Array<{ id: string; name: string; member_count: number; project_count: number }>
}

type DetailHead = Pick<AdminOrgDetail, 'org' | 'billing'>

/** An organization's own fields and billing, or null when it is gone. */
export const detailHead = internalQuery({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<DetailHead | null> => {
    const org = await byId(ctx, 'organizations', org_id)
    if (org === null) return null
    const subscription = await subscriptionFor(ctx, org.id)
    const plan = subscription ? await byId(ctx, 'billing_plans', subscription.plan_id) : null
    return {
      org: { id: org.id, name: org.name, created_at: org.created_at },
      billing:
        subscription && plan
          ? {
              plan: plan.name,
              seats: subscription.billed_seats,
              renewal_date: subscription.current_period_end?.slice(0, 10) ?? null,
            }
          : org.billing !== undefined
            ? {
                plan: org.billing.plan,
                seats: org.billing.seats,
                renewal_date: org.billing.renewal_date,
              }
            : null,
    }
  },
})

/* The newest 'invite_email' row in `rows` for address `email`, or undefined
 * when none of them is one. An org admin may correct a pending seat's
 * address, and a letter to the old address says nothing about the new one. */
function inviteIn(
  rows: Doc<'platform_audit_log'>[],
  email: string | undefined,
): Invite | undefined {
  for (const row of rows) {
    if (row.action !== 'invite_email') continue
    const detail = row.detail as { sent?: unknown; email?: unknown }
    if (detail.email !== email) continue
    return { sent: detail.sent === true, at: row.ts }
  }
  return undefined
}

/* A seat's audit rows, newest first. */
const seatAudit = (ctx: QueryCtx, profileId: string) =>
  ctx.db
    .query('platform_audit_log')
    .withIndex('by_target_profile', (q) => q.eq('target_profile_id', profileId))
    .order('desc')

type Member = PersonFields & { invite: Invite }

/** A members page also names the pending seats whose audit rows were too
 * many to read on it. Their invite is null until the action reads them. */
type MemberPage = { members: Member[]; deferred: string[]; next: string | null }

/** One page of an organization's profiles, with each pending seat's newest
 * invitation email when its newest PEOPLE_PAGE.invites audit rows hold it or
 * hold every row it has. */
export const memberPage = internalQuery({
  args: { org_id: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, cursor }): Promise<MemberPage> => {
    const page = await ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: PEOPLE_PAGE.members, maximumBytesRead: PEOPLE_PAGE.bytes })
    const members: Member[] = []
    const deferred: string[] = []
    for (const p of page.page) {
      let invite: Invite = null
      if (p.kind === 'person' && p.auth_user_id === undefined) {
        const rows = await seatAudit(ctx, p.id).take(PEOPLE_PAGE.invites + 1)
        const found = inviteIn(rows.slice(0, PEOPLE_PAGE.invites), p.email)
        if (found !== undefined) invite = found
        else if (rows.length > PEOPLE_PAGE.invites) deferred.push(p.id)
      }
      members.push({ ...personFields(p), invite })
    }
    return { members, deferred, next: nextOf(page) }
  },
})

type InvitePage = { invite: Invite; next: string | null }

/** One page of a pending seat's audit rows, newest first, with the newest
 * invitation email to the seat's current address. `next` is null once it is
 * found or the rows end. */
export const invitePage = internalQuery({
  args: { profile_id: v.string(), cursor: vCursor },
  handler: async (ctx, { profile_id, cursor }): Promise<InvitePage> => {
    const seat = await byId(ctx, 'profiles', profile_id)
    if (seat === null) return { invite: null, next: null }
    const page = await seatAudit(ctx, profile_id).paginate({
      cursor,
      numItems: PEOPLE_PAGE.audit,
      maximumBytesRead: PEOPLE_PAGE.bytes,
    })
    const invite = inviteIn(page.page, seat.email)
    if (invite !== undefined) return { invite, next: null }
    return { invite: null, next: nextOf(page) }
  },
})

/** A pending seat's newest invitation email to its current address, read
 * page by page. */
async function seatInvite(ctx: Runner, profile_id: string): Promise<Invite> {
  let cursor: string | null = null
  do {
    const page: InvitePage = await ctx.runQuery(internal.adminPeople.invitePage, {
      profile_id,
      cursor,
    })
    if (page.invite !== null) return page.invite
    cursor = page.next
  } while (cursor !== null)
  return null
}

const TEAM_CHILDREN = ['members', 'projects'] as const
type TeamChild = (typeof TEAM_CHILDREN)[number]

/* A team's members, or the projects that keep it as their legacy team. */
function teamChildQuery(ctx: QueryCtx, child: TeamChild, teamId: string) {
  return child === 'members'
    ? ctx.db.query('team_members').withIndex('by_team', (q) => q.eq('team_id', teamId))
    : ctx.db.query('projects').withIndex('by_team', (q) => q.eq('team_id', teamId))
}

type TeamRow = AdminOrgDetail['teams'][number]

/** A teams page also names the counts it left out for being longer than
 * PEOPLE_PAGE.children rows. Those counts are 0 on it. */
type TeamPage = {
  teams: TeamRow[]
  deferred: Array<{ team_id: string; child: TeamChild }>
  next: string | null
}

/** One page of an organization's teams, each with its member and project
 * counts. */
export const teamPage = internalQuery({
  args: { org_id: v.string(), cursor: vCursor },
  handler: async (ctx, { org_id, cursor }): Promise<TeamPage> => {
    const page = await ctx.db
      .query('teams')
      .withIndex('by_org', (q) => q.eq('org_id', org_id))
      .paginate({ cursor, numItems: PEOPLE_PAGE.teams, maximumBytesRead: PEOPLE_PAGE.bytes })
    const teams: TeamRow[] = []
    const deferred: TeamPage['deferred'] = []
    for (const team of page.page) {
      const counts = { members: 0, projects: 0 }
      for (const child of TEAM_CHILDREN) {
        const rows = await teamChildQuery(ctx, child, team.id).take(PEOPLE_PAGE.children + 1)
        if (rows.length > PEOPLE_PAGE.children) deferred.push({ team_id: team.id, child })
        else counts[child] = rows.length
      }
      teams.push({
        id: team.id,
        name: team.name,
        member_count: counts.members,
        project_count: counts.projects,
      })
    }
    return { teams, deferred, next: nextOf(page) }
  },
})

type CountPage = { rows: number; next: string | null }

/** One page of a team's members or projects, counted. */
export const teamCountPage = internalQuery({
  args: { team_id: v.string(), child: literals(...TEAM_CHILDREN), cursor: vCursor },
  handler: async (ctx, { team_id, child, cursor }): Promise<CountPage> => {
    const page = await teamChildQuery(ctx, child, team_id).paginate({
      cursor,
      numItems: PEOPLE_PAGE.rows,
      maximumBytesRead: PEOPLE_PAGE.bytes,
    })
    return { rows: page.page.length, next: nextOf(page) }
  },
})

/** Every page of one organization's profiles, with the invites the pages
 * left out read on their own. */
async function allMembers(ctx: Runner, org_id: string): Promise<Member[]> {
  const members: Member[] = []
  const deferred: string[] = []
  let cursor: string | null = null
  do {
    const page: MemberPage = await ctx.runQuery(internal.adminPeople.memberPage, {
      org_id,
      cursor,
    })
    members.push(...page.members)
    deferred.push(...page.deferred)
    cursor = page.next
  } while (cursor !== null)
  const invites = new Map(
    await inParallel(deferred, async (id) => [id, await seatInvite(ctx, id)] as const),
  )
  return members.map((m) => (invites.has(m.id) ? { ...m, invite: invites.get(m.id) ?? null } : m))
}

/** Every page of one organization's teams, with the counts the pages left
 * out read on their own. */
async function allTeams(ctx: Runner, org_id: string): Promise<TeamRow[]> {
  const teams: TeamRow[] = []
  const deferred: TeamPage['deferred'] = []
  let cursor: string | null = null
  do {
    const page: TeamPage = await ctx.runQuery(internal.adminPeople.teamPage, { org_id, cursor })
    teams.push(...page.teams)
    deferred.push(...page.deferred)
    cursor = page.next
  } while (cursor !== null)
  const teamById = new Map(teams.map((team) => [team.id, team]))
  await inParallel(deferred, async ({ team_id, child }) => {
    let rows = 0
    let childCursor: string | null = null
    do {
      const page: CountPage = await ctx.runQuery(internal.adminPeople.teamCountPage, {
        team_id,
        child,
        cursor: childCursor,
      })
      rows += page.rows
      childCursor = page.next
    } while (childCursor !== null)
    const team = teamById.get(team_id)
    if (team === undefined) return
    if (child === 'members') team.member_count = rows
    else team.project_count = rows
  })
  return teams
}

/* admin_org_detail. Members and teams are each ordered by name. A missing
 * organization throws the SQL's sentence. */
export const orgDetail = platformAction({
  args: { org_id: v.string() },
  handler: async (ctx, { org_id }): Promise<AdminOrgDetail> => {
    const head: DetailHead | null = await ctx.runQuery(internal.adminPeople.detailHead, { org_id })
    require(head !== null, notFound('organization not found'))
    const profiles = await allMembers(ctx, org_id)
    profiles.sort((a, b) => cmp(a.name, b.name))
    const auth = await authColumns(
      ctx,
      profiles.map((p) => p.auth_user_id),
    )
    const members = profiles.map((p): AdminMemberRow => {
      const cols = p.auth_user_id !== undefined ? auth.get(p.auth_user_id) : undefined
      return {
        profile_id: p.id,
        name: p.name,
        email: p.email ?? null,
        org_role: p.org_role,
        kind: p.kind,
        active: p.active,
        has_login: p.auth_user_id !== undefined,
        last_sign_in_at: cols?.last_sign_in_at ?? null,
        banned_until: cols?.banned_until ?? null,
        created_at: p.created_at,
        invite: p.invite,
      }
    })
    const teams = await allTeams(ctx, org_id)
    teams.sort((a, b) => cmp(a.name, b.name))
    return { ...head, members, teams }
  },
})
