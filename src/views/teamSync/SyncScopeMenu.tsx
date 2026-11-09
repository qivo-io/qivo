/* Team sync's scope menu (views/TeamSync.tsx): a trigger that names the
   scope the page shows, or says "Choose a scope" where the page asks to
   choose, and a popover with a search over All projects, the home
   organization's teams and its projects.

   The teams come from the server (teams.picker, P.teamChoices), 25 a batch
   in name order, read once a batch only while the menu is open and the
   page shows, with the server's search over every team, Load more and the
   list's end lines (components/pickerParts.tsx CommandChoiceEnd), at most
   TEAM_CAPS.teams kept, past which the list asks for a search. The store
   holds only the signed-in person's own teams, so the menu never lists
   them in place of the server's.

   The projects come from the server too: the home organization's
   top-level projects the person sees, 25 a batch in name order
   (projectNav.page with the home organization), and with a search the
   matching ones (projectNav.search with the home organization), where a
   sub-project's result shows its top-level project once, so a searched
   batch can hold fewer rows than it read. Both are read only while the
   menu is open and the page shows, with Load more and the list's end
   lines. A sub-project scope, as a /sync/p/<n> link opens, is offered as
   itself, named through the project cache. Equal names carry their number,
   told apart among the rows the menu shows (components/projectNavRows.tsx
   navTags), never by what the project cache holds.

   The closed trigger names a team scope among the person's own teams from
   the store at once, and any other from teams.get while the page shows
   that scope (panels/settings/useTeamSettings.ts), "Loading…" until it
   answers, the page's sentence for a team it cannot show, and a failed
   read with Try again, never "Choose a scope" for a team it has not named
   yet. A refresh that fails after the team was named keeps its name, with
   Try again beside it. A team that teams.get answers unavailable shows the
   page's sentence, also after the trigger named it. */

import { type ReactNode, useEffect, useRef, useState } from 'react'
import { navCursors, navTags, seedNavRow } from '@/components/projectNavRows'
import { Icon, Popover } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DropdownChevron } from '@/components/ui/select'
import { useProjects } from '@/components/useProjects'
import { TEAM_CAPS } from '@/lib/accessCaps'
import { listEnd, usePagedList, useSettledSearch } from '@/lib/pagedList'
import { type SyncPlaceScope, syncScopeKey } from '@/lib/teamSync'
import { cn } from '@/lib/utils'
import { useViewVisibility } from '@/lib/viewVisibility'
import { useTeamSettings } from '@/panels/settings/useTeamSettings'
import { P, type ScopeTeamChoice, type ScopeTeamChoices } from '@/store/planner'
import { usePlannerVersion } from '@/store/usePlannerVersion'
import { api } from '../../../convex/_generated/api'
import { LIMITS } from '../../../convex/lib/limits'
import { nameKey } from '../../../convex/lib/nameKey'
import { allWordsMatcher } from '../../../convex/lib/search'
import type {
  NavPage,
  NavPageRow,
  NavProject,
  NavSearch,
} from '../../../convex/model/projectNavReads'
import { CommandChoiceEnd } from '../../components/pickerParts'
import { type ChoiceWords, ESCAPE_CLEARS, escapeClearsFirst } from '../../components/pickerWords'

/** The data attribute that marks the menu's search box. */
const SCOPE_SEARCH = 'data-sync-scope-search'

/** The words of the scope menu's teams. */
const SCOPE_TEAM_WORDS: ChoiceWords = {
  held: (held) =>
    held?.state === 'refused' && held.message ? held.message : "Teams can't be listed yet.",
  failed: "Couldn't load teams.",
  stopped: 'Showing the teams found so far.',
  empty: 'No teams yet.',
  none: 'No matching teams.',
}

