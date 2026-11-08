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
import { hasTooltip } from '@/lib/passEscapeOn'
import { cn } from '@/lib/utils'
import { grouped, LIMITS } from '../../convex/lib/limits'
import { projectKeyBase, projectKeyCandidate } from '../../convex/lib/projectKeys'
import { issueKey } from '../../convex/lib/taskRefs'
import { LimitedInput, LimitedTextarea } from '../components/LimitedField'
import { MilestoneSectionPart } from '../components/MilestoneSectionPart'
import { LeadPicker } from '../components/ProjectAccessEditor'
import { ProjectAccessSelect } from '../components/ProjectAccessSelect'
import { ChoiceEnd, PickerSearch } from '../components/pickerParts'
import { type ChoiceWords, escapeClearsFirst } from '../components/pickerWords'
import { Avatar, DateSelect, Icon, MenuItem, Popover } from '../components/qivo'
import { WAITS_FOR_SAVE } from '../components/rowElements'
import { TARGET_WORDS, TargetPicker, type TargetRows } from '../components/TargetPicker'
import { useOrgPeople, usePeople } from '../components/usePeople'
import { useProjects } from '../components/useProjects'
import { ACCESS_CAPS } from '../lib/accessCaps'
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
  type ProjectFacts,
  type ProjectRemovalSummary,
  REMOVAL_UNCHECKED,
  type ReassignChoice,
  type ReassignChoices,
  type RemovalAnswer,
  type SubProjectParents,
  type TaskFamily,
  type TeamAccessLevel,
  teamNoun,
} from '../store/planner'
import { duplicateNameTags } from '../store/viewModels'
import { useMilestoneSection } from '../views/useMilestoneSection'
import { useViewsNews } from '../views/useViewsNews'
import { type ProjectSettingsRead, useProjectSettings } from './settings/useProjectSettings'

/** A row of the New sub-project dialog's Project list. */
type SubProjectParent = Extract<SubProjectParents, { state: 'ready' }>['rows'][number]

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
        <div data-modal-scroll className="overflow-y-auto px-5 pt-6 pb-6">
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
  /* A task is created into a SUB-project, chosen in one Sub-project picker
     of the sub-projects the person may WRITE in, not merely see, grouped
     under their project's name (projectNav.targets, components/
     TargetPicker.tsx), 25 at a time with a search, across every seat: a
     viewer's grant can't hold a new task, so the server applies the
     write's rule before it cuts each batch, and a project with no
     sub-project offers nothing. The dialog opens on the project it was
     opened in, a default, not a fence: on that sub-project when the project
     cache answers it writable, and in a top-level project on its first
     writable sub-project once a batch holds it; else on no choice, with
     Create off until one is chosen. (Moving an EXISTING task between
     projects is still a move, not a re-create: the task window's Move
     window, which is also the only one that can keep the number.) The
     phone's My tasks action opens with no project context and the same
     picker. */
  const context = init.project ? P.project(init.project) : undefined
  const contextWritable =
    context && context.type === 'project' && init.project ? P.canWrite(init.project) : false
  const created = useRefM(false)
  const [title, setTitle] = useStateM('')
  const [projId, setProjId] = useStateM<string | null>(
    contextWritable && init.project ? init.project : null,
  )
  // whether the person chose, after which no default moves the choice
  const chose = useRefM(contextWritable)
  // a context sub-project the cache answers writable once the dialog shows
  useEffectM(() => {
    if (!chose.current && contextWritable && init.project) {
      chose.current = true
      setProjId(init.project)
    }
  }, [contextWritable])
  // a top-level context opens on its first writable sub-project once a
  // batch of the picker holds one
  const openOnFirst = (rows: TargetRows) => {
    if (chose.current || !context || context.type !== 'meta') return
    const first = rows.find((row) => row.parent_id === context.id)
    if (!first) return
    chose.current = true
    setProjId(first.id)
  }
  // the chosen sub-project and the context, named while the dialog shows,
  // so the project cache reads them; Create waits for the chosen one's
  // answer, which the create reads (P.addIssue)
  useProjects([projId, init.project])
  const targetReady = !!projId && P.projectState(projId) === 'ok' && P.canWrite(projId)
  const canSave = targetReady && title.trim().length > 0 && !overLimit(LIMITS.title, title)

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
      <MField label="Sub-project">
        <div data-new-issue-subproject>
          <TargetPicker
            label="Sub-project"
            value={projId}
            onChoose={(row) => {
              chose.current = true
              setProjId(row.id)
            }}
            onRows={openOnFirst}
          />
        </div>
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
// still requires a unique ≤5-char key per org, so creation sends the name's
// first candidate (lib/projectKey.ts). projects.create keeps it while it is
// free and otherwise picks the first free candidate itself
// (convex/model/projects.ts allocateKey), as for REST and MCP, because the
// app holds no project and archived and hidden projects hold keys it never
// sees; the create's answer gives the key it kept.
const firstKey = (name: string) => projectKeyCandidate(projectKeyBase(name), 1)

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

/* The footer note of a create dialog (see creatorNote), naming the lead
   the dialog shows, for a project or a sub-project (`kind`). */
