/* The list of sub-projects a person may add tasks to, from the server
   (convex/projectNav.ts targets): the New task dialog's Sub-project picker
   across every seat and the Move window's targets in the task's
   organization. The store holds no project, and filtering a navigation
   list by levels in the browser would show a short batch as the whole
   list, so the server applies the write's rule (Edit or Lead) before it
   cuts each batch of 25. Rows come grouped under their top-level project's
   name, in the server's order, with a search of either name, Load more and
   the shared batch notes: not ready, stopped, failed, the refusal, and only
   at a confirmed end "No sub-project you can add tasks to." It reads only
   while it is mounted and the page shows (lib/pagedList.ts usePagedList).
   A chosen row seeds its facts and its parent's into the project cache
   (components/projectNavRows.tsx seedNavRow), so a create or a move into it
   reads its organization and parent at once. */

import { useEffect, useId, useRef, useState } from 'react'
import { api } from '../../convex/_generated/api'
import { LIMITS } from '../../convex/lib/limits'
import type { NavTargetRow, NavTargets } from '../../convex/model/projectNavReads'
import { listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { cn } from '../lib/utils'
import { P } from '../store/planner'
import { ChoiceEnd, PickerSearch } from './pickerParts'
import { type ChoiceWords, TARGET_WORDS } from './pickerWords'
import { navCursors, seedNavRow } from './projectNavRows'

/** The most targets Load more gathers, past which the list asks for a
    search. */
export const TARGETS_MOST = 500

/** The data attribute that marks the picker's search box. */
const TARGET_SEARCH = 'data-target-search'

/** The first rows a picker opens on: the rows of its list once a batch
    holds one, for a caller that opens on a default. */
export type TargetRows = readonly NavTargetRow[]

/**
 * The sub-projects the person may add tasks to, in organization `org` or
 * across every seat, as a list of radio rows grouped under their top-level
 * project; `value` the chosen sub-project's id, `onChoose` a pick, which
 * seeds the row's facts. `current` is marked and cannot be chosen (the
 * Move window's own sub-project). `onRows` hears the rows the list holds,
 * so a caller can open on a default once a batch holds it. `words` words
 * its end.
 */
export function TargetPicker({
  org,
  value,
  onChoose,
  current,
  onRows,
  words = TARGET_WORDS,
  label,
}: {
  org?: string
  value: string | null
  onChoose: (row: NavTargetRow) => void
  current?: string
  onRows?: (rows: TargetRows) => void
  words?: ChoiceWords
  label: string
}) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const query = search.settled
  const key = JSON.stringify(['targets', org ?? null, query])
  const list = usePagedList<NavTargets, NavTargetRow>({
    key,
    source: {
      kind: 'live',
      query: api.projectNav.targets,
      args: (at) => ({
        ...(org ? { org_id: org } : {}),
        ...(query ? { search: query } : {}),
        ...navCursors(at),
      }),
    },
    batch: (answer) => (answer.state === 'ok' ? answer : null),
    id: (row) => row.id,
    most: TARGETS_MOST,
  })
  const answered = !search.tooLong && query === search.typed
  const end = answered ? listEnd(list, query !== '') : 'loading'
  const group = useId()
  /** Seeds `row`'s facts and its parent's, then hands it on. */
  const choose = (row: NavTargetRow) => {
    seedNavRow({
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      num: row.num,
      parent: {
        id: row.parent_id,
        org_id: row.org_id,
        name: row.parent_name,
        num: row.parent_num,
      },
    })
    onChoose(row)
  }
  const heard = useRef(onRows)
  heard.current = onRows
  useEffect(() => {
    heard.current?.(list.rows)
  }, [list.rows])
  // the rows under their top-level project, in the server's order
  const groups: { parent: string; name: string; rows: NavTargetRow[] }[] = []
  for (const row of list.rows) {
    const last = groups.at(-1)
    if (last && last.parent === row.parent_id) last.rows.push(row)
    else
      groups.push({
        parent: row.parent_id,
        name: P.projectLabel({ id: row.parent_id, name: row.parent_name }),
        rows: [row],
      })
  }
  return (
    <div data-target-picker data-picker-state={answered ? list.phase : 'loading'}>
      <PickerSearch
        text={text}
        onText={setText}
        label={`Find a ${label.toLowerCase()}`}
        probe={TARGET_SEARCH}
      />
      <div
        role="radiogroup"
        aria-label={label}
        aria-busy={!answered || list.phase === 'more' || undefined}
        className="mt-2 max-h-56 overflow-auto rounded-md border border-border"
      >
        {groups.map((g) => (
          <div key={g.parent} data-target-group={g.parent}>
            <div className="px-2 pt-2 pb-1 text-xs text-text-3">{g.name}</div>
            {g.rows.map((row) => {
              const isCurrent = row.id === current
              const on = row.id === value
              return (
                <label
                  key={row.id}
                  data-target={row.id}
                  data-target-current={isCurrent ? '' : undefined}
                  className={cn(
                    'flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-text-1 hover:bg-hover has-[:disabled]:cursor-default has-[:disabled]:text-text-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                    on && 'bg-selected font-medium',
                  )}
                >
                  <input
                    type="radio"
                    name={group}
                    className="sr-only"
                    checked={on}
                    disabled={isCurrent || !answered}
                    onChange={() => choose(row)}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {P.projectLabel({ id: row.id, name: row.name })}
                  </span>
                  {isCurrent && <span className="text-xs text-text-3">Current</span>}
                </label>
              )
            })}
          </div>
        ))}
        <ChoiceEnd end={end} tooLong={search.tooLong} list={list} words={words} menu={false} />
      </div>
    </div>
  )
}
