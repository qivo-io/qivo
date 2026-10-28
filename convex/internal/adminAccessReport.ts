/* Read-only report of what each organization admin keeps and loses once
 * admin status stops giving access to project work (qivo-internal
 * docs/limits-plan.md, "Admin project management and ordinary task
 * access"). Today lib/access.ts levelUnder and levelsFrom, and the app's
 * levelOnProject (src/store/planner.ts), give an admin `lead` on every
 * project of a meta tree of their organization, and every task read,
 * assignment, notification, webhook and REST or MCP call follows that.
 * After the split an admin still manages every project from Settings, but
 * sees and works on only the projects ordinary access reaches: leadership,
 * individual grants, team shares and a parent's grants and shares. Nothing
 * here writes or changes a permission.
 *
 * An admin's ordinary level is the level rule without its admin branch,
 * the level a standard user with the same rows holds (ordinaryOf). For
 * every active admin it finds:
 *   leaves      a live project of a meta tree whose top-level project is
 *               live too, which they would no longer see.
 *   read_only   such a project they would see as a Viewer only. On a
 *               sub-project they can no longer change its tasks. On a
 *               top-level project they can no longer change its
 *               milestones, which model/milestones.ts lets only User and
 *               above write.
 *   navigation_only
 *               a top-level project they would see only because they reach
 *               one of its sub-projects, by a grant, a team share or as its
 *               lead. It stays in their navigation as a Viewer, so it does
 *               not leave, but they can no longer change its milestones.
 *               Its other sub-projects are reported on their own.
 *   unchecked   a top-level project they would see only through one of
 *               its sub-projects, if at all, when its sub-projects (SUBS)
 *               or the admin's own grants, team memberships and team
 *               shares (OWN) are more than a page reads to tell. Check it
 *               by hand. Also,
 *               once in each phase and without an admin or project, an
 *               organization with more than ADMINS_MOST admins, which the
 *               report leaves out.
 *   held_task   an open task they are the assignee or reviewer of (not
 *               Done, not archived, in a live project under a live
 *               top-level project), in a project they would no longer see
 *               (`sight: 'none'`) or would see as a Viewer only
 *               (`'viewer'`), where they can no longer change it. A task
 *               that older code stored on a top-level project, rather than
 *               on a sub-project, is judged by the admin's level there,
 *               'viewer' when they see that project for navigation only and
 *               'unchecked' when SUBS or OWN keep a page from telling. A
 *               reviewer of a task with active subtasks counts too. The
 *               removal of someone's access treats such a reviewer as
 *               dormant (model/projectAccess.ts removeAndFindLost), a
 *               precision this report does not need.
 *   follow      a follow of an unarchived task in a live project under a
 *               live top-level project, Done tasks included, as their
 *               followers still get their notifications, in a project they
 *               would no longer see. After the split they stop getting
 *               that task's notifications. `sight` is 'none', or
 *               'unchecked' as for held_task. A follow of a task restored
 *               from the archive keeps its archive mark (schema.ts
 *               task_archived) until a background step clears it, so the
 *               report reads the marked follows too and asks the task.
 *   webhook     an unexpired webhook subscription they own, disabled ones
 *               included, as registering one again enables it. Events are
 *               filtered by profileCanSeeProject (webhooks.ts,
 *               model/taskEvents.ts), so after the split it stops
 *               delivering the events of the projects that leave, without
 *               a word. A subscription whose owner can never authorize it
 *               again, as its credential was revoked, expired or replaced
 *               or its login or app is gone (model/webhookOwners.ts
 *               ownerStandings), delivers nothing today and is left out.
 *               `standing` is 'suspended' while Qivo refuses its owner for
 *               now, as for a banned login or a disabled app, and on the
 *               demo, which sends no events, else 'live'. `scope` is 'task'
 *               when its filters name a task,
 *               'project' when they name only a project (a sub-project, as
 *               webhooks.ts authorizeFilters refuses a top-level one), else
 *               'org'. `affected` says whether that task's or that
 *               project's project leaves, false also where it is gone or
 *               reaches nobody today, or where the task has moved out of
 *               the project its filters also name, as events must match
 *               both. It is null for 'org', to read with the admin's
 *               `leaves`, and where SUBS or OWN keep a page from telling, as
 *               for held_task.
 *   credential  the active personal tokens and approved connected apps of
 *               an admin who has any. They act as the admin over REST and
 *               MCP and lose the same projects.
 * Projects outside a meta tree carry no access for anyone, admins
 * included, so the report leaves them out. A project an admin keeps is only
 * counted (`kept`). An invitation that has not been accepted yet is an
 * active seat, and is reported like any admin. A finding names ids, keys
 * and task numbers, never a name, email, title or URL, because the runs are
 * recorded in qivo-internal.
 *
 * The `projects` phase walks the live projects (by_archived_org), each
 * organization's in creation order, and judges each one for every active
 * admin of its organization. The `work` phase walks the organizations
 * (by_uuid), their active admins in id order, and each admin's open
 * assigned tasks, open reviews, unmarked follows and marked follows in
 * creation order. The
 * `machine` phase walks each organization's webhook subscriptions, then
 * each admin's personal tokens and connected apps.
 *
 * The report ships in a release before the access split. The owner has
 * approved these releases and has said that no deployment holds real user
 * data. Each run needs the owner's approval. Once the release serves a
 * deployment that holds data (staging, the demo, production), run the
 * report there through the private helpers and give the owner the results;
 * the operator records each run's counts in qivo-internal
 * docs/verification.md. `check` is a query, so it cannot write, and a key
 * that may only run internal queries can run it. It reports one page of one
 * phase. Start with `{"phase": "projects"}`, pass the returned `cursor` back
 * until `done` is true, then do the same for "work" and "machine". `run`
 * walks the pages of every phase from its `cursor` and answers the counts
 * and the first FINDINGS_MOST findings. A call stops after RUN.ms, well
 * inside Convex's action time limit, and then answers a `cursor`; call it
 * again with `"cursor"` set to it until the cursor is null. The counts of a
 * call that goes on from a cursor add to those of the call before it. A
 * page that fails ends the call with its counts so far, `failed` set to the
 * error and the cursor of that page, so a call from it with a smaller
 * `page_size` can go on, or the operator can look into what it names. With
 * the private helper:
 *   H="${QIVO_INTERNAL_DIR:-$HOME/projects/qivo-internal}/scripts/with-deployment"
 *   "$H" staging npx convex run internal/adminAccessReport:check '{"phase": "projects"}'
 *   "$H" staging npx convex run internal/adminAccessReport:run '{}'
 * Production runs the same commands, with the owner's approval. The report
 * only reads, so it needs no backup first. On the demo, whose stored key
 * cannot run internal functions, the private with-temp-deploy-key helper
 * runs each command with a short-lived key, which is a key permission
 * change and needs the owner's approval of the command: `check` needs
 * deployment:functions:runInternalQueries and `run`, an internal action,
 * deployment:functions:runInternalActions.
 *
 * Each page reads in its own transaction, so a change between two pages
 * can be missed or seen twice. Run the report again right before the
 * release with the split. A page checks its room before each organization,
 * part of projects (PART), project, admin, task, follow and row, and ends
 * only between two creation
 * times, so its cursor can point into an organization's projects, into one
 * project's admins and into one admin's tasks, follows, tokens and apps. */
