import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { NativeSelect } from '@/components/ui/native-select'
import { useUpdateBlocker } from '../lib/updateSafety'
import {
  type AccessLevel,
  P,
  type TeamAccessLevel,
  type TeamVM,
  type UserVM,
} from '../store/planner'
import { Avatar, Icon } from './qivo'
import { SettingsGroup } from './settingsPage'

/** One access list for both project creation and settings. Team membership is
 * resolved by the server; adding a team never copies its members into Users. */
export function ProjectAccessEditor({
  teams,
  users,
  teamAccess,
  access,
  onTeamChange,
  onUserChange,
  role,
  onRoleChange,
  allowLead = true,
  canManage = true,
  canManageTeams = canManage,
  canManageUsers = canManage,
  canManageUser,
}: {
  teams: TeamVM[]
  users: UserVM[]
  teamAccess: Record<string, TeamAccessLevel>
  access: Record<string, string>
  onTeamChange: (id: string, level: TeamAccessLevel | null) => void
  onUserChange: (id: string, level: AccessLevel | null) => void
  role: AccessLevel
  onRoleChange: (role: AccessLevel) => void
  allowLead?: boolean
  canManage?: boolean
  canManageTeams?: boolean
  canManageUsers?: boolean
  canManageUser?: (userId: string) => boolean
}) {
  const [target, setTarget] = useState('')
  useUpdateBlocker(!!target)
  const selectedTeam = target.startsWith('team:')
    ? teams.find((team) => `team:${team.id}` === target)
    : undefined
  const selectedUser = target.startsWith('user:')
    ? users.find((user) => `user:${user.id}` === target)
    : undefined
  const viewerOnly = selectedUser?.orgRole === 'viewer'
  const canGrantLead = allowLead && !selectedTeam && !viewerOnly
  const selectedRole = viewerOnly ? 'viewer' : !canGrantLead && role === 'lead' ? 'user' : role
  const teamIds = Object.keys(teamAccess).sort((a, b) =>
    (P.teamById(a)?.name || a).localeCompare(P.teamById(b)?.name || b),
  )
  const userIds = Object.keys(access).sort((a, b) => {
    const rank = (access[a] === 'lead' ? 0 : 1) - (access[b] === 'lead' ? 0 : 1)
    return rank || (P.user(a)?.name || a).localeCompare(P.user(b)?.name || b)
  })
  const canEditUser = (userId: string) => canManageUsers && (canManageUser?.(userId) ?? true)
  const addableTeams = canManageTeams ? teams.filter((team) => !teamAccess[team.id]) : []
  const addableUsers = users.filter(
    (user) => canEditUser(user.id) && user.active && !access[user.id],
  )
  const canPick = canManageTeams || canManageUsers
  const canAdd = selectedTeam
    ? canManageTeams && !teamAccess[selectedTeam.id]
    : !!selectedUser &&
      canEditUser(selectedUser.id) &&
      selectedUser.active &&
      !access[selectedUser.id]

  return (
    <div data-project-access>
      <SettingsGroup legend="Teams" data-project-access-teams="">
        <div className="space-y-1.5">
          {teamIds.map((teamId) => {
            const team = P.teamById(teamId)
            const name = team?.name || 'Unavailable team'
            return (
              <div
                key={teamId}
                data-project-access-team={teamId}
                className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-2"
              >
                <span className="min-w-0 flex-1 truncate text-base font-medium">{name}</span>
                <NativeSelect
                  data-project-team-role={teamId}
                  aria-label={`Project role for ${name}`}
                  disabled={!canManageTeams}
                  value={teamAccess[teamId]}
                  onChange={(event) => onTeamChange(teamId, event.target.value as TeamAccessLevel)}
                  className="h-control-sm w-28 shrink-0 bg-surface-1 px-1.5 text-sm font-sans"
                >
                  <option value="user">User</option>
                  <option value="viewer">Viewer</option>
                </NativeSelect>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-control-sm w-control-sm shrink-0"
                  aria-label={`Remove ${name} team access`}
                  title={`Remove ${name} team access`}
                  disabled={!canManageTeams}
                  onClick={() => onTeamChange(teamId, null)}
                >
                  <Icon name="close" size={16} />
                </Button>
              </div>
            )
          })}
          {teamIds.length === 0 && <p className="text-sm text-text-2">No teams added.</p>}
        </div>
      </SettingsGroup>

      <SettingsGroup legend="Users" data-project-access-users="">
        <div className="space-y-1.5">
          {userIds.map((userId) => {
            const user = P.user(userId)
            if (!user) return null
            const userRole = access[userId]
            const canEdit = canEditUser(userId)
            return (
              <div
                key={userId}
                data-project-access-user={userId}
                className="flex items-center gap-2 rounded-md border border-border bg-surface-1 p-2"
              >
                <Avatar id={userId} size={28} />
                <span className="min-w-0 flex-1 truncate text-base font-medium">
                  {user.name}
                  {user.orgRole === 'guest' && (
                    <span data-guest-chip className="ml-1.5 text-xs font-bold text-text-2">
                      guest
                    </span>
                  )}
                  {user.orgRole === 'viewer' && (
                    <span data-viewer-chip className="ml-1.5 text-xs font-bold text-text-2">
                      viewer
                    </span>
                  )}
                  {user.pending && (
                    <span data-invited-chip className="ml-1.5 text-xs font-bold text-[var(--warn)]">
                      invited
                    </span>
                  )}
                </span>
                <NativeSelect
                  data-project-role={userId}
                  aria-label={`Project role for ${user.name}`}
                  disabled={!canEdit || userRole === 'lead'}
                  value={userRole}
                  onChange={(event) => onUserChange(userId, event.target.value as AccessLevel)}
                  className="h-control-sm w-28 shrink-0 bg-surface-1 px-1.5 text-sm font-sans"
                  title={
                    user.orgRole === 'viewer'
                      ? 'Organization viewers have read-only access'
                      : userRole === 'lead'
                        ? 'Choose another lead to transfer project control'
                        : 'Direct role; team access still applies'
                  }
                >
                  {allowLead && user.orgRole !== 'viewer' && <option value="lead">Lead</option>}
                  {user.orgRole !== 'viewer' && <option value="user">User</option>}
                  <option value="viewer">Viewer</option>
                </NativeSelect>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-control-sm w-control-sm shrink-0"
                  aria-label={`Remove ${user.name} direct access`}
                  title={`Remove ${user.name} direct access`}
                  disabled={!canEdit || userRole === 'lead'}
                  onClick={() => onUserChange(userId, null)}
                >
                  <Icon name="close" size={16} />
                </Button>
              </div>
            )
          })}
          {userIds.length === 0 && (
            <p className="text-sm text-text-2">No individual users added.</p>
          )}
        </div>
      </SettingsGroup>

      {/* the creation controls stand a group's distance below the lists */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <NativeSelect
          data-project-access-picker
          aria-label={canManageTeams ? 'Add team or user' : 'Add user'}
          disabled={!canPick}
          value={target}
          onChange={(event) => {
            const next = event.target.value
            setTarget(next)
            const user = users.find((candidate) => `user:${candidate.id}` === next)
            if (user?.orgRole === 'viewer') onRoleChange('viewer')
            else if (next.startsWith('team:') && role === 'lead') onRoleChange('user')
          }}
          className="h-control min-w-[160px] flex-1 bg-surface-1 px-2.5 text-base font-sans"
        >
          <option value="">{canManageTeams ? 'Add team or user…' : 'Add user…'}</option>
          {canManageTeams && (
            <optgroup label="Teams">
              {addableTeams.map((team) => (
                <option key={team.id} value={`team:${team.id}`}>
                  {team.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Users">
            {addableUsers.map((user) => (
              <option key={user.id} value={`user:${user.id}`}>
                {user.name}
              </option>
            ))}
          </optgroup>
        </NativeSelect>
        <NativeSelect
          data-project-access-new-role
          aria-label="New project access role"
          disabled={!canPick}
          value={selectedRole}
          onChange={(event) => onRoleChange(event.target.value as AccessLevel)}
          className="h-control w-28 bg-surface-1 px-2.5 text-base font-sans"
        >
          {canGrantLead && <option value="lead">Lead</option>}
          {!viewerOnly && <option value="user">User</option>}
          <option value="viewer">Viewer</option>
        </NativeSelect>
        <Button
          type="button"
          data-add-project-user
          data-add-project-access
          disabled={!canAdd}
          onClick={() => {
            if (!canAdd) return
            if (selectedTeam) onTeamChange(selectedTeam.id, selectedRole as TeamAccessLevel)
            else if (selectedUser) onUserChange(selectedUser.id, selectedRole)
            setTarget('')
          }}
        >
          + Add
        </Button>
      </div>
      {!canManageUsers && (
        <p className="mt-2 text-sm text-text-2">Project access is read-only for your role.</p>
      )}
      {!canManageTeams && canManageUsers && (
        <p className="mt-2 text-sm text-text-2">Your role cannot change team access.</p>
      )}
      {canManageUsers && !canEditUser(P.CURRENT_USER) && (
        <p className="mt-2 text-sm text-text-2">
          An organization admin or project lead must change your own role.
        </p>
      )}
    </div>
  )
}
