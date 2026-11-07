/* The rules the lists on the server's navigation reads (convex/projectNav.ts)
   share, so they name, tag, word and open a project alike: the shared
   project picker (components/ProjectPicker.tsx), the All projects directory
   (components/ProjectDirectory.tsx), the sidebar's project tree
   (components/SidebarProjects.tsx), Search's project results
   (panels/Palette.tsx) and the project chooser
   (components/ProjectChooser.tsx). Of the store they read the
   organizations' names, the home organization, whether the person is an
   organization admin and whether the workspace holds a project and is
   current, and they open a project the workspace does not hold through
   projectNav.resolve (openResolved, useNavOpen), which every navigation
   the person makes drops (navMoved). */

import { type ReactNode, useCallback, useEffect, useRef } from 'react'
import type {
  NavChildren,
  NavPage,
  NavProject,
  NavSearch,
} from '../../convex/model/projectNavReads'
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
    projects directory and the project chooser: the lists judge an
    organization admin by ordinary access too, so an admin is pointed to
    the list of every project of their organization. */
export function noNavProjectsHint(): string {
  return P.isAdmin()
    ? 'You have no active projects. Ask an organization admin or a project lead for access. Settings › Projects › All projects lists every project of your organization.'
    : 'You have no active projects. Ask an organization admin or a project lead for access.'
}

/** What opening a project through projectNav.resolve came to
    (openResolved): open, the workspace holding it; not loaded, the
    server's ok, with the project's name, while the workspace, current,
    did not hold it, or did not become current within NAV_OPEN_WAIT_MS;
    unavailable, a project the person cannot open; unchecked, the
    access_unchecked refusal with its sentence; or failed, a read that
    failed. */
export type NavOpening =
  | { state: 'open'; id: string }
  | { state: 'not_loaded'; name: string }
  | { state: 'unavailable' }
  | { state: 'unchecked'; message: string }
  | { state: 'failed' }

/** How long an open waits at most, after the server's ok, for a workspace
    that is not current (P.workspaceCurrent) to hold the project. */
export const NAV_OPEN_WAIT_MS = 10_000

/** The refusal's sentence where the server gives none. */
const UNCHECKED_TEXT = 'Qivo could not finish checking whether you can open this project.'

/**
 * Asks the server whether the person may open the project `ask` names
 * (P.resolveProject) and calls `done` once with what that came to. On ok,
 * a project the workspace holds opens at once. Otherwise the decision
 * waits for the store's next repaint, as the delivery that brings the
 * project can arrive with the answer and paint after it: it opens once the
 * workspace holds the project, and ends not loaded once the workspace is
 * current without it (P.workspaceCurrent), or at the latest after
 * NAV_OPEN_WAIT_MS. Only that wait follows the store. Answers a function
 * that stops it, after which `done` is never called.
 */
export function openResolved(ask: ProjectAsk, done: (opening: NavOpening) => void): () => void {
  let live = true
  let stopWait = () => {}
  const finish = (opening: NavOpening) => {
    if (!live) return
    live = false
    stopWait()
    done(opening)
  }
  void P.resolveProject(ask).then((answer) => {
    if (!live) return
    if (answer === null) return finish({ state: 'failed' })
    if (answer.state !== 'ok')
      return finish(
        answer.reason === 'access_unchecked'
          ? { state: 'unchecked', message: answer.message ?? UNCHECKED_TEXT }
          : { state: 'unavailable' },
      )
    const { id, name } = answer.project
    if (P.project(id)) return finish({ state: 'open', id })
    const look = () => {
      if (P.project(id)) finish({ state: 'open', id })
      else if (P.workspaceCurrent()) finish({ state: 'not_loaded', name })
    }
    const off = P.updates.workspace.subscribe(look)
    // a paint owed at the answer runs on a 0 ms timer at the latest (owe)
    const repaint = setTimeout(look, 0)
    const bound = setTimeout(() => finish({ state: 'not_loaded', name }), NAV_OPEN_WAIT_MS)
    stopWait = () => {
      off()
      clearTimeout(repaint)
      clearTimeout(bound)
    }
  })
  return () => {
    live = false
    stopWait()
  }
}

/** What a list says when opening project `name` came to `opening`, or
    null where it opened. */
export function navOpenText(opening: NavOpening, name: string): string | null {
  switch (opening.state) {
    case 'open':
      return null
    case 'not_loaded':
      return `${name} has not loaded yet. Try again in a moment.`
    case 'unavailable':
      return `You can no longer open ${name}.`
    case 'unchecked':
      return opening.message
    case 'failed':
      return `Couldn't open ${name}. Try again.`
  }
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
 * The open rule of the lists on the navigation reads. `open(row)` opens a
 * project the workspace holds at once with `go(id)`, reading nothing. One
 * it does not hold says "Opening <name>…" through `say` and opens through
 * openResolved: `go(id)` once the workspace holds it, with `say(null)`,
 * which ends the line, else the outcome's sentence (navOpenText). A
 * second press of the row it waits for does nothing, and a press on
 * another row replaces the wait. `cancel()` drops it and says nothing, as
 * a caller does on a page move or a new search, which ends its own line.
 * The caller hiding (React's Activity runs this hook's cleanup) or going
 * drops it too, and so does every navigation the person makes (navMoved):
 * another view, page, project or Team sync scope, Back or Forward, or an
 * open that starts to wait in another list. So nothing opens later in a
 * place the person left, and only one open waits at a time. These, and a
 * press on a held row, also end the "Opening <name>…" line with
 * `say(null)`, so no list says it opens what nothing waits for.
 */
export function useNavOpen(go: (id: string) => void, say: (line: string | null) => void) {
  const wait = useRef<{ id: string; stop: () => void } | null>(null)
  const goNow = useLatest(go)
  const sayNow = useLatest(say)
  const cancel = useCallback(() => {
    wait.current?.stop()
    wait.current = null
  }, [])
  // drops a wait with its line
  const drop = useCallback(() => {
    if (wait.current) sayNow(null)
    cancel()
  }, [cancel, sayNow])
  useEffect(() => drop, [drop])
  const open = (row: { id: string; name: string }) => {
    if (P.project(row.id)) {
      drop()
      return goNow(row.id)
    }
    if (wait.current?.id === row.id) return
    cancel()
    // another list's open that waits, and startup's check, give way
    navMoved()
    sayNow(`Opening ${row.name}…`)
    const at = { id: row.id, stop: () => {} }
    const stopOpen = openResolved(row.id, (opening) => {
      if (wait.current !== at) return
      cancel()
      if (opening.state === 'open') {
        sayNow(null)
        goNow(opening.id)
      } else sayNow(navOpenText(opening, row.name))
    })
    const off = onNavMove(drop)
    at.stop = () => {
      stopOpen()
      off()
    }
    wait.current = at
  }
  return { open, cancel }
}
