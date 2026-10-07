import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { matchesAllWords } from '../lib/search'
import type { AccessLevel, TeamAccessLevel, TeamVM, UserVM } from '../store/planner'
import { Avatar, Icon } from './qivo'

/** Creation keeps its selection in the draft; opening, searching and closing
 * this picker never changes a grant. Each checkbox applies immediately. */
export function ProjectAccessSelect({
  teams,
  users,
  teamAccess,
  access,
  onTeamChange,
  onUserChange,
}: {
  teams: TeamVM[]
  users: UserVM[]
  teamAccess: Record<string, TeamAccessLevel>
  access: Record<string, AccessLevel>
  onTeamChange: (id: string, level: TeamAccessLevel | null) => void
  onUserChange: (id: string, level: AccessLevel | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const inputId = useId()
  const query = search.trim()
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)
  const matchingTeams = teams.filter((team) => matchesAllWords(team.name, query)).sort(byName)
  const matchingUsers = users.filter((user) => matchesAllWords(user.name, query)).sort(byName)
  const teamIds = Object.keys(teamAccess)
  const userIds = Object.keys(access)
  const selectionCount = teamIds.length + userIds.length
  const summary =
    selectionCount === 0
      ? 'Select teams and users…'
      : selectionCount === 1
        ? teams.find((team) => team.id === teamIds[0])?.name ||
          users.find((user) => user.id === userIds[0])?.name ||
          '1 selected'
        : [
            teamIds.length ? `${teamIds.length} team${teamIds.length === 1 ? '' : 's'}` : '',
            userIds.length ? `${userIds.length} user${userIds.length === 1 ? '' : 's'}` : '',
          ]
            .filter(Boolean)
            .join(', ')

  return (
    <Popover
      modal
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          data-new-project-access
          data-field-trigger
          aria-label={`Project users: ${summary}`}
          className="w-full justify-between bg-surface-1 px-2.5 text-base font-normal"
        >
          <span className={selectionCount ? 'min-w-0 truncate' : 'min-w-0 truncate text-text-2'}>
            {summary}
          </span>
          <Icon name="chevronDown" size={16} color="var(--text-3)" />
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
          searchRef.current?.focus()
        }}
        // Radix restores focus; the shared modality rule keeps a pointer
        // dismissal quiet without losing the trigger's place in the Tab order.
        onEscapeKeyDown={(event) => {
          // Consume the nested popup's Escape before the create dialog or
          // Settings' page-level Escape handler can receive the same key.
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
          setSearch('')
        }}
      >
        <div className="shrink-0 border-b border-border p-2">
          <Input
            ref={searchRef}
            data-project-access-search
            aria-label="Search teams and users"
            placeholder="Search teams and users…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-control w-full bg-surface-1 text-base"
          />
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-1">
          <fieldset className="min-w-0 border-0 p-0" data-project-access-teams>
            <legend className="w-full px-2 pt-2 pb-1 text-xs font-semibold text-text-2">
              Teams
            </legend>
            {matchingTeams.map((team) => {
              const selected = !!teamAccess[team.id]
              const id = `${inputId}-team-${team.id}`
              return (
                <div
                  key={team.id}
                  className="flex items-center gap-2 rounded-md px-2 hover:bg-hover"
                >
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2"
                  >
                    <Checkbox
                      id={id}
                      data-project-access-team-option={team.id}
                      aria-label={`${team.name} team`}
                      checked={selected}
                      onCheckedChange={(checked) =>
                        onTeamChange(team.id, checked === true ? 'user' : null)
                      }
                    />
                    <span className="min-w-0 truncate text-sm">{team.name}</span>
                  </label>
                  {selected && (
                    <NativeSelect
                      data-project-team-role={team.id}
                      aria-label={`Project role for ${team.name}`}
                      value={teamAccess[team.id]}
                      onChange={(event) =>
                        onTeamChange(team.id, event.target.value as TeamAccessLevel)
                      }
                      className="h-control-sm w-24 shrink-0 bg-surface-1 px-1.5 text-sm"
                    >
                      <option value="user">User</option>
                      <option value="viewer">Viewer</option>
                    </NativeSelect>
                  )}
                </div>
              )
            })}
            {!matchingTeams.length && (
              <p className="px-2 py-2 text-sm text-text-2">
                {query ? 'No matching teams.' : 'No teams available.'}
              </p>
            )}
          </fieldset>
          <fieldset
            className="mt-1 min-w-0 border-0 border-t border-solid border-t-border p-0"
            data-project-access-users
          >
            <legend className="w-full px-2 pt-2 pb-1 text-xs font-semibold text-text-2">
              Users
            </legend>
            {matchingUsers.map((user) => {
              const selected = !!access[user.id]
              const id = `${inputId}-user-${user.id}`
              const viewerOnly = user.orgRole === 'viewer'
              return (
                <div
                  key={user.id}
                  className="flex items-center gap-2 rounded-md px-2 hover:bg-hover"
                >
                  <label
                    htmlFor={id}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-2"
                  >
                    <Checkbox
                      id={id}
                      data-project-access-user-option={user.id}
                      aria-label={user.name}
                      checked={selected}
                      disabled={!user.active && !selected}
                      onCheckedChange={(checked) =>
                        onUserChange(
                          user.id,
                          checked === true ? (viewerOnly ? 'viewer' : 'user') : null,
                        )
                      }
                    />
                    <Avatar id={user.id} size={28} />
                    <span className="min-w-0 truncate text-sm">{user.name}</span>
                  </label>
                  {selected && (
                    <NativeSelect
                      data-project-role={user.id}
                      aria-label={`Project role for ${user.name}`}
                      value={access[user.id]}
                      disabled={viewerOnly}
                      title={viewerOnly ? 'Organization viewers have read-only access' : undefined}
                      onChange={(event) => onUserChange(user.id, event.target.value as AccessLevel)}
                      className="h-control-sm w-24 shrink-0 bg-surface-1 px-1.5 text-sm"
                    >
                      {!viewerOnly && <option value="user">User</option>}
                      <option value="viewer">Viewer</option>
                    </NativeSelect>
                  )}
                </div>
              )
            })}
            {!matchingUsers.length && (
              <p className="px-2 py-2 text-sm text-text-2">
                {query ? 'No matching users.' : 'No users available.'}
              </p>
            )}
          </fieldset>
        </div>
      </PopoverContent>
    </Popover>
  )
}