function CreatorNote({
  note,
  leadName,
  kind = 'project',
}: {
  note: ReturnType<typeof creatorNote>
  leadName: string
  kind?: 'project' | 'sub-project'
}) {
  if (note === 'hidden') return <FooterNote tone="warn">You won't see this {kind}.</FooterNote>
  if (note === 'lead') {
    return (
      <FooterNote tone="muted">
        Only {leadName || 'the lead'} and org admins can manage it.
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

/** What a create dialog hands App with its project: whether to make a
    starter task, which New sub-project asks only for a creator who will
    be able to add one there, and for a sub-project the organization its
    parent check named (ProjectShown), which the create goes to, and
    whether its creator will see it (`sees`, null while unknown), which
    App's toast and its move into the sub-project use. */
type CreateOptions = {
  withStarter: boolean
  shown?: { orgId: string }
  sees?: boolean | null
}

/* New top-level project (program). A project is an organization-wide
   container, so it has a lead but no owning/managing team. Teams can still be
   added through the access picker below; sub-projects use the same model.
   Lead and Project access read the server's choices only while their
   popovers are open (projectSettings.leadCandidates and candidates for a
   new project); the lead starts as the creator, named from their own
   profile, and Create needs no answer, as nothing else can be chosen.
   A creator who picks someone else as lead, an organization admin as
   anyone, is shown in Project access as User, the grant the server gives
   them (lib/newProjectAccess.ts), and the footer says who will manage the
   project, which an admin keeps managing, or that the creator would not
   see it. Of the store it reads the
   creator's own seat and the creator's teams for the footer
   (P.seesNewProject); the key it sends is the name's first candidate
   (firstKey). */
function NewProjectModal({
  init: _init = {},
  onClose,
  onCreate,
}: {
  init?: { team?: string }
  onClose: () => void
  onCreate: (p: NewProjectInput, opts: CreateOptions) => void
}) {
  const creatorName = P.user(P.CURRENT_USER)?.name ?? ''
  const [name, setName] = useStateM('')
  const [lead, setLead] = useStateM({ id: P.CURRENT_USER, name: creatorName })
  const [desc, setDesc] = useStateM('')
  const [teamAccess, setTeamAccess] = useStateM<Record<string, TeamAccessLevel>>({})
  const [draft, setDraft] = useStateM<AccessDraft>({ access: {}, self: 'none' })
  const access = draft.access
  const nameRef = useRefM(null)
  useEffectM(() => {
    nameRef.current?.focus()
  }, [])

  const creator = { id: P.CURRENT_USER, admin: P.isAdmin() }
  const changeLead = (next: { id: string; name: string }) => {
    setLead(next)
    setDraft((current) => afterLeadChange(current, next.id, creator))
  }
  const canSave =
    name.trim().length > 0 &&
    !overLimit(LIMITS.projectName, name) &&
    !overLimit(LIMITS.projectDescription, desc) &&
    !!lead.id
  const note = creatorNote({
    creator,
    lead: lead.id,
    sees: P.seesNewProject({
      lead: lead.id,
      access: requestedAccess(draft, creator),
      teamAccess,
    }),
  })

  const submit = () => {
    if (!canSave) return
    onCreate(
      {
        key: firstKey(name),
        name: name.trim(),
        type: 'meta',
        lead: lead.id || undefined,
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
      footerLeft={<CreatorNote note={note} leadName={lead.name} />}
    >
      <NameRow nameRef={nameRef} name={name} setName={setName} submit={submit} />
      {/* Alone on its row, it keeps MField's 24px below it. As the last
          child of a row of its own, last:mb-0 took that gap away. */}
      <MField label="Lead">
        <LeadPicker
          on={{ org_id: P.homeOrg }}
          lead={lead}
          disabled={!P.homeOrg}
          busy={false}
          modal
          onPick={changeLead}
        />
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
          on={{ org_id: P.homeOrg, lead_id: lead.id }}
          teamAccess={teamAccess}
          access={access}
          you={P.CURRENT_USER}
          youName={creatorName}
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

/** A parent the New sub-project dialog may create under: the opener's,
    known by id, or a row its Project list answered, with that row's name,
    number, tag among equal names and organization. */
type ParentPick = { id: string; name?: string; tag?: string; org?: string }

/** The Project list's words (projectSettings.projects with
    sub_project_parents). Its access_unchecked answer is an `unavailable`
    one with the server's sentence, which shows as it is. */
const PARENT_WORDS: ChoiceWords = {
  held: (held) =>
    held?.state === 'not_ready'
      ? "Projects can't be listed yet."
      : held?.message
        ? held.message
        : "Projects can't be listed.",
  failed: "Couldn't load projects.",
  stopped: 'Showing the projects found so far.',
  empty: 'Project Lead access is required to create sub-projects.',
  none: 'No projects match.',
}

/** The parent check's line under the Project field, for the read of the
    chosen parent's settings (projectSettings.get), or null when the
    parent may take a sub-project. `opener` says the parent is the one the
    dialog opened with. */
function parentNote(read: ProjectSettingsRead, picked: ParentPick, opener: boolean) {
  const kept = read.answer
  if (read.state === 'loading') return null
  if (read.afterFailure || read.state === 'failed')
    return kept ? `Couldn't check “${kept.project.name}” again.` : "Couldn't check the project."
  if (read.state === 'archived' && read.archived)
    return `“${read.archived.project.name}” is archived, so restore it before adding a sub-project.`
  if (read.state === 'unavailable')
    return opener || !picked.name
      ? 'The project you opened this from is no longer available.'
      : `“${picked.name}” is no longer available.`
  if (kept && !kept.can_create_sub_project)
    return kept.project.type === 'meta' && kept.parent === null
      ? `Only the lead of “${kept.project.name}” or an organization admin can add sub-projects to it.`
      : `“${kept.project.name}” can't take a sub-project.`
  return null
}

/* New sub-project. Every opener names a parent, which the dialog checks on
   the server while it is open (projectSettings.get, useProjectSettings),
   whose answer names the parent's organization and whether the caller may
   create under it (can_create_sub_project, by management). For a parent
   that cannot take one the dialog says why and offers the Project list,
   the server's parents in that organization (projectSettings.projects with
   sub_project_parents), 25 at a time with a search, read only while open,
   equal names tagged as duplicateNameTags tags them; a pick is checked in
   turn. The Project and Lead popovers wait for the check unless the
   workspace holds the parent, the Lead button reading Loading… meanwhile,
   and use the home organization, else the first, only once it answers
   `unavailable` or fails before it answered. The creator is the caller's seat in that organization
   (P.seatIn), never the home seat, and leads until the Lead popover
   (leadCandidates with the parent) offers someone else; a pick is kept
   through a change of parent, which the create checks again. Create needs
   a current answer that the parent may take a sub-project, so it is off
   while the check loads, failed, refreshes after a failure, or answered
   archived, unavailable or no. The create goes to the answer's
   organization (CreateOptions `shown`). The creator sees the sub-project
   as its lead, or by their own level on the parent, which the parent check
   answers without navigation (`accessible`), so an organization admin who
   manages a parent they take no part in and names someone else as lead
   reads "You won't see this sub-project.", and an unknown answer, as from
   a check that stopped, warns of nothing. A starter task is offered only
   under a parent the workspace holds, as P.addIssue creates tasks only in
   a project it holds, and only to a creator who will be able to add a
   task there, its lead or one whose level on the parent, which the
   sub-project inherits, is User or Lead (a team share counts at its
   level). Seeing it is not enough, as a Viewer on the parent sees the
   sub-project and may add no task, and an unknown level offers none. Of the
   store it reads the caller's seats and their names, the organizations'
   names, the parent's facts in the project cache and the creator's admin
   flag for the footer; no list, choice or right. The key it sends is the
   name's first candidate (firstKey). */
function NewSubProjectModal({
  init = {},
  onClose,
  onCreate,
  focusAfterClose,
}: {
  init?: { parent?: string }
  onClose: () => void
  onCreate: (p: NewProjectInput, opts: CreateOptions) => void
  focusAfterClose?: () => HTMLElement | null
}) {
  const [name, setName] = useStateM('')
  const [parent, setParent] = useStateM<ParentPick | null>(init.parent ? { id: init.parent } : null)
  const [picked, setPicked] = useStateM<{ id: string; name: string; org: string } | null>(null)
  const [withStarter, setWithStarter] = useStateM(true)
  const nameRef = useRefM(null)
  useEffectM(() => {
    nameRef.current?.focus()
  }, [])

  const read = useProjectSettings(parent?.id ?? null)
  const answer = read.answer
  const held = parent ? P.project(parent.id) : undefined
  // the organization the popovers read in and the create goes to: the
  // check's, a picked row's, the project cache's while it knows the parent,
  // and after an `unavailable` answer or a check that failed before it
  // answered the home organization, else the first, so the Project list
  // stays open to another parent while Create waits for a check
  const known =
    answer?.project.org_id ?? read.archived?.project.org_id ?? parent?.org ?? held?.org ?? ''
  const fallback =
    read.state === 'unavailable' || read.state === 'failed' || !parent
      ? P.homeOrg || P.orgs[0]?.id || ''
      : ''
  const org = known || fallback
  const seat = org ? P.seatIn(org) : ''
  const creatorLead = { id: seat, name: P.user(seat)?.name ?? '' }
  const lead = picked && picked.org === org ? picked : creatorLead
  // a current answer, or one kept while the read refreshes after the tab
  // showed again, decides; one kept after a failure does not
  const current = read.state === 'ok' || (read.state === 'refreshing' && !read.afterFailure)
  const mayCreate =
    !!parent &&
    current &&
    !!answer &&
    answer.project.id === parent.id &&
    answer.can_create_sub_project
  const canSave =
    name.trim().length > 0 &&
    !overLimit(LIMITS.projectName, name) &&
    mayCreate &&
    !!seat &&
    !!lead.id
  const note = parent ? parentNote(read, parent, parent.id === init.parent) : null
  const orgName = P.orgs.length > 1 && org ? P.orgs.find((o) => o.id === org)?.name : undefined
  // whether the creator will see the new sub-project: as its lead, or by
  // their own level on the parent, null while that is unknown
  const sees: boolean | null =
    seat && lead.id === seat
      ? true
      : answer && parent && answer.project.id === parent.id
        ? answer.accessible
        : null
  // whether the creator will be able to add a task to it, which the
  // server's task create allows User and Lead (model/issues.ts
  // assertCanEdit), as its lead or by User or Lead on the parent, which it
  // inherits, and false while the parent's level is unknown
  const edits =
    (!!seat && lead.id === seat) ||
    (!!answer &&
      !!parent &&
      answer.project.id === parent.id &&
      (answer.level === 'user' || answer.level === 'lead'))
  // App makes the starter task once the new sub-project's read by id
  // answers that the creator may add tasks there (App.tsx createProject)
  const offersStarter = edits

  const submit = () => {
    if (!canSave || !parent || !answer) return
    onCreate(
      {
        key: firstKey(name),
        name: name.trim(),
        type: 'project',
        parent: parent.id,
        lead: lead.id,
      },
      {
        withStarter: offersStarter && withStarter,
        shown: { orgId: answer.project.org_id },
        sees,
      },
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
        <CreatorNote
          note={creatorNote({
            creator: { id: seat, admin: !!seat && P.isAdmin(seat) },
            lead: lead.id,
            sees,
          })}
          leadName={lead.name}
          kind="sub-project"
        />
      }
    >
      <NameRow nameRef={nameRef} name={name} setName={setName} submit={submit} />
      <div className="flex flex-wrap gap-x-2">
        <MField label="Project" flex>
          <ParentPicker org={org} parent={parent} read={read} onPick={(row) => setParent(row)} />
          {orgName && (
            <p data-new-subproject-org="" className="mt-1.5 text-sm text-text-2">
              In {orgName}
            </p>
          )}
        </MField>
        <MField label="Lead" flex>
          <LeadPicker
            on={parent ? { org_id: org, parent_id: parent.id } : { org_id: org }}
            lead={seat ? lead : null}
            emptyLabel={read.state === 'loading' ? 'Loading…' : undefined}
            disabled={!org || !parent}
            busy={false}
            modal
            onPick={(person) => setPicked({ ...person, org })}
          />
        </MField>
      </div>
      {note && (
        <div
          role={read.afterFailure || read.state === 'failed' ? 'alert' : 'status'}
          data-new-subproject-parent-note=""
          className={cn(
            'mb-6 flex flex-wrap items-center gap-2 text-sm leading-normal',
            read.afterFailure || read.state === 'failed' ? 'text-danger' : 'text-text-2',
          )}
        >
          {note}
          {(read.afterFailure || read.state === 'failed') && (
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm text-sm"
              onClick={read.retry}
            >
              Try again
            </Button>
          )}
        </div>
      )}
      {offersStarter && (
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
      )}
    </ModalShell>
  )
}

/* The New sub-project dialog's Project field: a button naming the parent
   once the check answered that it may take a sub-project, "Choose a
   project…" otherwise and "Loading…" while it checks, which opens the
   server's parents in organization `org`. Its popover is modal, so its
   list scrolls inside the modal dialog (qivo Popover). While the check
   loads the button is marked disabled but stays focusable, and a press
   opens nothing. A keyboard pick starts a check as the popover closes and
   focus returns to the button, which a disabled one would drop to the
   page. */
function ParentPicker({
  org,
  parent,
  read,
  onPick,
}: {
  org: string
  parent: ParentPick | null
  read: ProjectSettingsRead
  onPick: (row: ParentPick) => void
}) {
  const answer = read.answer && parent && read.answer.project.id === parent.id ? read.answer : null
  const loading = read.state === 'loading' && !!parent
  // the parent the check said may take a sub-project, named also while it
  // refreshes or after a failure, when Create waits for a current answer
  const shows = read.state === 'ok' || read.state === 'refreshing' || read.state === 'failed'
  const named =
    answer && shows && answer.can_create_sub_project
      ? `${answer.project.name}${parent?.tag ? ` ${parent.tag}` : ''}`
      : null
  const label = loading ? 'Loading…' : (named ?? 'Choose a project…')
  return (
    <Popover
      width={300}
      backLayer
      modal
      onEscapeKeyDown={escapeClearsFirst('data-new-subproject-parent-search')}
      wrapStyle={{ minWidth: 0 }}
      button={(toggle, open) => (
        <Button
          type="button"
          variant="outline"
          data-new-subproject-parent={named ? (parent?.id ?? '') : ''}
          data-on={open ? '' : undefined}
          aria-label={`Project: ${named ?? 'none chosen'}`}
          aria-busy={loading || undefined}
          aria-disabled={loading || undefined}
          disabled={!loading && !org}
          onClick={(event) => {
            // Radix's trigger opens only when the click is not prevented
            if (loading) event.preventDefault()
            else toggle()
          }}
          className="h-control w-full max-w-full justify-between gap-2 bg-surface-1 px-2.5 text-base font-normal text-text-1 aria-disabled:cursor-progress aria-disabled:opacity-55"
        >
          <span className={named ? 'min-w-0 truncate' : 'min-w-0 truncate text-text-2'}>
            {label}
          </span>
          <Icon name="chevronDown" size={14} color="var(--text-2)" />
        </Button>
      )}
    >
      {(close) => (
        <ParentChoiceList
          org={org}
          chosen={named ? (parent?.id ?? null) : null}
          onPick={(row) => close(() => onPick(row))}
        />
      )}
    </Popover>
  )
}

/* The open Project list: a search and the server's parents with Load
   more, read once a batch, tagged where names are equal among the loaded
   rows. */
function ParentChoiceList({
  org,
  chosen,
  onPick,
}: {
  org: string
  chosen: string | null
  onPick: (row: ParentPick) => void
}) {
  const [text, setText] = useStateM('')
  const { tooLong, settled: query } = useSettledSearch(text, LIMITS.search)
  const list = usePagedList({
    key: `${org}|${query}`,
    source: { kind: 'once', read: (at) => P.subProjectParents(org, query, at.after) },
    batch: (answer: SubProjectParents) => (answer.state === 'ready' ? answer : null),
    id: (row: SubProjectParent) => row.id,
    most: ACCESS_CAPS.choices,
  })
  const end = listEnd(list, query !== '')
  const tags = duplicateNameTags(
    list.rows.map((row) => ({ id: row.id, org, parent: undefined, name: row.name, num: row.num })),
  )
  return (
    <div data-new-subproject-parents="" className="flex flex-col gap-1">
      <PickerSearch
        text={text}
        onText={setText}
        label="Search projects"
        probe="data-new-subproject-parent-search"
      />
      <div className="max-h-[280px] overflow-y-auto">
        {list.rows.map((row) => {
          const tag = tags.get(row.id)
          return (
            <MenuItem
              key={row.id}
              active={chosen === row.id}
              onClick={() => onPick({ id: row.id, name: row.name, tag, org })}
              data-new-subproject-parent-choice={row.id}
            >
              <span className="min-w-0 truncate">{row.name}</span>
              {tag && <span className="shrink-0 text-text-2">{tag}</span>}
            </MenuItem>
          )
        })}
        <ChoiceEnd end={end} tooLong={tooLong} list={list} words={PARENT_WORDS} />
      </div>
    </div>
  )
}

/** Why moving, archiving or deleting a task the workspace holds waits
    while tasks still load and no answer of its own serves its subtasks:
    each acts on subtasks and blockers that may be still to arrive. Only a
    store that asked for every task, as the scripts' and the benchmark's,
    holds a task before every task has loaded. */
export const WAITS_FOR_TASKS = 'Available once every task has loaded'
/** Why a control of the person's own new task that reads the server about
    the task waits until it is saved (components/rowElements.tsx). */
export { WAITS_FOR_SAVE }
/** Why a change to a task the task window shows from its own read waits
    while that read failed or runs again: Qivo cannot tell whether someone
    changed the task meanwhile. */
export const WAITS_FOR_CHECK = 'Available once Qivo can check this task for changes'
/** Why moving, archiving or deleting a task the window shows from its own
    read is off while that read holds no whole list of its subtasks. */
export const FAMILY_UNKNOWN = 'Not available while Qivo cannot read every subtask of this task'

/** Why a task's Move or Archive or delete window cannot act, with no
    family (P.familyOf). A task the workspace holds waits for every task,
    the person's new task shown from what its create sent waits until it
    is saved, and one the window shows from its own read waits for that
    read to be current again (P.answerSaveWaits), else for its whole
    subtask list, as the task window's menu says (IssueDetail fateTip). */
const familyWait = (it: IssueVM) =>
  P.issueById[it.id]
    ? WAITS_FOR_TASKS
    : P.taskDetail(it.uuid, it.org)?.saving
      ? WAITS_FOR_SAVE
      : P.answerSaveWaits(it.id)
        ? WAITS_FOR_CHECK
        : FAMILY_UNKNOWN

/** What the Move window's list says at its end: no other sub-project the
    person may move the task to. */
const MOVE_TARGET_WORDS: ChoiceWords = {
  ...TARGET_WORDS,
  empty: 'No other sub-project you can move it to.',
  none: 'No matching sub-project you can move it to.',
}

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
  // Same-organization destinations with write access, from the server
  // (projectNav.targets in the task's organization, components/
  // TargetPicker.tsx), the task's own sub-project marked current. The
  // server checks access at both ends; a move preserves the task's
  // immutable number. A chosen row seeds its facts and its parent's into
  // the project cache, and the window names it while it shows, so the
  // move reads its parent (crossing, P.moveFamily) from the cache.
  const [target, setTarget] = useStateM('')
  useProjects([target || null])
  // A move to another top-level project carries the subtasks, archived ones
  // included. Archived tasks are not in this view, so the server answers
  // whether any would move to the chosen sub-project.
  const [asked, setAsked] = useStateM<{ target: string; carries: boolean } | null>(null)
  const crossing =
    !!it &&
    !!target &&
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
  // a target the project cache answers gone, as a concurrently deleted
  // one, must not leave Move enabled
  const targetValid = !!target && P.projectState(target) !== 'gone' && !!P.project(target)
  const moving = targetValid && target !== it.project
  // whoever works on the task or its subtasks must keep access after the
  // move: the server checks every one at full scope and refuses the move
  // with a sentence that says what to change, which is toasted and the
  // move taken back (the store holds no one else to name here)
  const canMove = !!target && moving && !!family
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
        <TargetPicker
          label="Move to"
          org={it.org}
          value={target || null}
          current={it.project}
          onChoose={(row) => setTarget(row.id)}
          words={MOVE_TARGET_WORDS}
        />
      </MField>
      {notes.length > 0 && (
        <div
          data-move-notes
          className="[font-size:var(--fs-base)] [color:var(--text-2)] [line-height:1.5] [margin-top:12px] flex flex-col gap-2"
        >
          {notes.map((note) => (
            <p key={note} data-move-note>
              {note}
            </p>
          ))}
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
  onRemoved,
  onClose,
  focusAfterClose,
}: {
  change: AccessRemoval
  /** the server's preview that opened the window (P.startRemoval) */
  answer: RemovalAnswer
  /** runs once the access is gone: the server accepted the removal the
      window sent, or said it was gone already */
  onRemoved?: () => void
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
  // the team and the person as the page that pressed showed them (the
  // change's label, and a member's team), the store's team only as a
  // fallback
  const team =
    'teamId' in change
      ? ((change.kind !== 'teamMember' ? change.label : change.team) ??
        P.teamById(change.teamId)?.name)
      : undefined
  const teamName = `the ${teamNoun(team)}`
  const person =
    'userId' in change
      ? shown.people.find((p) => p.id === change.userId)?.name || change.label || 'Someone'
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
  /* The removal that leaves the tasks, once a read-only organization
     allows only that, reported once the server accepts it. */
  const leaveTasks = (now: RemovalAnswer) => {
    onClose()
    void P.removeLeavingTasks(change, now).then((removed) => {
      if (removed) onRemoved?.()
    })
  }
  /* After a refused write, the window asks the server again: an answer it
     cannot read keeps the window with its lists, a refusal closes it, as the
     write's own message already said why, and a read-only organization
     hands over to the removal that leaves the tasks. */
  const finish = (removal: Promise<boolean>) => {
    setSaving(true)
    void removal.then(async (removed) => {
      if (removed) {
        onRemoved?.()
        return onClose()
      }
      const now = await P.previewRemoval(change)
      if (!open.current) return
      setSaving(false)
      if (now === null || now.state === 'too_large') return
      if (now.state === 'refused') return onClose()
      if (now.state === 'unavailable' || !now.pending) {
        onRemoved?.()
        return onClose()
      }
      if (now.leave_only) return leaveTasks(now)
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
        onRemoved?.()
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
      if (now.leave_only) return leaveTasks(now)
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
  // the chosen person, named while the button shows them after the list
  // closes, so their portrait loads
  useOrgPeople(change.orgId ?? P.homeOrg, [to?.id])
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
  // the picker's people, named while it is open, in the change's
  // organization
  usePeople(list.rows.map((person) => ({ org: change.orgId ?? P.homeOrg, id: person.id })))
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
            onClick={() => {
              // a pick outlives the list, so its row is kept as a name
              P.takePeople(change.orgId ?? P.homeOrg, [person])
              onPick({ id: person.id, name: person.name })
            }}
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
        ? "At least one is in a project you can't edit. Keep the subtasks, or ask someone who can edit those projects."
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
  project: Pick<ProjectFacts, 'id' | 'name' | 'type'> & { orgId?: string }
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

/* ---------- Milestones (sections + create + edit, one window) ----------
   Deviation #239. The window lists a project's milestones in two sections
   the server answers (milestones.section, views/useMilestoneSection.ts).
   The first row is the new milestone (name, week, Add). Upcoming lists the
   milestones of the current week and later, nearest first. Past, collapsed
   whenever the window opens, lists the earlier ones, newest first, and
   reads nothing until the person expands it; it shows once Upcoming's first
   answer came, unless the answer Upcoming shows says the project holds no
   past milestone and the person made none here. An Upcoming that moved on
   can no longer tell, so Past shows then. Each section reads 25 at first
   and 25 more for each Load more, keeps at most 100 and then moves on with
   Show from the start, shows its search box, which searches every
   milestone of its side on the server, once it held more than one batch,
   and says when it loads, refreshes, fails (Retry), is refused (the
   server's sentence) or could check only part of the list, never calling
   such a section empty or whole. Every section is a live read of the store,
   so the person's own writes paint over it at once and other people's
   arrive while it shows; every read stops while the tab or desktop window
   hides and reads again on return, and a new week starts both sections
   again. A row's Edit button opens it in place with Delete / Cancel / Save.
   Every action commits where it stands and the window stays open; the
   footer is only Done.
   `init.project` opens on the new row, `init.week` preselecting its week.

   `init.id` (a roadmap diamond, an Overview row, the phone agenda) opens
   on that milestone, which the window reads from the server
   (milestones.get, P.watchMilestones) while it and the tab show. Its
   answer alone fixes the window's project and says whether the person may
   change the milestone. The window reads Upcoming beside it for the
   project the opener named (init.project), and uses that read only once
   the answer names the same project, else it asks the answer's project,
   and an answer that names no project, or a failure or refusal before the
   first answer, drops it.
   Until the answer and, where the store holds the project, Upcoming's
   first answer are in, nothing but "Loading this milestone…" shows: no
   sections, no add row, no editor. Then the milestone shows as its editor
   for someone who may write, else as its row, in its place in Upcoming
   where that answer holds it, else above the sections, a past one
   included, without reading Past. Once the milestones showed, the loading
   line never returns, also where the store holds the project only later.
   A milestone the server does not answer, for every reason alike, or
   refuses, says so with Done only; a failure offers Retry; and once it
   showed, an answer of null that the person's own delete did not cause
   closes its editor and says it is no longer here. The add row and the
   other milestones' Edit follow the answer's right while it names the
   milestone, and after the person's own delete the right it gave last,
   while the store's level allows it too; an answer of null for another
   reason gives none. An editor open when its right goes stays, locked, with
   its draft. A failure after an answer keeps that answer, and the editor
   its draft, under a note with Retry. While the tab hides or after a
   reconnect the window shows its last answer and its root is marked
   refreshing (aria-busy) until the answer is current again.

   An open editor stays in the place it opened in, above the sections or
   in its section, with its draft and focus, until the person saves,
   cancels or deletes, whatever its row does meanwhile: a save's own move,
   someone else's rename or move, a create that pushes it out of a full
   answer, a new search or the collapse of Past. A section leaves its
   milestone out of its rows while it shows elsewhere. An editor whose
   milestone no section shows reads it with milestones.get under
   milestone:kept, which gives it its stored values, its organization and
   its right, and says when it is gone. Until that read first answers, its
   Save and Delete wait, so a write finds its row and organization in that
   read's answer and the editor takes its right from it, and it says it is
   loading while the read loads. A save still sends the values the editor
   showed when it opened as what the person saw. That read's failure says
   so above the sections with Retry, and its refusal gives the server's
   sentence; before any answer a refusal also locks the editor with its
   draft, and after one, a failure or refusal keeps that answer and its
   right. */

/* The store's slots of the window's reads: the milestone it opened on, the
   milestone of an editor no section shows, and its two sections' asks. */
const MILESTONE_OPEN = 'milestone:open'
const MILESTONE_KEPT = 'milestone:kept'
const MILESTONE_SECTIONS = {
  upcoming: 'milestones:window:upcoming',
  past: 'milestones:window:past',
} as const
/* How many of the window's milestone reads mounted, each one's read owner
   (P.watchMilestones). */
let milestoneWindows = 0

/** The read of milestone `id` (milestones.get) under `slot`, which the
    window registers with the store while it and the tab show, with Retry,
    or none without an id. The read goes when the id changes or the window
    closes. Renders again on the store's `views` news
    (views/useViewsNews.ts). */
function useMilestoneGet(slot: string, id: string | null | undefined) {
  const { visible } = useViewVisibility()
  const [attempt, setAttempt] = useStateM(0)
  // this mounted window, which owns the read while it asks
  const [owner] = useStateM(() => ++milestoneWindows)
  useViewsNews()
  useEffectM(() => {
    if (!id) return
    P.watchMilestones(slot, visible ? { kind: 'get', id } : null, owner, attempt)
    return () => P.watchMilestones(slot, null, owner, attempt)
  }, [slot, id, visible, owner, attempt])
  useEffectM(() => {
    if (!id) return
    return () => P.releaseMilestones(slot, owner)
  }, [slot, id, owner])
  return {
    // an answer for another milestone than this one is loading
    read: id ? P.milestoneRead(slot, { kind: 'get', id }) : null,
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

/* A line the window shows in place of, or above, its milestones, about the
   milestone it opened on, or with `kept` about the milestone of an editor
   no section shows (milestone:kept). */
function MilestoneLine({
  state,
  kept = false,
  children,
  retry,
}: {
  state: 'loading' | 'unavailable' | 'refused' | 'failed' | 'gone'
  kept?: boolean
  children: ReactNodeM
  retry?: () => void
}) {
  return (
    <div
      data-milestone-open={state}
      data-milestone-kept={kept ? '' : undefined}
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

/** Where an open editor stays: above the sections, or in one of them. */
type EditorPlace = 'top' | 'upcoming' | 'past'

function MilestoneModal({
  init = {},
  onClose,
  focusAfterClose,
}: {
  /** `project` with `id` is the project the opener shows the milestone on,
      which only starts Upcoming's read early; the answer fixes the project */
  init?: { id?: string; week?: number; project?: string | null }
  onClose: () => void
  /** what takes focus as the window closes, for an opener whose milestone
      was deleted here */
  focusAfterClose?: () => HTMLElement | null
}) {
  const opened = useMilestoneGet(MILESTONE_OPEN, init.id)
  const read = opened.read
  const answer = shownAnswer(read)
  // the opened milestone as the answer shows it, painted with the person's
  // own writes: none before the answer, after an answer of null and after
  // the person's own delete
  const openedM = init.id ? (answer?.rows[0] ?? null) : null
  // milestones sit on a project's roadmap (0078); a new one needs one, and
  // writing takes user level on it. The project is fixed when the window
  // knows it: at once for a new milestone, and from the server's first
  // answer that names the milestone when opened on one. It stays on that
  // project after the milestone itself is deleted here.
  // the project it opens on, named with the project cache while the
  // window shows, so its top-level project, its level and its add row read
  // the cache's answer, which the window takes once it arrives
  useProjects([init.project])
  const [projectId, setProjectId] = useStateM<string | null>(() =>
    init.id ? null : (P.metaOf(init.project)?.id ?? null),
  )
  const metaNow = init.id ? null : (P.metaOf(init.project)?.id ?? null)
  if (!init.id && projectId === null && metaNow !== null) setProjectId(metaNow)
  // the name the answer gave the project as it fixed it, which the badge
  // keeps once the milestone is gone and its answer names no project
  const [fixedName, setFixedName] = useStateM<string | null>(null)
  if (init.id && projectId === null && openedM && answer?.project) {
    setProjectId(answer.project.id)
    setFixedName(answer.project.name)
  }
  // the store's own project, which the add row and the sections need
  const project = projectId ? P.metaOf(projectId) : null
  const projectName = init.id
    ? (answer?.project?.name ?? fixedName ?? project?.name ?? null)
    : (project?.name ?? null)
  // the person's level on the project in the store: User access or more
  const levelWrites = !!project && ['lead', 'user'].includes(P.levelOn(project.id) || '')
  // the right the last answer that named the project gave, which the add
  // row and the other milestones keep after the person's own delete
  const [namedRight, setNamedRight] = useStateM(false)
  if (init.id && answer?.project && !!answer.canWrite !== namedRight)
    setNamedRight(!!answer.canWrite)
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
  // whether the person may change the opened milestone, which is what the
  // answer says, and no right once it names no milestone
  const openedCanWrite = !!answer?.canWrite
  // the window cannot tell the person's right on the project once the
  // answer names no project for a reason other than their own delete,
  // since a deleted milestone and lost access answer alike
  const rightUnknown = !!init.id && !answer?.project && !deletedHere
  // whether they may add milestones and change the others. Opened on a
  // milestone, that is what the answer says while it names the project,
  // and after their own delete of the milestone what the last such answer
  // said while the store still gives them User access. No right while the
  // window cannot tell (rightUnknown). Else their level on the project.
  const canWrite = !init.id
    ? levelWrites
    : answer?.project
      ? !!answer.canWrite
      : deletedHere && namedRight && levelWrites

  // The sections. `from` is the first day of the current week in the app's
  // grid, read on each render: a new week re-anchors the grid, which moves
  // the boundary and starts both sections again. Before the answer named
  // the project, Upcoming reads the project the opener named, while the
  // milestone's read loads or its answer names a project. An answer that
  // names none (gone or unreadable), or a failure or refusal with no
  // answer kept, drops that read, since the window shows no section then.
  const from = weekToISO(P.TODAY_WEEK)
  const hinted =
    init.id && projectId === null && (!read || read.state === 'loading' || !!answer?.project)
      ? (P.metaOf(init.project)?.id ?? null)
      : null
  const upcomingOn = project?.id ?? hinted
  const upcoming = useMilestoneSection(
    MILESTONE_SECTIONS.upcoming,
    upcomingOn ? { projects: [upcomingOn], from, side: 'upcoming' } : null,
  )
  // Past, collapsed whenever the window opens, reads nothing while it is
  const [pastOpen, setPastOpen] = useStateM(false)
  const pastOpenRef = useRefM(pastOpen)
  pastOpenRef.current = pastOpen
  const past = useMilestoneSection(
    MILESTONE_SECTIONS.past,
    project && pastOpen ? { projects: [project.id], from, side: 'past' } : null,
  )
  // whether Upcoming's first answer for the window's project came, failed
  // or was refused, which the opened milestone waits for
  const [upcomingIn, setUpcomingIn] = useStateM(false)
  if (!upcomingIn && project && upcoming.view.state !== 'loading') setUpcomingIn(true)
  // The person's writes here that make a past milestone, an add or a save
  // that moves one into a past week. The window counts those still waiting
  // for the server and notes whether the server saved one. While one waits,
  // or once one saved, Past shows even where the last first answer of
  // Upcoming said the project held none.
  const [pastWrites, setPastWrites] = useStateM({ waiting: 0, saved: false })
  const pastMade = pastWrites.saved || pastWrites.waiting > 0
  /** Counts a write that makes a past milestone as waiting, since its paint
      shows the milestone at once, and answers what runs, once, with the
      server's answer. That settles this write alone, so a refusal takes back
      only its own part of the mark and leaves another write's waiting or
      saved one. */
  const makePast = () => {
    setPastWrites((w) => ({ ...w, waiting: w.waiting + 1 }))
    return (saved: boolean) =>
      setPastWrites((w) => ({ waiting: w.waiting - 1, saved: w.saved || saved }))
  }
  // each section's search box, which stays once it showed
  const [searchable, setSearchable] = useStateM({ upcoming: false, past: false })
  for (const [side, section] of [
    ['upcoming', upcoming],
    ['past', past],
  ] as const)
    if (
      !searchable[side] &&
      (section.view.next !== null || section.text !== '' || section.view.dropped)
    )
      setSearchable({ ...searchable, [side]: true })

  const [initialDate] = useStateM(() => (init.week == null ? null : weekToISO(init.week)))
  const [name, setName] = useStateM('')
  const [date, setDate] = useStateM(() => initialDate ?? weekToISO(P.TODAY_WEEK))
  // a create in flight: Add waits for the server's answer
  const [adding, setAdding] = useStateM(false)
  // the draft as it is now, so an answer can tell whether it changed since
  const draftRef = useRefM({ name, date })
  draftRef.current = { name, date }
  const week = exactWeekForDate(date)
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
    const toPast = exactWeekForDate(date) < P.TODAY_WEEK
    // a past add shows Past's disclosure at once, as the paint does
    const settled = toPast ? makePast() : undefined
    setAdding(true)
    void P.addMilestone({ name: added, week: exactWeekForDate(date), project: project.id }).then(
      (saved) => {
        setAdding(false)
        settled?.(saved)
        if (!saved) return
        // a milestone that lands in a collapsed Past says where it went
        window.showToast?.(
          toPast && !pastOpenRef.current
            ? `Milestone “${added}” added to Past`
            : `Milestone “${added}” added`,
        )
        // a name or date changed while the add was in flight is the next one
        const draft = draftRef.current
        if (draft.name.trim() !== added || draft.date !== sent) return
        setName('')
        setDate(initialDate ?? weekToISO(P.TODAY_WEEK))
      },
    )
  }

  // what the window says before the answer names its project and Upcoming
  // answered, in place of its milestones. Once its milestones showed it
  // never says so again, so a project the store comes to hold only later
  // starts Upcoming beside an open editor, which keeps its place and draft.
  const [showed, setShowed] = useStateM(!init.id)
  const waiting = !!init.id && !!project && !upcomingIn && !showed
  const before = !!init.id && (projectId === null || waiting)
  if (!before && !showed) setShowed(true)
  const inUpcoming = (id: string) => upcoming.view.rows.some((m) => m.id === id)
  const inPast = (id: string) => pastOpen && past.view.rows.some((m) => m.id === id)
  // where an open editor stays: where its row showed as it opened, and for
  // the opened milestone where it first shows
  const [editPlace, setEditPlace] = useStateM<EditorPlace | null>(null)
  const placeOf = (id: string): EditorPlace =>
    inUpcoming(id) ? 'upcoming' : inPast(id) ? 'past' : 'top'
  if (editId !== null && editPlace === null && !before) setEditPlace(placeOf(editId))
  if (editId === null && editPlace !== null) setEditPlace(null)
  const editing = editId !== null && (editId !== init.id || answered)
  // the milestone of an open editor that no section shows, which the window
  // reads on its own (milestone:kept); the opened milestone has its read
  const keptId =
    editing && editId !== init.id && !before && !inUpcoming(editId) && !inPast(editId)
      ? editId
      : null
  const kept = useMilestoneGet(MILESTONE_KEPT, keptId)
  const keptRead = keptId ? kept.read : null
  // its answer, kept through a failure or a refusal and while it refreshes
  const keptAnswer = shownAnswer(keptRead)
  // a kept editor whose milestone the server no longer answers closes and
  // says so, as the opened milestone's does
  const [keptGone, setKeptGone] = useStateM(false)
  if (keptId && kept.read?.state === 'ok' && keptAnswer?.rows.length === 0) {
    setEditId(null)
    setKeptGone(true)
  }
  // the last row an editor showed, for a kept editor before its read answers
  const lastEdited = useRefM<MilestoneVM | null>(null)
  // each section's last place of its editor, where it stays once its row left
  const lastAt = useRefM<Record<EditorPlace, number>>({ top: 0, upcoming: 0, past: 0 })
  const startEdit = (id: string) => {
    setEditId(id)
    setEditPlace(placeOf(id))
    setKeptGone(false)
  }
  // the next milestone's phrase is emphasised on the first row of Upcoming's
  // answer when no search narrows it and it did not move on
  const nextId =
    upcoming.settled === '' && !upcoming.view.dropped ? (upcoming.view.rows[0]?.id ?? null) : null

  /* An open editor's milestone: the opened one from its answer, any other
     from the section that shows it, else from its own read, else as it
     last showed. `storedOf` reads the same source when asked, so a save
     sends what the editor showed. */
  const editedRow = (id: string): MilestoneVM | null =>
    id === init.id
      ? openedM
      : (upcoming.view.rows.find((m) => m.id === id) ??
        (pastOpen ? past.view.rows.find((m) => m.id === id) : undefined) ??
        keptAnswer?.rows[0] ??
        (lastEdited.current?.id === id ? lastEdited.current : null))
  const storedOf = (id: string) => () =>
    id === init.id
      ? shownAnswer(P.milestoneRead(MILESTONE_OPEN))?.stored.get(id)
      : (upcoming.storedOf(id) ??
        past.storedOf(id) ??
        shownAnswer(P.milestoneRead(MILESTONE_KEPT))?.stored.get(id))
  /* The editor of `m`. It stays, locked with its draft, once the person may
     no longer change its milestone, and says so, or says that the window
     can no longer tell (rightUnknown). A kept editor takes its right from
     its own read once it answered, keeps it through a later failure or
     refusal, and has none while that read was refused before any answer,
     as the server could not confirm it. Until that read first answers,
     loading or failed, a kept editor waits with its Save and Delete off,
     also while another read still holds its milestone, such as a hidden
     page's stopped one, so a save or delete takes its row and organization
     from that read's answer, not from the stopped read. */
  const editorOf = (m: MilestoneVM) => {
    const own = m.id === init.id
    lastEdited.current = m
    const isKept = !own && keptId === m.id
    const keptRight = isKept && keptAnswer !== null
    const keptRefused = isKept && !keptRight && keptRead?.state === 'refused'
    const keptWaiting = isKept && !keptRight && !keptRefused
    const right = own
      ? openedCanWrite
      : keptRight
        ? !!keptAnswer?.canWrite
        : !keptRefused && canWrite
    return (
      <MilestoneEditor
        key={m.id}
        m={m}
        storedOf={storedOf(m.id)}
        waiting={keptWaiting ? (keptRead?.state === 'failed' ? 'failed' : 'loading') : undefined}
        locked={!right}
        lockedNote={
          (rightUnknown && !keptRight) || keptRefused
            ? 'This window can no longer confirm your access. Close the window and open this milestone again to change it.'
            : undefined
        }
        onClose={() => setEditId(null)}
        onDelete={own ? () => setDeletedHere(true) : undefined}
        onPastMove={makePast}
      />
    )
  }
  const rowOf = (m: MilestoneVM, own: boolean) => (
    <MilestoneRowView
      key={m.id}
      m={m}
      next={nextId === m.id}
      opened={own}
      onEdit={(own ? openedCanWrite : canWrite) ? () => startEdit(m.id) : undefined}
    />
  )
  /* A section's milestones: its rows in the server's order, the opened one
     from its answer, the editor in its place where it stays here, at its
     last place once its row left, and none of a milestone whose editor
     shows elsewhere or that is gone. */
  const itemsOf = (place: 'upcoming' | 'past', rows: readonly MilestoneVM[]) => {
    const items: ReactNodeM[] = []
    let editorAt = -1
    for (const m of rows) {
      if (gone && m.id === init.id) continue
      const shown = m.id === init.id && openedM ? openedM : m
      if (editing && m.id === editId) {
        if (editPlace === place) {
          editorAt = items.length
          items.push(editorOf(shown))
        }
        continue
      }
      items.push(rowOf(shown, m.id === init.id))
    }
    if (editing && editId !== null && editPlace === place && editorAt < 0) {
      const m = editedRow(editId)
      if (m) {
        editorAt = Math.min(lastAt.current[place], items.length)
        items.splice(editorAt, 0, editorOf(m))
      }
    }
    if (editorAt >= 0) lastAt.current[place] = editorAt
    return items
  }
  // above the sections: the opened milestone where no shown section holds
  // it, and an editor that stays here
  const top: ReactNodeM[] = []
  if (!before && openedM && !gone) {
    if (editing && editId === openedM.id) {
      if (editPlace === 'top' || !project) top.push(editorOf(openedM))
    } else if (!project || (!inUpcoming(openedM.id) && !inPast(openedM.id)))
      top.push(rowOf(openedM, true))
  }
  if (!before && editing && editId !== null && editId !== init.id && editPlace === 'top') {
    const m = editedRow(editId)
    if (m) top.push(editorOf(m))
  }
  const upcomingItems = project ? itemsOf('upcoming', upcoming.view.rows) : []
  const pastItems = project ? itemsOf('past', pastOpen ? past.view.rows : []) : []
  // Past shows once Upcoming's first answer came, failed or was refused,
  // unless Upcoming knows the project holds no past milestone (its `past`,
  // unknown once it moved on) and the person made none here
  const showPast =
    !!project &&
    upcomingIn &&
    (pastOpen || editPlace === 'past' || pastMade || upcoming.view.past !== false)
  const pastBodyId = useIdM()

  const openState = !init.id
    ? undefined
    : read === null || read.state === 'loading'
      ? 'loading'
      : read.state === 'ok'
        ? gone
          ? 'gone'
          : !openedM && !answered
            ? 'unavailable'
            : waiting
              ? 'loading'
              : read.current
                ? 'ok'
                : 'refreshing'
        : read.state === 'refused' || read.state === 'failed'
          ? read.state
          : 'loading'
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
          <div className="flex flex-col gap-6">
            {(read?.state === 'failed' ||
              read?.state === 'refused' ||
              keptRead?.state === 'failed' ||
              keptRead?.state === 'refused' ||
              gone ||
              keptGone) && (
              <div className="flex flex-col gap-2">
                {read?.state === 'failed' && (
                  <MilestoneLine state="failed" retry={opened.retry}>
                    Couldn't load the latest version of this milestone.
                  </MilestoneLine>
                )}
                {read?.state === 'refused' && (
                  <MilestoneLine state="refused">{read.sentence}</MilestoneLine>
                )}
                {/* the read of the milestone an editor no section shows */}
                {keptRead?.state === 'failed' && (
                  <MilestoneLine state="failed" kept retry={kept.retry}>
                    Couldn't load the latest version of this milestone.
                  </MilestoneLine>
                )}
                {keptRead?.state === 'refused' && (
                  <MilestoneLine state="refused" kept>
                    {keptRead.sentence}
                  </MilestoneLine>
                )}
                {(gone || keptGone) && (
                  <MilestoneLine state="gone">
                    This milestone is no longer here. It was deleted, or you can no longer open it.
                  </MilestoneLine>
                )}
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
            {/* the opened milestone where no section holds it, and an editor
                that stays above the sections; always here, so an editor in
                it keeps its place */}
            <div data-milestone-top className={cn('flex flex-col gap-1', !top.length && 'hidden')}>
              {top}
            </div>
            {project && (
              <MilestoneSectionPart
                side="upcoming"
                section={upcoming}
                open
                searchable={searchable.upcoming}
                pastKnown={upcoming.view.past === false && !pastMade}
                header={
                  <div className="mb-2 flex items-center gap-2 text-md font-semibold text-text-1">
                    Upcoming
                    {upcoming.view.count !== null && (
                      <span data-milestone-count className="font-normal text-text-3">
                        {upcoming.view.count}
                      </span>
                    )}
                  </div>
                }
              >
                {upcomingItems}
              </MilestoneSectionPart>
            )}
            {project && (showPast || pastItems.length > 0) && (
              <MilestoneSectionPart
                side="past"
                section={past}
                open={pastOpen}
                searchable={searchable.past}
                bodyId={pastBodyId}
                header={
                  <Button
                    type="button"
                    variant="ghost"
                    data-milestone-past-toggle
                    aria-expanded={pastOpen}
                    aria-controls={pastBodyId}
                    onClick={() => setPastOpen((open) => !open)}
                    className="mb-2 -ml-2 gap-1.5 self-start px-2 text-md font-semibold text-text-1"
                  >
                    <Icon
                      name={pastOpen ? 'chevronDown' : 'chevronRight'}
                      size={14}
                      color="var(--text-2)"
                    />
                    Past
                    {pastOpen && past.view.count !== null && (
                      <span data-milestone-count className="font-normal text-text-3">
                        {past.view.count}
                      </span>
                    )}
                  </Button>
                }
              >
                {pastItems}
              </MilestoneSectionPart>
            )}
          </div>
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
   `storedOf` answers the milestone's stored name and day as the row it
   renders from holds them now (a milestone read's answer,
   MilestoneAnswer.stored); the save sends them as what the person saw, and
   a refused save rebases on them as they are once the store took its paint
   back.
   `waiting` keeps Save and Delete off, and Enter from saving, while the
   window's own read of a kept editor's milestone has not answered yet.
   With `loading` the editor says so under the fields; with `failed` the
   window's failure line with Retry says why. The draft stays editable.
   `locked` keeps the typed text read-only once the person may no longer
   change the milestone, and `lockedNote` says why under it. The Name box
   takes focus when the editor opens, unless the person already moved focus
   inside the window. The window moves an open editor among its section's
   rows as they move, and a browser blurs an element it moves, as React
   moves the editor's own node to a later place; React DOM focuses the
   element that held focus again after that commit, with its selection
   (restoreSelection), so typing goes on where the person left it
   (panels/milestoneWindow.test.tsx pins both directions). */
function MilestoneEditor({
  m,
  storedOf,
  waiting,
  locked = false,
  lockedNote = 'You can no longer change this milestone.',
  onClose,
  onDelete,
  onPastMove,
}: {
  m: MilestoneVM
  storedOf: () => { name: string; week: string } | undefined
  /** the kept editor's own read, which has not answered yet */
  waiting?: 'loading' | 'failed'
  locked?: boolean
  lockedNote?: string
  onClose: () => void
  /** runs as the person deletes the milestone here */
  onDelete?: () => void
  /** runs as a save moves the milestone into a past week, and answers what
      runs with whether the server saved it */
  onPastMove?: () => (saved: boolean) => void
}) {
  // the name and day stored when the editor opened, which the save sends as
  // what the person saw. After a save refused over someone else's change,
  // the draft stays and their version becomes it once it shows (rebase), so
  // a second Save replaces it on purpose. Read when asked, never as of the
  // last render: a refusal's keepDraft runs right after the store took the
  // person's paint back, before React renders again.
  const storedNow = () => storedOf() ?? undefined
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
    !locked &&
    !waiting &&
    name.trim().length > 0 &&
    !overLimit(LIMITS.milestoneName, name) &&
    !saving
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
    const moved = week !== m.week && week < P.TODAY_WEEK ? onPastMove?.() : undefined
    void P.updateMilestone(m.id, { name: name.trim(), week }, seen, keepDraft).then((saved) => {
      moved?.(saved)
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
      if (locked || waiting || P.refusePausedEdit()) return
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
          {lockedNote}
        </p>
      )}
      {!locked && waiting === 'loading' && (
        <p data-milestone-editor-wait className="mt-2 mb-0 pl-6 text-sm text-text-3">
          Loading this milestone…
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
        <span className="text-xs text-text-3">Week {P.weekNumberOf(week).num}</span>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={locked || !!waiting}
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
