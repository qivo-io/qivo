import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import '../styles/app.css'
import { AppUpdates } from '../components/AppUpdates'
import { SavePauseNotice } from '../components/SavePauseNotice'
import { convex } from '../lib/convex'
import { installFocusVisibility } from '../lib/focusVisibility'
import { installLeaveGuard } from '../lib/leaveGuard'
import { syncStatus, watchConnection } from '../lib/syncStatus'
import { AdminGate } from './AdminGate'

const disposeFocusVisibility = installFocusVisibility()
import.meta.hot?.dispose(disposeFocusVisibility)
// whether Qivo can save, which pauses the console's changes (./convex.ts)
const stopWatchingConnection = watchConnection(syncStatus, convex)
import.meta.hot?.dispose(stopWatchingConnection)
// The console's writes wait for their answer in its own forms, and many are
// actions. Warn while a mutation or an action has not been answered, sent or
// not yet sent, as Convex's own warning did for the sent ones.
const removeLeaveGuard = installLeaveGuard(() => {
  const state = convex.connectionState()
  return state.inflightMutations > 0 || state.inflightActions > 0
})
import.meta.hot?.dispose(removeLeaveGuard)

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <AdminGate />
    <AppUpdates />
    <SavePauseNotice />
  </TooltipProvider>,
)
