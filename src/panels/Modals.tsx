/* Modals: shared shell + New Issue + New Project (sub-project or program). */
import {
  type ComponentPropsWithoutRef as ComponentPropsM,
  Fragment,
  type ReactNode as ReactNodeM,
  useEffect as useEffectM,
  useId as useIdM,
  useRef as useRefM,
  useState as useStateM,
} from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { hasOpenTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { projectKeyBase, projectKeyCandidate } from '../../convex/lib/projectKeys'
import { PROJECT_DESCRIPTION_MAX } from '../../convex/lib/projectLimits'
import { NAME_MAX, TEXT_MAX } from '../../convex/lib/textLimits'
import { ProjectAccessSelect } from '../components/ProjectAccessSelect'
import { Avatar, DateSelect, FieldSelect, Icon } from '../components/qivo'
import { relativeWeek, weekToISO } from '../lib/dates'
import { restoreFocus } from '../lib/focusVisibility'
import { isLandscapeRoadmapOpen } from '../lib/landscape'
import {
  type AccessDraft,
  afterAccessChange,
  afterLeadChange,
  creatorNote,
  requestedAccess,
} from '../lib/newProjectAccess'
import { useUpdateBlocker } from '../lib/updateSafety'
import { useConfirmArm } from '../lib/useConfirmArm'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import { exactWeekForDate } from '../lib/weekDrafts'
import {
  type AccessRemoval,
  andList,
  type Holder,
  type IssueVM,
  type MilestoneVM,
  type NewIssueInput,
  type NewProjectInput,
  P,
  type ProjectRemovalSummary,
  type ProjectVM,
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
  danger = false,
  dangerSubmit = false,
  width = 500,
  footerLeft,
  footer,
  focusAfterClose,
  keepOnOutsideClick = false,
  children,
}: {
  icon: string
  title: ReactNodeM
  badge?: ReactNodeM
  /** return false to stay open; on a phone the Back step is then restored */
  onClose: () => unknown
  onSubmit?: () => void
  canSubmit?: boolean
  submitLabel?: ReactNodeM
  /** paints the icon, the border and the submit button red, for a submit
   * that cannot be undone (Delete now, revoking a credential) */
  danger?: boolean
  /** paints only the submit button red, for a submit that moves something to
   * Deleted items, where it can still be restored */
  dangerSubmit?: boolean
  width?: number
  /** a status line left of Cancel and the submit button. Its container is a
   * polite live region from the start, so a line that appears as the form
   * changes is announced */
  footerLeft?: ReactNodeM
  footer?: ReactNodeM
  focusAfterClose?: () => HTMLElement | null
  /** ignore clicks outside the dialog, for content an accidental close would
   * lose for good (a secret shown once). Close, Escape and the footer still
   * close it */
  keepOnOutsideClick?: boolean
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
      {/* Dialogs and task windows share the theme's window material and
          backdrop (appearance.css), with borders and shadows separating them
          from the page beneath. */}
      <DialogContent
        data-modal-shell
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="z-[100]"
        className={cn(
          'top-[4vh] z-[101] flex max-h-[92vh] max-w-[94vw] translate-y-0 flex-col gap-0 overflow-hidden rounded-xl bg-background p-0 shadow-pop',
          danger && 'border-[color-mix(in_oklab,var(--danger)_45%,var(--border))]',
        )}
        style={{ width: mobile ? '100%' : width }}
        onOpenAutoFocus={(event) => {
          // Preserve the shell's chosen field instead of Radix's close-button
          // fallback. data-autofocus takes precedence over document order; a
          // window with no field takes focus itself, so it never stays behind.
          event.preventDefault()
          const content = event.currentTarget as HTMLElement
          ;(
            content.querySelector<HTMLElement>('[data-autofocus]') ??
            content.querySelector<HTMLElement>(
              '[autofocus], input:not([type="hidden"]), textarea, select',
            ) ??
            content
          ).focus()
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          restoreFocus(focusAfterClose?.() ?? returnFocusRef.current)
        }}
        onInteractOutside={keepOnOutsideClick ? (event) => event.preventDefault() : undefined}
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
          <Icon name={icon} size={16} color={danger ? 'var(--danger)' : 'var(--primary)'} />
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
              {/* footerLeft takes the room left of the buttons and wraps
                  there, so the buttons keep their row */}
              <div
                className="min-w-0 flex-1"
                role={footerLeft === undefined ? undefined : 'status'}
              >
                {footerLeft}
              </div>
              <Button type="button" variant="ghost" onClick={closeLayer} className="text-text-1">
                Cancel
              </Button>
              <Button
                type="button"
                variant={
                  canSubmit ? (danger || dangerSubmit ? 'destructive' : 'primary') : 'default'
                }
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

/* The one line left of a create dialog's Cancel and submit buttons, beside
   the place the creator looks just before saving. Muted when someone else
   will lead the project, warning ink when the creator would not see it. */
function FooterNote({ tone, children }: { tone: 'muted' | 'warn'; children: ReactNodeM }) {
  return (
    <p
      data-footer-note={tone}
      className={cn(
        'flex items-start gap-1.5 pr-3 text-sm leading-snug',
        tone === 'warn' ? 'text-warning' : 'text-text-2',
      )}
    >
      <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

/* The footer note for a non-admin creator (see creatorNote). */
function CreatorNote({ note, lead }: { note: ReturnType<typeof creatorNote>; lead: string }) {
  if (note === 'hidden') return <FooterNote tone="warn">You won't see this project.</FooterNote>
  if (note === 'lead') {
    return (
      <FooterNote tone="muted">
        Only {P.user(lead)?.name || 'the lead'} and org admins can manage it.
      </FooterNote>
    )
  }
  return null
}

function NameRow({ nameRef, name, setName, submit }) {
  return (
    <MField label="Name">
      <Input
        aria-label="Name"
        ref={nameRef}
        value={name}
        maxLength={NAME_MAX}
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
   added through the access picker below; sub-projects use the same model.
   A creator who is not an org admin and picks someone else as lead is shown
   in Project access as User, the grant the server gives them
   (lib/newProjectAccess.ts), and the footer says who will manage the project
   or that the creator would not see it. */
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
  const [draft, setDraft] = useStateM<AccessDraft>({ access: {}, self: 'none' })
  const access = draft.access
  const nameRef = useRefM(null)
  useEffectM(() => {
    nameRef.current?.focus()
  }, [])

  const creator = { id: P.CURRENT_USER, admin: P.isAdmin() }
  const leadCandidates = P.homeAssignees()
  const leadValid = leadCandidates.some((user) => user.id === lead)
  const changeLead = (next: string) => {
    setLead(next)
    setDraft((current) => afterLeadChange(current, next, creator))
  }
  // A roster update must not submit a hidden or ineligible lead.
  useEffectM(() => {
    if (!leadValid) changeLead(leadCandidates[0]?.id || '')
  }, [leadValid])
  const canSave = name.trim().length > 0 && leadValid
  const note = creatorNote({
    creator,
    lead,
    sees: P.seesNewProject({ lead, access: requestedAccess(draft, creator), teamAccess }),
  })

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
        access: requestedAccess(draft, creator),
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
      footerLeft={<CreatorNote note={note} lead={lead} />}
    >
      <NameRow nameRef={nameRef} name={name} setName={setName} submit={submit} />
      {/* Alone on its row, it keeps MField's 24px below it. As the last
          child of a row of its own, last:mb-0 took that gap away. */}
      <MField label="Lead">
        <NativeSelect
          aria-label="Lead"
          value={leadValid ? lead : ''}
          onChange={(e) => changeLead(e.target.value)}
          className={ctlClass}
        >
          {leadCandidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </NativeSelect>
      </MField>
      <MField label="Description">
        <Input
          aria-label="Description"
          maxLength={PROJECT_DESCRIPTION_MAX}
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
          you={P.CURRENT_USER}
          onTeamChange={(teamId, level) => {
            setTeamAccess((current) => {
              const updated = { ...current }
              if (level) updated[teamId] = level
              else delete updated[teamId]
              return updated
            })
          }}
          onUserChange={(userId, level) => {
            setDraft((current) => afterAccessChange(current, userId, level, creator))
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
   lead and receives any team or user permissions through the access controls.
   A creator who is not an org admin and hands it to another lead keeps User
   access through the parent, and the footer says who will manage it. */
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
      footerLeft={
        // the creator leads the parent, so they always see the sub-project
        <CreatorNote
          note={creatorNote({
            creator: { id: P.CURRENT_USER, admin: P.isAdmin() },
            lead,
            sees: true,
          })}
          lead={lead}
        />
      }
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
  // when the window last asked again: the click right after (a double click,
  // a repeated Enter) must not apply to lists nobody has read yet
  const askedAt = useRefM(0)
  if (!items.length) return null
  const names = people.map((id) => P.user(id)?.name || 'Someone')
  // one row per role, but a task held twice counts once
  const count = new Set(items.map((i) => i.task.id)).size
  const tasks = `${count} task${count === 1 ? '' : 's'}`
  // "the task" and "this task" read better than "the 1 task"
  const theTasks = count === 1 ? 'the task' : `the ${tasks}`
  const these = count === 1 ? 'this task' : 'these tasks'
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
      if (!left || (!left.items.length && !P.removalPending(change))) return onClose()
      setSaving(false)
      // a refused removal whose tasks are now covered keeps its list, to retry
      if (left.items.length) setView(left)
    })
  }
  const submit = () => {
    if (saving || Date.now() - askedAt.current < 1000) return
    const now = read()
    // a task that moved, or a grant that now lands elsewhere, asks again
    const key = (list: Holder[], where: string[]) =>
      `${list
        .map((i) => `${i.task.id}:${i.task.project}:${i.role}:${i.uid}`)
        .sort()
        .join()}|${where.join()}`
    const lost = !keep && to !== NOBODY && !now.choices.some((u) => u.id === to)
    if (lost || key(now.items, now.projects) !== key(items, projects)) {
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
      askedAt.current = Date.now()
      setView(now)
      setChanged(true)
      if (!now.choices.some((u) => u.id === to)) setTo(NOBODY)
      return
    }
    finish(
      P.removeAccess(change, keep ? { keep: true } : { to: to === NOBODY ? null : to }, now.items),
    )
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

/* ---------- Archive or delete ----------
   One window for the two ways work leaves the board. Archive puts it away
   where its editors can restore it, and Delete moves it to Deleted items. The
   two choices are radio cards; the arrow keys move between them, and the
   reason typed under them survives a switch. What either choice takes along
   (subtasks, sub-projects) is listed above the cards. */

// one step per level of subtasks, as literal classes for Tailwind
const INDENT = ['', 'ml-4', 'ml-8', 'ml-12', 'ml-16']

type Fate = 'archive' | 'delete'

/** One of the window's two radio cards. `extra` sits below the card's label,
    outside it, so a control there never switches cards. */
function FateCard({
  name,
  checked,
  onSelect,
  title,
  danger = false,
  autoFocus = false,
  extra,
  children,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  title: string
  danger?: boolean
  /** the selected card when the window opens takes the first focus */
  autoFocus?: boolean
  extra?: ReactNodeM
  children: ReactNodeM
}) {
  return (
    <div
      data-fate-card={title.toLowerCase()}
      className={cn(
        'flex flex-col rounded-lg border p-3',
        !checked
          ? 'border-border'
          : danger
            ? '[border-color:var(--danger)] [background:var(--danger-soft)]'
            : '[border-color:var(--primary)] [background:var(--accent-soft)]',
      )}
    >
      <Label className="flex cursor-pointer items-start gap-2.5 font-normal">
        <Input
          type="radio"
          name={name}
          value={title.toLowerCase()}
          checked={checked}
          onChange={onSelect}
          data-autofocus={autoFocus ? '' : undefined}
          className={cn('mt-0.5', danger && 'accent-danger')}
        />
        <span className="flex flex-col gap-0.5">
          <span
            className={cn(
              'text-base font-semibold',
              danger && checked ? 'text-danger' : 'text-text-1',
            )}
          >
            {title}
          </span>
          <span className="text-sm text-text-2">{children}</span>
        </span>
      </Label>
      {extra && <div className="pl-[26px]">{extra}</div>}
    </div>
  )
}

/** The checkbox in a selected card that takes the subtasks along, with what
    happens to them when it is cleared. */
function SubtaskChoice({
  label,
  checked,
  onChange,
  danger = false,
}: {
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
  danger?: boolean
}) {
  return (
    <div className="mt-3">
      <Label className="flex w-fit cursor-pointer items-center gap-2 font-normal text-text-1">
        <Checkbox
          data-subtask-choice
          checked={checked}
          onCheckedChange={(value) => onChange(value === true)}
          className={cn(
            danger &&
              'data-[state=checked]:border-danger data-[state=checked]:bg-danger dark:data-[state=checked]:bg-danger',
          )}
        />
        {label}
      </Label>
      {!checked && (
        <p className="mt-1 pl-6 text-sm leading-normal text-text-2">
          They stay in their projects. Those directly under it become{' '}
          <span className="whitespace-nowrap">top-level tasks.</span>
        </p>
      )}
    </div>
  )
}

/** The window's lead sentence, in the style every line above the cards uses. */
function FateLead({ children, ...rest }: ComponentPropsM<'p'>) {
  return (
    <p {...rest} className="mb-3 text-base leading-normal text-text-2">
      {children}
    </p>
  )
}

/** A list above the cards: its heading and its rows in a scrolling box. */
function FateList({
  heading,
  going,
  children,
  ...rest
}: { heading: string; going: boolean } & ComponentPropsM<'div'>) {
  return (
    <div {...rest} className="mb-3">
      <div
        className={cn(
          'mb-2 text-sm leading-[1.45] font-semibold',
          going ? 'text-danger' : 'text-text-1',
        )}
      >
        {heading}
      </div>
      <div className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-1">
        {children}
      </div>
    </div>
  )
}

const fateRow = 'flex items-baseline gap-2 px-2.5 py-[5px] text-sm leading-[1.4]'

/** The reason field under the cards. Archive's is a comment on the task and
    is required, since the field shows for an archive only when work is
    unfinished. Delete's is optional and shown in Deleted items. The field
    tells assistive technology both, and its hint. */
function FateReason({
  archiving,
  value,
  onChange,
}: {
  archiving: boolean
  value: string
  onChange: (value: string) => void
}) {
  const hint = useIdM()
  return (
    <MField data-fate-reason-field label={archiving ? 'Reason (required)' : 'Reason (optional)'}>
      <Textarea
        data-fate-reason
        aria-label={archiving ? 'Reason for archiving' : 'Reason for deleting'}
        aria-required={archiving}
        aria-describedby={hint}
        rows={archiving ? 3 : 2}
        maxLength={TEXT_MAX}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          ctlClass,
          'h-auto resize-y px-2.5 py-2 leading-normal',
          archiving ? 'min-h-[72px]' : 'min-h-[56px]',
        )}
      />
      <p id={hint} className="mt-2 text-sm text-text-2">
        {archiving ? "Saved to the task's comments." : 'Shown in Deleted items.'}
      </p>
    </MField>
  )
}

const plural = (n: number, noun: string) =>
  `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`

/** A subtask the window lists for an archive. `editable` is whether I can
    change it, which the archive needs for every subtask it takes along. */
type ArchiveRow = { task: IssueVM; depth: number; editable: boolean }

/* What archiving a task takes along: its whole visible subtree in tree
   order, and whether a task in it has subtasks in projects I cannot see. */
function archivePlan(id: string): { rows: ArchiveRow[]; hidden: boolean } {
  const root = P.issueById[id]
  const rows: ArchiveRow[] = []
  if (!root) return { rows, hidden: false }
  let hidden = root.hasHiddenSubtasks
  const seen = new Set([root.id])
  const walk = (it: IssueVM, depth: number) => {
    for (const key of it.children) {
      const child = P.issueById[key]
      if (!child || seen.has(key)) continue
      seen.add(key)
      rows.push({ task: child, depth, editable: P.canWrite(child.project) })
      hidden ||= child.hasHiddenSubtasks
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return { rows, hidden }
}

type TaskPlans = {
  archive: ReturnType<typeof archivePlan>
  delete: ReturnType<typeof P.deletePlan>
}
const readPlans = (id: string): TaskPlans => ({
  archive: archivePlan(id),
  delete: P.deletePlan(id),
})
/* What a choice depends on, to tell whether it changed since the person read it. */
const planKey = (plans: TaskPlans, fate: Fate) =>
  fate === 'archive'
    ? `${plans.archive.rows.map((r) => `${r.task.id}:${r.task.project}:${r.depth}:${r.editable}`).join()}|${plans.archive.hidden}`
    : `${plans.delete.rows.map((r) => `${r.task.id}:${r.task.project}:${r.depth}:${r.deletable}`).join()}|${plans.delete.hidden}`

/* ---------- Archive or delete a task ----------
   Opened from the task menu by people who can edit the task, for every task.
   Archive takes it off the board with its whole subtree, or alone when the
   subtasks are kept, which become top-level tasks. A subtree with a subtask
   in a project I can't edit can't be archived, so Archive waits for the
   subtasks to be kept. Unfinished work needs a reason, saved as a comment.
   Delete moves it to Deleted items, with the subtasks I can delete unless
   they are kept; a subtask I can't delete, or can't see, stays and becomes a
   top-level task. The lists are taken when the window opens; if the chosen
   one changed by the click, the window shows the new lists and asks again,
   ignoring clicks for a second, so what leaves is what the person read. Both
   actions wait for the server, the window refuses to close meanwhile, and a
   refusal leaves it open on the lists as they are now. */
function ArchiveOrDeleteTaskModal({
  issueId,
  onClose,
  onArchive,
  onDelete,
  focusAfterClose,
}: {
  issueId: string
  onClose: () => void
  /** archive the task, alone when `keepSubtasks`; resolves whether the server
      archived it, and the caller closes the window when it did */
  onArchive: (reason: string, keepSubtasks: boolean) => Promise<boolean>
  /** delete the task and these subtasks (handles); resolves like onArchive */
  onDelete: (subtasks: string[], reason: string) => Promise<boolean>
  focusAfterClose?: () => HTMLElement | null
}) {
  const [plans, setPlans] = useStateM(() => readPlans(issueId))
  const [fate, setFate] = useStateM<Fate>('archive')
  const [reason, setReason] = useStateM('')
  const [archiveAll, setArchiveAll] = useStateM(true)
  const [deleteAll, setDeleteAll] = useStateM(plans.delete.deletable.length > 0)
  const [changed, setChanged] = useStateM(false)
  const [saving, setSaving] = useStateM(false)
  // when the window last asked again: the click right after (a double click,
  // a repeated Enter) must not act on lists nobody has read yet
  const askedAt = useRefM(0)
  const it = P.issueById[issueId]
  if (!it) return null
  const archiving = fate === 'archive'
  const { rows, hidden } = plans.archive
  const plan = plans.delete
  const hasSubtasks = rows.length > 0 || hidden
  const n = plan.deletable.length
  // the statuses as they are now; the rows are what the window opened with
  const live = (task: IssueVM) => P.issueById[task.id] ?? task
  const unfinishedRows = rows.filter((r) => !P.isDone(live(r.task))).length
  const readOnly = rows.some((r) => !r.editable)
  const withSubtasks = archiving ? archiveAll && hasSubtasks : deleteAll && n > 0
  // Archiving takes unfinished work off the board when the task itself is
  // unfinished and its subtasks are kept (it is a task of its own then), or
  // when anything in its whole subtree is.
  const unfinished = archiving && (withSubtasks ? !P.isDone(it) : it.status !== 'done')
  const showReason = !archiving || unfinished
  const archiveBlocked = archiving && withSubtasks && readOnly
  const canSubmit =
    !saving && (!archiving || (!archiveBlocked && (!unfinished || reason.trim().length > 0)))
  const viewOnly = plan.rows.some((r) => !r.deletable)
  const suffix = !withSubtasks
    ? ''
    : archiving
      ? readOnly
        ? "At least one is in a project you can't edit. Keep the subtasks, or ask an organization admin."
        : hidden
          ? "If any of them is in a project you can't edit, the archive is refused."
          : ''
      : viewOnly && plan.hidden
        ? "Subtasks marked View only, and any you can't open, aren't deleted. They stay and become top-level tasks."
        : viewOnly
          ? "Subtasks marked View only aren't deleted. They stay and become top-level tasks."
          : plan.hidden
            ? "Subtasks you can't open aren't deleted. They stay and become top-level tasks."
            : ''
  const status = P.statusOf(it.status)
  const count = (k: number) => (k ? plural(k, 'subtask') : 'its subtasks')
  // ask again with the lists as they are now
  const reask = (now: TaskPlans) => {
    askedAt.current = Date.now()
    setPlans(now)
    setChanged(true)
    if (!now.delete.deletable.length) setDeleteAll(false)
  }
  const finish = (sent: Promise<boolean>) => {
    setSaving(true)
    void sent.then((done) => {
      if (done) return // the caller closes the window
      setSaving(false)
      const now = readPlans(issueId)
      if (planKey(now, fate) !== planKey(plans, fate)) reask(now)
    })
  }
  const submit = () => {
    if (!canSubmit || Date.now() - askedAt.current < 1000) return
    const now = readPlans(issueId)
    const gone = archiving
      ? !now.archive.rows.length && !now.archive.hidden
      : !now.delete.rows.length && !now.delete.hidden
    // nothing under it any more: the task alone goes, as the person confirmed
    if (!gone && planKey(now, fate) !== planKey(plans, fate)) return reask(now)
    if (archiving) finish(onArchive(unfinished ? reason.trim() : '', !gone && !withSubtasks))
    else
      finish(onDelete(withSubtasks && !gone ? plan.deletable.map((t) => t.id) : [], reason.trim()))
  }
  // the list shows what the selected card does to the subtasks
  const listed = archiving ? rows.length > 0 || hidden : plan.rows.length > 0 || plan.hidden
  const heading = archiving
    ? withSubtasks
      ? `Also archives ${count(rows.length)}:`
      : `Keeps ${count(rows.length)}:`
    : withSubtasks
      ? `Also deletes ${plural(n, 'subtask')}:`
      : `Keeps ${count(plan.rows.length)}:`
  const listRows: { task: IssueVM; depth: number; editable: boolean }[] = archiving
    ? rows
    : plan.rows.map((r) => ({ task: r.task, depth: r.depth, editable: r.deletable }))
  return (
    <ModalShell
      icon="inbox"
      title="Archive or delete task"
      badge={it.key}
      onClose={saving ? () => false : onClose}
      onSubmit={submit}
      canSubmit={canSubmit}
      dangerSubmit={!archiving}
      focusAfterClose={focusAfterClose}
      submitLabel={
        archiving
          ? saving
            ? 'Archiving…'
            : 'Archive'
          : saving
            ? 'Deleting…'
            : withSubtasks
              ? `Delete ${n + 1} tasks`
              : `Delete ${it.key}`
      }
      width={540}
    >
      <div data-task-fate>
        <FateLead data-fate-lead>
          <b className="text-text-1">{it.key}</b>
          {rows.length ? (
            <>
              {' '}
              has {plural(rows.length, 'subtask')}
              {rows.length === 1
                ? unfinishedRows
                  ? ', which is unfinished.'
                  : ', which is done.'
                : unfinishedRows
                  ? `, ${unfinishedRows} of them unfinished.`
                  : ', all of them done.'}
            </>
          ) : hidden ? (
            " has subtasks in projects you can't open."
          ) : (
            <>
              {' '}
              is <b className="text-text-1">{status ? status.name : it.status}</b>.
            </>
          )}
          {suffix && ` ${suffix}`}
        </FateLead>
        {changed && (
          <p className="mb-3 text-sm text-danger">
            The subtasks changed while this window was open. Check them and choose again.
          </p>
        )}
        {listed && (
          <FateList data-fate-subtasks heading={heading} going={withSubtasks}>
            {listRows.map((r) => {
              const task = live(r.task)
              const st = P.statusOf(task.status)
              const going = withSubtasks && r.editable
              return (
                <div key={r.task.id} data-fate-subtask={r.task.key} className={fateRow}>
                  <span
                    className={cn(
                      'shrink-0 font-semibold text-text-3',
                      INDENT[Math.min(r.depth, INDENT.length - 1)],
                    )}
                  >
                    {r.task.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-1">{task.title}</span>
                  {!r.editable ? (
                    <span className="shrink-0 font-medium text-text-1">View only</span>
                  ) : (
                    !P.isGroup(task) && (
                      <span
                        className={cn(
                          'shrink-0',
                          going && task.status !== 'done' ? 'text-danger' : 'text-text-3',
                        )}
                      >
                        {st ? st.name : task.status}
                      </span>
                    )
                  )}
                </div>
              )
            })}
            {(archiving ? hidden : plan.hidden) && (
              <div className={cn(fateRow, 'text-text-2')}>
                {listRows.length ? 'More subtasks' : 'Subtasks'} in projects you can't open
              </div>
            )}
          </FateList>
        )}
        <div
          role="radiogroup"
          aria-label="Archive or delete"
          className={cn('mt-5 flex flex-col gap-3', showReason && 'mb-6')}
        >
          <FateCard
            name="task-fate"
            title="Archive"
            checked={archiving}
            autoFocus
            onSelect={() => setFate('archive')}
            extra={
              archiving &&
              hasSubtasks && (
                <SubtaskChoice
                  label={`Also archive ${rows.length === 1 ? 'the subtask' : rows.length ? `the ${rows.length} subtasks` : 'its subtasks'}`}
                  checked={archiveAll}
                  onChange={setArchiveAll}
                />
              )
            }
          >
            Takes it off the board. Anyone who can edit the project can restore it from{' '}
            <span className="whitespace-nowrap">Archived tasks.</span>
          </FateCard>
          <FateCard
            name="task-fate"
            title="Delete"
            danger
            checked={!archiving}
            onSelect={() => setFate('delete')}
            extra={
              !archiving &&
              (n > 0 ? (
                <SubtaskChoice
                  danger
                  label={n === 1 ? 'Also delete the subtask' : `Also delete the ${n} subtasks`}
                  checked={deleteAll}
                  onChange={setDeleteAll}
                />
              ) : (
                (plan.rows.length > 0 || plan.hidden) && (
                  <p className="mt-2 text-sm leading-normal text-text-2">
                    You can't delete its subtasks, so they stay in their projects and become
                    top-level tasks.
                  </p>
                )
              ))
            }
          >
            Moves it to Deleted items with its comments, attachments and links. You can restore it
            from there.
          </FateCard>
        </div>
        {showReason && <FateReason archiving={archiving} value={reason} onChange={setReason} />}
      </div>
    </ModalShell>
  )
}

/* ---------- Archive or delete a project ----------
   Opened by the project's lead from its settings page, or from Archived
   projects with only the delete part (`deleteOnly`, titled Delete “name”?).
   The counts come from the server when the window opens, archived work
   included, because the store holds no archived tasks; until they arrive
   both actions wait, and a failed count offers to try again. Archive acts at
   once (the caller closes the window). Delete waits for the server, the
   window refuses to close meanwhile, and a refusal leaves it open. */
function ArchiveOrDeleteProjectModal({
  project,
  deleteOnly = false,
  onClose,
  onArchive,
  onDelete,
  focusAfterClose,
}: {
  project: Pick<ProjectVM, 'id' | 'name' | 'type'>
  deleteOnly?: boolean
  onClose: () => void
  onArchive?: () => void
  /** resolves whether the server deleted it; the caller closes the window */
  onDelete: (reason: string) => Promise<boolean>
  focusAfterClose?: () => HTMLElement | null
}) {
  // undefined while counting, null when the count failed
  const [summary, setSummary] = useStateM<ProjectRemovalSummary | null | undefined>(undefined)
  const [attempt, setAttempt] = useStateM(0)
  const [fate, setFate] = useStateM<Fate>(deleteOnly ? 'delete' : 'archive')
  const [reason, setReason] = useStateM('')
  const [saving, setSaving] = useStateM(false)
  useEffectM(() => {
    let current = true
    setSummary(undefined)
    void P.projectRemovalSummary(project.id).then((answer) => {
      if (current) setSummary(answer)
    })
    return () => {
      current = false
    }
    // a new attempt, from Try again, asks once more
  }, [project.id, attempt])
  const archiving = fate === 'archive'
  const noun = project.type === 'meta' ? 'project' : 'sub-project'
  const subs = summary?.sub_projects ?? []
  const tasks = summary
    ? summary.more
      ? `more than ${plural(summary.tasks, 'task')}`
      : plural(summary.tasks, 'task')
    : ''
  const anyTasks = !!summary && (summary.tasks > 0 || summary.more)
  const deleteText = !summary
    ? `Moves the ${noun} and everything in it to Deleted items. You can restore it from there.`
    : subs.length
      ? anyTasks
        ? `Moves the ${noun}, its sub-projects and ${summary.more ? 'their tasks' : `all ${tasks}`} to Deleted items. You can restore them from there.`
        : `Moves the ${noun} and its sub-projects to Deleted items. You can restore them from there.`
      : anyTasks
        ? `Moves the ${noun} and ${summary.tasks === 1 && !summary.more ? 'its task' : summary.more ? 'its tasks' : `all ${tasks}`} to Deleted items. You can restore them from there.`
        : `Moves the ${noun} to Deleted items. You can restore it from there.`
  const listed = archiving ? subs.filter((s) => !s.archived) : subs
  const submit = () => {
    if (!summary || saving) return
    if (archiving) {
      onArchive?.()
      return
    }
    setSaving(true)
    void onDelete(reason.trim()).then((done) => {
      if (!done) setSaving(false) // the caller closes the window when it did
    })
  }
  return (
    <ModalShell
      icon={deleteOnly ? 'warning' : 'archive'}
      title={deleteOnly ? `Delete “${P.projectLabel(project)}”?` : `Archive or delete ${noun}`}
      onClose={saving ? () => false : onClose}
      onSubmit={submit}
      canSubmit={!!summary && !saving}
      dangerSubmit={!archiving}
      focusAfterClose={focusAfterClose}
      submitLabel={
        archiving
          ? 'Archive'
          : saving
            ? 'Deleting…'
            : anyTasks
              ? `Delete ${noun} and ${tasks}`
              : `Delete ${noun}`
      }
      width={540}
    >
      <div data-project-fate>
        {summary === undefined ? (
          <FateLead role="status">Counting tasks…</FateLead>
        ) : summary === null ? (
          <div role="alert" className="mb-3 flex items-center gap-3">
            <p className="text-base leading-normal text-text-2">Couldn't count the tasks.</p>
            <Button type="button" size="sm" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <FateLead data-fate-lead>
            <b className="text-text-1">{P.projectLabel(project)}</b> has{' '}
            {subs.length ? `${plural(subs.length, 'sub-project')} and ` : ''}
            {anyTasks ? tasks : 'no tasks'}
            {summary.archived_tasks
              ? `, including ${plural(summary.archived_tasks, 'archived task')}`
              : ''}
            .
          </FateLead>
        )}
        {listed.length > 0 && (
          <FateList
            data-fate-subprojects
            heading={`Also ${archiving ? 'archives' : 'deletes'} ${plural(listed.length, 'sub-project')}:`}
            going={false}
          >
            {listed.map((s) => (
              <div key={s.id} data-fate-subproject={s.id} className={fateRow}>
                <Icon name="layers" size={14} className="self-center text-text-3" />
                <span className="min-w-0 flex-1 truncate text-text-1">{s.name}</span>
                {s.archived && <span className="shrink-0 text-text-3">Archived</span>}
                <span className="shrink-0 text-text-2">
                  {/* a count that stopped before this sub-project read none of it */}
                  {s.more
                    ? s.tasks === 0
                      ? 'Not counted'
                      : `more than ${plural(s.tasks, 'task')}`
                    : plural(s.tasks, 'task')}
                </span>
              </div>
            ))}
          </FateList>
        )}
        {deleteOnly ? (
          <p className="mt-2 mb-6 text-base leading-normal text-text-2">{deleteText}</p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Archive or delete"
            className={cn('mt-5 flex flex-col gap-3', !archiving && 'mb-6')}
          >
            <FateCard
              name="project-fate"
              title="Archive"
              checked={archiving}
              autoFocus
              onSelect={() => setFate('archive')}
            >
              Hides it and its tasks from every view. You can restore it from{' '}
              <span className="whitespace-nowrap">Archived projects.</span>
            </FateCard>
            <FateCard
              name="project-fate"
              title="Delete"
              danger
              checked={!archiving}
              onSelect={() => setFate('delete')}
            >
              {deleteText}
            </FateCard>
          </div>
        )}
        {!archiving && <FateReason archiving={false} value={reason} onChange={setReason} />}
      </div>
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
                maxLength={NAME_MAX}
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
  // Two-click arm-then-confirm with the app-wide timing (lib/useConfirmArm).
  const deletion = useConfirmArm<'delete'>()
  const armDel = deletion.armed !== null
  const remove = () =>
    deletion.press('delete', () => {
      P.removeMilestone(m.id)
      window.showToast?.('Milestone removed')
      onClose()
    })
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
          maxLength={NAME_MAX}
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
          maxLength={NAME_MAX}
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
  ArchiveOrDeleteProjectModal,
  ArchiveOrDeleteTaskModal,
  CreateOrgModal,
  fmtSize,
  MField,
  MilestoneModal,
  ModalShell,
  MoveIssueModal,
  NewIssueModal,
  NewProjectModal,
  NewSubProjectModal,
  useWindowDropGuard,
}
