/* One Northstar record writer for private marketing and isolated public demos.
 * Auth and lifecycle ownership stay with the callers. No registered functions. */
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import {
  DEMO_EVENT_TIME,
  DEMO_SYNC_TIME,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingDate,
  marketingId,
  marketingInstant,
  marketingWeek,
} from '../internal/marketingDemoData'
import { byId } from '../lib/db'
import { require, rule } from '../lib/functions'
import { type NotifyPreload, notifyCommentInsert, notifyIssueInsert } from './messages'
import { assertSlugAvailable, newOrgDefaults, newTeamDefaults } from './orgs'
import { projectDescription } from './projects'

export const SAMPLE_AVATARS = [
  'nora',
  'leo',
  'aisha',
  'emil',
  'sofia',
  'daniel',
  'ben',
  'atlas',
] as const
export type SampleAvatar = (typeof SAMPLE_AVATARS)[number]

/** The current UTC Monday, independent of the visitor's clock or timezone. */
export function demoMonday(now: number): string {
  const day = new Date(now)
  day.setUTCHours(0, 0, 0, 0)
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

export async function writeNorthstarWork(
  ctx: MutationCtx,
  {
    org,
    profiles,
    namespace,
    anchor,
    now,
  }: {
    org: Doc<'organizations'>
    profiles: Doc<'profiles'>[]
    namespace: string
    anchor: string
    now: string
  },
): Promise<void> {
  const id = (key: string) => marketingId(namespace, key)
  const data = MARKETING_DEMO
  const personIds = Object.fromEntries(
    await Promise.all(data.people.map(async (p) => [p.key, await id(`person:${p.key}`)])),
  )
  const projectIds = Object.fromEntries(
    await Promise.all(data.projects.map(async (p) => [p.key, await id(`project:${p.key}`)])),
  )
  const issueIds = Object.fromEntries(
    await Promise.all(data.issues.map(async (i) => [i.key, await id(`issue:${i.key}`)])),
  )
  const labelIds = Object.fromEntries(
    await Promise.all(data.labels.map(async (l) => [l.key, await id(`label:${l.key}`)])),
  )
  const teamIds = Object.fromEntries(
    await Promise.all(data.teams.map(async (team) => [team.key, await id(`team:${team.key}`)])),
  )
  const teamDefaults = newTeamDefaults(now)
  const orgDefaults = newOrgDefaults(org.created_at)
  await ctx.db.patch(org._id, {
    name: data.organization.name,
    ...orgDefaults,
    gravatar_avatars: false,
    next_issue_num: data.issues.length,
    activity_count: data.issues.length,
    next_project_num: data.projects.length,
  })
  for (const team of data.teams) {
    await ctx.db.insert('teams', {
      id: teamIds[team.key],
      org_id: org.id,
      name: team.name,
      icon: team.icon,
      icon_color: team.color,
      ...teamDefaults,
    })
    for (const member of team.members)
      await ctx.db.insert('team_members', {
        team_id: teamIds[team.key],
        profile_id: personIds[member],
        is_leader: member === team.lead,
      })
  }
  for (const p of data.people) {
    const profile = profiles.find((pr) => pr.id === personIds[p.key])
    require(profile !== undefined, rule('marketing demo: owned profile missing'))
    await ctx.db.patch(profile._id, {
      name: p.name,
      initials: p.initials,
      color: p.color,
      org_role: p.role,
      active: true,
      plannable_hours: p.kind === 'person' ? orgDefaults.default_plannable_hours : undefined,
      message_retention_days: p.kind === 'person' ? 7 : undefined,
      // A wipe keeps profiles, so set or clear the Team sync stamp every time:
      // a reset must not keep stamps from interactive use.
      sync_at:
        p.syncDay === undefined ? undefined : marketingInstant(anchor, p.syncDay, DEMO_SYNC_TIME),
      sync_since: undefined,
    })
  }
  // The notify fan-outs read roles, so they get the profiles as patched.
  const orgProfiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  for (const [index, p] of data.projects.entries()) {
    await ctx.db.insert('projects', {
      id: projectIds[p.key],
      org_id: org.id,
      type: p.parent ? 'project' : 'meta',
      ...(p.parent ? { parent_id: projectIds[p.parent] } : { icon: p.icon, icon_color: p.color }),
      key: p.code,
      name: p.name,
      description: projectDescription(p.description),
      lead_id: personIds[p.lead],
      sort_order: index,
      num: index + 1,
      track_delay: teamDefaults.track_delay_default,
      created_at: now,
    })
    if (!p.parent)
      for (const team of data.teams)
        await ctx.db.insert('project_team_access', {
          project_id: projectIds[p.key],
          team_id: teamIds[team.key],
          level: team.key === p.team ? 'user' : 'viewer',
        })
  }
  // Nothing below writes teams, grants, roles or projects, so one visibility
  // memo can serve every notification this seed writes.
  const preload: NotifyPreload = {
    orgProfiles,
    projects: new Map(
      (
        await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .collect()
      ).map((project) => [project.id, project]),
    ),
    visibility: new Map(),
  }
  const atlas = orgProfiles.find((p) => p.id === personIds.atlas)
  require(atlas !== undefined, rule('marketing demo: import actor missing'))
  for (const l of data.labels)
    await ctx.db.insert('labels', {
      id: labelIds[l.key],
      org_id: org.id,
      name: l.name,
      name_lower: l.name.toLowerCase(),
      color: l.color,
      created_at: now,
    })
  // Tasks as inserted, for the comment loop; nothing below patches them.
  const issueDocs = new Map<string, Doc<'issues'>>()
  for (const [index, i] of data.issues.entries()) {
    const created = `${marketingDate(anchor, -21)}T09:00:00.000Z`
    // A dated last write (updated_at and the import event) lets Team sync
    // read the task as untouched, or its review as waiting, since a sync.
    const touched =
      i.touchedDay === undefined ? now : marketingInstant(anchor, i.touchedDay, DEMO_EVENT_TIME)
    // These are explicitly imported fixtures. Atlas is the import actor;
    // reporter is separate attribution, never a forged creator history.
    const issueDocId = await ctx.db.insert('issues', {
      id: issueIds[i.key],
      org_id: org.id,
      project_id: projectIds[i.project],
      num: index + 1,
      title: i.title,
      description: i.description,
      status: i.status,
      priority: i.priority,
      assignee_id: i.assignee ? personIds[i.assignee] : undefined,
      reviewer_id: i.reviewer ? personIds[i.reviewer] : undefined,
      reporter_id:
        personIds[
          i.reporter ??
            data.projects.find(
              (project) =>
                project.key ===
                (data.projects.find((p) => p.key === i.project)?.parent ?? i.project),
            )?.lead ??
            'atlas'
        ],
      created_by: personIds.atlas,
      parent_id: i.parent ? issueIds[i.parent] : undefined,
      start_week: i.startWeek !== undefined ? marketingWeek(anchor, i.startWeek) : undefined,
      end_week: i.endWeek !== undefined ? marketingWeek(anchor, i.endWeek) : undefined,
      due_date: i.dueDay !== undefined ? marketingDate(anchor, i.dueDay) : undefined,
      remaining_hours: i.remaining,
      remaining_set_at: i.remaining !== undefined ? now : undefined,
      paused: i.paused ?? false,
      ...(i.status === 'done' ? { done_at: `${marketingDate(anchor, -3)}T15:00:00.000Z` } : {}),
      ...(i.reviewDay !== undefined
        ? { review_at: marketingInstant(anchor, i.reviewDay, DEMO_EVENT_TIME) }
        : {}),
      ...(i.archived ? { archived_at: `${marketingDate(anchor, -1)}T15:00:00.000Z` } : {}),
      created_at: created,
      updated_at: touched,
    })
    for (const label of i.labels)
      await ctx.db.insert('issue_labels', {
        org_id: org.id,
        issue_id: issueIds[i.key],
        label_id: labelIds[label],
      })
    await ctx.db.insert('activity_events', {
      id: await id(`activity:import:${i.key}`),
      org_id: org.id,
      actor_id: personIds.atlas,
      verb: 'created',
      target_type: 'issue',
      target_id: issueIds[i.key],
      label: i.title,
      detail: 'Imported from the fictional Northstar marketing dataset',
      project_id: projectIds[i.project],
      ts: touched,
    })
    const issue = await ctx.db.get(issueDocId)
    require(issue !== null, rule('marketing demo: task insert missing'))
    issueDocs.set(i.key, issue)
    await notifyIssueInsert(ctx, { issue, actor: atlas, now, preload, skipTaskEvent: true })
  }
  for (const l of data.links) {
    const pair = [issueIds[l.source], issueIds[l.target]].sort()
    await ctx.db.insert('issue_links', {
      org_id: org.id,
      id: await id(`link:${l.source}:${l.target}`),
      source_id: l.type === 'relates' ? pair[0] : issueIds[l.source],
      target_id: l.type === 'relates' ? pair[1] : issueIds[l.target],
      type: l.type,
      pair_key: pair.join(':'),
      created_at: now,
    })
  }
  for (const m of data.milestones)
    await ctx.db.insert('milestones', {
      id: await id(`milestone:${m.key}`),
      project_id: projectIds[m.project],
      name: m.name,
      week: marketingWeek(anchor, m.week),
      created_at: now,
    })
  const commentMinutes = new Map<string, number>()
  for (const c of [...data.comments].sort((a, b) => a.day - b.day)) {
    // Preserve fixture conversation order when two replies share a day.
    const dayKey = `${c.issue}:${c.day}`
    const minute = commentMinutes.get(dayKey) ?? 0
    commentMinutes.set(dayKey, minute + 1)
    const createdAt = new Date(
      Date.parse(`${marketingDate(anchor, c.day)}T14:00:00.000Z`) + minute * 60_000,
    ).toISOString()
    await ctx.db.insert('comments', {
      id: await id(`comment:${c.key}`),
      issue_id: issueIds[c.issue],
      author: personIds[c.author],
      body: c.body,
      created_at: createdAt,
    })
    const issue = issueDocs.get(c.issue)
    const actor = orgProfiles.find((p) => p.id === personIds[c.author])
    require(issue !== undefined && actor !== undefined, rule(
      'marketing demo: sample comment references missing',
    ))
    await notifyCommentInsert(ctx, {
      comment: { body: c.body },
      issue,
      actor,
      now: createdAt,
      preload,
      skipTaskEvent: true,
    })
  }
}

/** Called only by the authenticated demo provisioner, in its transaction.
 * Nora alone receives the visitor login; every other human is a fictional seat.
 * The receipt id namespaces every UUID, including otherwise identical links. */
export async function provisionPublicDemo(
  ctx: MutationCtx,
  receipt: Doc<'demo_sessions'>,
  authUser: { _id: string; email: string },
): Promise<{ org_id: string; anchor: string; seed_version: number }> {
  require(process.env.APP_MODE === 'demo', rule('Public demos are unavailable here'))
  require(receipt.auth_user_id === authUser._id &&
    receipt.status === 'unprovisioned' &&
    receipt.expires_at > Date.now() &&
    receipt.org_id === undefined, rule('This demo cannot be provisioned'))
  const namespace = `public-demo:${receipt.id}`
  const id = (key: string) => marketingId(namespace, key)
  const orgId = await id('org')
  const slug = `northstar-${receipt.id.replace(/-/g, '').slice(0, 24)}`
  const now = new Date().toISOString()
  const anchor = demoMonday(Date.now())
  await assertSlugAvailable(ctx, slug)
  require((await byId(ctx, 'organizations', orgId)) === null, rule(
    'Demo organization already exists',
  ))
  const docId = await ctx.db.insert('organizations', {
    id: orgId,
    name: MARKETING_DEMO.organization.name,
    slug,
    ...newOrgDefaults(now),
    gravatar_avatars: false,
    max_attachment_mb: 5,
  })
  const org = await ctx.db.get(docId)
  require(org !== null, rule('Demo organization could not be created'))
  const profiles: Doc<'profiles'>[] = []
  for (const person of MARKETING_DEMO.people) {
    const profileId = await ctx.db.insert('profiles', {
      id: await id(`person:${person.key}`),
      org_id: orgId,
      name: person.name,
      initials: person.initials,
      color: person.color,
      org_role: person.role,
      kind: person.kind,
      active: true,
      created_at: now,
      sample_avatar: person.key as SampleAvatar,
      ...(person.kind === 'person'
        ? {
            email:
              person.key === 'nora' ? authUser.email : `${person.key}.${receipt.id}@demo.invalid`,
            ...(person.key === 'nora' ? { auth_user_id: authUser._id, accepted_at: now } : {}),
            plannable_hours: org.default_plannable_hours,
            message_retention_days: 7,
          }
        : {}),
    })
    const profile = await ctx.db.get(profileId)
    require(profile !== null, rule('Demo profile could not be created'))
    profiles.push(profile)
  }
  await writeNorthstarWork(ctx, { org, profiles, namespace, anchor, now })
  // Shared writer preserves historical marketing defaults. Public uploads
  // have the tighter cap, independently enforced by their tracked receiver.
  await ctx.db.patch(docId, { max_attachment_mb: 5 })
  await ctx.db.insert('account_appearance', {
    auth_user_id: authUser._id,
    mode: 'blue',
    image_source: 'daily',
    revision: receipt.id,
    updated_at: now,
  })
  return { org_id: orgId, anchor, seed_version: MARKETING_DEMO_VERSION }
}
