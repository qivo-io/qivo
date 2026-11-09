/* The task window's stand-in (store/taskWindowStandIn.setup.ts), which the
 * store tests' live double and the browser benchmark's server answer the
 * window's three reads with, held to the real reads
 * (convex/lib/taskWindow.ts) on convex-test: for every Northstar person
 * with a login and for a user, a guest, a Viewer and an admin of the small
 * fixture in each access shape, every task of the organization, active and
 * archived, by uuid and by its number bare and as a key, its links and its
 * attachments, a task of another organization and an unknown number. The
 * stand-in reads the person's published whole (convex/tests/helpers.setup.ts
 * wholeOf), whose tasks are the tests' tasks oracle's, with the
 * organization's archived tasks beside it as the server holds them
 * (`unheld`), so it answers only a task the person may open: a task the
 * person cannot see, a hidden parent and a hidden subtask leave nothing
 * of their contents in its answers. */

import { describe, expect, it } from 'vitest'
import { api } from '../../convex/_generated/api'
import type { Doc } from '../../convex/_generated/dataModel'
import { newWindowKey } from '../../convex/lib/db'
import { issueKey } from '../../convex/lib/taskRefs'
import { relationRow, taskFields } from '../../convex/lib/workspaceParts'
import { descriptionOf } from '../../convex/model/descriptions'
import { SHAPES } from '../../convex/tests/accessShapes.setup'
import {
  as,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantSeat,
  type T,
  uuid,
  wholeOf,
  withOrg,
} from '../../convex/tests/helpers.setup'
import { plantNorthstar } from '../../convex/tests/northstar.setup'
import type { Whole } from './guard/liveDouble.setup'
import { type TaskWindowRead, taskWindowStandIn } from './taskWindowStandIn.setup'

/** `person`'s published whole with the organization's archived tasks as
    the server holds them (`unheld`), and every task of the organization,
    active and archived. */
async function wholeWith(t: T, person: Doc<'profiles'>) {
  const snap = await wholeOf(t, person)
  if (snap === null) throw new Error(`${person.name} has no seat`)
  const tasks = await t.run((ctx) =>
    ctx.db
      .query('issues')
      .withIndex('by_org', (q) => q.eq('org_id', person.org_id))
      .collect(),
  )
  const archived = await t.run(async (ctx) => {
    const rows = []
    const labels = []
    for (const task of tasks.filter((row) => row.archived_at !== undefined)) {
      const kid = await ctx.db
        .query('issues')
        .withIndex('by_parent', (q) => q.eq('parent_id', task.id))
        .first()
      for (const label of await ctx.db
        .query('issue_labels')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .collect())
        labels.push(relationRow(label))
      rows.push({
        ...taskFields(task),
        description: await descriptionOf(ctx.db, task),
        has_subtasks: kid !== null,
        has_hidden_parent: false,
        has_hidden_subtasks: false,
      })
    }
    return { rows, labels }
  })
  // the archived tasks' label rows beside the active ones', as the server
  // holds them
  const whole = {
    ...snap,
    issueLabels: [...snap.issueLabels, ...archived.labels],
    unheld: { issues: archived.rows },
  } as unknown as Whole
  return { whole, tasks }
}

/* Each read of the window for `task` by `person`, through the server and
   through the stand-in, compared. Answers how many reads it compared. */
async function compareTask(
  t: T,
  person: Doc<'profiles'>,
  whole: Whole,
  task: Doc<'issues'>,
  every: boolean,
): Promise<number> {
  const caller = as(t, person)
  const org_id = person.org_id
  const asks: [TaskWindowRead, Record<string, string>][] = [
    ['taskWindow:task', { org_id, ref: task.id }],
    ['taskWindow:links', { org_id, issue_id: task.id }],
    ['taskWindow:attachments', { org_id, issue_id: task.id }],
  ]
  if (every)
    asks.push(
      ['taskWindow:task', { org_id, ref: String(task.num) }],
      ['taskWindow:task', { org_id, ref: issueKey(task.num).toLowerCase() }],
    )
  for (const [name, args] of asks) {
    const server =
      name === 'taskWindow:task'
        ? await caller.query(api.taskWindow.task, args as { org_id: string; ref: string })
        : name === 'taskWindow:links'
          ? await caller.query(api.taskWindow.links, args as { org_id: string; issue_id: string })
          : await caller.query(
              api.taskWindow.attachments,
              args as { org_id: string; issue_id: string },
            )
    expect(taskWindowStandIn(whole, name, args), `${person.name}, ${task.title}, ${name}`).toEqual(
      server,
    )
  }
  return asks.length
}

