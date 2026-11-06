/* Shareable app routes under /app/<org>/, where <org> is a slug or `~` for
   cross-organization/account pages. Slug validation excludes `~`.

   Routes (view = overview|board|roadmap):
     <view>/tasks/<ref>        task over that view
     tasks/<ref>               task using saved view/scope
     [<view>/]p/<n>            project/sub-project scope
     <view>/all|mine           sentinel scope, optionally /tasks/<ref>
     settings/<page>           account, org-*, projects-* or team:<uuid>
     settings/project/<n>      project settings, by number or uuid
     projects                  directory
     archive                   old Archive address; opens settings/projects-archived-tasks
     inbox[/tasks/<ref>]       inbox, optionally with a task open
     sync[/all|/p/<n>|/team/<uuid>][/people/<uuid>|/agents][/tasks/<ref>]

   Team sync uses the home organization. Bare /app or /app/<org> returns null
   so App restores saved UI state instead of persisting a default view.
   Task refs accept qn-<num> (any case), bare numbers or immutable uuids;
   project refs accept numbers or uuids. Emission is lowercase. Numbers are
   org-scoped and survive moves; renamed project keys are display-only.
   A project settings page names a project the workspace holds by its
   number, and one it does not hold by its uuid under the organization the
   page's own read named (noteProjectPage), which parses back to the page
   without the workspace: the page's read (projectSettings.get) decides
   what it shows, so a reload, Back and Forward open it again.
   A task the workspace holds resolves to its handle, and one it does not
   to a reference (lib/taskReference.ts) that the task window reads from
   the server, in the organization the address names. Tasks resolve their
   own project scope except under all/mine or inbox, a reference's once
   its answer names its project (App pendingTask).
   Legacy #/ links share parseSegments and are replaced by path routes;
   unrelated hashes, including auth fragments, are ignored. */

import { parseIssueRef, UUID } from '../../convex/lib/taskRefs'
import type { AddressedTask } from '../store/liveParts'
import { ALL_SCOPE, ISSUE_PREFIX, MINE_SCOPE, P } from '../store/planner'
import type { IssueVM } from '../store/viewModels'
import { refParts, taskRef } from './taskReference'

export type Route = {
  scope?: string
  view?: string
  issue?: string
  settings?: string
  inbox?: boolean
  projects?: boolean
  /* The Team sync page. `scope` is 'all' | 'team:<uuid>' | 'project:<uuid>'
     | 'unresolved:<segment>' for a project the app cannot resolve (absent:
     the viewer's saved scope); `step` is 'agents' or a profile uuid
     (absent: the default step). Team and profile uuids pass through
     unvalidated, as `settings/team:<uuid>` does: the server answers a team
     it cannot honour as unavailable and the page asks to choose, and a step
     that resolves to nothing falls back to the opening. */
  sync?: { scope?: string; step?: string }
}

/** The prefix that separates the app from the marketing site sharing its
    origin. Fixed rather than per-organization on purpose: it keeps every org
    slug out of the marketing namespace, so `/docs` and `/pricing` can never be
    taken by a customer naming their company after one. */
export const APP_PREFIX = '/app'

/** The org segment for an address that is about no single organization. */
export const ORG_NONE = '~'

/** The Settings page that lists archived tasks, Settings › Projects ›
    Archived tasks. */
export const ARCHIVED_TASKS_PAGE = 'projects-archived-tasks'

/* The scope tokens that name no project row. Both sit where a project number
   would and share the whole URL grammar, so the parser and the builder ask
   this rather than testing one sentinel — but they are NOT interchangeable:
   the answer is the token itself, so callers compare identity (moving between
   them changes the pane, and that earns a history entry). */
const sentinelOf = (s?: string | null): string | null =>
  s === ALL_SCOPE || s === MINE_SCOPE ? s : null

// "split" and "resources" were folded into the roadmap — old links still parse
const URL_TO_VIEW: Record<string, string> = {
  overview: 'overview',
  board: 'kanban',
  kanban: 'kanban',
  roadmap: 'roadmap',
  split: 'roadmap',
  resources: 'roadmap',
}
const VIEW_TO_URL: Record<string, string> = {
  overview: 'overview',
  kanban: 'board',
  roadmap: 'roadmap',
}

/* `org` (a uuid, resolved from the address's org segment) pins which
   organization a bare number is read in. Without it both finders resolve HOME
   first, so a guest's colliding number can never hijack an unpinned link —
   which is what `~` and every legacy hash rely on. */
