/* Visible project navigation, archived projects and a project's settings.
   A project's Settings page reads the project, its parent, its lead and
   every right from the server (projectSettings.get, useProjectSettings),
   its access lists and pickers too (components/ProjectAccessEditor.tsx),
   and sends every write with what it showed, so it works the same for a
   project the workspace does not hold. It reads the workspace only for the
   Sub-projects section, the names the removal window and the Archive or
   delete window give, and the avatars. */
import React, { useState as useStateS } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { LIMITS } from '../../../convex/lib/limits'
import { roundReviewHours } from '../../../convex/lib/review'
import { navRowDiv } from '../../components/navRow'
import { LeadPicker, ProjectAccessEditor } from '../../components/ProjectAccessEditor'
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
import { limitSentence, sentence } from '../../lib/fieldLimits'
import {
  focusAround,
  menuTrigger,
  useFocusAfterRender,
  useFocusWhenGone,
} from '../../lib/focusWhenGone'
import { useUnsaved } from '../../lib/leaveGuard'
import { REVIEW_HOURS, useSavedDraft } from '../../lib/savedDraft'
import { useUpdateBlocker } from '../../lib/updateSafety'
import type { AccessLevel, ArchivedProjectVM, ProjectVM } from '../../store/planner'
import { grantRemoval, P } from '../../store/planner'
import { ArchiveOrDeleteProjectModal } from '../Modals'
import { useAccessRemoval } from '../useAccessRemoval'
import { BackLink, DemoCapabilityNotice, DraftConflictLine, TextField, Toggle } from './controls'
import { InviteOutcome } from './UserControls'
import { type ProjectSettingsRead, type SettingsOk, useProjectSettings } from './useProjectSettings'

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
  /** opens New sub-project; `focusAfterClose` is what takes focus as it closes */
  onNewSubProject: (parent: string, focusAfterClose?: () => HTMLElement | null) => void
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
                    onClick={(e) => {
                      const trigger = menuTrigger(e.currentTarget)
                      close()
                      onNewSubProject(m.id, () => trigger)
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
  /* The project whose Restore was pressed last, with where focus goes once
     its row has left: the next row's first button, the previous row's, or
     the page heading. The row leaves with the delivery that restores it,
     and its Restore, disabled while it waits, has left focus nowhere. */
  const [restored, setRestored] = useStateS<{ id: string; focus: () => HTMLElement | null }>()
  useFocusWhenGone(
    !!restored && rows.some((row) => row.id === restored.id),
    () => restored?.focus() ?? null,
  )
  // a restore whose row has left is done, so a later change that lists the
  // project and takes it away again moves nothing
  React.useLayoutEffect(() => {
    if (restored && !rows.some((row) => row.id === restored.id)) setRestored(undefined)
  })
  const focusAfterRender = useFocusAfterRender()
  const restore = (r: ArchivedProjectVM) => {
    if (busy.has(r.id)) return
    setRestored({
      id: r.id,
      focus: focusAround(
        'data-archived-project',
        r.id,
        (row) => row.querySelector<HTMLElement>('button:not(:disabled)'),
        () => document.querySelector<HTMLElement>('.settings-page-title h1'),
      ),
    })
    setBusy((s: Set<string>) => new Set(s).add(r.id))
    void P.unarchiveProject(r.id).then((ok: boolean) => {
      setBusy((s: Set<string>) => {
        const n = new Set(s)
        n.delete(r.id)
        return n
      })
      if (ok) {
        window.showToast?.(`Restored “${r.name}”`)
        return
      }
      // the row stays, so a later change that takes it away moves nothing,
      // and its Restore takes back the focus it lost while disabled
      setRestored((shown) => (shown?.id === r.id ? undefined : shown))
      focusAfterRender(() =>
        document.querySelector<HTMLElement>(`[data-restore-project="${r.id}"]`),
      )
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

/** What the Archive or delete window holds of the project it opened with,
    from the page's answer. */
type RemovalShown = {
  id: string
  name: string
  type: SettingsOk['project']['type']
  orgId: string
  parent: string | null
}

export function ProjectPage({
  projectId,
  read: given,
  setPage,
  onBackPage = setPage,
  onProjectGone,
  onHolding,
}: {
  projectId: string
  /** the read of the project's settings that Settings holds for this page
      (useProjectSettings), so Try again subscribes afresh; a page rendered
      on its own reads its own */
  read?: ProjectSettingsRead
  setPage: (page: string) => void
  onBackPage?: (page: string) => void
  onProjectGone?: (parent: string | null) => void
  /** told the project's id while its Archive or delete window is open, and
      null once the person closes it. The page stays while the window is
      open, also once the project left the board, so the window keeps what
      was typed in it. The delivery that drops the project usually lands
      before its own delete's answer. After its own archive or delete the
      window closes and the page moves on, and the hold stays until the page
      changes (Settings.tsx), because a move waits while the window's typed
      text lets go (lib/discardQuestion.ts closeOrAsk). */
  onHolding?: (projectId: string | null) => void
}) {
  /* The page reads its project, its parent, its lead and every right from
     the server, and shows nothing of the project until that answer comes
     (useProjectSettings). It keeps one watch of that read: a second one
     beside Settings' would join the subscription Settings holds, so its
     Try again would read back the failure Convex stored and never ask the
     server again. */
  const own = useProjectSettings(given ? null : projectId)
  const read = given ?? own
  /* The Archive or delete window, from the section at the end of the page.
     It holds the project as it was when the window opened, so it stays up
     when the project leaves, whether by a delete it sent before the
     server's answer, a refused one or someone else's change. It is the
     page's last child with or without the project, so React keeps the same
     window, still deleting, until that answer closes it. */
  const [removing, setRemovingState] = useStateS<RemovalShown | null>(null)
  const setRemoving = (shown: RemovalShown | null) => {
    setRemovingState(shown)
    onHolding?.(shown ? shown.id : null)
  }
  const removeButton = React.useRef<HTMLButtonElement>(null)
  const gone = read.state === 'unavailable' || read.state === 'archived'
  const removalWindow = (shown: RemovalShown) => {
    const showing = { orgId: shown.orgId }
    // Archiving lands on the Archived projects page rather than back on the
    // list, because the page that can take it back is where you should be
    // standing when the toast appears.
    const archive = () => {
      // a paused archive keeps the window open
      if (P.refusePausedEdit()) return
      // the hold stays until the page moves (onHolding)
      setRemovingState(null)
      P.archiveProject(shown.id, showing)
      window.showToast?.(`Archived “${shown.name}”`)
      onProjectGone?.(shown.parent)
      setPage('projects-archived')
    }
    // the window waits for the server, so a refusal leaves it open
    const del = async (reason: string) => {
      const parent = shown.parent
      if (!(await P.removeProject(shown.id, reason, showing))) return false
      setRemovingState(null)
      window.showToast?.(`Deleted “${shown.name}”`)
      onProjectGone?.(parent)
      // a sub-project falls back to its project while the workspace holds
      // it; a project back to the list it was opened from (never to some
      // other project the caller may not see)
      if (parent && P.project(parent)) setPage(`project:${parent}`)
      else setPage('projects')
      return true
    }
    return (
      <ArchiveOrDeleteProjectModal
        project={shown}
        gone={gone}
        onClose={() => setRemoving(null)}
        onArchive={archive}
        onDelete={del}
        focusAfterClose={() => removeButton.current}
      />
    )
  }
  const answer = read.answer
  return (
    <div
      data-project-settings-state={read.state}
      aria-busy={read.state === 'loading' || read.state === 'refreshing' || undefined}
      className="contents"
    >
      <ProjectPageTitle answer={answer} onBackPage={onBackPage} />
      {answer ? (
        <ProjectSettingsFields
          answer={answer}
          read={read}
          setPage={setPage}
          removeButton={removeButton}
          onRemove={() =>
            setRemoving({
              id: answer.project.id,
              name: answer.project.name,
              type: answer.project.type,
              orgId: answer.project.org_id,
              parent: answer.parent?.id ?? null,
            })
          }
        />
      ) : (
        <SettingsFrame read={read} />
      )}
      {removing && removalWindow(removing)}
    </div>
  )
}

/* A project page's Back link and title. Until the first answer they read
   Projects and "Project settings"; then the title names the project, and
   a sub-project's Back goes to the project above it, where the delete
   also goes while the workspace holds that project. The heading stays one
   element through both, so the focus Settings gives it as it opens the
   page by keyboard stays once the fields come. */
function ProjectPageTitle({
  answer,
  onBackPage,
}: {
  answer: SettingsOk | null
  onBackPage: (page: string) => void
}) {
  const parent = answer?.parent ?? null
  const isMeta = answer?.project.type === 'meta'
  return (
    <>
      <BackLink
        to={parent ? parent.name : 'Projects'}
        onClick={() => onBackPage(parent ? `project:${parent.id}` : 'projects')}
      />
      <PageTitle
        sub={
          answer && !isMeta ? 'Controlled by its own lead; permissions can be shared.' : undefined
        }
      >
        {answer ? (
          <>
            {answer.project.name}
            <span className="[font-size:var(--fs-sm)] [font-weight:500] [color:var(--text-2)] [margin-left:10px]">
              {isMeta ? 'Project' : 'Sub-project'}
            </span>
          </>
        ) : (
          'Project settings'
        )}
      </PageTitle>
    </>
  )
}

/* A project page before its first answer, after a failure without one, or
   for a project the server no longer shows: one line under the title, and
   no field, right or list. */
function SettingsFrame({ read }: { read: ProjectSettingsRead }) {
  if (read.state === 'failed')
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-base text-text-2">
        Couldn't load project settings.
        <Button type="button" size="sm" onClick={read.retry}>
          Try again
        </Button>
      </div>
    )
  return (
    <p role="status" className="text-base text-text-2">
      {read.state === 'loading' || read.state === 'refreshing'
        ? 'Loading project settings…'
        : 'This project is no longer available.'}
    </p>
  )
}

/** Where focus goes once the access of team or user `id` may have left the
    access editor: that row's Remove while it is listed, as after Change to
    Viewer, else the next row's in its list, the previous row's, the list's
    empty line or the Add picker. Call it as the removal starts. */
function focusAfterAccessRemoval(kind: 'team' | 'user', id: string) {
  return focusAround(
    `data-project-access-${kind}`,
    id,
    (row) => row.querySelector<HTMLElement>('[data-project-access-remove]:not(:disabled)'),
    () =>
      document.querySelector<HTMLElement>(`[data-project-access-none="${kind}"]`) ??
      document.querySelector<HTMLElement>('[data-project-access-picker]'),
  )
}

/** A project's settings sections from the server's answer, for
    ProjectPage, which owns the Archive or delete window that `onRemove`
    opens and gives focus back to `removeButton`. Every right comes from the
    answer. While the answer is not current after a failure, or the project
    has gone, every control of the page that writes is off, and a typed text
    stays. A removal window or the Archive or delete window that is already
    open acts on its own server preview, and the server checks each of its
    writes again. */
function ProjectSettingsFields({
  answer,
  read,
  setPage,
  removeButton,
  onRemove,
}: {
  answer: SettingsOk
  read: ProjectSettingsRead
  setPage: (page: string) => void
  removeButton: React.RefObject<HTMLButtonElement | null>
  onRemove: () => void
}) {
  const { project } = answer
  const shown = { orgId: project.org_id }
  // after a failure, Try again's wait included, or for a project that
  // left, no control of the page writes until an answer is current again
  const gone = read.state === 'unavailable' || read.state === 'archived'
  const blocked = read.afterFailure || gone
  const [grantRole, setGrantRole] = useStateS<AccessLevel>('user')
  /* Removing a grant asks the server which open tasks it would take out of
     someone's sight, and when some, whether to keep them as Viewers or
     reassign their tasks (useAccessRemoval). Focus then goes to the target
     taken as the press starts (focusAfterAccessRemoval). */
  const removal = useAccessRemoval()
  // the choice controls' values on their way to the server: they keep no
  // draft (row 373), and show what was chosen until the write is answered
  const [delayChosen, setDelayChosen] = useStateS<boolean | null>(null)
  const [leadChosen, setLeadChosen] = useStateS<{ id: string; name: string } | null>(null)
  const accessHeading = React.useRef<HTMLDivElement>(null)
  const isMeta = project.type === 'meta'
  // the workspace's copy, read only for the Sub-projects section until
  // t3/limits-project-admin-ui reads it from the server
  const held = P.project(project.id)
  const visibleChildren =
    held && isMeta
      ? (held.children || [])
          .map((id) => P.project(id))
          .filter((child) => !!child && P.canSee(child.id))
      : []
  const subCount = visibleChildren.length
  const trackDelay = delayChosen ?? project.track_delay
  const lead = leadChosen ?? (answer.lead ? { id: answer.lead.id, name: answer.lead.name } : null)
  const grant = (kind: 'team' | 'user', id: string) =>
    grantRemoval(kind, project.id, id, project.org_id, isMeta)
  return (
    <>
      {read.afterFailure && !gone && (
        <div
          role="alert"
          data-project-settings-failed=""
          className="mb-6 flex flex-wrap items-center gap-3 text-base text-danger"
        >
          Couldn't load project settings. Changes are off until they load.
          <Button type="button" size="sm" onClick={read.retry}>
            Try again
          </Button>
        </div>
      )}

      <Button
        variant="outline"
        className="settings-mobile-people-jump"
        onClick={() => {
          accessHeading.current?.scrollIntoView({ block: 'start' })
          accessHeading.current?.focus({ preventScroll: true })
        }}
      >
        <Icon name="people" size={16} />
        {answer.can_manage_users ? 'Manage people' : 'View project access'}
        <Icon name="chevronDown" size={16} />
      </Button>

      <SettingsSection title={isMeta ? 'Project' : 'Sub-project'}>
        <TextField
          label="Name"
          record={project.id}
          value={project.name}
          limit={LIMITS.projectName}
          disabled={!answer.can_edit}
          readOnly={blocked}
          onCommit={(v, save) => {
            // the toast waits for the server, so a refusal never reads as done
            void P.updateProject(project.id, { name: v }, save.as('name'), shown).then((saved) => {
              if (saved) window.showToast?.(`Renamed to “${v}”`)
            })
          }}
        />
        {isMeta && (
          <TextField
            label="Description"
            record={project.id}
            multiline
            limit={LIMITS.projectDescription}
            value={project.description}
            disabled={!answer.can_edit}
            readOnly={blocked}
            onCommit={(v, save) =>
              P.updateProject(project.id, { description: v }, save.as('description'), shown)
            }
            width={520}
          />
        )}
        <SettingsField
          label="Delay tracking"
          hint={
            trackDelay ? (
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
            <span
              data-project-delay-toggle
              aria-busy={delayChosen !== null || undefined}
              className="[display:inline-flex]"
            >
              <Toggle
                on={trackDelay}
                disabled={!answer.can_edit || blocked || delayChosen !== null}
                title={trackDelay ? 'Delay tracking is on' : 'Delay tracking is off'}
                onClick={() => {
                  const v = !project.track_delay
                  setDelayChosen(v)
                  void P.updateProject(
                    project.id,
                    { trackDelay: v },
                    { seen: { track_delay: project.track_delay } },
                    shown,
                  ).then((saved) => {
                    setDelayChosen(null)
                    if (saved)
                      window.showToast?.(
                        v ? 'Projected delays are highlighted' : 'Tasks stay neutral',
                      )
                  })
                }}
              />
            </span>
            <span className="[font-size:var(--fs-base)] [color:var(--text-1)]">
              {trackDelay ? 'Projected delays highlighted' : 'Tasks stay neutral'}
            </span>
          </div>
        </SettingsField>
        <ReviewTimeField
          answer={answer}
          disabled={!answer.can_edit}
          readOnly={blocked}
          hint={
            isMeta
              ? 'Remaining time a task gets when it moves into Review. Sub-projects use it unless they set their own.'
              : "Remaining time a task gets when it moves into Review. Empty uses the project's time."
          }
        />
        <SettingsField label="Lead" hint="Controls this project's settings and access.">
          <LeadPicker
            on={{ org_id: project.org_id, project_id: project.id }}
            lead={
              lead && answer.lead?.inherited && !leadChosen
                ? { ...lead, name: `${lead.name} (from the project)` }
                : lead
            }
            disabled={!answer.can_change_lead || blocked}
            busy={leadChosen !== null}
            onPick={(person) => {
              // a pick of the lead shown changes nothing, a legacy
              // sub-project's inherited lead included, which a write would
              // pin to the sub-project, dropping that person's grant on it
              if (person.id === project.lead_id || person.id === answer.lead?.id) return
              setLeadChosen(person)
              void P.updateProject(
                project.id,
                { lead: person.id },
                { seen: { lead_id: project.lead_id } },
                shown,
              ).then(() => setLeadChosen(null))
            }}
          />
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
              <div
                data-project-subprojects-none=""
                className="[font-size:var(--fs-sm)] [color:var(--text-2)] [font-style:italic]"
              >
                {held ? 'No sub-projects yet.' : "Sub-projects can't be listed here yet."}
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
            project={{ id: project.id, org_id: project.org_id }}
            canManageUsers={answer.can_manage_users}
            canManageTeams={answer.can_manage_teams}
            canChangeLead={answer.can_change_lead}
            current={!blocked}
            role={grantRole}
            onRoleChange={setGrantRole}
            onLevel={(kind, id, level, was) =>
              kind === 'team'
                ? P.setProjectTeamAccess(project.id, id, level === 'viewer' ? 'viewer' : 'user', {
                    ...shown,
                    level: was,
                  })
                : P.setProjectAccess(project.id, id, level, {
                    ...shown,
                    level: was,
                    leadId: project.lead_id,
                  })
            }
            onRemove={(kind, id) =>
              removal.press(grant(kind, id), focusAfterAccessRemoval(kind, id))
            }
            checking={(kind, id) => removal.checking(grant(kind, id))}
            removing={(kind, id) => P.removingAccess(grant(kind, id))}
          />
          {removal.window}
          {/* External invitees gain a guest seat with access to this project. */}
          {DEMO_MODE ? (
            <DemoCapabilityNotice>Inviting people is unavailable in the demo.</DemoCapabilityNotice>
          ) : (
            <InviteForm answer={answer} blocked={blocked} />
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
      <SettingsSection title="Archive or delete" data-project-removal={project.id}>
        <div className="flex items-center gap-4">
          <p className="min-w-0 flex-1 text-sm leading-normal text-text-2">
            {answer.can_archive && isMeta && held && subCount
              ? `Archive hides it and its ${subCount} sub-project${subCount === 1 ? '' : 's'}. Delete moves them and their tasks to Deleted items.`
              : isMeta && (!answer.can_archive || !held)
                ? 'Archive hides it and its sub-projects. Delete moves them and their tasks to Deleted items.'
                : 'Archive hides it. Delete moves it and its tasks to Deleted items.'}
          </p>
          <Button
            ref={removeButton}
            type="button"
            data-remove-project={project.id}
            disabled={!answer.can_archive || blocked}
            title={
              answer.can_archive ? undefined : "Only the project's lead can archive or delete it"
            }
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

/* The remaining time a task gets on entering Review (#314), as a draft
   against the saved value it began from (lib/savedDraft.ts REVIEW_HOURS),
   saved on blur and Enter. Empty inherits: a sub-project takes its
   project's value, a project the default, which the placeholder shows.
   0 is a real setting, so the parse is never tested for truth. On blur:
   an unparsable entry, and an empty field over an empty saved value, show
   the saved value; a number outside LIMITS.reviewHours stays typed and
   marked with the limit's sentence; a number that rounds to the saved
   value shows it; a value changed elsewhere waits for Use saved or Keep
   mine, and a paused save keeps the text; else it saves, null for an
   empty field, the rounded number otherwise. */
function ReviewTimeField({
  answer,
  disabled,
  readOnly,
  hint,
}: {
  answer: SettingsOk
  disabled: boolean
  readOnly: boolean
  hint: string
}) {
  const { project } = answer
  const draft = useSavedDraft(
    `${project.id}:review_hours`,
    project.review_hours,
    REVIEW_HOURS,
    'review time',
    disabled,
  )
  // a number refused on blur stays typed and marked until the field changes
  const [refused, setRefused] = useStateS(false)
  const inherited = answer.inherited_review_hours
  const save = (hours: number | null, toast: number) => {
    void P.updateProject(project.id, { reviewHours: hours }, draft.save(hours).as('review_hours'), {
      orgId: project.org_id,
    }).then((saved) => {
      if (saved) window.showToast?.(`Review time set to ${toast} h`)
    })
  }
  const commit = (el: HTMLInputElement) => {
    if (disabled || readOnly) return
    const raw = draft.text.trim()
    // an unparsable entry reads as '' too, so it is caught before the
    // empty case would take it for a clear
    const n = Number(raw)
    if (el.validity.badInput || !Number.isFinite(n)) return draft.showSaved()
    if (!raw) {
      if (project.review_hours === null) return draft.showSaved()
      if (draft.conflict || P.refusePausedEdit()) return
      return save(null, inherited)
    }
    // the typed number against the range, as the server checks it, so
    // -0.04 is refused rather than saved as 0
    if (n < LIMITS.reviewHours.min || n > LIMITS.reviewHours.max) {
      setRefused(true)
      window.showToast?.(limitSentence(LIMITS.reviewHours), 'error')
      return
    }
    const h = roundReviewHours(n)
    if (draft.isSaved(String(h))) return draft.showSaved()
    if (draft.conflict || P.refusePausedEdit()) return
    draft.edit(String(h))
    save(h, h)
  }
  return (
    <SettingsField label="Review time" hint={hint}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={LIMITS.reviewHours.min}
          max={LIMITS.reviewHours.max}
          step={0.5}
          data-project-review-hours
          aria-label="Review time"
          aria-invalid={(refused && draft.unsaved) || undefined}
          aria-describedby={draft.conflict ? draft.conflictId : undefined}
          value={draft.text}
          placeholder={String(inherited)}
          disabled={disabled}
          readOnly={readOnly || undefined}
          onChange={(e) => {
            setRefused(false)
            draft.edit(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          onBlur={(e) => commit(e.currentTarget)}
          className="h-control w-15 bg-surface-1 px-2.5 text-base font-sans"
        />
        <span className="text-base text-text-2">hours</span>
      </div>
      <DraftConflictLine draft={draft} text={REVIEW_HOURS.text} />
    </SettingsField>
  )
}

/* Invite by email. The press asks the server which seat the address names
   and the level that seat holds on the project (P.projectInviteTarget),
   then sends the invitation with that level as its `expected`, so a seat or
   grant made in between refuses it. Inviting… covers both calls, and the
   field, the level and the button stay off until both answer. The form's
   own level is User or Viewer; once the lookup finds an organization
   viewer for the address, only Viewer for that address, which it says
   rather than change the level unseen. The chosen level stays as it was,
   so another address, or the next invitation, goes out with it again. A
   lookup that fails or refuses sends nothing and says why. */
function InviteForm({ answer, blocked }: { answer: SettingsOk; blocked: boolean }) {
  const { project } = answer
  const [email, setEmail] = useStateS('')
  const [level, setLevel] = useStateS<'user' | 'viewer'>('user')
  // the address the lookup found an organization viewer for
  const [viewerAddress, setViewerAddress] = useStateS<string | null>(null)
  const [inviting, setInviting] = useStateS(false)
  const [note, setNote] = useStateS<string | null>(null)
  /* The seats this form's invitations emailed, newest last, for
     InviteOutcome. Each stays until the page closes, so a later invitation
     does not hide an earlier one's result. */
  const [emailed, setEmailed] = useStateS<{ seat: string; email: string }[]>([])
  useUpdateBlocker(!!email || inviting)
  useUnsaved(!!email.trim(), 'email')
  const typed = email.trim()
  const viewerOnly = viewerAddress !== null && viewerAddress === typed.toLowerCase()
  const sending = viewerOnly ? 'viewer' : level
  const canInvite = answer.can_invite && !blocked
  const invite = async () => {
    if (!canInvite || !typed || inviting) return
    // the lookup would wait for the connection a pause lost
    if (P.refusePausedEdit()) return
    setInviting(true)
    setNote(null)
    const found = await P.projectInviteTarget(project.org_id, project.id, typed)
    if (found === null || found.state !== 'ready') {
      setInviting(false)
      setNote(
        found === null
          ? "Couldn't check this address. Nothing was sent."
          : found.state === 'refused'
            ? sentence(found.message)
            : 'This project is no longer available.',
      )
      return
    }
    if (found.person?.org_role === 'viewer' && sending !== 'viewer') {
      setInviting(false)
      setViewerAddress(typed.toLowerCase())
      setNote(
        `${found.person.name} is an organization viewer, so they can only be given Viewer. Invite again to give them Viewer.`,
      )
      return
    }
    const invited = await P.inviteToProject(project.id, typed, sending, {
      orgId: project.org_id,
      level: found.level,
    })
    setInviting(false)
    if (!invited) return
    window.showToast?.(`${typed} was added to “${project.name}”`)
    const seat = invited.emailed
    if (seat) setEmailed((all) => [...all.filter((e) => e.seat !== seat), { seat, email: typed }])
    setEmail('')
  }
  return (
    <SettingsGroup legend="Invite by email" className="settings-project-invite">
      <div className="[display:flex] [gap:8px]">
        <Input
          data-invite-email
          disabled={!canInvite || inviting}
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            setNote(null)
          }}
          placeholder="Email address"
          aria-label="Invite by email"
          type="email"
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
          className="h-control w-full bg-surface-1 px-2.5 text-base font-sans [flex:1]"
        />
        <NativeSelect
          data-invite-level
          aria-label="Invitation role"
          disabled={!canInvite || inviting}
          value={sending}
          onChange={(e) => setLevel(e.target.value === 'viewer' ? 'viewer' : 'user')}
          className="h-control w-28 shrink-0 bg-surface-1 text-base font-sans"
        >
          {!viewerOnly && <option value="user">User</option>}
          <option value="viewer">Viewer</option>
        </NativeSelect>
        <Button
          type="button"
          data-invite-send
          aria-busy={inviting || undefined}
          disabled={!canInvite || !typed || inviting}
          onClick={() => void invite()}
        >
          <Icon name="plus" size={16} />
          {inviting ? 'Inviting…' : 'Invite'}
        </Button>
      </div>
      {note && (
        <p role="status" data-invite-note="" className="mt-2 text-sm text-text-2">
          {note}
        </p>
      )}
      {emailed.map((e) => (
        <InviteOutcome key={e.seat} orgId={project.org_id} seat={e.seat} email={e.email} />
      ))}
    </SettingsGroup>
  )
}
