/* One-time migration: find, and fix where a program safely can, stored
 * values the registry's limits (lib/limits.ts) now refuse. Names, label
 * names and attachment file names counted code points before; they now count
 * UTF-16 code units, so a name of 80 code points with emoji in it can hold
 * more than 80 units. A task's remaining hours could exceed the cap before it
 * was enforced, and task descriptions were stored untrimmed. Email addresses
 * kept a Unicode domain before they were stored in punycode. Such a row still
 * reads, but an edit that resends the value, or an `expected` that names it,
 * is refused until it fits. No code keeps such rows working (there is no
 * grandfathering), so a deployment that holds one runs this.
 *
 * Every phase walks one table. The deleted_* phases walk the copies Deleted
 * items keeps of that table (deleted_rows), because a restore writes a copy
 * back unchanged (schema.ts), and apply the same rules to its `row.doc`.
 * The phases, in the order the fix runs them:
 *   projects, teams, milestones, organizations, profiles, agent_keys,
 *   mcp_tokens   names over NAME_MAX; projects also descriptions over
 *                LIMITS.projectDescription
 *   labels       label names over LIMITS.labelName
 *   issue_attachments  file names over LIMITS.attachmentName
 *   issues       remaining hours over the cap, untrimmed descriptions and
 *                descriptions over TEXT_MAX
 *   comments     bodies over TEXT_MAX
 *   emails       profile addresses not in the form cleanEmail stores,
 *                including ones it refuses, such as an address a password
 *                login cannot use
 *   deleted_projects, deleted_milestones, deleted_issue_attachments,
 *   deleted_issues, deleted_comments   the same rules on stored copies
 *
 * Check a deployment first. `check` is a query, so it writes nothing, and a
 * key that may only run internal queries can run it. It reports one page of
 * one `phase`: the rows that break a rule with the field and its length,
 * never the value. Pass the returned `cursor` back until `done` is true, for
 * each phase. With the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/overCapRows:check '{"phase": "teams"}'
 *
 * Run the fix only after the deployment serves this release, and only with
 * the owner's approval; it changes what people see. On production, take
 * and verify a backup first (docs/deployment.md). Read the dry run, which
 * writes nothing, then fix and check again:
 *   "$H" staging npx convex run internal/overCapRows:fix '{"dry_run": true}'
 *   "$H" staging npx convex run internal/overCapRows:fix '{"dry_run": false}'
 *
 * Each row found carries an `outcome`: 'fixed' by this run, 'would_fix' in a
 * dry run or check, 'skipped' when the fixed value would collide with
 * another row or, for a project name, when its reach rows do not fit what
 * its page has left (run the fix again; behind more than REPORTS reported
 * names on its page, after a person shortens those), or 'reported' when
 * only a person can fix it, such as a project name whose reach rows are
 * more than one change may update (LIMITS.projectTreeChange). A dry run sees
 * a collision with a stored row or a row of the same page; two rows on
 * different pages that fix to the same value both show 'would_fix', and the
 * real run fixes the first and skips the second. `fix` answers `counts` for
 * every row and lists the first 2,000, so a large run still answers.
 *
 * The fix trims each over-long name and cuts it to its limit without
 * splitting an emoji (cutText); a file name keeps its extension. A cut
 * profile, team, project, agent key or personal token name gets the name key
 * of its new form, and the copies of a profile's or team's follow it
 * (model/nameKeys.ts). It lowers remaining hours to the cap, stores each
 * task description trimmed, and rewrites an address to its punycode form
 * (asciiEmail). A label or address
 * whose fixed form another row of its organization already has is skipped,
 * for a person to rename or merge. It never cuts a task description, comment
 * or project description, because a cut can break its markdown, and never
 * cuts an address, because a cut address is a different address; those are
 * reported for a person to shorten or correct. A task description or comment
 * over TEXT_MAX must be shortened (over REST or MCP) before anyone edits it
 * in the app, because the app parses only up to TEXT_MAX. The fix writes no
 * activity. A task's description is the text readers show, its description
 * row's (model/descriptions.ts descriptionOf), and its trimmed form is
 * stored in both copies in a transaction of its own (describe). A task
 * whose task row holds a different text, which only a rollback leaves, is
 * skipped for internal/descriptionsBackfill's repair, so no fresher edit is
 * lost. The issues phase reads each task's description row too, which can
 * come close to Convex's document size limit, so it walks the tasks by id
 * with a cursor of its own, in steps by bytes (taskPage), rather than by a
 * paginate cursor. Running it again is safe, and a deployment that needs
 * nothing reports no rows. */
