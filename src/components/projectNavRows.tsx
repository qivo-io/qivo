/* The rules the lists on the server's navigation reads (convex/projectNav.ts)
   share, so they name, tag, word and open a project alike: the shared
   project picker (components/ProjectPicker.tsx), the All projects directory
   (components/ProjectDirectory.tsx), the sidebar's project tree
   (components/SidebarProjects.tsx), Search's project results
   (panels/Palette.tsx) and the project chooser
   (components/ProjectChooser.tsx). Of the store they read the
   organizations' names, the home organization and whether the person is
   an organization admin. They open a project at once (useNavOpen),
   seeding its row's facts into the store's project cache
   (P.seedProjects), and App shows "Opening <name>…" until the cache
   answers for it. Startup's check of an address by number reads
   projectNav.resolve (openResolved), which every navigation the person
   makes drops (navMoved). */

import { type ReactNode, useCallback } from 'react'
import type {
  NavChildren,
  NavPage,
  NavProject,
  NavSearch,
} from '../../convex/model/projectNavReads'
import { noProjectsHint } from '../lib/noProjects'
import type { BatchAt } from '../lib/pagedList'
import { useLatest } from '../lib/useLatest'
import { P, type ProjectAsk } from '../store/planner'
import { duplicateNameTags, type TaggableProject } from '../store/viewModels'

