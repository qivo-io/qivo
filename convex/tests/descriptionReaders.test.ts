/* Task descriptions in issue_descriptions, the second of three releases:
 * every reader takes a task's text from its first description row in
 * creation order that holds the task's copies, else from its first row,
 * and only a task without a row reads issues.description
 * (model/descriptions.ts). These cases clear issues.description the way the
 * third release will, plant rows that differ from it, leave a task without
 * a row and give one a second row, and check what each reader answers and
 * what each writer narrates, notifies and sends. The real-limit cases run
 * under Convex's transaction limits and check the reads they bound.
 * scripts/check-task-reads.test.mjs covers the check that no other code
 * reads issues.description. */

import { makeFunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  accessFlags,
  asMachineCaller,
  COMMENT_READS_RESERVE,
  DESCRIPTIONS_TOO_LARGE,
  LABEL_READS_RESERVE,
  listActiveIssuesCore,
  loadCatalogue,
  PAGE_TOO_LARGE,
  TEXT_TASK_READS,
} from '../lib/core'
import { newWindowKey } from '../lib/db'
import { descriptionForm, printOf } from '../lib/fieldPrints'
import { type IdWindow, piecesAfter } from '../lib/idWindows'
import { LIMITS, MIB } from '../lib/limits'
import type { OrgExportPage, OrgExportRow, OrgExportSection } from '../lib/orgExport'
import type { EventOwner } from '../lib/taskEvents'
import { PAGE, readTasks } from '../lib/workspaceParts'
import {
  activityFor,
  as,
  expectRefusal,
  messagesFor,
  NOW,
  newT,
  type OrgFixture,
  plantIssue,
  plantProject,
  restArchivedPage,
  restTasks,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'

const whole: IdWindow = { from: '', to: null }
const DEFAULT_TEXT_READS = TEXT_TASK_READS.reads

const exportPage = makeFunctionReference<
  'query',
  { org_id: string; section: OrgExportSection; parent_id?: string; cursor: string | null },
  OrgExportPage
>('orgExport:page')

/** withOrg with the agent able to write the fixture's sub-projects, for
 * REST and MCP. */
async function machineOrg(t: T): Promise<OrgFixture> {
  const f = await withOrg(t)
  await t.run((ctx) =>
    ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    }),
  )
  return f
}

/** Unsets issues.description on every task of organization `orgId`, as the
 * third release leaves task rows, while their description rows keep the
 * text. It patches `each` tasks a transaction, in creation order. */
async function clearTaskText(t: T, orgId: string, each = 50): Promise<void> {
  for (let after = 0; ; ) {
    const from = after
    const last = await t.run(async (ctx) => {
      const tasks = await ctx.db
        .query('issues')
        .withIndex('by_org', (q) => q.eq('org_id', orgId).gt('_creationTime', from))
        .take(each)
      for (const task of tasks) await ctx.db.patch(task._id, { description: undefined })
      return tasks.at(-1)?._creationTime ?? null
    })
    if (last === null) return
    after = last
  }
}

/** Sets the text of task `id`'s first description row to `text`, leaving
 * issues.description as it is. */
const setRowText = (t: T, id: string, text: string) =>
  t.run(async (ctx) => {
    const row = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .first()
    if (row === null) throw new Error('the task has no description row')
    await ctx.db.patch(row._id, { description: text })
  })

/** Deletes every description row of task `id`, as a task stored before the
 * first release has none. */
const dropRows = (t: T, id: string) =>
  t.run(async (ctx) => {
    const rows = await ctx.db
      .query('issue_descriptions')
      .withIndex('by_issue', (q) => q.eq('issue_id', id))
      .collect()
    for (const row of rows) await ctx.db.delete(row._id)
  })

/** Gives task `task` a second description row holding `text`, as a
 * rollback can leave one. */
const secondRow = (t: T, task: Doc<'issues'>, text: string) =>
  t.run((ctx) =>
    ctx.db.insert('issue_descriptions', {
      issue_id: task.id,
      org_id: task.org_id,
      project_id: task.project_id,
      archived_at: task.archived_at,
      description: text,
    }),
  )

/** The two tasks every reader is asked about: `active` in the fixture's
 * sub-project and `archived` archived there. */
type Pair = { active: Doc<'issues'>; archived: Doc<'issues'> }

const plantPair = async (t: T, f: OrgFixture, texts: [string, string]): Promise<Pair> => ({
  active: await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    title: 'Active task',
    description: texts[0],
  }),
  archived: await plantIssue(t, {
    org_id: f.org.id,
    project_id: f.sub.id,
    title: 'Archived task',
    description: texts[1],
    archived_at: NOW,
  }),
})

/** What each reader answers for `pair`, by reader: the text it sends for
 * the task, null when it sent no row for it, and for the searches by
 * `words` the text of the row the search found. */
