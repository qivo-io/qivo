import { TooltipProvider } from '@perf/components/ui/tooltip'
import { createRoot } from 'react-dom/client'
// before the app's modules, as in src/main.tsx, whose app chunk loads its
// stylesheets after these: the page's styles cascade in the same order
import '@perf/styles/app.css'
import '@perf/styles/demo.css'
import App from '@perf/App'
import { AppearanceProvider } from '@perf/AppearanceProvider'
import { installFocusVisibility } from '@perf/lib/focusVisibility'
import { initStore } from '@perf/store/planner'

async function boot() {
  // as src/main.tsx does: views tell pointer from keyboard input by it
  installFocusVisibility()
  // every scenario measures the complete workspace, never a partial one
  await initStore(undefined, undefined, { whole: true })
  createRoot(document.getElementById('root')!).render(
    <TooltipProvider>
      <AppearanceProvider accountId="perf-account">
        <App />
      </AppearanceProvider>
    </TooltipProvider>,
  )
}
void boot()
