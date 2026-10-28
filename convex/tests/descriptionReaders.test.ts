/* Task descriptions in issue_descriptions, the second of three releases:
 * every reader takes a task's text from its first description row in
 * creation order, and only a task without a row reads issues.description
 * (model/descriptions.ts). These cases clear issues.description the way the
 * third release will, plant rows that differ from it, leave a task without
 * a row and give one a second row, and check what each reader answers and
 * what each writer narrates, notifies and sends. The real-limit cases run
 * under Convex's transaction limits and check the reads they bound.
 * scripts/check-task-reads.test.mjs covers the check that no other code
 * reads issues.description. */

import { makeFunctionReference } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import {
  accessFlags,
  asMachineCaller,
  DESCRIPTIONS_TOO_LARGE,
  listActiveIssuesCore,
  loadCatalogue,
  PAGE_TOO_LARGE,
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
  restArchivedPage,
  restTasks,
  type T,
  TODAY,
  uuid,
  withOrg,
} from './helpers.setup'
import { plantNorthstar } from './northstar.setup'

const whole: IdWindow = { from: '', to: null }

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

describe('every reader takes the text of the description row', () => {
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
  it('a window of 200 tasks whose rows are near 900 KB overflows, and the cut that fits answers within PAGE.hard', async () => {
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
    expect(first.metrics.mib).toBeLessThanOrEqual(PAGE.hard.bytes / MIB)
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
    expect(metrics.mib).toBeLessThanOrEqual(PAGE.hard.bytes / MIB)
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

  it('a REST search over 3,000 tasks that match only in their descriptions answers or refuses with its sentence', async () => {
    const t = newT({ transactionLimits: true })
    const f = await machineOrg(t)
    await plantMany(
      t,
      f,
      3000,
      (i) => `Notes ${i} on the zephyr`,
      (i) => `Notes ${i} on the zephyr`,
      500,
    )
    const agent = { callerId: f.agent.id, access: 'read' as const }
    await expectRefusal(
      restTasks(t, { ...agent, search: 'zephyr' }),
      'bad_request',
      new RegExp(DESCRIPTIONS_TOO_LARGE.slice(0, 40)),
    )
    // within the request, never past Convex's limits
    const metrics = await restMetrics(t, f, { limit: 50, search: 'zephyr' })
    expect(metrics.refused).toContain(DESCRIPTIONS_TOO_LARGE)
    expect(metrics.mib).toBeLessThan(16)
    expect(metrics.ranges).toBeLessThan(4096)
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