async function readers(t: T, f: OrgFixture, pair: Pair, words: [string, string]) {
  const agent = { callerId: f.agent.id, access: 'read' as const }
  const mcpList = async <R>(args: { search?: string; archived?: boolean; project?: string }) =>
    JSON.parse(
      await t.query(internal.machine.mcp.listIssues, { ...agent, today: TODAY, ...args }),
    ) as R
  type Row = { id: string; description: string }
  const pick = (rows: Row[], task: Doc<'issues'>) =>
    rows.find((row) => row.id === task.id)?.description ?? null

  const window = await as(t, f.admin).query(api.workspace.tasks, { org_id: f.org.id, ...whole })
  if (window.state !== 'ok') throw new Error(window.state)
  const restGet = (task: Doc<'issues'>) =>
    t.query(internal.machine.rest.getIssue, { ...agent, today: TODAY, ref: task.id })
  const mcpGet = async (task: Doc<'issues'>) =>
    JSON.parse(
      await t.query(internal.machine.mcp.getIssue, { ...agent, today: TODAY, ref: task.id }),
    ) as Row
  const archivedPage = await as(t, f.admin).query(api.issues.archivedPage, {
    project_id: f.sub.id,
    search: words[1],
  })
  const exported: OrgExportRow[] = []
  for (let cursor: string | null = null, done = false; !done; ) {
    const result: OrgExportPage = await as(t, f.admin).query(exportPage, {
      org_id: f.org.id,
      section: 'issues',
      cursor,
    })
    exported.push(...result.rows)
    done = result.isDone
    cursor = result.continueCursor
  }
  const exportedText = (task: Doc<'issues'>) =>
    (exported.find((row) => row.id === task.id)?.description as string | undefined) ?? null

  return {
    workspace: pick(window.issues as Row[], pair.active),
    restGetActive: (await restGet(pair.active)).description,
    restGetArchived: (await restGet(pair.archived)).description,
    restList: pick(await restTasks(t, agent), pair.active),
    restSearch: pick(await restTasks(t, { ...agent, search: words[0] }), pair.active),
    restArchivedSearch: pick(
      (await restArchivedPage(t, { ...agent, project: f.sub.id, search: words[1] })).tasks,
      pair.archived,
    ),
    mcpGetActive: (await mcpGet(pair.active)).description,
    mcpGetArchived: (await mcpGet(pair.archived)).description,
    mcpList: pick(await mcpList<Row[]>({}), pair.active),
    mcpSearch: pick(await mcpList<Row[]>({ search: words[0] }), pair.active),
    mcpArchivedSearch: pick(
      (
        await mcpList<{ tasks: Row[] }>({
          archived: true,
          project: f.sub.id,
          search: words[1],
        })
      ).tasks,
      pair.archived,
    ),
    // its rows carry no text, so it tells only whether the search found it
    archivedPageFound: archivedPage.rows.some((row) => row.id === pair.archived.id),
    exportActive: exportedText(pair.active),
    exportArchived: exportedText(pair.archived),
  }
}

/** What every reader answers when it shows `active` and `archived` as the
 * texts of the pair. */
const everywhere = (active: string, archived: string) => ({
  workspace: active,
  restGetActive: active,
  restGetArchived: archived,
  restList: active,
  restSearch: active,
  restArchivedSearch: archived,
  mcpGetActive: active,
  mcpGetArchived: archived,
  mcpList: active,
  mcpSearch: active,
  mcpArchivedSearch: archived,
  archivedPageFound: true,
  exportActive: active,
  exportArchived: archived,
})

/** The searches of `readers`, which find nothing for words the readers do
 * not see. */
const searches = (found: Awaited<ReturnType<typeof readers>>) => ({
  restSearch: found.restSearch,
  restArchivedSearch: found.restArchivedSearch,
  mcpSearch: found.mcpSearch,
  mcpArchivedSearch: found.mcpArchivedSearch,
  archivedPageFound: found.archivedPageFound,
})

const notFound = {
  restSearch: null,
  restArchivedSearch: null,
  mcpSearch: null,
  mcpArchivedSearch: null,
  archivedPageFound: false,
}

/* A search reads the rows of the tasks it needs one by one, and past
 * TEXT_TASK_READS the organization's active rows in one range; each reader
 * case runs both ways. */
for (const [way, reads] of [
  ['one by one', DEFAULT_TEXT_READS],
  ['in one range', 0],
] as const)
  describe(`every reader takes the text of the description row, searches reading rows ${way}`, () => {
    beforeEach(() => {
      TEXT_TASK_READS.reads = reads
    })
    afterEach(() => {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    })

    it('answers the row text once issues.description is cleared, as the third release leaves it', async () => {
      const t = newT()
      const f = await machineOrg(t)
      const texts: [string, string] = ['Calibrate the zephyr sensor', 'Archive the quokka notes']
      const pair = await plantPair(t, f, texts)
      await clearTaskText(t, f.org.id)
      expect(await readers(t, f, pair, ['zephyr', 'quokka'])).toEqual(everywhere(...texts))
    })

    it('answers a planted row whose text differs from issues.description, and searches only the row', async () => {
      const t = newT()
      const f = await machineOrg(t)
      const pair = await plantPair(t, f, ['Stale walrus text', 'Stale narwhal text'])
      await setRowText(t, pair.active.id, 'Calibrate the zephyr sensor')
      await setRowText(t, pair.archived.id, 'Archive the quokka notes')
      expect(await readers(t, f, pair, ['zephyr', 'quokka'])).toEqual(
        everywhere('Calibrate the zephyr sensor', 'Archive the quokka notes'),
      )
      // the stale text in the task row finds nothing
      expect(searches(await readers(t, f, pair, ['walrus', 'narwhal']))).toEqual(notFound)
    })

    it('falls back to issues.description for a task without a row', async () => {
      const t = newT()
      const f = await machineOrg(t)
      const texts: [string, string] = ['Calibrate the zephyr sensor', 'Archive the quokka notes']
      const pair = await plantPair(t, f, texts)
      await dropRows(t, pair.active.id)
      await dropRows(t, pair.archived.id)
      expect(await readers(t, f, pair, ['zephyr', 'quokka'])).toEqual(everywhere(...texts))
    })

    it('reads the first of two rows in creation order and never throws over the second', async () => {
      const t = newT()
      const f = await machineOrg(t)
      const texts: [string, string] = ['Calibrate the zephyr sensor', 'Archive the quokka notes']
      const pair = await plantPair(t, f, texts)
      await secondRow(t, pair.active, 'A second walrus row')
      await secondRow(t, pair.archived, 'A second narwhal row')
      expect(await readers(t, f, pair, ['zephyr', 'quokka'])).toEqual(everywhere(...texts))
      expect(searches(await readers(t, f, pair, ['walrus', 'narwhal']))).toEqual(notFound)
    })

    it("reads the same row everywhere for a duplicate whose first row's archived copy is stale", async () => {
      const t = newT()
      const f = await machineOrg(t)
      const texts: [string, string] = ['Calibrate the zephyr sensor', 'Archive the quokka notes']
      const pair = await plantPair(t, f, ['Stale walrus text', texts[1]])
      // the first row says the task is archived, which it is not, and a
      // second row holds the task's copies
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query('issue_descriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', pair.active.id))
          .first()
        if (row !== null) await ctx.db.patch(row._id, { archived_at: NOW })
      })
      await secondRow(t, pair.active, texts[0])
      expect(await readers(t, f, pair, ['zephyr', 'quokka'])).toEqual(everywhere(...texts))
      expect(searches(await readers(t, f, pair, ['walrus', 'narwhal']))).toEqual(notFound)
    })

    it('reads the row of an active task whose archived copy is stale, which only a rollback leaves', async () => {
      const t = newT()
      const f = await machineOrg(t)
      const texts: [string, string] = ['Calibrate the zephyr sensor', 'Archive the quokka notes']
      const pair = await plantPair(t, f, texts)
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query('issue_descriptions')
          .withIndex('by_issue', (q) => q.eq('issue_id', pair.active.id))
          .first()
        if (row !== null) await ctx.db.patch(row._id, { archived_at: NOW })
      })
      expect(await readers(t, f, pair, ['zephyr', 'quokka'])).toEqual(everywhere(...texts))
    })
  })

