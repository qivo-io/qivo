/* The Overview of a scope: My view's page (views/overview/MyOverview.tsx)
   or a project or sub-project's (views/overview/ProjectOverview.tsx). App
   mounts the page anew for each scope, so one mount shows one of them. */

import type { ScopeInfo } from '../store/planner'
import { MyOverview } from './overview/MyOverview'
import type { OverviewActions } from './overview/overviewParts'
import { ProjectOverview } from './overview/ProjectOverview'

function Overview({ info, actions }: { info: ScopeInfo; actions: OverviewActions }) {
  return info.mine ? (
    <MyOverview info={info} actions={actions} />
  ) : (
    <ProjectOverview info={info} actions={actions} />
  )
}

export { Overview }
