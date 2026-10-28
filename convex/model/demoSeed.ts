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
import { projectSightForProfiles } from '../lib/access'
import { byId, newWindowKey } from '../lib/db'
import { demoRefusal } from '../lib/demo'
import { DEMO_UNAVAILABLE } from '../lib/demoRefusals'
import { require, rule } from '../lib/functions'
import { DEFAULT_MESSAGE_RETENTION_DAYS } from '../lib/limits'
import { named, nameKey } from '../lib/nameKey'
import { issueKey } from '../lib/taskRefs'
import { insertActivity, issueChanges, machineDetail } from './activity'
import { markArchivedTask } from './archiveMarks'
import { type CommentWrite, startCount, tallyComments } from './commentLimits'
import { insertTask } from './descriptions'
import { browserVerbDetail, cleanDescription } from './issues'
import {
  type NotifyPreload,
  notifyCommentInsert,
  notifyIssueInsert,
  profileCacheOf,
  type RecipientSight,
} from './messages'
import { assertWeekFree, cleanMilestoneName } from './milestones'
import {
  assertSlugAvailable,
  cleanOrgName,
  insertOrgRows,
  newOrgDefaults,
  newTeamDefaults,
  setCounters,
  tallyRows,
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
  /* Whether the notify preload reads who sees each sub-project up front
   * (notifyContext). Only the public demo's calls set it: each runs a few
   * steps whose notices ask about most sub-projects. Every other seed asks
   * person by person as each notice asks, which keeps a marketing step of
   * one call inside its read budget. */
  sightUpFront?: true
}