import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'
import type { Doc, Id } from '../_generated/dataModel'
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from '../_generated/server'
import { cleanEmail } from '../lib/email'
import { cutText, LIMITS, NAME_MAX, TEXT_MAX, trimMarkdown } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { DOCUMENT_MAX_BYTES } from '../model/comments'
import { patchTask, textCopiesOf } from '../model/descriptions'
import { copyNameKey, inlineBudget } from '../model/nameKeys'
import { patchRows } from '../model/projectNav'
import { renameProjectTotals } from '../model/storageTotals'

/** Rows per page and the bytes one page may read; a page can end early.
 * `page_size` lowers the rows per page, for tests of a walk over pages; it
 * counts as a whole number from 1 to PAGE. */
const PAGE = 500
const PAGE_BYTES = 4 * 1024 * 1024

/** The project names a page may read in full only to report them, each up
 * to LIMITS.projectTreeChange.max reach rows, besides the allowance its
 * fixes share. The bound keeps a page within Convex's read limits; past it
 * the long names left on the page wait until a person shortens those. */
const REPORTS = 4

/** The bytes one page of the issues phase reads before it ends, besides one
 * last task (taskPage), and the documents of up to Convex's size limit one
 * task can read: its row, its text's two description rows at most
 * (model/descriptions.ts textCopiesOf), and its row again when the fix
 * patches its hours. A page so reads at most 15 MiB, and a step of the
 * page reads 2 tasks while little of it is spent. */
const TASK_PAGE_BYTES = 11 * 1024 * 1024
const TASK_DOCUMENTS = 4

/** The tables whose `name` counts NAME_MAX UTF-16 units. */
const NAMED = [
  'projects',
  'teams',
  'milestones',
  'organizations',
  'profiles',
  'agent_keys',
  'mcp_tokens',
] as const
type Named = (typeof NAMED)[number]

/** The tables Deleted items stores (lib/enums.ts STORED_TABLES) that a rule
 * here covers, each walked by its own deleted_* phase. */
const STORED = ['projects', 'milestones', 'issue_attachments', 'issues', 'comments'] as const
type Stored = (typeof STORED)[number]

/** The phases, one table each, in the order the fix runs them. */
const PHASES = [
  ...NAMED,
  'labels',
  'issue_attachments',
  'issues',
  'comments',
  'emails',
  'deleted_projects',
  'deleted_milestones',
  'deleted_issue_attachments',
  'deleted_issues',
  'deleted_comments',
] as const
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))
type Phase = (typeof PHASES)[number]

/** Whether `phase` walks a table's `name` alone, or projects. */
const isNamed = (phase: Phase): phase is Named => (NAMED as readonly Phase[]).includes(phase)

/** Whether `phase` walks the copies Deleted items keeps of a table. */
const isDeleted = (phase: Phase): phase is `deleted_${Stored}` => phase.startsWith('deleted_')

/** What happened to one row: fixed by this run, would be fixed (a dry run
 * or check), skipped because the fixed value collides with another row, or
 * reported for a person to fix. */
type Outcome = 'fixed' | 'would_fix' | 'skipped' | 'reported'

/** One field of a row that breaks a rule: its table, id, field, the length
 * or value the rule counts, and what happened to it. A copy in Deleted items
 * names table deleted_rows, its own id and `<table>.<field>`. */
type Found = { table: string; id: string; field: string; length: number; outcome: Outcome }

/** What one page found, and where the next one starts. */
/** What one page found, where the next one starts, and the tasks whose
 * descriptions the fix stores trimmed after the page (describe). */
type PageResult = { rows: Found[]; cursor: string; done: boolean; describe?: Id<'issues'>[] }

const pageRef = makeFunctionReference<
  'mutation',
  { phase: Phase; dry_run: boolean; cursor: string | null; page_size?: number },
  PageResult
>('internal/overCapRows:page')

const describeRef = makeFunctionReference<'mutation', { id: Id<'issues'> }, null>(
  'internal/overCapRows:describe',
)

/** `value` as the fix stores it: trimmed and cut to `max` UTF-16 units, with
 * no space left at the end of the cut. */
const fitted = (value: string, max: number): string => cutText(value.trim(), max).trimEnd()