const findProject = (s: string | undefined, org?: string) => {
  if (!s) return undefined
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    const all = P.projects.filter((p) => p.num === n)
    if (org) return all.find((p) => p.org === org)
    return all.find((p) => p.org === P.homeOrg) || all[0]
  }
  return P.projects.find((p) => p.id === s.toLowerCase())
}
/* The task an address's task segment `s` names: its handle when the
   workspace holds it, else a reference (lib/taskReference.ts), which the
   task window reads from the server, so Back or Forward to the address of
   any task opens it again, also after a reload. A number reads only in
   the organization the address pins (`org`), or, unpinned (`~` and a
   legacy hash without one), in the home organization, never another
   organization's task with that number; a login without a home
   organization resolves none. A uuid names one task anywhere: one the
   workspace does not hold reads first in the organization the address
   names it under (`from`), since an address can name another
   organization's task by its uuid (syncPath), then in the login's other
   seats (store/planner.ts refSeats). A segment that is neither names no
   task, unless it is the handle of one the workspace holds. */
const findIssueKey = (s: string | undefined, org?: string) => {
  if (!s) return undefined
  const named = parseIssueRef(s)
  if (named && 'num' in named) {
    const key = `${ISSUE_PREFIX}-${named.num}`
    if (org) return P.issueRefIn(org, key) ?? taskRef({ org, num: named.num })
    // unpinned: the home organization's handle IS the key
    if (P.issueById[key]) return key
    return P.homeOrg ? taskRef({ org: P.homeOrg, num: named.num }) : undefined
  }
  const uuid = named && 'uuid' in named ? named.uuid : null
  const held = P.handleOf(uuid ?? s.toLowerCase())
  if (held) return held
  return uuid ? taskRef({ org: null, uuid, from: org }) : undefined
}

/** What the store knows of the task `open` names, a handle or a reference
    (lib/taskReference.ts), from its live sources only: the workspace, the
    view of the task a window shows from its own read (P.detail), and the
    read of the registered reference (P.reference). Undefined when none
    names it. */
export function taskFacts(open: string | null | undefined): TaskFacts | undefined {
  if (!open) return undefined
  // a reference is never looked up as a handle
  const ref = refParts(open)
  const detail = P.detail
  if (!ref) {
    const it = P.issueById[open]
    if (it) return factsOfView(it)
    const view = detail?.view
    return view && view.id === open ? factsOfView(view) : undefined
  }
  const read = P.reference?.ref === open ? P.reference.task : null
  const uuid = ref.uuid ?? read?.uuid
  const view = uuid && detail?.task === uuid ? detail.view : null
  if (view) return factsOfView(view)
  return {
    uuid,
    org: ref.org ?? read?.org ?? null,
    from: ref.from,
    num: ref.num ?? read?.num ?? undefined,
    project: read?.project ?? undefined,
    owner: read?.owner ?? undefined,
  }
}

/** What taskFacts knows of a task. `from` is the organization an address
    names a uuid under before a read names the task's own. */
export type TaskFacts = {
  uuid?: string
  org: string | null
  from?: string
  num?: number
  project?: string
  owner?: string | null
}

/* The facts of task view `it`. */
const factsOfView = (it: IssueVM): TaskFacts => ({
  uuid: it.uuid,
  org: it.org,
  num: Number(it.key.slice(ISSUE_PREFIX.length + 1)),
  project: it.project,
  owner: it.owner ?? null,
})

/** Whether `a` and `b`, each a handle or a reference, name the same task:
    the same uuid, or the same number in the same organization, by what the
    store knows of each (taskFacts). Two that the store cannot tell apart
    yet name different tasks. App's pending task, pathMatchesState and the
    Inbox's row choice compare by it, never by the strings. */
export function sameTask(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const x = taskFacts(a)
  const y = taskFacts(b)
  if (!x || !y) return false
  if (x.uuid && y.uuid) return x.uuid === y.uuid
  return !!x.org && x.org === y.org && x.num !== undefined && x.num === y.num
}

/** The org segment for content owned by `orgId` — its slug, or `~` when there
    is no organization to name (or none this caller can resolve, in which case
    `~` degrades to the home-first reading rather than naming the wrong one). */
const orgSegment = (orgId: string | undefined | null): string => {
  if (!orgId) return ORG_NONE
  const o = P.orgs.find((x) => x.id === orgId)
  return o?.slug ? o.slug : ORG_NONE
}

/** Organization and team settings use the home organization. Personal and
    desktop settings have no organization scope and take `~`. A project's
    page names its own organization (buildPath). */
const settingsOrg = (page: string): string | null => {
  if (page === 'account' || page.startsWith('account-') || page === 'desktop' || page === 'menu')
    return null
  return P.homeOrg || null
}

/** A task as the scope rules read it: its project and owner, from the
    workspace or from the window's read of it (taskFacts). */
export type ScopeTask = { project: string; owner?: string | null }

/** The task `open` names as the scope rules read it, once the store knows
    its project, else undefined. */
