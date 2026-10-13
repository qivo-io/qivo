/* One-time repair: remove the team memberships guests still hold.
 *
 * A guest is never a team member (teams.addMember). Before every role change
 * followed that rule, a seat could become a guest and keep its team rows,
 * leadership included. Those rows grant nothing, because team access and
 * leadership ignore guests, but the snapshot still sends them, so the app
 * can list a guest under a team (Team Sync's team scope). Seats that become
 * guests now leave every team (leaveAllTeams), so only older data needs this.
 *
 * Run it once per deployment, reading the dry run first:
 *   npx convex run internal/guestTeams:repair '{"dry_run": true}'
 *   npx convex run internal/guestTeams:repair '{"dry_run": false}'
 * The result holds counts only. Re-running is safe, and a clean deployment
 * reports zeros. Like leaveAllTeams it writes no activity. A team whose only
 * leader was a guest is left without one; its organization's admins run it. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import { internalAction, internalMutation } from '../_generated/server'
import { byId } from '../lib/db'

const PAGE = 256

type PageResult = {
  memberships: number
  leaderships: number
  guests: string[]
  cursor: string
  done: boolean
}

const pageRef = makeFunctionReference<
  'mutation',
  { dry_run: boolean; cursor: string | null },
  PageResult
>('internal/guestTeams:page')

/** One page of team_members in its own transaction. A deleted row cannot
 * move the cursor, so the next page starts where this one ended. */
export const page = internalMutation({
  args: { dry_run: v.boolean(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { dry_run, cursor }): Promise<PageResult> => {
    const rows = await ctx.db.query('team_members').paginate({ cursor, numItems: PAGE })
    const guests = new Set<string>()
    let memberships = 0
    let leaderships = 0
    for (const row of rows.page) {
      const profile = await byId(ctx, 'profiles', row.profile_id)
      if (profile?.org_role !== 'guest') continue
      guests.add(profile.id)
      memberships += 1
      if (row.is_leader) leaderships += 1
      if (!dry_run) await ctx.db.delete(row._id)
    }
    return {
      memberships,
      leaderships,
      guests: [...guests],
      cursor: rows.continueCursor,
      done: rows.isDone,
    }
  },
})

/** Walks every page and reports what it removed, or would remove. */
export const repair = internalAction({
  args: { dry_run: v.boolean() },
  handler: async (ctx, { dry_run }) => {
    const guests = new Set<string>()
    let memberships = 0
    let leaderships = 0
    let cursor: string | null = null
    for (;;) {
      const result: PageResult = await ctx.runMutation(pageRef, { dry_run, cursor })
      memberships += result.memberships
      leaderships += result.leaderships
      for (const id of result.guests) guests.add(id)
      if (result.done) break
      cursor = result.cursor
    }
    return { dry_run, memberships, leaderships, guests: guests.size }
  },
})
