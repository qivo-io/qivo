import { TooltipProvider } from '@perf/components/ui/tooltip'
import { createRoot } from 'react-dom/client'
// before the app's modules, as in src/main.tsx, whose app chunk loads its
// stylesheets after these: the page's styles cascade in the same order
import '@perf/styles/app.css'
import '@perf/styles/demo.css'
import App from '@perf/App'
import { AppearanceProvider } from '@perf/AppearanceProvider'
import { installFocusVisibility } from '@perf/lib/focusVisibility'
import * as liveParts from '@perf/store/liveParts'
import * as planner from '@perf/store/planner'

async function boot() {
  // as src/main.tsx does: views tell pointer from keyboard input by it
  installFocusVisibility()
  // The app's boot, which loads tasks on demand, or with taskload=boot every
  // task as it boots, the cost of the app before tasks on demand. A baseline
  // store from before it (scripts/perf/page.mjs) has no TASKS and loads
  // every task as it boots either way.
  const tasks = Reflect.get(liveParts, 'TASKS') as { atBoot: boolean } | undefined
  const parameters = new URLSearchParams(location.search)
  if (tasks && parameters.get('taskload') === 'boot') tasks.atBoot = true
  // milestones=sync-too-many: no milestone read may name a project, so Team
  // sync's opening asks nothing and says why (scripts/perf/server.mjs)
  const reads = Reflect.get(planner, 'MILESTONE_READS') as { projects: number } | undefined
  if (reads && (parameters.get('milestones') ?? '').split(',').includes('sync-too-many'))
    reads.projects = 0
  await planner.initStore()
  createRoot(document.getElementById('root')!).render(
    <TooltipProvider>
      <AppearanceProvider accountId="perf-account">
        <App />
      </AppearanceProvider>
    </TooltipProvider>,
  )
}
void boot()