/** Compares every read of every task of `person`'s organization, a third
    of them also by number and key, and a task of another organization.
    Answers how many tasks `person` may open. */
async function compareAll(t: T, person: Doc<'profiles'>, foreign: Doc<'issues'>) {
  const { whole, tasks } = await wholeWith(t, person)
  for (const [i, task] of tasks.entries()) await compareTask(t, person, whole, task, i % 3 === 0)
  // another organization's task answers unavailable through both, by uuid
  // and by its number in the person's organization when none holds it
  await compareTask(t, person, whole, foreign, true)
  return whole.issues.length
}

/* A few tasks over withOrg's projects that the shapes tell apart: a group
   in FW with subtasks in FW and PCB and one in Skunkworks, a subtask in FW
   of a parent in Skunkworks, a link from FW to Skunkworks and one from FW
   to PCB, a label, two attachments and the subject's follow on the group,
   and an archived task in each sub-project. */
async function plantWork(t: T, f: OrgFixture, subject: Doc<'profiles'>) {
  const task = (project: Doc<'projects'>, extra: Partial<Doc<'issues'>> = {}) =>
    plantIssue(t, { org_id: f.org.id, project_id: project.id, ...extra })
  const group = await task(f.sub, { title: 'Bring up the board', remaining_hours: 4 })
  await task(f.sub, { title: 'Solder the headers', parent_id: group.id })
  const inPcb = await task(f.sub2, { title: 'Route the planes', parent_id: group.id })
  await task(f.hidden, { title: 'Secret probe', parent_id: group.id })
  const hiddenParent = await task(f.hidden, { title: 'Hidden parent' })
  await task(f.sub, { title: 'Orphan in FW', parent_id: hiddenParent.id })
  await task(f.sub, { title: 'Archived in FW', archived_at: NOW })
  await task(f.sub2, { title: 'Archived in PCB', archived_at: NOW })
  await t.run(async (ctx) => {
    for (const [target, type] of [
      [hiddenParent, 'blocks'],
      [inPcb, 'blocks'],
    ] as const)
      await ctx.db.insert('issue_links', {
        org_id: f.org.id,
        id: uuid(),
        source_id: group.id,
        target_id: target.id,
        type,
        pair_key: [group.id, target.id].sort().join(':'),
        created_at: NOW,
        task_key: group.window_key ?? newWindowKey(),
      })
    const label = await ctx.db
      .query('labels')
      .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
      .first()
    if (label)
      await ctx.db.insert('issue_labels', {
        org_id: f.org.id,
        issue_id: group.id,
        label_id: label.id,
        task_key: group.window_key ?? newWindowKey(),
      })
    for (const [name, created_at] of [
      ['spec.pdf', '2026-01-02T00:00:00.000Z'],
      ['board.png', NOW],
    ])
      await ctx.db.insert('issue_attachments', {
        org_id: f.org.id,
        id: uuid(),
        issue_id: group.id,
        name,
        size_bytes: 5,
        storage_id: await ctx.storage.store(new Blob(['bytes'])),
        inline: false,
        created_at,
        task_key: group.window_key ?? newWindowKey(),
      })
    await ctx.db.insert('issue_subscriptions', {
      issue_id: group.id,
      profile_id: subject.id,
      created_at: NOW,
      task_key: group.window_key ?? newWindowKey(),
    })
  })
}

