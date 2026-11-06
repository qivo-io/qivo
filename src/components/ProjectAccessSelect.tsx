import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { NativeSelect } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DropdownChevron } from '@/components/ui/select'
import { LIMITS } from '../../convex/lib/limits'
import { ACCESS_CAPS } from '../lib/accessCaps'
import { restoreFocus } from '../lib/focusVisibility'
import { listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { type AccessChoices, type AccessLevel, P, type TeamAccessLevel } from '../store/planner'
import { ChoiceEnd, PickerSearch } from './pickerParts'
import { ACCESS_WORDS, escapeClearsFirst } from './pickerWords'
import { Avatar } from './qivo'

/* "2 teams, 1 user": how many of each are selected. */
const countOf = (teams: number, users: number) =>
  [
    teams ? `${teams} team${teams === 1 ? '' : 's'}` : '',
    users ? `${users} user${users === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(', ')

/** A choice of the New project dialog's Project access. */
type Choice = Extract<AccessChoices, { state: 'ready' }>['rows'][number]
type PersonChoice = Extract<Choice, { type: 'user' }>
type GrantLevel = 'user' | 'viewer'

/** Who the choices are read for: the organization of the new project and
    the lead the dialog has chosen, whom the server leaves out. */
export type AccessOn = { org_id: string; lead_id: string }

/** What the picker keeps of a checked choice, so it names it and offers
    its roles through later searches, batches and closes: a team's name, a
    person's name and the levels they may be given. */
type KeptNames = {
  teams: ReadonlyMap<string, string>
  people: ReadonlyMap<string, { name: string; levels: readonly GrantLevel[] }>
}

/* The levels the creator may be given, an organization admin's or a
   standard user's, as only they may create a project. */
const CREATOR_LEVELS: readonly GrantLevel[] = ['user', 'viewer']

/** The draft's checked teams and people, by id, in the order they were
    checked. */
const checkedOf = (
  teamAccess: Record<string, TeamAccessLevel>,
  access: Record<string, AccessLevel>,
) => ({ teams: Object.keys(teamAccess), people: Object.keys(access) })

/**
 * The New project dialog's Project access: a button naming the checked
 * teams and people that opens the server's choices
 * (projectSettings.candidates without a project, P.accessChoices), teams
 * first and then people, 25 at a time in the server's name order with its
 * search and Load more, read once a batch only while the popover is open.
 * The browser filters, sorts and counts nothing, so organization admins are
 * offered as the server offers them, and the server leaves out the chosen
 * lead. Creation keeps its selection in the draft (`teamAccess` and
 * `access`); opening, searching and closing the picker never changes it,
 * and each checkbox applies at once. A checked choice keeps its name and
 * roles here, apart for teams and people since their ids can be equal, so
 * it stays checked and named outside the loaded rows. While the search is
 * empty, Selected lists the choices checked when the popover opened or the
 * search last changed, before the server's rows. `you` (the signed-in
 * user's id) marks that user's row "(you)" and names them `youName` in the
 * closed field once they are selected: "Aisha Rahman (you)" alone, "You,
 * 1 team" beside others.
 */
export function ProjectAccessSelect({
  on,
  teamAccess,
  access,
  you,
  youName,
  onTeamChange,
  onUserChange,
}: {
  on: AccessOn
  teamAccess: Record<string, TeamAccessLevel>
  access: Record<string, AccessLevel>
  you: string
  youName: string
  onTeamChange: (id: string, level: TeamAccessLevel | null) => void
  onUserChange: (id: string, level: AccessLevel | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [names, setNames] = useState<KeptNames>({ teams: new Map(), people: new Map() })
  // the Selected group's members, taken as the popover opens and as the
  // search changes, so a check never moves the rows under the pointer
  const [members, setMembers] = useState(() => checkedOf(teamAccess, access))
  const teamIds = Object.keys(teamAccess)
  const userIds = Object.keys(access)
  const selectionCount = teamIds.length + userIds.length
  const nameOf = (kind: 'team' | 'user', id: string) =>
    kind === 'team' ? names.teams.get(id) : id === you ? youName : names.people.get(id)?.name
  const summary =
    you && access[you]
      ? selectionCount === 1
        ? `${youName} (you)`
        : `You, ${countOf(teamIds.length, userIds.length - 1)}`
      : selectionCount === 0
        ? 'Select teams and users…'
        : selectionCount === 1
          ? ((teamIds[0] ? nameOf('team', teamIds[0]) : nameOf('user', userIds[0])) ?? '1 selected')
          : countOf(teamIds.length, userIds.length)
  const changeSearch = (text: string) => {
    setSearch(text)
    setMembers(checkedOf(teamAccess, access))
  }
  const checkTeam = (id: string, name: string, on: boolean) => {
    if (on) setNames((was) => ({ ...was, teams: new Map(was.teams).set(id, name) }))
    onTeamChange(id, on ? 'user' : null)
  }
  const checkPerson = (id: string, name: string, levels: readonly GrantLevel[], on: boolean) => {
    if (on) setNames((was) => ({ ...was, people: new Map(was.people).set(id, { name, levels }) }))
    onUserChange(id, on ? (levels.includes('user') ? 'user' : 'viewer') : null)
  }

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // a close leaves the search as it was, which the list shows until
        // it has faded
        if (next) {
          setSearch('')
          setMembers(checkedOf(teamAccess, access))
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          data-new-project-access
          data-field-trigger
          aria-label={`Project users: ${summary}`}
          // the dropdown face (deviation #326): text 10px in, arrow 8px in
          className="w-full justify-between bg-surface-1 pr-2 pl-2.5 text-base font-normal has-[>svg]:pr-2"
        >
          <span className={selectionCount ? 'min-w-0 truncate' : 'min-w-0 truncate text-text-2'}>
            {summary}
          </span>
          <DropdownChevron />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-new-project-access-popup
        aria-label="Select project teams and users"
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="z-[120] flex max-h-[min(420px,var(--radix-popover-content-available-height))] w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-lg bg-surface-1 p-0 shadow-pop"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          document.querySelector<HTMLInputElement>('[data-project-access-search]')?.focus()
        }}
        // Radix restores focus; the shared modality rule keeps a pointer
        // dismissal quiet without losing the trigger's place in the Tab order.
        onEscapeKeyDown={(event) => {
          // a typed search takes the Escape first, which its box clears
          // (PickerSearch), and keeps the popup open
          escapeClearsFirst('data-project-access-search')(event)
          if (event.defaultPrevented) return
          // Consume the nested popup's Escape before the create dialog or
          // Settings' page-level Escape handler can receive the same key.
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }}
      >
        <AccessChoiceList
          on={on}
          search={search}
          onSearch={changeSearch}
          teamAccess={teamAccess}
          access={access}
          you={you}
          youName={youName}
          names={names}
          members={members}
          onTeam={checkTeam}
          onPerson={checkPerson}
          onTeamLevel={(id, level) => onTeamChange(id, level)}
          onPersonLevel={(id, level) => onUserChange(id, level)}
        />
      </PopoverContent>
    </Popover>
  )
}

/* The open Project access: the search, Selected while the search is empty,
   and the server's choices with their end line. It mounts with the
   popover's content, so a closed picker reads nothing, and keeps its rows
   while the content fades. */
function AccessChoiceList({
  on,
  search,
  onSearch,
  teamAccess,
  access,
  you,
  youName,
  names,
  members,
  onTeam,
  onPerson,
  onTeamLevel,
  onPersonLevel,
}: {
  on: AccessOn
  search: string
  onSearch: (text: string) => void
  teamAccess: Record<string, TeamAccessLevel>
  access: Record<string, AccessLevel>
  you: string
  youName: string
  names: KeptNames
  members: { teams: string[]; people: string[] }
  onTeam: (id: string, name: string, on: boolean) => void
  onPerson: (id: string, name: string, levels: readonly GrantLevel[], on: boolean) => void
  onTeamLevel: (id: string, level: TeamAccessLevel) => void
  onPersonLevel: (id: string, level: AccessLevel) => void
}) {
  const inputId = useId()
  const { typed, tooLong, settled: query } = useSettledSearch(search, LIMITS.search)
  const list = usePagedList({
    key: `${on.org_id}|${on.lead_id}|${query}`,
    source: {
      kind: 'once',
      read: (at) => P.accessChoices({ org_id: on.org_id, lead_id: on.lead_id }, query, at.after),
    },
    batch: (answer: AccessChoices) => (answer.state === 'ready' ? answer : null),
    id: (choice: Choice) => `${choice.type}:${choice.id}`,
    most: ACCESS_CAPS.choices,
  })
  const end = listEnd(list, query !== '')
  const teamRows = list.rows.filter((r) => r.type === 'team')
  const people = list.rows.filter((r): r is PersonChoice => r.type === 'user')
  const ended = end === 'end'
  const noTeams = list.rows.length > 0 && teamRows.length === 0 && (people.length > 0 || ended)
  const noPeople = list.rows.length > 0 && people.length === 0 && ended
  // Load more keeps focus while it reads; then focus moves to the first new
  // row's checkbox, else the search box
  const from = useRef<number | null>(null)
  useLayoutEffect(() => {
    if (from.current === null || list.phase === 'more') return
    const at = from.current
    from.current = null
    const active = document.activeElement
    const onMore =
      !active ||
      active === document.body ||
      !active.isConnected ||
      active.matches('[data-new-project-access-more]')
    if (!onMore) return
    const row = list.rows[at]
    const box = row
      ? document.querySelector<HTMLElement>(
          `[data-project-access-${row.type === 'team' ? 'team' : 'user'}-option="${row.id}"]`,
        )
      : null
    restoreFocus(box ?? document.querySelector<HTMLElement>('[data-project-access-search]'))
  })
  const more = () => {
    if (list.phase === 'more') return
    from.current = list.rows.length
    list.more()
  }
  const selected = typed === '' && members.teams.length + members.people.length > 0
  const teamRow = (id: string, name: string, hook: Record<string, string>, roleHook: string) => {
    const level = teamAccess[id]
    const box = `${inputId}-${hook['data-project-access-selected-option'] ? 'selected-' : ''}team-${id}`
    return (
      <div key={`team:${id}`} className="flex items-center gap-2 rounded-md px-2 hover:bg-hover">
        <label htmlFor={box} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2">
          <Checkbox
            id={box}
            {...hook}
            aria-label={`${name} team`}
            checked={!!level}
            onCheckedChange={(checked) => onTeam(id, name, checked === true)}
          />
          <span className="min-w-0 truncate text-sm">{name}</span>
        </label>
        {level && (
          <NativeSelect
            {...{ [roleHook]: id }}
            aria-label={`Project role for ${name}`}
            value={level}
            onChange={(event) => onTeamLevel(id, event.target.value as TeamAccessLevel)}
            className="h-control-sm w-24 shrink-0 bg-surface-1 text-sm"
          >
            <option value="user">User</option>
            <option value="viewer">Viewer</option>
          </NativeSelect>
        )}
      </div>
    )
  }
  const personRow = (
    person: { id: string; name: string; levels: readonly GrantLevel[]; mark?: string },
    hook: Record<string, string>,
    roleHook: string,
  ) => {
    const { id, name, levels } = person
    const level = access[id]
    const viewerOnly = !levels.includes('user')
    const box = `${inputId}-${hook['data-project-access-selected-option'] ? 'selected-' : ''}user-${id}`
    return (
      <div key={`user:${id}`} className="flex items-center gap-2 rounded-md px-2 hover:bg-hover">
        <label htmlFor={box} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2">
          <Checkbox
            id={box}
            {...hook}
            aria-label={id === you ? `${name} (you)` : name}
            checked={!!level}
            onCheckedChange={(checked) => onPerson(id, name, levels, checked === true)}
          />
          <Avatar id={id} size={28} />
          <span className="min-w-0 truncate text-sm">
            {name}
            {id === you && <span className="text-text-2"> (you)</span>}
          </span>
          {person.mark && <span className="ml-auto text-xs text-text-2">{person.mark}</span>}
        </label>
        {level && (
          <NativeSelect
            {...{ [roleHook]: id }}
            aria-label={`Project role for ${name}`}
            value={level}
            disabled={viewerOnly}
            title={viewerOnly ? 'Organization viewers have read-only access' : undefined}
            onChange={(event) => onPersonLevel(id, event.target.value as AccessLevel)}
            className="h-control-sm w-24 shrink-0 bg-surface-1 text-sm"
          >
            {!viewerOnly && <option value="user">User</option>}
            <option value="viewer">Viewer</option>
          </NativeSelect>
        )}
      </div>
    )
  }
  const legend = (text: string) => (
    <legend className="w-full px-2 pt-2 pb-1 text-xs font-semibold text-text-2">{text}</legend>
  )
  const markOf = (row: PersonChoice) =>
    row.kind === 'agent' ? 'agent' : row.org_role === 'viewer' ? 'viewer' : undefined
  return (
    <>
      <div className="shrink-0 border-b border-border p-2">
        <PickerSearch
          text={search}
          onText={onSearch}
          label="Search teams and users"
          placeholder="Search teams and users…"
          probe="data-project-access-search"
        />
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain p-1">
        {selected && (
          <fieldset
            className="mb-1 min-w-0 border-0 border-b border-solid border-b-border p-0 pb-1"
            data-project-access-selected
          >
            {legend('Selected')}
            {members.teams.map((id) =>
              teamRow(
                id,
                names.teams.get(id) ?? 'Team',
                { 'data-project-access-selected-option': `team:${id}` },
                'data-project-access-selected-role',
              ),
            )}
            {members.people.map((id) =>
              personRow(
                {
                  id,
                  name: (id === you ? youName : names.people.get(id)?.name) ?? 'Someone',
                  levels:
                    id === you ? CREATOR_LEVELS : (names.people.get(id)?.levels ?? ['viewer']),
                },
                { 'data-project-access-selected-option': `user:${id}` },
                'data-project-access-selected-role',
              ),
            )}
          </fieldset>
        )}
        {(teamRows.length > 0 || noTeams) && (
          <fieldset className="min-w-0 border-0 p-0" data-project-access-teams>
            {legend('Teams')}
            {teamRows.map((row) =>
              teamRow(
                row.id,
                row.name,
                { 'data-project-access-team-option': row.id },
                'data-project-team-role',
              ),
            )}
            {noTeams && (
              <p data-picker-group-none="team" className="px-2 py-2 text-sm text-text-2">
                {query ? 'No teams match.' : 'No teams to add.'}
              </p>
            )}
          </fieldset>
        )}
        {(people.length > 0 || noPeople) && (
          <fieldset
            className="mt-1 min-w-0 border-0 border-t border-solid border-t-border p-0"
            data-project-access-users
          >
            {legend('Users')}
            {people.map((row) =>
              personRow(
                { id: row.id, name: row.name, levels: row.levels, mark: markOf(row) },
                { 'data-project-access-user-option': row.id },
                'data-project-role',
              ),
            )}
            {noPeople && (
              <p data-picker-group-none="user" className="px-2 py-2 text-sm text-text-2">
                {query ? 'No one matches.' : 'No one to add.'}
              </p>
            )}
          </fieldset>
        )}
        <ChoiceEnd
          end={end}
          tooLong={tooLong}
          list={list}
          words={ACCESS_WORDS}
          menu={false}
          moreHook="data-new-project-access-more"
          onMore={more}
        />
      </div>
    </>
  )
}