export function scopeTaskOf(open: string | null | undefined): ScopeTask | undefined {
  const facts = taskFacts(open)
  return facts?.project ? { project: facts.project, owner: facts.owner } : undefined
}

/* Scope to show behind an issue link: the preferred (saved/current) scope
   when the issue lives inside it — so the owner's reload lands exactly where
   they were — else the issue's own sub-project (a link recipient's sensible
   default). A task whose project the store does not know yet keeps the
   preferred scope. */
export const scopeForIssue = (
  it: ScopeTask | undefined,
  preferred?: string | null,
): string | undefined => {
  if (!it) return preferred || undefined
  // All projects already holds every issue this login can open — nothing to
  // narrow to, and narrowing would drop the mode on a short issue link
  if (preferred === ALL_SCOPE) return ALL_SCOPE
  /* My view does NOT hold every issue — only mine. A short link to somebody
     else's task therefore narrows to its own sub-project, keeping the promise
     that a link always lands you on a board that actually shows the task. The
     explicit .../mine/tasks/<n> form never reaches here (the parser sets the scope
     outright), so standing in the mode and opening a colleague's task from it
     keeps the mode. */
  if (preferred === MINE_SCOPE)
    return it.owner && P.myProfileIds.includes(it.owner) ? MINE_SCOPE : it.project
  if (preferred) {
    const p = P.project(preferred)
    if (
      p &&
      (p.id === it.project || (p.type === 'meta' && (p.children || []).includes(it.project)))
    )
      return preferred
  }
  return it.project
}

/* The view a task address `r` shows behind its task window, `view` being
   the one that stays where the address names none: null under the Inbox,
   which covers every view. */
export const viewBehindTask = (r: Route, view: string): string | null =>
  r.inbox ? null : r.view || view

/* The scope to show behind a task link on `view` (viewBehindTask). The
   Board and the Overview have no All projects selection (convex/tasks.ts
   board, convex/overview.ts): where scopeForIssue keeps All projects, they
   show the task's own sub-project instead, so its card or its figures can
   be shown. The Roadmap and the Inbox, which shows no view, keep All
   projects. */
export const scopeForIssueOn = (
  view: string | null,
  it: ScopeTask | undefined,
  preferred?: string | null,
): string | undefined => {
  const scope = scopeForIssue(it, preferred)
  return (view === 'kanban' || view === 'overview') && scope === ALL_SCOPE
    ? (it?.project ?? scope)
    : scope
}

/* ---------------------------------------------------------------------------
   The grammar below the prefix — shared by both parsers, so a path and a
   legacy hash can never come to mean different things.
   --------------------------------------------------------------------------- */
function parseSegments(seg: string[], org: string | undefined, orgUnknown: boolean): Route | null {
  if (!seg.length) return null // the org's front door — fall back to saved UI state
  const r: Route = {}
  const proj = (s: string | undefined) => (orgUnknown ? undefined : findProject(s, org))
  const issue = (s: string | undefined) => (orgUnknown ? undefined : findIssueKey(s, org))
  if (seg[0] === 'settings') {
    if (seg[1] === 'project') {
      /* A uuid names the page whether the workspace holds the project or
         not, and the page's own read decides what it shows; a number reads
         through the workspace. Under a slug this login cannot resolve,
         neither does, as for every segment past the page. */
      const s = seg[2] ?? ''
      const p = UUID.test(s) ? null : proj(s)
      r.settings =
        !orgUnknown && UUID.test(s)
          ? `project:${s.toLowerCase()}`
          : p
            ? `project:${p.id}`
            : 'account'
    } else r.settings = seg[1] || 'account'
    return r
  }
  // The full-screen Archive became Settings › Archived tasks. Its address
  // still works and is rewritten to the page's own.
  if (seg[0] === 'archive') return { settings: ARCHIVED_TASKS_PAGE }
  if (seg[0] === 'projects') return { projects: true }
  if (seg[0] === 'inbox') {
    r.inbox = true
    // a task opened from a message floats over the inbox, so the address
    // carries both
    if (seg[1] === 'tasks') r.issue = issue(seg[2])
    return r
  }
  if (seg[0] === 'sync') {
    /* Team sync: scope, then step, then a task. Under a slug this login
       cannot resolve, nothing past the page resolves, uuids included (the
       rule proj() and issue() follow, applied to the whole address). A
       project the app cannot resolve stays a scope the page cannot honour
       (`unresolved:<segment>`, as typed), which asks to choose, never the
       saved scope or All projects. */
    r.sync = {}
    if (orgUnknown) return r
    let i = 1
    if (seg[1] === 'all') {
      r.sync.scope = 'all'
      i = 2
    } else if (seg[1] === 'p' || seg[1] === 'team') {
      if (seg[1] === 'p') {
        const p = proj(seg[2])
        r.sync.scope = p ? `project:${p.id}` : `unresolved:${seg[2] ?? ''}`
      } else if (seg[2]) r.sync.scope = `team:${seg[2].toLowerCase()}`
      i = 3
    }
    if (seg[i] === 'agents') {
      r.sync.step = 'agents'
      i += 1
    } else if (seg[i] === 'people' && seg[i + 1]) {
      r.sync.step = seg[i + 1].toLowerCase()
      i += 2
    }
    if (seg[i] === 'tasks') r.issue = issue(seg[i + 1])
    return r
  }
  let i = 0
  if (URL_TO_VIEW[seg[0]]) {
    r.view = URL_TO_VIEW[seg[0]]
    i = 1
  }
  /* "all" and "mine" sit where a project number would: the token IS the
     scope. Both span every organization, so the org segment in front of this
     form pins only how the issue reference behind it is read — never which
     projects are shown. */
  const sen = sentinelOf(seg[i])
  if (sen) {
    r.scope = sen
    if (seg[i + 1] === 'tasks') r.issue = issue(seg[i + 2])
    return r
  }
  if (seg[i] === 'p') {
    const p = proj(seg[i + 1])
    if (p) r.scope = p.id
    // tolerated combined form (never emitted): <view>/p/<n>/tasks/<task>
    if (seg[i + 2] === 'tasks') r.issue = issue(seg[i + 3])
    return r
  }
  if (seg[i] === 'tasks') {
    r.issue = issue(seg[i + 1])
    return r
  }
  return r
}

