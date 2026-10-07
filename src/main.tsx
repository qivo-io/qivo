import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import './styles/app.css'
import './styles/demo.css'
import { AuthGate } from './AuthGate'
import { AppUpdates } from './components/AppUpdates'
import { DemoGate } from './DemoGate'
import { DEMO_MODE } from './lib/demoMode'
import { installFocusVisibility } from './lib/focusVisibility'

const disposeFocusVisibility = installFocusVisibility()
import.meta.hot?.dispose(disposeFocusVisibility)

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
  </TooltipProvider>,
)
