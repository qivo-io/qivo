/* Visible project navigation, archived projects and project access settings. */
import React, { useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../../convex/lib/limits'
import { DEFAULT_REVIEW_HOURS, roundReviewHours } from '../../../convex/lib/review'
import { navRowDiv } from '../../components/navRow'
import { ProjectAccessEditor } from '../../components/ProjectAccessEditor'
import { Icon, MenuItem, Popover, ProjectName } from '../../components/qivo'
import {
  FieldHint,
  PageTitle,
  SettingsField,
  SettingsGroup,
  SettingsSection,
} from '../../components/settingsPage'
import { dayInSentence, deletedAtFull } from '../../lib/deletedTime'
import { DEMO_MODE } from '../../lib/demoMode'
import { limitSentence } from '../../lib/fieldLimits'
import { useFieldUnsaved, useUnsaved } from '../../lib/leaveGuard'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { AccessLevel, AccessRemoval, ArchivedProjectVM, ProjectVM } from '../../store/planner'
import { P } from '../../store/planner'
import { AccessRemovalModal, ArchiveOrDeleteProjectModal } from '../Modals'
import { BackLink, DemoCapabilityNotice, TextField, Toggle } from './controls'
import { InviteOutcome } from './UserControls'

// Show home projects first, then foreign organizations. Remember one expanded
// project for this browser session; access settings determine visibility.
let lastOpenProject: string | null = null
const rememberOpenProject = (id: string | null) => {
  lastOpenProject = id
}

export function OrgProjectsPage({
  setPage,
  onNewProject,
  onNewSubProject,
  onOpenArchivedTasks,
}: {
  setPage: (page: string) => void
  onNewProject: () => void
  onNewSubProject: (parent: string) => void
  onOpenArchivedTasks: (projectId: string) => void
}) {
  const visible = P.visibleProjects()
  const canCreate = P.canCreateProject()
  const [open, setOpen] = useStateS<string | null>(lastOpenProject)
  const toggle = (id: string) => {
    const next = open === id ? null : id
    rememberOpenProject(next)
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
            <ProjectName project={m} />
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
                    onOpenArchivedTasks(m.id)
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
                <ProjectName project={sp} wrap />
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
                        onOpenArchivedTasks(sp.id)
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
  // the project whose Delete window is open
  const [deleting, setDeleting] = useStateS<ArchivedProjectVM | null>(null)
  // the rows on either side of it when the window opened, for focus
  const deleteSides = React.useRef<{ next?: string; previous?: string }>({})
  const all = P.archivedProjects
  // rows = what a person can act on: every archived project, plus the
  // sub-projects whose own project is still active. The rest are chips.
  const rows = all.filter((r) => !r.parentArchived)
  const askDelete = (r: ArchivedProjectVM) => {
    const at = rows.findIndex((row) => row.id === r.id)
    deleteSides.current = { next: rows[at + 1]?.id, previous: rows[at - 1]?.id }
    setDeleting(r)
  }
  /* Where focus goes when the Delete window closes. That is the row's Delete
     while the row is there, else the next row's first button, the previous
     row's, or the page heading, so focus never falls to the page body. */
  const afterDelete = (id: string) => {
    const own = document.querySelector<HTMLElement>(`[data-delete-project="${id}"]`)
    if (own) return own
    const buttonOf = (row?: string) =>
      row === undefined
        ? null
        : document.querySelector<HTMLElement>(
            `[data-archived-project="${row}"] button:not(:disabled)`,
          )
    const { next, previous } = deleteSides.current
    return (
      buttonOf(next) ??
      buttonOf(previous) ??
      document.querySelector<HTMLElement>('.settings-page-title h1')
    )
  }
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
  // the window waits for the server, so a refusal leaves it open
  const del = async (r: ArchivedProjectVM, reason: string) => {
    if (!(await P.removeProject(r.id, reason))) return false
    setDeleting(null)
    window.showToast?.(`Deleted “${r.name}”`)
    return true
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
                      <ProjectName project={r} />
                      {r.type !== 'meta' && (
                        <span className="[margin-left:7px] [font-size:var(--fs-xs)] [font-weight:500] [color:var(--text-2)]">
                          sub-project
                          {r.parentName && r.parent
                            ? ` of ${P.projectLabel({ id: r.parent, name: r.parentName })}`
                            : ''}
                        </span>
                      )}
                    </div>
                    <HoverTooltip content={deletedAtFull(new Date(r.archivedAt))}>
                      <div
                        data-archived-when
                        className="[font-size:var(--fs-xs)] [color:var(--text-2)] !font-mono"
                      >
                        archived {dayInSentence(new Date(r.archivedAt), new Date())}
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
                      <Button
                        type="button"
                        data-delete-project={r.id}
                        className="text-danger"
                        onClick={() => askDelete(r)}
                      >
                        <Icon name="trash" size={16} />
                        Delete
                      </Button>
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
                          <ProjectName project={k} />
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
            deletes its sub-projects and tasks.
          </FieldHint>
        )}
      </SettingsSection>
      {deleting && (
        <ArchiveOrDeleteProjectModal
          key={deleting.id}
          project={deleting}
          deleteOnly
          onClose={() => setDeleting(null)}
          onDelete={(reason) => del(deleting, reason)}
          focusAfterClose={() => afterDelete(deleting.id)}
        />
      )}
    </>
  )
}