import { makeFunctionReference } from 'convex/server'
import { getDocumentSize, type Value, v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import { internalAction, internalQuery, type QueryCtx } from '../_generated/server'
import { projectLevelsOf, tokenExpired } from '../lib/access'
import { byId, usedMoreThan } from '../lib/db'
import type { AccessLevel } from '../lib/enums'
import { MIB } from '../lib/limits'
import { ownerStandings } from '../model/webhookOwners'

/** The most rows a page judges in each phase: (project, admin) pairs,
 * tasks and follows, or subscriptions, tokens and apps. Each row gives at
 * most one finding, of at most about 300 bytes as JSON, so a page answers
 * at most about 1 MiB. The room (ROOM) usually ends a page first.
 * `page_size` lowers it, for tests. */
const PAGE = { projects: 4_000, work: 2_000, machine: 2_000 }

/** The share of Convex's limits for one transaction a page uses before it
 * ends at its next row. The rest holds what a page reads past its last
 * check, which is one task of at most Convex's 1 MiB document limit, or one
 * admin's first navigation answer of the page. That answer reads the
 * admin's own rows twice (OWN), the organization's teams once
 * (lib/access.ts OWN_READS, at most 4,000 rows and 512 KiB) and the
 * parent's sub-projects twice (SUBS). Tests lower it. */
export const ROOM = { share: 0.5 }

/** The most sub-projects of one parent, and their bytes as Convex counts a
 * document's size, a page reads to tell whether an admin sees a top-level
 * project only for navigation. This report reads them first, then
 * lib/access.ts projectLevelsOf reads every one of them again for that,
 * once for each admin without a level of their own on it, so one answer
 * reads them twice beside the admin's own rows, in the half of the limits a
 * page leaves past its room (ROOM). Twice 2 MiB is half of that half's 8
 * MiB, and twice 1,000 documents an eighth of its 16,000. A sub-project
 * holds a name of at most 80 characters and a description of at most 500,
 * at most about 2.5 KiB, and may hold a legacy icon of any length, which the
 * byte bound covers. A parent with more is `unchecked`. Tests lower them. */
export const SUBS = { most: 1_000, bytes: 2 * MIB }

/** The most of an admin's own rows, their grants, team memberships and the
 * shares of those teams, a page reads before it asks whether the admin sees
 * a top-level project for navigation, with their bytes and the most teams.
 * lib/access.ts projectLevelsOf reads all of those rows for that with no
 * bound, the first time a page asks about the admin, so this report counts
 * them first with bounded reads and leaves the project `unchecked` past
 * any bound. In the half of the limits a page leaves past its room (ROOM),
 * the count and that read take twice 4,000 documents and twice 1 MiB, and
 * about three index ranges a team, so 1,500 for 500 teams, beside the
 * organization's teams (at most 4,000 rows) and SUBS. Tests lower them. */
export const OWN = { rows: 4_000, bytes: MIB, teams: 500 }

/** The most live projects of one organization the projects phase reads at
 * once, and their bytes, before it judges them. Each admin's ordinary levels
 * get the part's projects and their parents (lib/access.ts projectLevelsOf
 * `read`), so no (project, admin) pair reads its project again. A part holds
 * about as many projects as the page has pairs left for the organization's
 * admins, so a page mostly reads one part of an organization; each part
 * makes the admins' levels again, which then read their own rows again. A
 * part is read past the room check before it, so it sits beside one
 * navigation answer (ROOM, OWN, SUBS) in the half of the limits a page
 * leaves, which 1,000 documents and 1 MiB keep inside 16,000 documents and
 * 8 MiB. Tests lower them. */
export const PART = { rows: 1_000, bytes: MIB }

/** The most admins of one organization a page reads, each a profile of at
 * most about 1.5 KiB (a name of at most 80 characters and an email of at
 * most 254), so about 1.5 MiB. A page reads an organization's admins once.
 * An organization with more is `unchecked`. */
export const ADMINS_MOST = 1_000

/** The most findings `run` lists. It counts every one. */
const FINDINGS_MOST = 2_000

/** How long one call of run goes on before it answers where to go on from,
 * as the backfills' RUN. Tests lower it. */
export const RUN = { ms: 5 * 60_000 }

const PHASES = ['projects', 'work', 'machine'] as const
type Phase = (typeof PHASES)[number]
const vPhase = v.union(...PHASES.map((phase) => v.literal(phase)))

/* The parts of an organization the work and machine phases walk in turn.
 * The work phase walks each admin's open assigned tasks, open reviews,
 * follows without an archive mark and follows with one. The machine phase
 * walks the organization's webhook subscriptions, then each admin's
 * personal tokens and connected apps. */
const PARTS = {
  projects: [],
  work: ['assigned', 'reviewing', 'follows', 'marked_follows'],
  machine: ['webhooks', 'tokens', 'apps'],
} as const
type Part = (typeof PARTS)[Exclude<Phase, 'projects'>][number]

const KINDS = [
  'leaves',
  'read_only',
  'navigation_only',
  'unchecked',
  'held_task',
  'follow',
  'webhook',
  'credential',
] as const
type Kind = (typeof KINDS)[number]

/* The admin, project, key and top-level project a project finding names. */
type ProjectWhere = {
  org_id: string
  profile_id: string
  project_id: string
  key: string
  top_level_id: string
}

/** One finding (see the header). An organization's `unchecked` names
 * neither an admin nor a project. */
type Finding =
  | ({ kind: 'leaves' | 'read_only' | 'navigation_only' } & ProjectWhere)
  | {
      kind: 'unchecked'
      org_id: string
      profile_id: string | null
      project_id: string | null
      key: string | null
    }
  | {
      kind: 'held_task'
      org_id: string
      profile_id: string
      task_id: string
      num: number
      role: 'assignee' | 'reviewer'
      project_id: string
      sight: 'none' | 'viewer' | 'unchecked'
    }
  | {
      kind: 'follow'
      org_id: string
      profile_id: string
      task_id: string
      sight: 'none' | 'unchecked'
    }
  | {
      kind: 'webhook'
      org_id: string
      profile_id: string
      subscription_id: string
      standing: 'live' | 'suspended'
      scope: 'task' | 'project' | 'org'
      affected: boolean | null
    }
  | { kind: 'credential'; org_id: string; profile_id: string; tokens: number; apps: number }

/** What one page found, the rows it judged and, in the projects phase, the
 * (project, admin) pairs it found kept, and where the next page starts,
 * null once the phase is done. */
type PageResult = {
  findings: Finding[]
  checked: number
  kept: number
  cursor: string | null
  done: boolean
}

/** Where a page goes on from, as its cursor holds it as JSON. Organizations
 * before `org` are done, all of them without it. projects: `org`'s projects
 * created through `after` are done and, with `project`, that project's
 * admins through `admin` in id order. work and machine: `org`'s admins
 * before `admin` in id order are done, and of `part`, the rows created
 * through `after`, those of `admin` or for webhooks the organization's.
 * machine also carries `admin`'s active tokens and approved apps so far. */
type Cursor = {
  phase: Phase
  org?: string
  after?: number
  project?: string
  admin?: string
  part?: Part
  tokens?: number
  apps?: number
}

const isText = (value: unknown) => typeof value === 'string'
const isCount = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

/* The check of each field a cursor may hold besides its phase. */
const CURSOR_FIELDS: Record<
  Exclude<keyof Cursor, 'phase'>,
  (value: unknown, phase: Phase) => boolean
> = {
  org: isText,
  after: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  project: (value, phase) => phase === 'projects' && isText(value),
  admin: isText,
  part: (value, phase) => PARTS[phase].some((part) => part === value),
  tokens: (value, phase) => phase === 'machine' && isCount(value),
  apps: (value, phase) => phase === 'machine' && isCount(value),
}

/* The JSON `raw` holds when it is an object, else null. */
function jsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? { ...parsed }
    : null
}

