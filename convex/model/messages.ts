/* The inbox: subscriptions, the single message insert path, the pair-item
 * prune, the snooze wake, mention extraction and the notify fan-outs:
 * postMessage, pruneReadMessages, wakeSnoozedItem, subscribeToIssue,
 * extractMentions, notifyIssueInsert, notifyIssueUpdate, notifyCommentInsert
 * and notifyCommentUpdate.
 *
 * Change fragments are joined as sentences; user-written values inside
 * them are preserved verbatim. Inbox.tsx still rewrites 'an issue in another
 * project' and keys on 'New comment'. All timestamps are the mutation's ONE
 * `now` (0111: a comment and the message announcing it share an instant;
 * spine.ts's >= is load-bearing).
 *
 * Whoever a task passes to starts following it (#314), extending #89's
 * assignment subscription: the reviewer when the task enters Review or is
 * handed over in Review, the assignee when it leaves Review. A reviewer set
 * in any other status is not subscribed; one who already follows the task
 * reads 'Reviewer set to you'. */

import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import { profileCanSeeProject } from '../lib/access'
import { byId } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { reviewerOwns, taskOwnerId } from '../lib/review'
import { PRIORITY_NAMES, STATUS_NAMES } from './activity'
import { newUuid } from './orgs'
import { emitTaskEvent } from './taskEvents'

/* The line a reviewer reads when a task becomes theirs to review. */
const REVIEW_READY = 'Ready for your review'

/* The per-recipient placeholder for the parent-attach line (0114:212):
 * two followers of one task can differ on whether they may see the parent's
 * project, so the narration holds its place until the fan-out. */
export const ATTACH_SLOT = '\x01attach'

/* to_char(date, 'FMDD Mon') over the ISO 'YYYY-MM-DD' storage → '5 Aug'. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmtDayMon = (iso: string): string => {
  const [, m, d] = iso.split('-')
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`
}

/* to_char(numeric(6,1), 'FM999990.#'). VERIFIED against the live PG17
 * deployment: '#' is not a numeric template character, so the template has
 * zero fraction positions and the value is rounded to an INTEGER, half away
 * from zero — 80.5 → '81', 0.4 → '0', 2.0 → '2'. The design prose reads the
 * template as "integer-or-one-decimal"; byte fidelity follows what the
 * deployed trigger actually produced. remaining_hours >= 0, so JS
 * Math.round (half toward +∞) matches. */
const fmtHours = (n: number): string => String(Math.round(n))

/* Every message of one inbox item — the (recipient, issue) pair. */
const pairRows = (
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string },
): Promise<Doc<'messages'>[]> =>
  ctx.db
    .query('messages')
    .withIndex('by_recipient_issue', (q) =>
      q.eq('recipient_id', a.recipient_id).eq('issue_id', a.issue_id),
    )
    .collect()

/* -------------------------------------------------------------------- wake
 * Ends an item's snooze: every row of the pair loses snoozed_until, goes
 * UNREAD and is stamped woke_at = now, so the item returns bold, at the top
 * of the list, on every client at once. Idempotent by design — `until`
 * narrows it to the snooze it was scheduled for, so a wake scheduled for a
 * superseded or already-lifted snooze finds nothing and does nothing (no
 * cancellation bookkeeping). Without `until` (the nightly fallback) any
 * snooze on the pair ends. Returns whether anything woke. */
export async function wakeSnoozedItem(
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string; until?: string },
  now: string,
): Promise<boolean> {
  const rows = (await pairRows(ctx, a)).filter(
    (r) => r.snoozed_until !== undefined && (a.until === undefined || r.snoozed_until === a.until),
  )
  for (const r of rows) {
    await ctx.db.patch(r._id, { snoozed_until: undefined, read_at: undefined, woke_at: now })
  }
  return rows.length > 0
}

/* ------------------------------------------------------------------- prune
 * 0109's invariant, kept at both ends (postMessage and messages.markRead):
 * "an item holds every UNREAD message it has been sent, plus its newest
 * message when that one has been read." Deletes every READ message of the
 * (recipient, issue) pair except the pair's newest message, read or not.
 * Newest = max by (created_at desc, id desc) — raw string compare, the same
 * total order as the client's isNewer mirror (planner.ts), so client and
 * server keep the same survivor. */