/** The words of the scope menu's projects. */
const SCOPE_PROJECT_WORDS: ChoiceWords = {
  held: (held) =>
    held?.state === 'refused' && held.message ? held.message : "Projects can't be listed yet.",
  failed: "Couldn't load projects.",
  stopped: 'Showing the projects found so far.',
  empty: 'No projects yet.',
  none: 'No matching projects.',
}

/** The most projects the menu's Load more gathers, past which it asks for
    a search, as the sidebar's list does. */
const SCOPE_PROJECTS_MOST = 200

/** What the projects' paged list answers: a page batch or a search batch
    of the home organization, refusals and not ready held. */
type ProjectsAnswer = NavPage | NavSearch

/** The top-level project a menu row names: a page row itself, or for a
    search row its top-level project, a sub-project's parent. */
type MenuProject = NavProject

/** What the trigger says while it cannot name the scope (scopeName). */
const SCOPE_WORDS = {
  choose: 'Choose a scope',
  loading: 'Loading…',
  unavailable: 'Team not available',
  failed: "Couldn't load this team",
}

/** The words for scope `scope` on the closed trigger, with whether the
    team read behind them failed, also one that keeps an earlier answer's
    name, from the store's own teams and projects and `team`, teams.get's
    read of a team the person is not in. */
function scopeName(
  scope: SyncPlaceScope,
  named: boolean,
  team: ReturnType<typeof useTeamSettings>,
): { label: string; icon: ReactNode; failed: boolean } {
  const none = { label: SCOPE_WORDS.choose, icon: null, failed: false }
  if (!named) return none
  if (scope.kind === 'all')
    return { label: 'All projects', icon: <Icon name="layers" size={14} />, failed: false }
  if (scope.kind === 'project') {
    const project = P.project(scope.id)
    return project ? { label: P.projectLabel(project), icon: null, failed: false } : none
  }
  if (scope.kind !== 'team') return none
  const icon = <Icon name="people" size={14} />
  const own = P.teamById(scope.id)
  if (own && own.org === P.homeOrg) return { label: own.name, icon, failed: false }
  if (team.state === 'unavailable') return { label: SCOPE_WORDS.unavailable, icon, failed: false }
  if (team.answer) return { label: team.answer.team.name, icon, failed: team.state === 'failed' }
  if (team.state === 'failed') return { label: SCOPE_WORDS.failed, icon, failed: true }
  return { label: SCOPE_WORDS.loading, icon, failed: false }
}

/**
 * Team sync's scope choice. `scope` is the scope the page shows and `named`
 * whether the page names it (false where it asks to choose); `onPick`
 * writes a scope key (lib/teamSync.ts parseSyncScope) as the page's own
 * pick does.
 */
