/* Home-organization teams and the memberships their leaders can manage. */
import { useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { Avatar, Icon } from '../../components/qivo'
import {
  FieldHint,
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { useUpdateBlocker } from '../../lib/updateSafety'
import { P } from '../../store/planner'
import { BackLink, TextField } from './controls'
import { PlannableHoursInput } from './UserControls'

export function TeamPage({
  teamId,
  setPage,
  onBackPage = setPage,
}: {
  teamId: string
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
}) {
  // A removed team shows an empty name until the settings shell redirects.
  const teamName = P.teamById(teamId)?.name || ''
  const ws = teamId // the update calls below all take the team id
  const canManage = P.isTeamLeader(teamId) // team leader or org admin
  const [confirm, setConfirm] = useStateS<string | null>(null)
  const [addUid, setAddUid] = useStateS('')
  useUpdateBlocker(!!addUid)
  // Team membership belongs to the home organization; guests cannot join.
  const members = P.homeUsers().filter((u) => (u.teams || []).includes(teamId))
  const addable = P.homeUsers().filter((u) => !(u.teams || []).includes(teamId))
  return (
    <>
      <BackLink to="Teams" onClick={() => onBackPage('org-teams')} />
      <PageTitle>{teamName || 'Team'}</PageTitle>
      <SettingsSection
        title="Team"
        description={
          canManage ? undefined : 'Only team leaders and organization admins can edit this team.'
        }
      >
        {canManage ? (
          <TextField
            label="Team name"
            value={teamName}
            onCommit={(v) => {
              P.updateTeam(ws, { name: v })
              window.showToast?.('Team renamed')
            }}
          />
        ) : (
          <SettingsField label="Team name">
            <Input
              value={teamName}
              disabled
              className="h-control bg-surface-1 px-[11px] text-base font-sans opacity-55"
            />
          </SettingsField>
        )}
      </SettingsSection>

      <SettingsSection title="Members">
        <div className="[display:flex] [flex-direction:column] [gap:6px]">
          {members.map((u) => {
            const isLeader = (u.teamLeads || []).includes(ws)
            const arm = confirm === `m:${u.id}`
            return (
              <div
                key={u.id}
                data-settings-team-member={u.id}
                className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
              >
                <Avatar id={u.id} size={28} />
                <div className="[flex:1] [min-width:0]">
                  <span className="[font-size:var(--fs-base)] [font-weight:500]">{u.name}</span>
                  {u.orgRole === 'admin' && (
                    <span className="[font-size:var(--fs-xs)] [color:var(--text-2)]">
                      , org admin
                    </span>
                  )}
                  {u.orgRole === 'viewer' && (
                    <span
                      data-viewer-chip
                      className="[font-size:var(--fs-xs)] [color:var(--text-2)]"
                    >
                      , read-only
                    </span>
                  )}
                </div>
                {/* Leaders can edit the personal capacity they plan against. */}
                <PlannableHoursInput user={u} canEdit={canManage} />
                {/* Team leadership controls this team's roster only. Project
                  leads are assigned from each project's access settings. */}
                <HoverTooltip
                  content={
                    u.orgRole === 'viewer'
                      ? 'Organization viewers cannot lead a team.'
                      : canManage
                        ? 'Manage this team’s members and settings.'
                        : 'Only team leaders and organization admins can change leaders.'
                  }
                >
                  <label
                    htmlFor={`team-leader-${ws}-${u.id}`}
                    data-team-leader-toggle
                    style={{
                      cursor: canManage && u.orgRole !== 'viewer' ? 'pointer' : 'default',
                      opacity: canManage && u.orgRole !== 'viewer' ? 1 : 0.55,
                    }}
                    className="[display:flex] [align-items:center] [gap:6px] [font-size:var(--fs-sm)] [color:var(--text-2)] [flex-shrink:0]"
                  >
                    <Input
                      id={`team-leader-${ws}-${u.id}`}
                      type="checkbox"
                      checked={isLeader}
                      disabled={!canManage || u.orgRole === 'viewer'}
                      onChange={(e) => P.setTeamLeader(ws, u.id, e.target.checked)}
                      className="[accent-color:var(--primary)]"
                    />
                    Leader
                  </label>
                </HoverTooltip>
                {canManage && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    style={{ color: arm ? 'var(--danger)' : undefined }}
                    className="w-control-sm h-control-sm"
                    aria-label={arm ? 'Click again to confirm' : `Remove ${u.name} from this team`}
                    title={arm ? 'Click again to confirm' : `Remove ${u.name} from this team`}
                    onClick={() => {
                      if (!arm) {
                        setConfirm(`m:${u.id}`)
                        return
                      }
                      P.removeTeamMember(ws, u.id)
                      setConfirm(null)
                    }}
                  >
                    <Icon name="close" size={16} />
                  </Button>
                )}
              </div>
            )
          })}
          {members.length === 0 && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
              No members yet.
            </div>
          )}
        </div>
        {canManage && (
          <SettingsGroup legend="Add a member">
            <div className="[display:flex] [gap:8px]">
              <NativeSelect
                value={addUid}
                onChange={(e) => setAddUid(e.target.value)}
                className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1]"
              >
                <option value="">Add member…</option>
                {addable.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </NativeSelect>
              <Button
                type="button"
                disabled={!addUid}
                onClick={() => {
                  P.addTeamMember(ws, addUid)
                  setAddUid('')
                }}
              >
                <Icon name="plus" size={16} />
                Add
              </Button>
            </div>
          </SettingsGroup>
        )}
        <FieldHint>
          Removing a member leaves their other team and individual project access intact.
        </FieldHint>
      </SettingsSection>
    </>
  )
}