export async function pruneReadMessages(
  ctx: MutationCtx,
  a: { recipient_id: string; issue_id: string },
  preloaded?: Doc<'messages'>[],
): Promise<void> {
  const rows = preloaded ?? (await pairRows(ctx, a))
  if (rows.length === 0) return
  let newest = rows[0]
  for (const r of rows) {
    if (
      r.created_at > newest.created_at ||
      (r.created_at === newest.created_at && r.id > newest.id)
    ) {
      newest = r
    }
  }
  for (const r of rows) {
    if (r._id !== newest._id && r.read_at !== undefined) await ctx.db.delete(r._id)
  }
}

/* ---------------------------------------------------------------- preload
 * Rows a bulk writer already holds, handed to notifyIssueInsert and
 * notifyCommentInsert so each call need not read them again. A preload is a
 * snapshot: it is valid only while nothing in the transaction changes
 * profiles, projects, grants or teams, so it must never be passed from an
 * interactive mutation. Only the Northstar seed (demoSeed.ts's
 * writeNorthstarWork) passes one; interactive mutations pass nothing and
 * every row is read fresh. */
export type NotifyPreload = {
  /* Every profile of the issue's org, as stored now (after any patch). */
  orgProfiles: Doc<'profiles'>[]
  /* The org's projects by uuid, as stored now; a miss is read by uuid. */
  projects: Map<string, Doc<'projects'>>
  /* Recipient visibility answers by `${profile}:${project}` uuid, filled as
   * they are asked. */
  visibility: Map<string, boolean>
}

/* profileCanSeeProject, answered from a preload's visibility memo when one
 * is given (see NotifyPreload), else asked live. */
async function recipientCanSee(
  ctx: MutationCtx,
  profile: Doc<'profiles'>,
  project: Doc<'projects'>,
  visibility: NotifyPreload['visibility'] | undefined,
): Promise<boolean> {
  if (visibility === undefined) return await profileCanSeeProject(ctx, profile, project)
  const key = `${profile.id}:${project.id}`
  let canSee = visibility.get(key)
  if (canSee === undefined) {
    canSee = await profileCanSeeProject(ctx, profile, project)
    visibility.set(key, canSee)
  }
  return canSee
}

/* ------------------------------------------------------------- postMessage
 * THE single insert path (0109:95-114) — no other code may insert messages.
 * Silent drops, never errors: the actor's own copy, a recipient outside the
 * issue's org, and a recipient who cannot see the project are all skipped
 * without a trace — a mention must not leak a hidden project's existence
 * (0074), and a subscription can never outlive the access that justified it
 * (0114:40-42). Returns whether a row was inserted.
 *
 * `issue` / `project` / `recipient` are optional preloads; when absent they
 * are read by uuid. `visibility` is a seed's memo (NotifyPreload), never
 * passed interactively. The issue_title snapshot is the issue's CURRENT
 * title (the SQL passed new.title). */
export async function postMessage(
  ctx: MutationCtx,
  m: {
    org_id: string
    recipient_id: string
    issue_id: string
    kind: MessageKind
    body: string
    actor_id: string | undefined
    now: string
    issue?: Doc<'issues'>
    project?: Doc<'projects'>
    recipient?: Doc<'profiles'>
    visibility?: NotifyPreload['visibility']
  },
): Promise<boolean> {
  if (m.actor_id !== undefined && m.recipient_id === m.actor_id) return false
  const recipient = m.recipient ?? (await byId(ctx, 'profiles', m.recipient_id))
  if (recipient === null || recipient.org_id !== m.org_id) return false
  const issue = m.issue ?? (await byId(ctx, 'issues', m.issue_id))
  if (issue === null) return false
  const project = m.project ?? (await byId(ctx, 'projects', issue.project_id))
  if (project === null) return false
  if (!(await recipientCanSee(ctx, recipient, project, m.visibility))) return false
  await ctx.db.insert('messages', {
    id: newUuid(),
    org_id: m.org_id,
    recipient_id: m.recipient_id,
    actor_id: m.actor_id,
    issue_id: m.issue_id,
    issue_title: issue.title,
    kind: m.kind,
    detail: m.body,
    created_at: m.now,
  })
  const pair = { recipient_id: m.recipient_id, issue_id: m.issue_id }
  const rows = await pairRows(ctx, pair)
  // News wakes a snoozed item: the arrival is the news, so the older rows
  // only drop the snooze (no woke_at — the new row's created_at floats and
  // announces the item), and the scheduled wake later finds nothing to do.
  for (const r of rows) {
    if (r.snoozed_until !== undefined) await ctx.db.patch(r._id, { snoozed_until: undefined })
  }
  await pruneReadMessages(ctx, pair, rows)
  return true
}

