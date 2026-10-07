import { Component, type ReactNode, useSyncExternalStore } from 'react'
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

/** A missing route chunk must not unmount the shell, drafts or update monitor. */
export class ViewBoundary extends Component<
  { children: ReactNode; onBack: () => void; overlay?: boolean },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  override render() {
    if (!this.state.failed) return this.props.children
    const recovery = <ViewRecovery onBack={this.props.onBack} />
    return this.props.overlay ? (
      <Dialog open onOpenChange={(open) => !open && this.props.onBack()}>
        <DialogContent
          aria-describedby={undefined}
          overlayClassName="z-[100] bg-[var(--scrim)] backdrop-blur-[4px]"
          className="z-[101]"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <DialogTitle className="sr-only">View unavailable</DialogTitle>
          {recovery}
        </DialogContent>
      </Dialog>
    ) : (
      recovery
    )
  }
}