/** `raw`, a cursor a page of `phase` answered, or a refusal of anything
 * else. A cursor that holds only the phase starts it. */
function parseCursor(raw: string, phase: Phase): Cursor {
  const fields = jsonObject(raw)
  if (fields === null || fields.phase !== phase)
    throw new Error(`cursor must be one a page of the ${phase} phase answered`)
  // inside a project the cursor names the last admin done, and inside an
  // admin's rows the part; the organization's webhooks name no admin, and
  // a creation time in the work and machine phases belongs to a part
  const adminPart = fields.part !== undefined && fields.part !== 'webhooks'
  const valid =
    Object.entries(fields).every(
      ([field, value]) =>
        field === 'phase' ||
        (Object.hasOwn(CURSOR_FIELDS, field) &&
          CURSOR_FIELDS[field as Exclude<keyof Cursor, 'phase'>](value, phase)),
    ) &&
    (fields.admin !== undefined) ===
      (phase === 'projects' ? fields.project !== undefined : adminPart) &&
    (phase === 'projects' || fields.after === undefined || fields.part !== undefined) &&
    (fields.org !== undefined || Object.keys(fields).length === 1)
  if (!valid) throw new Error(`cursor must be one a page of the ${phase} phase answered`)
  return fields as Cursor
}

/** The phase `raw`, a cursor of any phase, goes on in, or a refusal. */
function phaseOf(raw: string): Phase {
  const phase = jsonObject(raw)?.phase
  const known = PHASES.find((name) => name === phase)
  if (known === undefined) throw new Error('cursor must be one a call of run or check answered')
  parseCursor(raw, known)
  return known
}

