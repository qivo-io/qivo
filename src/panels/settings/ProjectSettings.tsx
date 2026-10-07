/* Visible project navigation, archived projects and project access settings. */
import React, { useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { PROJECT_DESCRIPTION_MAX } from '../../../convex/lib/projectLimits'
import {
  DEFAULT_REVIEW_HOURS,
  REVIEW_HOURS_MAX,
  roundReviewHours,
} from '../../../convex/lib/review'
import { navRowDiv } from '../../components/navRow'
import { ProjectAccessEditor } from '../../components/ProjectAccessEditor'
import { Icon, MenuItem, Popover } from '../../components/qivo'
import {
  FieldHint,
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { DEMO_MODE } from '../../lib/demoMode'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { AccessLevel, ArchivedProjectVM, ProjectVM } from '../../store/planner'
import { P } from '../../store/planner'
import { BackLink, ConfirmButton, DemoCapabilityNotice, TextField, Toggle } from './controls'

// Show home projects first, then foreign organizations. Remember one expanded
// project for this browser session; access settings determine visibility.
let lastOpenProject: string | null = null

export function OrgProjectsPage({
  setPage,
  onNewProject,
  onNewSubProject,
  onOpenArchive,
}: {
  setPage: (page: string) => void
  onNewProject: () => void
  onNewSubProject: (parent: string) => void
  onOpenArchive: (projectId: string) => void
}) {
  const visible = P.visibleProjects()
  const canCreate = P.canCreateProject()
  const [open, setOpen] = useStateS<string | null>(lastOpenProject)
  const toggle = (id: string) => {
    const next = open === id ? null : id
    lastOpenProject = next
    setOpen(next)
  }
  const foreignOrgs: string[] = []
  visible.forEach((m) => {
    if (m.org !== P.homeOrg && !foreignOrgs.includes(m.org)) foreignOrgs.push(m.org)
  })
  const menuButton = (label: string) => (t: () => void) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="w-control-xs h-control-xs"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        t()
      }}
    >
      <Icon name="more" size={16} />
    </Button>
  )
  const projectRow = (m: ProjectVM) => {
    const isOpen = open === m.id
    const subs = (m.children || []).map((c) => P.project(c)).filter((sp) => !!sp && P.canSee(sp.id))
    const lead = P.levelOn(m.id) === 'lead'
    return (
      <div key={m.id} className="[margin-bottom:2px]">
        <div
          data-project-row={m.id}
          data-on={isOpen ? '' : undefined}
          className={cn(navRowDiv, 'gap-1 font-semibold')}
          onClick={() => toggle(m.id)}
        >
          <Button
            variant="unstyled"
            type="button"
            aria-expanded={isOpen}
            onClick={(e) => {
              e.stopPropagation()
              toggle(m.id)
            }}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
          >
            {m.name}
          </Button>
          <Popover width={196} align="right" button={menuButton('Project actions')}>
            {(close) => (
              <>
                {lead && (
                  <MenuItem
                    onClick={() => {
                      close()
                      onNewSubProject(m.id)
                    }}
                  >
                    <Icon name="plus" size={16} />
                    New sub-project…
                  </MenuItem>
                )}
                <MenuItem
                  onClick={() => {
                    close()
                    setPage(`project:${m.id}`)
                  }}
                >
                  <Icon name="cog" size={16} />
                  Project settings
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    close()
                    onOpenArchive(m.id)
                  }}
                >
                  <Icon name="inbox" size={14} />
                  Archived tasks
                </MenuItem>
              </>
            )}
          </Popover>
        </div>
        {isOpen &&
          subs.map((sp) => (
            <div
              key={sp.id}
              data-subproject-row={sp.id}
              onClick={() => setPage(`project:${sp.id}`)}
              className={cn(navRowDiv, 'planner-subproject relative pl-6')}
            >
              <Button
                variant="unstyled"
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setPage(`project:${sp.id}`)
                }}
                className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-left"
              >
                {sp.name}
              </Button>
              <Popover width={206} align="right" button={menuButton('Sub-project actions')}>
                {(close) => (
                  <>
                    <MenuItem
                      onClick={() => {
                        close()
                        setPage(`project:${sp.id}`)
                      }}
                    >
                      <Icon name="cog" size={16} />
                      Sub-project settings
                    </MenuItem>
                    <MenuItem
                      onClick={() => {
                        close()
                        onOpenArchive(sp.id)
                      }}
                    >
                      <Icon name="inbox" size={14} />
                      Archived tasks
                    </MenuItem>
                  </>
                )}
              </Popover>
            </div>
          ))}
        {isOpen && subs.length === 0 && lead && (
          <Button
            type="button"
            onClick={() => onNewSubProject(m.id)}
            variant="ghost"
            className="[margin:8px_0_8px_24px] h-control-sm [font-size:var(--fs-sm)] [color:var(--text-3)]"
          >
            <Icon name="plus" size={16} />
            Add sub-project
          </Button>
        )}
      </div>
    )
  }
  const section = (metas: ProjectVM[]) => (
    <div className="[max-width:480px]">{metas.map(projectRow)}</div>
  )
  return (
    <>
      <PageTitle
        action={
          canCreate ? (
            <Button type="button" data-new-settings-project onClick={onNewProject}>
              <Icon name="plus" size={16} />
              New project
            </Button>
          ) : undefined
        }
      >
        Projects
      </PageTitle>
      <SettingsSection title="Projects">
        <div data-settings-projects>
          {section(visible.filter((m) => m.org === P.homeOrg))}
          {visible.filter((m) => m.org === P.homeOrg).length === 0 && foreignOrgs.length === 0 && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
              You don’t have access to any project yet.
            </div>
          )}
          {foreignOrgs.map((oid) => {
            const o = P.orgs.find((x) => x.id === oid)
            const name = o?.name || 'Shared with you'
            return (
              <div key={oid} className="[margin-top:12px]">
                {/* the same small header the sidebar puts over a foreign
                  organization's projects */}
                <HoverTooltip content={`Shared with you by ${name}`}>
                  <div
                    data-settings-group={name}
                    className="[display:flex] [align-items:center] [gap:8px] [padding:12px_8px_4px] [font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-3)]"
                  >
                    <Icon name="people" size={12} />
                    {name}
                  </div>
                </HoverTooltip>
                {section(visible.filter((m) => m.org === oid))}
              </div>
            )
          })}
        </div>
      </SettingsSection>
    </>
  )
}

