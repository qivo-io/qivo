import { P, TASKS_FAILED_TEXT } from '../store/planner'
import { usePlannerVersion } from '../store/usePlannerVersion'
import { Button } from './ui/button'
import { Progress } from './ui/progress'

/* Tasks load on demand (store/planner.ts P.askTasks): only a page or action
   that needs every task asks for them, and the load shows no share, since
   the task windows' answers come as one or two large transitions after a
   small first one, so a share would stand still near 0 and then jump. */

/** The note over the bottom of the workspace while every task loads (the
    load P.taskLoad reports): "Loading tasks…" with a bar that moves
    without a share, on one line. Once the load stopped it says why and
    that changes show as made until tasks load, with Try again
    (P.retryTasks). A stopped load also goes on once a task window answers
    again. It floats, so it
    covers little and the page does not move when it goes, as a large
    Board would lay itself out again. Gone before any ask and once every
    task arrived. Its parent must be positioned. App's useTasksLoadingNews
    says the start, the stop and the end to a screen reader. */
export function TasksLoadingBar() {
  usePlannerVersion()
  const load = P.taskLoad()
  if (load.state !== 'arriving' && load.state !== 'failed') return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4">
      {load.state === 'failed' ? (
        <div
          data-tasks-loading
          data-task-load="failed"
          className="pointer-events-auto flex max-w-xl items-center gap-3 rounded-lg border border-border bg-popover py-1.5 pr-1.5 pl-3 text-xs text-text-2 shadow-xl"
        >
          <p className="min-w-0">
            <span className="font-medium text-text-1">{TASKS_FAILED_TEXT}</span> {load.reason}
          </p>
          <Button
            variant="outline"
            size="xs"
            onClick={() => P.retryTasks()}
            disabled={load.retrying}
          >
            Try again
          </Button>
        </div>
      ) : (
        <div
          data-tasks-loading
          data-task-load="arriving"
          className="flex items-center gap-3 rounded-full border border-border bg-popover px-3 py-1.5 text-xs text-text-2 shadow-xl"
        >
          <span className="font-medium text-text-1">Loading tasks…</span>
          <Progress className="h-1.5 w-24" value={null} aria-label="Loading tasks" />
        </div>
      )}
    </div>
  )
}