for (const [way, reads] of [
  ['one by one', DEFAULT_TEXT_READS],
  ['in one range', 0],
] as const)
  describe(`a search reads descriptions only up to its page, rows ${way}`, () => {
    beforeEach(() => {
      TEXT_TASK_READS.reads = reads
    })
    afterEach(() => {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    })

    it('answers every page as a search of every task would', async () => {
      const t = newT()
      const f = await machineOrg(t)
      // 300 tasks in list order; every tenth says zephyr in its description,
      // and two others carry a label named for it, one in the first step of
      // tasks a search looks at and one after it
      const ids = await plantMany(
        t,
        f,
        300,
        (i) => (i % 10 === 3 ? `Wire the zephyr ${i}` : `Wire the board ${i}`),
        () => undefined,
        100,
      )
      const labelled = [ids[5], ids[155]]
      await t.run(async (ctx) => {
        const label = uuid()
        await ctx.db.insert('labels', {
          id: label,
          org_id: f.org.id,
          name: 'Zephyr board',
          name_lower: 'zephyr board',
          color: '#336699',
          created_at: NOW,
        })
        for (const issue_id of labelled)
          await ctx.db.insert('issue_labels', { org_id: f.org.id, issue_id, label_id: label })
      })
      const expected = ids.filter((id, i) => i % 10 === 3 || labelled.includes(id))
      const agent = { callerId: f.agent.id, access: 'read' as const }
      const pages: string[] = []
      for (let offset = 0; offset < expected.length + 10; offset += 10) {
        const page = await restTasks(t, {
          ...agent,
          search: 'zephyr',
          limit: '10',
          offset: String(offset),
        })
        pages.push(...page.map((row) => row.id))
      }
      expect(pages).toEqual(expected)
      // a task that matches in none of its fields stays out
      expect(await restTasks(t, { ...agent, search: 'zephyr unicorn' })).toEqual([])
    })
  })

describe('an active page whose own reads fill the request', () => {
  it('asks for a smaller limit only when the page holds more than one row', async () => {
    const t = newT()
    const f = await machineOrg(t)
    for (let i = 0; i < 2; i++)
      await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: `Text ${i}` })
    const agent = { callerId: f.agent.id, access: 'read' as const }
    const reserve = { ...COMMENT_READS_RESERVE }
    try {
      for (const limit of [1, 2]) {
        // the ranges the page reads through its rows' newest comments, the
        // last of its reads, one a row
        const all = await restMetrics(t, f, { limit })
        expect(all.refused).toBeNull()
        // room for the rows' texts, none for their comments
        COMMENT_READS_RESERVE.ranges = 4096 - (all.ranges - limit)
        const e = await expectRefusal(
          restTasks(t, { ...agent, limit: String(limit) }),
          'bad_request',
        )
        const message = (e.data as { message: string }).message
        if (limit === 1) expect(message).toMatch(/too many projects, teams or labels/)
        else expect(message).toBe(PAGE_TOO_LARGE)
        Object.assign(COMMENT_READS_RESERVE, reserve)
      }
    } finally {
      Object.assign(COMMENT_READS_RESERVE, reserve)
    }
  })
})

describe('a write that stamps new copies without issues.description', () => {
  /** A task whose first row has a stale archived copy and the text "Old
   * text", and whose second row holds its copies and "Current text", with
   * issues.description cleared, so readers show "Current text". */
  async function duplicate(t: T, f: OrgFixture) {
    const task = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Old text',
    })
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query('issue_descriptions')
        .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
        .first()
      if (row !== null) await ctx.db.patch(row._id, { archived_at: NOW })
    })
    await secondRow(t, task, 'Current text')
    await clearTaskText(t, f.org.id)
    return task
  }
  const shown = (t: T, f: OrgFixture, id: string) =>
    t
      .query(internal.machine.rest.getIssue, {
        callerId: f.agent.id,
        access: 'read',
        today: TODAY,
        ref: id,
      })
      .then((task) => task.description)

  it('keeps the shown text through a move', async () => {
    const t = newT()
    const f = await machineOrg(t)
    const task = await duplicate(t, f)
    expect(await shown(t, f, task.id)).toBe('Current text')
    await as(t, f.user).mutation(api.issues.move, {
      org_id: f.org.id,
      id: task.id,
      project_id: f.sub2.id,
    })
    expect(await shown(t, f, task.id)).toBe('Current text')
  })

  it("keeps the shown text through the backfill's copy repair", async () => {
    const t = newT()
    const f = await machineOrg(t)
    const task = await duplicate(t, f)
    await t.action(internal.internal.descriptionsBackfill.run, { dry_run: false, repair: true })
    expect(await shown(t, f, task.id)).toBe('Current text')
  })
})

