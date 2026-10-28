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
 * another row, or 'reported' when only a person can fix it. A dry run sees
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
 * activity. A task's trimmed description is stored with its description
 * row (model/descriptions.ts) in a transaction of its own (describe), so a
 * page never reads a description row, whose bytes its maximumBytesRead
 * would not count. Running it again is safe, and a deployment that needs
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
import { byId } from '../lib/db'
import { cleanEmail } from '../lib/email'
import { cutText, LIMITS, NAME_MAX, TEXT_MAX, trimMarkdown } from '../lib/limits'
import { nameKey } from '../lib/nameKey'
import { patchTask } from '../model/descriptions'
import { copyNameKey, inlineBudget } from '../model/nameKeys'
import { patchRows, treeRows } from '../model/projectNav'
import { renameProjectTotals } from '../model/storageTotals'

/** Rows per page and the bytes one page may read; a page can end early.
 * `page_size` lowers the rows per page, for tests of a walk over pages. */
const PAGE = 500
const PAGE_BYTES = 4 * 1024 * 1024

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
    case 'issues': {
      // remaining hours down to the cap, and the description trimmed, or
      // reported when it is over TEXT_MAX
      const changes: Change[] = []
      const hours = row.doc.remaining_hours
      const max = LIMITS.remainingHours.max
      if (hours !== undefined && hours > max)
        changes.push({ field: 'remaining_hours', length: hours, value: max })
      const description = trimMarkdown(row.doc.description ?? '')
      if (description.length > TEXT_MAX)
        changes.push({ field: 'description', length: description.length })
      else if (description !== (row.doc.description ?? ''))
        changes.push({ field: 'description', length: description.length, value: description })
      return changes
    }
    default:
      return []
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
  pageSize = PAGE,
): Promise<PageResult> {
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
    // page (model/nameKeys.ts)
    const copies = inlineBudget()
    for (const doc of page.page) {
      const { _id, _creationTime, ...body } = doc
      const changes =
        table === 'projects'
          ? storedChanges({ table, doc: body } as StoredRow)
          : nameChange(doc.name, NAME_MAX)
      const found = sorted(table, _id, changes, write)
      rows.push(...found.rows)
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
      // a cut project name's reach rows copy its key too (model/projectNav.ts),
      // refused past LIMITS.projectTreeChange as a rename is
      const project =
        typeof name === 'string' && table === 'projects'
          ? await byId(write, 'projects', doc.id)
          : null
      if (project !== null)
        await patchRows(write, await treeRows(write, project.org_id, [project.id]), {
          name_key: nameKey(project.name),
        })
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
  if (phase === 'issues') {
    const page = await ctx.db.query('issues').paginate(opts)
    const describe: Id<'issues'>[] = []
    for (const doc of page.page) {
      const { _id, _creationTime, ...body } = doc
      const found = sorted('issues', _id, storedChanges({ table: 'issues', doc: body }), write)
      rows.push(...found.rows)
      if (found.patch === null || write === null) continue
      const { remaining_hours, description } = found.patch
      if (typeof remaining_hours === 'number')
        await write.db.patch('issues', _id, { remaining_hours })
      if (typeof description === 'string') describe.push(_id)
    }
    return { rows, cursor: page.continueCursor, done: page.isDone, describe }
  }
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

/** Stores the description of task `id` trimmed, with its description row
 * (model/descriptions.ts), once a page of the fix found it untrimmed. A
 * description that a trim leaves over TEXT_MAX, or that changed since,
 * stays as it is. */
export const describe = internalMutation({
  args: { id: v.id('issues') },
  handler: async (ctx, { id }): Promise<null> => {
    const task = await ctx.db.get(id)
    if (task?.description === undefined) return null
    const description = trimMarkdown(task.description)
    if (description !== task.description && description.length <= TEXT_MAX)
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
        // each in its own transaction, so a page reads no description row
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
