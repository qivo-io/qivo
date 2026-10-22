/* One Northstar record writer for private marketing and isolated public demos.
 * Auth and lifecycle ownership stay with the callers. No registered functions. */
import type { Doc } from '../_generated/dataModel'
import type { MutationCtx } from '../_generated/server'
import {
  DEMO_SYNC_TIME,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingDate,
  marketingId,
  marketingInstant,
  marketingWeek,
  northstarTaskTimes,
} from '../internal/marketingDemoData'
import { byId } from '../lib/db'
import { require, rule } from '../lib/functions'
import { DEFAULT_MESSAGE_RETENTION_DAYS } from '../lib/limits'
import { issueKey } from '../lib/taskRefs'
import { insertActivity, issueChanges, machineDetail } from './activity'
import { markArchivedTask } from './archiveMarks'
import { browserVerbDetail, cleanDescription } from './issues'
import {
  type NotifyPreload,
  notifyCommentInsert,
  notifyIssueInsert,
  profileCacheOf,
} from './messages'
import { cleanMilestoneName } from './milestones'
import {
  assertSlugAvailable,
  cleanOrgName,
  insertOrgRows,
  newOrgDefaults,
  newTeamDefaults,
  setCounters,
} from './orgs'
import { cleanProjectName, projectDescription } from './projects'
import { deleteStamp, writeStamp } from './syncStamps'
import { cleanTeamName } from './teams'

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

/** One part of the Northstar work: the organization, teams, people,
 * projects and labels; tasks `from` to `to` (data order); the links, short
 * histories and milestones; comments `from` to `to` (NORTHSTAR_COMMENTS
 * order); or the archived tasks' marks. Each part reads what earlier parts
 * wrote, so they run in NORTHSTAR_STEPS order. */
export type NorthstarStep =
  | { kind: 'setup' }
  | { kind: 'tasks'; from: number; to: number }
  | { kind: 'history' }
  | { kind: 'comments'; from: number; to: number }
  | { kind: 'archive' }

/** The tasks and the comments one step writes at most. Measured on the
 * dataset, a task step writes at most 93 documents and a comment step
 * reads at most 268 and writes at most 57, each with at most 224 index
 * ranges; the whole work in one transaction wrote about 1,400 documents
 * and took up to 2 s on a loaded machine. convex/tests/marketingDemo.test.ts
 * holds every call to 300 index ranges, 350 documents read and 150 written,
 * so a step is a small part of Convex's 1 s mutation limit. */
export const NORTHSTAR_BATCH = { tasks: 15, comments: 15 }

/* The ranges [from, to) that cover `count` items, `size` at a time. */
const batches = (count: number, size: number) =>
  Array.from({ length: Math.ceil(count / size) }, (_, i) => ({
    from: i * size,
    to: Math.min(count, (i + 1) * size),
  }))

/** The fixture comments in the order they are written, oldest day first,
 * each with its minute after 14:00: replies on one task and day keep the
 * fixture's order a minute apart. */
export const NORTHSTAR_COMMENTS = (() => {
  const minutes = new Map<string, number>()
  return [...MARKETING_DEMO.comments]
    .sort((a, b) => a.day - b.day)
    .map((c) => {
      const dayKey = `${c.issue}:${c.day}`
      const minute = minutes.get(dayKey) ?? 0
      minutes.set(dayKey, minute + 1)
      return { ...c, minute }
    })
})()

/** Every part of the Northstar work, in the order they must run. */
export const NORTHSTAR_STEPS: readonly NorthstarStep[] = [
  { kind: 'setup' },
  ...batches(MARKETING_DEMO.issues.length, NORTHSTAR_BATCH.tasks).map(
    (range): NorthstarStep => ({ kind: 'tasks', ...range }),
  ),
  { kind: 'history' },
  ...batches(NORTHSTAR_COMMENTS.length, NORTHSTAR_BATCH.comments).map(
    (range): NorthstarStep => ({ kind: 'comments', ...range }),
  ),
  { kind: 'archive' },
]

/** What every Northstar step writes for: the organization and its
 * profiles as the caller read them, the uuid namespace, the Monday the dates
 * are arranged around, and the write time. Steps of one seed share `now`. */
export type NorthstarTarget = {
  org: Doc<'organizations'>
  profiles: Doc<'profiles'>[]
  namespace: string
  anchor: string
  now: string
}

/* The fixture keys of `items` mapped to their uuids in `namespace`. */
async function uuids(
  namespace: string,
  prefix: string,
  items: readonly { key: string }[],
): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      items.map(async (item) => [item.key, await marketingId(namespace, `${prefix}:${item.key}`)]),
    ),
  )
}

/** The refusals of a step that finds a row an earlier step wrote gone:
 * the app changed the demo between two calls of a seed. */