describe('the writers compare the text of the description row', () => {
  /** The fixture with a webhook subscription on its sub-project, so each
   * write of a task there records its task event. */
  async function setup() {
    const t = newT()
    const f = await machineOrg(t)
    const owner = await t.run(async (ctx): Promise<EventOwner> => {
      const id = uuid()
      const credential_row_id = await ctx.db.insert('mcp_tokens', {
        id,
        profile_id: f.guest.id,
        name: 'Events',
        token_prefix: 'qvt_test',
        token_hash: 'test',
        access: 'read',
        created_at: NOW,
      })
      return {
        profile_id: f.guest.id,
        credential_table: 'mcp_tokens',
        credential_id: id,
        credential_row_id,
      }
    })
    await t.mutation(internal.webhooks.save, {
      owner,
      id: uuid(),
      name: 'task.updated',
      filters: { project_id: f.sub.id },
      url: 'https://receiver.example/events',
      encrypted_secret: 'encrypted-test-key',
      expires_at: Date.now() + 600_000,
    })
    return { t, f }
  }

  /** The changed fields of the task events written after `count` of them. */
  const eventsAfter = (t: T, count: number) =>
    t.run(async (ctx) =>
      (await ctx.db.query('webhook_events').collect())
        .slice(count)
        .map(
          (row) =>
            (JSON.parse(row.payload) as { data: { changed_fields: string[] } }).data.changed_fields,
        ),
    )
  const eventCount = (t: T) =>
    t.run(async (ctx) => (await ctx.db.query('webhook_events').collect()).length)

  /** Each surface's edit of task `id`: its fields and its `expected`, as the
   * surface sends them. */
  const surfaces = {
    app: (t: T, f: OrgFixture, id: string, patch: Record<string, string>, seen?: string) =>
      as(t, f.user).mutation(api.issues.update, {
        org_id: f.org.id,
        id,
        patch,
        ...(seen === undefined
          ? {}
          : { expected: { description: printOf(descriptionForm(seen)) } }),
      }),
    rest: (t: T, f: OrgFixture, id: string, patch: Record<string, string>, seen?: string) =>
      t.mutation(internal.machine.rest.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        keyName: 'readers',
        ref: id,
        body: JSON.stringify({
          ...patch,
          ...(seen === undefined ? {} : { expected: { description: seen } }),
        }),
      }),
    mcp: (t: T, f: OrgFixture, id: string, patch: Record<string, string>, seen?: string) =>
      t.mutation(internal.machine.mcp.updateIssue, {
        callerId: f.agent.id,
        access: 'write',
        ref: id,
        ...patch,
        ...(seen === undefined ? {} : { expected: { description: seen } }),
      }),
  }

  for (const [surface, edit] of Object.entries(surfaces))
    it(`${surface}: narrates, notifies, keeps a shown image, checks expected and names the field from the row`, async () => {
      const { t, f } = await setup()
      const lost = uuid()
      const mention = `@[admin](user:${f.admin.id})`
      const old = `Old wiring ${mention} ![photo](att:${lost})`
      const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, description: old })
      await clearTaskText(t, f.org.id)

      // a stale expected is refused; the unchanged one passes
      const refusal = await expectRefusal(
        edit(t, f, task.id, { description: 'Lost edit' }, 'Something else'),
        'conflict',
      )
      expect((refusal.data as { reason?: string }).reason).toBe('field_changed')
      // the image the old text showed may stay though the task lacks it,
      // and the mention it held is not news
      const next = `New wiring ${mention} ![photo](att:${lost})`
      let events = await eventCount(t)
      await edit(t, f, task.id, { description: next }, old)
      expect(await messagesFor(t, f.admin.id, task.id)).toEqual([])
      const history = (await activityFor(t, f.org.id)).filter((row) => row.target_id === task.id)
      expect(history.at(-1)).toMatchObject({
        verb: surface === 'app' ? 'updated the description of' : 'changed',
        detail: expect.stringContaining(`“Old wiring`),
      })
      expect(await eventsAfter(t, events)).toEqual([['description']])

      // a newly added mention notifies
      const added = `${next} @[viewer](user:${f.viewer.id})`
      await edit(t, f, task.id, { description: added })
      expect((await messagesFor(t, f.viewer.id, task.id)).map((m) => m.kind)).toEqual(['mention'])

      // a title edit names the title only
      events = await eventCount(t)
      await edit(t, f, task.id, { title: 'Renamed' })
      expect(await eventsAfter(t, events)).toEqual([['title']])
    })
})

describe('Northstar', () => {
  it("the workspace part's rows and the REST and MCP task JSON answer each task's row text, which is its task row's", async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    const texts = new Map(
      await t.run(async (ctx) => {
        const tasks = await ctx.db
          .query('issues')
          .withIndex('by_org', (q) => q.eq('org_id', org.id))
          .collect()
        const out: [string, { row: string; task: string | null }][] = []
        for (const task of tasks) {
          const row = await ctx.db
            .query('issue_descriptions')
            .withIndex('by_issue', (q) => q.eq('issue_id', task.id))
            .first()
          out.push([task.id, { row: row?.description ?? '', task: task.description ?? null }])
        }
        return out
      }),
    )
    // both copies are equal, so the answers before this release and after
    // it are the same
    for (const { row, task } of texts.values()) expect(task).toBe(row)
    const admin = profiles.find((p) => p.org_role === 'admin' && p.kind === 'person')
    if (admin?.auth_user_id === undefined) throw new Error('Northstar has no admin')
    const answer = await t
      .withIdentity({ subject: admin.auth_user_id })
      .query(api.workspace.tasks, { org_id: org.id, ...whole })
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.issues.length).toBeGreaterThan(50)
    for (const row of answer.issues) expect(row.description).toBe(texts.get(row.id)?.row)
    const agent = profiles.find((p) => p.kind === 'agent')
    if (agent === undefined) throw new Error('Northstar has no agent')
    const rows = await restTasks(t, { callerId: agent.id, access: 'read', limit: '200' })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.description).toBe(texts.get(row.id)?.row)
    const one = rows.find((row) => row.description !== '')
    if (one === undefined) throw new Error('no described task')
    const mcp = JSON.parse(
      await t.query(internal.machine.mcp.getIssue, {
        callerId: agent.id,
        access: 'read',
        today: TODAY,
        ref: one.id,
      }),
    ) as { description: string }
    expect(mcp.description).toBe(texts.get(one.id)?.row)
  })
})

