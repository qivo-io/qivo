import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import '../styles/app.css'
import { AppUpdates } from '../components/AppUpdates'
import { convex } from '../lib/convex'
import { installFocusVisibility } from '../lib/focusVisibility'
import { installLeaveGuard } from '../lib/leaveGuard'
import { AdminGate } from './AdminGate'

const disposeFocusVisibility = installFocusVisibility()
import.meta.hot?.dispose(disposeFocusVisibility)
// The console's writes wait for their answer in its own forms. Warn while
// one has not been answered, sent or not yet sent.
const removeLeaveGuard = installLeaveGuard(() => convex.connectionState().inflightMutations > 0)
import.meta.hot?.dispose(removeLeaveGuard)

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <AdminGate />
    <AppUpdates />
  </TooltipProvider>,
)