// Archived-project headers remain in the snapshot. Children archived with a
// parent restore together; independently archived children stay archived.
export function ArchivedProjectsPage() {
  const [busy, setBusy] = useStateS(() => new Set<string>())
  const all = P.archivedProjects
  // rows = what a person can act on: every archived project, plus the
  // sub-projects whose own project is still active. The rest are chips.
  const rows = all.filter((r) => !r.parentArchived)
  const restore = (r: ArchivedProjectVM) => {
    if (busy.has(r.id)) return
    setBusy((s: Set<string>) => new Set(s).add(r.id))
    void P.unarchiveProject(r.id).then((ok: boolean) => {
      setBusy((s: Set<string>) => {
        const n = new Set(s)
        n.delete(r.id)
        return n
      })
      if (ok) window.showToast?.(`Restored “${r.name}”`)
    })
  }
  const del = (r: ArchivedProjectVM) => {
    P.removeProject(r.id)
    window.showToast?.(`Deleted “${r.name}”`)
  }
  return (
    <>
      <PageTitle>Archived projects</PageTitle>
      <SettingsSection title="Archived projects">
        <div data-archived-projects className="[display:flex] [flex-direction:column] [gap:8px]">
          {rows.map((r) => {
            const kids = r.type === 'meta' ? all.filter((c) => c.parent === r.id) : []
            return (
              <div
                key={r.id}
                data-archived-project={r.id}
                className="[border:1px_solid_var(--border)] [border-radius:var(--r-md)] [background:var(--surface-1)] [padding:8px]"
              >
                <div className="[display:flex] [align-items:center] [gap:8px]">
                  <div className="[flex:1] [min-width:0]">
                    <div className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                      {r.name}
                      {r.type !== 'meta' && (
                        <span className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:500] [color:var(--text-2)]">
                          sub-project{r.parentName ? ` of ${r.parentName}` : ''}
                        </span>
                      )}
                    </div>
                    <HoverTooltip content={new Date(r.archivedAt).toLocaleString()}>
                      <div
                        data-archived-when
                        className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono"
                      >
                        archived {P.fmtAgo(r.archivedAt)}
                      </div>
                    </HoverTooltip>
                  </div>
                  {r.manage ? (
                    <>
                      <Button
                        type="button"
                        data-restore-project={r.id}
                        disabled={busy.has(r.id)}
                        title={
                          r.type === 'meta' && kids.some((k) => k.withParent)
                            ? `Restore “${r.name}” and the sub-projects archived with it`
                            : `Restore “${r.name}”`
                        }
                        onClick={() => restore(r)}
                      >
                        <Icon name="rotateCcw" size={16} />
                        {busy.has(r.id) ? 'Restoring…' : 'Restore'}
                      </Button>
                      <ConfirmButton
                        label="Delete"
                        data-delete-project={r.id}
                        confirmLabel={
                          'Click again — deletes ' +
                          (r.type === 'meta' ? 'it and its sub-projects' : 'it') +
                          ' for good'
                        }
                        title={`Delete “${r.name}” and everything in it — this cannot be undone`}
                        onConfirm={() => del(r)}
                      />
                    </>
                  ) : (
                    <span className="[font-size:var(--fs-xs)] [color:var(--text-2)] [font-style:italic]">
                      only the project's lead can restore it
                    </span>
                  )}
                </div>
                {kids.length > 0 && (
                  <div className="[display:flex] [flex-wrap:wrap] [gap:8px] [margin-top:8px]">
                    {kids.map((k) => (
                      <HoverTooltip
                        content={
                          k.withParent
                            ? `Comes back when “${r.name}” is restored`
                            : 'Archived separately. Restore the project first, then restore this sub-project.'
                        }
                        key={k.id}
                      >
                        <span
                          data-archived-sub={k.id}
                          style={{
                            color: k.withParent ? 'var(--text-1)' : 'var(--text-2)',
                            borderStyle: k.withParent ? 'solid' : 'dashed',
                          }}
                          className="inline-flex h-6 items-center [font-size:var(--fs-xs)] [padding:0_8px] [border-radius:var(--r-sm)] [border:1px_solid_var(--border)] [background:var(--surface-1)]"
                        >
                          {k.name}
                        </span>
                      </HoverTooltip>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {rows.length === 0 && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
              No archived projects.
            </div>
          )}
        </div>
        {rows.length > 0 && (
          <FieldHint>
            Sub-projects archived separately need to be restored separately. Deleting a project
            permanently deletes its sub-projects and tasks.
          </FieldHint>
        )}
      </SettingsSection>
    </>
  )
}

export function ProjectPage({
  projectId,
  setPage,
  onBackPage = setPage,
  onProjectGone,
}: {
  projectId: string
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
  onProjectGone?: (parent: string | null) => void
}) {
  const proj = P.project(projectId)
  const [grantRole, setGrantRole] = useStateS<AccessLevel>('user')
  const [inviteEmail, setInviteEmail] = useStateS('')
  const [inviting, setInviting] = useStateS(false)
  useUpdateBlocker(!!inviteEmail || inviting)
  const accessHeading = React.useRef<HTMLDivElement>(null)
  if (!proj) return null
  const isMeta = proj.type === 'meta'
  const parentMeta = proj.parent ? P.project(proj.parent) : null
  // what an empty Review time box means: the parent project's effective
  // value for a sub-project, the default for a project
  const inheritedReview = parentMeta ? P.reviewHoursFor(parentMeta.id) : DEFAULT_REVIEW_HOURS
  const visibleChildren = isMeta
    ? (proj.children || [])
        .map((id) => P.project(id))
        .filter((child) => !!child && P.canSee(child.id))
    : []
  const issueCount = (
    isMeta ? [proj.id, ...visibleChildren.map((child) => child.id)] : [proj.id]
  ).reduce((s, pid) => s + P.issues.filter((i) => i.project === pid).length, 0)
  // Organization admins already have full access; everyone else can receive
  // a direct grant independently of team membership.
  const grantable = P.usersFor(proj.id).filter((u) => u.orgRole !== 'admin' && !proj.access?.[u.id])
  const isLead = P.levelOn(proj.id) === 'lead'
  const canManageUsers = P.canManageProjectUsers(proj.id)
  const canManageTeams = P.canManageProjectTeams(proj.id)
  const inviteTarget = P.users.find(
    (user) =>
      user.org === proj.org && user.email?.toLowerCase() === inviteEmail.trim().toLowerCase(),
  )
  const canInvite =
    canManageUsers && (!inviteTarget || P.canManageProjectUser(proj.id, inviteTarget.id))
  const subCount = visibleChildren.length
  const del = () => {
    const parent = proj.parent || null
    const label = proj.name
    P.removeProject(proj.id)
    window.showToast?.(`Deleted “${label}”`)
    onProjectGone?.(parent)
    // a sub-project falls back to its project; a project back to the list it
    // was opened from (never to some other project the caller may not see)
    if (parent && P.project(parent)) setPage(`project:${parent}`)
    else setPage('projects')
  }
  /* Archiving lands on the Archived projects page rather than back on the
     list. The two are the same act from here — the project leaves — and the
     difference is that this one can be taken back, so the page that can take
     it back is where you should be standing when the toast appears. */
  const archive = () => {
    const label = proj.name
    P.archiveProject(proj.id)
    window.showToast?.(`Archived “${label}”`)
    onProjectGone?.(proj.parent || null)
    setPage('projects-archived')
  }
  return (
    <>
      {/* A sub-project goes back to the project above it, anything else to the
          listing — the same target the delete below picks, and for the same
          reason: an archived or unreadable parent leaves `parentMeta` null, so
          the fallback is the list rather than a page that would not render. */}
      <BackLink
        to={parentMeta ? parentMeta.name : 'Projects'}
        onClick={() => onBackPage(parentMeta ? `project:${parentMeta.id}` : 'projects')}
      />
      <PageTitle
        sub={isMeta ? undefined : 'Controlled by its own lead; permissions can be shared.'}
      >
        {proj.name}
        <span className="[font-size:var(--fs-sm)] [font-weight:500] [color:var(--text-2)] [margin-left:10px]">
          {isMeta ? 'Project' : 'Sub-project'}
        </span>
      </PageTitle>

      <Button
        variant="outline"
        className="settings-mobile-people-jump"
        onClick={() => {
          accessHeading.current?.scrollIntoView({ block: 'start' })
          accessHeading.current?.focus({ preventScroll: true })
        }}
      >
        <Icon name="people" size={16} />
        {canManageUsers ? 'Manage people' : 'View project access'}
        <Icon name="chevronDown" size={16} />
      </Button>

      <SettingsSection title={isMeta ? 'Project' : 'Sub-project'}>
        <TextField
          label="Name"
          value={proj.name}
          disabled={!isLead}
          onCommit={(v) => {
            P.updateProject(proj.id, { name: v })
            window.showToast?.(`Renamed to “${v}”`)
          }}
        />
        {isMeta && (
          <TextField
            label="Description"
            multiline
            maxLength={PROJECT_DESCRIPTION_MAX}
            value={proj.description || ''}
            disabled={!isLead}
            onCommit={(v) => P.updateProject(proj.id, { description: v })}
            width={520}
          />
        )}
        <SettingsField
          label="Delay tracking"
          hint={
            proj.trackDelay ? (
              <>
                Yellow: projected to miss the planned end.
                <br />
                Red: projected to miss the due date.
              </>
            ) : (
              'Turn on to highlight tasks projected to miss their planned end or due date.'
            )
          }
        >
          <div className="[display:flex] [align-items:center] [gap:8px]">
            <span data-project-delay-toggle className="[display:inline-flex]">
              <Toggle
                on={proj.trackDelay}
                disabled={!isLead}
                title={proj.trackDelay ? 'Delay tracking is on' : 'Delay tracking is off'}
                onClick={() => {
                  const v = !proj.trackDelay
                  P.updateProject(proj.id, { trackDelay: v })
                  window.showToast?.(v ? 'Projected delays are highlighted' : 'Tasks stay neutral')
                }}
              />
            </span>
            <span className="[font-size:var(--fs-base)] [color:var(--text-1)]">
              {proj.trackDelay ? 'Projected delays highlighted' : 'Tasks stay neutral'}
            </span>
          </div>
        </SettingsField>
        {/* The remaining time a task gets on entering Review (#314). Empty
            inherits: a sub-project takes its project's value, a project the
            default. 0 is a real setting, so never test the parse for truth. */}
        <SettingsField
          label="Review time"
          hint={
            isMeta
              ? 'Remaining time a task gets when it moves into Review. Sub-projects use it unless they set their own.'
              : "Remaining time a task gets when it moves into Review. Empty uses the project's time."
          }
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={REVIEW_HOURS_MAX}
              step={0.5}
              data-project-review-hours
              aria-label="Review time"
              key={`review:${proj.id}:${proj.reviewHours ?? ''}`}
              defaultValue={proj.reviewHours ?? ''}
              placeholder={String(inheritedReview)}
              disabled={!isLead}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={(e) => {
                if (!isLead) return
                const el = e.currentTarget
                const raw = el.value.trim()
                const own = proj.reviewHours ?? null
                // an unparsable entry reads as '' too, so it is caught before
                // the empty case would take it for a clear
                const n = Number(raw)
                if (el.validity.badInput || !Number.isFinite(n)) {
                  el.value = own === null ? '' : String(own)
                  return
                }
                if (!raw) {
                  if (own !== null) {
                    P.updateProject(proj.id, { reviewHours: null })
                    window.showToast?.(`Review time set to ${inheritedReview} h`)
                  }
                  return
                }
                const h = roundReviewHours(Math.min(REVIEW_HOURS_MAX, Math.max(0, n)))
                el.value = String(h)
                if (h === own) return
                P.updateProject(proj.id, { reviewHours: h })
                window.showToast?.(`Review time set to ${h} h`)
              }}
              className="h-control w-15 bg-surface-1 px-[11px] text-base font-sans"
            />
            <span className="text-base text-text-2">hours</span>
          </div>
        </SettingsField>
        <SettingsField label="Lead" hint="Controls this project's settings and access.">
          <NativeSelect
            aria-label="Lead"
            value={proj.lead || parentMeta?.lead || ''}
            disabled={!canManageUsers}
            onChange={(event) => P.setProjectAccess(proj.id, event.target.value, 'lead')}
            className="h-control w-full bg-surface-1 px-[11px] text-base font-sans"
          >
            {P.assigneesFor(proj.id).map((user) => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
      </SettingsSection>
      {isMeta && (
        <SettingsSection title="Sub-projects">
          <div className="[display:flex] [flex-direction:column] [gap:6px]">
            {visibleChildren.map((sp) => (
              <Button
                type="button"
                key={sp.id}
                onClick={() => setPage(`project:${sp.id}`)}
                title={`Open settings for ${sp.name}`}
                className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [text-align:left] [border:1px_solid_var(--border)] [background:var(--surface-1)] [color:var(--text-1)] [cursor:pointer] [transition:background-color_var(--dur-fast)_var(--ease-out),_border-color_var(--dur-fast)_var(--ease-out)] [font-family:var(--sans)]"
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'var(--hover)'
                  e.currentTarget.style.borderColor = 'var(--border-strong)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'var(--surface-1)'
                  e.currentTarget.style.borderColor = 'var(--border)'
                }}
                variant="unstyled"
              >
                <span className="[font-size:var(--fs-base)] [font-weight:500] [flex:1]">
                  {sp.name}
                </span>
                <Icon name="chevronRight" size={16} color="var(--text-2)" />
              </Button>
            ))}
            {visibleChildren.length === 0 && (
              <div className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]">
                No sub-projects yet.
              </div>
            )}
          </div>
        </SettingsSection>
      )}
      {/* where the phone's Manage people jump lands: just above the box */}
      <div ref={accessHeading} tabIndex={-1} className="settings-access-heading" />
      <SettingsSection
        title="Project access"
        description={
          isMeta
            ? undefined
            : 'Parent project permissions also apply. Changes here affect only this sub-project.'
        }
      >
        <div className="settings-project-members">
          <ProjectAccessEditor
            teams={P.teams.filter((team) => team.org === proj.org)}
            users={grantable}
            teamAccess={proj.teamAccess || {}}
            access={proj.access || {}}
            onTeamChange={(teamId, level) => P.setProjectTeamAccess(proj.id, teamId, level)}
            onUserChange={(userId, level) => P.setProjectAccess(proj.id, userId, level)}
            role={grantRole}
            onRoleChange={setGrantRole}
            canManageUsers={canManageUsers}
            canManageTeams={canManageTeams}
            canManageUser={(userId) => P.canManageProjectUser(proj.id, userId)}
          />
          {/* External invitees gain a guest seat with access to this project. */}
          {DEMO_MODE ? (
            <DemoCapabilityNotice>Inviting people is unavailable in the demo.</DemoCapabilityNotice>
          ) : (
            <SettingsGroup legend="Invite by email" className="settings-project-invite">
              <div className="[display:flex] [gap:8px]">
                <Input
                  data-invite-email
                  disabled={!canManageUsers}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="Email address"
                  aria-label="Invite by email"
                  type="email"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                  }}
                  className="h-control w-full bg-surface-1 px-[11px] text-base font-sans [flex:1]"
                />
                <Button
                  type="button"
                  disabled={!canInvite || !inviteEmail.trim() || inviting}
                  onClick={async () => {
                    if (!canInvite) return
                    setInviting(true)
                    const ok = await P.inviteToProject(proj.id, inviteEmail, grantRole)
                    setInviting(false)
                    if (ok) {
                      window.showToast?.(`${inviteEmail.trim()} was added to “${proj.name}”`)
                      setInviteEmail('')
                    }
                  }}
                >
                  <Icon name="plus" size={16} />
                  {inviting ? 'Inviting…' : 'Invite'}
                </Button>
              </div>
            </SettingsGroup>
          )}
          <FieldHint>
            Organization admins retain access. Assigning a new Lead changes the previous Lead to
            User.
          </FieldHint>
        </div>
      </SettingsSection>

      <SettingsSection title="Danger zone" tone="danger">
        {/* Archive sits above Delete on purpose: it is the answer to almost
            every reason someone opens this box, and it is the only one of the
            two you can take back. */}
        <div className="[display:flex] [align-items:center] [gap:8px] [margin-bottom:8px]">
          <div className="[flex:1] [font-size:var(--fs-sm)] [color:var(--text-2)] [line-height:1.5]">
            {isMeta
              ? subCount
                ? `Also archives ${subCount} sub-project${subCount === 1 ? '' : 's'}.`
                : 'Restore it from Archived projects.'
              : 'Restore it from Archived projects.'}
          </div>
          <ConfirmButton
            danger={false}
            icon="archive"
            data-archive-project={proj.id}
            label={`Archive ${isMeta ? 'project' : 'sub-project'}`}
            confirmLabel="Confirm archive"
            disabled={!isLead}
            title={isLead ? `Archive “${proj.name}”` : "Only the project's lead can archive it"}
            onConfirm={archive}
          />
        </div>
        <div className="[display:flex] [align-items:center] [gap:8px]">
          <div className="[flex:1] [font-size:var(--fs-sm)] [color:var(--text-2)] [line-height:1.5]">
            {isMeta
              ? 'Permanently deletes this project, its sub-projects and their tasks.'
              : 'Permanently deletes this sub-project and its tasks.'}
          </div>
          <ConfirmButton
            label={`Delete ${isMeta ? 'project' : 'sub-project'}`}
            confirmLabel={`Click again — deletes ${issueCount} task${issueCount === 1 ? '' : 's'}`}
            disabled={!isLead}
            title={isLead ? `Delete “${proj.name}”` : "Only the project's lead can delete it"}
            onConfirm={del}
          />
        </div>
      </SettingsSection>
    </>
  )
}