/* ------------------------------------------------------------ real limits */

/** A task row for planting by hand: `text` in issues.description, or none
 * when it is undefined. */
const taskDoc = (
  f: OrgFixture,
  num: number,
  text?: string,
  extra: Partial<Doc<'issues'>> = {},
) => ({
  id: uuid(),
  org_id: f.org.id,
  project_id: f.sub.id,
  num,
  title: `Task ${num}`,
  ...(text === undefined ? {} : { description: text }),
  status: 'todo' as const,
  priority: 'low' as const,
  paused: false,
  created_at: NOW,
  updated_at: NOW,
  window_key: newWindowKey(),
  ...extra,
})

/** Plants `count` tasks in the fixture's sub-project, each with a
 * description row holding `rowText` and issues.description holding
 * `taskText`, or none, `each` tasks a transaction. */
async function plantMany(
  t: T,
  f: OrgFixture,
  count: number,
  rowText: (i: number) => string,
  taskText: (i: number) => string | undefined,
  each: number,
): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; from < count; from += each)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(count, from + each); i++) {
        const doc = taskDoc(f, 10_000 + i, taskText(i))
        await ctx.db.insert('issues', doc)
        await ctx.db.insert('issue_descriptions', {
          issue_id: doc.id,
          org_id: f.org.id,
          project_id: f.sub.id,
          description: rowText(i),
        })
        ids.push(doc.id)
      }
    })
  return ids
}

/** The metrics a transaction logs: what it read, in MiB, documents and
 * index ranges. */
async function used(ctx: QueryCtx) {
  const m = await ctx.meta.getTransactionMetrics()
  return {
    mib: Math.round((m.bytesRead.used / MIB) * 100) / 100,
    documents: m.documentsRead.used,
    ranges: m.databaseQueries.used,
  }
}

/** What a REST active list of `o` read, in the agent's query, and the
 * refusal it met, or null when it answered. */
const restMetrics = (t: T, f: OrgFixture, o: { limit: number; search?: string }) =>
  as(t, f.admin).query(async (ctx) => {
    const me = await asMachineCaller(ctx, f.agent.id, 'read')
    const cat = await loadCatalogue(ctx, me)
    const flags = await accessFlags(ctx, me, cat, 'read')
    let refused: string | null = null
    try {
      await listActiveIssuesCore(
        ctx,
        me,
        { scope: null, offset: 0, stars: true, today: TODAY, ...o },
        { surface: 'rest', cat, readable: (id) => flags.get(id)?.read === true },
      )
    } catch (error) {
      refused = String(error)
    }
    return { refused, ...(await used(ctx)) }
  })

/** A text of `chars` characters of a three-byte script, ending in `word`. */
const wide = (chars: number, word = '') => `${'中'.repeat(chars - word.length)}${word}`