/* --------------------------------------------------------------- subscribe
 * subscribe_to_issue (0114:134-149): same fence as postMessage (org +
 * visibility — a subscription row decides who gets messages, so it must not
 * be creatable for someone who could not have received them), idempotent.
 * `visibility` is a seed's memo (NotifyPreload), never passed interactively. */
export async function subscribeToIssue(
  ctx: MutationCtx,
  a: {
    issue_id: string
    profile: Doc<'profiles'>
    org_id: string
    project: Doc<'projects'> | null
    now: string
    visibility?: NotifyPreload['visibility']
  },
): Promise<void> {
  if (a.profile.org_id !== a.org_id) return
  if (a.project === null) return
  if (!(await recipientCanSee(ctx, a.profile, a.project, a.visibility))) return
  const existing = await ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue_profile', (q) =>
      q.eq('issue_id', a.issue_id).eq('profile_id', a.profile.id),
    )
    .unique()
  if (existing !== null) return
  await ctx.db.insert('issue_subscriptions', {
    issue_id: a.issue_id,
    profile_id: a.profile.id,
    created_at: a.now,
  })
}

/* ---------------------------------------------------------------- mentions
 * extract_mentions (0075:34-49 — the survey quotes 0074's obsolete regex).
 * Code contexts are stripped first (the dialect renders them literally):
 * ``` fences to the closer or EOF, then single-line backtick spans. Then
 * `@[label](user:uuid)` — case-INSENSITIVE (USER: matches, uppercase hex
 * folds), label charset [^][]* (no brackets), dest padding by spaces/tabs.
 * A plain [x](user:...) link is NOT a mention. Distinct uuids, mapped onto
 * the supplied profile list (callers pass the org's profiles — active or
 * not, the SQL org fence never filtered on active); unknown uuids drop. */
