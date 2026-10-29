/* One-time migration that clears the legacy `icon` and `icon_color` of
 * projects and teams (schema.ts), so a later release can drop both from the
 * schema. No release since v0.1.15 (31ece0f) takes them, and nothing shows
 * or exports them (lib/workspaceParts.ts iconFree, model/orgExportRead.ts
 * exportRow), but a value stored before has no length limit. One such row
 * can come close to Convex's 1 MiB document size, and the readers of
 * projects and teams budget for that until the fields are gone. A restore
 * from Deleted items leaves them out (model/deletedItems.ts cleanProject),
 * so nothing brings a cleared value back.
 *
 * A run walks three phases in turn, each one table in its own index order,
 * which a clear never changes, so a page cursor stays valid. The live
 * projects and the live teams go first, each in creation order, then the
 * project copies Deleted items keeps (deleted_rows by_row, table
 * 'projects'), which Convex validates against the same project validator. A
 * project moved to Deleted items before the walk reached its live row is a
 * stored copy when the last phase starts, and one moved after is clean
 * already, so one full run leaves none. Teams have no stored copies
 * (lib/enums.ts STORED_TABLES). A clear unsets both fields and changes
 * nothing else on the row, its creation time included.
 *
 * Read the dry run first. It writes nothing and reports, per phase, the
 * rows holding either field (`rows`), the rows holding each (`icon`,
 * `icon_color`), the UTF-8 bytes of the largest value of each
 * (`largest_icon`, `largest_icon_color`), never a value, and the size of
 * the largest row it walked without the two fields (`largest_row`), and
 * lists the first PAGE.listed organizations with anything found. With the
 * private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/legacyIconsBackfill:run '{"dry_run": true}'
 *   "$H" staging npx convex run internal/legacyIconsBackfill:run '{"dry_run": false}'
 * A call checks its time before every page, stops after RUN.ms, well inside
 * Convex's action time limit, and then answers `done: false` with a
 * `cursor`, an object naming the phase and the place in it. Call it again
 * with the same arguments and `"cursor"` set to that object until `done` is
 * true. A page that throws stops the call with `error` and the cursor of
 * that page, so a call with that cursor tries the page again. A dry run's
 * cursor does not resume a run that writes, nor the reverse. Then check that
 * a second full dry run reports zero rows in every phase. `check` reads one
 * page of one phase without writing, for a key that may only run internal
 * queries. Pass the returned `cursor` back until `done`, for each phase:
 *   "$H" staging npx convex run internal/legacyIconsBackfill:check '{"phase": "projects"}'
 *
 * Run it only after the deployment serves this release, and only with the
 * owner's approval. On production, take and verify a backup of the
 * deployment first (`npx convex export`, checked with `unzip -t`,
 * docs/deployment.md). Only that backup keeps the cleared values, because
 * an organization export leaves both fields out. On the demo, whose stored
 * key cannot run internal functions, the private with-temp-deploy-key
 * helper runs each command with a short-lived key. `run`, an internal
 * action, needs deployment:functions:runInternalActions in both modes, and
 * `check` deployment:functions:runInternalQueries, so a key limited to
 * internal queries reads the dry run page by page through `check`.
 *
 * A call that is not a dry run adds one platform_audit_log row (action
 * 'legacy_icons_backfill', actor 'system') with the rows it cleared per
 * phase, whether it finished, its cursor and its error, also when a page
 * threw. Running it again is safe, and a cleared deployment's dry run
 * reports zeros. A release before this one writes a stored copy back whole,
 * so after a rollback to one of them and forward again, read the dry run
 * again, because its restores can bring a field back from a copy the run
 * had not cleared yet. It writes no activity, sends no task event and changes
 * nothing an organization's people see. The approximate data size Qivo
 * Admin shows for an organization shrinks. Once every deployment reports
 * zero, the release after drops both fields from the schema, and this
 * module with them. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Infer, type Value, v } from 'convex/values'
import type { MutationCtx, QueryCtx } from '../_generated/server'
import { internalAction, internalMutation, internalQuery } from '../_generated/server'
import { MIB } from '../lib/limits'
import { audit as writeAudit } from '../model/admin'

declare class TextEncoder {
  encode(value: string): Uint8Array
}

/** Rows one page reads, the bytes it reads before it ends early, and the
 * most organizations a run lists. A row with a legacy icon can come close
 * to Convex's 1 MiB document size, so a page reads at most `bytes` and one
 * document past it, under 5 MiB. Convex reads a document again to patch
 * it, so a page that clears every row it read reads under 10 MiB, inside
 * Convex's 16 MiB, and writes no more bytes than it read. It reads at most
 * twice `rows` documents and one more, in one index range for the page and
 * one for each patch, and writes at most `rows` documents. Tests lower
 * them. */