// Team leaders manage their teams; only organization admins create or delete teams.
export function OrgTeamsPage({ setPage }: { setPage: (page: string) => void }) {
  const admin = P.isAdmin()
  const [teamName, setTeamName] = useStateS('')
  useUpdateBlocker(!!teamName)
  const [confirm, setConfirm] = useStateS<string | null>(null)
  const homeTeams = P.teams.filter((t) => t.org === P.homeOrg)
  const mine = homeTeams.filter((t) => P.isTeamLeader(t.id))
  const addTeam = () => {
    if (!teamName.trim() || !admin) return
    P.addTeam(teamName.trim())
    window.showToast?.(`Team “${teamName.trim()}” created`)
    setTeamName('')
  }
  return (
    <>
      <PageTitle>Teams</PageTitle>
      <SettingsSection
        title="Teams"
        description={
          admin ? undefined : 'Teams you lead. Only organization admins can create or delete teams.'
        }
      >
        <div data-org-teams className="[display:flex] [flex-direction:column] [gap:6px]">
          {mine.map((t) => {
            const memberCount = P.homeUsers().filter((u) => (u.teams || []).includes(t.id)).length
            // Count home teams only; P.teams also contains foreign teams.
            const last = homeTeams.length <= 1
            const arm = confirm === `t:${t.id}`
            return (
              <div
                key={t.id}
                data-team-row={t.id}
                className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
              >
                <Button
                  type="button"
                  onClick={() => setPage(`team:${t.id}`)}
                  title={`Open ${t.name}`}
                  className="[flex:1] [text-align:left] [background:none] [border:none] [padding:0] [cursor:pointer] [font-size:var(--fs-base)] [font-weight:600] [color:var(--text-1)] [font-family:var(--sans)]"
                  variant="unstyled"
                >
                  {t.name}
                </Button>
                <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono">
                  {memberCount} member
                  {memberCount === 1 ? '' : 's'}
                </span>
                {admin && (
                  <Button
                    type="button"
                    variant="ghost"
                    size={arm ? 'sm' : 'icon-sm'}
                    disabled={last}
                    style={{ opacity: last ? 0.35 : 1, color: arm ? 'var(--danger)' : undefined }}
                    aria-label={
                      last
                        ? "The last team can't be deleted"
                        : arm
                          ? 'Click again to delete this team'
                          : 'Delete team'
                    }
                    title={
                      last
                        ? "The last team can't be deleted"
                        : arm
                          ? 'Click again to delete this team'
                          : 'Delete team'
                    }
                    onClick={() => {
                      if (last) return
                      if (!arm) {
                        setConfirm(`t:${t.id}`)
                        return
                      }
                      P.removeTeam(t.id)
                      setConfirm(null)
                      window.showToast?.(`Team “${t.name}” deleted`)
                    }}
                  >
                    <Icon name="trash" size={16} />
                    {arm && 'Delete?'}
                  </Button>
                )}
              </div>
            )
          })}
          {mine.length === 0 && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
              You lead no team yet.
            </div>
          )}
        </div>
        {admin && (
          <SettingsGroup legend="New team">
            <div className="[display:flex] [gap:8px]">
              <Input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="New team name"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTeam()
                }}
                className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1]"
              />
              <Button type="button" disabled={!teamName.trim()} onClick={addTeam}>
                <Icon name="plus" size={16} />
                Add team
              </Button>
            </div>
          </SettingsGroup>
        )}
      </SettingsSection>
    </>
  )
}