export const SEED_ROW_MISSING = {
  task: 'marketing demo: a seeded task is missing; use reset to replace it',
  project: 'marketing demo: a seeded project is missing; use reset to replace it',
  label: 'marketing demo: a seeded label is missing; use reset to replace it',
  parent: 'marketing demo: a seeded parent task moved to another project; use reset to replace it',
} as const

/** What the steps of one seed share: the fixture uuids, and the rows they
 * read or wrote, so a seed run in one transaction reads each only once
 * (writeNorthstarWork). A step run alone builds its own (newNorthstarRun)
 * and reads what it needs again. */
export type NorthstarRun = {
  ids: Record<'person' | 'project' | 'issue' | 'label' | 'team', Record<string, string>>
  /* The org's profiles and the one notify preload the task and comment
   * steps share, read after the setup step patched the roles they read; no
   * later step writes teams, grants, roles or projects. */
  notify?: { orgProfiles: Doc<'profiles'>[]; preload: NotifyPreload }
  /* The uuids of the org's labels. */
  labels?: Set<string>
  /* The seeded tasks by fixture key, as inserted or read. Nothing in the
   * seed patches a task before the archive marks. */
  tasks: Map<string, Doc<'issues'>>
}

/** An empty NorthstarRun for the uuids of `namespace`. */
export async function newNorthstarRun(namespace: string): Promise<NorthstarRun> {
  const data = MARKETING_DEMO
  return {
    ids: {
      person: await uuids(namespace, 'person', data.people),
      project: await uuids(namespace, 'project', data.projects),
      issue: await uuids(namespace, 'issue', data.issues),
      label: await uuids(namespace, 'label', data.labels),
      team: await uuids(namespace, 'team', data.teams),
    },
    tasks: new Map(),
  }
}

/* The run's notify context, read on first use. */
async function notifyContext(ctx: MutationCtx, org: Doc<'organizations'>, run: NorthstarRun) {
  if (run.notify) return run.notify
  const orgProfiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  const projects = await ctx.db
    .query('projects')
    .withIndex('by_org', (q) => q.eq('org_id', org.id))
    .collect()
  run.notify = {
    orgProfiles,
    preload: {
      profiles: profileCacheOf(orgProfiles),
      projects: new Map(projects.map((project) => [project.id, project])),
      visibility: new Map(),
    },
  }
  return run.notify
}

/** Writes the whole Northstar work in this transaction, every step in
 * order, sharing one NorthstarRun. The public demo provisions this way; the
 * marketing demo runs one step a call (writeNorthstarStep). */
export async function writeNorthstarWork(ctx: MutationCtx, target: NorthstarTarget): Promise<void> {
  const run = await newNorthstarRun(target.namespace)
  for (const step of NORTHSTAR_STEPS) await writeNorthstarStep(ctx, target, step, run)
}

/** Writes one step of the Northstar work (NorthstarStep). The steps before
 * it must have run, in this or earlier transactions, and nothing else may
 * have changed the organization's teams, grants, roles or projects since;
 * a step refuses (SEED_ROW_MISSING) when a task, project or label it builds
 * on is gone. `run` is shared by the steps of one transaction. */
