import { getFunctionName } from 'convex/server'
import { act, type ReactNode, useState } from 'react'
import type { Root } from 'react-dom/client'
import { vi } from 'vitest'
import { plannerFixture, type Snapshot } from '../store/plannerFixture.setup'

/* The Board on the real store for jsdom tests. A test file mocks
   ../lib/convex with `network` and ../lib/auth as memoRows.test.tsx does,
   then loads the store with loadBoard and renders board() in its own root.
   Writes never answer, so an edit stays applied locally. */

type Network = {
  mutation: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
  onUpdate: ReturnType<typeof vi.fn>
}
type Row = Snapshot['issues'][number]
/** What renders beside the Board for the task it opened, given a close. */
type Window = (opened: string | null, close: () => void) => ReactNode

const AT = '2026-09-14T08:00:00.000Z'

/** A task row in the fixture's one project, owned by its one person. */
export function taskRow(snapshot: Snapshot, id: string, status: Row['status'], num: number): Row {
  return {
    id,
    org_id: snapshot.orgs[0].id,
    project_id: snapshot.projects[0].id,
    num,
    title: `Task ${id}`,
    description: '',
    status,
    priority: 'medium',
    assignee_id: snapshot.profiles[0].id,
    created_at: AT,
    updated_at: AT,
    paused: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
  }
}

/** Boots a fresh store on the fixture with the tasks `prepare` adds, and
    returns it with the Board and a way to deliver a changed snapshot. */
export async function loadBoard(network: Network, prepare: (snapshot: Snapshot) => void) {
  vi.resetModules()
  const snapshot = plannerFixture()
  prepare(snapshot)
  let deliver: (snap: Snapshot) => void = () => {}
  network.query.mockResolvedValue(null)
  network.onUpdate.mockImplementation((ref, _args, next) => {
    const name = getFunctionName(ref)
    if (name === 'snapshot:forMe') {
      deliver = (snap) => next(structuredClone(snap))
      deliver(snapshot)
    } else if (name === 'snapshot:commentThread') next({ comments: [], earlier: false, events: [] })
    return () => {}
  })
  network.mutation.mockImplementation((ref) =>
    getFunctionName(ref) === 'identity:claimMySeats'
      ? Promise.resolve(null)
      : new Promise(() => {}),
  )
  const store = await import('../store/planner')
  await store.initStore()
  const { usePlannerVersion } = await import('../store/usePlannerVersion')
  const { TooltipProvider } = await import('../components/ui/tooltip')
  const { Kanban } = await import('./Kanban')
  const { P } = store
  const scope = snapshot.projects[0].id
  const filters = {
    mine: false,
    assignees: [],
    priority: null,
    stale: false,
    focus: false,
    search: '',
  }
  /** The Board as App renders it, again on every store change. `window`
      renders beside it in the same root, with the task the Board opened. */
  function Screen({ window }: { window?: Window }) {
    usePlannerVersion()
    const [opened, setOpened] = useState<string | null>(null)
    const info = P.scopeInfo(scope)
    if (!info) throw new Error('missing the scope')
    return (
      <TooltipProvider>
        <Kanban
          info={info}
          filters={filters}
          tweaks={{ metaViz: 'swimlanes' }}
          actions={{ openIssue: setOpened as (...args: unknown[]) => void }}
        />
        {window?.(opened, () => setOpened(null))}
      </TooltipProvider>
    )
  }
  return {
    P,
    snapshot,
    /** The Board's row for the task stored as `uuid`; the Board names a
        task by its key. */
    card: (uuid: string) =>
      document.querySelector<HTMLElement>(
        `[data-card="${P.issues.find((it) => it.uuid === uuid)?.id}"]`,
      ),
    /** Delivers `snapshot` as it is now, as the server would after a change. */
    deliver: () => act(async () => deliver(snapshot)),
    render: (root: Root, window?: Window) =>
      act(async () => root.render(<Screen window={window} />)),
  }
}

/** A drag event jsdom can carry, with a transfer that holds `id`. */
export function dragEvent(type: string, id: string) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  const data = new Map([['text/plain', id]])
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      effectAllowed: 'all',
      dropEffect: 'none',
      setData: (format: string, value: string) => data.set(format, value),
      getData: (format: string) => data.get(format) ?? '',
    },
  })
  return event
}

/** The Board cell of `status` in the pooled lane. */
export const cell = (status: string) =>
  document.querySelector<HTMLElement>(`[data-board-cell][data-status="${status}"]`)