/** The extension a file name keeps when the fix cuts it, the one
 * src/lib/images.ts webpName recognizes. */
const EXTENSION = /\.[A-Za-z0-9]{1,5}$/

/** File name `value` as the fix stores it: the stem cut so that the stem and
 * its extension fit `max`. */
function fittedFile(value: string, max: number): string {
  const name = value.trim()
  const extension = EXTENSION.exec(name)?.[0] ?? ''
  return `${fitted(name.slice(0, name.length - extension.length), max - extension.length)}${extension}`
}

/** One field that breaks a rule, and the value the fix stores, or no value
 * when a person must change it. */
type Change = { field: string; length: number; value?: string | number }

/** The change a name over `max` needs, if any. */
function nameChange(name: string, max: number, shorten = fitted): Change[] {
  const length = name.trim().length
  return length <= max ? [] : [{ field: 'name', length, value: shorten(name, max) }]
}

/** The report of a long text over `max`, which the fix never cuts. */
function longText(field: string, text: string, max: number): Change[] {
  const length = trimMarkdown(text).length
  return length <= max ? [] : [{ field, length }]
}

/** A document of a table Deleted items stores, typed by its table, the
 * form deleted_rows keeps it in. */
type StoredRow = Doc<'deleted_rows'>['row']

/** The changes one document of a stored table needs. The live phase of the
 * table and its deleted_* phase share it, so a restored copy is as fixed as
 * a live row. */
function storedChanges(row: StoredRow): Change[] {
  switch (row.table) {
    case 'projects':
      return [
        ...nameChange(row.doc.name, NAME_MAX),
        ...longText('description', row.doc.description, LIMITS.projectDescription.max),
      ]
    case 'milestones':
      return nameChange(row.doc.name, NAME_MAX)
    case 'issue_attachments':
      return nameChange(row.doc.name, LIMITS.attachmentName.max, fittedFile)
    case 'comments':
      return longText('body', row.doc.body, TEXT_MAX)
    case 'issues':
      // a copy in Deleted items keeps its text (model/descriptions.ts
      // withDescription)
      return taskChanges(row.doc.remaining_hours, row.doc.description ?? '')
    default:
      return []
  }
}

/** The changes a task with remaining hours `hours` and text `text` needs:
 * its hours down to the cap, and its text trimmed, or reported when it is
 * over TEXT_MAX. */
function taskChanges(hours: number | undefined, text: string): Change[] {
  const changes: Change[] = []
  const max = LIMITS.remainingHours.max
  if (hours !== undefined && hours > max)
    changes.push({ field: 'remaining_hours', length: hours, value: max })
  const description = trimMarkdown(text)
  if (description.length > TEXT_MAX)
    changes.push({ field: 'description', length: description.length })
  else if (description !== text)
    changes.push({ field: 'description', length: description.length, value: description })
  return changes
}

/** One page of the issues phase after `cursor`, the id of the last task the
 * page before read, in id order, which holds no ties. Each task reads its
 * text from its description row (model/descriptions.ts textCopiesOf), and a
 * page reads no more tasks at a time than its unspent TASK_PAGE_BYTES could
 * hold at TASK_DOCUMENTS of Convex's document size limit a task, and one
 * while less is left, so it stays inside Convex's 16 MiB of reads. It ends
 * at `pageSize` tasks, at most PAGE, so its index ranges stay far inside
 * Convex's 4,096. A task whose copies differ is skipped. A task inserted
 * meanwhile may land before the cursor and go unread; such a task's text
 * is stored trimmed already. */
