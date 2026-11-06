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
import { hasTooltip } from '@/lib/passEscapeOn'
import { cn } from '@/lib/utils'
import { grouped, LIMITS } from '../../convex/lib/limits'
import { projectKeyBase, projectKeyCandidate } from '../../convex/lib/projectKeys'
import { issueKey } from '../../convex/lib/taskRefs'
import { LimitedInput, LimitedTextarea } from '../components/LimitedField'
import { ProjectAccessSelect } from '../components/ProjectAccessSelect'
import { Avatar, DateSelect, Icon, MenuItem, Popover } from '../components/qivo'
import { copyText } from '../lib/clipboard'
import { relativeWeek, weekToISO } from '../lib/dates'
import { closeOrAsk } from '../lib/discardQuestion'
import { limitSentence, overLimit, sentence } from '../lib/fieldLimits'
import { restoreFocus } from '../lib/focusVisibility'
import { isLandscapeRoadmapOpen } from '../lib/landscape'
import { UnsentScopeContext, useTypedUnsaved, useUnsaved, useUnsentScope } from '../lib/leaveGuard'
import {
  type AccessDraft,
  afterAccessChange,
  afterLeadChange,
  creatorNote,
  requestedAccess,
} from '../lib/newProjectAccess'
import { listEnd, usePagedList, useSettledSearch } from '../lib/pagedList'
import { useUpdateBlocker } from '../lib/updateSafety'
import { useConfirmArm } from '../lib/useConfirmArm'
import { useMobile, useMobileBackLayer } from '../lib/useMobile'
import { useViewVisibility } from '../lib/viewVisibility'
import { exactWeekForDate } from '../lib/weekDrafts'
import {
  type AccessRemoval,
  andList,
  type IssueVM,
  type MilestoneAnswer,
  type MilestoneRead,
  type MilestoneVM,
  type NewIssueInput,
  type NewProjectInput,
  P,
  type ProjectRemovalSummary,
  type ProjectVM,
  REMOVAL_UNCHECKED,
  type ReassignChoice,
  type ReassignChoices,
  type RemovalAnswer,
  type TaskFamily,
  type TeamAccessLevel,
  teamNoun,
} from '../store/planner'
import { useViewsNews } from '../views/useViewsNews'

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
  savesAsYouGo = false,
  busy = false,
  unsent = [],
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
  /** replaces the Cancel/submit pair; a function gets the shell's close, which
   * asks first while the dialog holds unsent text */
  footer?: ReactNodeM | ((close: () => void) => ReactNodeM)
  focusAfterClose?: () => HTMLElement | null
  /** ignore clicks outside the dialog, for content an accidental close would
   * lose for good (a secret shown once). Close, Escape and the footer still
   * close it */
  keepOnOutsideClick?: boolean
  /** for a dialog whose fields save on their own (Milestones). They hold
   * their own close-warning leases, so typing alone does not count as
   * unsaved until the dialog closes */
  savesAsYouGo?: boolean
  /** refuses every close without asking, for a dialog waiting for the
   * server; a phone keeps its Back step */
  busy?: boolean
  /** names of the text the dialog's own fields hold unsent, such as "title",
   * with false for a field that holds none. Fields in the children hold
   * their own leases (useUnsaved) */
  unsent?: readonly (string | false)[]
  children?: ReactNodeM
}) {
  // A create/edit dialog also holds non-text draft choices and staged files.
  // Keep its entire editing session intact until it is submitted or closed.
  useUpdateBlocker(true)
  // text typed into the dialog is lost if the page closes before it is sent.
  // Closing the dialog itself asks only about the fields' own leases, which
  // know when their text matches what is saved (DiscardPrompt).
  const unsaved = useTypedUnsaved(null)
  const typed = savesAsYouGo ? undefined : unsaved.typed
  const scope = useUnsentScope()
  const mobile = useMobile()
  // Cancel is the person's own choice to drop what they typed, for the one
  // close it starts; a dialog that refuses that close asks again later
  const cancelling = useRefM(false)
  // Every close asks first while a field holds unsent text. The answer comes
  // later, so this close stays open (a phone keeps its Back step) and
  // Discard closes through the layer again, past the then empty question.
  const closeLayer = useMobileBackLayer(
    true,
    (again) => {
      const cancelled = cancelling.current
      cancelling.current = false
      if (busy) return false
      if (cancelled || !scope.held().length) return onClose()
      closeOrAsk([scope], again)
      return false
    },
    mobile || isLandscapeRoadmapOpen(),
    busy,
  )
  const cancel = () => {
    cancelling.current = true
    closeLayer()
  }
  const returnFocusRef = useRefM<HTMLElement | null>(
    typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null),
  )
  return (
    <Dialog open onOpenChange={(open) => !open && closeLayer()}>
      {/* top-anchored 4vh from the browser edge (IssueDetail matches); the
          card grows with content and caps at 92vh so the 4vh margin also
          holds at the bottom before the body starts scrolling, both inside
          the floating notices' bands (lib/floatStack) */}
      {/* Dialogs and task windows share the theme's window material and
          backdrop (appearance.css), with borders and shadows separating them
          from the page beneath. */}
      <DialogContent
        data-modal-shell
        showCloseButton={false}
        aria-describedby={undefined}
        overlayClassName="z-[100]"
        className={cn(
          'top-[calc(4vh+var(--float-inset-top))] z-[101] flex max-h-[calc(92vh-var(--float-inset-y))] max-w-[94vw] translate-y-0 flex-col gap-0 overflow-hidden rounded-xl bg-background p-0 shadow-pop',
          danger && 'border-[color-mix(in_oklab,var(--danger)_45%,var(--border))]',
        )}
        style={{ width: mobile ? '100%' : width }}
        onInputCapture={typed}
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
        <div className="overflow-y-auto px-5 pt-6 pb-6">
          <UnsentScopeContext.Provider value={scope}>
            {unsent.map((what) => what && <HoldUnsent key={what} what={what} />)}
            {children}
          </UnsentScopeContext.Provider>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-5 pt-0 pb-5">
          {/* a custom footer replaces the Cancel/submit pair — for windows
              with no submit, such as Milestones with its Done button */}
          {footer !== undefined ? (
            typeof footer === 'function' ? (
              footer(closeLayer)
            ) : (
              footer
            )
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
              <Button type="button" variant="ghost" onClick={cancel} className="text-text-1">
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

/** Holds a lease on `what` while it is mounted, inside the dialog's scope. */
function HoldUnsent({ what }: { what: string }) {
  useUnsaved(true, what)
  return null
}

/* ---------- New issue ---------- */
function NewIssueModal({
  init = {},
  onClose,
  onCreate,
}: {
  init?: Partial<Pick<NewIssueInput, 'project' | 'status' | 'start' | 'end' | 'due'>>
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
    title.trim().length > 0 &&
    !overLimit(LIMITS.title, title)

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
    // Keep the initiating column and date context; the remaining details
    // are edited in the existing task window immediately after creation.
    // No parent is passed on: the Project select can leave a parent's
    // top-level project, and the server refuses a subtask outside it.
    created.current = onCreate({
      start: init.start,
      end: init.end,
      due: init.due,
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
      unsent={[!!title.trim() && 'title']}
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
        <LimitedInput
          limit={LIMITS.title}
          aria-label="Title"
          data-autofocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
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
      <LimitedInput
        limit={LIMITS.projectName}
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
  const canSave =
    name.trim().length > 0 &&
    !overLimit(LIMITS.projectName, name) &&
    !overLimit(LIMITS.projectDescription, desc) &&
    leadValid
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
      unsent={[!!name.trim() && 'name', !!desc.trim() && 'description']}
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
        <LimitedInput
          limit={LIMITS.projectDescription}
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
  focusAfterClose,
}: {
  init?: { parent?: string }
  onClose: () => void
  onCreate: (p: NewProjectInput, opts: { withStarter: boolean }) => void
  focusAfterClose?: () => HTMLElement | null
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
  const canSave =
    name.trim().length > 0 && !overLimit(LIMITS.projectName, name) && parentValid && leadValid

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
      focusAfterClose={focusAfterClose}
      unsent={[!!name.trim() && 'name']}
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

/** Why moving, archiving or deleting a task the workspace holds waits
    while tasks still load and no answer of its own serves its subtasks:
    each acts on subtasks and blockers that may be still to arrive. */
export const WAITS_FOR_TASKS = 'Available once every task has loaded'
/** Why a change to a task the task window shows from its own read waits
    while that read failed or runs again: Qivo cannot tell whether someone
    changed the task meanwhile. */
export const WAITS_FOR_CHECK = 'Available once Qivo can check this task for changes'
/** Why moving, archiving or deleting a task the window shows from its own
    read is off while that read holds no whole list of its subtasks. */
export const FAMILY_UNKNOWN = 'Not available while Qivo cannot read every subtask of this task'

/** Why a task's Move or Archive or delete window cannot act, with no
    family (P.familyOf). A task the workspace holds waits for every task,
    and one the window shows from its own read waits for that read to be
    current again (P.answerSaveWaits), else for its whole subtask list, as
    the task window's menu says (IssueDetail fateTip). */
const familyWait = (it: IssueVM) =>
  P.issueById[it.id] ? WAITS_FOR_TASKS : P.answerSaveWaits(it.id) ? WAITS_FOR_CHECK : FAMILY_UNKNOWN

/* ---------- Move issue ----------
   The task is the window's (`task`), the workspace's or one shown from
   its own read, else the workspace's task `issueId`. What the move takes
   along and who would lose access come from its family (P.familyOf),
   read on every render, so a family that turns unknown while the window
   is open, as when the task arrives in the workspace with every task
   while no answer serves its family, shows the reason and refuses the
   move. */
function MoveIssueModal({
  issueId,
  task,
  onClose,
  onMove,
  focusAfterClose,
}: {
  issueId: string
  task?: IssueVM
  onClose: () => void
  onMove: (target: string) => void
  focusAfterClose?: () => HTMLElement | null
}) {
  const it = task ?? P.issueById[issueId]
  const family = it ? P.familyOf(it) : null
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
  // A move to another top-level project carries the subtasks, archived ones
  // included. Archived tasks are not in this view, so the server answers
  // whether any would move to the chosen sub-project.
  const [asked, setAsked] = useStateM<{ target: string; carries: boolean } | null>(null)
  const crossing =
    !!it &&
    !!P.project(target) &&
    target !== it.project &&
    P.topLevelOf(target) !== P.topLevelOf(it.project)
  useEffectM(() => {
    if (!crossing || !it) return
    let live = true
    P.moveCarriesSubtasks(it, target).then((carries) => {
      if (live && carries !== null) setAsked({ target, carries })
    })
    return () => {
      live = false
    }
  }, [crossing, it?.uuid, target])
  if (!it) return null
  // targetValid: a concurrently deleted target vanishes from the options but
  // would linger in state — the blank select must not leave Move enabled
  const targetValid = groups.some((g) => g.subs.some((sp) => sp.id === target))
  const moving = targetValid && target !== it.project
  // whoever works on the task or its subtasks must keep access after the
  // move; the dialog names them (subtasks outside this view are left to the
  // server, whose refusal names no one)
  const blockers = moving && family ? P.moveBlockers(it, target, family) : []
  const canMove = !!target && moving && !!family && !blockers.length
  // a subtask stays in its parent's project, so a move to another project
  // leaves the parent and carries the subtasks along; the dialog says so
  const moved = moving && family ? P.moveFamily(it, target, family) : null
  const carries = !!moved?.carriesSubtasks || (asked?.target === target && asked.carries)
  const parentKey = it.parent ? (family?.byId[it.parent] ?? P.issueById[it.parent])?.key : undefined
  const notes = [
    !family && `${familyWait(it)}.`,
    moved?.leavesParent &&
      (parentKey
        ? `${it.key} will no longer be a subtask of ${parentKey}.`
        : `${it.key} will no longer be a subtask.`),
    moving && carries && 'Its subtasks move with it, archived ones included.',
  ].filter((note): note is string => !!note)
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
      {notes.length + blockers.length > 0 && (
        <div
          data-move-blockers
          className="[font-size:var(--fs-base)] [color:var(--text-2)] [line-height:1.5] [margin-top:12px] flex flex-col gap-2"
        >
          {notes.map((note) => (
            <p key={note} data-move-note>
              {note}
            </p>
          ))}
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
   Team settings. The press asks the server's preview first
   (useAccessRemoval, P.startRemoval), and the window shows that answer
   only: who loses sight, the tasks the caller may read (up to
   LIMITS.reassign.max, with a count of the rest and of those in projects
   the caller cannot see), and whether each choice passes the write's
   rules, never a task or a figure from the tasks the workspace holds.
   Keeping them as Viewers is selected first; reassigning hands every
   listed task to one person the server lists (ReassignPicker), or to
   nobody, and then removes the access. Removing someone whose grant is
   already Viewer leaves only the reassignment. A choice the server refuses
   is disabled with its sentence, and with both refused only Cancel acts.
   The window asks the server again before it saves, with the chosen
   person, so a choice applies only to the tasks the person read. If they
   or the chosen person's eligibility changed meanwhile, the window shows
   the new answer and asks again. It stays open, and keeps the settings
   behind it out of reach, until the server has accepted the removal. A
   check that fails or that the server cannot answer removes nothing and
   says so. If a write is refused the access stays and so does the window,
   with the answer the server gives then. If someone else removed the
   access meanwhile, it closes and says so. If the organization turns
   read-only for its admin meanwhile, the window closes and the removal goes
   ahead, leaving the tasks (P.removeLeavingTasks); a removal the read-only
   organization refuses closes it with the server's sentence. */

/* What the window compares before it saves: each listed holding, the
   people who lose sight (also of tasks it does not list, whom Keep as
   Viewer grants Viewer), the counts, the Keep targets and what the Keep
   text says each person can still change, and which choices the server
   offers and allows. */
const removalKey = (a: RemovalAnswer): string =>
  JSON.stringify([
    a.items.map((i) => `${i.task_id}:${i.project_id}:${i.role}:${i.holder_id}`).sort(),
    a.people.map((p) => p.id).sort(),
    a.tasks,
    a.hidden,
    a.items_total,
    a.keep.targets,
    a.keep.changers.map((c) => `${c.id}:${c.projects.join(',')}:${c.more}`).sort(),
    a.keep.offered,
    a.keep.allowed,
    a.reassign.allowed,
  ])

/** The person Reassign hands the tasks to, as the picker named them, null
    for Unassigned. */
type Taker = { id: string; name: string } | null

function AccessRemovalModal({
  change,
  answer,
  onClose,
  focusAfterClose,
}: {
  change: AccessRemoval
  /** the server's preview that opened the window (P.startRemoval) */
  answer: RemovalAnswer
  onClose: () => void
  /** what takes focus as the window closes, as the removal takes the row
      of the button that opened it away before the server accepts it */
  focusAfterClose?: () => HTMLElement | null
}) {
  const [shown, setShown] = useStateM(answer)
  const [changed, setChanged] = useStateM(false)
  const [saving, setSaving] = useStateM(false)
  const keepOk = shown.keep.offered && shown.keep.allowed
  const reassignOk = shown.reassign.allowed
  const [keep, setKeep] = useStateM(answer.keep.offered && answer.keep.allowed)
  const [to, setTo] = useStateM<Taker>(null)
  // the name of the chosen person the server said can no longer take the
  // tasks, until a new choice in the picker
  const [dropped, setDropped] = useStateM<string | null>(null)
  // when the window last asked again: the click right after (a double click,
  // a repeated Enter) must not apply to an answer nobody has read yet
  const askedAt = useRefM(0)
  // answers that arrive after the window closed do nothing
  const open = useRefM(true)
  useEffectM(() => {
    open.current = true
    return () => {
      open.current = false
    }
  }, [])
  const names = shown.people.map((p) => p.name || 'Someone')
  const count = shown.tasks
  const tasks = `${count} task${count === 1 ? '' : 's'}`
  // "the task" and "this task" read better than "the 1 task"
  const theTasks = count === 1 ? 'the task' : `the ${tasks}`
  const team = 'teamId' in change ? P.teams.find((t) => t.id === change.teamId) : null
  const teamName = `the ${teamNoun(team?.name)}`
  const person =
    'userId' in change
      ? shown.people.find((p) => p.id === change.userId)?.name ||
        P.user(change.userId)?.name ||
        'Someone'
      : ''
  const refs = new Map(shown.projects.map((p) => [p.id, p]))
  const places = shown.keep.targets.flatMap((id) => refs.get(id) ?? [])
  const placesShown = places.length > 3 ? places.slice(0, 2) : places
  const more = places.length - placesShown.length
  const deleting = change.kind === 'deleteTeam'
  // the distinct tasks listed, the rest the caller may read, and those in
  // projects the caller cannot see, which the list never names
  const listed = new Set(shown.items.map((i) => i.task_id)).size
  const unlisted = count - shown.hidden - listed
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
        ? `Keep as Viewer${shown.people.length === 1 ? '' : 's'} and delete`
        : 'Change to Viewer'
  // Reassign waits for a new choice once the chosen person was dropped
  const choosing = keep ? keepOk : reassignOk && dropped === null
  // what the window shows after a refused write or a changed answer, with
  // the choice moved to the other one when the new answer refuses it
  const showAgain = (next: RemovalAnswer, eligible: boolean) => {
    askedAt.current = Date.now()
    setShown(next)
    setChanged(true)
    if (!eligible) {
      setDropped(to?.name || 'Someone')
      setTo(null)
    }
    const nextKeep = next.keep.offered && next.keep.allowed
    setKeep((chosen) =>
      chosen ? nextKeep || !next.reassign.allowed : !next.reassign.allowed && nextKeep,
    )
  }
  /* After a refused write, the window asks the server again: an answer it
     cannot read keeps the window with its lists, a refusal closes it, as the
     write's own message already said why, and a read-only organization
     hands over to the removal that leaves the tasks. */
  const finish = (removal: Promise<boolean>) => {
    setSaving(true)
    void removal.then(async (removed) => {
      if (removed) return onClose()
      const now = await P.previewRemoval(change)
      if (!open.current) return
      setSaving(false)
      if (now === null || now.state === 'too_large') return
      if (now.state === 'refused') return onClose()
      if (now.state === 'unavailable' || !now.pending) return onClose()
      if (now.leave_only) {
        onClose()
        void P.removeLeavingTasks(change, now)
        return
      }
      // a refused removal whose tasks are now covered keeps its answer, so
      // a retry checks again and takes the plain removal
      if (now.tasks > 0) showAgain(now, true)
    })
  }
  const submit = () => {
    if (saving || !choosing || Date.now() - askedAt.current < 1000) return
    if (P.refusePausedEdit()) return
    const taker = !keep && to !== null ? to.id : undefined
    setSaving(true)
    void P.previewRemoval(change, taker).then((now) => {
      if (!open.current) return
      if (now === null) {
        setSaving(false)
        window.showToast?.(REMOVAL_UNCHECKED, 'error')
        return
      }
      if (now.state === 'unavailable' || (now.state === 'ok' && !now.pending)) {
        // someone else removed this access meanwhile: say so instead of a silent close
        window.showToast?.(`${P.removalGoneText(change)} Nothing was changed.`, 'info')
        onClose()
        return
      }
      if (now.state === 'refused') {
        window.showToast?.(sentence(now.message), 'error')
        onClose()
        return
      }
      if (now.state === 'too_large') {
        // the check with a chosen person reads more than the press did, so
        // the person may still choose Unassigned or Keep as Viewer
        setSaving(false)
        window.showToast?.(sentence(now.message), 'error')
        return
      }
      if (now.leave_only) {
        onClose()
        void P.removeLeavingTasks(change, now)
        return
      }
      // nobody loses sight of anything any more, so the plain removal applies
      if (now.tasks === 0) {
        finish(P.removeAccess(change, { to: null }))
        return
      }
      const eligible = taker === undefined || now.reassign.holder_eligible === true
      if (!eligible || removalKey(now) !== removalKey(shown)) {
        setSaving(false)
        showAgain(now, eligible)
        return
      }
      finish(P.removeAccess(change, keep ? { keep: true } : { to: to?.id ?? null }, now))
    })
  }
  const option = (selected: boolean, enabled: boolean) =>
    cn(
      'flex flex-col rounded-lg border p-3',
      selected && enabled
        ? '[border-color:var(--primary)] [background:var(--accent-soft)]'
        : 'border-border',
      !enabled && 'opacity-70',
    )
  return (
    <ModalShell
      icon="warning"
      title={title}
      onClose={onClose}
      focusAfterClose={focusAfterClose}
      busy={saving}
      onSubmit={submit}
      canSubmit={!saving && choosing}
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
          {andList(names)} {names.length === 1 ? 'is' : 'are'} assigned to or reviewing {tasks}
          {placesShown.length > 0 && ' in '}
          {placesShown.map((p, i) => (
            <Fragment key={p.id}>
              {i > 0 && (i === placesShown.length - 1 && !more ? ' and ' : ', ')}
              <b className="text-text-1">{P.projectLabel(p)}</b>
            </Fragment>
          ))}
          {more > 0 && ` and ${more} other projects`}.
        </p>
        {/* a live region from the start, so a screen reader reads each
            notice as the window asks again; no gap of its own while empty */}
        <div role="status" data-access-removal-notice className="-mt-3">
          {changed && (
            <p className="mt-3 text-sm [color:var(--danger)]">
              Access or tasks changed while this window was open. Check them and choose again.
            </p>
          )}
          {dropped !== null && (
            <p className="mt-1 text-sm [color:var(--danger)]">
              {dropped} can no longer take {count === 1 ? 'the task' : 'these tasks'}. Choose
              someone else or Unassigned.
            </p>
          )}
        </div>
        <div className="max-h-48 overflow-auto rounded-lg border border-border">
          {shown.items.map((i) => {
            const holder = shown.people.find((p) => p.id === i.holder_id)
            return (
              <div
                key={`${i.task_id}:${i.role}:${i.holder_id}`}
                data-access-removal-task={i.task_id}
                className="flex items-center gap-2.5 border-t border-border px-3 py-2 text-sm first:border-t-0"
              >
                <span className="w-12 shrink-0 font-mono text-xs text-text-2">
                  {issueKey(i.num)}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-1">{i.title}</span>
                <span className="shrink-0 text-xs text-text-2">
                  {names.length > 1 ? `${(holder?.name || 'Someone').split(' ')[0]}, ` : ''}
                  {i.role === 'reviewer' ? 'Reviewer' : 'Assignee'}
                </span>
              </div>
            )
          })}
          {unlisted > 0 && (
            <div className="border-t border-border px-3 py-2 text-sm text-text-2 first:border-t-0">
              and {unlisted} more task{unlisted === 1 ? '' : 's'}
            </div>
          )}
          {shown.hidden > 0 && (
            <div
              data-access-removal-hidden
              className="border-t border-border px-3 py-2 text-sm text-text-2 first:border-t-0"
            >
              {shown.hidden} task{shown.hidden === 1 ? '' : 's'} in projects you can't see
            </div>
          )}
        </div>
        {shown.keep.offered && (
          <div className={option(keep, keepOk)} data-access-removal-keep>
            <Label
              className={cn(
                'flex items-start gap-2.5 font-normal',
                keepOk ? 'cursor-pointer' : 'cursor-default',
              )}
            >
              <Input
                type="radio"
                name="access-removal"
                checked={keep && keepOk}
                // as the picker, so the choice on screen stays the one saved
                disabled={!keepOk || saving}
                onChange={() => setKeep(true)}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-base font-semibold text-text-1">Keep as Viewer</span>
                <span className="text-sm text-text-2">
                  {keepOk
                    ? P.keepText(change, shown)
                    : sentence(shown.keep.refusal ?? 'Keeping them as Viewers is not possible.')}
                </span>
              </span>
            </Label>
          </div>
        )}
        <div className={option(!keep, reassignOk)} data-access-removal-reassign>
          <Label
            className={cn(
              'flex items-start gap-2.5 font-normal',
              reassignOk ? 'cursor-pointer' : 'cursor-default',
            )}
          >
            {shown.keep.offered && (
              <Input
                type="radio"
                name="access-removal"
                checked={!keep && reassignOk}
                disabled={!reassignOk || saving}
                onChange={() => setKeep(false)}
                className="mt-0.5"
              />
            )}
            <span className="flex flex-col gap-0.5">
              <span className="text-base font-semibold text-text-1">
                Reassign {theTasks}, then {deleting ? 'delete the team' : 'remove'}
              </span>
              <span className="text-sm text-text-2">
                {reassignOk
                  ? 'Reviewer roles move to the same person.'
                  : sentence(shown.reassign.refusal ?? 'Reassigning these tasks is not possible.')}
              </span>
            </span>
          </Label>
          {/* outside the label, so opening the picker never toggles the radio */}
          <div className={cn('mt-2 min-w-0', shown.keep.offered && 'ml-6.5')}>
            <ReassignPicker
              change={change}
              to={to}
              disabled={!reassignOk || saving}
              onPick={(taker) => {
                setTo(taker)
                setDropped(null)
                setKeep(false)
              }}
            />
          </div>
        </div>
      </div>
    </ModalShell>
  )
}

/** The most people the Reassign picker gathers with Load more, as API
    access's person filter does; past it a search narrows the list. */
const TAKERS_MOST = 500

/* The Reassign picker: a button naming Unassigned or the chosen person
   that opens a list read from the server a batch at a time
   (P.reassignChoices), as API access's person filter does. The chosen
   person stays named on the button through later searches, also when no
   loaded batch holds them, and the window checks them again before it
   saves. */
function ReassignPicker({
  change,
  to,
  disabled,
  onPick,
}: {
  change: AccessRemoval
  to: Taker
  disabled: boolean
  onPick: (taker: Taker) => void
}) {
  const label = to?.name ?? 'Unassigned'
  return (
    <Popover
      width={280}
      backLayer
      onEscapeKeyDown={(event) => {
        // Escape clears the search first (ReassignChoiceList), and closes
        // the list once the search is empty, never the window
        const field = event.target
        if (field instanceof HTMLInputElement && field.matches('[data-reassign-search]'))
          if (field.value !== '') event.preventDefault()
      }}
      wrapStyle={{ minWidth: 0 }}
      button={(toggle, open) => (
        <Button
          type="button"
          variant="outline"
          data-reassign-to={to?.id ?? ''}
          data-on={open ? '' : undefined}
          aria-label={`New assignee: ${label}`}
          disabled={disabled}
          onClick={toggle}
          // sized and drawn as the select it replaces (FieldSelect), taller
          // with the chosen person's avatar
          className="h-control max-w-full gap-2 bg-surface-1 px-2.5 text-base font-normal text-text-1 has-[[data-slot=avatar]]:h-auto has-[[data-slot=avatar]]:min-h-[46px] has-[[data-slot=avatar]]:py-2"
        >
          {to !== null && <Avatar id={to.id} size={28} />}
          <span className="min-w-0 truncate">{label}</span>
          <Icon name="chevronDown" size={14} color="var(--text-2)" />
        </Button>
      )}
    >
      {(close) => (
        <ReassignChoiceList
          change={change}
          to={to}
          onPick={(taker) => close(() => onPick(taker))}
        />
      )}
    </Popover>
  )
}

/* The open Reassign picker: Unassigned, a search, then the people the
   server lists in name order, matching the search once typing rests, with
   Load more. It reads its batches on demand through the shared paged list
   (lib/pagedList.ts), never live, and drops them when it closes. A batch
   the read budget stopped, that failed or that holds no row never reads as
   the end of the list, and one the server answered without rows, the
   first or a Load more, says why. */
function ReassignChoiceList({
  change,
  to,
  onPick,
}: {
  change: AccessRemoval
  to: Taker
  onPick: (taker: Taker) => void
}) {
  const [text, setText] = useStateM('')
  const { tooLong, settled: query } = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: `${JSON.stringify(change)}|${query}`,
    source: { kind: 'once', read: (at) => P.reassignChoices(change, query, at.after) },
    batch: (answer: ReassignChoices) => (answer.state === 'ready' ? answer : null),
    id: (person: ReassignChoice) => person.id,
    most: TAKERS_MOST,
  })
  const end = listEnd(list, query !== '')
  // the answer of a read that holds no rows says why: the first read's, or
  // a Load more's, after which Try again would only ask the same
  const held = end === 'held' ? list.answers[0] : (list.failure ?? undefined)
  const heldLine =
    held === undefined
      ? "People can't be listed yet."
      : held.state === 'not_ready'
        ? "People can't be listed yet."
        : held.state === 'refused' || held.state === 'too_large'
          ? sentence(held.message)
          : held.state === 'unavailable'
            ? 'This removal can no longer be checked.'
            : null
  return (
    <div data-reassign-people="" className="flex flex-col gap-1">
      <LimitedInput
        limit={LIMITS.search}
        aria-label="Search people"
        data-reassign-search=""
        placeholder="Search people"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Escape clears the search first; an empty field closes the list
          if (e.key === 'Escape' && text) {
            e.stopPropagation()
            setText('')
          }
        }}
        className="h-control text-sm"
      />
      <div className="max-h-[280px] overflow-y-auto">
        <MenuItem active={to === null} onClick={() => onPick(null)} data-reassign-choice="">
          Unassigned
        </MenuItem>
        {list.rows.map((person) => (
          <MenuItem
            key={person.id}
            active={to?.id === person.id}
            onClick={() => onPick({ id: person.id, name: person.name })}
            data-reassign-choice={person.id}
          >
            <Avatar id={person.id} size={20} />
            <span className="min-w-0 truncate">{person.name}</span>
            {person.kind === 'agent' && <span className="ml-auto text-xs text-text-2">agent</span>}
          </MenuItem>
        ))}
        {tooLong ? (
          <p className="px-2 py-1 text-sm text-text-2">{limitSentence(LIMITS.search)}</p>
        ) : end === 'loading' ? (
          <p role="status" className="px-2 py-1 text-sm text-text-2">
            Loading people…
          </p>
        ) : end === 'held' || (end === 'failed' && list.failure !== null) ? (
          <p role="status" data-reassign-held="" className="px-2 py-1 text-sm text-text-2">
            {heldLine}
          </p>
        ) : end === 'failed' ? (
          <div role="alert" className="flex items-center gap-2 px-2 py-1 text-sm text-danger">
            Couldn't load people.
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm text-sm"
              // a failed Load more keeps its place; a failed first batch
              // starts again
              onClick={() => list.retry()}
            >
              Try again
            </Button>
          </div>
        ) : end === 'full' ? (
          <p className="px-2 py-1 text-sm text-text-2">Search to narrow the list.</p>
        ) : end === 'more' ? (
          <>
            {list.stopped && (
              <p className="px-2 py-1 text-sm text-text-2">Showing the people found so far.</p>
            )}
            <MenuItem data-reassign-more="" disabled={list.phase === 'more'} onClick={list.more}>
              {list.phase === 'more' ? 'Loading…' : 'Load more'}
            </MenuItem>
          </>
        ) : end === 'none' ? (
          <p className="px-2 py-1 text-sm text-text-2">No one matches.</p>
        ) : null}
      </div>
    </div>
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

/** `sent`, with a rejection logged and read as a refusal. The callers run
    their own code after the store answers (closing the task window, a toast,
    a page change), and a window that waits on them must never stay saving
    because that code threw. */
const refusedOnThrow = (sent: Promise<boolean>) =>
  sent.catch((error: unknown) => {
    console.error('[qivo] archive or delete failed:', error)
    return false
  })

/** The reason field's limit. An archive's reason is saved as a comment on
    the task (LIMITS.archiveReason); a delete's is shown on its Deleted items
    row (LIMITS.deleteReason). A reason typed for one stays when the person
    switches to the other, and holds it while it is too long. */
const reasonLimit = (archiving: boolean) => (archiving ? LIMITS.archiveReason : LIMITS.deleteReason)
const reasonTooLong = (archiving: boolean, reason: string) =>
  overLimit(reasonLimit(archiving), reason)

/** The reason field under the cards. Archive's is a comment on the task and
    is required, since the field shows for an archive only when work is
    unfinished. Delete's is optional and shown in Deleted items. The hint
    names the limit, and a reason over it says so and holds the archive or
    delete rather than cut what was typed. The field tells assistive
    technology both, and its hint. */
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
  const limit = reasonLimit(archiving)
  const tooLong = reasonTooLong(archiving, value)
  return (
    <MField data-fate-reason-field label={archiving ? 'Reason (required)' : 'Reason (optional)'}>
      <LimitedTextarea
        limit={limit}
        data-fate-reason
        aria-label={archiving ? 'Reason for archiving' : 'Reason for deleting'}
        aria-required={archiving}
        aria-describedby={hint}
        rows={archiving ? 3 : 2}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          ctlClass,
          'h-auto resize-y px-2.5 py-2 leading-normal',
          archiving ? 'min-h-[72px]' : 'min-h-[56px]',
        )}
      />
      <p
        id={hint}
        className={cn('mt-2 text-sm', tooLong ? '[color:var(--danger)]' : 'text-text-2')}
      >
        {tooLong
          ? limitSentence(limit)
          : `${archiving ? "Saved to the task's comments." : 'Shown in Deleted items.'} At most ${grouped(limit.max)} characters.`}
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
   order from its family (P.familyOf), and whether a task in it has
   subtasks in projects I cannot see. */
function archivePlan(family: TaskFamily): { rows: ArchiveRow[]; hidden: boolean } {
  const root = family.root
  const rows: ArchiveRow[] = []
  let hidden = root.hasHiddenSubtasks
  const seen = new Set([root.id])
  const walk = (it: IssueVM, depth: number) => {
    for (const key of it.children) {
      const child = family.byId[key]
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
/* Both lists of a task from its family, or none while it is unknown. */
const readPlans = (family: TaskFamily | null): TaskPlans =>
  family
    ? { archive: archivePlan(family), delete: P.deletePlan(family.root.id, family) }
    : { archive: { rows: [], hidden: false }, delete: { rows: [], deletable: [], hidden: false } }
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
   refusal leaves it open on the lists as they are now. The task is the
   window's (`task`), the workspace's or one shown from its own read, else
   the workspace's task `issueId`, and its lists come from its family
   (P.familyOf): while that is unknown, also once the window is open, it
   says why and acts on nothing. */
function ArchiveOrDeleteTaskModal({
  issueId,
  task,
  onClose,
  onArchive,
  onDelete,
  onReasonChange,
  initialReason = '',
  focusAfterClose,
}: {
  issueId: string
  /** the task the window shows, the workspace's or one from its own read */
  task?: IssueVM
  onClose: () => void
  /** the reason the field starts with, such as one the task window kept */
  initialReason?: string
  /** hears each change of the reason, so the task window can keep it when
      the task leaves the board under the open window */
  onReasonChange?: (reason: string) => void
  /** archive the task, alone when `keepSubtasks`; resolves whether the server
      archived it, and the caller closes the window when it did */
  onArchive: (reason: string, keepSubtasks: boolean) => Promise<boolean>
  /** delete the task and these subtasks (handles); resolves like onArchive */
  onDelete: (subtasks: string[], reason: string) => Promise<boolean>
  focusAfterClose?: () => HTMLElement | null
}) {
  const it = task ?? P.issueById[issueId]
  const family = it ? P.familyOf(it) : null
  // the family as it is at a click, which a delivery since the last render
  // may have changed: the task as the window shows it now
  const familyNow = () => {
    const now = task ? (P.taskShown(task.id) ?? task) : P.issueById[issueId]
    return now ? P.familyOf(now) : null
  }
  const [plans, setPlans] = useStateM(() => readPlans(family))
  const [fate, setFate] = useStateM<Fate>('archive')
  const [reason, setTypedReason] = useStateM(initialReason)
  const setReason = (value: string) => {
    setTypedReason(value)
    onReasonChange?.(value)
  }
  const [archiveAll, setArchiveAll] = useStateM(true)
  const [deleteAll, setDeleteAll] = useStateM(plans.delete.deletable.length > 0)
  const [changed, setChanged] = useStateM(false)
  const [saving, setSaving] = useStateM(false)
  // when the window last asked again: the click right after (a double click,
  // a repeated Enter) must not act on lists nobody has read yet
  const askedAt = useRefM(0)
  if (!it) return null
  const archiving = fate === 'archive'
  const { rows, hidden } = plans.archive
  const plan = plans.delete
  const hasSubtasks = rows.length > 0 || hidden
  const n = plan.deletable.length
  // the statuses as they are now; the rows are what the window opened with
  const live = (row: IssueVM) => family?.byId[row.id] ?? P.issueById[row.id] ?? row
  const unfinishedRows = rows.filter((r) => !P.isDone(live(r.task))).length
  const readOnly = rows.some((r) => !r.editable)
  const withSubtasks = archiving ? archiveAll && hasSubtasks : deleteAll && n > 0
  // Archiving takes unfinished work off the board when the task itself is
  // unfinished and its subtasks are kept (it is a task of its own then), or
  // when anything in its whole subtree is.
  // a group's Done comes from its whole list (TaskFamily done)
  const unfinished = archiving && (withSubtasks ? !family?.done : it.status !== 'done')
  const showReason = !archiving || unfinished
  const archiveBlocked = archiving && withSubtasks && readOnly
  const canSubmit =
    !saving &&
    !!family &&
    (archiving
      ? !archiveBlocked &&
        (!unfinished || (reason.trim().length > 0 && !reasonTooLong(true, reason)))
      : !reasonTooLong(false, reason))
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
    void refusedOnThrow(sent).then((done) => {
      if (done) return // the caller closes the window
      setSaving(false)
      // the lists as they are now, also when the task is shown from its
      // own read, whose answer may have changed
      const now = readPlans(familyNow())
      if (planKey(now, fate) !== planKey(plans, fate)) reask(now)
    })
  }
  const submit = () => {
    if (!canSubmit || Date.now() - askedAt.current < 1000) return
    const current = familyNow()
    // the family went unknown since the render: nothing goes
    if (!current) return
    const now = readPlans(current)
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
      onClose={onClose}
      busy={saving}
      // a reason on its way to the server goes with the change
      unsent={[!saving && !!reason.trim() && 'reason']}
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
        {!family && (
          <p data-fate-family-unknown className="mb-3 text-sm text-text-2">
            {familyWait(it)}.
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
   window refuses to close meanwhile, and a refusal leaves it open. A project
   that left the board while the window was open (`gone`) is said to be gone
   once no delete of its own is on its way. The window then only says so and
   shows the reason typed in it with Copy reason, as a task window whose
   task left does (IssueDetail.tsx TaskGone). Nothing in it can be sent any
   more, so it has Close rather than Cancel, and every close asks first
   until the reason is copied. */
function ArchiveOrDeleteProjectModal({
  project,
  deleteOnly = false,
  gone = false,
  onClose,
  onArchive,
  onDelete,
  focusAfterClose,
}: {
  /** the project, with its organization when a page that read it from the
      server opened the window (projectSettings.get), so its counts read
      also for a project the workspace does not hold */
  project: Pick<ProjectVM, 'id' | 'name' | 'type'> & { orgId?: string }
  deleteOnly?: boolean
  /** whether the project left the board while the window was open */
  gone?: boolean
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
    const shown = project.orgId === undefined ? undefined : { orgId: project.orgId }
    void P.projectRemovalSummary(project.id, shown).then((answer) => {
      if (current) setSummary(answer)
    })
    return () => {
      current = false
    }
    // a new attempt, from Try again, asks once more
  }, [project.id, project.orgId, attempt])
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
  // the project went while nothing of this window's own was on its way
  const left = gone && !saving
  const reasonId = useIdM()
  // the text Copy reason put on the clipboard once the project left
  const [copied, setCopied] = useStateM<string | null>(null)
  // the field that had focus goes with the cards, so the notice takes it
  const goneRef = useRefM<HTMLDivElement>(null)
  useEffectM(() => {
    if (!left) return
    const active = document.activeElement
    if (!active || active === document.body) goneRef.current?.focus()
  }, [left])
  const submit = () => {
    if (!summary || saving || left || (!archiving && reasonTooLong(false, reason))) return
    if (archiving) {
      onArchive?.()
      return
    }
    setSaving(true)
    void refusedOnThrow(onDelete(reason.trim())).then((done) => {
      if (!done) setSaving(false) // the caller closes the window when it did
    })
  }
  return (
    <ModalShell
      icon={deleteOnly ? 'warning' : 'archive'}
      title={deleteOnly ? `Delete “${P.projectLabel(project)}”?` : `Archive or delete ${noun}`}
      onClose={onClose}
      busy={saving}
      unsent={[!saving && !!reason.trim() && !(left && copied === reason) && 'reason']}
      onSubmit={submit}
      canSubmit={!!summary && !saving && !left && (archiving || !reasonTooLong(false, reason))}
      dangerSubmit={!archiving}
      focusAfterClose={focusAfterClose}
      footer={
        left
          ? (close) => (
              <>
                <div className="flex-1" />
                <Button type="button" onClick={close} className="font-semibold">
                  Close
                </Button>
              </>
            )
          : undefined
      }
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
        {left ? (
          <div ref={goneRef} tabIndex={-1} className="outline-none">
            <FateLead
              role="status"
              data-fate-gone
              aria-describedby={reason.trim() ? reasonId : undefined}
            >
              <b className="text-text-1">{P.projectLabel(project)}</b> is no longer here. It was
              archived or deleted, or you can no longer open it.
              {reason.trim()
                ? ' The reason you typed for it was not used. Copy it to keep it.'
                : ''}
            </FateLead>
            {reason.trim() && <UnusedReason id={reasonId} reason={reason} onCopied={setCopied} />}
          </div>
        ) : summary === undefined ? (
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
        {!left && listed.length > 0 && (
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
        {left ? null : deleteOnly ? (
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
        {!left && !archiving && (
          <FateReason archiving={false} value={reason} onChange={setReason} />
        )}
      </div>
    </ModalShell>
  )
}

/** A reason that went unused because its project left, to copy. `onCopied`
    hears the text a copy put on the clipboard. A refused copy leaves it
    selected, to copy by hand. */
function UnusedReason({
  id,
  reason,
  onCopied,
}: {
  id: string
  reason: string
  onCopied: (reason: string) => void
}) {
  const box = useRefM<HTMLParagraphElement>(null)
  const copy = () => {
    void copyText(reason).then((ok) => {
      if (ok) {
        onCopied(reason)
        window.showToast?.('Copied the reason')
        return
      }
      if (box.current) window.getSelection()?.selectAllChildren(box.current)
      window.showToast?.("Couldn't copy. Copy the selected text instead.", 'error')
    })
  }
  return (
    <div data-fate-gone-reason className="flex flex-col items-start gap-2">
      {/* a long reason scrolls, so Copy reason stays in reach */}
      <p
        ref={box}
        id={id}
        className="max-h-[min(12rem,30dvh)] w-full overflow-y-auto rounded-md border border-border bg-surface-1 px-2.5 py-2 whitespace-pre-wrap break-words text-text-1 select-text"
      >
        {reason}
      </p>
      <Button type="button" variant="ghost" onClick={copy}>
        <Icon name="copy" size={16} />
        Copy reason
      </Button>
    </div>
  )
}

/* ---------- Milestones (list + create + edit, one window) ----------
   Deviation #239. The window IS the project's milestone list: the first row
   is the new milestone (name, week, Add), "On the roadmap" lists the
   project's milestones by week, and a row's Edit button opens it in place
   with Delete / Cancel / Save. Every action commits where it stands and the
   window stays open — the footer is only Done. `init.project` opens on the
   new row, `init.week` preselecting its week.

   `init.id` (a roadmap diamond, an Overview row, the phone agenda) opens
   on that milestone, which the window reads from the server
   (milestones.get, P.watchMilestones) while it and the tab show. Its
   answer alone fixes the window's project and says whether the person may
   change the milestone, so nothing but "Loading this milestone…" shows
   before it: no list, no add row, no editor. Then the milestone shows as
   its editor for someone who may write, else as its row, in its place in
   the list or above it, whatever the list holds. A milestone the server
   does not answer, for every reason alike, or refuses, says so with Done
   only; a failure offers Retry; and once it showed, an answer of null
   that the person's own delete did not cause closes its editor and says
   it is no longer here. A failure after an answer keeps that answer, and
   the editor its draft, under a note with Retry. While the tab hides or
   after a reconnect the window shows its last answer and its root is
   marked refreshing (aria-busy) until the answer is current again. */

/* The store's slot of the window's read of the milestone it opened on. */
const MILESTONE_OPEN = 'milestone:open'
/* How many Milestones windows mounted, each one's read owner
   (P.watchMilestones). */
let milestoneWindows = 0

/** The read of milestone `id` (milestones.get) the window registers with
    the store while it and the tab show, with Retry, or none without an id.
    The read goes when the window closes. Renders again on the store's
    `views` news (views/useViewsNews.ts). */
function useOpenedMilestone(id: string | undefined) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useStateM(0)
  // this mounted window, which owns the read while it asks
  const [owner] = useStateM(() => ++milestoneWindows)
  useViewsNews()
  useEffectM(() => {
    if (!id) return
    P.watchMilestones(MILESTONE_OPEN, visible ? { kind: 'get', id } : null, owner, attempt)
    return () => P.watchMilestones(MILESTONE_OPEN, null, owner, attempt)
  }, [id, visible, owner, attempt])
  useEffectM(() => {
    if (!id) return
    return () => P.releaseMilestones(MILESTONE_OPEN, owner)
  }, [id, owner])
  return {
    read: id ? P.milestoneRead(MILESTONE_OPEN) : null,
    retry: () => setAttempt((n) => n + 1),
  }
}

/** The answer a milestone read shows: its current or kept answer, also
    beside a failure or refusal, or null. */
function shownAnswer(read: MilestoneRead | null): MilestoneAnswer | null {
  if (!read) return null
  if (read.state === 'ok') return read.answer
  return read.state === 'failed' || read.state === 'refused' ? read.kept : null
}

/* A line the window shows in place of, or above, its milestones. */
function MilestoneLine({
  state,
  children,
  retry,
}: {
  state: 'loading' | 'unavailable' | 'refused' | 'failed' | 'gone'
  children: ReactNodeM
  retry?: () => void
}) {
  return (
    <div
      data-milestone-open={state}
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-base',
        state === 'loading' ? 'text-text-3' : 'text-text-2',
      )}
    >
      <span className="min-w-0">{children}</span>
      {retry && (
        <Button type="button" variant="ghost" size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  )
}

function MilestoneModal({
  init = {},
  onClose,
  focusAfterClose,
}: {
  init?: { id?: string; week?: number; project?: string | null }
  onClose: () => void
  /** what takes focus as the window closes, for an opener whose milestone
      was deleted here */
  focusAfterClose?: () => HTMLElement | null
}) {
  const opened = useOpenedMilestone(init.id)
  const read = opened.read
  const answer = shownAnswer(read)
  // the opened milestone as the answer shows it, painted with the person's
  // own writes: none before the answer, after an answer of null and after
  // the person's own delete
  const openedM = init.id ? (answer?.rows[0] ?? null) : null
  // milestones sit on a project's roadmap (0078) — a new one needs one, and
  // writing takes user level on it. The project is fixed when the window
  // knows it: at once for a new milestone, and from the server's first
  // answer that names the milestone when opened on one. It stays on that
  // project after the milestone itself is deleted here.
  const [projectId, setProjectId] = useStateM<string | null>(() =>
    init.id ? null : (P.metaOf(init.project)?.id ?? null),
  )
  if (init.id && projectId === null && openedM && answer?.project) setProjectId(answer.project.id)
  // the store's own project, which the add row and the list need
  const project = projectId ? P.metaOf(projectId) : null
  const projectName = init.id ? (answer?.project?.name ?? null) : (project?.name ?? null)
  // opened on a milestone, the answer says whether the person may write;
  // else their level on the project
  const canWrite = init.id
    ? !!answer?.canWrite
    : !!project && ['lead', 'user'].includes(P.levelOn(project.id) || '')
  // the editor opens on init.id once the answer says the person may write;
  // a read-only flag or row opens the window with that milestone as its row
  const [editId, setEditId] = useStateM<string | null>(init.id ?? null)
  const [answered, setAnswered] = useStateM(!init.id)
  if (!answered && openedM && answer) {
    setAnswered(true)
    if (!answer.canWrite) setEditId(null)
  }
  // whether the opened milestone showed, and whether the person deleted it
  // here, after which its answer of null says nothing
  const [deletedHere, setDeletedHere] = useStateM(false)
  // a delete the server refused brings the milestone back, and a later
  // answer of null is news again
  if (deletedHere && openedM) setDeletedHere(false)
  const gone = !!init.id && answered && !openedM && !deletedHere && read?.state === 'ok' && !!answer
  if (gone && editId === init.id) setEditId(null)
  const [initialDate] = useStateM(() => (init.week == null ? null : weekToISO(init.week)))
  const [name, setName] = useStateM('')
  const [date, setDate] = useStateM(() => initialDate ?? weekToISO(P.TODAY_WEEK))
  // a create in flight: Add waits for the server's answer
  const [adding, setAdding] = useStateM(false)
  // the draft as it is now, so an answer can tell whether it changed since
  const draftRef = useRefM({ name, date })
  draftRef.current = { name, date }
  const week = exactWeekForDate(date)
  // the list needs the project in the store; without it the window shows
  // the opened milestone alone rather than an empty list
  const list = project
    ? P.milestonesIn(project.id)
        .slice()
        .sort((a, b) => a.week - b.week || a.name.localeCompare(b.name))
        .filter((m) => !(gone && m.id === init.id))
    : null
  const next = list?.find((m) => m.week >= P.TODAY_WEEK) ?? null
  const openedAbove = !!openedM && !list?.some((m) => m.id === openedM.id)
  const canAdd =
    canWrite &&
    !!project &&
    name.trim().length > 0 &&
    !overLimit(LIMITS.milestoneName, name) &&
    !adding
  const add = () => {
    if (!canAdd || !project) return
    // The typed name and date stay until the server creates the milestone,
    // and after a refusal, so a paused or refused add can be sent again.
    const added = name.trim()
    const sent = date
    setAdding(true)
    void P.addMilestone({ name: added, week: exactWeekForDate(date), project: project.id }).then(
      (saved) => {
        setAdding(false)
        if (!saved) return
        window.showToast?.(`Milestone “${added}” added`)
        // a name or date changed while the add was in flight is the next one
        const draft = draftRef.current
        if (draft.name.trim() !== added || draft.date !== sent) return
        setName('')
        setDate(initialDate ?? weekToISO(P.TODAY_WEEK))
      },
    )
  }
  /* A milestone of the window: the opened one from the answer, with its
     stored name and day, any other from the list, the workspace's. */
  const item = (m: MilestoneVM, own: boolean) => {
    const editing = m.id === editId && (own ? answered : canWrite)
    return editing ? (
      <MilestoneEditor
        key={m.id}
        m={m}
        stored={own ? answer?.stored.get(m.id) : undefined}
        locked={!canWrite}
        onClose={() => setEditId(null)}
        onDelete={own ? () => setDeletedHere(true) : undefined}
      />
    ) : (
      <MilestoneRowView
        key={m.id}
        m={m}
        next={next?.id === m.id}
        opened={own}
        onEdit={canWrite ? () => setEditId(m.id) : undefined}
      />
    )
  }
  const openState = !init.id
    ? undefined
    : read === null || read.state === 'loading'
      ? 'loading'
      : read.state === 'ok'
        ? gone
          ? 'gone'
          : !openedM && !answered
            ? 'unavailable'
            : read.current
              ? 'ok'
              : 'refreshing'
        : read.state === 'refused' || read.state === 'failed'
          ? read.state
          : 'loading'
  // what the window says before the answer names its project, in place of
  // its milestones
  const before = init.id && projectId === null
  return (
    <ModalShell
      icon="diamond"
      title="Milestones"
      savesAsYouGo
      // a new milestone's name, typed and not added yet
      unsent={[!!name.trim() && 'milestone name']}
      // the shell's chip is set in mono for task keys; a project name is prose
      badge={projectName && <span className="font-sans">{projectName}</span>}
      onClose={onClose}
      focusAfterClose={focusAfterClose}
      width={600}
      footer={(close) => (
        <>
          <div className="flex-1" />
          <Button type="button" onClick={close} className="font-semibold">
            Done
          </Button>
        </>
      )}
    >
      <div
        data-milestone-window
        data-milestone-open-state={openState}
        aria-busy={openState === 'refreshing' || undefined}
      >
        {before ? (
          openState === 'refused' && read?.state === 'refused' ? (
            <MilestoneLine state="refused">{read.sentence}</MilestoneLine>
          ) : openState === 'failed' ? (
            <MilestoneLine state="failed" retry={opened.retry}>
              Couldn't open this milestone.
            </MilestoneLine>
          ) : openState === 'unavailable' ? (
            <MilestoneLine state="unavailable">
              This milestone can't be opened. It may have been deleted, or you may not have access
              to it.
            </MilestoneLine>
          ) : (
            <MilestoneLine state="loading">Loading this milestone…</MilestoneLine>
          )
        ) : !init.id && !project ? (
          <div className="text-base text-text-2">Open a project to add a milestone.</div>
        ) : (
          <>
            {read?.state === 'failed' && (
              <div className="mb-4">
                <MilestoneLine state="failed" retry={opened.retry}>
                  Couldn't load the latest version of this milestone.
                </MilestoneLine>
              </div>
            )}
            {read?.state === 'refused' && (
              <div className="mb-4">
                <MilestoneLine state="refused">{read.sentence}</MilestoneLine>
              </div>
            )}
            {gone && (
              <div className="mb-4">
                <MilestoneLine state="gone">
                  This milestone is no longer here. It was deleted, or you can no longer open it.
                </MilestoneLine>
              </div>
            )}
            {canWrite && project && (
              <div className="flex flex-wrap items-center gap-3">
                <LimitedInput
                  limit={LIMITS.milestoneName}
                  aria-label="New milestone"
                  placeholder="New milestone"
                  data-milestone-new
                  data-autofocus={init.id ? undefined : ''}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') add()
                  }}
                  wrapperClassName="min-w-[160px] flex-1"
                  className={cn(ctlClass, 'font-medium')}
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
            {/* the opened milestone where the list does not hold it */}
            {openedM && openedAbove && (
              <div className={cn('flex flex-col gap-1', canWrite && project && 'mt-6')}>
                {item(openedM, true)}
              </div>
            )}
            {list && (
              <>
                <div
                  className={cn(
                    'mb-2 flex items-center gap-2 text-md font-semibold text-text-1',
                    ((canWrite && project) || openedAbove) && 'mt-6',
                  )}
                >
                  On the roadmap
                  <span className="font-normal text-text-3">{list.length}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {list.map((m) => (m.id === openedM?.id ? item(openedM, true) : item(m, false)))}
                  {list.length === 0 && (
                    <div className="px-0.5 py-1 text-sm text-text-3 italic">No milestones yet.</div>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </ModalShell>
  )
}

/* One milestone on the list: the diamond, the name, the Overview's relative
   phrase and the roadmap's week label, and an Edit button when the caller may
   write. Past milestones are dimmed; the next one's phrase is emphasised. On
   a phone the two labels drop under the name. The milestone the window
   opened on carries data-milestone-opened. */
function MilestoneRowView({
  m,
  next,
  opened = false,
  onEdit,
}: {
  m: MilestoneVM
  next: boolean
  opened?: boolean
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
      data-milestone-opened={opened ? '' : undefined}
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
   edit and leaves the window open (data-escape-owner, see ModalShell).
   `stored` is the milestone's stored name and day as the row it renders
   from holds them (a milestone read's answer, MilestoneAnswer.stored), else
   the store's (P.milestoneRow); the save sends them as what the person saw.
   `locked` keeps the typed text read-only once the person may no longer
   change the milestone. The Name box takes focus when the editor opens,
   unless the person already moved focus inside the window. */
function MilestoneEditor({
  m,
  stored,
  locked = false,
  onClose,
  onDelete,
}: {
  m: MilestoneVM
  stored?: { name: string; week: string }
  locked?: boolean
  onClose: () => void
  /** runs as the person deletes the milestone here */
  onDelete?: () => void
}) {
  // the name and day stored when the editor opened, which the save sends as
  // what the person saw. After a save refused over someone else's change,
  // the draft stays and their version becomes it once it shows (rebase), so
  // a second Save replaces it on purpose.
  const storedRef = useRefM(stored)
  storedRef.current = stored
  const storedNow = () => storedRef.current ?? P.milestoneRow(m.id) ?? undefined
  const [seen, setSeen] = useStateM(storedNow)
  const rebase = useRefM(false)
  const takeStored = () => {
    const row = storedNow()
    if (!row || (row.name === seen?.name && row.week === seen?.week)) return false
    rebase.current = false
    setSeen(row)
    return true
  }
  useEffectM(() => {
    if (rebase.current) takeStored()
  }, [m.name, m.week])
  // trimmed, as a name saved before names were trimmed can hold spaces
  const [name, setName] = useStateM(m.name.trim())
  // a rename typed and not saved yet
  useUnsaved(name.trim() !== m.name.trim(), 'milestone name')
  const [date, setDate] = useStateM(() => weekToISO(m.week))
  const week = exactWeekForDate(date)
  // a save in flight: the editor stays open, its fields read-only, until
  // the server answers
  const [saving, setSaving] = useStateM(false)
  const canSave =
    !locked && name.trim().length > 0 && !overLimit(LIMITS.milestoneName, name) && !saving
  // an answer that comes after this editor closed, for example because
  // another milestone's editor opened, closes nothing
  const mounted = useRefM(true)
  useEffectM(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const rootRef = useRefM<HTMLDivElement>(null)
  const nameRef = useRefM<HTMLInputElement>(null)
  // focus moves to the Name box only while it is nowhere in particular: on
  // the page, or on the window itself, as before an opened milestone's
  // answer arrived; never away from a control the person moved to meanwhile
  useEffectM(() => {
    const active = document.activeElement
    if (!active?.isConnected || active === document.body || active.hasAttribute('data-modal-shell'))
      nameRef.current?.focus()
  }, [])
  const closeRef = useRefM(onClose)
  closeRef.current = onClose
  // Escape is read here, on the document in the capture phase, because that
  // is where the shell's Radix listener reads it and stops propagation: an
  // onKeyDown on the Name box would never see the key. Listeners on the same
  // node still run. An open calendar owns the key first (it closes itself).
  useEffectM(() => {
    const onKey = (e: KeyboardEvent) => {
      // a tooltip, open or closing, takes the Escape first and passes it on,
      // read then
      if (
        e.key !== 'Escape' ||
        hasTooltip() ||
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
    // a refused save (paused, a name over the cap, or refused by the server)
    // keeps the editor open with the draft
    setSaving(true)
    const keepDraft = () => {
      if (!mounted.current) return false
      if (!takeStored()) rebase.current = true
      return true
    }
    void P.updateMilestone(
      m.id,
      { name: name.trim(), week: exactWeekForDate(date) },
      seen,
      keepDraft,
    ).then((saved) => {
      setSaving(false)
      if (!saved) return
      window.showToast?.('Milestone updated')
      if (mounted.current) closeRef.current()
    })
  }
  // Two-click arm-then-confirm with the app-wide timing (lib/useConfirmArm).
  const deletion = useConfirmArm<'delete'>()
  const armDel = deletion.armed !== null
  const remove = () =>
    deletion.press('delete', () => {
      if (locked || P.refusePausedEdit()) return
      onDelete?.()
      void P.removeMilestone(m.id, seen).then((saved) => {
        if (saved) window.showToast?.('Milestone removed')
      })
      onClose()
    })
  return (
    <div
      ref={rootRef}
      data-milestone-editor={m.id}
      data-milestone-locked={locked ? '' : undefined}
      data-escape-owner
      className="rounded-md bg-lit p-2 shadow-card"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span
          aria-hidden="true"
          className="size-[9px] shrink-0 rotate-45 rounded-[var(--r-2xs)] bg-[var(--milestone)]"
        />
        <LimitedInput
          ref={nameRef}
          limit={LIMITS.milestoneName}
          aria-label="Name"
          data-autofocus
          value={name}
          readOnly={saving || locked}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          wrapperClassName="min-w-[160px] flex-1"
          className={cn(ctlClass, 'font-medium')}
        />
        <DateSelect
          value={week}
          disabled={saving || locked}
          onChange={(w) => {
            if (w != null) setDate(weekToISO(w))
          }}
          title="Milestone date"
          className="h-control w-[150px] rounded-md font-sans text-base"
        />
      </div>
      {locked && (
        <p data-milestone-locked-note className="mt-2 mb-0 pl-6 text-sm text-text-2">
          You can no longer change this milestone.
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <span className="text-xs text-text-3">Week {P.weekNumberOf(week).num}</span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={locked}
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
function CreateOrgModal({
  onClose,
  focusAfterClose,
}: {
  onClose: () => void
  /** what takes focus as the window closes, as the button that opened it
      leaves once the organization exists */
  focusAfterClose?: () => HTMLElement | null
}) {
  const [name, setName] = useStateM('')
  const [busy, setBusy] = useStateM(false)
  const ref = useRefM<HTMLInputElement>(null)
  useEffectM(() => {
    ref.current?.focus()
  }, [])
  const canSave = name.trim().length > 0 && !overLimit(LIMITS.orgName, name) && !busy
  const submit = async () => {
    if (!canSave) return
    setBusy(true)
    try {
      if (await P.createOrg(name.trim())) {
        window.showToast?.(`“${name.trim()}” is yours. You're its first admin.`)
        onClose()
      }
    } finally {
      // busy refuses every close of the dialog
      setBusy(false)
    }
  }
  return (
    <ModalShell
      icon="people"
      title="Create your organization"
      onClose={onClose}
      focusAfterClose={focusAfterClose}
      // the button that opened it leaves once the organization exists, so a
      // close while the create runs would leave focus nowhere
      busy={busy}
      unsent={[!!name.trim() && 'organization name']}
      onSubmit={submit}
      canSubmit={canSave}
      submitLabel={busy ? 'Creating…' : 'Create'}
      width={440}
    >
      <MField label="Organization name">
        <LimitedInput
          limit={LIMITS.orgName}
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
  ArchiveOrDeleteProjectModal,
  ArchiveOrDeleteTaskModal,
  CreateOrgModal,
  MField,
  MilestoneModal,
  ModalShell,
  MoveIssueModal,
  NewIssueModal,
  NewProjectModal,
  NewSubProjectModal,
}