export function ProjectPage({
  projectId,
  setPage,
  onBackPage = setPage,
  onProjectGone,
  onLeaving,
}: {
  projectId: string
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
  onProjectGone?: (parent: string | null) => void
  /** told the project's id while its delete waits for the server, and null
      when the server refused it. The delivery that drops the project usually
      lands before the answer, and this page leaves on its own after it. */
  onLeaving?: (projectId: string | null) => void
}) {
  const proj = P.project(projectId)
  /* The Archive or delete window, from the section at the end of the page.
     It holds the project as it was when the window opened, so it stays up
     when a delete it sent drops the project before the server's answer. It
     is the page's last child with or without the project, so React keeps
     the same window, still deleting, until that answer closes it. */
  const [removing, setRemoving] = useStateS<ProjectVM | null>(null)
  const removeButton = React.useRef<HTMLButtonElement>(null)
  const removalWindow = (shown: ProjectVM) => {
    // Archiving lands on the Archived projects page rather than back on the
    // list, because the page that can take it back is where you should be
    // standing when the toast appears.
    const archive = () => {
      // a paused archive keeps the window open
      if (P.refusePausedEdit()) return
      setRemoving(null)
      P.archiveProject(shown.id)
      window.showToast?.(`Archived “${shown.name}”`)
      onProjectGone?.(shown.parent || null)
      setPage('projects-archived')
    }
    // the window waits for the server, so a refusal leaves it open
    const del = async (reason: string) => {
      const parent = shown.parent || null
      onLeaving?.(shown.id)
      if (!(await P.removeProject(shown.id, reason))) {
        onLeaving?.(null)
        return false
      }
      setRemoving(null)
      window.showToast?.(`Deleted “${shown.name}”`)
      onProjectGone?.(parent)
      // a sub-project falls back to its project; a project back to the list it
      // was opened from (never to some other project the caller may not see)
      if (parent && P.project(parent)) setPage(`project:${parent}`)
      else setPage('projects')
      return true
    }
    return (
      <ArchiveOrDeleteProjectModal
        project={shown}
        onClose={() => setRemoving(null)}
        onArchive={archive}
        onDelete={del}
        focusAfterClose={() => removeButton.current}
      />
    )
  }
  return (
    <>
      {proj && (
        <ProjectSettingsFields
          proj={proj}
          setPage={setPage}
          onBackPage={onBackPage}
          removeButton={removeButton}
          onRemove={() => setRemoving(proj)}
        />
      )}
      {removing && removalWindow(removing)}
    </>
  )
}

/** A project's settings sections while the project is in the store, for
    ProjectPage, which owns the Archive or delete window that `onRemove`
    opens and gives focus back to `removeButton`. */