async function taskPage(
  ctx: QueryCtx,
  cursor: string | null,
  write: MutationCtx | null,
  pageSize: number,
): Promise<PageResult> {
  const after = cursor === null ? null : ctx.db.normalizeId('issues', cursor)
  if (cursor !== null && after === null)
    throw new Error('the issues phase takes the cursor a page of it answered')
  const start = (await ctx.meta.getTransactionMetrics()).bytesRead.used
  const rows: Found[] = []
  const describe: Id<'issues'>[] = []
  let through = after
  let read = 0
  const result = (done: boolean): PageResult => ({
    rows,
    cursor: through ?? '',
    done,
    describe,
  })
  for (;;) {
    const spent = (await ctx.meta.getTransactionMetrics()).bytesRead.used - start
    if (read >= pageSize || spent >= TASK_PAGE_BYTES) return result(false)
    const fits = Math.floor((TASK_PAGE_BYTES - spent) / (TASK_DOCUMENTS * DOCUMENT_MAX_BYTES))
    const want = Math.min(pageSize - read, Math.max(1, fits))
    const from = through
    const tasks = await ctx.db
      .query('issues')
      .withIndex('by_id', (q) => (from === null ? q : q.gt('_id', from)))
      .take(want)
    for (const task of tasks) {
      const { text, differs } = await textCopiesOf(ctx.db, task)
      const found = sorted('issues', task._id, taskChanges(task.remaining_hours, text), write)
      // the backfill's repair brings the copies together first
      if (differs)
        for (const row of found.rows) if (row.field === 'description') row.outcome = 'skipped'
      rows.push(...found.rows)
      if (found.patch === null || write === null) continue
      const { remaining_hours, description } = found.patch
      if (typeof remaining_hours === 'number')
        await write.db.patch('issues', task._id, { remaining_hours })
      if (typeof description === 'string' && !differs) describe.push(task._id)
    }
    read += tasks.length
    through = tasks.at(-1)?._id ?? through
    if (tasks.length < want) return result(true)
  }
}

/** The rows `changes` found, each with the outcome a run with or without
 * `write` gives it, and the fields the fix stores, or null when it stores
 * none. `prefix` names the stored table of a copy in Deleted items. */
function sorted(
  table: string,
  id: string,
  changes: Change[],
  write: MutationCtx | null,
  prefix = '',
): { rows: Found[]; patch: Record<string, string | number> | null } {
  const rows: Found[] = []
  let patch: Record<string, string | number> | null = null
  for (const { field, length, value } of changes) {
    const outcome = value === undefined ? 'reported' : write ? 'fixed' : 'would_fix'
    rows.push({ table, id, field: `${prefix}${field}`, length, outcome })
    if (value === undefined) continue
    patch ??= {}
    patch[field] = value
  }
  return { rows, patch }
}

/** One page of `phase` from `cursor`: the rows that break a rule, each fixed
 * with `write` unless it is null. The check and the fix share it, so both
 * find the same rows. A fix changes no index a page is read by, so the
 * cursor stays valid. */