/** An empty NorthstarRun for the uuids of `namespace`. */
export async function newNorthstarRun(
  namespace: string,
  options: Pick<NorthstarRun, 'sightUpFront'> = {},
): Promise<NorthstarRun> {
  const data = MARKETING_DEMO
  return {
    ...options,
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

/* The run's notify context, read on first use. With sightUpFront, who sees
 * each sub-project, where every task lives, is read for everyone at once,
 * all projects together (lib/access.ts projectSightForProfiles), not person
 * by person as each notice asks, one read after another. */
async function notifyContext(ctx: MutationCtx, org: Doc<'organizations'>, run: NorthstarRun) {
  if (run.notify) return run.notify
  const [orgProfiles, projects] = await Promise.all([
    ctx.db
      .query('profiles')
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect(),
    ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('org_id', org.id))
      .collect(),
  ])
  const upFront = run.sightUpFront ? projects.filter((p) => p.parent_id !== undefined) : []
  const visibility: RecipientSight = new Map(
    await Promise.all(
      upFront.map(async (project) => {
        const all = Promise.resolve(await projectSightForProfiles(ctx, project))
        return [project.id, { alone: new Map<string, boolean>(), all }] as const
      }),
    ),
  )
  run.notify = {
    orgProfiles,
    preload: {
      profiles: profileCacheOf(orgProfiles),
      projects: new Map(projects.map((project) => [project.id, project])),
      visibility,
    },
  }
  return run.notify
}

/** Writes the whole Northstar work in this transaction, every step in
 * order, sharing one NorthstarRun. Only tests write it this way; the
 * marketing demo runs one step a call and the public demo a few
 * (writeNorthstarStep, PUBLIC_DEMO_CALLS). */
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
  // Reads the tasks of `keys` the run has not read yet, all at once rather
  // than one after another, as the step's loop would.
  const readTasks = async (keys: readonly string[]) => {
    await Promise.all([...new Set(keys)].filter((key) => !shared.tasks.has(key)).map(task))
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
    // A membership and a team share copy their person's or team's name key
    // (model/nameKeys.ts), here the keys of the names the loop below gives
    // the people. Seeding needs an organization without teams and projects
    // (holdsNoWork), so no other copy of a person's key is left to follow.
    const personKeys = new Map(data.people.map((p) => [p.key, nameKey(p.name)]))
    const teamKeys = new Map<string, string>()
    for (const team of data.teams) {
      const teamName = named(cleanTeamName(team.name))
      teamKeys.set(team.key, teamName.name_key)
      await ctx.db.insert('teams', {
        id: teamIds[team.key],
        org_id: org.id,
        ...teamName,
        ...teamDefaults,
      })
      for (const member of team.members)
        await ctx.db.insert('team_members', {
          team_id: teamIds[team.key],
          profile_id: personIds[member],
          is_leader: member === team.lead,
          name_key: personKeys.get(member),
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
        ...named(p.name),
        initials: p.initials,
        color: p.color,
        org_role: p.role,
        active: true,
        plannable_hours: p.kind === 'person' ? orgDefaults.default_plannable_hours : undefined,
        message_retention_days: p.kind === 'person' ? DEFAULT_MESSAGE_RETENTION_DAYS : undefined,
        // Nor may a reset keep a project-creation right granted in the demo.
        can_create_projects: undefined,
      })
    }
    for (const [index, p] of data.projects.entries()) {
      await ctx.db.insert('projects', {
        id: projectIds[p.key],
        window_key: newWindowKey(),
        org_id: org.id,
        type: p.parent ? 'project' : 'meta',
        parent_id: p.parent ? projectIds[p.parent] : undefined,
        key: p.code,
        ...named(cleanProjectName(p.name)),
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
            name_key: teamKeys.get(team.key),
          })
    }
    // one read of the counters for every project, not one per project
    await tallyRows(
      ctx,
      'projects',
      data.projects.map((_, index) => [null, { org_id: org.id, num: index + 1 }] as const),
    )
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
    const inserted: Doc<'issues'>[] = []
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
      const windowKey = newWindowKey()
      const issueDocId = await insertTask(ctx.db, {
        id: issueIds[i.key],
        window_key: windowKey,
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
      await startCount(ctx, { id: issueIds[i.key], org_id: org.id })
      for (const label of i.labels)
        await ctx.db.insert('issue_labels', {
          org_id: org.id,
          issue_id: issueIds[i.key],
          label_id: labelIds[label],
          task_key: windowKey,
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
      inserted.push(issue)
      shared.tasks.set(i.key, issue)
      await notifyIssueInsert(ctx, { issue, actor: atlas, now, preload, skipTaskEvent: true })
    }
    // one read of the counters for the step's tasks, not one per task
    await tallyRows(
      ctx,
      'issues',
      inserted.map((issue) => [null, issue] as const),
    )
    return
  }
  if (step.kind === 'history') {
    const changedAt = (c: { day: number; time: string }) => marketingInstant(anchor, c.day, c.time)
    await readTasks([
      ...data.links.flatMap((l) => [l.source, l.target]),
      ...data.history.flatMap((c) => (c.kind === 'link' ? [c.issue, c.target] : [c.issue])),
    ])
    for (const l of data.links) {
      // both ends must still be live, as a link to a removed task is no link
      const ends = [await task(l.source), await task(l.target)]
      const pair = [issueIds[l.source], issueIds[l.target]].sort()
      const sourceId = l.type === 'relates' ? pair[0] : issueIds[l.source]
      // a link the history adds dates from that change
      const added = data.history.find(
        (c) => c.kind === 'link' && c.issue === l.source && c.target === l.target,
      )
      await ctx.db.insert('issue_links', {
        org_id: org.id,
        id: await id(`link:${l.source}:${l.target}`),
        source_id: sourceId,
        task_key: ends.find((end) => end.id === sourceId)?.window_key,
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
    // the milestones' projects, as the run read them or else all at once
    const known = shared.notify?.preload.projects
    const projects = await Promise.all(
      data.milestones.map(
        async (m) =>
          known?.get(projectIds[m.project]) ?? (await byId(ctx, 'projects', projectIds[m.project])),
      ),
    )
    // The organization as it is now, whose first day of the week the setup
    // step reset. Between the calls of a seed the app can add a milestone,
    // which the weekly rule then holds to as to any other.
    const calendar = (await byId(ctx, 'organizations', org.id)) ?? org
    for (const [index, m] of data.milestones.entries()) {
      const project = projects[index]
      require(project !== null && project !== undefined, rule(SEED_ROW_MISSING.project))
      const week = marketingWeek(anchor, m.week)
      await assertWeekFree(ctx, { org: calendar, projectId: project.id, day: week })
      await ctx.db.insert('milestones', {
        id: await id(`milestone:${m.key}`),
        project_id: projectIds[m.project],
        name: cleanMilestoneName(m.name),
        week,
        created_at: now,
      })
    }
    return
  }
  if (step.kind === 'comments') {
    const { orgProfiles, preload } = await notifyContext(ctx, org, shared)
    const comments = NORTHSTAR_COMMENTS.slice(step.from, step.to)
    await readTasks(comments.map((c) => c.issue))
    const inserted: CommentWrite[] = []
    for (const c of comments) {
      const createdAt = new Date(
        Date.parse(`${marketingDate(anchor, c.day)}T14:00:00.000Z`) + c.minute * 60_000,
      ).toISOString()
      const commentDocId = await ctx.db.insert('comments', {
        id: await id(`comment:${c.key}`),
        issue_id: issueIds[c.issue],
        author: personIds[c.author],
        body: c.body,
        created_at: createdAt,
      })
      inserted.push([{ _id: commentDocId, issue_id: issueIds[c.issue] }, 1])
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
    await tallyComments(ctx, inserted)
    return
  }
  // The archived tasks' labels, links and follows carry the mark the archive
  // steps leave (model/archiveMarks.ts), as in an organization in use.
  await readTasks(data.issues.map((i) => i.key))
  for (const i of data.issues) {
    await markArchivedTask(ctx, await task(i.key), Number.POSITIVE_INFINITY)
  }
}

/** How many of NORTHSTAR_STEPS each call of a public demo runs, in order,
 * in one transaction that shares one NorthstarRun, so a call reads a row
 * that an earlier step of it read or wrote only once. The first call also
 * creates the organization and its people. Every call is a round trip, and
 * 27 calls of one step each took most of a start.
 *
 * Each call stays inside a third of Convex's limits for one mutation:
 * 1,365 index ranges, 10,666 documents read, 5,333 written, 5.3 MiB read
 * or written, and 333 ms of the function's own JavaScript (the limit does
 * not count database operations). In convex-test a call reads at most 513
 * ranges and 724 documents and writes at most 441. The hosted demo's steps
 * at v0.1.86, summed for each call (the worst of three starts, less 48 ms
 * for each step past the first), put a call's JavaScript at 48 ms plus
 * 0.38 to 0.45 ms per index range. Per document read it spreads from 0.26
 * to 0.45 ms, as the first calls write more for each document they read,
 * so the documents alone cannot bound it. convex/tests/demo.test.ts then
 * holds every call to 630 ranges, within 48 + 0.45 x 630 = 332 ms, and to
 * 900 documents read and 650 written, so that a call at those caps reads
 * at most 1.4 documents and writes at most 1.0 a range, inside the 0.9 to
 * 1.5 and 0.4 to 1.4 of the calls those costs come from. A call with fewer
 * ranges stays inside 332 ms too, as a document past those costs about
 * 0.13 ms read and 0.06 ms written (the slopes over the hosted steps). */
export const PUBLIC_DEMO_CALL_SIZES: readonly number[] = [5, 6, 6, 5, 4]

/** `steps` in calls of `sizes` steps each, in order, then each step past
 * them in a call of its own: a dataset that grows adds bounded calls
 * rather than steps no call runs. Sizes past the last step add nothing. */
export function stepCalls<Step>(
  steps: readonly Step[],
  sizes: readonly number[],
): readonly (readonly Step[])[] {
  const calls: Step[][] = []
  let from = 0
  for (const size of sizes) {
    if (from >= steps.length) break
    calls.push(steps.slice(from, from + size))
    from += size
  }
  for (const step of steps.slice(from)) calls.push([step])
  return calls
}

/** The work of each call of a public demo (PUBLIC_DEMO_CALL_SIZES). */
export const PUBLIC_DEMO_CALLS = stepCalls(NORTHSTAR_STEPS, PUBLIC_DEMO_CALL_SIZES)

/** The calls that build a public demo, one transaction each. */
export const PUBLIC_DEMO_STEPS = PUBLIC_DEMO_CALLS.length

/** A 32-bit FNV-1a hash of `text` in hex: a label for a step layout, not a
 * secret. */
export function layoutHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(16)
}

/** A fingerprint of the public demo's calls and its whole dataset. A
 * receipt stores it when provisioning starts, and a later call refuses when
 * it differs: a call number from another layout would write rows twice or
 * skip them, and a later call from an edited dataset would miss a renamed
 * key or mix two revisions of the data. */
export const PUBLIC_DEMO_LAYOUT = `${PUBLIC_DEMO_STEPS}:${layoutHash(
  JSON.stringify({
    version: MARKETING_DEMO_VERSION,
    calls: PUBLIC_DEMO_CALLS,
    data: MARKETING_DEMO,
  }),
)}`

/** How far a public demo's provisioning got: the next of PUBLIC_DEMO_STEPS
 * to run, or `done` once the receipt is ready. */
export type PublicDemoProgress = { done: false; step: number; steps: number } | { done: true }

/* Creates the public demo's organization, its people and the visitor's
 * appearance, and notes the organization, the anchor and the write time on
 * the receipt, for the first call of provisionPublicDemoStep. Answers what
 * the call's steps write for. */
async function createPublicDemoOrg(
  ctx: MutationCtx,
  receipt: Doc<'demo_sessions'>,
  authUser: { _id: string; email: string },
  namespace: string,
): Promise<NorthstarTarget> {
  require(receipt.org_id === undefined, rule('This demo cannot be provisioned'))
  const id = (key: string) => marketingId(namespace, key)
  const orgId = await id('org')
  const slug = `northstar-${receipt.id.replace(/-/g, '').slice(0, 24)}`
  const now = new Date().toISOString()
  const anchor = demoMonday(Date.now())
  const [, existing] = await Promise.all([
    assertSlugAvailable(ctx, slug),
    byId(ctx, 'organizations', orgId),
  ])
  require(existing === null, rule('Demo organization already exists'))
  const docId = await insertOrgRows(ctx, {
    id: orgId,
    name: cleanOrgName(MARKETING_DEMO.organization.name),
    slug,
    ...newOrgDefaults(now),
    max_attachment_mb: 5,
  })
  const org = await ctx.db.get(docId)
  require(org !== null, rule('Demo organization could not be created'))
  for (const person of MARKETING_DEMO.people)
    await ctx.db.insert('profiles', {
      id: await id(`person:${person.key}`),
      org_id: orgId,
      ...named(person.name),
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
  const profiles = await ctx.db
    .query('profiles')
    .withIndex('by_org', (q) => q.eq('org_id', orgId))
    .collect()
  await ctx.db.insert('account_appearance', {
    auth_user_id: authUser._id,
    mode: 'dark',
    image_source: 'daily',
    revision: receipt.id,
    updated_at: now,
  })
  await ctx.db.patch(receipt._id, {
    org_id: orgId,
    anchor,
    provision: { step: 0, now, layout: PUBLIC_DEMO_LAYOUT },
  })
  return { org, profiles, namespace, anchor, now }
}

/** Runs the receipt's next provisioning call (PUBLIC_DEMO_CALLS) and
 * records it on the receipt; the last call marks the receipt ready. Called
 * only by the authenticated demo provisioner, once per call. The first call
 * also creates the organization and its people, notes the organization on
 * the receipt so cleanup can remove a demo that stops halfway, and fixes
 * the anchor and the write time every later call uses. A call that does
 * not commit leaves its steps for the next call, and two calls at once
 * conflict on the receipt, so each step runs once. Nothing else writes the
 * organization meanwhile: every app function refuses a receipt that is not
 * ready. Nora alone receives the visitor login; every other human is a
 * fictional seat. The receipt id namespaces every UUID, including
 * otherwise identical links. */
export async function provisionPublicDemoStep(
  ctx: MutationCtx,
  receipt: Doc<'demo_sessions'>,
  authUser: { _id: string; email: string },
): Promise<PublicDemoProgress> {
  require(process.env.APP_MODE === 'demo', rule('Public demos are unavailable here'))
  require(receipt.auth_user_id === authUser._id &&
    receipt.status === 'unprovisioned' &&
    receipt.expires_at > Date.now(), rule('This demo cannot be provisioned'))
  const namespace = `public-demo:${receipt.id}`
  let step = 0
  let target: NorthstarTarget
  if (receipt.provision === undefined) {
    target = await createPublicDemoOrg(ctx, receipt, authUser, namespace)
  } else {
    const { now, layout } = receipt.provision
    step = receipt.provision.step
    const anchor = receipt.anchor
    // A deploy between two calls can change the calls. The visitor starts a
    // new demo, and cleanup removes this one at its deadline.
    if (
      layout !== PUBLIC_DEMO_LAYOUT ||
      PUBLIC_DEMO_CALLS[step] === undefined ||
      anchor === undefined
    )
      throw demoRefusal(DEMO_UNAVAILABLE.updated, 'demo_unavailable')
    const orgId = await marketingId(namespace, 'org')
    require(receipt.org_id === orgId, rule('This demo cannot be provisioned'))
    const [org, profiles] = await Promise.all([
      byId(ctx, 'organizations', orgId),
      ctx.db
        .query('profiles')
        .withIndex('by_org', (q) => q.eq('org_id', orgId))
        .collect(),
    ])
    require(org !== null, rule('This demo cannot be provisioned'))
    target = { org, profiles, namespace, anchor, now }
  }
  const run = await newNorthstarRun(namespace, { sightUpFront: true })
  for (const work of PUBLIC_DEMO_CALLS[step]) {
    await writeNorthstarStep(ctx, target, work, run)
    // The setup step writes the shared marketing defaults. Public uploads
    // keep the tighter cap, which their tracked receiver also enforces.
    if (work.kind === 'setup') await ctx.db.patch(target.org._id, { max_attachment_mb: 5 })
  }
  const next = step + 1
  if (next < PUBLIC_DEMO_STEPS) {
    await ctx.db.patch(receipt._id, {
      provision: { step: next, now: target.now, layout: PUBLIC_DEMO_LAYOUT },
    })
    return { done: false, step: next, steps: PUBLIC_DEMO_STEPS }
  }
  await ctx.db.patch(receipt._id, {
    status: 'ready',
    seed_version: MARKETING_DEMO_VERSION,
    provision: undefined,
  })
  return { done: true }
}
