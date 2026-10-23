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
    loads its tasks (store/liveParts.ts): one line with the share loaded,
    the share it stopped at while the workspace cannot load
    (P.snapshotTrouble, which the notices explain), or that it waits for
    the server (P.waitingForServer), so a page whose tasks stop arriving
    for a while does not look frozen. It floats and keeps to
    one line, so it covers little and the page does not move when it goes:
    a large Board would lay itself out again. Gone once every task arrived.
    Its parent must be positioned. App's useTasksLoadingNews says the start
    and the end to a screen reader. */
export function TasksLoadingBar() {
  usePlannerVersion()
  usePlannerVersion('health')
  const percent = loadedPercent()
  if (percent === null) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
      <div
        data-tasks-loading
        className="flex items-center gap-3 rounded-full border border-border bg-popover px-3 py-1.5 text-xs text-text-2 shadow-xl"
      >
        <span className="font-medium text-text-1">
          {P.snapshotTrouble()
            ? `Tasks stopped loading at ${percent}%`
            : P.waitingForServer()
              ? `Waiting for the server… ${percent}%`
              : `Loading tasks… ${percent}%`}
        </span>
        <Progress className="h-1.5 w-24" value={percent} aria-label="Tasks loaded" />
      </div>
    </div>
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