export const PAGE = { rows: 200, bytes: 4 * MIB, listed: 100 }

/** How long one call of run goes on before it answers where to go on from.
 * Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

/** The phases a run walks, in order: the live projects, the live teams and
 * the project copies Deleted items keeps. */
const PHASES = ['projects', 'teams', 'deleted_projects'] as const
type Phase = (typeof PHASES)[number]
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))

/** What a walk of one phase found: the rows holding either field, the rows
 * holding each, the UTF-8 bytes of the largest value of each, and the size
 * of the largest row it walked, holding the fields or not, measured without
 * them (getDocumentSize, a stored copy as its project document). */
type Found = {
  rows: number
  icon: number
  icon_color: number
  largest_icon: number
  largest_icon_color: number
  largest_row: number
}
const nothing = (): Found => ({
  rows: 0,
  icon: 0,
  icon_color: 0,
  largest_icon: 0,
  largest_icon_color: 0,
  largest_row: 0,
})

/** `total` and `more` together: the counts summed, the largest sizes
 * kept. */
const sum = (total: Found, more: Found): Found => ({
  rows: total.rows + more.rows,
  icon: total.icon + more.icon,
  icon_color: total.icon_color + more.icon_color,
  largest_icon: Math.max(total.largest_icon, more.largest_icon),
  largest_icon_color: Math.max(total.largest_icon_color, more.largest_icon_color),
  largest_row: Math.max(total.largest_row, more.largest_row),
})

/** What one page found, the organizations of the rows it found, where the
 * next page starts and whether the phase is done. */
type PageResult = Found & { orgs: string[]; cursor: string; done: boolean }

/** A project or team, live or stored, as far as the legacy fields go. */
type Held = { org_id: string; icon?: string; icon_color?: string }

/* How many bytes `value` takes in UTF-8. */
const utf8 = (value: string | undefined): number =>
  value === undefined ? 0 : new TextEncoder().encode(value).length

/* Counts `row` into `found`, with `rest`, the row without the two fields,
 * toward the largest row. Answers whether `row` holds either field. */
function tally(found: Found, row: Held, rest: Record<string, Value>): boolean {
  found.largest_row = Math.max(found.largest_row, getDocumentSize(rest))
  if (row.icon === undefined && row.icon_color === undefined) return false
  found.rows += 1
  if (row.icon !== undefined) found.icon += 1
  if (row.icon_color !== undefined) found.icon_color += 1
  found.largest_icon = Math.max(found.largest_icon, utf8(row.icon))
  found.largest_icon_color = Math.max(found.largest_icon_color, utf8(row.icon_color))
  return true
}

/** One page of `phase` from `cursor`: what its rows hold and, unless
 * `write` is null, clears both fields on each row that holds one. The
 * check and the clear share it, so both find the same rows. Exported for
 * the tests, which measure a page as `page` runs it. */
export async function walk(
  ctx: QueryCtx,
  phase: Phase,
  cursor: string | null,
  write: MutationCtx | null,
): Promise<PageResult> {
  const opts = { cursor, numItems: PAGE.rows, maximumBytesRead: PAGE.bytes }
  const found = nothing()
  const orgs = new Set<string>()
  const ended = (page: { continueCursor: string; isDone: boolean }): PageResult => ({
    ...found,
    orgs: [...orgs],
    cursor: page.continueCursor,
    done: page.isDone,
  })
  if (phase === 'deleted_projects') {
    const page = await ctx.db
      .query('deleted_rows')
      .withIndex('by_row', (q) => q.eq('table', 'projects'))
      .paginate(opts)
    for (const stored of page.page) {
      if (stored.row.table !== 'projects') continue
      const { icon: _icon, icon_color: _iconColor, ...doc } = stored.row.doc
      if (!tally(found, stored.row.doc, doc)) continue
      orgs.add(stored.org_id)
      // the stored document without the two keys, as retiredFields rewrote
      // attachment copies
      await write?.db.patch(stored._id, { row: { table: 'projects', doc } })
    }
    return ended(page)
  }
  const page = await ctx.db.query(phase).paginate(opts)
  for (const row of page.page) {
    const { icon: _icon, icon_color: _iconColor, ...rest } = row
    if (!tally(found, row, rest)) continue
    orgs.add(row.org_id)
    // ctx.db.patch unsets a key whose value is undefined
    await write?.db.patch(row._id, { icon: undefined, icon_color: undefined })
  }
  return ended(page)
}