async function walk(
  ctx: QueryCtx,
  phase: Phase,
  cursor: string | null,
  write: MutationCtx | null,
  asked = PAGE,
): Promise<PageResult> {
  const pageSize = Number.isFinite(asked) ? Math.max(1, Math.min(PAGE, Math.floor(asked))) : PAGE
  const opts = { cursor, numItems: pageSize, maximumBytesRead: PAGE_BYTES }
  const rows: Found[] = []
  if (isDeleted(phase)) {
    const table = phase.slice('deleted_'.length) as Stored
    const page = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', table))
      .paginate(opts)
    for (const stored of page.page) {
      const { row } = stored
      const found = sorted('deleted_rows', stored._id, storedChanges(row), write, `${table}.`)
      rows.push(...found.rows)
      if (found.patch !== null && write !== null) {
        await write.db.patch('deleted_rows', stored._id, {
          row: { table: row.table, doc: { ...row.doc, ...found.patch } } as StoredRow,
        })
        // the Storage by project breakdown names a project in Deleted items
        // by its stored copy (model/storageTotals.ts)
        if (row.table === 'projects' && typeof found.patch.name === 'string')
          await renameProjectTotals(write, { ...row.doc, name: found.patch.name })
      }
    }
    return { rows, cursor: page.continueCursor, done: page.isDone }
  }
  if (isNamed(phase)) {
    const table = phase
    const page = await ctx.db.query(table).paginate(opts)
    // a cut profile or team name's copies follow it, within one budget a
    // page (model/nameKeys.ts), and so do a cut project name's reach rows
    // (model/projectNav.ts), within LIMITS.projectTreeChange.max a page
    const copies = inlineBudget()
    let reachLeft = LIMITS.projectTreeChange.max
    let reportsLeft = REPORTS
    for (const doc of page.page) {
      const { _id, _creationTime, ...body } = doc
      const changes =
        table === 'projects'
          ? storedChanges({ table, doc: body } as StoredRow)
          : nameChange(doc.name, NAME_MAX)
      const found = sorted(table, _id, changes, write)
      rows.push(...found.rows)
      // A project's reach rows, which its cut name's key must reach, read
      // in the dry run too, so it reports what the fix does. A name that
      // fits or waits spends the page's allowance with its query and each
      // row it reads, as treeRows counts them. Past what the page has left
      // the name waits for a later run ('skipped'), and once the allowance
      // is spent the names left wait without a read. Past what one change
      // may update, which only a read with the whole allowance finds, a
      // person must shorten it after some access goes ('reported'), as a
      // rename in the app is refused. That read spends one of REPORTS
      // instead, so the names after it still fit, and with none left a
      // name that would read the whole allowance waits.
      let reach: Doc<'project_reach'>[] = []
      if (table === 'projects' && typeof found.patch?.name === 'string') {
        const named = found.rows.find((row) => row.field === 'name')
        const wait = (outcome: Outcome) => {
          if (named !== undefined) named.outcome = outcome
        }
        const fresh = reachLeft === LIMITS.projectTreeChange.max
        if (reachLeft < 1 || (fresh && reportsLeft < 1)) {
          wait('skipped')
          continue
        }
        const read = await ctx.db
          .query('project_reach')
          .withIndex('by_project_grantee', (q) => q.eq('project_id', doc.id))
          .take(reachLeft)
        const cost = 1 + read.length
        if (fresh && cost > reachLeft) {
          reportsLeft -= 1
          wait('reported')
          continue
        }
        reachLeft -= cost
        if (reachLeft < 0) {
          wait('skipped')
          continue
        }
        const org = 'org_id' in doc ? doc.org_id : undefined
        reach = read.filter((row) => row.org_id === org)
      }
      if (found.patch === null || write === null) continue
      const { name } = found.patch
      const keyed =
        table === 'projects' ||
        table === 'teams' ||
        table === 'profiles' ||
        table === 'agent_keys' ||
        table === 'mcp_tokens'
      if (typeof name === 'string' && keyed) found.patch.name_key = nameKey(name)
      await write.db.patch(table, _id, found.patch)
      if (typeof name === 'string' && (table === 'teams' || table === 'profiles'))
        await copyNameKey(write, table, { ...doc, name }, copies)
      // the Storage by project breakdown shows the project's current name
      if ('num' in doc && 'org_id' in doc && typeof name === 'string')
        await renameProjectTotals(write, { id: doc.id, org_id: doc.org_id, num: doc.num, name })
      if (typeof name === 'string' && table === 'projects')
        await patchRows(write, reach, { name_key: nameKey(name) })
    }
    return { rows, cursor: page.continueCursor, done: page.isDone }
  }
  if (phase === 'labels') {
    const page = await ctx.db.query('labels').paginate(opts)
    // the names this page gave, so a dry run shows the collisions a real
    // run would meet
    const given = new Set<string>()
    for (const doc of page.page) {
      const [change] = nameChange(doc.name, LIMITS.labelName.max)
      if (change === undefined) continue
      const name = change.value as string
      const nameLower = name.toLowerCase()
      // label names are unique per organization; a cut that meets another
      // label's name is left for a person to rename
      const taken =
        given.has(`${doc.org_id}:${nameLower}`) ||
        (await ctx.db
          .query('labels')
          .withIndex('by_org_name_lower', (q) =>
            q.eq('org_id', doc.org_id).eq('name_lower', nameLower),
          )
          .first()) !== null
      const outcome = taken ? 'skipped' : write ? 'fixed' : 'would_fix'
      rows.push({ table: phase, id: doc._id, field: 'name', length: change.length, outcome })
      if (taken) continue
      given.add(`${doc.org_id}:${nameLower}`)
      await write?.db.patch('labels', doc._id, { name, name_lower: nameLower })
    }
    return { rows, cursor: page.continueCursor, done: page.isDone }
  }
  if (phase === 'emails') {
    const page = await ctx.db.query('profiles').paginate(opts)
    const given = new Set<string>()
    for (const doc of page.page) {
      if (doc.email === undefined) continue
      const email = cleanEmail(doc.email)
      if (email === doc.email) continue
      const found = { table: 'profiles', id: doc._id, field: 'email', length: doc.email.length }
      // an address over the limit, not one address at all or one a password
      // login cannot use is a person's to correct: a cut or rewritten
      // address is a different address
      if (email === null) {
        rows.push({ ...found, outcome: 'reported' })
        continue
      }
      // one seat per address in an organization; a seat whose punycode form
      // another seat already holds is left for a person to merge
      const holder = await ctx.db
        .query('profiles')
        .withIndex('by_org_email', (q) => q.eq('org_id', doc.org_id).eq('email', email))
        .first()
      const taken =
        given.has(`${doc.org_id}:${email}`) || (holder !== null && holder._id !== doc._id)
      rows.push({ ...found, outcome: taken ? 'skipped' : write ? 'fixed' : 'would_fix' })
      if (taken) continue
      given.add(`${doc.org_id}:${email}`)
      await write?.db.patch('profiles', doc._id, { email })
    }
    return { rows, cursor: page.continueCursor, done: page.isDone }
  }
  if (phase === 'issues') return await taskPage(ctx, cursor, write, pageSize)
  const table = phase
  const page = await ctx.db.query(table).paginate(opts)
  for (const doc of page.page) {
    const { _id, _creationTime, ...body } = doc
    const found = sorted(table, _id, storedChanges({ table, doc: body } as StoredRow), write)
    rows.push(...found.rows)
    if (found.patch !== null) await write?.db.patch(table, _id, found.patch)
  }
  return { rows, cursor: page.continueCursor, done: page.isDone }
}

