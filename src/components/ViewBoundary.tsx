import { Component, type ReactNode, useSyncExternalStore } from 'react'
import { retryFailedLoads } from '../lib/lazyModule'
import { viewPauseWords } from '../lib/noticeText'
import { type SavePause, type SyncStatus, syncStatus } from '../lib/syncStatus'
import { isUpdateBlocked, subscribeUpdateSafety } from '../lib/updateSafety'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

function ViewRecovery({ onBack }: { onBack: () => void }) {
  const blocked = useSyncExternalStore(subscribeUpdateSafety, isUpdateBlocked, isUpdateBlocked)
  return (
    <div role="alert" className="[padding:24px] [color:var(--text-2)]">
      <p>This view could not be loaded. Check your connection and reload to try again.</p>
      {blocked && <p>Finish or discard open edits before reloading.</p>}
      <div className="flex gap-2 mt-3">
        <Button variant="outline" onClick={onBack}>
          Back to workspace
        </Button>
        <Button
          disabled={blocked}
          onClick={() => {
            if (!isUpdateBlocked()) window.location.reload()
          }}
        >
          Reload
        </Button>
      </div>
    </div>
  )
}

/** What a view that failed during a pause shows until the pause ends. */
function ViewPaused({ kind, onBack }: { kind: SavePause['kind']; onBack: () => void }) {
  const { title, line } = viewPauseWords(kind)
  return (
    <div role="status" className="[padding:24px] [color:var(--text-2)]">
      <p className="[color:var(--text)] [font-weight:600]">{title}</p>
      <p>{line}</p>
      <div className="flex gap-2 mt-3">
        <Button variant="outline" onClick={onBack}>
          Back to workspace
        </Button>
      </div>
    </div>
  )
}

type ViewBoundaryProps = { children: ReactNode; status?: SyncStatus } & (
  | { onBack: () => void; overlay?: boolean }
  /** Shown in place of the children while saving pauses after they failed.
      A failure while Qivo can save goes to the boundary above instead. */
  | { whilePaused: ReactNode }
)

/** A missing route chunk must not unmount the shell, drafts or update monitor.
 * A failure during a pause, when the code cannot download, shows the pause
 * and tries again once the pause ends (lib/lazyModule). */
export class ViewBoundary extends Component<
  ViewBoundaryProps,
  { error: { cause: unknown } | null }
> {
  override state: { error: { cause: unknown } | null } = { error: null }
  private stopListening = () => {}

  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } }
  }

  private get status() {
    return this.props.status ?? syncStatus
  }

  override componentDidMount() {
    const status = this.status
    const unsubscribe = status.subscribe((ended) => {
      if (!this.state.error) return
      if (ended && !status.pause()) {
        retryFailedLoads()
        this.setState({ error: null })
      } else this.forceUpdate()
    })
    this.stopListening = unsubscribe
  }

  override componentWillUnmount() {
    this.stopListening()
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    const pause = this.status.pause()
    if ('whilePaused' in this.props) {
      if (pause) return this.props.whilePaused
      throw error.cause
    }
    const { onBack, overlay } = this.props
    const content = pause ? (
      <ViewPaused kind={pause.kind} onBack={onBack} />
    ) : (
      <ViewRecovery onBack={onBack} />
    )
    return overlay ? (
      <Dialog open onOpenChange={(open) => !open && onBack()}>
        <DialogContent
          aria-describedby={undefined}
          overlayClassName="z-[100]"
          className="z-[101]"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <DialogTitle className="sr-only">View unavailable</DialogTitle>
          {content}
        </DialogContent>
      </Dialog>
    ) : (
      content
    )
  }
}