describe('the task window stand-in', () => {
  it('answers what the window reads answer every Northstar person, for every task', async () => {
    const t = newT()
    const { profiles } = await plantNorthstar(t)
    const other = await withOrg(t)
    const foreign = await plantIssue(t, { org_id: other.org.id, project_id: other.sub.id })
    let shown = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined))
      shown += await compareAll(t, person, foreign)
    expect(shown).toBeGreaterThan(100)
  })

  for (const role of ['user', 'guest', 'viewer', 'admin'] as const)
    it(`answers what the window reads answer ${role === 'admin' ? 'an' : 'a'} ${role} in every access shape`, async () => {
      let opened = 0
      for (const shape of SHAPES) {
        const t = newT()
        const f = await withOrg(t)
        const subject = await plantSeat(t, {
          org_id: f.org.id,
          org_role: role,
          auth_user_id: `auth_${uuid()}`,
        })
        await t.run((ctx) => shape[1](ctx, f, subject))
        await plantWork(t, f, subject)
        const foreign = await plantIssue(t, {
          org_id: f.otherOrg.id,
          project_id: f.otherProject.id,
        })
        opened += await compareAll(t, subject, foreign)
      }
      // some shapes show the subject work, and none shows them everything
      expect(opened).toBeGreaterThan(0)
    })

  it('fails a stand-in that answers a task the caller cannot see', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantWork(t, f, f.guest)
    const { whole, tasks } = await wholeWith(t, f.guest)
    const secret = tasks.find((task) => task.title === 'Secret probe')
    if (!secret) throw new Error('no secret task')
    // the guest is shown nothing of Skunkworks, so a whole that held its
    // task would answer it where the server says unavailable
    expect(
      await as(t, f.guest).query(api.taskWindow.task, { org_id: f.org.id, ref: secret.id }),
    ).toEqual({ state: 'unavailable' })
    // a whole that holds every project and task of the organization, as a
    // fixture's does, still answers only what the guest may open
    const projects = await t.run((ctx) =>
      ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('org_id', f.org.id))
        .collect(),
    )
    // with the secret under the group the guest sees, the hidden parent
    // the group links to, and every link of the organization
    const hiddenParent = tasks.find((task) => task.title === 'Hidden parent')
    const group = tasks.find((task) => task.title === 'Bring up the board')
    if (!hiddenParent || !group) throw new Error('no hidden parent or group')
    const links = await t.run((ctx) =>
      ctx.db
        .query('issue_links')
        .withIndex('by_source', (q) => q.eq('source_id', group.id))
        .collect(),
    )
    const hiddenRow = (task: Doc<'issues'>) => ({
      ...taskFields(task),
      ...(task.parent_id ? { parent_id: task.parent_id } : {}),
      description: '',
      has_hidden_parent: false,
      has_hidden_subtasks: false,
    })
    const leaky = {
      ...whole,
      projects: projects.map(({ _id, _creationTime, ...row }) => row),
      // the group's row as a fixture writes it, with no hidden fact, so
      // the stand-in must find the hidden subtask itself
      issues: [
        ...whole.issues.map((row) =>
          row.id === group.id ? { ...row, has_hidden_subtasks: false } : row,
        ),
        hiddenRow(secret),
        hiddenRow(hiddenParent),
      ],
      links: links.map(relationRow),
    } as Whole
    expect(
      taskWindowStandIn(leaky, 'taskWindow:task', { org_id: f.org.id, ref: secret.id }),
    ).toEqual({ state: 'unavailable' })
    // the group's own answers name neither hidden task, and say a subtask
    // is hidden, as the server's do
    for (const [name, args] of [
      ['taskWindow:task', { org_id: f.org.id, ref: group.id }],
      ['taskWindow:links', { org_id: f.org.id, issue_id: group.id }],
    ] as const) {
      const server =
        name === 'taskWindow:task'
          ? await as(t, f.guest).query(api.taskWindow.task, args as { org_id: string; ref: string })
          : await as(t, f.guest).query(
              api.taskWindow.links,
              args as { org_id: string; issue_id: string },
            )
      expect(server).toMatchObject({ state: 'ok' })
      const standIn = taskWindowStandIn(leaky, name, args)
      expect(standIn, name).toEqual(server)
      const text = JSON.stringify(standIn)
      expect(text).not.toContain(secret.id)
      expect(text).not.toContain(hiddenParent.id)
    }
    expect(
      taskWindowStandIn(leaky, 'taskWindow:task', { org_id: f.org.id, ref: group.id }),
    ).toMatchObject({ task: { has_subtasks: true, has_hidden_subtasks: true } })
  })
})