/** `admin` as a standard user with the same rows. lib/access.ts treats the
 * two roles alike everywhere but the admin branch of levelUnder and
 * levelsFrom. canLeadProjects and isOrgStaff accept both, both receive team
 * access, and cappedLevel caps only viewers. So projectLevelsOf of it gives
 * the level the admin holds once that branch is gone, the ordinary level.
 * adminAccessReport.test.ts fails when those helpers start telling the two
 * roles apart. */
export const ordinaryOf = (admin: Doc<'profiles'>): Doc<'profiles'> => ({
  ...admin,
  org_role: 'user',
})

/* An admin's ordinary levels (ordinaryOf), with the projects they read. */
type Levels = ReturnType<typeof projectLevelsOf>

/* Whether `project` belongs to the meta tree of `root`, which is the
 * project itself or the top-level project above it. This is lib/access.ts
 * inMetaTree, which that module does not export. A project outside a meta
 * tree carries no access for anyone. */
const inMetaTree = (project: Doc<'projects'>, root: Doc<'projects'>): boolean =>
  root.parent_id === undefined &&
  root.type === 'meta' &&
  (project.id === root.id || project.parent_id === root.id)

/** One page of a phase: its transaction, its row budget and its time, what
 * it found so far, and the reads it caches for this page only, each
 * organization's admins, each admin's ordinary levels, whether each
 * parent's sub-projects fit SUBS and each admin's own rows OWN, and the
 * parents the projects phase reads. */
type Page = {
  ctx: QueryCtx
  size: number
  now: number
  findings: Finding[]
  checked: number
  kept: number
  /** whether the page got past a row yet, so every page gets further */
  moved: boolean
  admins: Map<string, Promise<Doc<'profiles'>[]>>
  levels: Map<string, Levels>
  subsFit: Map<string, Promise<boolean>>
  ownFits: Map<string, Promise<boolean>>
  projects: Map<string, Promise<Doc<'projects'> | null>>
}

const newPage = (ctx: QueryCtx, size: number): Page => ({
  ctx,
  size,
  now: Date.now(),
  findings: [],
  checked: 0,
  kept: 0,
  moved: false,
  admins: new Map(),
  levels: new Map(),
  subsFit: new Map(),
  ownFits: new Map(),
  projects: new Map(),
})

/** Whether `page` ends before its next row: once it got further, past its
 * size or its share of the transaction's limits. */
const full = async (page: Page): Promise<boolean> =>
  page.moved && (page.checked >= page.size || (await usedMoreThan(page.ctx, ROOM.share)))

/** The answer of `page`, which goes on from `cursor`, or is done without. */
const answer = (page: Page, cursor: Cursor | null): PageResult => ({
  findings: page.findings,
  checked: page.checked,
  kept: page.kept,
  cursor: cursor === null ? null : JSON.stringify(cursor),
  done: cursor === null,
})

/** The active admins of organization `orgId` in id order, read once a
 * page. An organization with more than ADMINS_MOST admins, active or not,
 * gets an `unchecked` finding and answers none. */
function adminsOf(page: Page, orgId: string): Promise<Doc<'profiles'>[]> {
  let known = page.admins.get(orgId)
  if (known === undefined) {
    known = page.ctx.db
      .query('profiles')
      .withIndex('by_org_role_name', (q) => q.eq('org_id', orgId).eq('org_role', 'admin'))
      .take(ADMINS_MOST + 1)
      .then((rows) => {
        if (rows.length <= ADMINS_MOST)
          return rows.filter((p) => p.active).sort((a, b) => (a.id < b.id ? -1 : 1))
        page.findings.push({
          kind: 'unchecked',
          org_id: orgId,
          profile_id: null,
          project_id: null,
          key: null,
        })
        return []
      })
    page.admins.set(orgId, known)
  }
  return known
}

/** The project with this id, of any organization, or null, read once a
 * page. */
function projectOf(page: Page, id: string): Promise<Doc<'projects'> | null> {
  let known = page.projects.get(id)
  if (known === undefined) {
    known = byId(page.ctx, 'projects', id)
    page.projects.set(id, known)
  }
  return known
}

/** The ordinary levels of `admin` (ordinaryOf), kept for the page. The
 * projects phase makes its own for each part of projects it reads
 * (PART). */
function levelsOf(page: Page, admin: Doc<'profiles'>): Levels {
  let known = page.levels.get(admin.id)
  if (known === undefined) {
    known = projectLevelsOf(page.ctx, ordinaryOf(admin))
    page.levels.set(admin.id, known)
  }
  return known
}

/** Whether the sub-projects of `parent`, archived ones included, as
 * navigation reads them, are at most SUBS.most and SUBS.bytes. Read once a
 * page, and only as far as the first row past either bound. */
function subsFit(page: Page, parent: Doc<'projects'>): Promise<boolean> {
  let known = page.subsFit.get(parent.id)
  if (known === undefined) {
    known = (async () => {
      let count = 0
      let bytes = 0
      const children = page.ctx.db
        .query('projects')
        .withIndex('by_parent', (q) => q.eq('parent_id', parent.id))
      for await (const child of children) {
        count += 1
        bytes += getDocumentSize(child)
        if (count > SUBS.most || bytes > SUBS.bytes) return false
      }
      return true
    })()
    page.subsFit.set(parent.id, known)
  }
  return known
}

/** Whether `admin`'s own rows, which lib/access.ts projectLevelsOf reads
 * all of the first time it asks whether they see a parent for navigation,
 * are within OWN. Their grants, their team memberships and the shares of
 * each of those teams, read once a page, and only as far as the first row
 * past a bound. */