export async function writeNorthstarStep(
  ctx: MutationCtx,
  { org, profiles, namespace, anchor, now }: NorthstarTarget,
  step: NorthstarStep,
  run?: NorthstarRun,
): Promise<void> {
  const shared = run ?? (await newNorthstarRun(namespace))
  const id = (key: string) => marketingId(namespace, key)
  const data = MARKETING_DEMO
  const {
    person: personIds,
    project: projectIds,
    issue: issueIds,
    label: labelIds,
    team: teamIds,
  } = shared.ids
  const teamDefaults = newTeamDefaults(now)
  // A task an earlier step inserted.
  const task = async (key: string) => {
    const known = shared.tasks.get(key)
    if (known) return known
    const issue = await byId(ctx, 'issues', issueIds[key])
    require(issue !== null, rule(SEED_ROW_MISSING.task))
    shared.tasks.set(key, issue)
    return issue
  }
  if (step.kind === 'setup') {
    const orgDefaults = newOrgDefaults(org.created_at)
    await ctx.db.patch(org._id, {
      name: data.organization.name,
      ...orgDefaults,
      // Not a default (missing means 'users'), so clear it by hand: a reset
      // must not keep the setting from interactive use.
      project_creators: undefined,
    })
    await setCounters(ctx, org, {
      next_issue_num: data.issues.length,
      next_project_num: data.projects.length,
    })
    for (const team of data.teams) {
      await ctx.db.insert('teams', {
        id: teamIds[team.key],
        org_id: org.id,
        name: cleanTeamName(team.name),
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
      // A wipe keeps profiles, so set or clear the Team sync stamp every time:
      // a reset must not keep stamps from interactive use.
      if (p.syncDay === undefined) await deleteStamp(ctx, profile.id)
      else
        await writeStamp(ctx, profile, {
          at: marketingInstant(anchor, p.syncDay, DEMO_SYNC_TIME),
        })
      await ctx.db.patch(profile._id, {
        name: p.name,
        initials: p.initials,
        color: p.color,
        org_role: p.role,
        active: true,
        plannable_hours: p.kind === 'person' ? orgDefaults.default_plannable_hours : undefined,
        message_retention_days: p.kind === 'person' ? DEFAULT_MESSAGE_RETENTION_DAYS : undefined,
        // The retired Team sync fields (schema.ts) stay clear; the stamp is
        // set above.
        sync_at: undefined,
        sync_since: undefined,
        // Nor may a reset keep a project-creation right granted in the demo.
        can_create_projects: undefined,
      })
    }
    for (const [index, p] of data.projects.entries()) {
      await ctx.db.insert('projects', {
        id: projectIds[p.key],
        org_id: org.id,
        type: p.parent ? 'project' : 'meta',
        parent_id: p.parent ? projectIds[p.parent] : undefined,
        key: p.code,
        name: cleanProjectName(p.name),
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
    for (const l of data.labels)
      await ctx.db.insert('labels', {
        id: labelIds[l.key],
        org_id: org.id,
        name: l.name,
        name_lower: l.name.toLowerCase(),
        color: l.color,
        created_at: now,
      })
    shared.labels = new Set(data.labels.map((l) => labelIds[l.key]))
    return
  }
  if (step.kind === 'tasks') {
    const { orgProfiles, preload } = await notifyContext(ctx, org, shared)
    const atlas = orgProfiles.find((p) => p.id === personIds.atlas)
    require(atlas !== undefined, rule('marketing demo: import actor missing'))
    // a label delete is final, so read which of the seeded labels are left
    shared.labels ??= new Set(
      (
        await ctx.db
          .query('labels')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .collect()
      ).map((label) => label.id),
    )
    const labels = shared.labels
    for (let index = step.from; index < step.to; index++) {
      const i = data.issues[index]
      // a project, label or parent task the app removed since it was
      // written refuses rather than gain tasks that point at nothing
      require(preload.projects.has(projectIds[i.project]), rule(SEED_ROW_MISSING.project))
      require(i.labels.every((label) => labels.has(labelIds[label])), rule(SEED_ROW_MISSING.label))
      if (i.parent) {
        // a parent the app moved since would hold a child its project refuses
        const parent = await task(i.parent)
        const home = data.issues.find((it) => it.key === i.parent)?.project
        require(home !== undefined && parent.project_id === projectIds[home], rule(
          SEED_ROW_MISSING.parent,
        ))
      }
      // A dated last write (updated_at) lets Team sync read the task as
      // untouched, or its review as waiting, since a sync.
      const times = northstarTaskTimes(anchor, now, i)
      // These are explicitly imported fixtures. Atlas is the import actor;
      // reporter is separate attribution, never a forged creator history.
      const issueDocId = await ctx.db.insert('issues', {
        id: issueIds[i.key],
        org_id: org.id,
        project_id: projectIds[i.project],
        num: index + 1,
        title: i.title,
        description: cleanDescription(i.description),
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
        done_at: times.done,
        review_at: times.review,
        status_at: times.status,
        ...(i.archived ? { archived_at: `${marketingDate(anchor, -1)}T15:00:00.000Z` } : {}),
        created_at: times.created,
        updated_at: times.updated,
      })
      for (const label of i.labels)
        await ctx.db.insert('issue_labels', {
          org_id: org.id,
          issue_id: issueIds[i.key],
          label_id: labelIds[label],
        })
      await insertActivity(
        ctx,
        {
          org_id: org.id,
          actor_id: personIds.atlas,
          verb: 'created',
          target_type: 'issue',
          target_id: issueIds[i.key],
          label: i.title,
          detail: 'Imported from the fictional Northstar marketing dataset',
          project_id: projectIds[i.project],
          ts: times.created,
          named_task_nums: [],
        },
        { id: await id(`activity:import:${i.key}`) },
      )
      const issue = await ctx.db.get(issueDocId)
      require(issue !== null, rule(SEED_ROW_MISSING.task))
      shared.tasks.set(i.key, issue)
      await notifyIssueInsert(ctx, { issue, actor: atlas, now, preload, skipTaskEvent: true })
    }
    return
  }
  if (step.kind === 'history') {
    const changedAt = (c: { day: number; time: string }) => marketingInstant(anchor, c.day, c.time)
    for (const l of data.links) {
      // both ends must still be live, as a link to a removed task is no link
      await task(l.source)
      await task(l.target)
      const pair = [issueIds[l.source], issueIds[l.target]].sort()
      // a link the history adds dates from that change
      const added = data.history.find(
        (c) => c.kind === 'link' && c.issue === l.source && c.target === l.target,
      )
      await ctx.db.insert('issue_links', {
        org_id: org.id,
        id: await id(`link:${l.source}:${l.target}`),
        source_id: l.type === 'relates' ? pair[0] : issueIds[l.source],
        target_id: l.type === 'relates' ? pair[1] : issueIds[l.target],
        type: l.type,
        pair_key: pair.join(':'),
        created_at: added ? changedAt(added) : now,
      })
    }
    // Each task's short history, after its import row and oldest first, so
    // insertion order follows ts. The words come from the app's own writers;
    // nothing else (notifications, follows, webhook events) is written for
    // these rows.
    for (const c of data.history) {
      const doc = await task(c.issue)
      let entry: { verb: string; detail: string | undefined; named: number[] }
      if (c.kind === 'status' && c.via === 'mcp') {
        // machine/shared.ts MCP_PROVENANCE; model code never imports machine code
        const diff = issueChanges({ ...doc, status: c.from }, { ...doc, status: c.to })
        entry = { verb: 'changed', detail: machineDetail(diff, 'via MCP'), named: [] }
      } else if (c.kind === 'status') {
        entry = await browserVerbDetail(ctx, {
          before: { ...doc, status: c.from },
          after: { ...doc, status: c.to },
          patch: { status: c.to },
        })
      } else if (c.kind === 'label') {
        const label = data.labels.find((l) => l.key === c.label)
        require(label !== undefined, rule('marketing demo: history label missing'))
        entry = { verb: 'labeled', detail: `“${label.name}”`, named: [] }
      } else {
        const target = await task(c.target)
        entry = { verb: 'linked', detail: `(blocks ${issueKey(target.num)})`, named: [target.num] }
      }
      await insertActivity(
        ctx,
        {
          org_id: org.id,
          actor_id: personIds[c.actor],
          verb: entry.verb,
          target_type: 'issue',
          target_id: doc.id,
          label: doc.title,
          detail: entry.detail,
          project_id: doc.project_id,
          ts: changedAt(c),
          named_task_nums: entry.named,
        },
        { id: await id(`activity:change:${c.key}`) },
      )
    }
    const projects = shared.notify?.preload.projects
    for (const m of data.milestones) {
      const project =
        projects?.get(projectIds[m.project]) ?? (await byId(ctx, 'projects', projectIds[m.project]))
      require(project !== null && project !== undefined, rule(SEED_ROW_MISSING.project))
      await ctx.db.insert('milestones', {
        id: await id(`milestone:${m.key}`),
        project_id: projectIds[m.project],
        name: cleanMilestoneName(m.name),
        week: marketingWeek(anchor, m.week),
        created_at: now,
      })
    }
    return
  }
  if (step.kind === 'comments') {
    const { orgProfiles, preload } = await notifyContext(ctx, org, shared)
    for (const c of NORTHSTAR_COMMENTS.slice(step.from, step.to)) {
      const createdAt = new Date(
        Date.parse(`${marketingDate(anchor, c.day)}T14:00:00.000Z`) + c.minute * 60_000,
      ).toISOString()
      await ctx.db.insert('comments', {
        id: await id(`comment:${c.key}`),
        issue_id: issueIds[c.issue],
        author: personIds[c.author],
        body: c.body,
        created_at: createdAt,
      })
      const issue = await task(c.issue)
      const actor = orgProfiles.find((p) => p.id === personIds[c.author])
      require(actor !== undefined, rule('marketing demo: sample comment references missing'))
      await notifyCommentInsert(ctx, {
        comment: { body: c.body },
        issue,
        actor,
        now: createdAt,
        preload,
        skipTaskEvent: true,
      })
    }
    return
  }
  // The archived tasks' labels, links and follows carry the mark the archive
  // steps leave (model/archiveMarks.ts), as in an organization in use.
  for (const i of data.issues) {
    await markArchivedTask(ctx, await task(i.key), Number.POSITIVE_INFINITY)
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
  const docId = await insertOrgRows(ctx, {
    id: orgId,
    name: cleanOrgName(MARKETING_DEMO.organization.name),
    slug,
    ...newOrgDefaults(now),
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
            message_retention_days: DEFAULT_MESSAGE_RETENTION_DAYS,
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
    mode: 'dark',
    image_source: 'daily',
    revision: receipt.id,
    updated_at: now,
  })
  return { org_id: orgId, anchor, seed_version: MARKETING_DEMO_VERSION }
}
