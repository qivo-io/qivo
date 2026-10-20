import { Component, type ReactNode, useSyncExternalStore } from 'react'
import { CodeWaitsForConnection, codeWaits, watchCodeWaits } from '../lib/lazyModule'
import { viewOfflineWords } from '../lib/noticeText'
import { type SyncStatus, syncStatus } from '../lib/syncStatus'
import { isUpdateBlocked, subscribeUpdateSafety } from '../lib/updateSafety'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

function ViewRecovery({ onBack, describedBy }: { onBack: () => void; describedBy: string }) {
  const blocked = useSyncExternalStore(subscribeUpdateSafety, isUpdateBlocked, isUpdateBlocked)
  return (
    <div role="alert" className="[padding:24px] [color:var(--text-2)]">
      <p id={describedBy}>
        This view could not be loaded. Check your connection and reload to try again.
      </p>
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

/** What a view whose code waits for the connection shows until it is back. */
function ViewWaiting({ onBack, describedBy }: { onBack: () => void; describedBy: string }) {
  const { title, line } = viewOfflineWords()
  return (
    <div role="alert" className="[padding:24px] [color:var(--text-2)]">
      <p className="[color:var(--text)] [font-weight:600]">{title}</p>
      <p id={describedBy}>{line}</p>
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
  /** Shown in place of the children while their code waits for the
      connection. Any other failure goes to the boundary above instead. */
  | { whileWaiting: ReactNode }
)

// gives each boundary its own id for the dialog's description
let boundaries = 0

/** A missing route chunk must not unmount the shell, drafts or update monitor.
 * A view whose code waits for the connection (lib/lazyModule) says so and
 * mounts again once it may load. Any other failure offers a reload. */
export class ViewBoundary extends Component<
  ViewBoundaryProps,
  { error: { cause: unknown } | null }
> {
  override state: { error: { cause: unknown } | null } = { error: null }
  private stopListening = () => {}
  private describedBy = `view-boundary-${++boundaries}`

  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } }
  }

  private get status() {
    return this.props.status ?? syncStatus
  }

  override componentDidMount() {
    const status = this.status
    this.stopListening = watchCodeWaits(status, () => {
      const cause = this.state.error?.cause
      if (cause instanceof CodeWaitsForConnection && !codeWaits(status))
        this.setState({ error: null })
    })
  }

  override componentWillUnmount() {
    this.stopListening()
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children
    const waiting = error.cause instanceof CodeWaitsForConnection
    if ('whileWaiting' in this.props) {
      if (waiting) return this.props.whileWaiting
      throw error.cause
    }
    const { onBack, overlay } = this.props
    const content = waiting ? (
      <ViewWaiting onBack={onBack} describedBy={this.describedBy} />
    ) : (
      <ViewRecovery onBack={onBack} describedBy={this.describedBy} />
    )
    return overlay ? (
      <Dialog open onOpenChange={(open) => !open && onBack()}>
        <DialogContent
          aria-describedby={this.describedBy}
          overlayClassName="z-[100]"
          className="z-[101]"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <DialogTitle className="sr-only">
            {waiting ? viewOfflineWords().title : 'View unavailable'}
          </DialogTitle>
          {content}
        </DialogContent>
      </Dialog>
    ) : (
      content
    )
  }
}
