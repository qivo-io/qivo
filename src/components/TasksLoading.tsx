import { useEffect, useRef, useState } from 'react'
import { P } from '../store/planner'
import { usePlannerVersion } from '../store/usePlannerVersion'
import { Button } from './ui/button'
import { Progress } from './ui/progress'

/** The share of tasks that arrived as a whole percent, or null once every
    task did (P.stillLoading). */
function loadedPercent(): number | null {
  const share = P.stillLoading()
  return share === null ? null : Math.min(99, Math.floor(share * 100))
}

/** The note over the bottom of the workspace while a large workspace still
    loads its tasks (store/liveParts.ts). It says that lists show the tasks
    that arrived and that counts and reports wait, with the share loaded. It
    floats, so the page does not move when it goes: a large Board would lay
    itself out again. A screen reader hears, politely, when loading starts
    and when it ends; the share sits in the progress bar, which it reads on
    request. Gone once every task arrived. Its parent must be positioned. */
export function TasksLoadingBar() {
  usePlannerVersion()
  const percent = loadedPercent()
  // whether this bar showed, so the end is said only after a start
  const shown = useRef(false)
  const [ended, setEnded] = useState(false)
  useEffect(() => {
    if (percent !== null) shown.current = true
    else if (shown.current) setEnded(true)
  }, [percent])
  return (
    <>
      <div role="status" className="sr-only">
        {percent !== null ? 'Loading tasks.' : ended ? 'Every task has loaded.' : ''}
      </div>
      {percent !== null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
          <div
            data-tasks-loading
            className="flex max-w-xl flex-col gap-2 rounded-xl border border-border bg-popover px-4 py-3 text-xs text-text-2 shadow-xl"
          >
            <div className="flex items-center gap-3">
              <span className="font-medium text-text-1">Loading tasks… {percent}%</span>
              <Progress
                className="h-1.5 min-w-24 flex-1"
                value={percent}
                aria-label="Tasks loaded"
              />
            </div>
            <span>
              Lists show the tasks that have arrived. Counts and reports wait until every task is
              in.
            </span>
          </div>
        </div>
      )}
    </>
  )
}

/** What a view that needs every task shows while tasks still load: `what`
    names the view, as in "The overview", and `onBack`, when given, leaves
    it. */
export function TasksLoadingView({ what, onBack }: { what: string; onBack?: () => void }) {
  usePlannerVersion()
  const percent = loadedPercent() ?? 99
  return (
    <div
      data-tasks-loading-view
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm text-text-2"
    >
      <p className="max-w-sm">{what} opens once every task has loaded.</p>
      <Progress className="h-1.5 w-48" value={percent} aria-label="Tasks loaded" />
      {onBack && (
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
      )}
    </div>
  )
}
