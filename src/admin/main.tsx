import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import '../styles/app.css'
import { AppUpdates } from '../components/AppUpdates'
import { installFocusVisibility } from '../lib/focusVisibility'
import { AdminGate } from './AdminGate'

const disposeFocusVisibility = installFocusVisibility()
import.meta.hot?.dispose(disposeFocusVisibility)

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <AdminGate />
    <AppUpdates />
  </TooltipProvider>,
)