/** Resolve an org segment to an org uuid. `~` names none, which reads exactly
    like a legacy unprefixed hash: home-first. A slug this caller CANNOT
    resolve is different and must not fall through to that reading — the same
    number exists at home, so "their QN-1" would silently open MY QN-1. Such an
    address resolves to nothing instead. */
function resolveOrg(segment: string): { org?: string; orgUnknown: boolean } {
  if (!segment || segment === ORG_NONE) return { orgUnknown: false }
  const o = P.orgBySlug(segment)
  return o ? { org: o.id, orgUnknown: false } : { orgUnknown: true }
}

/** The raw org segment of an app path — a slug, `~`, or '' when the path is
    not an app address at all. Exported because the address book has to ask
    "which organization does this URL claim to be about?" before the route it
    describes has been resolved, and that question belongs to the grammar. */
export function orgSegmentOf(pathname: string): string {
  const path = (pathname || '').split('?')[0].split('#')[0]
  if (path !== APP_PREFIX && path.indexOf(`${APP_PREFIX}/`) !== 0) return ''
  const seg = path.slice(APP_PREFIX.length).split('/').filter(Boolean)
  return seg.length ? decodeURIComponent(seg[0]) : ''
}

export function parsePath(pathname: string): Route | null {
  const path = (pathname || '').split('?')[0].split('#')[0]
  if (path !== APP_PREFIX && path.indexOf(`${APP_PREFIX}/`) !== 0) return null
  const seg = path.slice(APP_PREFIX.length).split('/').filter(Boolean).map(decodeURIComponent)
  if (!seg.length) return null // bare /app — the app's front door
  const { org, orgUnknown } = resolveOrg(seg[0])
  return parseSegments(seg.slice(1), org, orgUnknown)
}

/** The task segment the address names, decoded as the parsers read it:
    the path's, else the legacy `hash`'s, as parsePath and parseHash take
    them in that order. Undefined when it names no task. */
export function taskSegmentOf(pathname: string, hash: string): string | undefined {
  return addressSegments(pathname, hash).task
}

/** The task the address names under an organization's slug, with the ref
    taskWindow.task reads (`QN-12`, or a lowercase uuid), which a boot reads
    with the first parts (store/liveParts.ts `address`). The slug is the
    path's org segment, else a legacy hash's `#/o/<slug>/`. Undefined for
    an address that names no task, names it under `~` or a legacy hash
    without a slug, which reads a number in the home organization only once
    the boot knows which that is, or names it by a ref no task can have. */
export function addressedTask(pathname: string, hash: string): AddressedTask | undefined {
  const { slug, task } = addressSegments(pathname, hash)
  const named = task ? parseIssueRef(task) : null
  if (!slug || slug === ORG_NONE || !named) return undefined
  return { slug, ref: 'num' in named ? `${ISSUE_PREFIX}-${named.num}` : named.uuid }
}

/* The org segment and the task segment of an address, decoded as the
   parsers read them: the path's, else the legacy hash's, whose org
   segment is `#/o/<slug>/` (parseHash). */
