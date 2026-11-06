/* The organization's people read from the server for Settings ›
 * Organization › Users and for whoever needs a person's row by id. The
 * readers and their rules are in model/peopleSettings.ts; the writes stay
 * in profiles.ts.
 *
 * - settingsPage: one page of Settings › Users, the organization's people
 *   and agents and then its guests, 25 records a page across both groups
 *   in name order, with a search over every person's name and address on
 *   the server, for an organization admin. The app subscribes to each page
 *   it shows (src/panels/settings/UsersSettings.tsx).
 * - get: one person by id as the page shows them, for an organization
 *   admin, whether or not a loaded page holds them. The app subscribes
 *   while a `user:` page shows, for the phone's user page and Settings'
 *   check that the page is still valid
 *   (src/panels/settings/usePersonSettings.ts).
 * - byIds: the person rows, with their faces, of up to 100 profiles of the
 *   organization by id, for any active seat, guests and viewers included,
 *   as the workspace's people part sends every seat the whole roster today.
 *   No page reads it yet; the roster cache and the pickers will, for people
 *   a batch does not hold.
 *
 * Each is an orgQuery, so the caller is an active seat of `org_id`, and
 * reads one organization, no task, team, membership or key, and no grant
 * other than a guest's own. settingsPage and get answer `admins`, the
 * organization's active admins counted up to two over its admins alone,
 * the count the writes' last-admin check reads (model/orgs.ts
 * activeAdmins). */

import { v } from 'convex/values'
import { orgQuery } from './lib/functions'
import {
  type PeoplePageAnswer,
  type PersonFaceRow,
  type PersonSettingsAnswer,
  peopleByIdsOf,
  settingsPeopleOf,
  settingsPersonOf,
} from './model/peopleSettings'

/** One page of Settings › Users (model/peopleSettings.ts
 * settingsPeopleOf): 25 records across the people and agents and then the
 * guests, in name key order with the id breaking ties, each with what its
 * row's controls need and a guest with their first projects, and
 * `admins`. `search` keeps a person when every word of it is in their name
 * or their address. `after` is a cursor from an earlier page's `next`;
 * `through` keeps the shape the Settings lists share, and no app caller
 * sends it. Only an organization admin reads it. */
export const settingsPage = orgQuery({
  args: {
    search: v.optional(v.string()),
    after: v.optional(v.string()),
    through: v.optional(v.string()),
  },
  handler: (ctx, a): Promise<PeoplePageAnswer> => settingsPeopleOf(ctx, ctx.me, a),
})

/** Person `id` as Settings › Users shows them, with `admins`, or
 * `unavailable` alike for an unknown id and a profile of another
 * organization (model/peopleSettings.ts settingsPersonOf). Only an
 * organization admin reads it. */
export const get = orgQuery({
  args: { id: v.string() },
  handler: (ctx, { id }): Promise<PersonSettingsAnswer> => settingsPersonOf(ctx, ctx.me, id),
})

/** The profiles of the organization among `ids`, each once, as person rows
 * with their faces: `id`, `name`, `org_role`, `kind`, `active`, `pending`,
 * `color`, the avatar color as the workspace sends it (gray for an older
 * non-hex value), and `initials`, as stored. Switched-off and pending
 * profiles answer too. An unknown id and a profile of another organization
 * are left out, a definite answer, since each was looked up. More than
 * BY_IDS_MAX (100) ids are refused (model/peopleSettings.ts peopleByIdsOf).
 * Any active seat of the organization reads it. */
export const byIds = orgQuery({
  args: { ids: v.array(v.string()) },
  handler: (ctx, { ids }): Promise<{ rows: PersonFaceRow[] }> => peopleByIdsOf(ctx, ctx.me, ids),
})