/** Clears one page of `phase` from `cursor`, in its own transaction. */
export const page = internalMutation({
  args: { phase: vPhase, cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { phase, cursor }): Promise<PageResult> =>
    await walk(ctx, phase, cursor, ctx),
})

/** Reports, without writing, what one page of `phase` holds. Leave out
 * `cursor`, or pass null, for the first page, then call again with the
 * returned `cursor` until `done`. */
export const check = internalQuery({
  args: { phase: vPhase, cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { phase, cursor }): Promise<PageResult> =>
    await walk(ctx, phase, cursor ?? null, null),
})

/** Where a call of run goes on: a phase and a page cursor in it, null for
 * its first page. It names the dry_run of the call that answered it, so a
 * dry run's cursor cannot resume a run that writes. */
const vRunCursor = v.object({
  dry_run: v.boolean(),
  phase: vPhase,
  cursor: v.union(v.string(), v.null()),
})
type RunCursor = Infer<typeof vRunCursor>

/** What a call that is not a dry run records: the rows it cleared per
 * phase, whether it finished, where to go on from and the error that
 * stopped it, if one did. */
const vRecord = {
  projects: v.number(),
  teams: v.number(),
  deleted_projects: v.number(),
  done: v.boolean(),
  cursor: v.union(vRunCursor, v.null()),
  error: v.optional(v.string()),
}
type RunRecord = Infer<ReturnType<typeof v.object<typeof vRecord>>>

/** Records a call of run that was not a dry run. */
export const audit = internalMutation({
  args: vRecord,
  handler: async (ctx, record) => {
    await writeAudit(ctx, {
      actor_email: 'system',
      action: 'legacy_icons_backfill',
      detail: record,
    })
    return null
  },
})

type PageArgs = { phase: Phase; cursor: string | null }
const pageRef = makeFunctionReference<'mutation', PageArgs, PageResult>(
  'internal/legacyIconsBackfill:page',
)
const checkRef = makeFunctionReference<'query', PageArgs, PageResult>(
  'internal/legacyIconsBackfill:check',
)
const auditRef = makeFunctionReference<'mutation', RunRecord, null>(
  'internal/legacyIconsBackfill:audit',
)

/** Walks every phase from `cursor` on, a page per transaction, and clears
 * both fields, or with `dry_run` only reports them through `check`.
 * Answers per phase what the call's pages found (`tables`, counts summed
 * and largest sizes kept) and the first PAGE.listed organizations with
 * anything found. Past RUN.ms it stops before the next page, after one page
 * at least, and answers the `cursor` to go on from, else `done`. A page
 * that throws stops the call with `error` and the cursor of that page. A
 * call that is not a dry run ends with its audit row, which records what
 * committed, whether the call finished and where to go on from. */
export const run = internalAction({
  args: { dry_run: v.boolean(), cursor: v.optional(vRunCursor) },
  handler: async (ctx, { dry_run, cursor: from }) => {
    if (from !== undefined && from.dry_run !== dry_run)
      throw new Error('this cursor is from a call with the other dry_run')
    const until = Date.now() + RUN.ms
    const tables: Record<Phase, Found> = {
      projects: nothing(),
      teams: nothing(),
      deleted_projects: nothing(),
    }
    const orgs = new Set<string>()
    let paged = false
    // the next page, which a call that stops answers as its cursor
    let next: RunCursor = from ?? { dry_run, phase: PHASES[0], cursor: null }
    let done = false
    let error: string | undefined
    try {
      // a call always takes one page, so every call makes progress
      while (!paged || Date.now() < until) {
        const args: PageArgs = { phase: next.phase, cursor: next.cursor }
        const got: PageResult = dry_run
          ? await ctx.runQuery(checkRef, args)
          : await ctx.runMutation(pageRef, args)
        paged = true
        const { orgs: found, cursor, done: phaseDone, ...counts } = got
        tables[next.phase] = sum(tables[next.phase], counts)
        for (const org of found) if (orgs.size < PAGE.listed) orgs.add(org)
        const after = PHASES[PHASES.indexOf(next.phase) + 1]
        if (!phaseDone) next = { dry_run, phase: next.phase, cursor }
        else if (after !== undefined) next = { dry_run, phase: after, cursor: null }
        else {
          done = true
          break
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const cursor = done ? null : next
    const failed = error === undefined ? {} : { error }
    if (!dry_run)
      await ctx.runMutation(auditRef, {
        projects: tables.projects.rows,
        teams: tables.teams.rows,
        deleted_projects: tables.deleted_projects.rows,
        done,
        cursor,
        ...failed,
      })
    return { dry_run, tables, orgs: [...orgs], done, cursor, ...failed }
  },
})