function addressSegments(pathname: string, hash: string): { slug?: string; task?: string } {
  const decoded = (s: string) =>
    s
      .split('/')
      .filter(Boolean)
      .map((part) => {
        try {
          return decodeURIComponent(part)
        } catch {
          return part
        }
      })
  const path = (pathname || '').split('?')[0].split('#')[0]
  const app =
    path === APP_PREFIX || path.startsWith(`${APP_PREFIX}/`)
      ? decoded(path.slice(APP_PREFIX.length))
      : []
  // past the org segment, as parsePath reads it; a path that names
  // nothing past it leaves the hash's
  let slug: string | undefined = app[0]
  let seg = app.slice(1)
  if (!seg.length) {
    const h = (hash || '').replace(/^#/, '')
    seg = h[0] === '/' ? decoded(h.slice(1)) : []
    slug = undefined
    if (seg[0] === 'o') {
      slug = seg[1]
      seg = seg.slice(2)
    }
  }
  const at = seg.indexOf('tasks')
  return { slug, task: at === -1 ? undefined : seg[at + 1] }
}

/* The organization, its address segment, the key and uuid each task handle
   was last named by. A task that leaves the store while its window is open
   (IssueDetail TaskGone) keeps that name, so the address goes on naming the
   task the window still speaks of, in its own organization, instead of a
   `~` that names none. Once its organization has left the store too, the
   address names it by its uuid, because `~` would read its key in the home
   organization; that new address replaces the old one in place
   (namedBefore). */
type NamedTask = Pick<IssueVM, 'org' | 'key' | 'uuid'> & { num: number; seg: string }
const named = new Map<string, NamedTask>()
const NAMED_MAX = 64

/* What `named` keeps of the task handle `open` opens now (P.handleNow).
   After the home organization changed, the handle an entry was kept by
   can open another task, whose address it must not name, and the task the
   entry names opens by another handle, which the window follows
   (P.watchHandles): the newest entry whose task opens by `open` answers. */
function namedNow(open: string) {
  const handleOf = (was: NamedTask) => P.handleNow(was.uuid, was.org, was.num)
  const was = named.get(open)
  if (was && handleOf(was) === open) return was
  let found: NamedTask | undefined
  for (const entry of named.values()) if (handleOf(entry) === open) found = entry
  return found
}

/** How an address names the task `open` names, a handle or a reference:
    its organization and the ref under it, the task's key, or its uuid
    where the organization cannot be named, since `~` would read the key in
    the home organization, with the task's uuid once known, which names it
    under another organization's slug (syncPath). A task the workspace
    holds is named by the workspace and remembered (`named`), one that left
    while its window showed it by what `named` kept, and any other from the
    store's live sources (taskFacts): the reference itself, its read's
    answer and the window's own read. Undefined when nothing names it, as
    for a reference by number alone whose organization has left the store,
    which `~` would read in the home organization (unnamedRef). */
function taskNamed(open: string): NamedRef | undefined {
  const it = refParts(open) ? undefined : P.issueById[open]
  if (it) {
    named.delete(open)
    // the display key is QN-n, the task's number in its organization
    const num = Number(it.key.slice(ISSUE_PREFIX.length + 1))
    named.set(open, { org: it.org, key: it.key, uuid: it.uuid, num, seg: orgSegment(it.org) })
    if (named.size > NAMED_MAX) named.delete(named.keys().next().value ?? open)
    return { org: it.org, ref: it.key, uuid: it.uuid }
  }
  const was = refParts(open) ? undefined : namedNow(open)
  if (was) {
    const seg = orgSegment(was.org)
    if (seg === ORG_NONE) return { org: was.org, ref: was.uuid, uuid: was.uuid }
    // its organization's address may change after the task left
    was.seg = seg
    return { org: was.org, ref: was.key, uuid: was.uuid }
  }
  const facts = taskFacts(open)
  if (!facts) return undefined
  const { org, num, uuid } = facts
  if (org && num !== undefined && orgSegment(org) !== ORG_NONE)
    return { org, ref: `${ISSUE_PREFIX}-${num}`, uuid }
  if (uuid) return { org: org ?? facts.from ?? null, ref: uuid, uuid }
  return undefined
}

/** The name taskNamed gives a task. `org` is the organization whose slug
    the address writes `ref` under, and `uuid` the task's uuid when the
    store knows it. */
type NamedRef = { org: string | null; ref: string; uuid?: string }

/** Whether `open` is a reference no address can name (taskNamed). An
    address leaves its task out rather than write the reference itself, so
    a reload or Back opens no task, never another one. */
const unnamedRef = (open: string | null | undefined): boolean =>
  !!open && !!refParts(open) && !taskNamed(open)

/* The organization and number each project settings page was last named
   by while the workspace held its project. A project that leaves while
   its page shows with its Archive or delete window open (ProjectSettings
   onHolding) keeps that address, so App writes no new entry over the
   window's phone marker. */
const namedProjects = new Map<string, { org: string; seg: string; num: number }>()

/* The project settings pages whose project the workspace does not hold,
   each with the organization its page's read named (noteProjectPage).
   buildPath names such a page by its uuid under that organization, which
   parses back to the page, so a reload, Back and Forward open it again. */
const unheldPages = new Map<string, { org: string }>()

/* The revision of unheldPages, which App's address follows (projectPagesRev),
   so an answer that names a page's organization rewrites the address at
   once, in place. */
let pagesRev = 0
const pagesListeners = new Set<() => void>()

/** Subscribes to the notes of project settings pages, for
    useSyncExternalStore beside projectPagesRev. */
export function subscribeProjectPages(listener: () => void): () => void {
  pagesListeners.add(listener)
  return () => pagesListeners.delete(listener)
}

/** The revision of the notes of project settings pages (noteProjectPage). */
export const projectPagesRev = (): number => pagesRev

/** Tells the address that the settings page of project `id` shows a
    project its read (projectSettings.get) found in organization `org`,
    while the workspace does not hold it and no window holds the page, or,
    with null, that it no longer does. The address then names the page by
    the project's uuid under that organization, in place. */
export function noteProjectPage(id: string, at: { org: string } | null): void {
  const was = unheldPages.get(id)
  if (at === null) {
    if (!was) return
    unheldPages.delete(id)
  } else {
    if (was?.org === at.org) return
    unheldPages.delete(id)
    unheldPages.set(id, { org: at.org })
    if (unheldPages.size > NAMED_MAX) unheldPages.delete(unheldPages.keys().next().value ?? id)
  }
  pagesRev++
  for (const listener of pagesListeners) listener()
}

/** Whether `path` names the settings page of the project `page` names by
    the organization and number it was last named by: the page's own
    address, also once its project left the store while the page is held
    (App onPop keeps the page then). */
export function namesProjectPage(path: string, page: string | null | undefined) {
  const was = page?.startsWith('project:') ? namedProjects.get(page.slice(8)) : undefined
  const seg = path.split('/').filter(Boolean)
  return (
    !!was &&
    orgSegmentOf(path) === was.seg &&
    seg.at(-2) === 'project' &&
    seg.at(-1) === String(was.num)
  )
}

/** Whether `path` names the task handle `open` by the organization and key
    it was last named by, as the address did before that organization left
    the store. */
function namedBefore(path: string, open: string | null | undefined) {
  const was = open && !refParts(open) ? namedNow(open) : undefined
  return (
    !!was &&
    orgSegmentOf(path) === was.seg &&
    taskSegmentOf(path, '')?.toLowerCase() === was.key.toLowerCase()
  )
}

/** Read-only hash navigation using the same task segments as path routes.
    Nothing emits a hash any more. */
export function parseHash(hash: string): Route | null {
  const h = (hash || '').replace(/^#/, '')
  if (h[0] !== '/') return null
  const seg = h.slice(1).split('/').filter(Boolean).map(decodeURIComponent)
  if (!seg.length) return null // bare "#/" — fall back to the saved UI state
  let org: string | undefined
  let orgUnknown = false
  if (seg[0] === 'o') {
    const r = resolveOrg(seg[1] || '')
    org = r.org
    orgUnknown = r.orgUnknown || !seg[1]
    seg.splice(0, 2)
  }
  return parseSegments(seg, org, orgUnknown)
}

/* ---------------------------------------------------------------------------
   Emission
   --------------------------------------------------------------------------- */
/** The slice of app state the address mirrors — what buildPath reads and
    pathMatchesState compares against. */
export type UiState = {
  scope?: string
  view?: string
  openIssue?: string | null
  settingsPage?: string | null
  inboxOpen?: boolean
  projectsOpen?: boolean
  // the Team sync page while it is open: scope as Route.sync, step 'team'
  // (the opening), 'agents' or a profile uuid
  sync?: { scope: string; step: string } | null
}

/** Where a Team sync route opens the page. No scope: the viewer's `saved`
    one, the scope they last picked, else none (`''`), where the page asks
    to choose; never All projects by default. No step: the team opening,
    except that the bare page link (`/sync`, no scope either) opens the
    viewer's own page on a phone, also behind the picker, so a pick lands
    there; the page falls back to the opening when they own nothing in
    scope. Every address the app writes for a scope names it, so a reload,
    Back or a task closing over the opening lands on the opening, phone or
    not. */
export function syncPlaceOf(
  r: NonNullable<Route['sync']>,
  viewer: { saved?: string; me: string; mobile: boolean },
): { scope: string; step: string } {
  return {
    scope: r.scope || viewer.saved || '',
    step: r.step || (viewer.mobile && !r.scope ? viewer.me : 'team'),
  }
}

/* The Team sync address for an open page (see the grammar above). The org
   segment pins how a task number reads, so a task of another organization
   is named by its uuid, and one whose uuid the store does not know yet,
   as a task opened by its number whose read has not answered, is left out
   of the address rather than named by its number under this slug, which
   would read another task. */
function syncPath(sync: { scope: string; step: string }, openIssue?: string | null): string {
  let org: string | null | undefined = P.homeOrg
  // no scope is the bare page; a project the app cannot resolve keeps the
  // segment it was typed as, encoded as parsePath decodes it, so a '/', '?'
  // or '#' in it stays inside the segment
  let rest = sync.scope === 'all' ? '/sync/all' : '/sync'
  if (sync.scope.indexOf('unresolved:') === 0)
    rest = `/sync/p/${encodeURIComponent(sync.scope.slice(11))}`
  else if (sync.scope.indexOf('project:') === 0) {
    const id = sync.scope.slice(8)
    const p = P.project(id)
    if (p) org = p.org
    rest = `/sync/p/${p && p.num != null ? String(p.num) : encodeURIComponent(id)}`
  } else if (sync.scope.indexOf('team:') === 0) {
    rest = `/sync/team/${encodeURIComponent(sync.scope.slice(5))}`
  }
  if (sync.step === 'agents') rest += '/agents'
  else if (sync.step && sync.step !== 'team') rest += `/people/${encodeURIComponent(sync.step)}`
  if (openIssue) {
    const it = taskNamed(String(openIssue))
    // another organization's task by its uuid, as the slug pins the number
    const ref = !it ? String(openIssue) : it.org === org ? it.ref : it.uuid
    if (ref) rest += `/tasks/${encodeURIComponent(ref.toLowerCase())}`
  }
  return `${APP_PREFIX}/${orgSegment(org)}${rest}`
}

/** The path this state is addressed by. Always `/app/<org>/…`. A
    reference no address can name leaves the task out (unnamedRef). */
export function buildPath(state: UiState): string {
  const s = unnamedRef(state.openIssue) ? { ...state, openIssue: null } : state
  const at = (orgId: string | null | undefined, rest: string) =>
    `${APP_PREFIX}/${orgSegment(orgId)}${rest}`

  // same precedence as the render: full-screen pages first, then the inbox
  if (s.settingsPage) {
    const page = s.settingsPage
    if (page.indexOf('project:') === 0) {
      const id = page.slice(8)
      const p = P.project(id)
      if (p?.num != null) {
        namedProjects.delete(id)
        namedProjects.set(id, { org: p.org, seg: orgSegment(p.org), num: p.num })
        if (namedProjects.size > NAMED_MAX)
          namedProjects.delete(namedProjects.keys().next().value ?? id)
        return at(p.org, `/settings/project/${String(p.num)}`)
      }
      // a page whose read found its project outside the workspace, by its
      // uuid under the organization that read named (noteProjectPage)
      const unheld = p ? undefined : unheldPages.get(id)
      if (unheld) return at(unheld.org, `/settings/project/${encodeURIComponent(id)}`)
      // a project that left while its page shows with a window open keeps
      // the page's address, by its id once its organization left too, as
      // `~` would read the number in the home organization
      const was = p ? undefined : namedProjects.get(id)
      if (was && orgSegment(was.org) !== ORG_NONE) {
        was.seg = orgSegment(was.org)
        return at(was.org, `/settings/project/${String(was.num)}`)
      }
      return at(p?.org, `/settings/project/${encodeURIComponent(id)}`)
    }
    return at(settingsOrg(page), `/settings/${encodeURIComponent(page)}`)
  }
  if (s.projectsOpen) return at(null, '/projects')
  if (s.inboxOpen) {
    // the inbox owns the screen, but a task opened from a message floats over
    // it — name both, so a reload lands back on the task you were reading
    if (!s.openIssue) return at(null, '/inbox')
    const it = taskNamed(String(s.openIssue))
    const ref = it ? it.ref : String(s.openIssue)
    return at(it?.org, `/inbox/tasks/${encodeURIComponent(ref.toLowerCase())}`)
  }
  // Team sync owns the screen too; the scope and view below it stay as they
  // were, so the address names only the page (and a task over it)
  if (s.sync) return syncPath(s.sync, s.openIssue)
  const viewUrl = VIEW_TO_URL[s.view || ''] || 'overview'
  /* A sentinel scope is one an issue link must NAME: there is no project to
     restore it from on the way back (scopeForIssue would land the reload on
     the issue's own sub-project and silently leave the mode). */
  if (sentinelOf(s.scope)) {
    if (!s.openIssue) return at(null, `/${viewUrl}/${s.scope}`)
    const it = taskNamed(String(s.openIssue))
    const ref = it ? it.ref : String(s.openIssue)
    return at(it?.org, `/${viewUrl}/${s.scope}/tasks/${encodeURIComponent(ref.toLowerCase())}`)
  }
  // the issue names its own project — no scope segment (scopeForIssue
  // restores it on the way back in)
  if (s.openIssue) {
    const it = taskNamed(String(s.openIssue))
    // a foreign issue's handle is its uuid; the readable key + org segment is
    // the shareable form, and the uuid still parses for anything older
    const ref = it ? it.ref : String(s.openIssue)
    return at(it?.org, `/${viewUrl}/tasks/${encodeURIComponent(ref.toLowerCase())}`)
  }
  const p = s.scope ? P.project(s.scope) : null
  // no scope to name yet (a brand-new organization with no projects): the
  // org's own front door, which parses back to null and keeps the saved state
  if (!p) return `${APP_PREFIX}/${orgSegment(P.homeOrg)}`
  if (p.num == null) return at(p.org, `/${viewUrl}/p/${encodeURIComponent(p.id)}`)
  return at(p.org, `/${viewUrl}/p/${String(p.num)}`)
}

/* The shareable address of one task (the window's Copy link) — the SHORT
   form, so the recipient lands in their own saved view. A task the store
   does not hold, such as one archived while its window was open or one a
   window shows from its own read, is named by its organization and key as
   the window's address names it (taskNamed), never by `~` while its
   organization can be named, which the recipient would read in their own
   home organization. */
export function issueLink(handle: string): string {
  const open = String(handle)
  const it = taskNamed(open)
  // a reference no address can name gives no task to link to
  if (!it && refParts(open)) return `${APP_PREFIX}/${ORG_NONE}`
  const ref = it ? it.ref : open
  return `${APP_PREFIX}/${orgSegment(it?.org)}/tasks/${encodeURIComponent(ref.toLowerCase())}`
}

// true when `path` already describes exactly this state (so the URL only
// needs normalizing, not a new history entry). The address names the open
// task when it names the same task (sameTask), so a reference the address
// gave and the handle it moved to, or the key an answer taught for a uuid,
// change the address in place.
export function pathMatchesState(path: string, s: UiState): boolean {
  const built = buildPath(s)
  if (path === built) return true

  /* An address whose ONLY difference is the org segment is this organization's
     address having MOVED, not a navigation. `organizations` is in the realtime
     publication, so an admin renaming the address re-emits in every colleague's
     open tab within a second; treating that as a navigation would push a
     history entry whose Back target is a slug that no longer resolves. */
  const seg = (u: string) => {
    const i = u.indexOf('/', APP_PREFIX.length + 1)
    return i < 0 ? '' : u.slice(i)
  }
  if (path.indexOf(`${APP_PREFIX}/`) === 0 && seg(path) === seg(built) && seg(built) !== '')
    return true

  const r = parsePath(path)
  if (!r) return true // the front door or a foreign path: overwrite in place
  // the task the address names, the open one when they name the same task
  const issue =
    sameTask(r.issue, s.openIssue) || namedBefore(path, s.openIssue) ? s.openIssue : r.issue || null
  // a login with no home organization has no Team sync: the address it
  // followed shows the page underneath, so it is rewritten, not stacked
  if (r.sync && !P.homeOrg) return true
  if (r.inbox || s.inboxOpen) return !!r.inbox === !!s.inboxOpen && issue === (s.openIssue || null)
  if (r.projects || s.projectsOpen) return !!r.projects === !!s.projectsOpen
  if (r.settings || s.settingsPage)
    return (
      (r.settings || null) === (s.settingsPage || null) ||
      (!!r.settings && namesProjectPage(path, s.settingsPage))
    )
  /* Inside Team sync, a new step or scope rewrites the address in place: the
     walk must not fill the history, and Back leaves the page. Opening or
     closing a task over it is a navigation, as over the inbox. */
  if (r.sync || s.sync) return !!r.sync === !!s.sync && issue === (s.openIssue || null)
  if (issue !== (s.openIssue || null)) return false
  if (s.openIssue) {
    /* Entering or leaving a sentinel scope with the window open changes the
       pane behind the task, so it earns a history entry. Reading "no scope
       segment" as "a different scope" takes a view: the PROJECT form omits the
       segment too, so an address that names a view but no scope was that form
       — while a viewless short link names neither and must still normalize in
       place, or every such boot under a saved sentinel scope would push a junk
       entry.
       Compared by IDENTITY, not by "is it a sentinel": All projects → My view
       swaps the pane exactly as project → All projects does, and a boolean
       test would call those two the same page. */
    if ((r.view || r.scope) && sentinelOf(r.scope) !== sentinelOf(s.scope)) return false
    // a viewless short link matches whatever view the state has — the URL
    // normalizes in place to the canonical view-prefixed form
    return (r.view || s.view || 'overview') === (s.view || 'overview')
  }
  return (r.scope || s.scope) === s.scope && (r.view || 'overview') === (s.view || 'overview')
}