const vPageSize = v.optional(v.number())

/** One page of one phase in its own transaction: fixes the rows that break a
 * rule, or only reports them with `dry_run`. It answers the tasks whose
 * descriptions `fix` stores trimmed after it (describe). */
export const page = internalMutation({
  args: {
    phase: vPhase,
    dry_run: v.boolean(),
    cursor: v.union(v.string(), v.null()),
    page_size: vPageSize,
  },
  handler: async (ctx, { phase, dry_run, cursor, page_size }): Promise<PageResult> =>
    await walk(ctx, phase, cursor, dry_run ? null : ctx, page_size),
})

/** Stores the description of task `id` trimmed in both copies
 * (model/descriptions.ts patchTask), once a page of the fix found its text
 * (textCopiesOf) untrimmed. A description that a trim leaves over
 * TEXT_MAX, or that changed since, stays as it is, and so does one whose
 * copies differ, as the page leaves it. */
export const describe = internalMutation({
  args: { id: v.id('issues') },
  handler: async (ctx, { id }): Promise<null> => {
    const task = await ctx.db.get(id)
    if (task === null) return null
    const { text, differs } = await textCopiesOf(ctx.db, task)
    if (differs) return null
    const description = trimMarkdown(text)
    if (description !== text && description.length <= TEXT_MAX)
      await patchTask(ctx.db, task, { description })
    return null
  },
})

/** Reports, without writing, the rows of one page of `phase` that break a
 * rule. Leave out `cursor`, or pass null, for the first page, then call
 * again with the returned `cursor` until `done`. */
export const check = internalQuery({
  args: {
    phase: vPhase,
    cursor: v.optional(v.union(v.string(), v.null())),
    page_size: vPageSize,
  },
  handler: async (ctx, { phase, cursor, page_size }): Promise<PageResult> =>
    await walk(ctx, phase, cursor ?? null, null, page_size),
})

/** The most rows fix lists, far below Convex's 8,192 values per array, so
 * a run that finds more still answers. `counts` covers every row. */
const ROWS_LISTED = 2_000

/** Walks every page of every phase and answers what it did to each row it
 * found, or would do in a dry run: `counts` per table, field and outcome,
 * and the first ROWS_LISTED rows with `unlisted` the rest. */
export const fix = internalAction({
  args: { dry_run: v.boolean(), page_size: vPageSize },
  handler: async (
    ctx,
    { dry_run, page_size },
  ): Promise<{
    dry_run: boolean
    counts: Record<string, number>
    rows: Found[]
    unlisted: number
  }> => {
    const rows: Found[] = []
    const counts: Record<string, number> = {}
    let unlisted = 0
    for (const phase of PHASES) {
      let cursor: string | null = null
      for (;;) {
        const result: PageResult = await ctx.runMutation(pageRef, {
          phase,
          dry_run,
          cursor,
          page_size,
        })
        // each in its own transaction, so a page writes no description row
        for (const id of result.describe ?? []) await ctx.runMutation(describeRef, { id })
        for (const row of result.rows) {
          const key = `${row.table}.${row.field} ${row.outcome}`
          counts[key] = (counts[key] ?? 0) + 1
          if (rows.length < ROWS_LISTED) rows.push(row)
          else unlisted += 1
        }
        if (result.done) break
        cursor = result.cursor
      }
    }
    return { dry_run, counts, rows, unlisted }
  },
})