describe('real limits', () => {
  it('a window of 200 tasks whose rows are near 900 KB overflows, and the cut that fits answers, past PAGE.hard by one row at most', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const text = 'n'.repeat(900 * 1024)
    await plantMany(
      t,
      f,
      200,
      () => text,
      () => undefined,
      12,
    )
    const read = (w: IdWindow) =>
      t.run(async (ctx) => {
        const answer = await readTasks(ctx, f.admin, w)
        return { answer, metrics: await used(ctx) }
      })
    const first = await read(whole)
    expect(first.answer.state).toBe('overflow')
    // past PAGE.hard by one row at most
    expect(first.metrics.mib).toBeLessThanOrEqual(PAGE.hard.bytes / MIB + 1)
    // the app cuts the window, and goes on into the piece that holds the
    // first task, until it answers
    let w = whole
    let answer = first.answer
    let metrics = first.metrics
    for (let depth = 0; answer.state === 'overflow' && depth < 12; depth++) {
      const pieces = piecesAfter(w, answer) ?? []
      w = pieces.find((piece) => piece.from === w.from) ?? pieces[0]
      ;({ answer, metrics } = await read(w))
    }
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.issues.length).toBeGreaterThan(0)
    for (const row of answer.issues) expect(row.description).toBe(text)
    expect(metrics.mib).toBeLessThanOrEqual(PAGE.hard.bytes / MIB + 1)
  }, 300_000)

  it('the narrowest window answers a parent whose subtasks are legacy rows near 1 MiB, its text one row past PAGE.hard at most', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    // the narrowest window of the grid, which cannot be cut
    const narrowest: IdWindow = { from: 'fff00000', to: null }
    const parent = await plantIssue(t, {
      org_id: f.org.id,
      project_id: f.sub.id,
      description: 'Bring up the board',
      window_key: 'fff00000',
    })
    // eight subtasks in other windows, stored before the caps with texts of
    // 850 KB in their task rows; the window reads each, and the first again,
    // to tell the parent is a group, about 7.3 MiB
    const legacy = 'l'.repeat(850 * 1024)
    for (let from = 0; from < 8; from += 4)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 4; i++)
          await ctx.db.insert(
            'issues',
            taskDoc(f, 20_000 + i, legacy, { parent_id: parent.id, window_key: '00000000' }),
          )
      })
    const { answer, metrics } = await t.run(async (ctx) => ({
      answer: await readTasks(ctx, f.admin, narrowest),
      metrics: await used(ctx),
    }))
    if (answer.state !== 'ok') throw new Error(answer.state)
    expect(answer.issues.map((row) => [row.id, row.description, row.has_subtasks])).toEqual([
      [parent.id, 'Bring up the board', true],
    ])
    expect(metrics.mib).toBeGreaterThan(7)
    expect(metrics.mib).toBeLessThan(16)
  }, 300_000)

  it('a window of 200 tasks with both copies at the cap in a three-byte script answers or splits within PAGE.hard', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const text = wide(LIMITS.description.max)
    await plantMany(
      t,
      f,
      200,
      () => text,
      () => text,
      50,
    )
    const queue: IdWindow[] = [whole]
    const shown = new Set<string>()
    const states: string[] = []
    let most = 0
    while (queue.length > 0) {
      const w = queue.shift() as IdWindow
      const { answer, metrics } = await t.run(async (ctx) => ({
        answer: await readTasks(ctx, f.admin, w),
        metrics: await used(ctx),
      }))
      states.push(answer.state)
      most = Math.max(most, metrics.mib)
      if (answer.state === 'ok') {
        for (const row of answer.issues) {
          expect(row.description).toBe(text)
          shown.add(row.id)
        }
        if (answer.split === true) states.push('split')
        continue
      }
      expect(answer.state).toBe('overflow')
      queue.push(...(piecesAfter(w, answer) ?? []))
    }
    expect(shown.size).toBe(200)
    expect(states).toContain('ok')
    expect(most).toBeLessThanOrEqual(PAGE.hard.bytes / MIB)
  }, 300_000)

  it('a REST page of 200 tasks at the cap answers or refuses with PAGE_TOO_LARGE, and a smaller limit answers', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    const text = wide(LIMITS.description.max)
    await plantMany(
      t,
      f,
      200,
      () => text,
      () => text,
      50,
    )
    const agent = { callerId: f.agent.id, access: 'read' as const }
    await expectRefusal(
      restTasks(t, { ...agent, limit: '200' }),
      'bad_request',
      /too large to read at once/,
    )
    const small = await restTasks(t, { ...agent, limit: '20' })
    expect(small.map((row) => row.description)).toEqual(Array(20).fill(text))
    // as the third release leaves the task rows, a whole page fits
    await clearTaskText(t, f.org.id)
    const all = await restTasks(t, { ...agent, limit: '200' })
    expect(all).toHaveLength(200)
    expect(all.map((row) => row.description)).toEqual(Array(200).fill(text))
    expect(PAGE_TOO_LARGE).toMatch(/smaller limit/)
  }, 300_000)

  it('a REST search over 4,000 active tasks answers a key and a description word, reading only up to its page', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    const ids = await plantMany(
      t,
      f,
      4000,
      (i) => `Notes ${i} on the zephyr`,
      (i) => `Notes ${i} on the zephyr`,
      500,
    )
    const agent = { callerId: f.agent.id, access: 'read' as const }
    // a key matches one task, so every other task's text is read, in one
    // range past TEXT_TASK_READS
    const key = await restTasks(t, { ...agent, search: 'QN-10001' })
    expect(key.map((row) => row.id)).toEqual([ids[1]])
    // a word in every description finds the page in the first tasks
    const word = await restTasks(t, { ...agent, search: 'zephyr', limit: '20' })
    expect(word.map((row) => row.id)).toEqual(ids.slice(0, 20))
    const broad = await restMetrics(t, f, { limit: 20, search: 'zephyr' })
    expect(broad.refused).toBeNull()
    // the 4,000 tasks, one step of their rows and the page's reads
    expect(broad.documents).toBeLessThan(4000 + 300)
    const rare = await restMetrics(t, f, { limit: 20, search: 'QN-10001' })
    expect(rare.refused).toBeNull()
    // one range a task for TEXT_TASK_READS, then one a step of up to 64
    // rows, far from one a task
    expect(rare.ranges).toBeLessThan(1500)
  }, 300_000)

  it('a REST search of one row stops reading once its page is complete, before descriptions that would not fit', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // 3,000 rows of 4 KB beside task rows without text, 12 MB in all; one
    // task says zephyr at 950, past nothing but per-task reads, and one says
    // quokka at 1,500, past TEXT_TASK_READS
    const ids = await plantMany(
      t,
      f,
      3000,
      (i) => `${i === 950 ? 'zephyr' : i === 1500 ? 'quokka' : 'notes'} `.padEnd(4000, 'x'),
      () => undefined,
      500,
    )
    const agent = { callerId: f.agent.id, access: 'read' as const }
    // the first task's ID, which reads no description
    expect(
      (await restTasks(t, { ...agent, search: 'QN-10000', limit: '1' })).map((row) => row.id),
    ).toEqual([ids[0]])
    expect(
      (await restTasks(t, { ...agent, search: 'zephyr', limit: '1' })).map((row) => row.id),
    ).toEqual([ids[950]])
    expect(
      (await restTasks(t, { ...agent, search: 'quokka', limit: '1' })).map((row) => row.id),
    ).toEqual([ids[1500]])
    const quokka = await restMetrics(t, f, { limit: 1, search: 'quokka' })
    expect(quokka.refused).toBeNull()
    // TEXT_TASK_READS rows one by one, then the range again up to the page,
    // about 11 MiB, where the range over every row passes 16 MiB
    expect(quokka.mib).toBeLessThan(12)
  }, 300_000)

  it("a REST search past TEXT_TASK_READS reads its candidates' projects, not an archived project's history", async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // first, 2,000 tasks left active in an archived sub-project, with rows
    // of 8 KB, 16 MB in all, which no active list reads
    const shelved = await plantProject(t, {
      org_id: f.org.id,
      type: 'project',
      parent_id: f.meta.id,
      archived_at: NOW,
    })
    for (let from = 0; from < 2000; from += 250)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 250; i++) {
          const doc = taskDoc(f, 40_000 + i, undefined, { project_id: shelved.id })
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            org_id: f.org.id,
            project_id: shelved.id,
            description: 'History '.padEnd(8000, 'h'),
          })
        }
      })
    const ids = await plantMany(
      t,
      f,
      300,
      (i) => `Notes ${i}`,
      () => undefined,
      300,
    )
    TEXT_TASK_READS.reads = 0
    try {
      const agent = { callerId: f.agent.id, access: 'read' as const }
      expect((await restTasks(t, { ...agent, search: 'QN-10007' })).map((row) => row.id)).toEqual([
        ids[7],
      ])
    } finally {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    }
  }, 300_000)

  it('a REST search past TEXT_TASK_READS follows its tasks across projects and stops at its page', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // in list order: a task in one project that misses, the match in the
    // other project, then 1,000 tasks back in the first project with rows of
    // 16 KiB, 16 MiB in all, which reading a project to its end before the
    // next would read
    const plant = (num: number, project_id: string, text: string) => ({
      doc: taskDoc(f, num, undefined, { project_id }),
      text,
    })
    const firstTwo = [
      plant(70_000, f.sub.id, 'Wire the board'),
      plant(70_001, f.sub2.id, 'Wire the zephyr'),
    ]
    const tail = Array.from({ length: 1000 }, (_, i) =>
      plant(70_002 + i, f.sub.id, `Notes ${i} `.padEnd(16 * 1024, 'n')),
    )
    const all = [...firstTwo, ...tail]
    for (let from = 0; from < all.length; from += 200)
      await t.run(async (ctx) => {
        for (const { doc, text } of all.slice(from, from + 200)) {
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            org_id: f.org.id,
            project_id: doc.project_id,
            description: text,
          })
        }
      })
    TEXT_TASK_READS.reads = 0
    try {
      const agent = { callerId: f.agent.id, access: 'read' as const }
      expect(
        (await restTasks(t, { ...agent, search: 'zephyr', limit: '1' })).map((row) => row.id),
      ).toEqual([firstTwo[1].doc.id])
      const metrics = await restMetrics(t, f, { limit: 1, search: 'zephyr' })
      // one chunk of the first project, not its 16 MiB
      expect(metrics.mib).toBeLessThan(2)
    } finally {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    }
  }, 300_000)

  it('a REST search past TEXT_TASK_READS stops a range step once the task it reads for has its text', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // the match first, then 20 tasks with rows of 900 KiB, fewer than a
    // step's 64 rows but more than the room holds
    const match = await t.run(async (ctx) => {
      const doc = taskDoc(f, 81_000)
      await ctx.db.insert('issues', doc)
      await ctx.db.insert('issue_descriptions', {
        issue_id: doc.id,
        org_id: f.org.id,
        project_id: f.sub.id,
        description: 'Wire the zephyr',
      })
      return doc
    })
    for (let from = 0; from < 20; from += 5)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 5; i++) {
          const doc = taskDoc(f, 81_001 + i)
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            org_id: f.org.id,
            project_id: f.sub.id,
            description: `${i} `.padEnd(900 * 1024, 'n'),
          })
        }
      })
    TEXT_TASK_READS.reads = 0
    try {
      const agent = { callerId: f.agent.id, access: 'read' as const }
      expect(
        (await restTasks(t, { ...agent, search: 'zephyr', limit: '1' })).map((row) => row.id),
      ).toEqual([match.id])
    } finally {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    }
  }, 300_000)

  it('a REST search past TEXT_TASK_READS reads small rows ahead in one range when its projects alternate', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // 640 tasks whose small rows alternate between the two sub-projects
    for (let from = 0; from < 640; from += 160)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 160; i++) {
          const project_id = i % 2 === 0 ? f.sub.id : f.sub2.id
          const doc = taskDoc(f, 84_000 + i, undefined, { project_id })
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', {
            issue_id: doc.id,
            org_id: f.org.id,
            project_id,
            description: `Notes ${i} on the board`,
          })
        }
      })
    TEXT_TASK_READS.reads = 0
    try {
      // a key reads every task's text
      const key = await restMetrics(t, f, { limit: 20, search: 'QN-84001' })
      expect(key.refused).toBeNull()
      // a step of up to 64 rows a project, where a step a task reads 640
      expect(key.ranges).toBeLessThan(100)
    } finally {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    }
  }, 300_000)

  it('a REST search past TEXT_TASK_READS reads no large rows ahead while the page waits on another project', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // the page is A, then B in the other sub-project; A's project holds 20
    // rows of 900 KiB of tasks listed after them, more than the room holds
    const row = (doc: ReturnType<typeof taskDoc>, description: string) => ({
      issue_id: doc.id,
      org_id: f.org.id,
      project_id: doc.project_id,
      description,
    })
    const a = taskDoc(f, 83_000)
    const b = taskDoc(f, 83_001, undefined, { project_id: f.sub2.id })
    await t.run(async (ctx) => {
      await ctx.db.insert('issues', a)
      await ctx.db.insert('issue_descriptions', row(a, 'Wire the zephyr'))
    })
    for (let from = 0; from < 20; from += 5)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 5; i++) {
          const doc = taskDoc(f, 83_002 + i)
          await ctx.db.insert('issues', doc)
          await ctx.db.insert('issue_descriptions', row(doc, `${i} `.padEnd(900 * 1024, 'n')))
        }
      })
    await t.run(async (ctx) => {
      await ctx.db.insert('issues', b)
      await ctx.db.insert('issue_descriptions', row(b, 'Wire the zephyr'))
    })
    TEXT_TASK_READS.reads = 0
    try {
      const agent = { callerId: f.agent.id, access: 'read' as const }
      expect(
        (await restTasks(t, { ...agent, search: 'zephyr', limit: '2' })).map((r) => r.id),
      ).toEqual([a.id, b.id])
    } finally {
      TEXT_TASK_READS.reads = DEFAULT_TEXT_READS
    }
  }, 300_000)

  it('a REST search refuses with its sentence when the descriptions do not fit, and with the list sentence when nothing does', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // 2,500 rows of 6 KB beside task rows without text, as the third
    // release leaves them: 15 MB of descriptions
    await plantMany(
      t,
      f,
      2500,
      (i) => `${i} `.padEnd(6000, 'z'),
      () => undefined,
      250,
    )
    const agent = { callerId: f.agent.id, access: 'read' as const }
    await expectRefusal(
      restTasks(t, { ...agent, search: 'QN-10001' }),
      'bad_request',
      new RegExp(DESCRIPTIONS_TOO_LARGE.slice(0, 40)),
    )
    const metrics = await restMetrics(t, f, { limit: 50, search: 'QN-10001' })
    expect(metrics.refused).toContain(DESCRIPTIONS_TOO_LARGE)
    expect(metrics.mib).toBeLessThan(16)
    // a search whose reads before the first text leave no room for one
    // says what filled the request
    const reserve = { ...LABEL_READS_RESERVE }
    LABEL_READS_RESERVE.bytes = 16 * MIB
    try {
      await expectRefusal(
        restTasks(t, { ...agent, search: 'QN-10001' }),
        'bad_request',
        /active tasks are too large to list/,
      )
    } finally {
      Object.assign(LABEL_READS_RESERVE, reserve)
    }
  }, 300_000)

  it("a single-task read of an archived task with large legacy rows reads its text before its walk, within Convex's limits", async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    const big = (c: string) => c.repeat(1000 * 1000)
    // an archived task with a description row and a newest comment near
    // 1 MiB, a parent stored before the caps with a text near 1 MiB, and
    // archived subtasks of 900 KB that fill the walk's room. The reads after
    // the walk fit the reserve only without the description row, and only
    // when it counts the subtasks read again
    const ids = await t.run(async (ctx) => {
      const parent = taskDoc(f, 30_000, big('p'), { archived_at: NOW })
      await ctx.db.insert('issues', parent)
      const task = taskDoc(f, 30_001, undefined, { archived_at: NOW, parent_id: parent.id })
      await ctx.db.insert('issues', task)
      await ctx.db.insert('issue_descriptions', {
        issue_id: task.id,
        org_id: f.org.id,
        project_id: f.sub.id,
        archived_at: NOW,
        description: big('d'),
      })
      await ctx.db.insert('comments', {
        id: uuid(),
        issue_id: task.id,
        body: big('c'),
        created_at: NOW,
      })
      return { parent: parent.id, task: task.id }
    })
    for (let from = 0; from < 20; from += 5)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 5; i++)
          await ctx.db.insert(
            'issues',
            taskDoc(f, 30_100 + i, 's'.repeat(900 * 1024), {
              archived_at: NOW,
              parent_id: ids.task,
            }),
          )
      })
    const got = await t.query(internal.machine.rest.getIssue, {
      callerId: f.agent.id,
      access: 'read',
      today: TODAY,
      ref: ids.task,
    })
    expect(got.description).toBe(big('d'))
    expect(got.parent_id).toBe(ids.parent)
  }, 300_000)

  it('an active page and an export page count two description rows a task', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // 12 tasks with two rows of 900 KiB each, the first with a stale
    // archived copy, as a rollback leaves them, so each text reads both
    const shown = (i: number) => `${i} shown `.padEnd(900 * 1024, 's')
    const ids: string[] = []
    for (let from = 0; from < 12; from += 2)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 2; i++) {
          const doc = taskDoc(f, 60_000 + i)
          await ctx.db.insert('issues', doc)
          for (const [text, archived] of [
            [`${i} stale `.padEnd(900 * 1024, 'x'), NOW],
            [shown(i), undefined],
          ] as const)
            await ctx.db.insert('issue_descriptions', {
              issue_id: doc.id,
              org_id: f.org.id,
              project_id: f.sub.id,
              ...(archived === undefined ? {} : { archived_at: archived }),
              description: text,
            })
          ids.push(doc.id)
        }
      })
    const agent = { callerId: f.agent.id, access: 'read' as const }
    // twelve texts of two rows each do not fit beside the page; four do
    await expectRefusal(
      restTasks(t, { ...agent, limit: '12' }),
      'bad_request',
      /too large to read at once/,
    )
    expect((await restTasks(t, { ...agent, limit: '4' })).map((row) => row.description)).toEqual(
      ids.slice(0, 4).map((_, i) => shown(i)),
    )
    // the export goes on a few tasks a page
    const rows: OrgExportRow[] = []
    for (let cursor: string | null = null, done = false; !done; ) {
      const result: OrgExportPage = await as(t, f.admin).query(exportPage, {
        org_id: f.org.id,
        section: 'issues',
        cursor,
      })
      rows.push(...result.rows)
      done = result.isDone
      cursor = result.continueCursor
    }
    for (const [i, id] of ids.entries())
      expect(rows.find((row) => row.id === id)?.description).toBe(shown(i))
  }, 300_000)

  it('a task with many rows reads two of them at most, within the limits', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    // 20 rows of 900 KiB, as repeated rollbacks could leave them: the first
    // 19 with a stale archived copy, the last with the task's copies
    const task = await t.run(async (ctx) => {
      const doc = taskDoc(f, 50_000)
      await ctx.db.insert('issues', doc)
      return doc
    })
    for (let from = 0; from < 20; from += 5)
      await t.run(async (ctx) => {
        for (let i = from; i < from + 5; i++)
          await ctx.db.insert('issue_descriptions', {
            issue_id: task.id,
            org_id: f.org.id,
            project_id: f.sub.id,
            ...(i < 19 ? { archived_at: NOW } : {}),
            description: `${i} `.padEnd(900 * 1024, 'r'),
          })
      })
    const got = await t.query(internal.machine.rest.getIssue, {
      callerId: f.agent.id,
      access: 'read',
      today: TODAY,
      ref: task.id,
    })
    // neither of the first two rows holds the copies, so the first
    expect(got.description).toBe('0 '.padEnd(900 * 1024, 'r'))
  }, 300_000)

  it('an export issues page with description rows near 1 MiB stays within the limits and goes on', async () => {
    const t = newT({ transactionLimits: true })
    const f = await withOrg(t)
    const text = (i: number) => `${i} `.padEnd(1000 * 1024, 'x')
    const ids = await plantMany(t, f, 24, text, () => undefined, 8)
    const rows: OrgExportRow[] = []
    let pages = 0
    for (let cursor: string | null = null, done = false; !done; pages++) {
      const result: OrgExportPage = await as(t, f.admin).query(exportPage, {
        org_id: f.org.id,
        section: 'issues',
        cursor,
      })
      rows.push(...result.rows)
      done = result.isDone
      cursor = result.continueCursor
    }
    expect(pages).toBeGreaterThan(2)
    for (const [i, id] of ids.entries())
      expect(rows.find((row) => row.id === id)?.description).toBe(text(i))
  }, 300_000)
})
