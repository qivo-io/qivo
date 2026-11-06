/* What Settings' project lists (ProjectLists.tsx) and a project's Settings
   page (ProjectSettings.tsx) share beside their components: the open
   lists' caps, how a list answer reads, the sub-project list's read and
   its Load more, and the name tags of rows shown together. */
import { useRef } from 'react'
import { api } from '../../../convex/_generated/api'
import type { NavChildRow } from '../../../convex/model/projectNavReads'
import type { SettingsListAnswer } from '../../../convex/model/projectSettingsLists'
import { sentence } from '../../lib/fieldLimits'
import { useFocusWhenGone } from '../../lib/focusWhenGone'
import {
  type BatchAt,
  type ListEnd,
  type PagedList,
  useMoreOnScroll,
  usePagedList,
} from '../../lib/pagedList'
import { duplicateNameTags } from '../../store/viewModels'

/** The most rows an open list gathers, which tests lower and set back: an
    opened project's sub-projects (`subProjects`, four batches, past the
    design size's 30 live sub-projects under one project) and an archived
    project's sub-projects (`chips`, past its 40). Past them a list asks
    for a search. */
export const PROJECT_LIST_LIMITS = { subProjects: 100, chips: 100 }

/** A list answer's batch, or null for one with no rows, not ready or
    unavailable, which a list shows as held. */
export function readyBatch<R>(answer: SettingsListAnswer<R>) {
  return answer.state === 'ready' ? answer : null
}

/** What a list says for an answer with no rows: the access_unchecked
    refusal's own sentence, `unavailable` without one, or not ready. */
export function heldSentence(
  answer: SettingsListAnswer<unknown> | null | undefined,
  words: { notReady: string; unavailable: string },
): string {
  if (answer?.state !== 'unavailable') return words.notReady
  return answer.message ? sentence(answer.message) : words.unavailable
}

/** The `#num` tags of rows shown together in organization `org`, by the
    store's rule for names shown at once (store/viewModels.ts
    duplicateNameTags): one organization, one parent, one name. Twins on
    two pages stay untagged. */
export const tagsOf = (
  org: string,
  rows: readonly { id: string; name: string; num: number; parent?: string }[],
) =>
  duplicateNameTags(
    rows.map((r) => ({ id: r.id, org, parent: r.parent, name: r.name, num: r.num })),
  )

/** Where a list's first batch starts. */
export const BATCH_START: BatchAt = { after: null, through: null }

/** The arguments of one batch of a project's sub-project list, live or
    archived, in a fixed key order with empty fields left out. */
export const childArgs = (org: string, project: string, at: BatchAt) => ({
  org_id: org,
  project_id: project,
  ...(at.after === null ? {} : { after: at.after }),
  ...(at.through === null ? {} : { through: at.through }),
})

/** The live sub-projects of top-level project `at.project` in
    organization `at.org` (projectSettings.subProjects), a batch at a time
    up to PROJECT_LIST_LIMITS.subProjects; null reads nothing. */
export function useSubProjects(at: { org: string; project: string } | null) {
  return usePagedList({
    key: at === null ? null : JSON.stringify(childArgs(at.org, at.project, BATCH_START)),
    source: {
      kind: 'live',
      query: api.projectSettings.subProjects,
      args: (b) => childArgs(at?.org ?? '', at?.project ?? '', b),
    },
    batch: readyBatch<NavChildRow>,
    id: (row: NavChildRow) => row.id,
    most: PROJECT_LIST_LIMITS.subProjects,
  })
}

/**
 * Load more for an open list: keeps focus on the button while it reads,
 * and once Load more goes moves it to the first new row's control
 * (`rowControl`), else `rest()`, as Settings › Labels does. Answers the
 * press and the marker ref that loads more as the list's end scrolls into
 * view (lib/pagedList.ts useMoreOnScroll).
 */
export function useLoadMore<A, Row extends { id: string }>(
  list: PagedList<A, Row>,
  end: ListEnd,
  rowControl: (id: string) => HTMLElement | null,
  rest: () => HTMLElement | null,
) {
  const from = useRef<number | null>(null)
  useFocusWhenGone(end === 'more', () => {
    if (end === 'loading') return null
    const row = from.current === null ? undefined : list.rows[from.current]
    return (row ? rowControl(row.id) : null) ?? rest()
  })
  const more = () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }
  const marker = useMoreOnScroll(more, end === 'more' && list.phase !== 'more')
  return { more, marker }
}
