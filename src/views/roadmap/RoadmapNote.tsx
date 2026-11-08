/* What the Roadmap says in place of its rows when it cannot show a
   selection's tasks (useRoadmapView): the narrowing message of a
   selection past the Roadmap's limits, a Roadmap
   that is not available or did not load, a text filter past its limit, a
   wait, and a row source that did not bring a task. Each is an empty state
   (components/ViewNote.tsx). The Roadmap keeps its toolbar beside every
   one, and its timeline frame in a project, a sub-project and My view, and
   none names a shorter window as a way to narrow. The window bounds only
   Done tasks, since unfinished work shows whatever its dates; the line
   about the milestone flags may offer it (roadmapMilestones.ts
   markerLine), as the window bounds their range read. None shows part of
   a Roadmap. */

import type { ReactNode } from 'react'
import { LIMITS } from '../../../convex/lib/limits'
import { ViewNote } from '../../components/ViewNote'
import { limitSentence } from '../../lib/fieldLimits'
import type { ScopeInfo } from '../../store/planner'
import type { RoadmapView } from './useRoadmapView'

type Actions = Record<string, (...args: unknown[]) => void>

/** The ways to narrow a selection past the Roadmap's limits, for `view` of
    `info` on a phone or not. */
function narrowing(view: RoadmapView, info: ScopeInfo, phone: boolean) {
  if (info.mine)
    return {
      hint: phone
        ? 'Narrow your filters, such as Priority, or open a project.'
        : 'Narrow your filters, such as Priority or the text filter, or open a project.',
    }
  if (info.isMeta) {
    // the answer's sub-projects the store knows, in the Roadmap's track order
    const offered = new Set(view.answer && 'projects' in view.answer ? view.answer.projects : [])
    return {
      hint: 'Choose a sub-project or narrow your filters.',
      projects: info.groups
        .filter((g) => offered.has(g.proj.id))
        .map((g) => g.proj)
        .sort((a, b) => a.name.localeCompare(b.name)),
    }
  }
  return { hint: 'Narrow your filters.' }
}

/** What the Roadmap says for `view`'s state, or null when it shows tasks. */
export function RoadmapNote({
  view,
  info,
  actions,
  phone,
}: {
  view: RoadmapView
  info: ScopeInfo
  actions: Actions
  phone: boolean
}): ReactNode {
  const open = (id: string) => actions.setScope(id)
  switch (view.state) {
    case 'over_ceiling': {
      const { hint, projects } = narrowing(view, info, phone)
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="filter"
          title={limitSentence(LIMITS.roadmapTasks)}
          hint={hint}
          projects={projects}
          onProject={open}
        />
      )
    }
    case 'over_budget': {
      // one sub-project offers nothing smaller to choose, so Search finds
      // its tasks instead
      const sub = !info.wide && !info.isMeta
      const { hint, projects } = narrowing(view, info, phone)
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="filter"
          title="This selection could not be loaded within the Roadmap's limits."
          hint={sub ? 'Narrow your filters, or find its tasks with Search.' : hint}
          projects={projects}
          onProject={open}
          action={
            sub
              ? { label: 'Search this sub-project', onClick: () => actions.openPalette(info.id) }
              : undefined
          }
        />
      )
    }
    case 'unavailable':
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="eyeOff"
          title="This Roadmap is not available"
          hint={
            view.answer?.state === 'unavailable' && view.answer.message
              ? view.answer.message
              : 'Qivo cannot show this project here. Choose another project.'
          }
        />
      )
    case 'error':
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="alert"
          title="The Roadmap could not be loaded"
          hint="Try again asks the server for this Roadmap once more."
          action={{ label: 'Try again', onClick: view.retry }}
        />
      )
    case 'search_limit':
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="search"
          title={limitSentence(LIMITS.search)}
          hint="The Roadmap shows tasks again once the text filter is short enough."
        />
      )
    case 'incomplete':
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="alert"
          title="Some tasks of this Roadmap have not reached this window."
          hint="Try again asks the server for this Roadmap once more. If the tasks still do not show, reload the page."
          action={{ label: 'Try again', onClick: view.retry }}
        />
      )
    case 'loading':
      return (
        <ViewNote
          hooks="roadmap"
          phone={phone}
          icon="timeline"
          title="Loading tasks…"
          hint="Qivo is checking which tasks this Roadmap shows."
        />
      )
    default:
      return null
  }
}