function ownFits(page: Page, admin: Doc<'profiles'>): Promise<boolean> {
  let known = page.ownFits.get(admin.id)
  if (known === undefined) {
    known = (async () => {
      const { db } = page.ctx
      let rows = 0
      let bytes = 0
      /* counts `query`'s rows, answering false at the first past OWN */
      const fits = async <R extends Record<string, Value>>(
        query: AsyncIterable<R>,
        each: (row: R) => void = () => {},
      ) => {
        for await (const row of query) {
          rows += 1
          bytes += getDocumentSize(row)
          if (rows > OWN.rows || bytes > OWN.bytes) return false
          each(row)
        }
        return true
      }
      const teams: string[] = []
      if (
        !(await fits(
          db.query('project_access').withIndex('by_profile', (q) => q.eq('profile_id', admin.id)),
        )) ||
        !(await fits(
          db.query('team_members').withIndex('by_profile', (q) => q.eq('profile_id', admin.id)),
          (membership) => teams.push(membership.team_id),
        )) ||
        teams.length > OWN.teams
      )
        return false
      for (const teamId of teams) {
        const shares = db
          .query('project_team_access')
          .withIndex('by_team', (q) => q.eq('team_id', teamId))
        if (!(await fits(shares))) return false
      }
      return true
    })()
    page.ownFits.set(admin.id, known)
  }
  return known
}

/** Whether `admin` sees top-level project `project`, on which they hold no
 * level of their own, for navigation to one of its sub-projects, by
 * `levels`, their ordinary levels, or null when the reads that tell would
 * pass SUBS or OWN. */
async function seesForNavigation(
  page: Page,
  admin: Doc<'profiles'>,
  levels: Levels,
  project: Doc<'projects'>,
): Promise<boolean | null> {
  if (!(await ownFits(page, admin)) || !(await subsFit(page, project))) return null
  return (await levels.level(project.id)) !== null
}

/** `admin`'s ordinary level on `project`, under top-level project `root`,
 * by `levels`, their ordinary levels, as profileCanSeeProject decides
 * sight: 'viewer' for a top-level project they see for navigation only.
 * 'unchecked' where that takes reads past SUBS or OWN. A task older code
 * stored on a top-level project is judged this way. */
async function sightOf(
  page: Page,
  admin: Doc<'profiles'>,
  levels: Levels,
  project: Doc<'projects'>,
  root: Doc<'projects'>,
): Promise<AccessLevel | null | 'unchecked'> {
  const own = await levels.level(project.id, false)
  if (own !== null || project.id !== root.id) return own
  const navigates = await seesForNavigation(page, admin, levels, project)
  return navigates === null ? 'unchecked' : navigates ? 'viewer' : null
}

/** The top-level project of `project` when both are in one meta tree of
 * organization `orgId`, where its admins reach it today, else null. With
 * `live`, also null when either is archived. It reads the parent through
 * `levels`, an admin's levels, which then need not read it again. */
async function treeOf(
  levels: Levels,
  project: Doc<'projects'>,
  orgId: string,
  live: boolean,
): Promise<Doc<'projects'> | null> {
  const root = project.parent_id === undefined ? project : await levels.project(project.parent_id)
  if (root === null || project.org_id !== orgId || root.org_id !== orgId) return null
  if (!inMetaTree(project, root)) return null
  if (live && (project.archived_at !== undefined || root.archived_at !== undefined)) return null
  return root
}

/** Judges each row of `rows`, which hold the rows created after `after` in
 * creation order, with `judge`. Answers the page with the cursor `at(last)`
 * gives, `last` the creation time of the last row judged, once the page is
 * full between two creation times, else null once the rows end. */
async function walk<R extends { _creationTime: number }>(
  page: Page,
  rows: AsyncIterable<R>,
  after: number,
  judge: (row: R) => Promise<void>,
  at: (last: number) => Cursor,
): Promise<PageResult | null> {
  let last = after
  for await (const row of rows) {
    if (row._creationTime !== last && (await full(page))) return answer(page, at(last))
    await judge(row)
    page.checked += 1
    page.moved = true
    last = row._creationTime
  }
  return null
}

/** Judges what `admin` keeps of live project `project` under top-level
 * project `root`, by `levels`, their ordinary levels. */
async function judgeProject(
  page: Page,
  admin: Doc<'profiles'>,
  levels: Levels,
  project: Doc<'projects'>,
  root: Doc<'projects'>,
): Promise<void> {
  const where: ProjectWhere = {
    org_id: project.org_id,
    profile_id: admin.id,
    project_id: project.id,
    key: project.key,
    top_level_id: root.id,
  }
  const own = await levels.level(project.id, false)
  if (own === 'viewer') {
    page.findings.push({ kind: 'read_only', ...where })
    return
  }
  if (own !== null) {
    page.kept += 1
    return
  }
  // a top-level project may still show for navigation to a sub-project
  if (project.id === root.id) {
    const navigates = await seesForNavigation(page, admin, levels, project)
    if (navigates === null) {
      page.findings.push({
        kind: 'unchecked',
        org_id: project.org_id,
        profile_id: admin.id,
        project_id: project.id,
        key: project.key,
      })
      return
    }
    if (navigates) {
      page.findings.push({ kind: 'navigation_only', ...where })
      return
    }
  }
  page.findings.push({ kind: 'leaves', ...where })
}

/** The live projects of organization `orgId` created after `after`, in
 * creation order. */
const liveProjects = (ctx: QueryCtx, orgId: string, after: number) =>
  ctx.db
    .query('projects')
    .withIndex('by_archived_org', (q) =>
      q.eq('archived_at', undefined).eq('org_id', orgId).gt('_creationTime', after),
    )

