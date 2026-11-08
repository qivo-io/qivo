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

   The projects stay the store's (P.visibleProjects), matched in the
   browser, until t3/limits-projects-part reads them from the server; the
   projects part sends every project the person sees, so that list is
   whole. A sub-project scope, as a /sync/p/<n> link opens, is offered as
   itself.

   The closed trigger names a team scope among the person's own teams from
   the store at once, and any other from teams.get while the page shows
   that scope (panels/settings/useTeamSettings.ts), "Loading…" until it
   answers, the page's sentence for a team it cannot show, and a failed
   read with Try again, never "Choose a scope" for a team it has not named
   yet. */

import { type ReactNode, useEffect, useRef, useState } from 'react'
import { Icon, Popover } from '@/components/qivo'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DropdownChevron } from '@/components/ui/select'
import { TEAM_CAPS } from '@/lib/accessCaps'
import { listEnd, usePagedList, useSettledSearch } from '@/lib/pagedList'
import { type SyncPlaceScope, syncScopeKey } from '@/lib/teamSync'
import { cn } from '@/lib/utils'
import { useViewVisibility } from '@/lib/viewVisibility'
import { useTeamSettings } from '@/panels/settings/useTeamSettings'
import { P, type ScopeTeamChoice, type ScopeTeamChoices } from '@/store/planner'
import { usePlannerVersion } from '@/store/usePlannerVersion'
import { LIMITS } from '../../../convex/lib/limits'
import { nameKey } from '../../../convex/lib/nameKey'
import { allWordsMatcher } from '../../../convex/lib/search'
import { CommandChoiceEnd } from '../../components/pickerParts'
import { type ChoiceWords, ESCAPE_CLEARS, escapeClearsFirst } from '../../components/pickerWords'

/** The data attribute that marks the menu's search box. */
const SCOPE_SEARCH = 'data-sync-scope-search'

/** The words of the scope menu's teams. */
export const SCOPE_TEAM_WORDS: ChoiceWords = {
  held: (held) =>
    held?.state === 'refused' && held.message ? held.message : "Teams can't be listed yet.",
  failed: "Couldn't load teams.",
  stopped: 'Showing the teams found so far.',
  empty: 'No teams yet.',
  none: 'No matching teams.',
}

/** What the trigger says while it cannot name the scope (scopeName). */
export const SCOPE_WORDS = {
  choose: 'Choose a scope',
  loading: 'Loading…',
  unavailable: 'Team not available',
  failed: "Couldn't load this team",
}

/** The words for scope `scope` on the closed trigger, with whether the
    team read behind them failed, from the store's own teams and projects
    and `team`, teams.get's read of a team the person is not in. */
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
  if (team.answer) return { label: team.answer.team.name, icon, failed: false }
  if (team.state === 'unavailable') return { label: SCOPE_WORDS.unavailable, icon, failed: false }
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
 * The open menu: a search box, All projects, the teams of the home
 * organization a batch at a time from the server, and its projects from
 * the store, matched in the browser. Enter acts only on the answer for the
 * typed text. The team read runs only while the list is mounted, which it
 * is while the menu is open, and not while the page is hidden.
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

  const matches = allWordsMatcher(nameKey(typed))
  const showAll = typed === '' || matches(nameKey('All projects'))
  const projects = P.visibleProjects().filter((p) => p.org === org)
  // a sub-project scope (a /sync/p/<n> link) is offered as itself
  const ownProject = scope.kind === 'project' ? P.project(scope.id) : null
  if (ownProject && !projects.some((p) => p.id === ownProject.id)) projects.push(ownProject)
  const shownProjects = projects.filter((p) => typed === '' || matches(nameKey(P.projectLabel(p))))
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
        {shownProjects.length > 0 && (
          <div data-sync-scope-group="projects" className="px-2 pt-2 pb-1 text-xs text-text-3">
            Projects
          </div>
        )}
        {shownProjects.map((p) => {
          const key = `project:${p.id}`
          return (
            <CommandItem
              key={p.id}
              value={key}
              data-sync-scope-choice={key}
              onSelect={() => onPick(key)}
              className={rowClass}
            >
              <span className="min-w-0 flex-1 truncate">{P.projectLabel(p)}</span>
              {check(key)}
            </CommandItem>
          )
        })}
      </CommandList>
    </Command>
  )
}
