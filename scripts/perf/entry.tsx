import App from '@perf/App'
import { AppearanceProvider } from '@perf/AppearanceProvider'
import { TooltipProvider } from '@perf/components/ui/tooltip'
import { initStore } from '@perf/store/planner'
import { createRoot } from 'react-dom/client'
import '@perf/styles/app.css'
import '@perf/styles/demo.css'

async function boot() {
  await initStore()
  createRoot(document.getElementById('root')!).render(
    <TooltipProvider>
      <AppearanceProvider accountId="perf-account">
        <App />
      </AppearanceProvider>
    </TooltipProvider>,
  )
}
void boot()