/** The next part of organization `orgId`'s live projects created after
 * `after`, at most `most` of them and PART.bytes, and with them every other
 * project created at the last one's time, as the next part starts after
 * that time. `more` is false once the part holds the rest. */
async function projectPart(
  ctx: QueryCtx,
  orgId: string,
  after: number,
  most: number,
): Promise<{ rows: Doc<'projects'>[]; more: boolean }> {
  const rows: Doc<'projects'>[] = []
  let bytes = 0
  for await (const project of liveProjects(ctx, orgId, after)) {
    rows.push(project)
    bytes += getDocumentSize(project)
    if (rows.length >= most || bytes >= PART.bytes) {
      const last = project._creationTime
      const tied = ctx.db
        .query('projects')
        .withIndex('by_archived_org', (q) =>
          q.eq('archived_at', undefined).eq('org_id', orgId).eq('_creationTime', last),
        )
      for await (const same of tied) if (!rows.some((row) => row._id === same._id)) rows.push(same)
      return { rows, more: true }
    }
  }
  return { rows, more: false }
}

/** The first organization after `orgId`, or the first of all without it,
 * that holds a live project. */
async function nextProjectOrg(ctx: QueryCtx, orgId?: string): Promise<string | null> {
  const project = await ctx.db
    .query('projects')
    .withIndex('by_archived_org', (q) => {
      const live = q.eq('archived_at', undefined)
      return orgId === undefined ? live : live.gt('org_id', orgId)
    })
    .first()
  return project?.org_id ?? null
}

/** One page of the projects phase from `at`. */
async function projectsPage(page: Page, at: Cursor): Promise<PageResult> {
  const { ctx } = page
  let orgId = at.org ?? (await nextProjectOrg(ctx))
  let after = at.after ?? 0
  // the project the page goes on inside of, and its last admin done
  let inside = at.project === undefined ? null : { project: at.project, admin: at.admin ?? '' }
  while (orgId !== null) {
    const org = orgId
    if (await full(page)) return answer(page, { phase: 'projects', org, after })
    const admins = await adminsOf(page, org)
    let last = after
    // an organization without active admins has nothing to judge
    for (let more = admins.length > 0; more; ) {
      if (await full(page)) return answer(page, { phase: 'projects', org, after: last })
      // about as many projects as the page has pairs left
      const most = Math.min(
        PART.rows,
        Math.max(1, Math.ceil((page.size - page.checked) / admins.length)),
      )
      const part = await projectPart(ctx, org, last, most)
      more = part.more
      // each admin's levels read neither these projects nor their parents
      const known = [...part.rows]
      const parents = new Set(part.rows.flatMap((p) => p.parent_id ?? []))
      for (const row of part.rows) parents.delete(row.id)
      for (const id of parents) {
        const parent = await projectOf(page, id)
        if (parent !== null) known.push(parent)
      }
      const levels = admins.map((admin) => projectLevelsOf(ctx, ordinaryOf(admin), known))
      for (const project of part.rows) {
        // a page ends only between two creation times
        const apart = project._creationTime !== last
        if (apart && (await full(page)))
          return answer(page, { phase: 'projects', org, after: last })
        const root = await treeOf(levels[0], project, org, true)
        // the last admin done with this project, by this page or the one
        // before
        let done = inside?.project === project.id ? inside.admin : null
        if (root !== null)
          for (const [i, admin] of admins.entries()) {
            if (done !== null && admin.id <= done) continue
            if (done !== null && apart && (await full(page)))
              return answer(page, {
                phase: 'projects',
                org,
                after: last,
                project: project.id,
                admin: done,
              })
            await judgeProject(page, admin, levels[i], project, root)
            page.checked += 1
            page.moved = true
            done = admin.id
          }
        page.moved = true
        last = project._creationTime
      }
    }
    page.moved = true
    orgId = await nextProjectOrg(ctx, org)
    after = 0
    inside = null
  }
  return answer(page, null)
}

/** The organizations from `orgId` on, in id order. */
const orgsFrom = (ctx: QueryCtx, orgId?: string) =>
  ctx.db
    .query('organizations')
    .withIndex('by_uuid', (q) => (orgId === undefined ? q : q.gte('id', orgId)))

/** The parts of `phase` for one admin from `from`, which goes on inside
 * one of them, or all of them, each with the creation time it starts
 * after. */
function partsFrom(parts: readonly Part[], from: Cursor | undefined) {
  const start = from?.part === undefined ? 0 : Math.max(0, parts.indexOf(from.part))
  return parts
    .slice(start)
    .map((part) => ({ part, after: part === from?.part ? (from.after ?? 0) : 0 }))
}

/** Reports `task`, which `admin` holds as `role`, when it is open in a live
 * project under a live top-level project that they would no longer see or
 * see as a Viewer only. */
async function judgeTask(
  page: Page,
  admin: Doc<'profiles'>,
  role: 'assignee' | 'reviewer',
  task: Doc<'issues'>,
): Promise<void> {
  if (task.status === 'done') return
  const levels = levelsOf(page, admin)
  const project = await levels.project(task.project_id)
  const root = project && (await treeOf(levels, project, admin.org_id, true))
  if (project === null || root === null) return
  const level = await sightOf(page, admin, levels, project, root)
  if (level !== null && level !== 'viewer' && level !== 'unchecked') return
  page.findings.push({
    kind: 'held_task',
    org_id: admin.org_id,
    profile_id: admin.id,
    task_id: task.id,
    num: task.num,
    role,
    project_id: project.id,
    sight: level ?? 'none',
  })
}