function ProjectSettingsFields({
  proj,
  setPage,
  onBackPage,
  removeButton,
  onRemove,
}: {
  proj: ProjectVM
  setPage: (page: string) => void
  onBackPage: (page: string) => void
  removeButton: React.RefObject<HTMLButtonElement | null>
  onRemove: () => void
}) {
  const [grantRole, setGrantRole] = useStateS<AccessLevel>('user')
  /* Removing a grant that would leave someone unable to see tasks they work
     on first asks whether to keep them as Viewers or reassign their tasks. */
  const [removal, setRemoval] = useStateS<AccessRemoval | null>(null)
  const removeOrAsk = (change: AccessRemoval) => {
    if (P.startRemoval(change)) setRemoval(change)
  }
  // a read-only organization's admin removes without the window
  React.useEffect(() => P.watchWriteBlock(proj.org), [proj.org])
  const [inviteEmail, setInviteEmail] = useStateS('')
  const [inviting, setInviting] = useStateS(false)
  /* The seats this form's invitations emailed, newest last, for
     InviteOutcome. Each stays until the window closes, so a later invitation
     does not hide an earlier one's result. */
  const [emailed, setEmailed] = useStateS<{ seat: string; email: string }[]>([])
  useUpdateBlocker(!!inviteEmail || inviting)
  useUnsaved(!!inviteEmail.trim(), 'email')
  // the review time typed and not yet saved (the field saves on blur)
  const reviewUnsaved = useFieldUnsaved(
    P.editsPaused,
    `${proj.id}:${proj.reviewHours ?? ''}`,
    'review hours',
  )
  // a review time refused on blur stays typed and marked until it changes
  const [reviewRefused, setReviewRefused] = useStateS(false)
  const accessHeading = React.useRef<HTMLDivElement>(null)
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
          limit={LIMITS.projectName}
          disabled={!isLead}
          onCommit={(v) => {
            // the toast waits for the server, so a refusal never reads as done
            void P.updateProject(proj.id, { name: v }).then((saved) => {
              if (saved) window.showToast?.(`Renamed to “${v}”`)
            })
          }}
        />
        {isMeta && (
          <TextField
            label="Description"
            multiline
            limit={LIMITS.projectDescription}
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
                  void P.updateProject(proj.id, { trackDelay: v }).then((saved) => {
                    if (saved)
                      window.showToast?.(
                        v ? 'Projected delays are highlighted' : 'Tasks stay neutral',
                      )
                  })
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
              min={LIMITS.reviewHours.min}
              max={LIMITS.reviewHours.max}
              step={0.5}
              data-project-review-hours
              aria-label="Review time"
              aria-invalid={reviewRefused || undefined}
              {...reviewUnsaved}
              key={`review:${proj.id}:${proj.reviewHours ?? ''}`}
              defaultValue={proj.reviewHours ?? ''}
              placeholder={String(inheritedReview)}
              disabled={!isLead}
              onChange={() => setReviewRefused(false)}
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
                    void P.updateProject(proj.id, { reviewHours: null }).then((saved) => {
                      if (saved) window.showToast?.(`Review time set to ${inheritedReview} h`)
                    })
                  }
                  return
                }
                // the typed number against the range, as the server checks
                // it, so -0.04 is refused rather than saved as 0
                if (n < LIMITS.reviewHours.min || n > LIMITS.reviewHours.max) {
                  setReviewRefused(true)
                  window.showToast?.(limitSentence(LIMITS.reviewHours), 'error')
                  return
                }
                const h = roundReviewHours(n)
                el.value = String(h)
                if (h === own) return
                void P.updateProject(proj.id, { reviewHours: h }).then((saved) => {
                  if (saved) window.showToast?.(`Review time set to ${h} h`)
                })
              }}
              className="h-control w-15 bg-surface-1 px-2.5 text-base font-sans"
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
            className="h-control w-full bg-surface-1 text-base font-sans"
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
                <span className="[font-size:var(--fs-base)] [font-weight:500] [flex:1] [min-width:0]">
                  <ProjectName project={sp} />
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
            onTeamChange={(teamId, level) =>
              level === null
                ? removeOrAsk({ kind: 'teamGrant', projectId: proj.id, teamId })
                : P.setProjectTeamAccess(proj.id, teamId, level)
            }
            onUserChange={(userId, level) =>
              level === null
                ? removeOrAsk({ kind: 'userGrant', projectId: proj.id, userId })
                : P.setProjectAccess(proj.id, userId, level)
            }
            role={grantRole}
            onRoleChange={setGrantRole}
            canManageUsers={canManageUsers}
            canManageTeams={canManageTeams}
            canManageUser={(userId) => P.canManageProjectUser(proj.id, userId)}
          />
          {removal && (
            <AccessRemovalModal
              key={JSON.stringify(removal)}
              change={removal}
              onClose={() => setRemoval(null)}
            />
          )}
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
                  className="h-control w-full bg-surface-1 px-2.5 text-base font-sans [flex:1]"
                />
                <Button
                  type="button"
                  disabled={!canInvite || !inviteEmail.trim() || inviting}
                  onClick={async () => {
                    if (!canInvite) return
                    setInviting(true)
                    const invited = await P.inviteToProject(proj.id, inviteEmail, grantRole)
                    setInviting(false)
                    if (invited) {
                      window.showToast?.(`${inviteEmail.trim()} was added to “${proj.name}”`)
                      const seat = invited.emailed
                      if (seat)
                        setEmailed((all) => [
                          ...all.filter((e) => e.seat !== seat),
                          { seat, email: inviteEmail.trim() },
                        ])
                      setInviteEmail('')
                    }
                  }}
                >
                  <Icon name="plus" size={16} />
                  {inviting ? 'Inviting…' : 'Invite'}
                </Button>
              </div>
              {emailed.map((e) => (
                <InviteOutcome key={e.seat} orgId={proj.org} seat={e.seat} email={e.email} />
              ))}
            </SettingsGroup>
          )}
          <FieldHint>
            Organization admins retain access. Assigning a new Lead changes the previous Lead to
            User.
          </FieldHint>
        </div>
      </SettingsSection>

      {/* Archive is the answer to almost every reason someone opens this, and
          the window offers it first; the counts come with the window, because
          only the lead may read them and the store holds no archived tasks. */}
      <SettingsSection title="Archive or delete" data-project-removal={proj.id}>
        <div className="flex items-center gap-4">
          <p className="min-w-0 flex-1 text-sm leading-normal text-text-2">
            {isLead && isMeta && subCount
              ? `Archive hides it and its ${subCount} sub-project${subCount === 1 ? '' : 's'}. Delete moves them and their tasks to Deleted items.`
              : isMeta && !isLead
                ? 'Archive hides it and its sub-projects. Delete moves them and their tasks to Deleted items.'
                : 'Archive hides it. Delete moves it and its tasks to Deleted items.'}
          </p>
          <Button
            ref={removeButton}
            type="button"
            data-remove-project={proj.id}
            disabled={!isLead}
            title={isLead ? undefined : "Only the project's lead can archive or delete it"}
            onClick={onRemove}
          >
            <Icon name="archive" size={16} />
            Archive or delete…
          </Button>
        </div>
      </SettingsSection>
    </>
  )
}
