/* Shareable app routes under /app/<org>/, where <org> is a slug or `~` for
   cross-organization/account pages. Slug validation excludes `~`.

   Routes (view = overview|board|roadmap):
     <view>/tasks/<ref>        task over that view
     tasks/<ref>               task using saved view/scope
     [<view>/]p/<n>            project/sub-project scope
     <view>/all|mine           sentinel scope, optionally /tasks/<ref>
     settings/<page>           account, org-* or team:<uuid>
     settings/project/<n>      project settings
     projects | archive       directory or archive
     inbox[/tasks/<ref>]       inbox, optionally with a task open
     sync[/all|/p/<n>|/team/<uuid>][/people/<uuid>|/agents][/tasks/<ref>]

   Team sync uses the home organization. Bare /app or /app/<org> returns null
   so App restores saved UI state instead of persisting a default view.
   Task refs accept qn-<num> (any case), bare numbers or immutable uuids;
   project refs accept numbers or uuids. Emission is lowercase. Numbers are
   org-scoped and survive moves; renamed project keys are display-only.
   Tasks resolve their own project scope except under all/mine or inbox.
   Legacy #/ links share parseSegments and are replaced by path routes;
   unrelated hashes, including auth fragments, are ignored. */
import { ALL_SCOPE, ISSUE_PREFIX, MINE_SCOPE, P } from '../store/planner'

export type Route = {
  scope?: string
  view?: string
  issue?: string
  settings?: string
  archive?: boolean
  inbox?: boolean
  projects?: boolean
  /* The Team sync page. `scope` is 'all' | 'team:<uuid>' | 'project:<uuid>'
     (absent: the viewer's saved scope); `step` is 'agents' or a profile uuid
     (absent: the default step). Team and profile uuids pass through
     unvalidated, as `settings/team:<uuid>` does: the page falls back when
     one resolves to nothing. */
  sync?: { scope?: string; step?: string }
}

/** The prefix that separates the app from the marketing site sharing its
    origin. Fixed rather than per-organization on purpose: it keeps every org
    slug out of the marketing namespace, so `/docs` and `/pricing` can never be
    taken by a customer naming their company after one. */
export const APP_PREFIX = '/app'

/** The org segment for an address that is about no single organization. */
export const ORG_NONE = '~'

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
const findIssueKey = (s: string | undefined, org?: string) => {
  if (!s) return undefined
  const m = new RegExp(`^(?:${ISSUE_PREFIX}-)?(\\d+)$`, 'i').exec(s)
  if (m) {
    const key = `${ISSUE_PREFIX}-${Number(m[1])}`
    if (org) return P.issueRefIn(org, key) || undefined
    // unpinned: the home organization's handle IS the key
    return P.issueById[key] ? key : undefined
  }
  const lc = s.toLowerCase()
  const it = P.issues.find((i) => i.uuid === lc)
  return it ? it.id : undefined
}

/** The org segment for content owned by `orgId` — its slug, or `~` when there
    is no organization to name (or none this caller can resolve, in which case
    `~` degrades to the home-first reading rather than naming the wrong one). */
const orgSegment = (orgId: string | undefined | null): string => {
  if (!orgId) return ORG_NONE
  const o = P.orgs.find((x) => x.id === orgId)
  return o?.slug ? o.slug : ORG_NONE
}

/** Which organization a settings page is about. Everything except the project
    form is home-org scoped by construction — P.setOrg resolves the home row,
    and the team rail filters on P.homeOrg — while an account page is about a
    person, not an organization, and takes `~`. */
const settingsOrg = (page: string): string | null => {
  if (page.indexOf('project:') === 0) {
    const p = P.project(page.slice(8))
    return p ? p.org : null
  }
  if (page === 'account' || page.startsWith('account-') || page === 'menu') return null
  return P.homeOrg || null
}

/* Scope to show behind an issue link: the preferred (saved/current) scope
   when the issue lives inside it — so the owner's reload lands exactly where
   they were — else the issue's own sub-project (a link recipient's sensible
   default). */