export function SyncScopeMenu({
  scope,
  named,
  onPick,
}: {
  scope: SyncPlaceScope
  named: boolean
  onPick: (key: string) => void
}) {
  usePlannerVersion()
  // a project scope is named through the project cache while it shows
  useProjects([named && scope.kind === 'project' ? scope.id : null])
  // a team scope the person is not in is named from the server
  const own = scope.kind === 'team' ? P.teamById(scope.id) : undefined
  const foreign = named && scope.kind === 'team' && !(own && own.org === P.homeOrg)
  const team = useTeamSettings(foreign && scope.kind === 'team' ? scope.id : null)
  const shown = scopeName(scope, named, team)
  return (
    <span data-sync-scope className="inline-flex min-w-0 items-center gap-2">
      <Popover
        width={260}
        align="left"
        backLayer
        onEscapeKeyDown={escapeClearsFirst(SCOPE_SEARCH)}
        button={(_toggle, open) => (
          <Button
            type="button"
            variant="unstyled"
            data-fieldselect
            data-sync-scope-trigger={shown.label}
            aria-label="Sync scope"
            aria-haspopup="dialog"
            aria-expanded={open}
            className={cn(
              'flex h-control w-fit max-w-[260px] cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-surface-1 py-0 pr-2 pl-2.5 text-left text-sm whitespace-nowrap text-text-1 shadow-xs outline-none transition-[color,box-shadow]',
              shown.label === SCOPE_WORDS.choose && 'text-muted-foreground',
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              {shown.icon}
              <span className="truncate" data-sync-scope-name="">
                {shown.label}
              </span>
            </span>
            <DropdownChevron />
          </Button>
        )}
      >
        {(close) => (
          <ScopeList
            scope={scope}
            onPick={(key) =>
              close(() => {
                if (key !== syncScopeKey(scope) || !named) onPick(key)
              })
            }
          />
        )}
      </Popover>
      {shown.failed && (
        <Button
          type="button"
          variant="ghost"
          className="h-control-sm text-sm"
          data-sync-scope-retry=""
          onClick={team.retry}
        >
          Try again
        </Button>
      )}
    </span>
  )
}

/* The value of the All projects item, which no team or project id takes. */
const ALL = 'all'

/**
 * The open menu: a search box, All projects, and the home organization's
 * teams and top-level projects a batch at a time from the server. Enter
 * acts only on the answers for the typed text. The reads run only while
 * the list is mounted, which it is while the menu is open, and not while
 * the page is hidden.
 */
function ScopeList({ scope, onPick }: { scope: SyncPlaceScope; onPick: (key: string) => void }) {
  const [text, setText] = useState('')
  const search = useSettledSearch(text, LIMITS.search)
  const typed = search.typed
  const query = search.settled
  const { visible } = useViewVisibility()
  const org = P.homeOrg
  const listKey = `${org}\n${query}`
  const list = usePagedList<ScopeTeamChoices, ScopeTeamChoice>({
    key: visible && org ? listKey : null,
    source: {
      kind: 'once',
      read: (at) => P.teamChoices({ org, search: query, cursor: at.after }),
    },
    batch: (answer) => (answer.state === 'ready' ? answer : null),
    id: (row) => row.id,
    most: TEAM_CAPS.teams,
  })
  // the list the paged list opened, which it opens after the render that
  // names a new one, so that render never takes an older text's rows as
  // this text's answer
  const opened = useRef<string | null>(null)
  useEffect(() => {
    opened.current = listKey
  })
  const answered =
    !search.tooLong && query === typed && opened.current === listKey && list.phase !== 'first'
  const stale = !answered
  const end = answered ? listEnd(list, query !== '') : 'loading'

  const projectList = usePagedList<ProjectsAnswer, MenuProject>({
    key: visible && org ? JSON.stringify(['sync-menu', org, query]) : null,
    source:
      query === ''
        ? {
            kind: 'live',
            query: api.projectNav.page,
            args: (at) => ({ org_id: org, ...navCursors(at) }),
          }
        : {
            kind: 'live',
            query: api.projectNav.search,
            args: (at) => ({ search: query, org_id: org, ...navCursors(at) }),
          },
    batch: (answer) => {
      if (answer.state !== 'ok') return null
      // a sub-project's result shows its top-level project, once a batch
      const seen = new Set<string>()
      const rows: MenuProject[] = []
      for (const row of answer.rows as readonly (NavPageRow & { parent?: NavProject | null })[]) {
        const top = row.parent ?? row
        if (seen.has(top.id)) continue
        seen.add(top.id)
        rows.push({ id: top.id, org_id: top.org_id, name: top.name, num: top.num })
      }
      return { rows, next: answer.next, stopped: answer.stopped }
    },
    id: (row) => row.id,
    most: SCOPE_PROJECTS_MOST,
  })
  const projectEnd = answered ? listEnd(projectList, query !== '') : 'loading'

  const matches = allWordsMatcher(nameKey(typed))
  const showAll = typed === '' || matches(nameKey('All projects'))
  // a sub-project scope (a /sync/p/<n> link) is offered as itself, named
  // through the project cache
  const ownProject = scope.kind === 'project' ? P.project(scope.id) : undefined
  const shownProjects: MenuProject[] = [...projectList.rows]
  if (
    ownProject &&
    ownProject.type === 'project' &&
    (typed === '' || matches(nameKey(P.projectLabel(ownProject))))
  )
    shownProjects.push({
      id: ownProject.id,
      org_id: ownProject.org,
      name: ownProject.name,
      num: ownProject.num,
    })
  // equal names told apart among the rows shown, the sub-project scope
  // under its own parent
  const ownParent = ownProject?.parent ? P.project(ownProject.parent) : undefined
  const tags = navTags(shownProjects, (row) =>
    ownProject?.parent && row.id === ownProject.id
      ? {
          id: ownProject.parent,
          org_id: ownProject.org,
          name: ownParent?.name ?? '',
          num: ownParent?.num ?? 0,
        }
      : null,
  )
  const labelOf = (p: MenuProject) => {
    const tag = tags.get(p.id)
    return tag ? `${p.name} ${tag}` : p.name
  }
  const current = syncScopeKey(scope)
  const [value, setValue] = useState(current || ALL)

  const rowClass = 'gap-2 py-1.5 text-sm'
  const check = (key: string) =>
    key === current ? <Icon name="check" size={14} color="var(--muted-foreground)" /> : null
  return (
    <Command
      aria-label="Choose a scope"
      shouldFilter={false}
      value={value}
      onValueChange={setValue}
      data-sync-scope-menu=""
      data-picker-state={stale ? 'loading' : list.phase}
      aria-busy={stale || list.phase === 'more' || undefined}
    >
      <CommandInput
        value={text}
        onValueChange={setText}
        placeholder="Find a team or project…"
        aria-label="Find a team or project"
        {...{ [SCOPE_SEARCH]: '', [ESCAPE_CLEARS]: '' }}
        onKeyDown={(event) => {
          // Enter acts only on the answer for the typed text
          if (event.key === 'Enter' && stale) event.preventDefault()
          if (event.key === 'Escape' && text !== '') setText('')
        }}
      />
      <CommandList className="max-h-72">
        {showAll && (
          <CommandItem
            value={ALL}
            data-sync-scope-choice={ALL}
            onSelect={() => onPick(ALL)}
            className={rowClass}
          >
            <Icon name="layers" size={14} />
            <span className="min-w-0 flex-1 truncate">All projects</span>
            {check(ALL)}
          </CommandItem>
        )}
        <div data-sync-scope-group="teams" className="px-2 pt-2 pb-1 text-xs text-text-3">
          Teams
        </div>
        {list.rows.map((row) => {
          const key = `team:${row.id}`
          return (
            <CommandItem
              key={row.id}
              value={key}
              data-sync-scope-choice={key}
              disabled={stale}
              onSelect={() => onPick(key)}
              className={rowClass}
            >
              <Icon name="people" size={14} />
              <span className="min-w-0 flex-1 truncate">{row.name}</span>
              {check(key)}
            </CommandItem>
          )
        })}
        <CommandChoiceEnd end={end} tooLong={search.tooLong} list={list} words={SCOPE_TEAM_WORDS} />
        <div data-sync-scope-group="projects" className="px-2 pt-2 pb-1 text-xs text-text-3">
          Projects
        </div>
        {shownProjects.map((p) => {
          const key = `project:${p.id}`
          return (
            <CommandItem
              key={p.id}
              value={key}
              data-sync-scope-choice={key}
              disabled={stale}
              onSelect={() => {
                seedNavRow(p)
                onPick(key)
              }}
              className={rowClass}
            >
              <span className="min-w-0 flex-1 truncate">{labelOf(p)}</span>
              {check(key)}
            </CommandItem>
          )
        })}
        <CommandChoiceEnd
          end={projectEnd}
          tooLong={search.tooLong}
          list={projectList}
          words={SCOPE_PROJECT_WORDS}
        />
      </CommandList>
    </Command>
  )
}