/** The cursors of one batch, absent ones left out, as the reads take them. */
export const navCursors = (at: BatchAt) => ({
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

/** The organization's name for a row of another organization than the
    home one, as Search's results name it. */
export const foreignOrg = (org: string): string | null =>
  org === P.homeOrg ? null : (P.orgs.find((o) => o.id === org)?.name ?? null)

/** What a list says for an answer with no rows: not ready, the
    access_unchecked refusal's own sentence, or a project that cannot be
    opened. */
export function heldText(
  answer: NavPage | NavSearch | NavChildren | null | undefined,
  what: 'page' | 'children',
) {
  if (answer?.state === 'not_ready') return 'Qivo is still preparing your project list.'
  if (answer?.state === 'unavailable' && answer.reason === 'access_unchecked')
    return answer.message ?? 'Qivo could not finish checking which projects you can see.'
  return what === 'children'
    ? 'You can no longer open this project.'
    : "Couldn't load your projects."
}

/** What an expanded sub-project list says, in the directory and the tree:
    its first batch on its way, a failure with no rows or after some, a
    stopped batch beside Load more, the bound past which it asks for a
    search, a confirmed empty end, and the notes of a batch above the last
    that failed or stopped without moving. */
export const CHILDREN_WORDS = {
  loading: 'Loading sub-projects…',
  failed: "Couldn't load the sub-projects.",
  failedMore: "Couldn't load more sub-projects.",
  stopped: 'Qivo checked part of the sub-projects.',
  full: 'Search to find more sub-projects.',
  empty: 'No sub-projects you can open.',
  stuck: 'Qivo could not check part of the sub-projects.',
  partFailed: "Couldn't load part of the sub-projects.",
} as const

/** A project's number tag, `#12`, beside its name. */
function tagSpan(tag: string) {
  // line-height 1 keeps the mono number from deepening the line it sits on
  return (
    <span
      data-project-tag
      className="whitespace-nowrap !font-mono text-xs leading-none font-normal text-text-2"
    >
      {tag}
    </span>
  )
}

/** A name with its tag, `#12` for one of equal names shown together. It
    wraps, or with `truncate` stays on one line, the name ellipsized and the
    tag kept whole beside it, as the workspace's ProjectName does. A name
    without a tag is its plain text, so a row's accessible name is the
    project's name. A function rather than a component, as
    components/rowElements.tsx projectName is, so this module exports no
    component beside its rules. */
export function tagged({
  name,
  tag,
  truncate = false,
}: {
  name: string
  tag: string | undefined
  truncate?: boolean
}): ReactNode {
  if (!tag) return name
  // real spaces keep "Test #4" apart for screen readers and copied text
  if (!truncate)
    return (
      <>
        {name} {tagSpan(tag)}
      </>
    )
  // a grid drops plain spaces, so the one before the tag is drawn 6px wide
  return (
    <span className="inline-grid min-w-0 max-w-full grid-flow-col items-baseline align-bottom">
      <span className="truncate">{name}</span>
      <span className="w-1.5 overflow-hidden whitespace-pre"> </span>
      {tagSpan(tag)}
    </span>
  )
}

/** The tags of `rows` as one list shows them: equal names of one
    organization under one parent carry their number
    (store/viewModels.ts duplicateNameTags), never through the workspace's
    ProjectName. `parentOf` names the project above a row, which is tagged
    among the top-level projects shown when a row names it, as a search's
    sub-project rows name theirs. */
export function navTags<Row extends NavProject>(
  rows: readonly Row[],
  parentOf: (row: Row) => NavProject | null = () => null,
): Map<string, string> {
  const taggable = new Map<string, TaggableProject>()
  for (const row of rows)
    taggable.set(row.id, {
      id: row.id,
      org: row.org_id,
      parent: parentOf(row)?.id,
      name: row.name,
      num: row.num,
    })
  for (const row of rows) {
    const up = parentOf(row)
    if (up && !taggable.has(up.id))
      taggable.set(up.id, {
        id: up.id,
        org: up.org_id,
        parent: undefined,
        name: up.name,
        num: up.num,
      })
  }
  return duplicateNameTags([...taggable.values()])
}

/** What a person with no active project to choose is told, in the All
    projects directory and the project chooser. The lists judge an
    organization admin by ordinary access, as every page does, so an admin
    gets the pages' own sentence (noProjectsHint), which points to the list
    of every project of their organization. */
export function noNavProjectsHint(): string {
  return P.isAdmin()
    ? noProjectsHint()
    : 'You have no active projects. Ask an organization admin or a project lead for access.'
}

/** What opening a project through projectNav.resolve came to
    (openResolved): open, with the project the server named; unavailable,
    a project the person cannot open; unchecked, the access_unchecked
    refusal with its sentence; or failed, a read that failed. */
export type NavOpening =
  | { state: 'open'; id: string }
  | { state: 'unavailable' }
  | { state: 'unchecked'; message: string }
  | { state: 'failed' }

/** The refusal's sentence where the server gives none. */
const UNCHECKED_TEXT = 'Qivo could not finish checking whether you can open this project.'

/**
 * Asks the server whether the person may open the project `ask` names
 * (P.resolveProject), for an address that names a project by its
 * organization and number, and calls `done` once with what that came to.
 * On ok it seeds the project's facts, and its parent's, into the project
 * cache (P.seedProjects), so the scope it opens names it at once. Answers
 * a function that stops it, after which `done` is never called.
 */
export function openResolved(ask: ProjectAsk, done: (opening: NavOpening) => void): () => void {
  let live = true
  void P.resolveProject(ask).then((answer) => {
    if (!live) return
    live = false
    if (answer === null) return done({ state: 'failed' })
    if (answer.state !== 'ok')
      return done(
        answer.reason === 'access_unchecked'
          ? { state: 'unchecked', message: answer.message ?? UNCHECKED_TEXT }
          : { state: 'unavailable' },
      )
    seedNavRow(answer.project)
    done({ state: 'open', id: answer.project.id })
  })
  return () => {
    live = false
  }
}

/** A navigation row as the open rule takes it: a projectNav.page or
    children row (a sub-project's `parent_id`), or a search or resolve row
    (`parent`, its top-level project). Main Search's project results name
    no organization number (`num`), and seed nothing. */
export type NavOpenRow = Omit<NavProject, 'num'> & {
  num?: number
  parent_id?: string | null
  parent?: (Omit<NavProject, 'num' | 'org_id'> & { num?: number; org_id?: string }) | null
}

/** Seeds `row`'s facts, and its top-level project's where the row names
    it whole, into the store's project cache (P.seedProjects), so a scope
    opened from the row names its project and its views ask at once. A row
    without its number seeds nothing, and App says it opens the project
    until the cache answers. */
export function seedNavRow(row: NavOpenRow) {
  if (row.num === undefined) return
  const parent = row.parent ?? null
  P.seedProjects([
    {
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      num: row.num,
      parent_id: parent?.id ?? row.parent_id ?? null,
    },
    ...(parent && parent.num !== undefined
      ? [
          {
            id: parent.id,
            org_id: parent.org_id ?? row.org_id,
            name: parent.name,
            num: parent.num,
            parent_id: null,
          },
        ]
      : []),
  ])
}

/* Who hears the person's navigations (navMoved): each open that waits
   (useNavOpen) and startup's check (App.tsx). */
const navMoves = new Set<() => void>()

/** Tells every open that waits, and startup's check, that the person moved
    elsewhere, so each drops its wait with its "Opening" line and its
    answer changes nothing. App calls it for each move it accepts and for
    each Back or Forward it accepts that changes the page, the open task or
    the project address the workspace does not hold that the page checks,
    and an open that starts to wait calls it first, so another list's open
    gives way to it. */
export function navMoved() {
  // one heard removes at most itself, which a walk of a Set allows
  for (const heard of navMoves) heard()
}

/** Calls `heard` on each navMoved until the function it answers is
    called. */
export function onNavMove(heard: () => void): () => void {
  navMoves.add(heard)
  return () => {
    navMoves.delete(heard)
  }
}

/**
 * The open rule of the lists on the navigation reads. `open(row)` seeds the
 * row's facts into the store's project cache (seedNavRow) and opens the
 * project at once with `go(id)`, as for any row: App sets the scope and
 * shows "Opening <name>…" until the cache answers for it, the lost note if
 * it answers the project gone and the failure's sentence with Retry. It
 * ends any line the caller shows (`say(null)`) and tells every check that
 * waits that the person moved (navMoved). `cancel()` does nothing now that
 * no open waits; callers keep it for a page move or a new search.
 */
export function useNavOpen(go: (id: string) => void, say: (line: string | null) => void) {
  const goNow = useLatest(go)
  const sayNow = useLatest(say)
  const cancel = useCallback(() => {}, [])
  const open = (row: NavOpenRow) => {
    seedNavRow(row)
    sayNow(null)
    navMoved()
    goNow(row.id)
  }
  return { open, cancel }
}