/** Reports `follow` of `admin` when its task is unarchived, in a live
 * project under a live top-level project, which they would no longer see. */
async function judgeFollow(
  page: Page,
  admin: Doc<'profiles'>,
  follow: Doc<'issue_subscriptions'>,
): Promise<void> {
  const task = await byId(page.ctx, 'issues', follow.issue_id)
  if (task === null || task.archived_at !== undefined) return
  const levels = levelsOf(page, admin)
  const project = await levels.project(task.project_id)
  const root = project && (await treeOf(levels, project, admin.org_id, true))
  if (project === null || root === null) return
  const level = await sightOf(page, admin, levels, project, root)
  if (level !== null && level !== 'unchecked') return
  page.findings.push({
    kind: 'follow',
    org_id: admin.org_id,
    profile_id: admin.id,
    task_id: task.id,
    sight: level ?? 'none',
  })
}

/** One page of the work phase from `at`. */
async function workPage(page: Page, at: Cursor): Promise<PageResult> {
  const { ctx } = page
  for await (const { id: org } of orgsFrom(ctx, at.org)) {
    if (await full(page)) return answer(page, { phase: 'work', org })
    const resume = at.org === org ? at : undefined
    for (const admin of await adminsOf(page, org)) {
      if (resume?.admin !== undefined && admin.id < resume.admin) continue
      const from = resume?.admin === admin.id ? resume : undefined
      if (from === undefined && (await full(page)))
        return answer(page, { phase: 'work', org, admin: admin.id, part: 'assigned' })
      for (const { part, after } of partsFrom(PARTS.work, from)) {
        const stopAt = (last: number): Cursor => ({
          phase: 'work',
          org,
          admin: admin.id,
          part,
          after: last,
        })
        const stopped =
          part === 'follows' || part === 'marked_follows'
            ? await walk(
                page,
                ctx.db.query('issue_subscriptions').withIndex('by_profile_task_archived', (q) =>
                  q
                    .eq('profile_id', admin.id)
                    .eq('task_archived', part === 'marked_follows' ? true : undefined)
                    .gt('_creationTime', after),
                ),
                after,
                (follow) => judgeFollow(page, admin, follow),
                stopAt,
              )
            : await walk(
                page,
                part === 'assigned'
                  ? ctx.db
                      .query('issues')
                      .withIndex('by_assignee_archived', (q) =>
                        q
                          .eq('assignee_id', admin.id)
                          .eq('archived_at', undefined)
                          .gt('_creationTime', after),
                      )
                  : ctx.db
                      .query('issues')
                      .withIndex('by_reviewer_archived', (q) =>
                        q
                          .eq('reviewer_id', admin.id)
                          .eq('archived_at', undefined)
                          .gt('_creationTime', after),
                      ),
                after,
                (task) =>
                  judgeTask(page, admin, part === 'assigned' ? 'assignee' : 'reviewer', task),
                stopAt,
              )
        if (stopped !== null) return stopped
      }
      page.moved = true
    }
    page.moved = true
  }
  return answer(page, null)
}

/** Reports `subscription` when an active admin of its organization in
 * `admins` owns it, it has not expired and its owner can still authorize
 * it (model/webhookOwners.ts ownerStandings). */
async function judgeWebhook(
  page: Page,
  admins: ReadonlyMap<string, Doc<'profiles'>>,
  subscription: Doc<'webhook_subscriptions'>,
): Promise<void> {
  const admin = admins.get(subscription.owner.profile_id)
  const expired = subscription.expires_at !== undefined && subscription.expires_at <= page.now
  if (admin === undefined || expired) return
  const [standing] = await ownerStandings(page.ctx, [subscription])
  if (standing === 'removed') return
  const { task_id, project_id } = subscription.filters
  const where = {
    kind: 'webhook' as const,
    org_id: subscription.org_id,
    profile_id: admin.id,
    subscription_id: subscription.id,
    standing,
  }
  if (task_id === undefined && project_id === undefined) {
    page.findings.push({ ...where, scope: 'org', affected: null })
    return
  }
  const levels = levelsOf(page, admin)
  const task = task_id === undefined ? null : await byId(page.ctx, 'issues', task_id)
  const projectId = task_id === undefined ? project_id : task?.project_id
  // events match both filters (model/taskEvents.ts), so a task moved out of
  // the project they name delivers nothing today
  const moved = task !== null && project_id !== undefined && task.project_id !== project_id
  const project = projectId === undefined || moved ? null : await levels.project(projectId)
  // a project gone, or outside the tree, delivers nothing today either
  const root = project && (await treeOf(levels, project, admin.org_id, false))
  const level =
    project === null || root === null ? 'gone' : await sightOf(page, admin, levels, project, root)
  page.findings.push({
    ...where,
    scope: task_id === undefined ? 'project' : 'task',
    affected: level === 'unchecked' ? null : level === null,
  })
}