export const scopeForIssue = (issueKey: string, preferred?: string | null): string | undefined => {
  const it = P.issueById[issueKey]
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
  if (preferred === MINE_SCOPE) return P.isMine(it) ? MINE_SCOPE : it.project
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
      const p = proj(seg[2])
      r.settings = p ? `project:${p.id}` : 'account'
    } else r.settings = seg[1] || 'account'
    return r
  }
  if (seg[0] === 'archive') {
    r.archive = true
    return r
  }
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
       rule proj() and issue() follow, applied to the whole address). An
       unresolvable project leaves the scope absent: the saved one opens. */
    r.sync = {}
    if (orgUnknown) return r
    let i = 1
    if (seg[1] === 'all') {
      r.sync.scope = 'all'
      i = 2
    } else if (seg[1] === 'p' || seg[1] === 'team') {
      if (seg[1] === 'p') {
        const p = proj(seg[2])
        if (p) r.sync.scope = `project:${p.id}`
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
  archiveOpen?: boolean
  inboxOpen?: boolean
  projectsOpen?: boolean
  // the Team sync page while it is open: scope as Route.sync, step 'team'
  // (the opening), 'agents' or a profile uuid
  sync?: { scope: string; step: string } | null
}

/** Where a Team sync route opens the page. No scope: the viewer's `saved`
    one, else all projects. No step: the team opening, except that the bare
    page link (`/sync`, no scope either) opens the viewer's own page on a
    phone; the page falls back to the opening when they own nothing in scope.
    Every address the app writes names a scope, so a reload, Back or a task
    closing over the opening lands on the opening, phone or not. */
export function syncPlaceOf(
  r: NonNullable<Route['sync']>,
  viewer: { saved?: string; me: string; mobile: boolean },
): { scope: string; step: string } {
  return {
    scope: r.scope || viewer.saved || 'all',
    step: r.step || (viewer.mobile && !r.scope ? viewer.me : 'team'),
  }
}

/* The Team sync address for an open page (see the grammar above). The org
   segment pins how a task number reads, so a task of another organization
   is named by its uuid. */
function syncPath(sync: { scope: string; step: string }, openIssue?: string | null): string {
  let org: string | null | undefined = P.homeOrg
  let rest = '/sync/all'
  if (sync.scope.indexOf('project:') === 0) {
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
    const it = P.issueById[String(openIssue)]
    const ref = it ? (it.org === org ? it.key : it.uuid) : String(openIssue)
    rest += `/tasks/${encodeURIComponent(ref.toLowerCase())}`
  }
  return `${APP_PREFIX}/${orgSegment(org)}${rest}`
}

/** The path this state is addressed by. Always `/app/<org>/…`. */
export function buildPath(s: UiState): string {
  const at = (orgId: string | null | undefined, rest: string) =>
    `${APP_PREFIX}/${orgSegment(orgId)}${rest}`

  // same precedence as the render: full-screen pages first, then the inbox
  if (s.settingsPage) {
    const page = s.settingsPage
    if (page.indexOf('project:') === 0) {
      const p = P.project(page.slice(8))
      if (!p || p.num == null)
        return at(p?.org, `/settings/project/${encodeURIComponent(page.slice(8))}`)
      return at(p.org, `/settings/project/${String(p.num)}`)
    }
    return at(settingsOrg(page), `/settings/${encodeURIComponent(page)}`)
  }
  if (s.archiveOpen) return at(null, '/archive')
  if (s.projectsOpen) return at(null, '/projects')
  if (s.inboxOpen) {
    // the inbox owns the screen, but a task opened from a message floats over
    // it — name both, so a reload lands back on the task you were reading
    if (!s.openIssue) return at(null, '/inbox')
    const it = P.issueById[String(s.openIssue)]
    const ref = it?.key ? it.key : String(s.openIssue)
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
    const it = P.issueById[String(s.openIssue)]
    const ref = it?.key ? it.key : String(s.openIssue)
    return at(it?.org, `/${viewUrl}/${s.scope}/tasks/${encodeURIComponent(ref.toLowerCase())}`)
  }
  // the issue names its own project — no scope segment (scopeForIssue
  // restores it on the way back in)
  if (s.openIssue) {
    const it = P.issueById[String(s.openIssue)]
    // a foreign issue's handle is its uuid; the readable key + org segment is
    // the shareable form, and the uuid still parses for anything older
    const ref = it?.key ? it.key : String(s.openIssue)
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
   form, so the recipient lands in their own saved view. */
export function issueLink(handle: string): string {
  const it = P.issueById[String(handle)]
  const ref = it?.key ? it.key : String(handle)
  return `${APP_PREFIX}/${orgSegment(it?.org)}/tasks/${encodeURIComponent(ref.toLowerCase())}`
}

// true when `path` already describes exactly this state (so the URL only
// needs normalizing, not a new history entry)
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
  // a login with no home organization has no Team sync: the address it
  // followed shows the page underneath, so it is rewritten, not stacked
  if (r.sync && !P.homeOrg) return true
  if (r.inbox || s.inboxOpen)
    return !!r.inbox === !!s.inboxOpen && (r.issue || null) === (s.openIssue || null)
  if (r.archive || s.archiveOpen) return !!r.archive === !!s.archiveOpen
  if (r.projects || s.projectsOpen) return !!r.projects === !!s.projectsOpen
  if (r.settings || s.settingsPage) return (r.settings || null) === (s.settingsPage || null)
  /* Inside Team sync, a new step or scope rewrites the address in place: the
     walk must not fill the history, and Back leaves the page. Opening or
     closing a task over it is a navigation, as over the inbox. */
  if (r.sync || s.sync) return !!r.sync === !!s.sync && (r.issue || null) === (s.openIssue || null)
  if ((r.issue || null) !== (s.openIssue || null)) return false
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