const FENCE_RE = /```[\s\S]*?(```|$)/g
const SPAN_RE = /`[^`\n]*`/g
const MENTION_RE =
  /@\[[^\][]*\]\([ \t]*user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})[ \t]*\)/gi

export function extractMentions(text: string, profiles: Doc<'profiles'>[]): Doc<'profiles'>[] {
  const stripped = (text ?? '').replace(FENCE_RE, ' ').replace(SPAN_RE, ' ')
  const seen = new Set<string>()
  const out: Doc<'profiles'>[] = []
  for (const match of stripped.matchAll(MENTION_RE)) {
    const uuid = match[1].toLowerCase()
    if (seen.has(uuid)) continue
    seen.add(uuid)
    const profile = profiles.find((p) => p.id === uuid)
    if (profile !== undefined) out.push(profile)
  }
  return out
}

const orgProfilesOf = (ctx: MutationCtx, orgId: string): Promise<Doc<'profiles'>[]> =>
  ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()

const subscribersOf = (ctx: MutationCtx, issueId: string): Promise<Doc<'issue_subscriptions'>[]> =>
  ctx.db
    .query('issue_subscriptions')
    .withIndex('by_issue', (q) => q.eq('issue_id', issueId))
    .collect()

/* ---------------------------------------------------------- notify: insert
 * notify_issue_insert (0114:167-194): mentions subscribe + hear about it;
 * an assignee subscribes and — unless they are the actor or already
 * mentioned — reads 'Assigned to you'. A task created In Review with a
 * reviewer is the reviewer's, so the reviewer subscribes too and, on the
 * same terms, reads 'Ready for your review' (an assignee who is also the
 * reviewer reads only 'Assigned to you'). No subscriber fan-out: a task one
 * statement old has no other subscribers by construction. */
export async function notifyIssueInsert(
  ctx: MutationCtx,
  a: {
    issue: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
    preload?: NotifyPreload
    skipTaskEvent?: boolean
  },
): Promise<void> {
  const { issue, actor, now, preload } = a
  if (!a.skipTaskEvent) await emitTaskEvent(ctx, { name: 'task.created', issue, actor, now })
  const project =
    preload?.projects.get(issue.project_id) ?? (await byId(ctx, 'projects', issue.project_id))
  const orgProfiles = preload?.orgProfiles ?? (await orgProfilesOf(ctx, issue.org_id))
  const visibility = preload?.visibility
  const mentioned = extractMentions(issue.description, orgProfiles)
  for (const m of mentioned) {
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: m,
      org_id: issue.org_id,
      project,
      now,
      visibility,
    })
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: 'Mentioned you in the description',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: m,
      visibility,
    })
  }
  if (issue.assignee_id !== undefined) {
    const assignee = orgProfiles.find((p) => p.id === issue.assignee_id)
    // a missing profile is skipped (the org fence would drop both writes),
    // but the reviewer below still hears about the task
    if (assignee !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        profile: assignee,
        org_id: issue.org_id,
        project,
        now,
        visibility,
      })
      if (assignee.id !== actor.id && !mentioned.some((p) => p.id === assignee.id)) {
        await postMessage(ctx, {
          org_id: issue.org_id,
          recipient_id: assignee.id,
          issue_id: issue.id,
          kind: 'change',
          body: 'Assigned to you',
          actor_id: actor.id,
          now,
          issue,
          project: project ?? undefined,
          recipient: assignee,
          visibility,
        })
      }
    }
  }
  // a task created In Review is the reviewer's: they follow it and hear so
  if (reviewerOwns(issue) && issue.reviewer_id !== issue.assignee_id) {
    const reviewer = orgProfiles.find((p) => p.id === issue.reviewer_id)
    if (reviewer !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: issue.id,
        profile: reviewer,
        org_id: issue.org_id,
        project,
        now,
        visibility,
      })
      if (reviewer.id !== actor.id && !mentioned.some((p) => p.id === reviewer.id)) {
        await postMessage(ctx, {
          org_id: issue.org_id,
          recipient_id: reviewer.id,
          issue_id: issue.id,
          kind: 'change',
          body: REVIEW_READY,
          actor_id: actor.id,
          now,
          issue,
          project: project ?? undefined,
          recipient: reviewer,
          visibility,
        })
      }
    }
  }
}

/* ---------------------------------------------------------- notify: update
 * notify_issue_update (0114:196-352). Diffs ONLY the trigger's column list;
 * a write that changes nothing in it must not post. Callers hand the STORED
 * before/after rows — for the envelope-widen and remaining-clear side-effect
 * writes too (0075 fix 4: "dates moving on YOUR issue is real news").
 *
 * `suppressNotify` replaces pg_trigger_depth() <= 1: the archive cascade
 * passes it for cascade-written descendant/ancestor rows, and it suppresses
 * ONLY the Archived/Restored narration line — one archive click is one
 * message (the root's) per subscriber. It sits upstream of the fan-out, so
 * it cannot multiply per subscriber, and it does not silence the nightly
 * sweep (each sweep write is its own statement).
 *
 * Ownership (#314): when the task passes to someone else (lib/review.ts's
 * taskOwnerId), the new owner starts following it. A reviewer handed the
 * task reads 'Ready for your review' after any assignment line and before
 * the change parts; both lines are said from the reader's side.
 *
 * `isGroup` marks a task with active subtasks, which always stays with its
 * assignee, so no write hands it over. The writers that can clear a group's
 * dormant reviewer (updateIssueCore, moveIssueCore) pass it; every other
 * caller changes neither the status nor the reviewer. */
export async function notifyIssueUpdate(
  ctx: MutationCtx,
  a: {
    before: Doc<'issues'>
    after: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
    suppressNotify?: boolean
    skipTaskEvent?: boolean
    isGroup?: boolean
  },
): Promise<void> {
  const { before, after, actor, now } = a
  if (!a.skipTaskEvent)
    await emitTaskEvent(ctx, { name: 'task.updated', issue: after, before, actor, now })
  const isGroup = a.isGroup === true
  const project = await byId(ctx, 'projects', after.project_id)
  const orgProfiles = await orgProfilesOf(ctx, after.org_id)

  // @mentions newly added to the description notify regardless of
  // subscribers, and subscribe the person to what they were pulled into
  const oldMentions = extractMentions(before.description, orgProfiles)
  const newMentions = extractMentions(after.description, orgProfiles).filter(
    (p) => !oldMentions.some((o) => o.id === p.id),
  )
  for (const m of newMentions) {
    await subscribeToIssue(ctx, {
      issue_id: after.id,
      profile: m,
      org_id: after.org_id,
      project,
      now,
    })
    await postMessage(ctx, {
      org_id: after.org_id,
      recipient_id: m.id,
      issue_id: after.id,
      kind: 'mention',
      body: 'Mentioned you in the description',
      actor_id: actor.id,
      now,
      issue: after,
      project: project ?? undefined,
      recipient: m,
    })
  }

  // a new assignee starts following; the old one keeps following — being
  // taken off a task is news you want (0114:228-229)
  if (after.assignee_id !== before.assignee_id && after.assignee_id !== undefined) {
    const assignee = orgProfiles.find((p) => p.id === after.assignee_id)
    if (assignee !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: after.id,
        profile: assignee,
        org_id: after.org_id,
        project,
        now,
      })
    }
  }

  // whoever the task passes to starts following it: the reviewer when it
  // enters Review or is handed over in Review, the assignee when it leaves
  // Review (#314). A reviewer set outside Review owns nothing yet.
  const ownerAfter = taskOwnerId(after, isGroup)
  if (ownerAfter !== undefined && ownerAfter !== taskOwnerId(before, isGroup)) {
    const owner = orgProfiles.find((p) => p.id === ownerAfter)
    if (owner !== undefined) {
      await subscribeToIssue(ctx, {
        issue_id: after.id,
        profile: owner,
        org_id: after.org_id,
        project,
        now,
      })
    }
  }
  // the reviewer was handed the task in this write, not merely kept
  const handedToReviewer =
    reviewerOwns(after, isGroup) &&
    !(reviewerOwns(before, isGroup) && before.reviewer_id === after.reviewer_id)

  // the cheap exit: with nobody following, there is nothing to narrate for
  const subs = await subscribersOf(ctx, after.id)
  if (subs.length === 0) return

  // narrate what changed (from → to, mirroring the activity feed's rule)
  const parts: string[] = []
  if (after.status !== before.status) {
    parts.push(`Status: ${STATUS_NAMES[before.status]} → ${STATUS_NAMES[after.status]}`)
  }
  if (after.priority !== before.priority) {
    parts.push(`Priority: ${PRIORITY_NAMES[before.priority]} → ${PRIORITY_NAMES[after.priority]}`)
  }
  if (after.title !== before.title) {
    parts.push(`Title: “${before.title}” → “${after.title}”`)
  }
  if (after.description !== before.description) {
    parts.push('Description updated')
  }
  if (after.due_date !== before.due_date) {
    const od = before.due_date
    const nd = after.due_date
    if (od === undefined && nd !== undefined) parts.push(`Due set to ${fmtDayMon(nd)}`)
    else if (nd === undefined && od !== undefined) parts.push(`Due cleared (was ${fmtDayMon(od)})`)
    else if (od !== undefined && nd !== undefined) {
      parts.push(`Due: ${fmtDayMon(od)} → ${fmtDayMon(nd)}`)
    }
  }
  if (after.start_week !== before.start_week || after.end_week !== before.end_week) {
    // half-null pairs cannot exist under the both-or-neither CHECK, but each
    // side still renders '…' for a missing half, like the SQL's coalesce
    const sched = (s: string | undefined, e: string | undefined): string | undefined =>
      s === undefined && e === undefined
        ? undefined
        : `${s === undefined ? '…' : fmtDayMon(s)} – ${e === undefined ? '…' : fmtDayMon(e)}`
    const oldSched = sched(before.start_week, before.end_week)
    const newSched = sched(after.start_week, after.end_week)
    if (oldSched === undefined && newSched !== undefined) parts.push(`Scheduled ${newSched}`)
    else if (newSched === undefined && oldSched !== undefined) {
      parts.push(`Unscheduled (was ${oldSched})`)
    } else if (oldSched !== undefined && newSched !== undefined) {
      parts.push(`Schedule: ${oldSched} → ${newSched}`)
    }
  }
  if (after.remaining_hours !== before.remaining_hours) {
    const oh = before.remaining_hours
    const nh = after.remaining_hours
    if (oh === undefined && nh !== undefined) parts.push(`Remaining set to ${fmtHours(nh)} h`)
    else if (nh === undefined && oh !== undefined) {
      parts.push(`Remaining cleared (was ${fmtHours(oh)} h)`)
    } else if (oh !== undefined && nh !== undefined) {
      parts.push(`Remaining: ${fmtHours(oh)} h → ${fmtHours(nh)} h`)
    }
  }
  if (after.paused !== before.paused) parts.push(after.paused ? 'Paused' : 'Resumed')
  if (after.project_id !== before.project_id) {
    parts.push(`Moved to ${project?.name ?? 'another project'}`)
  }
  let parentProjectId: string | undefined
  let parentProject: Doc<'projects'> | null = null
  let parentKey: string | undefined
  if (after.parent_id !== before.parent_id) {
    if (after.parent_id === undefined) {
      parts.push('Detached from its parent')
    } else {
      const parent = await byId(ctx, 'issues', after.parent_id)
      if (parent !== null) {
        parentProjectId = parent.project_id
        parentProject = await byId(ctx, 'projects', parent.project_id)
        parentKey = `QN-${parent.num}`
      }
      parts.push(ATTACH_SLOT)
    }
  }
  if (after.archived_at !== before.archived_at && a.suppressNotify !== true) {
    parts.push(after.archived_at !== undefined ? 'Archived' : 'Restored')
  }

  // the assignment line, said from the reader's side at fan-out
  let assignedLine: string | undefined
  if (after.assignee_id !== before.assignee_id) {
    if (after.assignee_id === undefined) {
      const oldName =
        before.assignee_id === undefined
          ? undefined
          : orgProfiles.find((p) => p.id === before.assignee_id)?.name
      assignedLine = `Unassigned (was ${oldName ?? 'someone'})`
    } else {
      const newName = orgProfiles.find((p) => p.id === after.assignee_id)?.name
      assignedLine = `Assigned to ${newName ?? 'someone'}`
    }
  }
  // the reviewer line, likewise; the reviewer's own copy is chosen per reader
  let reviewerLine: string | undefined
  if (after.reviewer_id !== before.reviewer_id) {
    if (after.reviewer_id === undefined) {
      const oldName =
        before.reviewer_id === undefined
          ? undefined
          : orgProfiles.find((p) => p.id === before.reviewer_id)?.name
      reviewerLine = `Reviewer removed (was ${oldName ?? 'someone'})`
    } else {
      const newName = orgProfiles.find((p) => p.id === after.reviewer_id)?.name
      reviewerLine = `Reviewer set to ${newName ?? 'someone'}`
    }
  }

  if (parts.length === 0 && assignedLine === undefined && reviewerLine === undefined) return

  // one message per follower. postMessage drops the actor's own copy, anyone
  // who has left the org, and anyone who can no longer see the project.
  for (const s of subs) {
    const recipient = orgProfiles.find((p) => p.id === s.profile_id)
    let mine = [...parts]
    if (newMentions.some((m) => m.id === s.profile_id)) {
      // a fresh mention supersedes the bare description line — they will
      // read it in the message view
      mine = mine.filter((x) => x !== 'Description updated')
    }
    if (parentProjectId !== undefined) {
      const canSee =
        recipient !== undefined &&
        parentProject !== null &&
        (await profileCanSeeProject(ctx, recipient, parentProject))
      // Keep the hidden parent anonymous while using the same task wording
      // as the inbox and the machine surfaces.
      mine = mine.map((x) =>
        x === ATTACH_SLOT
          ? `Attached under ${canSee ? parentKey : 'a task in another project'}`
          : x,
      )
    } else {
      mine = mine.filter((x) => x !== ATTACH_SLOT)
    }
    // unshifted before the assignment line, so it reads second
    let reviewLine = reviewerLine
    if (s.profile_id === after.reviewer_id) {
      if (handedToReviewer) reviewLine = REVIEW_READY
      else if (reviewerLine !== undefined) reviewLine = 'Reviewer set to you'
    }
    if (reviewLine !== undefined) mine.unshift(reviewLine)
    if (assignedLine !== undefined) {
      mine.unshift(s.profile_id === after.assignee_id ? 'Assigned to you' : assignedLine)
    }
    if (mine.length === 0) continue
    await postMessage(ctx, {
      org_id: after.org_id,
      recipient_id: s.profile_id,
      issue_id: after.id,
      kind: 'change',
      body: mine.join('. '),
      actor_id: actor.id,
      now,
      issue: after,
      project: project ?? undefined,
      recipient,
    })
  }
}

/* --------------------------------------------------------- notify: comment
 * notify_comment_insert (0114:354-382): mentions subscribe + hear about it;
 * the author subscribes (saying something is the clearest statement that you
 * want to hear the reply); every subscriber EXCEPT the mentioned reads
 * 'New comment'. `actor` is the comment's author; of the comment itself
 * only the body is read. */
export async function notifyCommentInsert(
  ctx: MutationCtx,
  a: {
    comment: Pick<Doc<'comments'>, 'body'>
    issue: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
    preload?: NotifyPreload
    skipTaskEvent?: boolean
  },
): Promise<void> {
  const { comment, issue, actor, now, preload } = a
  if (!a.skipTaskEvent) await emitTaskEvent(ctx, { name: 'comment.created', issue, actor, now })
  const project =
    preload?.projects.get(issue.project_id) ?? (await byId(ctx, 'projects', issue.project_id))
  const orgProfiles = preload?.orgProfiles ?? (await orgProfilesOf(ctx, issue.org_id))
  const visibility = preload?.visibility
  const mentioned = extractMentions(comment.body, orgProfiles)
  for (const m of mentioned) {
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: m,
      org_id: issue.org_id,
      project,
      now,
      visibility,
    })
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: 'Mentioned you in a comment',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: m,
      visibility,
    })
  }
  await subscribeToIssue(ctx, {
    issue_id: issue.id,
    profile: actor,
    org_id: issue.org_id,
    project,
    now,
    visibility,
  })
  const subs = await subscribersOf(ctx, issue.id)
  for (const s of subs) {
    if (mentioned.some((m) => m.id === s.profile_id)) continue
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: s.profile_id,
      issue_id: issue.id,
      kind: 'comment',
      body: 'New comment',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: orgProfiles.find((p) => p.id === s.profile_id),
      visibility,
    })
  }
}

/* notify_comment_update (0114:384-403): only when the body changed; mentions
 * ADDED by the edit subscribe + hear about it. `actor` is the caller's
 * resolution of coalesce(edited_by, author). Phase 5's comments.update
 * composes this. */
export async function notifyCommentUpdate(
  ctx: MutationCtx,
  a: {
    before: Doc<'comments'>
    after: Doc<'comments'>
    issue: Doc<'issues'>
    actor: Doc<'profiles'>
    now: string
  },
): Promise<void> {
  const { before, after, issue, actor, now } = a
  if (after.body === before.body) return
  const project = await byId(ctx, 'projects', issue.project_id)
  const orgProfiles = await orgProfilesOf(ctx, issue.org_id)
  const oldMentions = extractMentions(before.body, orgProfiles)
  const added = extractMentions(after.body, orgProfiles).filter(
    (p) => !oldMentions.some((o) => o.id === p.id),
  )
  for (const m of added) {
    await subscribeToIssue(ctx, {
      issue_id: issue.id,
      profile: m,
      org_id: issue.org_id,
      project,
      now,
    })
    await postMessage(ctx, {
      org_id: issue.org_id,
      recipient_id: m.id,
      issue_id: issue.id,
      kind: 'mention',
      body: 'Mentioned you in a comment',
      actor_id: actor.id,
      now,
      issue,
      project: project ?? undefined,
      recipient: m,
    })
  }
}
