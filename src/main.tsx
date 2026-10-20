import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import './styles/app.css'
import './styles/demo.css'
import { AuthGate } from './AuthGate'
import { AppUpdates } from './components/AppUpdates'
import { SnapshotNotice } from './components/SnapshotNotice'
import { DemoGate } from './DemoGate'
import { installAnnouncer } from './lib/announce'
import { convex } from './lib/convex'
import { DEMO_MODE } from './lib/demoMode'
import { installFocusVisibility } from './lib/focusVisibility'
import { installLeaveGuard } from './lib/leaveGuard'
import { syncStatus, watchConnection } from './lib/syncStatus'
import { P } from './store/planner'

const disposeFocusVisibility = installFocusVisibility()
import.meta.hot?.dispose(disposeFocusVisibility)
// before any dialog can open, so modal layers leave the regions exposed
const disposeAnnouncer = installAnnouncer()
import.meta.hot?.dispose(disposeAnnouncer)
// whether Qivo can save, which pauses edits (store/planner.ts write())
const stopWatchingConnection = watchConnection(syncStatus, convex)
import.meta.hot?.dispose(stopWatchingConnection)
// a change waiting for the server, or typed text an editor has not sent; the
// Convex count also covers panels that call a mutation directly
const removeLeaveGuard = installLeaveGuard(
  () => P.hasUnsavedWork() || convex.connectionState().inflightMutations > 0,
)
import.meta.hot?.dispose(removeLeaveGuard)

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    {DEMO_MODE ? (
      <DemoGate />
    ) : (
      <>
        <AuthGate />
        <AppUpdates />
      </>
    )}
    <SnapshotNotice />
  </TooltipProvider>,
)
