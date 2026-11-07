/* The organization's people read from the server for Settings ›
 * Organization › Users and for whoever needs a person's row by id. The
 * readers and their rules are in model/peopleSettings.ts; the writes stay
 * in profiles.ts.
 *
 * - settingsPage reads one page of Settings › Users, the organization's
 *   people and agents and then its guests, 25 records a page across both
 *   groups in name order, with a search over every person's name and
 *   address on the server, for an organization admin. The app subscribes to
 *   each page it shows (src/panels/settings/UsersSettings.tsx).
 * - get reads one person by id as the page shows them, for an organization
 *   admin, whether or not a loaded page holds them. The app subscribes
 *   while a `user:` page shows, for the phone's user page and Settings'
 *   check that the page is still valid
 *   (src/panels/settings/usePersonSettings.ts).
 * - byIds reads the person rows, with their faces, pictures and plannable
 *   hours, of up to 100 profiles of the organization by id, for any active
 *   seat, guests and viewers included, as the workspace's people part sends
 *   every seat the whole roster today. The app's profile cache reads it
 *   live, in chunks, for the people its open pages, pickers and views name
 *   that the workspace does not hold (src/store/profileCache.ts).
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
 * settingsPeopleOf), 25 records across the people and agents and then the
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
 * with their faces, which carry `id`, `name`, `org_role`, `kind`, `active`,
 * `pending`, `color`, the avatar color as the workspace sends it (gray for
 * an older non-hex value), `initials` as stored, `avatar`, the uploaded
 * picture's storage id or null, `sample_avatar`, the demo's sample portrait
 * or null, and `plannable_hours` as stored, null for an agent and for a seat
 * that stores none. Switched-off and pending profiles answer too. An unknown
 * id and a profile of another organization are left out, a definite answer,
 * since each was looked up. More than BY_IDS_MAX (100) ids are refused
 * (model/peopleSettings.ts peopleByIdsOf). Any active seat of the
 * organization reads it. Timed on 7 November 2026 at da65ecb5 on a local
 * backend on Boat (8 vCPU), one call at a time, as a standard user's login.
 * 100 ids of an organization of 1,000 people, each with a picture and
 * stored hours, read 103 ranges, 101 documents and 0.048 MiB with the
 * sign-in, the same reads as before `avatar`, `sample_avatar` and
 * `plannable_hours` joined the rows, which add 8,600 bytes to the answer
 * (86 bytes a row). The call answered 25,379 bytes and took 9 to 13 ms of
 * JavaScript quiet and 15 to 40 ms beside eight busy loops. The 49 others
 * of an everyday organization of 50 people took 8 to 11 ms quiet and 14 to
 * 40 ms busy, 25 ids 7 to 10 ms quiet and at most 45 ms busy, and 1 id 6 to
 * 12 ms quiet and at most 27 ms busy. The Settings users stage's timing of
 * 6 November 2026 saw the same read (101 documents, 0.054 MiB in the log,
 * 10 to 21 ms quiet). */
export const byIds = orgQuery({
  args: { ids: v.array(v.string()) },
  handler: (ctx, { ids }): Promise<{ rows: PersonFaceRow[] }> => peopleByIdsOf(ctx, ctx.me, ids),
})
