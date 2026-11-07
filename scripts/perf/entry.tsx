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
  // milestonecap=<n>: the Milestones window's sections read batches of n
  // and hold at most 2n rows (src/lib/milestoneSection.ts), so the moved-on
  // note shows with few milestones. A baseline from before that module has
  // none, so it is found through a glob, which answers nothing there
  const cap = Number(parameters.get('milestonecap'))
  if (cap > 0) {
    const found = import.meta.glob<{ MILESTONE_SECTION: { batch: number; rows: number } }>(
      '@perf/lib/milestoneSection.ts',
      { eager: true },
    )
    for (const module of Object.values(found))
      Object.assign(module.MILESTONE_SECTION, { batch: cap, rows: 2 * cap })
  }
  // threadkeep=<n>: the task window keeps at most n comments and changes
  // of the open task (src/lib/threadBudget.ts), so the benchmark's thread
  // phase can measure each candidate figure. A baseline from before that
  // module has none, so it is found through a glob too
  const keep = Number(parameters.get('threadkeep'))
  if (keep > 0) {
    const found = import.meta.glob<{ THREAD_KEEP: { rows: number } }>('@perf/lib/threadBudget.ts', {
      eager: true,
    })
    for (const module of Object.values(found)) module.THREAD_KEEP.rows = keep
  }
  // pictureskept=<bytes>: the profile pictures keep at most that many bytes
  // (src/lib/avatarSources.ts AVATAR_SOURCES), so past it a picture waits
  // as initials with few people. A baseline without the budget finds none
  const kept = Number(parameters.get('pictureskept'))
  if (kept > 0) {
    const found = import.meta.glob<{ AVATAR_SOURCES: { keptBytes: number } }>(
      '@perf/lib/avatarSources.ts',
      { eager: true },
    )
    for (const module of Object.values(found))
      if (module.AVATAR_SOURCES) module.AVATAR_SOURCES.keptBytes = kept
  }
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
