/* Modals: shared shell + New Issue + New Project (sub-project or program). */
import {
  type ComponentPropsWithoutRef as ComponentPropsM,
  Fragment,
  type ReactNode as ReactNodeM,
  useEffect as useEffectM,
  useRef as useRefM,
  useState as useStateM,
} from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { hasOpenTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { projectKeyBase, projectKeyCandidate } from '../../convex/lib/projectKeys'
import { ProjectAccessSelect } from '../components/ProjectAccessSelect'
import { Avatar, DateSelect, FieldSelect, Icon } from '../components/qivo'
import { relativeWeek, weekToISO } from '../lib/dates'
import { restoreFocus } from '../lib/focusVisibility'
import { isLandscapeRoadmapOpen } from '../lib/landscape'
import { useUpdateBlocker } from '../lib/updateSafety'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import { exactWeekForDate } from '../lib/weekDrafts'
import {
  type AccessLevel,
  type AccessRemoval,
  andList,
  type Holder,
  type IssueVM,
  type MilestoneVM,
  type NewIssueInput,
  type NewProjectInput,
  P,
  type TeamAccessLevel,
  teamNoun,
} from '../store/planner'

const ctlClass = 'h-control w-full bg-surface-1 text-base font-sans'

function MField({
  label,
  children,
  flex,
  ...rest
}: { label?: ReactNodeM; flex?: boolean } & ComponentPropsM<'div'>) {
  return (
    <div {...rest} className={`mb-6 min-w-0 last:mb-0 ${flex ? 'flex-1' : ''}`}>
      <div className="mb-2 text-sm font-normal text-text-1">{label}</div>
      {children}
    </div>
  )
}

function ModalShell({
  icon,
  title,
  badge,
  onClose,
  onSubmit,
  canSubmit,
  submitLabel,
  width = 500,
  footerLeft,
  footer,
  focusAfterClose,
  children,
}: {
  icon: string
  title: ReactNodeM
  badge?: ReactNodeM
  onClose: () => void
  onSubmit?: () => void
  canSubmit?: boolean
  submitLabel?: ReactNodeM
  width?: number
  footerLeft?: ReactNodeM
  footer?: ReactNodeM
  focusAfterClose?: () => HTMLElement | null
  children?: ReactNodeM
}) {
  // A create/edit dialog also holds non-text draft choices and staged files.
  // Keep its entire editing session intact until it is submitted or closed.
  useUpdateBlocker(true)
  const mobile = useMobile()
  const closeLayer = useMobileBackLayer(true, onClose, mobile || isLandscapeRoadmapOpen())
  const returnFocusRef = useRefM<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  return (
    <Dialog open onOpenChange={(open) => !open && closeLayer()}>
      {/* top-anchored 4vh from the browser edge (IssueDetail matches); the
          card grows with content and caps at 92vh so the 4vh margin also
          holds at the bottom before the body starts scrolling */}
      {/* Dialogs and task windows share the theme's floating material, with
          borders and shadows separating them from the page beneath. */}
      <DialogContent
        data-modal-shell
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="z-[100] bg-[var(--scrim)] backdrop-blur-[4px]"
        className="top-[4vh] z-[101] flex max-h-[92vh] max-w-[94vw] translate-y-0 flex-col gap-0 overflow-hidden rounded-xl bg-background p-0 shadow-pop"
        style={{ width: mobile ? '100%' : width }}
        onOpenAutoFocus={(event) => {
          // Preserve the shell's chosen field instead of Radix's close-button
          // fallback. data-autofocus takes precedence over document order.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          ;(
            content.querySelector<HTMLElement>('[data-autofocus]') ??
            content.querySelector<HTMLElement>(
              '[autofocus], input:not([type="hidden"]), textarea, select',
            )
          )?.focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus(focusAfterClose?.() ?? returnFocusRef.current)
        }}
        onEscapeKeyDown={(event) => {
          // The shell owns this key even when it closes. Without stopping the
          // native event, page-level Escape handlers (Inbox/Settings/task)
          // also run and dismiss the surface underneath it. An element that
          // answers Escape itself (data-escape-owner: the Milestones window's
          // inline editor cancels its edit) keeps the shell open too.
          event.stopPropagation()
          const target = event.target
          if (
            document.querySelector('[data-anchoredpop-backdrop]') ||
            (target instanceof Element &&
              target.closest('.ProseMirror, [data-mdpop], [data-mdtoolbar], [data-escape-owner]'))
          )
            event.preventDefault()
        }}
      >
        {/* No rule under the title and none over the footer, and the footer
            paints nothing of its own — deviation #65 took the drawn lines out
            of the task window and left these two standing only because they
            were the create dialogs' as much as its; #77 finishes the job, so a
            dialog is one unbroken sheet like the window beside it. What parts
            the three zones is space: 24px from the header to the first field and 24px of scrollable
            air before the footer actions, all on the same 20px inset. */}
        <div className="flex shrink-0 items-center gap-2 px-5 pt-4 pb-0">
          <Icon name={icon} size={16} color="var(--primary)" />
          <DialogTitle className="text-xl font-semibold text-text-1">{title}</DialogTitle>
          {/* the resting-control treatment every other box in the dialog wears
              — --surface-3 was the pill of a card that no longer exists */}
          {badge && (
            <span className="rounded-sm border border-border bg-surface-1 px-2 py-px font-mono text-xs text-text-3">
              {badge}
            </span>
          )}
          <div className="flex-1" />
          <Button type="button" variant="ghost" size="icon" onClick={closeLayer} aria-label="Close">
            <Icon name="close" size={16} />
          </Button>
        </div>
        {/* the 24px bottom is INSIDE the scroller on purpose: with no rule and
            no band under it, a body scrolled to its end has to come to rest
            clear of the buttons rather than butting into them */}
        <div className="overflow-y-auto px-5 pt-6 pb-6">{children}</div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-0 pb-5">
          {/* a custom footer replaces the Cancel/submit pair — for windows
              that paginate rather than submit (the Update Estimate walk) */}
          {footer !== undefined ? (
            footer
          ) : (
            <>
              {footerLeft}
              <div className="flex-1" />
              <Button type="button" variant="ghost" onClick={closeLayer} className="text-text-1">
                Cancel
              </Button>
              <Button
                type="button"
                variant={canSubmit ? 'primary' : 'default'}
                disabled={!canSubmit}
                onClick={onSubmit}
                className="font-semibold"
              >
                {submitLabel}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ---------- New issue ---------- */
function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(bytes < 102400 ? 1 : 0)} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/* While a drop target is mounted, a drop that misses it must not navigate
   the tab to the dropped file — that would destroy the whole open draft. */
function useWindowDropGuard() {
  useEffectM(() => {
    const swallow = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
}

function NewIssueModal({
  init = {},
  onClose,
  onCreate,
}: {
  init?: Partial<Pick<NewIssueInput, 'project' | 'status' | 'parent' | 'start' | 'end' | 'due'>>
  onClose: () => void
  onCreate: (issue: NewIssueInput) => boolean
}) {
  /* A task is created into a SUB-project, and which one is now asked in two
     steps: the project first, its sub-projects second. The dialog still opens
     on the project it was opened in — that is the default, not a fence — so
     the common path is unchanged and a create started from the wrong board no
     longer has to be cancelled and re-opened somewhere else. (Moving an
     EXISTING task between projects is still a move, not a re-create: the issue
     detail's Move dialog, which is also the only one that can keep the number.)
     The sub-project list is what the caller can WRITE in, not merely see: a
     viewer's grant can't hold a new task, so offering the target would end in
     a create the server rejects and the client rolls back a second later. The
     parent list is only the hierarchy picker, so a navigation-only parent is
     still included when it contains a writable child. A project with no
     sub-project has nowhere to put a task, so it isn't offered.
     Phone My tasks and All projects can open without a project context;
     they use the same writable roster and explicit project picker. */
  const subsOf = (metaId: string) =>
    P.projects.filter((p) => p.type === 'project' && p.parent === metaId)
  const writableSubsOf = (metaId: string) => subsOf(metaId).filter((p) => P.canWrite(p.id))
  const metas = P.projects.filter((p) => p.type === 'meta' && writableSubsOf(p.id).length > 0)
  const ctxMeta = (() => {
    const m = init.project ? P.metaOf(init.project) : null
    return m && metas.some((x) => x.id === m.id) ? m : null
  })()
  const initMeta = ctxMeta ? ctxMeta.id : metas[0] ? metas[0].id : null

  const created = useRefM(false)
  const [title, setTitle] = useStateM('')
  const [metaId, setMetaId] = useStateM(initMeta)
  const subProjects = metaId ? writableSubsOf(metaId) : []
  const initProj = (() => {
    const p = init.project ? P.project(init.project) : null
    if (p && p.type === 'project' && subProjects.some((sp) => sp.id === p.id)) return p.id
    return subProjects[0] ? subProjects[0].id : null
  })()
  const [projId, setProjId] = useStateM(initProj)
  const canSave =
    metas.some((meta) => meta.id === metaId) &&
    subProjects.some((project) => project.id === projId) &&
    title.trim().length > 0

  // Switching project carries the sub-project with it: the one held in state
  // belongs to the project being left, and leaving it there would submit a
  // task into a project the dialog no longer says it is creating in.
  const changeMeta = (mid) => {
    setMetaId(mid)
    const first = subsOf(mid)[0]
    setProjId(first ? first.id : null)
  }

  const submit = () => {
    if (!canSave) return
    // Keep the initiating column/date/parent context; the remaining details
    // are edited in the existing task window immediately after creation.
    created.current = onCreate({
      ...init,
      title: title.trim(),
      project: projId,
      status: init.status || 'backlog',
      priority: 'low',
    })
  }

  return (
    <ModalShell
      icon="layers"
      title="New task"
      onClose={onClose}
      onSubmit={submit}
      canSubmit={canSave}
      submitLabel="Create"
      width={520}
      focusAfterClose={() =>
        created.current
          ? document.querySelector<HTMLElement>('[data-task-scrim] [aria-label="Status"]')
          : null
      }
    >
      <MField label="Project">
        <NativeSelect
          data-new-issue-project
          aria-label="Project"
          value={metaId || ''}
          onChange={(e) => changeMeta(e.target.value)}
          className={ctlClass}
        >
          {metas.map((m) => (
            <option key={m.id} value={m.id}>
              {P.projectLabel(m)}
            </option>
          ))}
        </NativeSelect>
      </MField>
      <MField label="Sub-project">
        <NativeSelect
          data-new-issue-subproject
          aria-label="Sub-project"
          value={projId || ''}
          onChange={(e) => setProjId(e.target.value)}
          className={ctlClass}
        >
          {subProjects.map((p) => (
            <option key={p.id} value={p.id}>
              {P.projectLabel(p)}
            </option>
          ))}
        </NativeSelect>
      </MField>
      <MField label="Title">
        <Input
          aria-label="Title"
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={P.TITLE_MAX}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          className={`${ctlClass} h-control text-base font-medium`}
        />
      </MField>
    </ModalShell>
  )
}

/* ---------- New project & new sub-project ---------- */
// Abbreviations (projects.key) are no longer user-facing anywhere: the DB
// still requires a unique ≤5-char key per org, so creation derives one from
// the name instead of asking for it. This is only a preview. projects.create
// keeps it while it is free and otherwise picks the next candidate itself,
// because archived and hidden projects hold keys this client never sees.
const genKey = (name: string) => {
  const taken = new Set([...P.projects, ...P.archivedProjects].map((p) => p.key))
  const base = projectKeyBase(name)
  for (let n = 1; n <= 9999; n++) {
    const k = projectKeyCandidate(base, n)
    if (!taken.has(k)) return k
  }
  return base // every visible candidate is taken; the server picks one
}

function NameRow({ nameRef, name, setName, submit }) {
  return (
    <MField label="Name">
      <Input
        aria-label="Name"
        ref={nameRef}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        className={ctlClass}
      />
    </MField>
  )
}

/* New top-level project (program). A project is an organization-wide
   container, so it has a lead but no owning/managing team. Teams can still be
   added through the access picker below; sub-projects use the same model. */
function NewProjectModal({
  init: _init = {},
  onClose,
  onCreate,
}: {
  init?: { team?: string }
  onClose: () => void
  onCreate: (p: NewProjectInput, opts: { withStarter: boolean }) => void
}) {
  const [name, setName] = useStateM('')
  const [lead, setLead] = useStateM(P.CURRENT_USER)
  const [desc, setDesc] = useStateM('')
  const [teamAccess, setTeamAccess] = useStateM<Record<string, TeamAccessLevel>>({})
  const [access, setAccess] = useStateM<Record<string, AccessLevel>>({})
  const nameRef = useRefM(null)
  useEffectM(() => {
    nameRef.current?.focus()
  }, [])

  const leadCandidates = P.homeAssignees()
  const leadValid = leadCandidates.some((user) => user.id === lead)
  // A roster update must not submit a hidden or ineligible lead.
  useEffectM(() => {
    if (!leadValid) setLead(leadCandidates[0]?.id || '')
  }, [leadValid])
  const canSave = name.trim().length > 0 && leadValid

  const submit = () => {
    if (!canSave) return
    onCreate(
      {
        key: genKey(name),
        name: name.trim(),
        type: 'meta',
        lead: lead || undefined,
        description: desc.trim() || undefined,
        teamAccess,
        access,
      },
      { withStarter: false },
    )
  }

  return (
    <ModalShell
      icon="layers"
      title="New project"
      onClose={onClose}
      onSubmit={submit}
      canSubmit={canSave}
      submitLabel="Create project"
      width={480}
    >
      <NameRow nameRef={nameRef} name={name} setName={setName} submit={submit} />
      <div className="flex flex-wrap gap-x-2">
        <MField label="Lead" flex>
          <NativeSelect
            aria-label="Lead"
            value={leadValid ? lead : ''}
            onChange={(e) => {
              const next = e.target.value
              setLead(next)
              setAccess((current) => {
                const updated = { ...current }
                delete updated[next]
                return updated
              })
            }}
            className={ctlClass}
          >
            {leadCandidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </NativeSelect>
        </MField>
      </div>
      <MField label="Description">
        <Input
          aria-label="Description"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          className={ctlClass}
        />
      </MField>
      <MField label="Project access">
        <ProjectAccessSelect
          teams={P.teams.filter((candidate) => candidate.org === P.homeOrg)}
          users={P.homeUsers().filter(
            (user) =>
              !!access[user.id] || (user.active && user.id !== lead && user.orgRole !== 'admin'),
          )}
          teamAccess={teamAccess}
          access={access}
          onTeamChange={(teamId, level) => {
            setTeamAccess((current) => {
              const updated = { ...current }
              if (level) updated[teamId] = level
              else delete updated[teamId]
              return updated
            })
          }}
          onUserChange={(userId, level) => {
            setAccess((current) => {
              const updated = { ...current }
              if (level) updated[userId] = level
              else delete updated[userId]
              return updated
            })
          }}
        />
        <p className="mt-2 text-sm leading-normal text-text-2">
          Team access includes future members. Add each team that should see this project.
        </p>
      </MField>
    </ModalShell>
  )
}

/* New sub-project — needs lead-level on the parent project. It has its own
   lead and receives any team or user permissions through the access controls. */
function NewSubProjectModal({
  init = {},
  onClose,
  onCreate,
}: {
  init?: { parent?: string }
  onClose: () => void
  onCreate: (p: NewProjectInput, opts: { withStarter: boolean }) => void
}) {
  const metas = P.projects.filter((p) => p.type === 'meta' && P.levelOn(p.id) === 'lead')
  const [name, setName] = useStateM('')
  const [parent, setParent] = useStateM(init.parent || (metas[0] ? metas[0].id : null))
  const [lead, setLead] = useStateM(P.CURRENT_USER)
  const [withStarter, setWithStarter] = useStateM(true)
  const nameRef = useRefM(null)
  useEffectM(() => {
    nameRef.current?.focus()
  }, [])

  const parentMeta = P.project(parent)
  const leadCandidates = P.assigneesFor(parent || '')
  const leadValid = leadCandidates.some((user) => user.id === lead)
  useEffectM(() => {
    if (!leadValid) setLead(parentMeta?.lead || leadCandidates[0]?.id || '')
  }, [parentMeta?.lead, leadCandidates, lead])
  // parentValid: an init.parent the caller doesn't lead (openNewIssue's
  // redirect, the views' empty-state buttons) isn't among the options.
  const parentValid = metas.some((m) => m.id === parent)
  const canSave = name.trim().length > 0 && parentValid && leadValid

  const submit = () => {
    if (!canSave) return
    onCreate(
      {
        key: genKey(name),
        name: name.trim(),
        type: 'project',
        parent,
        lead: lead || undefined,
      },
      { withStarter },
    )
  }

  return (
    <ModalShell
      icon="layers"
      title="New sub-project"
      onClose={onClose}
      onSubmit={submit}
      canSubmit={canSave}
      submitLabel="Create sub-project"
      width={480}
    >
      {metas.length === 0 && (
        <div className="mb-6 text-sm leading-normal text-text-3">
          Project Lead access is required to create sub-projects.
        </div>
      )}
      <NameRow nameRef={nameRef} name={name} setName={setName} submit={submit} />
      <div className="flex flex-wrap gap-x-2">
        <MField label="Project" flex>
          <NativeSelect
            aria-label="Project"
            value={parent || ''}
            onChange={(e) => setParent(e.target.value)}
            className={ctlClass}
          >
            {metas.map((m) => (
              <option key={m.id} value={m.id}>
                {P.projectLabel(m)}
              </option>
            ))}
          </NativeSelect>
        </MField>
        <MField label="Lead" flex>
          <NativeSelect
            aria-label="Lead"
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            className={ctlClass}
          >
            {leadCandidates.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </NativeSelect>
        </MField>
      </div>
      <label
        htmlFor="subproject-starter"
        className="flex flex-wrap items-center gap-2 [font-size:var(--fs-base)] [color:var(--text-1)] [margin-bottom:24px] [cursor:pointer]"
      >
        <Input
          id="subproject-starter"
          type="checkbox"
          checked={withStarter}
          onChange={(e) => setWithStarter(e.target.checked)}
          className="[accent-color:var(--primary)]"
        />
        Create a starter task
      </label>
    </ModalShell>
  )
}

/* ---------- Move issue ---------- */
function MoveIssueModal({
  issueId,
  onClose,
  onMove,
  focusAfterClose,
}: {
  issueId: string
  onClose: () => void
  onMove: (target: string) => void
  focusAfterClose?: () => HTMLElement | null
}) {
  const it = P.issueById[issueId]
  // Offer same-organization destinations with write access. The server checks
  // access at both ends; a move preserves the task's immutable number.
  const groups = P.projects
    .filter(
      (m) =>
        m.type === 'meta' &&
        (!it || m.org === it.org) &&
        (m.children || []).some((cid) => P.canWrite(cid)),
    )
    .map((m) => ({
      meta: m,
      subs: (m.children || [])
        .map((cid) => P.project(cid))
        .filter((sp) => !!sp && P.canWrite(sp.id)),
    }))
    .filter((g) => g.subs.length > 0)
  const hasCurrent = !!it && groups.some((g) => g.subs.some((sp) => sp.id === it.project))
  const [target, setTarget] = useStateM(hasCurrent ? it.project : '')
  if (!it) return null
  // targetValid: a concurrently deleted target vanishes from the options but
  // would linger in state — the blank select must not leave Move enabled
  const targetValid = groups.some((g) => g.subs.some((sp) => sp.id === target))
  // whoever works on the task or its subtasks must keep access after the
  // move; the dialog names them (subtasks outside this view are left to the
  // server, whose refusal names no one)
  const blockers = targetValid && target !== it.project ? P.moveBlockers(it, target) : []
  const canMove = !!target && target !== it.project && targetValid && !blockers.length
  // no dirty-draft guard any more: the issue's key is org-scoped and
  // immutable (0050), so a move no longer remounts the editor — an open
  // description draft survives the move untouched
  const submit = () => {
    if (!canMove) return
    onMove(target)
  }
  return (
    <ModalShell
      icon="arrowRight"
      title="Move task"
      badge={it.key}
      onClose={onClose}
      focusAfterClose={focusAfterClose}
      onSubmit={submit}
      canSubmit={canMove}
      submitLabel="Move"
      width={440}
    >
      <MField label="Move to">
        <NativeSelect
          aria-label="Move to"
          autoFocus
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className={ctlClass}
        >
          {!hasCurrent && (
            <option value="" disabled hidden>
              Choose a sub-project…
            </option>
          )}
          {groups.map((g) => (
            <optgroup key={g.meta.id} label={P.projectLabel(g.meta)}>
              {g.subs.map((sp) => (
                <option key={sp.id} value={sp.id}>
                  {P.projectLabel(sp)}
                  {sp.id === it.project ? ' (current)' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </NativeSelect>
      </MField>
      {blockers.length > 0 && (
        <div
          data-move-blockers
          className="[font-size:var(--fs-base)] [color:var(--text-2)] [line-height:1.5] [margin-top:12px] flex flex-col gap-2"
        >
          {blockers.slice(0, 3).map((b) => (
            <p key={`${b.task.id}:${b.role}`}>{P.blockerText(b)}</p>
          ))}
          {blockers.length > 3 && (
            <p>
              {blockers.length === 4
                ? '1 more assignment is affected.'
                : `${blockers.length - 3} more assignments are affected.`}
            </p>
          )}
        </div>
      )}
    </ModalShell>
  )
}

/* ---------- Removing access from someone who has work ----------
   Shown before access is removed when someone would lose sight of open
   tasks they are assigned to or reviewing: a person's or a team's grant in
   project settings, or a member leaving a team or a team being deleted in
   Team settings. Keeping them as Viewers is selected first; reassigning
   hands every listed task to one person, or to nobody, and then removes the
   access. Removing someone whose grant is already Viewer leaves only the
   reassignment. The lists are taken when the window opens, so a choice
   applies only to the tasks the person read; if they or the chosen person's
   eligibility changed meanwhile, the window shows the new lists and asks
   again. It stays open, and keeps the settings behind it out of reach, until
   the server has accepted the removal. If a write is refused the access
   stays and so does the window, listing the tasks that remain. If someone
   else removed the access meanwhile, it closes and says so. */
const NOBODY = '__nobody__'
function AccessRemovalModal({ change, onClose }: { change: AccessRemoval; onClose: () => void }) {
  const read = () => {
    const removal = P.accessRemoval(change)
    return { ...removal, choices: P.reassignChoices(change, removal.items) }
  }
  const [{ people, items, projects, choices }, setView] = useStateM(read)
  const [changed, setChanged] = useStateM(false)
  const [saving, setSaving] = useStateM(false)
  const [canKeep] = useStateM(
    () =>
      !(
        change.kind === 'userGrant' &&
        P.project(change.projectId)?.access?.[change.userId] === 'viewer'
      ),
  )
  const [keep, setKeep] = useStateM(canKeep)
  const [to, setTo] = useStateM(NOBODY)
  if (!items.length) return null
  const names = people.map((id) => P.user(id)?.name || 'Someone')
  const tasks = `${items.length} task${items.length === 1 ? '' : 's'}`
  // "the task" and "this task" read better than "the 1 task"
  const theTasks = items.length === 1 ? 'the task' : `the ${tasks}`
  const these = items.length === 1 ? 'this task' : 'these tasks'
  const team = 'teamId' in change ? P.teams.find((t) => t.id === change.teamId) : null
  const teamName = `the ${teamNoun(team?.name)}`
  const person = 'userId' in change ? P.user(change.userId)?.name || 'Someone' : ''
  const places = projects.flatMap((id) => P.project(id) || [])
  // a project removal names its own project; a team change names where it reached
  const project =
    change.kind === 'userGrant' || change.kind === 'teamGrant' ? P.project(change.projectId) : null
  const shown = places.length > 3 ? places.slice(0, 2) : places
  const more = places.length - shown.length
  const seen = project
    ? project.type === 'meta'
      ? 'the whole project'
      : 'the whole sub-project'
    : andList(
        places.map((p) => P.projectLabel(p)),
        (n) => `${n} other projects`,
      )
  const inIt = places.length > 1 ? 'them' : 'it'
  const keepText =
    names.length === 1
      ? `${names[0].split(' ')[0]} keeps ${theTasks} and can see ${seen}, but can't change anything in ${inIt}, including ${these}.`
      : `They keep their tasks and can see ${seen}, but can't change anything in ${inIt}, including ${these}.`
  const deleting = change.kind === 'deleteTeam'
  const title =
    change.kind === 'userGrant'
      ? `Remove ${person}?`
      : change.kind === 'teamGrant'
        ? `Remove ${teamName}?`
        : change.kind === 'teamMember'
          ? `Remove ${person} from ${teamName}?`
          : `Delete ${teamName}?`
  const keepLabel =
    change.kind === 'teamMember'
      ? 'Keep as Viewer and remove'
      : deleting
        ? `Keep as Viewer${people.length === 1 ? '' : 's'} and delete`
        : 'Change to Viewer'
  const finish = (removal: Promise<boolean>) => {
    setSaving(true)
    void removal.then((removed) => {
      const left = removed ? null : read()
      if (!left?.items.length) return onClose()
      setSaving(false)
      setView(left)
    })
  }
  const submit = () => {
    if (saving) return
    const now = read()
    const key = (list: Holder[]) =>
      list
        .map((i) => `${i.task.id}:${i.role}:${i.uid}`)
        .sort()
        .join()
    const lost = !keep && to !== NOBODY && !now.choices.some((u) => u.id === to)
    if (lost || key(now.items) !== key(items)) {
      if (!now.items.length) {
        // someone else removed this access meanwhile: say so instead of a silent close
        if (!P.removalPending(change)) {
          const gone =
            change.kind === 'userGrant'
              ? `${person} no longer has this access.`
              : change.kind === 'teamGrant'
                ? `The ${teamNoun(team?.name)} no longer has this access.`
                : change.kind === 'teamMember'
                  ? `${person} has already left ${teamName}.`
                  : `The ${teamNoun(team?.name)} was already deleted.`
          window.showToast?.(`${gone} Nothing was changed.`, 'info')
          onClose()
          return
        }
        // nobody loses sight of anything any more: the plain removal applies
        finish(P.removeAccess(change, { to: null }, []))
        return
      }
      setView(now)
      setChanged(true)
      if (!now.choices.some((u) => u.id === to)) setTo(NOBODY)
      return
    }
    finish(P.removeAccess(change, keep ? { keep: true } : { to: to === NOBODY ? null : to }, items))
  }
  const option = (selected: boolean) =>
    cn(
      'flex flex-col rounded-lg border p-3',
      selected ? '[border-color:var(--primary)] [background:var(--accent-soft)]' : 'border-border',
    )
  return (
    <ModalShell
      icon="warning"
      title={title}
      onClose={saving ? () => {} : onClose}
      onSubmit={submit}
      canSubmit={!saving}
      submitLabel={
        saving
          ? 'Saving…'
          : keep
            ? keepLabel
            : deleting
              ? 'Reassign and delete'
              : 'Reassign and remove'
      }
      width={500}
    >
      <div data-access-removal className="flex flex-col gap-3">
        <p className="[font-size:var(--fs-base)] [color:var(--text-2)] [line-height:1.5]">
          {andList(names)} {names.length === 1 ? 'is' : 'are'} assigned to or reviewing {tasks} in{' '}
          {shown.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && (i === shown.length - 1 && !more ? ' and ' : ', ')}
              <b className="text-text-1">{P.projectLabel(p)}</b>
            </Fragment>
          ))}
          {more > 0 && ` and ${more} other projects`}.
        </p>
        {changed && (
          <p className="text-sm [color:var(--danger)]">
            Access or tasks changed while this window was open. Check them and choose again.
          </p>
        )}
        <div className="max-h-48 overflow-auto rounded-lg border border-border">
          {items.map((i) => (
            <div
              key={`${i.task.id}:${i.role}:${i.uid}`}
              className="flex items-center gap-2.5 border-t border-border px-3 py-2 text-sm first:border-t-0"
            >
              <span className="w-12 shrink-0 font-mono text-xs text-text-2">{i.task.key}</span>
              <span className="min-w-0 flex-1 truncate text-text-1">{i.task.title}</span>
              <span className="shrink-0 text-xs text-text-2">
                {names.length > 1 ? `${P.user(i.uid)?.name.split(' ')[0]}, ` : ''}
                {i.role === 'reviewer' ? 'Reviewer' : 'Assignee'}
              </span>
            </div>
          ))}
        </div>
        {canKeep && (
          <div className={option(keep)}>
            <Label className="flex cursor-pointer items-start gap-2.5 font-normal">
              <Input
                type="radio"
                name="access-removal"
                checked={keep}
                onChange={() => setKeep(true)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold text-text-1">Keep as Viewer</span>
                <span className="text-sm text-text-2">{keepText}</span>
              </span>
            </Label>
          </div>
        )}
        <div className={option(!keep)}>
          <Label className="flex cursor-pointer items-start gap-2.5 font-normal">
            {canKeep && (
              <Input
                type="radio"
                name="access-removal"
                checked={!keep}
                onChange={() => setKeep(false)}
                className="mt-0.5"
              />
            )}
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-semibold text-text-1">
                Reassign {theTasks}, then {deleting ? 'delete the team' : 'remove'}
              </span>
              <span className="text-sm text-text-2">Reviewer roles move to the same person.</span>
            </span>
          </Label>
          {/* outside the label, so opening the picker never toggles the radio */}
          <FieldSelect
            aria-label="New assignee"
            className={cn('mt-2', canKeep && 'ml-6.5')}
            menuWidth={240}
            value={to}
            options={[
              { value: NOBODY, label: 'Unassigned' },
              ...choices.map((u) => ({
                value: u.id,
                label: u.name,
                icon: <Avatar id={u.id} size={28} />,
              })),
            ]}
            onChange={(v) => {
              setTo(v)
              setKeep(false)
            }}
          />
        </div>
      </div>
    </ModalShell>
  )
}

/* ---------- Archive issue (0070) ---------- */
/* Shown whenever archiving would take UNFINISHED leaf work off the board
   (archiving is subtree-atomic). Parent statuses do not affect this decision.
   The required note lands in the issue's comments,
   readable after a restore or from the Archive page. An issue whose whole
   subtree is Done archives without a dialog. */
function ArchiveIssueModal({
  issueId,
  onClose,
  onArchive,
  focusAfterClose,
}: {
  issueId: string
  onClose: () => void
  onArchive: (reason: string) => void
  focusAfterClose?: () => HTMLElement | null
}) {
  const it = P.issueById[issueId]
  const [reason, setReason] = useStateM('')
  if (!it) return null
  const status = P.statusOf(it.status)
  const sub = P.progressOf(it) // whole subtree — the cascade takes all of it
  const unfinished = sub.total - sub.done
  const rootGroup = P.isGroup(it)
  // archiving changes every active subtask, so the server refuses when one is
  // in a project this person cannot edit
  // the subtree's issues, listed so it's plain what the cascade takes along
  // (the store only mirrors active issues, so everything here is unarchived;
  // cycle-safe like progressOf)
  const subIssues: IssueVM[] = []
  {
    const seen = new Set<string>()
    const stack = [...(it.children || [])]
    while (stack.length) {
      const c = stack.pop()
      if (seen.has(c)) continue
      seen.add(c)
      const ci = P.issueById[c]
      if (!ci) continue
      subIssues.push(ci)
      ;(ci.children || []).forEach((k: string) => {
        stack.push(k)
      })
    }
    // by task number — read from the display key, since the handle is a uuid
    // for another organization's tasks (0081)
    subIssues.sort(
      (a, b) => Number(String(a.key).split('-')[1]) - Number(String(b.key).split('-')[1]),
    )
  }
  const readOnlySub = subIssues.some((si) => !P.canWrite(si.project))
  const canSubmit = reason.trim().length > 0 && !readOnlySub
  const refusal = readOnlySub
    ? ' At least one is in a project you cannot edit, so an organization admin can archive it.'
    : sub.unknown
      ? ' If any of them is in a project you cannot edit, the archive is refused.'
      : ''
  return (
    <ModalShell
      icon="inbox"
      title="Archive task"
      badge={it.key}
      onClose={onClose}
      focusAfterClose={focusAfterClose}
      onSubmit={() => {
        if (canSubmit) onArchive(reason.trim())
      }}
      canSubmit={canSubmit}
      submitLabel="Archive"
      width={440}
    >
      <div className="[font-size:var(--fs-base)] [color:var(--text-2)] [line-height:1.5] [margin-bottom:12px]">
        {rootGroup && sub.unknown ? (
          <>
            <b>{it.key}</b> may include work outside this view; completion is unknown. All subtasks
            will also be archived.{refusal}
          </>
        ) : rootGroup ? (
          <>
            <b>{it.key}</b> has{' '}
            {unfinished === 1
              ? 'one unfinished subtask'
              : unfinished > 1
                ? `${unfinished} unfinished subtasks`
                : 'unfinished subtasks'}
            . All subtasks will also be archived.{refusal}
          </>
        ) : (
          <>
            <b>{it.key}</b> is <b>{status ? status.name : it.status}</b>.
          </>
        )}
      </div>
      {subIssues.length > 0 && (
        <div data-archive-subtree className="[margin-bottom:12px]">
          <div className="[font-size:var(--fs-sm)] [font-weight:600] [color:var(--danger)] [line-height:1.45] [margin-bottom:8px]">
            {subIssues.length === 1
              ? 'Also archives 1 subtask:'
              : `Also archives ${subIssues.length} subtasks:`}
          </div>
          <div className="[max-height:160px] [overflow-y:auto] [border:1px_solid_var(--border)] [border-radius:var(--r-md)] [background:var(--surface-1)]">
            {subIssues.map((si) => {
              const st = P.statusOf(si.status)
              const done = si.status === 'done'
              return (
                <div
                  key={si.id}
                  data-archive-subtree-row
                  className="[display:flex] [gap:8px] [align-items:baseline] [padding:5px_10px] [font-size:var(--fs-sm)] [line-height:1.4]"
                >
                  <span className="[font-weight:600] [color:var(--text-3)] [flex-shrink:0]">
                    {si.key}
                  </span>
                  <span className="[flex:1] [color:var(--text-1)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                    {si.title}
                  </span>
                  {!P.isGroup(si) && (
                    <span
                      style={{ color: done ? 'var(--text-3)' : 'var(--danger)' }}
                      className="[flex-shrink:0]"
                    >
                      {st ? st.name : si.status}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      <MField label="Reason (required)">
        <Textarea
          data-archive-reason
          aria-label="Reason for archiving"
          autoFocus
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${ctlClass} h-auto min-h-[72px] resize-y px-2.5 py-2 leading-normal`}
        />
        <p className="mt-2 text-sm text-text-2">Saved to the task's comments.</p>
      </MField>
    </ModalShell>
  )
}

/* ---------- Milestones (list + create + edit, one window) ----------
   Deviation #239. The window IS the project's milestone list: the first row
   is the new milestone (name, week, Add), "On the roadmap" lists the
   project's milestones by week, and a row's Edit button opens it in place
   with Delete / Cancel / Save. Every action commits where it stands and the
   window stays open — the footer is only Done. `init.id` opens with that
   row's editor open (a roadmap diamond, an Overview row, the phone agenda);
   `init.project` opens on the new row, `init.week` preselecting its week. */
function MilestoneModal({
  init = {},
  onClose,
}: {
  init?: { id?: string; week?: number; project?: string | null }
  onClose: () => void
}) {
  // milestones sit on a project's roadmap (0078) — a new one needs one, and
  // writing takes user level on it. The project is fixed when the window
  // opens: opened on a milestone, it stays on that milestone's project after
  // the milestone itself is deleted here.
  const [projectId] = useStateM(() => {
    const opened = init.id ? P.milestones.find((m) => m.id === init.id) : null
    return (opened ? P.metaOf(opened.project) : P.metaOf(init.project))?.id ?? null
  })
  const project = projectId ? P.metaOf(projectId) : null
  const canWrite = !!project && ['lead', 'user'].includes(P.levelOn(project.id) || '')
  // the row editor opens only for someone who may write: a read-only flag or
  // row opens the list with that milestone in view
  const [editId, setEditId] = useStateM<string | null>(canWrite ? (init.id ?? null) : null)
  const [initialDate] = useStateM(() => (init.week == null ? null : weekToISO(init.week)))
  const [name, setName] = useStateM('')
  const [date, setDate] = useStateM(() => initialDate ?? weekToISO(P.TODAY_WEEK))
  const week = exactWeekForDate(date)
  const list = project
    ? P.milestonesIn(project.id)
        .slice()
        .sort((a, b) => a.week - b.week || a.name.localeCompare(b.name))
    : []
  const next = list.find((m) => m.week >= P.TODAY_WEEK) ?? null
  const canAdd = canWrite && name.trim().length > 0
  const add = () => {
    if (!canAdd || !project) return
    P.addMilestone({ name: name.trim(), week: exactWeekForDate(date), project: project.id })
    window.showToast?.(`Milestone “${name.trim()}” added`)
    setName('')
    setDate(initialDate ?? weekToISO(P.TODAY_WEEK))
  }
  return (
    <ModalShell
      icon="diamond"
      title="Milestones"
      // the shell's chip is set in mono for task keys; a project name is prose
      badge={project && <span className="font-sans">{project.name}</span>}
      onClose={onClose}
      width={600}
      footer={
        <>
          <div className="flex-1" />
          <Button type="button" onClick={onClose} className="font-semibold">
            Done
          </Button>
        </>
      }
    >
      {!project ? (
        <div className="text-base text-text-2">Open a project to add a milestone.</div>
      ) : (
        <>
          {canWrite && (
            <div className="flex flex-wrap items-center gap-3">
              <Input
                aria-label="New milestone"
                placeholder="New milestone"
                data-milestone-new
                data-autofocus={init.id ? undefined : ''}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') add()
                }}
                className={cn(ctlClass, 'min-w-[160px] flex-1 font-medium')}
              />
              {/* the week and Add stay together when a phone wraps the row */}
              <span className="flex shrink-0 items-center gap-3">
                <DateSelect
                  value={week}
                  onChange={(w) => {
                    if (w != null) setDate(weekToISO(w))
                  }}
                  title="Milestone date"
                  className="h-control w-[150px] rounded-md font-sans text-base"
                />
                <Button
                  type="button"
                  variant={canAdd ? 'primary' : 'default'}
                  disabled={!canAdd}
                  onClick={add}
                  className="font-semibold"
                >
                  Add
                </Button>
              </span>
            </div>
          )}
          <div
            className={cn(
              'mb-2 flex items-center gap-2 text-md font-semibold text-text-1',
              canWrite && 'mt-6',
            )}
          >
            On the roadmap
            <span className="font-normal text-text-3">{list.length}</span>
          </div>
          <div className="flex flex-col gap-1">
            {list.map((m) =>
              canWrite && m.id === editId ? (
                <MilestoneEditor key={m.id} m={m} onClose={() => setEditId(null)} />
              ) : (
                <MilestoneRowView
                  key={m.id}
                  m={m}
                  next={next?.id === m.id}
                  onEdit={canWrite ? () => setEditId(m.id) : undefined}
                />
              ),
            )}
            {list.length === 0 && (
              <div className="px-0.5 py-1 text-sm text-text-3 italic">No milestones yet.</div>
            )}
          </div>
        </>
      )}
    </ModalShell>
  )
}

/* One milestone on the list: the diamond, the name, the Overview's relative
   phrase and the roadmap's week label, and an Edit button when the caller may
   write. Past milestones are dimmed; the next one's phrase is emphasised. On
   a phone the two labels drop under the name. */
function MilestoneRowView({
  m,
  next,
  onEdit,
}: {
  m: MilestoneVM
  next: boolean
  onEdit?: () => void
}) {
  const mobile = useMobile()
  const past = m.week < P.TODAY_WEEK
  const edit = onEdit && (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      title={`Edit “${m.name}”`}
      aria-label={`Edit ${m.name}`}
      onClick={onEdit}
      className="text-text-2 hover:text-text-1"
    >
      <Icon name="pen" size={16} />
    </Button>
  )
  return (
    <div
      data-milestone-row={m.id}
      className="flex min-h-control flex-wrap items-center gap-x-3 gap-y-0.5 rounded-md pr-1 pl-2"
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-[9px] shrink-0 rotate-45 rounded-[var(--r-2xs)] bg-[var(--milestone)]',
          past && 'opacity-45',
        )}
      />
      <span
        className={cn('min-w-0 flex-1 truncate text-base', past ? 'text-text-2' : 'text-text-1')}
      >
        {m.name}
      </span>
      {mobile && edit}
      <span className={cn('flex items-center gap-3', mobile && 'basis-full pl-6')}>
        <span
          className={cn(
            'shrink-0 text-xs whitespace-nowrap',
            !mobile && 'w-[84px] text-right',
            next ? 'font-medium text-text-1' : 'text-text-2',
          )}
        >
          {relativeWeek(m.week)}
        </span>
        <time
          dateTime={weekToISO(m.week)}
          className={cn(
            'shrink-0 font-mono text-xs whitespace-nowrap',
            !mobile && 'w-[96px] text-right',
            past ? 'text-text-3' : 'text-text-2',
          )}
        >
          {P.weekLabel(m.week)}
        </time>
      </span>
      {!mobile && edit}
    </div>
  )
}

/* The row, opened: name and week on the lit material of an on-state, then
   Delete / Cancel / Save on a second line. Enter saves; Escape cancels the
   edit and leaves the window open (data-escape-owner, see ModalShell). */
function MilestoneEditor({ m, onClose }: { m: MilestoneVM; onClose: () => void }) {
  const [name, setName] = useStateM(m.name)
  const [date, setDate] = useStateM(() => weekToISO(m.week))
  const week = exactWeekForDate(date)
  const canSave = name.trim().length > 0
  const rootRef = useRefM<HTMLDivElement>(null)
  const closeRef = useRefM(onClose)
  closeRef.current = onClose
  // Escape is read here, on the document in the capture phase, because that
  // is where the shell's Radix listener reads it and stops propagation: an
  // onKeyDown on the Name box would never see the key. Listeners on the same
  // node still run. An open calendar owns the key first (it closes itself).
  useEffectM(() => {
    const onKey = (e: KeyboardEvent) => {
      // an open tooltip closes first and passes the Escape on, read then
      if (
        e.key !== 'Escape' ||
        hasOpenTooltip() ||
        document.querySelector('[data-anchoredpop-backdrop]')
      )
        return
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) closeRef.current()
    }
    document.addEventListener('keydown', onKey, { capture: true })
    return () => document.removeEventListener('keydown', onKey, { capture: true })
  }, [])
  const save = () => {
    if (!canSave) return
    P.updateMilestone(m.id, { name: name.trim(), week: exactWeekForDate(date) })
    window.showToast?.('Milestone updated')
    onClose()
  }
  // two-click arm-then-confirm with the app-wide 3.5s self-disarm (the
  // Settings ConfirmButton pattern — not imported: Settings already imports
  // from this module, and the row keeps its ghost style)
  const [armDel, setArmDel] = useStateM(false)
  useEffectM(() => {
    if (!armDel) return
    const t = setTimeout(() => setArmDel(false), 3500)
    return () => clearTimeout(t)
  }, [armDel])
  const remove = () => {
    if (!armDel) {
      setArmDel(true)
      return
    }
    P.removeMilestone(m.id)
    window.showToast?.('Milestone removed')
    onClose()
  }
  return (
    <div
      ref={rootRef}
      data-milestone-editor={m.id}
      data-escape-owner
      className="rounded-md bg-lit p-2 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="size-[9px] shrink-0 rotate-45 rounded-[var(--r-2xs)] bg-[var(--milestone)]"
        />
        <Input
          aria-label="Name"
          data-autofocus
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          className={cn(ctlClass, 'min-w-[160px] flex-1 font-medium')}
        />
        <DateSelect
          value={week}
          onChange={(w) => {
            if (w != null) setDate(weekToISO(w))
          }}
          title="Milestone date"
          className="h-control w-[150px] rounded-md font-sans text-base"
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <span className="text-xs text-text-3">Week {P.weekNumberOf(week).num}</span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          style={{ background: armDel ? 'var(--danger-soft)' : undefined }}
          className="[color:var(--danger)]"
          onClick={remove}
        >
          <Icon name="trash" size={16} />
          {armDel ? 'Confirm delete' : 'Delete'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant={canSave ? 'primary' : 'default'}
          size="sm"
          disabled={!canSave}
          onClick={save}
          className="font-semibold"
        >
          Save
        </Button>
      </div>
    </div>
  )
}

/* ---------- Create your organization ----------
   Only reachable for a login that has NO home organization of its own — it
   signed up and was invited straight into someone else's project as a guest
   (0081). One home organization per login, forever, so this is a one-time
   door; `create_organization` refuses a second. */
function CreateOrgModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useStateM('')
  const [busy, setBusy] = useStateM(false)
  const ref = useRefM<HTMLInputElement>(null)
  useEffectM(() => {
    ref.current?.focus()
  }, [])
  const canSave = name.trim().length > 0 && !busy
  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    const ok = await P.createOrg(name.trim())
    setBusy(false)
    if (ok) {
      window.showToast?.(`“${name.trim()}” is yours — you're its first admin`)
      onClose()
    }
  }
  return (
    <ModalShell
      icon="people"
      title="Create your organization"
      onClose={onClose}
      onSubmit={submit}
      canSubmit={canSave}
      submitLabel={busy ? 'Creating…' : 'Create'}
      width={440}
    >
      <MField label="Organization name">
        <Input
          aria-label="Organization name"
          ref={ref}
          data-create-org
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          className={ctlClass}
        />
      </MField>
    </ModalShell>
  )
}

export {
  AccessRemovalModal,
  ArchiveIssueModal,
  CreateOrgModal,
  fmtSize,
  MilestoneModal,
  ModalShell,
  MoveIssueModal,
  NewIssueModal,
  NewProjectModal,
  NewSubProjectModal,
  useWindowDropGuard,
}
