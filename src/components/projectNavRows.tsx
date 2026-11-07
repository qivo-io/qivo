/* The rules the lists on the server's navigation reads (convex/projectNav.ts)
   share, so they name, tag, word and open a project alike: the shared
   project picker (components/ProjectPicker.tsx), the All projects directory
   (components/ProjectDirectory.tsx) and the sidebar's project tree
   (components/SidebarProjects.tsx). Of the store they read only the
   organizations' names, the home organization and whether the workspace
   holds a project. */

import type { ReactNode } from 'react'
import type {
  NavChildren,
  NavPage,
  NavProject,
  NavSearch,
} from '../../convex/model/projectNavReads'
import type { BatchAt } from '../lib/pagedList'
import { P } from '../store/planner'
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

/** Opens `row` as the sidebar's rows always have (actions.openProject),
    once the workspace holds it. One the workspace does not hold yet calls
    `say` with a sentence that says so and moves nothing, so the access
    guard never moves the scope somewhere the person did not ask for. */
export function openNavProject(
  row: NavProject,
  actions: Record<string, (id: string) => void>,
  say: (line: string) => void,
) {
  if (!P.project(row.id)) return say(`${row.name} has not loaded yet. Try again in a moment.`)
  actions.openProject(row.id)
}