/** One page of the machine phase from `at`. */
async function machinePage(page: Page, at: Cursor): Promise<PageResult> {
  const { ctx } = page
  for await (const { id: org } of orgsFrom(ctx, at.org)) {
    if (await full(page)) return answer(page, { phase: 'machine', org })
    const resume = at.org === org ? at : undefined
    const admins = await adminsOf(page, org)
    if (admins.length > 0 && (resume?.part ?? 'webhooks') === 'webhooks') {
      const after = resume?.after ?? 0
      const byAdmin = new Map(admins.map((admin) => [admin.id, admin]))
      const stopped = await walk(
        page,
        ctx.db
          .query('webhook_subscriptions')
          .withIndex('by_org', (q) => q.eq('org_id', org).gt('_creationTime', after)),
        after,
        (subscription) => judgeWebhook(page, byAdmin, subscription),
        (last) => ({ phase: 'machine', org, part: 'webhooks', after: last }),
      )
      if (stopped !== null) return stopped
    }
    for (const admin of admins) {
      if (resume?.admin !== undefined && admin.id < resume.admin) continue
      const from = resume?.admin === admin.id ? resume : undefined
      if (from === undefined && (await full(page)))
        return answer(page, { phase: 'machine', org, admin: admin.id, part: 'tokens' })
      const held = { tokens: from?.tokens ?? 0, apps: from?.apps ?? 0 }
      for (const { part, after } of partsFrom(['tokens', 'apps'], from)) {
        const stopAt = (last: number): Cursor => ({
          phase: 'machine',
          org,
          admin: admin.id,
          part,
          after: last,
          ...held,
        })
        const stopped =
          part === 'tokens'
            ? await walk(
                page,
                ctx.db
                  .query('mcp_tokens')
                  .withIndex('by_profile', (q) =>
                    q.eq('profile_id', admin.id).gt('_creationTime', after),
                  ),
                after,
                async (token) => {
                  if (token.revoked_at === undefined && !tokenExpired(token, page.now))
                    held.tokens += 1
                },
                stopAt,
              )
            : await walk(
                page,
                ctx.db
                  .query('oauth_connections')
                  .withIndex('by_profile', (q) =>
                    q.eq('profile_id', admin.id).gt('_creationTime', after),
                  ),
                after,
                async (app) => {
                  if (app.approved_at !== undefined && app.revoked_at === undefined) held.apps += 1
                },
                stopAt,
              )
        if (stopped !== null) return stopped
      }
      if (held.tokens > 0 || held.apps > 0)
        page.findings.push({ kind: 'credential', org_id: org, profile_id: admin.id, ...held })
      page.moved = true
    }
    page.moved = true
  }
  return answer(page, null)
}

/** One page of `phase` from `cursor`, or from the phase's start without
 * one, judging at most `size` rows. Exported for the tests, which read a
 * page's transaction metrics. */
export async function reportPage(
  ctx: QueryCtx,
  phase: Phase,
  cursor: string | null,
  size: number,
): Promise<PageResult> {
  if (!Number.isInteger(size) || size < 1)
    throw new Error('page_size must be a whole number of at least 1')
  const at = cursor === null ? { phase } : parseCursor(cursor, phase)
  const page = newPage(ctx, size)
  if (phase === 'projects') return await projectsPage(page, at)
  if (phase === 'work') return await workPage(page, at)
  return await machinePage(page, at)
}

/** Reports, without writing, one page of `phase`. Leave out `cursor`, or
 * pass null, for the first page, then call again with the returned
 * `cursor` until `done`. `checked` counts the rows the page judged:
 * (project, admin) pairs, tasks and follows, or subscriptions, tokens and
 * apps. `kept` counts the pairs whose admin keeps the project. */
export const check = internalQuery({
  args: {
    phase: vPhase,
    cursor: v.optional(v.union(v.string(), v.null())),
    page_size: v.optional(v.number()),
  },
  handler: async (ctx, { phase, cursor, page_size }): Promise<PageResult> =>
    await reportPage(ctx, phase, cursor ?? null, page_size ?? PAGE[phase]),
})

const checkRef = makeFunctionReference<
  'query',
  { phase: Phase; cursor?: string | null; page_size?: number },
  PageResult
>('internal/adminAccessReport:check')

/** Walks, without writing, the pages of every phase from `cursor`, or from
 * the projects phase's start without one, and answers how many rows it
 * checked, how many findings of each kind it made, with the kept pairs,
 * and the first FINDINGS_MOST findings, with `listed_all` false when it
 * left some out. Past RUN.ms it stops after a page, one at least, and
 * answers the `cursor` to go on from, null once every phase is done. A page
 * that throws ends the call with what it counted before, the error in
 * `failed` and that page's cursor; `failed` is null otherwise. */
export const run = internalAction({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    page_size: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { cursor: from, page_size },
  ): Promise<{
    checked: number
    counts: Record<Kind | 'kept', number>
    findings: Finding[]
    listed_all: boolean
    cursor: string | null
    failed: string | null
  }> => {
    const until = Date.now() + RUN.ms
    const counts = Object.fromEntries([...KINDS, 'kept'].map((kind) => [kind, 0])) as Record<
      Kind | 'kept',
      number
    >
    const findings: Finding[] = []
    let checked = 0
    let total = 0
    // the cursor of the next page, which names its phase
    let cursor: string | null = from ?? JSON.stringify({ phase: 'projects' })
    let phase = phaseOf(cursor)
    const report = (failed: string | null = null) => ({
      checked,
      counts,
      findings,
      listed_all: findings.length === total,
      cursor,
      failed,
    })
    for (;;) {
      let page: PageResult
      try {
        page = await ctx.runQuery(checkRef, { phase, cursor, page_size })
      } catch (e) {
        return report(e instanceof Error ? e.message : String(e))
      }
      checked += page.checked
      counts.kept += page.kept
      for (const finding of page.findings) {
        counts[finding.kind] += 1
        total += 1
        if (findings.length < FINDINGS_MOST) findings.push(finding)
      }
      if (page.done) {
        const next = PHASES[PHASES.indexOf(phase) + 1]
        if (next === undefined) {
          cursor = null
          return report()
        }
        phase = next
        cursor = JSON.stringify({ phase })
      } else cursor = page.cursor
      if (Date.now() >= until) return report()
    }
  },
})
