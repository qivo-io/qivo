/* Issue detail — top-anchored floating modal over a blurred scrim.
   Everything is editable in place: title, status, priority, assignee,
   reviewer, remaining, description, roadmap timeline, dependency links
   (add/remove), sub-issues.
   The details card (right) owns the window chrome: an actions menu
   (copy ID, copy link, move to another sub-project, delete) and close. */

import React, {
  type ReactNode,
  Suspense,
  useContext as useContextID,
  useEffect as useEffectID,
  useId as useIdID,
  useLayoutEffect as useLayoutEffectID,
  useRef as useRefID,
  useState as useStateID,
} from 'react'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { HoverTooltip } from '@/components/ui/tooltip'
import { hasTooltip } from '@/lib/passEscapeOn'
import { cn } from '@/lib/utils'
import { usePlannerVersion } from '@/store/usePlannerVersion'
import { LIMITS, MIB } from '../../convex/lib/limits'
import type { DescEditorHandle } from '../components/descEditor'
import { IssueSubscribers } from '../components/IssueSubscribers'
import { LimitedTextarea } from '../components/LimitedField'
import { Markdown } from '../components/markdown'
import {
  Avatar,
  DateInput,
  DateSelect,
  FieldSelect,
  Icon,
  IssueKey,
  MenuItem,
  Popover,
  PriorityIcon,
  ProgressBar,
  ProjectName,
  Seg,
  StatusDot,
  UnreadDivider,
} from '../components/qivo'
import { ViewBoundary } from '../components/ViewBoundary'
import { fmtSize, useWindowDropGuard } from '../lib/attachments'
import { copyText } from '../lib/clipboard'
import { DELAY_MARK, DELAY_UNKNOWN } from '../lib/delay'
import { dayInSentence, deletedAtFull } from '../lib/deletedTime'
import { closeOrAsk, questionOpen } from '../lib/discardQuestion'
import { limitSentence, overLimit } from '../lib/fieldLimits'
import { roomBeside, useFloatInsets } from '../lib/floatStack'
import { lastInputWasPointer, restoreFocus } from '../lib/focusVisibility'
import { lazyFromModule } from '../lib/lazyModule'
import {
  type UnsentScope,
  UnsentScopeContext,
  useFieldUnsaved,
  useUnsaved,
  useUnsentScope,
} from '../lib/leaveGuard'
import { parentBlock, subtaskBlock } from '../lib/relationCandidates'
import { remainingPatchFromInput, remainingValue } from '../lib/remaining'
import { DONE_WITHOUT_DATES, doneWithoutDates } from '../lib/roadmapVisibility'
import { buildPath, issueLink, sameTask } from '../lib/router'
import { SCROLL_ANCHORING } from '../lib/scrollAnchoring'
import {
  itemUnreadStart,
  mergeSpine,
  newerRow,
  spineGap,
  spineWindow,
  splitSpine,
  type UnreadStart,
  unreadMark,
} from '../lib/spine'
import { attachmentBlock, linkBlock } from '../lib/taskCaps'
import { markTaskFocus, restoreTaskFocus } from '../lib/taskFocus'
import { type RefParts, refParts } from '../lib/taskReference'
import { groupTotals, workspaceTotals } from '../lib/taskSections'
import { useUpdateBlocker } from '../lib/updateSafety'
import { useBottomSnap } from '../lib/useBottomSnap'
import { useConfirmArm } from '../lib/useConfirmArm'
import { useMobile } from '../lib/useMobile'
import { OUT_OF_USE } from '../lib/viewHidden'
import { loadDescEditor } from '../lib/workspaceChunks'
import '../styles/mobile-issue.css'
import {
  type ActivityVM,
  type CommentsEarlier,
  type CommentsFailure,
  type CommentVM,
  type IssueVM,
  P,
  type RelatedTaskVM,
  type SectionAttachmentVM,
  type SectionName,
  type SectionVM,
  type TaskDetailVM,
  type TaskRefVM,
  type TaskSectionsVM,
} from '../store/planner'
import { LabelPickerPopup } from './LabelPicker'
import {
  ArchiveOrDeleteTaskModal,
  FAMILY_UNKNOWN,
  MoveIssueModal,
  WAITS_FOR_CHECK,
  WAITS_FOR_TASKS,
} from './Modals'
import { type CurrentRelation, type CurrentRelations, RelationPicker } from './RelationPicker'
import { useTaskKey } from './taskKey'
import { useTaskLabels } from './taskLabels'

// the editor chunk (~150 KB gz of TipTap) loads only for users who can edit,
// after the workspace's first paint (App.tsx); viewers render the plain
// Markdown component
const DescEditor = lazyFromModule(loadDescEditor, (module) => module.default)

/** Shows `fallback` while the editor loads, and in its place while the
 * editor's code waits for the connection (editing waits then anyway). */
function EditorSlot({ fallback, children }: { fallback: ReactNode; children: ReactNode }) {
  return (
    <ViewBoundary whileWaiting={fallback}>
      <Suspense fallback={fallback}>{children}</Suspense>
    </ViewBoundary>
  )
}
const NO_PROFILE = '__none__'
/* WAITS_FOR_TASKS (from Modals.tsx) says why moving, archiving or deleting
   a task the workspace holds waits before it holds every task and no answer
   of its own serves its subtasks, as for the person's new task during a
   load, since each acts on subtasks and blockers that may be still to
   arrive. WAITS_FOR_CHECK says why a change to a task
   the window shows from its own read waits while that read failed or runs
   again, the Parent, Subtasks and Linked tasks changes included, and
   FAMILY_UNKNOWN why Move and Archive or delete are off while that read
   holds no whole subtask list. */
/* Why the fields of an archived task the window shows read-only are off,
   for someone who could restore it. */
const RESTORE_TO_CHANGE = 'Restore this task to change it'
/* Why a control is off for someone who can only read the project. */
const READ_ONLY = 'Read-only project access'

/* One task in Parent, Subtasks or Linked tasks, from its row model
   (RelatedTaskVM): the workspace's view of a task it holds, else the
   section answer's short row, so a task still to arrive in a large
   workspace is listed rather than left out. Opening it passes its handle
   on, or for a task the workspace does not hold, a reference with its
   organization, number and uuid (lib/taskReference.ts), so the window
   shows it from its own read and the address names it. Its × removes the
   relation from the row as the window shows it, whether or not the
   workspace holds the task, and shows busy until that write answers. */
function MiniIssueRow({
  task,
  onOpen,
  relation,
  remove,
}: {
  task: RelatedTaskVM
  onOpen: (id: string) => void
  relation?: { label: string; glyph: string; completedLabel?: string }
  // disabled when the server would refuse the removal for read-only access,
  // with `hint` saying why when it is another reason, and `busy` while its
  // write is on its way, so a second press sends nothing
  remove?: {
    label: string
    onClick: () => void
    disabled?: boolean
    hint?: string
    busy?: boolean
  }
}) {
  const proj = P.project(task.project)
  const done = task.done
  return (
    <div
      data-related-task={task.handle}
      data-control-fill
      className="flex w-full items-center rounded-md border border-border bg-surface-1 transition-colors hover:border-border-strong hover:bg-hover focus-within:border-border-strong"
    >
      <Button
        type="button"
        variant="unstyled"
        onClick={() => onOpen(task.held ? task.handle : P.openTask(task.uuid, task.org, task.num))}
        className="flex min-w-0 flex-1 self-stretch items-center gap-2 rounded-md p-2 text-left text-text-1 focus-visible:outline-2 focus-visible:outline-ring focus-visible:-outline-offset-2"
      >
        <span className="[display:flex] [flex-direction:column] [gap:2px] [flex:1] [min-width:0]">
          {/* the relation is a glyph and a word in the window's own voice — no
              fill, no border and no colour: a dependency is how the work was
              planned, not a problem to flag. A Done link keeps the glyph and
              the grey and only changes tense (#168) */}
          {relation && (
            <span className="flex h-5 items-center gap-1.5 self-start text-xs font-semibold text-text-2">
              <Icon name={relation.glyph} size={14} strokeWidth={2} />
              {done && relation.completedLabel ? relation.completedLabel : relation.label}
            </span>
          )}
          <span className="line-clamp-2 [font-size:var(--fs-base)] [line-height:1.4] [overflow-wrap:anywhere]">
            {task.title}
          </span>
          <span className="[font-size:var(--fs-xs)] [color:var(--text-3)] [max-width:100%] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
            <ProjectName project={proj} />
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {!task.isGroup && <StatusDot status={task.status} size={14} />}
          {task.owner && <Avatar id={task.owner} size={28} />}
        </span>
      </Button>
      {remove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="task-related-remove mr-1 h-control-sm w-control-sm shrink-0"
          aria-label={remove.label}
          title={remove.disabled ? (remove.hint ?? READ_ONLY) : remove.label}
          disabled={remove.disabled}
          aria-busy={remove.busy || undefined}
          {...(remove.busy ? { 'data-remove-busy': '' } : {})}
          onClick={() => {
            if (!remove.busy) remove.onClick()
          }}
        >
          <Icon name="close" size={16} />
        </Button>
      )}
    </div>
  )
}

function DetailField({
  label,
  children,
  person = false,
}: {
  label: React.ReactNode
  children?: React.ReactNode
  person?: boolean
}) {
  return (
    <div className={`task-field${person ? ' task-field-person' : ''}`}>
      {/* Align labels with the first control, including taller portraits;
          wrapping Plan content must not pull its label down the whole stack. */}
      <div className="task-field-label">{label}</div>
      <div className="task-field-value">{children}</div>
    </div>
  )
}
function SectionHead({
  icon,
  label,
  children,
  inlineAction = false,
}: {
  icon?: string
  label: React.ReactNode
  children?: React.ReactNode
  inlineAction?: boolean
}) {
  return (
    <div className={`task-section-head${inlineAction ? ' task-section-head-inline' : ''}`}>
      {icon && <Icon name={icon} size={16} color="var(--text-3)" />}
      <span className="[font-size:var(--fs-md)] [font-weight:600] [color:var(--text-1)]">
        {label}
      </span>
      {children}
    </div>
  )
}

/* One section of the task, alone in its own window — the description, or the
   Activity thread — for when there is too much of it to read in a column
   sharing the window with everything else.

   It is deliberately SMALLER than the task window it opens over (and inset on
   all four sides, top-anchored a step lower), because the whole point is that
   you can see it is a new window standing on the old one rather than the same
   one having changed shape.

   The section it shows is NOT mounted twice: the caller stops rendering its
   in-place copy while this is up. That is what keeps one description editor
   and one composer on screen — two would be two drafts of one field, and the
   store has one thread. The window covers most of the gap behind, and its
   backdrop blurs the rest.

   Escape and the outside click are ModalShell's, verbatim, including the
   [data-modal-shell] hook — the task window underneath reads it to leave
   Escape alone, exactly as it does for the Move and Archive dialogs.

   The shell only. Everything inside — the task window's own two-line heading
   and then the section — is the caller's, because it is the CALLER's window
   that this is a view of: `name` is here for the drives, not for the user,
   who is told which task this is by the same breadcrumb and title the window
   behind is showing. */
function FocusWindow({
  name,
  onClose,
  scope,
  children,
}: {
  name: string
  /** asks first while `scope` holds unsent text (DiscardPrompt) */
  onClose: () => void
  /** the text typed in this window, which closing it throws away: the
      section's editors mount again in the column behind */
  scope: UnsentScope
  children?: React.ReactNode
}) {
  useEffectID(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      // the discard question, which opens above this window, owns the key
      if (questionOpen()) return
      // a tooltip, open or closing, takes the Escape first and passes it on,
      // read then
      if (hasTooltip()) return
      if (
        e.target instanceof Element &&
        e.target.closest('[data-slot="popover-content"], [data-slot="select-content"]')
      )
        return
      // the description editor owns Escape while focus is inside it
      const t = e.target
      if (t instanceof Element && t.closest('.ProseMirror, [data-mdpop], [data-mdtoolbar]')) return
      if (document.querySelector('[data-anchoredpop-backdrop]')) return
      e.stopImmediatePropagation()
      onClose()
    }
    const hb = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    window.addEventListener('keydown', h, true)
    window.addEventListener('keydown', hb, false)
    return () => {
      window.removeEventListener('keydown', h, true)
      window.removeEventListener('keydown', hb, false)
    }
  }, [onClose])
  // Drawn in #root, not where the task is. The desktop Inbox draws its task in
  // a pane that blurs the photo, and that pane would clip this fixed window
  // and cut off its blur. Menus opened inside it portal to <body>, above #root.
  return createPortal(
    <div
      data-modal-shell
      data-focus-window={name}
      onMouseDown={onClose}
      className="[position:fixed] [inset:var(--float-inset-top)_0_var(--float-inset-bottom)] [z-index:100] [display:grid] [place-items:start_center] [padding:8vh_6vw]"
    >
      {/* 980 × 84vh against the task window's 1110 × 92vh, and 8vh down its
          4vh: a clear inset on every side, whichever frame it came from */}
      <div
        data-issue-design="alignment"
        data-floating-surface
        className="animate-in fade-in zoom-in-95 [width:980px] [max-width:88vw] [height:calc(84vh-var(--float-inset-y))] [display:flex] [flex-direction:column] [background:var(--background)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-pop)] [overflow:hidden]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <UnsentScopeContext.Provider value={scope}>{children}</UnsentScopeContext.Provider>
      </div>
      {/* The backdrop stands beside the window, under it, rather than around
          it, so the window's own blur still reaches the page (appearance.css).
          Last, so the phone rules for the shell's first child keep the window. */}
      <div data-scrim aria-hidden="true" className="[position:fixed] [inset:0] [z-index:-1]" />
    </div>,
    document.getElementById('root') ?? document.body,
  )
}

/* One glyph per relation, read from the open task: `|→` (blocks) leaves it
   for the row's task, `→|` (blocked by) runs into it from the row's task, and
   `⇆` (relates to) has no direction. None of them spends a colour. */
const relMapID = {
  blocks: { label: 'Blocks', glyph: 'arrowRightFromLine', completedLabel: 'Previously blocked' },
  blocked_by: { label: 'Blocked by', glyph: 'arrowRightToLine', completedLabel: 'Was blocked by' },
  relates: { label: 'Relates to', glyph: 'arrowLeftRight' },
}

/* A section of a task whose lists are not known yet: while a large
   workspace still loads, before the section's answer (P.sectionsFor), it
   reads as loading, never as another task's lists or as empty. */
const LOADING_SECTION: SectionVM<never> = {
  state: 'loading',
  rows: [],
  complete: false,
  delivered: false,
  source: 'answer',
}

/* An archived group's Progress and Remaining: its answer holds none of its
   subtasks, so both are unknown (the limits plan's item 2). */
const UNKNOWN_TOTALS: ReturnType<typeof groupTotals> = {
  progress: { state: 'unknown', partial: false },
  remaining: { state: 'unknown' },
}

/* What each section's lines call its rows, and the section. */
const SECTION_WORDS: Record<SectionName, { what: string; name: string }> = {
  subtasks: { what: 'subtasks', name: 'Subtasks' },
  links: { what: 'linked tasks', name: 'Linked tasks' },
  attachments: { what: 'attachments', name: 'Attachments' },
}

/* A section's state as its data-section-state says it, for drives and
   tests: loading, failed, retrying, unavailable, incomplete or complete. */
const sectionMark = (section: SectionVM<unknown>) =>
  section.state === 'ready' ? (section.complete ? 'complete' : 'incomplete') : section.state

/* A section heading's count, " (n)", only for a whole list with rows. */
const countOf = (section: SectionVM<unknown>) =>
  section.state === 'ready' && section.complete && section.rows.length > 0
    ? ` (${section.rows.length})`
    : ''

/* The line section `name` shows beside its rows, or null: while its list
   loads, after its read failed (LoadFailure, with Retry) and while Retry
   runs, when the server no longer lets this window list the task, under a
   list a read budget cut short, and `empty` for a whole list without rows.
   So a list that is not whole never reads as empty. */
function sectionNote(name: SectionName, section: SectionVM<unknown>, empty: string | null) {
  const { what, name: title } = SECTION_WORDS[name]
  const shown = section.rows.length > 0
  if (section.state === 'failed' || section.state === 'retrying')
    return (
      <LoadFailure
        state={section.state}
        what={what}
        shown={shown}
        onRetry={() => P.retrySection(name)}
        marks={{ 'data-section-failure': section.state, 'data-section-side': name }}
      />
    )
  const text =
    section.state === 'loading'
      ? `Loading ${what}…`
      : section.state === 'unavailable'
        ? `${title} are not available.`
        : !section.complete
          ? `Some ${what} could not be loaded.`
          : shown
            ? null
            : empty
  if (!text) return null
  return (
    <div
      data-section-note={name}
      className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]"
    >
      {text}
    </div>
  )
}

/* One file in Attachments. Opening and downloading mint its URL on the
   press (P.attachmentUrl), also for a file only the section's answer holds.
   Removing a file the workspace holds takes it off the list at once; one
   only the section's answer holds, as of a task shown from its own read,
   shows busy from the confirming press until that answer drops it, which
   is when the removal resolves, and a refusal leaves it. */
function AttachmentRow({ att, canEdit }: { att: SectionAttachmentVM; canEdit: boolean }) {
  const removal = useConfirmArm<'remove'>()
  const arm = removal.armed !== null
  const [removing, setRemoving] = useStateID(false)
  const mounted = useRefID(true)
  useEffectID(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const remove = () => {
    const sent = P.removeAttachment(att.id)
    if (att.held) return
    setRemoving(true)
    void sent.then(() => {
      if (mounted.current) setRemoving(false)
    })
  }
  const openIt = async (download: boolean) => {
    const url = await P.attachmentUrl(att.id, download)
    if (!url) return
    const a = document.createElement('a')
    a.href = url
    a.target = '_blank'
    a.rel = 'noopener'
    a.click()
  }
  const by = att.by ? P.user(att.by) : null
  return (
    <div className="[display:flex] [align-items:center] [gap:8px] [padding:8px] [border-radius:var(--r-md)] [border:1px_solid_var(--border)] [background:var(--surface-1)]">
      <Icon name="paperclip" size={14} color="var(--text-3)" />
      <Button
        type="button"
        data-attachment-open={att.name}
        onClick={() => openIt(false)}
        title={`Open ${att.name}${by ? `. Added by ${by.name}` : ''}`}
        className="[display:flex] [flex-direction:column] [align-items:flex-start] [gap:2px] [flex:1] [min-width:0] [text-align:left] [background:none] [border:none] [padding:0] [cursor:pointer] [color:var(--text-1)] [font-size:var(--fs-base)]"
        variant="unstyled"
      >
        <span className="line-clamp-2 [line-height:1.4] [overflow-wrap:anywhere]">{att.name}</span>
        <span className="[font-size:var(--fs-xs)] [color:var(--text-3)] !font-mono">
          {fmtSize(att.size)}
        </span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="w-control-sm h-control-sm [flex-shrink:0]"
        aria-label="Download"
        title="Download"
        onClick={() => openIt(true)}
      >
        <Icon name="download" size={16} />
      </Button>
      {canEdit && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          style={{ color: arm ? 'var(--danger)' : undefined }}
          className="w-control-sm h-control-sm [flex-shrink:0]"
          aria-label={arm ? 'Confirm removal' : 'Remove attachment'}
          aria-busy={removing || undefined}
          data-attachment-removing={removing ? '' : undefined}
          title={removing ? 'Removing…' : arm ? 'Confirm removal' : 'Remove attachment'}
          disabled={removing}
          onClick={() => removal.press('remove', remove)}
        >
          <Icon name={arm ? 'trash' : 'close'} size={16} />
        </Button>
      )}
    </div>
  )
}

/* Attachments, from the task's own attachments answer merged with the
   person's own writes on their way (P.sections). Its line says the list is
   loading, could not load (with Retry), is not available, or was cut short
   (sectionNote), so a list that is not whole never reads as empty. "No
   attachments." shows only for a whole list without files, to a person
   without edit access; an editor keeps the drop zone. The browse control
   keeps the cap check before a write (attachmentBlock) on the larger of the
   workspace's count and the whole list's (P.capInputs). */
function AttachmentsSection({
  it,
  canEdit,
  section,
}: {
  it: IssueVM
  canEdit: boolean
  section: TaskSectionsVM['attachments']
}) {
  const [drag, setDrag] = useStateID(false)
  const [uploading, setUploading] = useStateID([] as string[])
  const inputRef = useRefID<HTMLInputElement>(null)
  useWindowDropGuard()
  const limitMb = Math.round(P.attachmentLimit(it.id) / MIB)
  const list = section.rows
  // the per-task cap, files and description images together
  const full = attachmentBlock(P.capInputs(it).attachments)
  const note = sectionNote('attachments', section, canEdit ? null : 'No attachments.')
  // attach by uuid: on a just-created issue the derived key in the closure's
  // `it` can renumber while the INSERT is in flight, which would strand (or
  // mis-target) every file after the first
  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files || [])) {
      setUploading((u) => [...u, f.name])
      try {
        await P.addAttachment(it.uuid, f)
      } finally {
        setUploading((u) => {
          const n = u.slice()
          const i = n.indexOf(f.name)
          if (i >= 0) n.splice(i, 1)
          return n
        })
      }
    }
  }
  return (
    <section
      className="task-section"
      data-section="attachments"
      data-section-state={sectionMark(section)}
      data-section-source={section.source}
    >
      <SectionHead icon="paperclip" label={`Attachments${countOf(section)}`} />
      {list.length > 0 || uploading.length > 0 ? (
        <div
          style={{ marginBottom: canEdit ? 8 : 0 }}
          className="[display:flex] [flex-direction:column] [gap:6px]"
        >
          {list.map((a) => (
            <AttachmentRow key={a.id} att={a} canEdit={canEdit} />
          ))}
          {uploading.map((n, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: transient upload placeholders — the same file name can be in flight twice, so the name alone is not unique
              key={n + i}
              className="flex items-center gap-2 p-2 rounded-md border border-dashed border-border-strong bg-surface-2 text-sm text-text-3"
            >
              <Icon name="paperclip" size={16} color="var(--text-3)" />
              <span className="[flex:1] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                Uploading {n}…
              </span>
            </div>
          ))}
          {note}
        </div>
      ) : (
        note && <div className={canEdit ? '[margin-bottom:8px]' : undefined}>{note}</div>
      )}
      {canEdit && (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            setDrag(true)
          }}
          // crossing an inner element (browse, the hint) fires dragleave too —
          // only un-highlight when the drag actually leaves the zone
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            // a full task refuses in the store, with its toast
            void addFiles(e.dataTransfer.files)
          }}
          style={{
            border: `1px dashed ${drag ? 'var(--primary)' : 'var(--border-strong)'}`,
            background: drag ? 'var(--surface-2)' : 'transparent',
          }}
          className="[border-radius:var(--r-md)] [padding:13px_12px] [text-align:center] [transition:background-color_var(--dur-fast)_var(--ease-out),_border-color_var(--dur-fast)_var(--ease-out)] [font-size:var(--fs-sm)] [color:var(--text-3)]"
        >
          Drop files here, or{' '}
          <Button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={!!full}
            title={full}
            className="[background:none] [border:none] [padding:0] [cursor:pointer] [color:var(--text-1)] [font-size:var(--fs-sm)] [font-family:var(--sans)] underline underline-offset-2 disabled:[cursor:not-allowed] disabled:[opacity:0.5]"
            variant="unstyled"
          >
            browse
          </Button>
          <div className="[font-size:var(--fs-xs)] [margin-top:3px]">
            {full ?? `Max ${limitMb} MiB per file`}
          </div>
          <Input
            ref={inputRef}
            type="file"
            multiple
            className="[display:none]"
            onChange={(e) => {
              void addFiles(e.target.files)
              e.target.value = ''
            }}
          />
        </div>
      )}
    </section>
  )
}

/* The window's two columns stack below 1150px (side by side they no longer
   fit the viewport), matching the mockup's breakpoint. */
function useNarrow() {
  const [narrow, setNarrow] = useStateID(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(max-width: 1150px)').matches,
  )
  useEffectID(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(max-width: 1150px)')
    const h = () => setNarrow(mq.matches)
    mq.addEventListener('change', h)
    return () => mq.removeEventListener('change', h)
  }, [])
  return narrow
}

/* The embedded frame never stacks: it has ONE column. `narrow` exists to
   decide whether the details column fits beside the discussion, and the inbox
   pane doesn't render one — so the question the measurement answered no longer
   arises there, and the whole thing is a plain `false`. (This is what the
   layout-effect box measurement introduced by the first cut of the pane was
   for; a single-column pane retired it.) */

/* Spine node glyph per activity verb — only verbs the store actually logs
   (planner.ts logActivity call sites); anything unknown gets the dot. */
function evIcon(verb: string) {
  if (verb === 'created') return 'plus'
  if (verb === 'moved' || verb === 'detached') return 'arrowRight'
  if (verb === 'assigned' || verb === 'unassigned') return 'user'
  if (verb.includes('reviewer')) return 'user'
  if (verb === 'reprioritized') return 'flag'
  if (verb === 'renamed' || verb === 'updated' || verb.includes('description')) return 'pen'
  if (verb === 'paused') return 'pause'
  if (verb === 'resumed') return 'play'
  if (verb === 'linked') return 'link'
  if (verb.includes('remaining time')) return 'history' // the clock-shaped glyph in this icon set
  if (
    verb.includes('due date') ||
    verb === 'rescheduled' ||
    verb === 'scheduled' ||
    verb === 'removed from the roadmap'
  )
    return 'calendar'
  if (verb.includes('file') || verb.includes('image') || verb.includes('attachment'))
    return 'paperclip'
  if (verb.includes('label')) return 'tag'
  return 'dot'
}

/* The ring that used to mask the spine hairline behind an avatar/glyph node is
   gone with the hairline itself (deviation #65) — it was a 4px halo painted in
   --surface-1 for the sole purpose of cutting the rule, and with nothing to cut
   it is a faint disc around every node on a card that isn't --surface-1. The
   nodes keep their stacking context: they still overlap nothing, but the two
   call sites read as one shared idiom, and a later spine can restore the mask
   here without touching them. */
const spineNodeRing: React.CSSProperties = { position: 'relative', zIndex: 1 }

function EventRow({ e }: { e: ActivityVM }) {
  const u = e.actor ? P.user(e.actor) : null
  return (
    <div
      data-event={e.id}
      className="[display:flex] [align-items:center] [gap:10px] [min-height:28px]"
    >
      <span
        style={{ ...spineNodeRing }}
        className="[width:28px] [height:28px] [display:grid] [place-items:center] [background:var(--surface-2)] [border:1px_solid_var(--border)] [border-radius:50%] [color:var(--text-3)] [flex-shrink:0]"
      >
        <Icon name={evIcon(e.verb)} size={11} />
      </span>
      <span className="[font-size:var(--fs-sm)] [color:var(--text-3)] [min-width:0] [overflow-wrap:anywhere]">
        {/* same grammar as the activity bell (actor · verb · object · detail),
            with "this issue" for the object — the title is the modal itself */}
        <b className="[color:var(--text-1)] [font-weight:500]">{u ? u.name : 'Someone'}</b> {e.verb}{' '}
        this task{e.detail ? ` ${e.detail}` : ''}
        <HoverTooltip content={new Date(e.ts).toLocaleString()}>
          <span className="[font-size:var(--fs-xs)]">, {P.fmtAgo(e.ts)}</span>
        </HoverTooltip>
      </span>
    </div>
  )
}

/* The small pen after an edited comment's timestamp. Hover or keyboard focus
   pops the edit attribution: when + by whom (and that they were acting as
   project lead) when the editor wasn't the author. */
function EditedGlyph({ c, it }: { c: CommentVM; it: IssueVM }) {
  const foreign = !!c.editedBy && c.editedBy !== c.author
  const editor = c.editedBy ? P.user(c.editedBy) : null
  const lead = foreign && P.levelOn(it.project, c.editedBy) === 'lead'
  const tip =
    'Edited ' +
    new Date(c.editedTs).toLocaleString() +
    (foreign ? ` by ${editor ? editor.name : 'someone'}${lead ? ' (project lead)' : ''}` : '')
  return (
    <Button
      type="button"
      data-edited={c.id}
      aria-label={tip}
      title={tip}
      className="relative inline-grid place-items-center size-6 rounded-sm cursor-default border-0 bg-transparent p-0 text-text-3 hover:bg-hover hover:text-text-2 focus-visible:bg-hover focus-visible:text-text-2 [font:inherit] appearance-none"
      variant="unstyled"
    >
      <Icon name="pen" size={11} />
    </Button>
  )
}

/* The first row of a thread whose start is not loaded (P.commentsEarlier,
   and under All P.historyEarlier too). It is a muted "Show earlier comments"
   button above the oldest loaded comment, or "Show earlier activity" above
   the oldest loaded row under All, static text while the page above loads,
   and Retry when it failed. Each is one control tall, so the rows under it
   do not move when it changes. Its sibling NewerComments stands where the
   store let rows go between the two runs it keeps. */
function EarlierComments({
  state,
  what,
  onLoad,
}: {
  state: Exclude<CommentsEarlier, 'none'>
  what: 'comments' | 'activity'
  onLoad: (control: HTMLElement) => void
}) {
  if (state === 'loading') {
    return (
      <div
        data-earlier-comments="loading"
        className="flex min-h-control-sm items-center text-sm italic text-text-3"
      >
        Loading earlier {what}…
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div
        data-earlier-comments="failed"
        className="flex min-h-control-sm items-center gap-2 text-sm text-text-2"
      >
        Couldn't load earlier {what}.
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={(e) => onLoad(e.currentTarget)}
        >
          <Icon name="rotateCcw" size={16} />
          Retry
        </Button>
      </div>
    )
  }
  return (
    <div data-earlier-comments="more" className="-ml-2 flex min-h-control-sm items-center">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="gap-1.5 px-2"
        onClick={(e) => onLoad(e.currentTarget)}
      >
        <Icon name="chevronsUp" size={16} />
        Show earlier {what}
      </Button>
    </div>
  )
}

/* The row where the store let comments go between the two runs it keeps of
   a thread past its budget (P.commentsNewer, and under All
   P.historyNewer): a muted "Show newer comments" button, or "Show newer
   activity" under All, between the last row kept above the gap and the
   first kept below it, static text while the page under it loads, and
   Retry when it failed, in EarlierComments' style and height, so the rows
   around it do not move when it changes. */
function NewerComments({
  state,
  what,
  onLoad,
}: {
  state: Exclude<CommentsEarlier, 'none'>
  what: 'comments' | 'activity'
  onLoad: (control: HTMLElement) => void
}) {
  if (state === 'loading') {
    return (
      <div
        data-newer-comments="loading"
        className="flex min-h-control-sm items-center text-sm italic text-text-3"
      >
        Loading newer {what}…
      </div>
    )
  }
  if (state === 'failed') {
    return (
      <div
        data-newer-comments="failed"
        className="flex min-h-control-sm items-center gap-2 text-sm text-text-2"
      >
        Couldn't load newer {what}.
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={(e) => onLoad(e.currentTarget)}
        >
          <Icon name="rotateCcw" size={16} />
          Retry
        </Button>
      </div>
    )
  }
  return (
    <div data-newer-comments="more" className="-ml-2 flex min-h-control-sm items-center">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        className="gap-1.5 px-2"
        onClick={(e) => onLoad(e.currentTarget)}
      >
        <Icon name="chevronsDown" size={16} />
        Show newer {what}
      </Button>
    </div>
  )
}

/* The last row of a thread whose comment subscription failed
   (P.commentsFailure), or under All whose history subscription failed
   (P.historyFailure, `what` 'activity'), as LoadFailure says it, marked
   for the thread's drives and tests. */
function ThreadFailure({
  state,
  what = 'comments',
  shown,
  onRetry,
}: {
  state: Exclude<CommentsFailure, 'none'>
  what?: 'comments' | 'activity'
  shown: boolean
  onRetry: () => void
}) {
  return (
    <LoadFailure
      state={state}
      what={what}
      shown={shown}
      onRetry={onRetry}
      marks={{ 'data-thread-failure': state, 'data-thread-side': what }}
    />
  )
}

/* The row of a list whose subscription failed: it says so with Retry, and
   shows static text while the retry runs, in EarlierComments' style and
   height. `shown` says whether rows loaded before the failure are still on
   screen beside it, which then reads as the newest ones failing to load.
   `marks` are the data attributes its drives and tests find it by. */
function LoadFailure({
  state,
  what,
  shown,
  onRetry,
  marks,
}: {
  state: Exclude<CommentsFailure, 'none'>
  what: string
  shown: boolean
  onRetry: () => void
  marks: Record<`data-${string}`, string>
}) {
  if (state === 'retrying') {
    return (
      <div {...marks} className="flex min-h-control-sm items-center text-sm italic text-text-3">
        {shown ? `Loading the latest ${what}…` : `Loading ${what}…`}
      </div>
    )
  }
  return (
    <div {...marks} className="flex min-h-control-sm items-center gap-2 text-sm text-text-2">
      {shown ? `Couldn't load the latest ${what}.` : `Couldn't load ${what}.`}
      <Button type="button" variant="ghost" size="sm" className="px-2" onClick={onRetry}>
        <Icon name="rotateCcw" size={16} />
        Retry
      </Button>
    </div>
  )
}

/** What the window keeps of the task it shows, for once the task is gone:
    its uuid, organization, key, title and project. A task opened by a
    reference (lib/taskReference.ts) that this window has not shown is
    `opened`, with what the reference and its read name: no uuid before a
    read names it, and no key for a uuid alone. */
type ShownTask = Pick<IssueVM, 'uuid' | 'org' | 'title' | 'project'> & {
  key: string | null
  opened?: true
}

/** What became of a task the window shows no active task for, from its own
    read (P.taskDetail) or its reference's (P.reference): archived, with its
    row; null when it is no longer here, or for a task opened by a
    reference, when the server says it cannot be opened; 'failed' when the
    read failed; undefined while it is asked. */
type GoneAnswer =
  | { project: string; title: string; org: string; archivedAt: number }
  | null
  | 'failed'
  | undefined

/* The window's note on a task it shows no active task for, because it
   left the board while the window was open (someone archived or deleted
   it, or it moved where this person cannot open it), or because a task
   the workspace does not hold opened by a reference (lib/taskReference.ts),
   from a link, Back or Forward, Search, a list or a related row, from the
   window's own read of the task (`found`). It says the task was archived,
   with Restore for someone who can edit its project (`canRestore`), or
   that its project is archived too (`projectArchived`), or for a task the
   window showed that it is no longer here, or for one it never showed
   that it can't be opened, the same for every reason, with Retry where no
   read follows that answer (`retryUnavailable`), or that it could not be
   checked or opened, with Retry, or, while the read is asked, that the
   task left or is loading. A restored task comes back into the window. A
   reason typed in the task's
   Archive or delete window went unused, so the note says so and shows it
   to copy. Focus goes to the note when it was in the task's content, which
   went with the task, and never to a button, which the next key typed for
   that content would press. On a phone the note takes the width of the
   screen and the buttons go below it. A task opened that the window never
   showed shows its key and title, and once the read answers, its place
   and when it was archived. Above an archived task the window shows
   read-only (`inWindow`), the window around it says those, and the note
   says only what became of the task, and where it lives and when it was
   archived when the window has no details column to say it (`showPlace`). */
function TaskGone({
  task,
  found,
  canRestore,
  projectArchived = false,
  onRetry,
  retryUnavailable = false,
  inWindow = false,
  showPlace = false,
  unusedReason,
  onCopied,
  onClose,
  mobile,
}: {
  task: ShownTask
  found: GoneAnswer
  canRestore: boolean
  /** an archived task whose project is archived too, which Archived tasks
      lists only once the project is restored */
  projectArchived?: boolean
  onRetry: () => void
  /** a task opened by a reference that the server said can't be opened,
      which no read follows any more, so Retry reads it again */
  retryUnavailable?: boolean
  inWindow?: boolean
  /** above an archived task in a window without its details column, as
      the desktop Inbox pane: where it lives and when it was archived */
  showPlace?: boolean
  /** the reason typed for the Archive or delete window, which nothing sent */
  unusedReason: string | null
  /** the reason is on the clipboard, so closing need not ask about it */
  onCopied: (reason: string) => void
  onClose: () => void
  mobile: boolean
}) {
  const [restoring, setRestoring] = useStateID(false)
  const noteRef = useRefID<HTMLSpanElement>(null)
  useEffectID(() => {
    const active = document.activeElement
    if (!active || active === document.body) noteRef.current?.focus()
  }, [])
  const reasonRef = useRefID<HTMLParagraphElement>(null)
  // a refused copy leaves the reason selected, to copy by hand
  const copyReason = () => {
    if (!unusedReason) return
    void copyText(unusedReason).then((ok) => {
      if (ok) {
        onCopied(unusedReason)
        window.showToast?.('Copied the reason')
        return
      }
      if (reasonRef.current) window.getSelection()?.selectAllChildren(reasonRef.current)
      window.showToast?.("Couldn't copy. Copy the selected text instead.", 'error')
    })
  }
  const row = found === 'failed' ? undefined : found
  const restore = () => {
    if (!row) return
    setRestoring(true)
    // the archived row's own project and organization, which may not be
    // the ones the window last showed
    void P.unarchiveIssue(task.uuid, row.title, row.project, row.org).then((ok) => {
      // a restored task comes back into this window, which leaves this note
      if (ok) window.showToast?.(`Restored ${task.key ?? `"${row.title}"`}`)
      else setRestoring(false) // unarchiveIssue toasted why
    })
  }
  // Retry leaves with the failed answer, so focus stays on the note
  const retry = () => {
    noteRef.current?.focus()
    onRetry()
  }
  const opened = !!task.opened
  // a task opened by its uuid alone has no key to name until its read does
  const key = task.key ?? 'This task'
  const text =
    found === undefined
      ? opened
        ? `Loading ${task.key ?? 'this task'}…`
        : `${key} is no longer on the board.`
      : found === 'failed'
        ? opened
          ? `Couldn't open ${task.key ?? 'this task'}.`
          : `${key} is no longer on the board. Couldn't check the archive.`
        : found
          ? projectArchived
            ? `${key} was archived, and its project is archived too. Restore the project first, then the task from Archived tasks.`
            : canRestore
              ? `${key} was archived. Restore it to bring it back to the board.`
              : `${key} was archived. Someone who can edit its project can restore it from Archived tasks.`
          : opened
            ? `${key} can't be opened. It may not exist, or you may not have access to it.`
            : `${key} is no longer here. It was deleted, or you can no longer open it.`
  // the note says the reason went unused, and points a screen reader at it
  const reasonId = useIdID()
  return (
    <div
      data-task-gone
      // a task opened by a reference whose read has not answered yet
      data-task-loading={opened && found === undefined ? '' : undefined}
      className={cn(
        'flex min-h-0 flex-wrap items-center gap-3 text-sm text-text-2',
        inWindow ? 'shrink-0 px-5 pt-1 pb-3' : 'overflow-y-auto p-6',
      )}
    >
      {inWindow && showPlace && row && (
        <div className="basis-full">
          <ArchivedPlace project={row.project} archivedAt={row.archivedAt} />
        </div>
      )}
      {opened && !inWindow && task.key && (
        <div data-task-gone-task className="flex min-w-0 basis-full flex-col gap-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <IssueKey id={task.key} />
            {/* only a title the server sent */}
            <span className="min-w-0 truncate text-base font-medium text-text-1">{task.title}</span>
          </div>
          {row && <ArchivedPlace project={row.project} archivedAt={row.archivedAt} />}
        </div>
      )}
      <span
        ref={noteRef}
        role="status"
        tabIndex={-1}
        aria-describedby={unusedReason ? reasonId : undefined}
        className={mobile ? 'basis-full' : 'flex-1'}
      >
        {text}
        {unusedReason && ' The reason you typed for it was not used. Copy it to keep it.'}
      </span>
      {(found === 'failed' || (found === null && opened && retryUnavailable)) && (
        <Button type="button" variant="ghost" onClick={retry}>
          <Icon name="rotateCcw" size={16} />
          Retry
        </Button>
      )}
      {row && canRestore && (
        <Button type="button" variant="primary" disabled={restoring} onClick={restore}>
          {restoring ? 'Restoring…' : 'Restore'}
        </Button>
      )}
      <Button type="button" variant="ghost" onClick={onClose}>
        Close
      </Button>
      {unusedReason && (
        <div data-task-gone-reason className="flex basis-full flex-col items-start gap-2">
          {/* a long reason scrolls, so Copy reason stays in reach */}
          <p
            ref={reasonRef}
            id={reasonId}
            className="max-h-[min(12rem,30dvh)] w-full overflow-y-auto rounded-md border border-border bg-surface-1 px-2.5 py-2 whitespace-pre-wrap break-words text-text-1 select-text"
          >
            {unusedReason}
          </p>
          <Button type="button" variant="ghost" onClick={copyReason}>
            <Icon name="copy" size={16} />
            Copy reason
          </Button>
        </div>
      )}
    </div>
  )
}

/* The note above a task the window shows from its last answer while the
   read after that answer failed, with Retry, or runs again from Retry. The
   task stays as that answer had it, with a comment typed for it, since the
   answer shows nothing the window did not show already and the server
   checks every write. In LoadFailure's style, without its control height,
   as it sits under the task's title. */
function StaleTask({
  taskKey,
  retrying,
  mobile,
}: {
  taskKey: string
  retrying: boolean
  mobile: boolean
}) {
  const noteRef = useRefID<HTMLSpanElement>(null)
  // Retry leaves with the failure, so focus stays on the note, as in TaskGone
  const retry = () => {
    noteRef.current?.focus()
    P.retryTask()
  }
  return (
    <div
      data-task-stale={retrying ? 'retrying' : 'failed'}
      className="flex shrink-0 flex-wrap items-center gap-3 px-5 pt-1 pb-3 text-sm text-text-2"
    >
      <span
        ref={noteRef}
        role="status"
        tabIndex={-1}
        className={cn(mobile ? 'basis-full' : 'flex-1', retrying && 'italic text-text-3')}
      >
        {retrying
          ? `Checking ${taskKey} for changes…`
          : `Couldn't check ${taskKey} for changes, so it shows as it was last loaded.`}
      </span>
      {!retrying && (
        <Button type="button" variant="ghost" onClick={retry}>
          <Icon name="rotateCcw" size={16} />
          Retry
        </Button>
      )}
    </div>
  )
}

/* Where an archived task lives and the day it was archived, read-only, as
   the note on a task Search opened and the archived window's details say
   them. */
function ArchivedPlace({ project, archivedAt }: { project: string; archivedAt: number }) {
  const place = P.projectPlace(project)
  return (
    <div className="flex flex-wrap gap-x-3 text-xs text-text-2">
      {place && <span data-task-gone-place>{P.placeLabel(place)}</span>}
      <HoverTooltip content={deletedAtFull(new Date(archivedAt))}>
        <span data-task-gone-archived tabIndex={-1}>
          Archived {dayInSentence(new Date(archivedAt), new Date())}
        </span>
      </HoverTooltip>
    </div>
  )
}

/** The task a window on `issueId`, a handle or a reference
    (lib/taskReference.ts), is about, by uuid and organization: the
    workspace's task (`held`), else the task the window showed last when
    `issueId` names it too (`shown`, as a reference and the handle it moved
    to do), else what the reference names once its uuid and organization
    are known (`named`), or null. The window watches it (P.watchComments)
    and shows it from its own read while the workspace does not hold it
    (P.taskDetail). */
function windowTaskOf(
  issueId: string | null,
  held: IssueVM | undefined,
  named: ShownTask | undefined,
  shown: { at: string; task: ShownTask } | null,
): ShownTask | null {
  if (!issueId) return null
  if (held) {
    const { uuid, org, key, title, project } = held
    return { uuid, org, key, title, project }
  }
  if (shown && (shown.at === issueId || sameTask(shown.at, issueId))) return shown.task
  return named ?? null
}

/** The workspace's task that reference `ref` names once the workspace
    holds it, before the reference moves to its handle (P.watchHandles),
    by its uuid, or its number in its organization: never by reading the
    reference as a handle. */
function heldByRef(ref: RefParts | undefined, read: TaskRefVM | null): IssueVM | undefined {
  if (!ref) return undefined
  const uuid = ref.uuid ?? read?.task?.uuid
  const handle = uuid
    ? P.handleOf(uuid)
    : ref.org && ref.num !== undefined
      ? P.issueRefIn(ref.org, `${P.ISSUE_PREFIX}-${ref.num}`)
      : null
  return handle ? P.issueById[handle] : undefined
}

/** What the window names a task opened by reference `ref` by while it
    shows nothing of it: its uuid and organization once known, from the
    reference or its read (`read`), its key and the title and project the
    read's answer sent. Without a uuid, an empty one, which nothing
    watches. */
function refShownTask(ref: RefParts, read: TaskRefVM | null): ShownTask {
  const task = read?.task
  const num = task?.num ?? ref.num ?? null
  return {
    uuid: task?.uuid ?? (ref.org ? (ref.uuid ?? '') : ''),
    org: task?.org ?? ref.org ?? '',
    key: num === null ? null : `${P.ISSUE_PREFIX}-${num}`,
    title: task?.title ?? '',
    project: task?.project ?? '',
    opened: true,
  }
}

/* The first row of the thread in `feed`, focusable until it loses focus, so
   it can take keyboard focus once without staying focusable to a click. */
function firstRowForFocus(feed: Element): HTMLElement | null {
  return focusableOnce(feed.querySelector<HTMLElement>('[data-comment], [data-event]'))
}

/* The thread's row after `row`, the first a Show newer page brought in once
   the gap closed, focusable once as firstRowForFocus makes the first row. */
function rowAfterForFocus(row: Element | null): HTMLElement | null {
  let next = row?.nextElementSibling ?? null
  while (next && !next.matches('[data-comment], [data-event]')) next = next.nextElementSibling
  return next instanceof HTMLElement ? focusableOnce(next) : null
}

/* `row`, focusable until it loses focus. */
function focusableOnce(row: HTMLElement | null): HTMLElement | null {
  if (row && !row.hasAttribute('tabindex')) {
    row.tabIndex = -1
    row.addEventListener('blur', () => row.removeAttribute('tabindex'), { once: true })
  }
  return row
}

/* The nearest ancestor of `el` that scrolls vertically, or the page. */
function scrollerOf(el: Element): Element {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
      return node
  }
  return document.scrollingElement ?? document.documentElement
}

function CommentRow({
  c,
  it,
  canLead,
  locked = false,
  editing,
  onEdit,
  onDoneEdit,
}: {
  c: CommentVM
  it: IssueVM
  canLead: boolean
  /** an archived task's comments, which no one edits or deletes */
  locked?: boolean
  editing: boolean
  onEdit: (id: string) => void
  onDoneEdit: () => void
}) {
  const [hover, setHover] = useStateID(false)
  const deletion = useConfirmArm<'delete'>()
  const armDel = deletion.armed !== null
  // mine = authored by ANY of my seats (0081): a comment I left in a
  // foreign project is authored by my guest profile there, not CURRENT_USER
  const own = !!c.author && P.myProfileIds.includes(c.author)
  const u = c.author ? P.user(c.author) : null
  const canEdit = !locked && (own || canLead)
  return (
    <div
      data-comment={c.id}
      className="[display:flex] [gap:10px]"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHover(false)
      }}
    >
      <span
        style={{ ...spineNodeRing }}
        className="[width:28px] [height:28px] [border-radius:50%] [flex-shrink:0] [margin-top:1px]"
      >
        <Avatar id={c.author} size={28} />
      </span>
      <div className="[flex:1] [min-width:0]">
        <div className="[display:flex] [align-items:center] [gap:8px] [min-height:32px]">
          <span className="[font-size:var(--fs-base)] [font-weight:600] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
            {u ? u.name : 'Someone'}
          </span>
          <HoverTooltip content={new Date(c.ts).toLocaleString()}>
            <span className="[font-size:var(--fs-xs)] [color:var(--text-3)] [flex-shrink:0]">
              {P.fmtAgo(c.ts)}
            </span>
          </HoverTooltip>
          {c.editedTs != null && <EditedGlyph c={c} it={it} />}
          {canEdit && !editing && (
            <div
              style={{ opacity: hover ? 1 : 0 }}
              className="[margin-left:auto] [display:flex] [gap:2px] [transition:opacity_var(--dur-fast)_var(--ease-out)]"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="w-control-sm h-control-sm [border-radius:var(--r-sm)]"
                aria-label={own ? 'Edit comment' : 'Edit comment (project lead)'}
                title={own ? 'Edit comment' : 'Edit comment (project lead)'}
                onClick={() => onEdit(c.id)}
              >
                <Icon name="pen" size={16} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                style={{ color: armDel ? 'var(--danger)' : undefined }}
                className="w-control-sm h-control-sm [border-radius:var(--r-sm)]"
                aria-label={armDel ? 'Confirm delete' : 'Delete comment'}
                title={armDel ? 'Confirm delete' : 'Delete comment'}
                onClick={() => deletion.press('delete', () => P.deleteComment(c.id))}
              >
                <Icon name={armDel ? 'trash' : 'close'} size={16} />
              </Button>
            </div>
          )}
        </div>
        {editing ? (
          <div className="descfield [margin-top:3px]">
            <EditorSlot fallback={<Markdown text={c.body} />}>
              <DescEditor
                issueKey={null}
                org={it.org}
                value={c.body}
                placeholder="Comment…"
                ariaLabel="Edit comment"
                autoFocus
                comment={{
                  label: 'Save',
                  onCommit: (text, keep) => P.updateComment(c.id, text, keep),
                  onClose: onDoneEdit,
                }}
              />
            </EditorSlot>
          </div>
        ) : (
          <div className="[margin-top:3px]">
            <Markdown text={c.body} />
          </div>
        )}
      </div>
    </div>
  )
}

/* `embedded` drops the scrim and the floating card and lets the window fill
   whatever pane it is given — the inbox's right half, where the task IS the
   reading surface rather than something floating over one. It is also the one
   frame that DIVERGES: a pane that shares its half with a message list has no
   room for the details column, so embedded shows the discussion alone, names
   the location in a breadcrumb over the title, and offers `onPopOut` — the
   same window, floating, with everything the pane left out.
   `unread` overrides where this visit's unread part starts, and whether it
   holds a change (lib/spine.ts UnreadStart). The window freezes that
   itself on open, from the task's inbox item (P.inboxItem), also in the
   Inbox's pane. Only the Inbox's pop-out passes one, a start of nothing,
   since the pane behind it showed this visit's New mark already.
   `holdThread` says somebody else owns the store's one comment cache — the
   pane behind a popped-out window, which is on the same task. Without it the
   pop-out's unmount would release a thread the pane is still showing. */
function IssueDetail({
  issueId,
  onClose,
  onOpen,
  onPlanOnRoadmap,
  embedded = false,
  unread: unreadIn,
  onPopOut,
  onShowOnBoard,
  holdThread = false,
  closeLabel = 'Back',
  modalActive = true,
}: {
  issueId: string | null
  onClose: () => void
  onOpen: (id: string) => void
  onPlanOnRoadmap?: (id: string) => void
  embedded?: boolean
  unread?: UnreadStart
  onPopOut?: () => void
  /** Shows the project's Board and reveals `issueKey`'s card, with the
      task's window open over it unless `keepOpen` is false */
  onShowOnBoard?: (projectId: string, issueKey?: string, keepOpen?: boolean) => void
  holdThread?: boolean
  closeLabel?: string
  modalActive?: boolean
}) {
  usePlannerVersion('comments')
  // P.editsPaused(), read below: the end of snapshot trouble emits only the
  // store's health, and the start and end of a save pause a workspace emit,
  // which reaches health too
  usePlannerVersion('health')
  const mobile = useMobile()
  const [mobileTab, setMobileTab] = useStateID('activity')
  const [mobileViewport, setMobileViewport] = useStateID(() => ({
    height: window.visualViewport?.height || window.innerHeight,
    top: window.visualViewport?.offsetTop || 0,
  }))
  // the visible viewport less the floating notices' bands (lib/floatStack)
  const noticeBands = useFloatInsets()
  const mobileFrame = roomBeside(mobileViewport, noticeBands, window.innerHeight)
  useEffectID(() => {
    if (!mobile) return
    const viewport = window.visualViewport
    // iOS can open its keyboard without shrinking the layout viewport. Keep
    // the task inside the visible viewport, without moving or remounting its
    // editors; pinch zoom keeps the user's ordinary page zoom behavior.
    const update = () => {
      if (viewport && viewport.scale !== 1) return
      const next = { height: viewport?.height || window.innerHeight, top: viewport?.offsetTop || 0 }
      setMobileViewport((previous) =>
        previous.height === next.height && previous.top === next.top ? previous : next,
      )
    }
    update()
    viewport?.addEventListener('resize', update)
    viewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport?.removeEventListener('resize', update)
      viewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [mobile])
  const frameRef = useRefID<HTMLDivElement>(null)
  const [editTitle, setEditTitle] = useStateID(false)
  const [titleDraft, setTitleDraft] = useStateID('')
  // the title shown when editing began, which the save sends as seen; after
  // a save refused over someone else's rename, the next title shown that
  // differs from it becomes the new one (titleRebase)
  const [titleSeen, setTitleSeen] = useStateID('')
  const titleRebase = useRefID(false)
  // counts the title edits begun, so a refusal that answers after another
  // edit began, after the window moved to another task or closed, or while
  // the person types elsewhere, keeps nothing
  const titleSession = useRefID(0)
  const mountedRef = useRefID(true)
  useEffectID(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const [labelAnchor, setLabelAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [subAnchor, setSubAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [parentAnchor, setParentAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [linkAnchor, setLinkAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [linkType, setLinkType] = useStateID('blocked_by')
  const [moveOpen, setMoveOpen] = useStateID(false)
  // the Archive or delete window, from the task menu
  const [fateOpen, setFateOpen] = useStateID(false)
  // the reason typed in it, and the one it held when the task left the board
  // while it was open, which nothing sent (TaskGone)
  const fateReason = useRefID('')
  const [unusedReason, setUnusedReason] = useStateID<string | null>(null)
  // the text Copy reason put on the clipboard. Until that is the kept
  // reason, the reason holds the window's close and a reload, also once a
  // restore brings the task back, when it waits in the next Archive or
  // delete window, whose own field then holds it.
  const [copiedReason, setCopiedReason] = useStateID<string | null>(null)
  // the task the window is about, as one number that stays while a
  // reference turns into its handle (useTaskKey), which the window's own
  // state below keys on
  const taskKey = useTaskKey(issueId)
  // the task this window shows now, for work that finishes after a switch;
  // updated once a render commits, never during one
  const shownIssue = useRefID(taskKey)
  // the last task it showed, which closing (issueId null) keeps, for focus
  const lastShown = useRefID(issueId)
  // the task this window archives or deletes itself, which closes it
  const leaving = useRefID<number | null>(null)
  useLayoutEffectID(() => {
    shownIssue.current = taskKey
    if (issueId) lastShown.current = issueId
    if (leaving.current !== taskKey) leaving.current = null
  }, [issueId, taskKey])
  // a render once this window's own archive or delete of the task ends
  // without closing it: `leaving` is a ref, and the task may have left the
  // board meanwhile, which then shows TaskGone
  const [, setLeaveEnded] = useStateID(0)
  /** Ends this window's own archive or delete of `opened`, which left the
      window open, unless the window moved to another task meanwhile. */
  const stopLeaving = (opened: number | null) => {
    if (leaving.current !== opened) return
    leaving.current = null
    setLeaveEnded((n) => n + 1)
  }
  const [actFilter, setActFilter] = useStateID('comments') // comments ⇄ all
  // Another task opens under Comments from its first render, not only once
  // resetWindow's effect has run, so a window on All never asks for the
  // history of a task it will not show under All (P.showHistory).
  const [filterTask, setFilterTask] = useStateID(taskKey)
  if (filterTask !== taskKey) {
    setFilterTask(taskKey)
    setActFilter('comments')
  }
  // the description discloses only in the embedded pane; the floating window
  // pins it open, which is what discussion-first means there
  const [descOpen, setDescOpen] = useStateID(!embedded)
  // …and either half can be lifted out into a window of its own, for reading
  // (or writing) a lot of text without the rest of the task around it. Only
  // one at a time: they are two views of the same column, and stacking them
  // would put a scrim over a scrim for nothing.
  const [focus, setFocus] = useStateID(null as null | 'desc' | 'activity')
  // The text typed in each half, in the column and in its window. Moving a
  // half between the two mounts its editors afresh, so a move that would
  // drop typed text asks first (DiscardPrompt).
  const descColumn = useUnsentScope()
  const activityColumn = useUnsentScope()
  const focusWindow = useUnsentScope()
  const openFocus = (which: 'desc' | 'activity') =>
    closeOrAsk([which === 'desc' ? descColumn : activityColumn], () => setFocus(which))
  const closeFocus = () => closeOrAsk([focusWindow], () => setFocus(null))
  // the window this one counts its unsent text in (App's task window)
  const windowScope = useContextID(UnsentScopeContext)
  /** Closes the window after its task was archived or deleted, without the
      question: what was typed for the task goes with it, and its editors
      say so as they unmount. */
  const closeGone = () => {
    windowScope?.discard('unasked')
    onClose()
  }
  const [editingComment, setEditingComment] = useStateID<string | null>(null) // comment id being edited in place
  const winNarrow = useNarrow()
  const narrow = (!embedded || mobile) && winNarrow
  const descRef = useRefID<DescEditorHandle>(null)
  const composerRef = useRefID<DescEditorHandle>(null)
  const bodyRef = useRefID<HTMLDivElement>(null) // details card scroll body
  const contentRef = useRefID<HTMLDivElement>(null) // shared stacked content scroll
  const actScrollRef = useRefID<HTMLDivElement>(null) // activity spine scroller
  const descWrapRef = useRefID<HTMLDivElement>(null) // pinned description's own scroll
  const labelSecRef = useRefID<HTMLElement>(null)
  const subSecRef = useRefID<HTMLElement>(null)
  const parentSecRef = useRefID<HTMLElement>(null)
  const linkSecRef = useRefID<HTMLElement>(null)
  // Popup opens just below the section heading, left-aligned with the section
  // (AnchoredPop centers on x, so shift by half the popup width).
  const openPickerUnder = (ref, set, width) => {
    const el = ref.current
    const head = el?.firstElementChild ? el.firstElementChild : el
    if (!head) {
      set({ x: window.innerWidth / 2, y: 140 })
      return
    }
    // A heading scrolled partly out of a long panel: bring it on screen
    // BEFORE measuring, or the popup would open off-viewport. Must be
    // "instant": browser smooth scrolling would keep firing scroll events
    // after the popup mounts, and its close-on-scroll would eat it. Then wait
    // one frame so the (single) scroll event also dispatches before mount.
    head.scrollIntoView({ block: 'nearest', behavior: 'instant' })
    requestAnimationFrame(() => {
      const r = head.getBoundingClientRect()
      set({ x: r.left + width / 2, y: r.bottom - 4 })
    })
  }
  /* Puts the window's own state back as it is when a task opens in it: no
     title in editing, no picker, Move or Archive or delete window open, and
     the columns at their start. It runs when another task opens and when
     the task leaves the board, so a restore brings the task back afresh. */
  const resetWindow = () => {
    setEditTitle(false)
    setLabelAnchor(null)
    setSubAnchor(null)
    setParentAnchor(null)
    setLinkAnchor(null)
    setLinkType('blocked_by')
    setMoveOpen(false)
    setFateOpen(false)
    fateReason.current = ''
    setUnusedReason(null)
    setCopiedReason(null)
    setActFilter('comments')
    setEditingComment(null)
    setDescOpen(!embedded)
    setFocus(null)
    setMobileTab('activity')
    // in-modal navigation swaps issues in the same mounted cards — without a
    // scroll reset the crumb/title of the NEW issue would sit off-screen.
    // The spine scroller is NOT reset here: useBottomSnap owns it, and two
    // writers would make the result depend on hook declaration order.
    if (bodyRef.current) bodyRef.current.scrollTop = 0
    if (contentRef.current) contentRef.current.scrollTop = 0
    if (descWrapRef.current) descWrapRef.current.scrollTop = 0
  }
  useEffectID(resetWindow, [taskKey])
  useEffectID(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return
      // a ModalShell stacked on top (new sub-issue etc.) owns Escape there
      if (e.target instanceof Element && e.target.closest('[data-modal-shell]')) return
      if (e.defaultPrevented) return
      if (
        e.target instanceof Element &&
        e.target.closest('[data-slot="popover-content"], [data-slot="select-content"]')
      )
        return
      // Radix portals the open menu outside the task dialog. Let that nested
      // control consume the first Escape instead of dismissing both layers.
      if (document.querySelector('[data-fieldselect-menu]')) return
      // …and so does a POPPED-OUT copy of this very window: an embedded pane
      // yields while one floats over it, or the same keypress would close both
      // and clear the pane the pop-out came from. Probed off the DOM like the
      // rule above and ModalShell's own [data-anchoredpop-backdrop] check —
      // neither frame has a reference to the other.
      if (embedded && document.querySelector('[data-task-scrim]')) return
      onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, embedded])

  // the reference the window names a task the workspace does not hold by
  // (lib/taskReference.ts), and where its read stands (P.reference)
  const ref = refParts(issueId)
  const refRead = ref && P.reference?.ref === issueId ? P.reference : null
  // the workspace's view of the task the handle names, or the reference
  // names once the workspace holds it
  const held = !issueId ? undefined : ref ? heldByRef(ref, refRead) : P.issueById[issueId]
  // what the reference names of its task once its uuid and organization are
  // known, from the reference itself or its read's answer, or for a handle
  // the workspace does not hold, the watched task it opens now, as for the
  // pop-out over the Inbox pane on a task that left (P.unheldTask)
  const named = held
    ? undefined
    : ref
      ? refShownTask(ref, refRead)
      : issueId
        ? (P.unheldTask(issueId) ?? undefined)
        : undefined
  // what the window last showed of this task, kept for once it is gone
  const shownTask = useRefID<{ at: string; task: ShownTask } | null>(null)
  const identity = windowTaskOf(issueId, held, named?.uuid ? named : undefined, shownTask.current)
  // the window registers its reference, which the store reads until it
  // names the task and moves to its handle once the workspace holds it
  // (P.watchTaskRef); the pop-out over the Inbox pane leaves it to the pane
  const watchRef = ref ? issueId : null
  useEffectID(() => {
    if (!holdThread) P.watchTaskRef(watchRef)
  }, [watchRef, holdThread])
  useEffectID(
    () => () => {
      if (!holdThread) P.watchTaskRef(null)
    },
    [holdThread],
  )
  // the task as the window shows it from its own read while the workspace
  // does not hold it (P.taskDetail)
  const detail: TaskDetailVM | null = !held && identity ? P.taskDetail(identity.uuid) : null
  // the view of the last answer that held the task, active or archived,
  // also while a read after it failed or runs again (`stale`), so a
  // comment typed for the task stays; but not while this window's own
  // archive or delete is on its way: that closes the window, and the answer
  // must not show the task under its dialog
  const answerView =
    leaving.current !== taskKey &&
    detail?.view &&
    !detail.textless &&
    (detail.answered === 'ok' || detail.answered === 'archived')
      ? detail.view
      : null
  const it = held ?? answerView
  // the uuid of the task the window shows now, for work that finishes after
  // a switch; updated once a render commits
  const shownUuid = useRefID<string | null>(null)
  useLayoutEffectID(() => {
    shownUuid.current = it?.uuid ?? null
  })
  // a task shown from its answer, which its editor changes from that answer
  // (answerEdits), and of those an archived one, read-only with its note
  // above it and no comments either
  const fromAnswer = !held && !!it
  const archived = fromAnswer && detail?.answered === 'archived'
  // the window shows the task as its last answer had it, because the read
  // after it failed, or runs again from Retry (the note above the task)
  const stale = fromAnswer && (detail?.state === 'failed' || detail?.state === 'retrying')
  // the window shows an active task: the workspace's, or one from its answer
  const active = !!held || (fromAnswer && !archived)
  // the task the window showed follows its handle as it moves, as App's
  // address does, so the window goes on showing the same task
  useEffectID(
    () =>
      P.watchHandles((moved) => {
        const shown = shownTask.current
        const to = shown && moved.get(shown.at)
        if (shown && to) shownTask.current = { ...shown, at: to }
      }),
    [],
  )
  if (it && issueId) {
    const { uuid, org, key, title, project } = it
    shownTask.current = { at: issueId, task: { uuid, org, key, title, project } }
  } else if (shownTask.current && !sameTask(shownTask.current.at, issueId)) shownTask.current = null
  // the task as this render shows it, with its key and title from the
  // window's own answer once that names them, as for an archived task an
  // Inbox row opened by its uuid alone, whose reference names no number
  const shownNow = windowTaskOf(issueId, held, named?.uuid ? named : undefined, shownTask.current)
  // whether the window's read of the task has said nothing yet, or runs
  // again after a failure
  const unanswered = !detail || detail.state === 'loading' || detail.state === 'retrying'
  // a handle the window cannot name while the tasks an ask loads are on
  // their way may be a task still to arrive, and so may a task it showed
  // before whose read has not answered yet: the window says it loads. It
  // never waits in a session that never asks, nor after a load stopped
  // (P.tasksArriving). A task opened by a reference and never shown shows
  // its own loading line instead (TaskGone). Otherwise a handle without a
  // task opens nothing, and says nothing of it.
  const waiting =
    !it && !!issueId && P.tasksArriving() && (identity ? !identity.opened && unanswered : !ref)
  // the window shows no active task for the task it is about, other than by
  // this window's own archive or delete while that is on its way: the
  // window says what became of it (TaskGone), also once its own call was
  // refused (stopLeaving), and above an archived task it shows read-only.
  // A reference whose read has not named its task yet says where that
  // read stands, with what the reference names.
  const gone =
    !active && !waiting && issueId && leaving.current !== taskKey ? (shownNow ?? named) : null
  // what the window's read says became of it, for TaskGone: the archived
  // window's own answer, also while a read after it failed, else what the
  // read says now
  const archivedRow =
    detail?.view && detail.archivedAt !== null
      ? {
          project: detail.view.project,
          title: detail.view.title,
          org: detail.org,
          archivedAt: detail.archivedAt,
        }
      : undefined
  // what the reference's read says of a task it has not named yet, which
  // only the server's word makes unavailable
  const refAnswer: GoneAnswer =
    refRead?.state === 'failed' ? 'failed' : refRead?.state === 'unavailable' ? null : undefined
  // a uuid every organization said can't be opened, which no read follows
  // once its walk over the seats ended, so Retry reads it again
  // (P.retryTask); every other answer follows the server by itself
  const retryUnavailable =
    !!ref?.uuid && !ref.org && refRead?.state === 'unavailable' && !refRead.task
  const goneAnswer: GoneAnswer = !identity
    ? refAnswer
    : archived && archivedRow
      ? archivedRow
      : detail?.state === 'failed'
        ? 'failed'
        : detail?.state === 'unavailable'
          ? null
          : detail?.state === 'archived'
            ? archivedRow
            : undefined
  // an archived task whose project is archived too, which Archived tasks
  // lists only once the project is restored, and which no one restores
  // from the window
  const projectArchived =
    !!goneAnswer &&
    typeof goneAnswer === 'object' &&
    !P.project(goneAnswer.project) &&
    P.archivedProjects.some((project) => project.id === goneAnswer.project)
  // the caller's level on a task shown from its answer, which decides the
  // controls offered there, together with the workspace's (canComment);
  // an archived answer of an older backend holds none, and the workspace's
  // decides alone, as before
  const answerLevel = detail?.level ?? null
  const answerEditor = answerLevel === 'lead' || answerLevel === 'user'
  const canRestore =
    goneAnswer !== null &&
    typeof goneAnswer === 'object' &&
    (answerEditor || (answerLevel === null && !!detail?.textless)) &&
    P.canWrite(goneAnswer.project)
  /** Says that text typed for the task went with it, as its editors do,
      unless the person chose Discard for it. */
  const sayDiscarded = (what: string) => {
    if (!windowScope?.chosen()) window.showToast?.(`Unsaved ${what} discarded`)
  }
  // someone the answer and the workspace both give Edit on the project of
  // an active task shown from its answer, in any state of its read: their
  // title, description and hours editors stay mounted with their drafts,
  // and a save waits while the read failed or runs again (P.refuseStaleEdit)
  const answerEditorOn = !!it && fromAnswer && !archived && answerEditor && P.canWrite(it.project)
  // a title is typed for a task the workspace holds, or one shown from its
  // answer for its editor
  useUpdateBlocker(editTitle && !!it && titleDraft !== it.title)
  useUnsaved(editTitle && !!it && titleDraft !== it.title, 'title')
  const reasonUnsent = unusedReason !== null && unusedReason !== copiedReason && !fateOpen
  useUpdateBlocker(reasonUnsent)
  useUnsaved(reasonUnsent, 'reason')
  // the window shows no active task for it any more: its window's own
  // state goes too, the title typed for it is discarded, and a reason typed
  // to archive or delete it stays in the note to copy: the open window's,
  // or the one a restore kept for the next window, when the task leaves
  // again before that opens
  const goneUuid = gone ? gone.uuid : null
  useEffectID(() => {
    if (!gone) return
    if (editTitle && titleDraft !== gone.title) sayDiscarded('title')
    const reason = fateOpen ? fateReason.current.trim() : (unusedReason ?? '')
    const copied = copiedReason
    resetWindow()
    if (!reason) return
    setUnusedReason(reason)
    setCopiedReason(copied)
  }, [goneUuid])
  // a task that leaves the workspace while the window goes on showing it
  // from its answer closes the pickers and the Move window it had open. The title typed for it stays, to save through
  // the answer, when the answer gives its editor Edit; otherwise it goes,
  // as for a task that leaves the board
  const heldNow = useRefID({ taskKey, uuid: held?.uuid })
  useEffectID(() => {
    const was = heldNow.current
    heldNow.current = { taskKey, uuid: held?.uuid }
    if (was.taskKey !== taskKey || !was.uuid || held || gone) return
    setLabelAnchor(null)
    setSubAnchor(null)
    setParentAnchor(null)
    setLinkAnchor(null)
    setMoveOpen(false)
    if (!editTitle || answerEditorOn) return
    if (titleDraft !== titleSeen) sayDiscarded('title')
    setEditTitle(false)
  }, [held?.uuid])
  // a kept title draft: the rename that refused its save becomes the title
  // the next save sends as seen, once the screen shows it
  const shownTitle = it?.title
  useEffectID(() => {
    if (!titleRebase.current || shownTitle === undefined || shownTitle === titleSeen) return
    titleRebase.current = false
    setTitleSeen(shownTitle)
  }, [shownTitle, titleSeen])
  // remaining hours typed and not yet saved (the field saves on blur), in
  // the field of a task the person can change, the workspace's or one shown
  // from its answer, whose save waits while its read is not current
  const hoursEditable = (!!held && P.canWrite(held.project)) || answerEditorOn
  const remainingUnsaved = useFieldUnsaved(
    () => P.editsPaused() || (!!it && P.answerSaveWaits(it.id)),
    `${it?.id}:${hoursEditable ? 'edit' : 'read'}:${it?.remaining ?? ''}`,
    'remaining hours',
    () => {
      // the hours go with a task that left the board, or a field that
      // turned read-only, not with a save
      if (gone || !hoursEditable) sayDiscarded('remaining hours')
    },
  )
  // point the store's one-thread comment cache at this task, with its
  // organization, which a task the workspace does not hold is read in; keep
  // it while the window shows the task in any state, so the thread and the
  // history go on for an archived one; release it when the modal closes
  // (uuid null) or the component unmounts
  const watchUuid = identity ? identity.uuid : null
  const watchOrg = identity?.org
  // …unless another window on the SAME task already holds it (holdThread): a
  // pop-out over the inbox pane would otherwise release, on its way out, a
  // thread the pane behind it is still showing.
  useEffectID(() => {
    if (!holdThread) P.watchComments(watchUuid, watchOrg)
  }, [watchUuid, watchOrg, holdThread])
  useEffectID(
    () => () => {
      if (!holdThread) P.watchComments(null)
    },
    [holdThread],
  )
  // Under All the window shows the task's history, which the store loads
  // only while some window asks for it. A window with holdThread asks too:
  // the Inbox pane and its pop-out can show one task under different
  // filters, and each registers on its own.
  const historyOwner = useRefID({})
  const showsAll = actFilter === 'all' && watchUuid !== null
  useEffectID(() => {
    if (!showsAll) return
    const owner = historyOwner.current
    P.showHistory(owner, true)
    return () => P.showHistory(owner, false)
  }, [showsAll, watchUuid])
  // The comment open in this window's editor stays through every release
  // of rows past the store's budget (P.holdComment), so its editor and its
  // draft stay too; none once the editor closes or the window goes.
  const holdOwner = useRefID({})
  useEffectID(() => {
    P.holdComment(holdOwner.current, editingComment)
  }, [editingComment])
  useEffectID(() => {
    const owner = holdOwner.current
    return () => P.holdComment(owner, null)
  }, [])
  // Subtasks, Linked tasks and Attachments load their own lists, which the
  // store asks for only while some window shows them: a window with the
  // details column on an active task, and on a phone only while its Details
  // tab shows, since Activity hides the column there. The desktop Inbox
  // pane has no details column and asks for none; its pop-out (holdThread)
  // asks on its own. An archived task shows none of them.
  const sectionsOwner = useRefID({})
  const showsSections =
    active && watchUuid !== null && (mobile ? mobileTab === 'details' : !embedded)
  useEffectID(() => {
    if (!showsSections) return
    const owner = sectionsOwner.current
    P.showSections(owner, true)
    return () => P.showSections(owner, false)
  }, [showsSections, watchUuid])

  // Where this visit's unread part starts, frozen once a visit. Opening
  // marks the task read (below), so an unfrozen mark would vanish while you
  // were looking at it. Assigned DURING render, before any effect runs.
  // That ordering is the whole trick. Keyed on the uuid, not issueId: on a
  // cold deep link P.issueById[issueId] is still undefined on the first
  // render, and a null key would freeze "nothing unread" forever. It comes
  // from the task's inbox item, which the store reads beside the thread
  // (P.inboxItem), so it is exact also for messages the workspace never
  // loaded, and stays pending until that read's first ok, current answer,
  // while no mark shows and no read goes out. It stays pending through a
  // seat whose items are building and through a failure, which the store
  // runs once more, so a read that recovers still draws the divider.
  // …unless the surface that opened us passed one (`unread`, the Inbox's
  // pop-out over the pane that showed the mark already). Every other open,
  // a press on an Inbox row included, takes the item's.
  // Frozen with it: whether the unread messages include a change, which the
  // tail note under Comments points at All for, since Comments loads no
  // history to look for it in.
  const frozen = useRefID<{ key: string | null | undefined; unread: UnreadStart | null }>({
    key: undefined,
    unread: { ts: null, change: false },
  })
  const shownItem = watchUuid && P.inboxItem?.task === watchUuid ? P.inboxItem : null
  if (frozen.current.key !== watchUuid || frozen.current.unread === null) {
    const answered = shownItem?.state === 'ok' && shownItem.current ? shownItem : null
    frozen.current = {
      key: watchUuid,
      unread:
        unreadIn !== undefined
          ? unreadIn
          : !watchUuid
            ? { ts: null, change: false }
            : answered
              ? itemUnreadStart(answered.item)
              : null,
    }
  }
  const unreadTs = frozen.current.unread?.ts ?? null
  const unreadPending = frozen.current.unread === null
  // …and once the start is frozen, read the whole item on the server, so
  // what the badge counts goes also for messages the workspace never
  // loaded. The store sends each `through` of the item once a visit, from
  // the organization, the task and the `through` of its own answer, never
  // for a snoozed item, a reminder that must return unread, and the pause
  // is part of the key, so a read it refused goes out once it ends
  // (P.readOnOpen). A later answer, such as a message that arrived while
  // the task is open, reads it again, unless the person marked the task
  // unread, snoozed it or ended its snooze from this client during the
  // visit (P.readOnOpen).
  const paused = P.editsPaused()
  useEffectID(() => {
    if (!watchUuid || unreadPending || !shownItem) return
    P.readOnOpen(watchUuid)
  }, [watchUuid, unreadPending, shownItem, paused])

  // The spine opens at its newest end, like the inbox thread it now matches.
  // All five key terms earn their place: a different task is a different
  // thread; watchComments empties the cache first, so the opening render has
  // an empty spine and the snap must re-fire when the thread lands; under
  // All the history lands on its own, later, and only this window's All
  // counts, since the store's one history also serves a pop-out that the
  // pane behind it must not follow; All ⇄ Comments changes the
  // content height wholesale; and popping the thread out moves it into a
  // taller scroller that opens at the top unless this fires again
  // (actScrollRef follows it — only one is ever mounted).
  useBottomSnap(
    actScrollRef,
    issueId
      ? String(taskKey) +
          ':' +
          (P.commentsLoaded ? '1' : '0') +
          ':' +
          (actFilter !== 'all' ? '-' : P.historyLoaded ? '1' : '0') +
          ':' +
          actFilter +
          ':' +
          (focus === 'activity' ? 'pop' : 'in')
      : null,
  )
  const upd = (patch) => {
    P.updateIssue(it.id, patch)
  }
  const open = !!it || waiting || !!gone
  // Move and Archive open from the Task actions menu, which is gone when they
  // close, so they return focus to the button that opened that menu.
  const taskActionsButton = () =>
    frameRef.current?.querySelector<HTMLElement>('[aria-label="Task actions"]') ?? null
  // An open window is modal, except as the desktop Inbox's embedded pane: it
  // takes focus, keeps Tab inside, makes the page behind inert, which also
  // hides it from assistive technology, and returns focus when it closes.
  // Keyed on being modal, not on the breakpoint, so a resize across it keeps
  // the setup (and the focus) of a window that stays modal.
  const modal = open && modalActive && (!embedded || mobile)
  useEffectID(() => {
    if (!modal) return
    const frame = frameRef.current
    if (!frame) return
    const dialog = frame.querySelector<HTMLElement>('[role="dialog"]')
    let previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Where in a task's card, or in another view's row of the task, the
    // opener was. Changing the task here can move its card, which replaces
    // the opener.
    let previousMark = markTaskFocus(previousFocus, issueId)
    const outside = new Map<HTMLElement, boolean>()
    const focusable = () =>
      Array.from(
        frame.querySelectorAll<HTMLElement>(
          'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]',
        ),
      ).filter(
        (el) =>
          el.tabIndex >= 0 &&
          !el.matches(':disabled') &&
          !el.closest('[inert]') &&
          el.getClientRects().length > 0,
      )
    let initialFocus = 0
    const release = () => dialog?.removeAttribute('tabindex')
    // A layer that closed as this window opened (Search, the new task
    // dialog) returns focus in a setTimeout(0) it queued before this one.
    // Let it land first: its target is where focus returns when the window
    // closes, or, inside the window, where focus stays.
    const settle = setTimeout(() => {
      const landed = document.activeElement
      if (landed instanceof HTMLElement && landed !== document.body && !frame.contains(landed)) {
        previousFocus = landed
        previousMark = markTaskFocus(landed, issueId)
      }
      // The Inbox task lives inside main. Isolate sibling branches on the way
      // to body, rather than making its own ancestor inert. Menus and dialogs
      // created later in portals remain available above the task, and so do
      // the announcer and the floating column of toasts and notices
      // ([data-top-layer]).
      let branch: HTMLElement = frame
      while (branch.parentElement) {
        for (const sibling of branch.parentElement.children) {
          if (
            sibling !== branch &&
            sibling instanceof HTMLElement &&
            !sibling.matches('[data-focus-window], [data-modal-shell], [data-top-layer]')
          ) {
            outside.set(sibling, sibling.inert)
            sibling.inert = true
          }
        }
        if (branch.parentElement === document.body) break
        branch = branch.parentElement
      }
      // A phone focuses Back. A desktop focuses the window itself, drawn
      // without a ring, which reads as "Task, dialog" and opens no tooltip,
      // so Escape still closes it at once. It is focusable only until it
      // loses focus or takes a press, so a press on text or a scrollbar
      // leaves focus where the browser puts it without a focusable window:
      // in a field, or on the page, which then scrolls the column under the
      // press. Neither steals focus from a field inside or a focus window.
      initialFocus = requestAnimationFrame(() => {
        if (frame.contains(document.activeElement)) return
        if (document.querySelector('[data-focus-window]')) return
        if (mobile) {
          frame
            .querySelector<HTMLElement>('[data-mobile-task-back]')
            ?.focus({ preventScroll: true })
        } else if (dialog) {
          dialog.tabIndex = -1
          dialog.addEventListener('blur', release, { once: true })
          dialog.addEventListener('pointerdown', release, { once: true, capture: true })
          dialog.focus({ preventScroll: true })
        }
      })
    }, 0)
    const trap = (event: KeyboardEvent) => {
      if (
        event.key !== 'Tab' ||
        event.defaultPrevented ||
        !(event.target instanceof Node) ||
        !frame.contains(event.target)
      )
        return
      const controls = focusable()
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first) return
      // Wrap at either end, also from a focused element before the first
      // control (the desktop window itself) or after the last one.
      const from = document.activeElement
      const follows = (a: Node, b: Node) =>
        !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
      if (event.shiftKey && from && (from === first || follows(from, first))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && from && (from === last || follows(last, from))) {
        event.preventDefault()
        first.focus()
      }
    }
    frame.addEventListener('keydown', trap)
    return () => {
      clearTimeout(settle)
      cancelAnimationFrame(initialFocus)
      frame.removeEventListener('keydown', trap)
      dialog?.removeEventListener('blur', release)
      dialog?.removeEventListener('pointerdown', release, true)
      release()
      for (const [element, wasInert] of outside) element.inert = wasInert
      if (previousFocus?.isConnected && !previousFocus.closest(OUT_OF_USE)) {
        restoreFocus(previousFocus)
      } else {
        // The opener went with its card. This cleanup can run while React
        // still commits the close, so search once that commit is done and
        // the Board shows the tasks where they are now: the opener's task,
        // else the title of the task the window showed last, and only then
        // the card or row that took the opener's place, or what is beside
        // the place it left empty (restoreTaskFocus).
        const shown = lastShown.current
        queueMicrotask(() => {
          const scroll = !lastInputWasPointer()
          if (previousMark && restoreTaskFocus(previousMark, { scroll, nearby: false })) return
          if (shown) {
            const title = { taskId: shown, row: 'card', control: 'title' } as const
            const anywhere = { cell: null, status: null, place: null, index: -1 }
            if (restoreTaskFocus({ ...title, ...anywhere }, { scroll })) return
          }
          if (previousMark) restoreTaskFocus(previousMark, { scroll, beside: true })
        })
      }
    }
    // `mobile` only picks the first focus target when the window opens
  }, [modal])
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const proj = it ? P.project(it.project) : null
  // This task's own Subtasks, Linked tasks and Attachments (P.sectionsFor).
  // The store follows the task a window shows from that window's effects,
  // after the render that first shows it, so a task opened in place first
  // finds another task's sections in the store; it shows its own lists
  // from the workspace once it holds every task, and loading lines before
  // then until its own lists answer.
  const sections = it ? P.sectionsFor(it.uuid) : null
  const subtasks = sections?.subtasks ?? { ...LOADING_SECTION, hidden: false }
  const linked = sections?.links ?? LOADING_SECTION
  const files = sections?.attachments ?? { ...LOADING_SECTION, count: 0 }
  // whether the task is a group stays the workspace's, or its answer's for
  // a task shown from it; its Progress and Remaining come from the subtask
  // list, and say unknown without all of it, or, for the list a complete
  // workspace holds before the answer, by the workspace's own rules. An
  // archived group's answer holds no subtasks, so they are unknown.
  const totals =
    it && P.isGroup(it)
      ? archived
        ? UNKNOWN_TOTALS
        : subtasks.source === 'workspace'
          ? workspaceTotals(P.progressOf(it), P.remainingOf(it))
          : groupTotals(subtasks)
      : null
  const prog = totals?.progress
  // the Parent row: the workspace's, or the answer's for a task shown from
  // it, and for a held task whose parent the workspace does not hold, as
  // one the Parent picker offered, the window's own answer's
  const parentUuid = held?.parent ? P.issueById[held.parent]?.uuid : undefined
  const parentRow = held
    ? parentUuid
      ? P.relatedTask(parentUuid)
      : P.shownParent(held.uuid)
    : (detail?.parent ?? null)
  const meta = it ? P.metaOf(it.project) : null
  // A task lives in its sub-project. The parent may be navigation-only for a
  // child grant, so all task edits must follow the task's own write level.
  const canLabel = !!held && P.canWrite(held.project)
  // A task shown from its answer takes the same edits from its answer, for
  // someone both the answer and the workspace give Edit on its project,
  // while the window's read of it is current (P.editsFromAnswer): each
  // write sends the values the window showed as its expected values, which
  // the server checks. A task shown from the read of the reference it was
  // opened by takes none until the window's own read answered. Its
  // relations take the same rule (canEdit).
  const answerEdits = answerEditorOn && !stale && !!it && P.editsFromAnswer(it.id)
  const canEdit = canLabel || answerEdits
  // every label of the task, named from the workspace or by id
  // (taskLabels.ts useTaskLabels), so none is hidden for not being loaded
  const taskLabels = useTaskLabels(it)
  const shownLabels = taskLabels.labels.filter((label) => label.state !== 'gone')
  // Comments on a task shown from its answer need edit access by both the
  // answer and the workspace, so a stale one only takes controls away. An
  // archived task takes none.
  const canComment = held ? canLabel : !!it && !archived && answerEditor && P.canWrite(it.project)
  const canLead = held
    ? P.levelOn(held.project) === 'lead'
    : !!it && !archived && answerLevel === 'lead' && P.levelOn(it.project) === 'lead'
  // one roster for both people pickers: the reviewer follows the assignee rule
  const assigneeChoices = it ? P.taskAssigneesFor(it) : []
  // one sentence for every control the read-only case switches off, so a
  // viewer is told WHY rather than left prodding a dead field. A task shown
  // from its answer says, to someone who could change it, that it waits
  // for its read to be current again, or for a restore
  const roTip = canEdit
    ? undefined
    : answerEditorOn
      ? WAITS_FOR_CHECK
      : fromAnswer && answerEditor && archived
        ? RESTORE_TO_CHANGE
        : READ_ONLY
  // The phone's Activity view keeps the two frequent edits within reach.
  // Details uses the same controls, with the same choices and access checks.
  // Pause / Resume is the last row of the status menu: a pause is a state of
  // the work under way rather than a status of its own. The window-edge tab
  // shows that state without adding a field or changing the selected status.
  // Done and Backlog tasks hold no pause (the server clears it on the move),
  // so they get no action or tab. Group parents keep dormant workflow fields.
  const pausable = !!it && it.status !== 'done' && it.status !== 'backlog'
  const showResume = pausable && it.paused && !P.isGroup(it)
  const statusControl = () => (
    <div className="task-status-control">
      <FieldSelect
        aria-label="Status"
        value={it.status}
        menuWidth={180}
        disabled={!canEdit}
        title={roTip}
        options={P.STATUSES.map((s) => ({
          value: s.id,
          label: s.name,
          icon: <StatusDot status={s.id} />,
        }))}
        onChange={(v) => upd({ status: v })}
        action={
          pausable
            ? {
                label: it.paused ? 'Resume' : 'Pause',
                icon: (
                  <Icon
                    name={it.paused ? 'play' : 'pause'}
                    size={14}
                    color={it.paused ? 'var(--success)' : 'var(--text-2)'}
                  />
                ),
                onSelect: () => upd({ paused: !it.paused }),
              }
            : undefined
        }
      />
      {showResume && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-task-resume
          aria-label="Resume task"
          title={roTip || 'Resume task'}
          disabled={!canEdit}
          onClick={(e) => {
            // The shortcut disappears on resume; leave keyboard users on
            // the status trigger instead of dropping focus onto the page.
            const trigger =
              e.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-fieldselect]')
            if (trigger) restoreFocus(trigger)
            upd({ paused: false })
          }}
        >
          <Icon name="play" size={16} color="var(--success)" />
        </Button>
      )}
    </div>
  )
  /* The Assignee and Reviewer pickers: the same control over the same roster,
     each writing its own field. A historical value that is no longer eligible
     still renders as the placeholder but is not a selectable menu item. */
  const personControl = (field: 'assignee' | 'reviewer') => {
    const value = it[field]
    const none = field === 'reviewer' ? 'No reviewer' : 'Unassigned'
    const selectable = !!value && assigneeChoices.some((u) => u.id === value)
    return (
      <FieldSelect
        aria-label={field === 'reviewer' ? 'Reviewer' : 'Assignee'}
        value={value ? (selectable ? value : undefined) : NO_PROFILE}
        placeholder={(value && P.user(value)?.name) || none}
        menuWidth={220}
        disabled={!canEdit}
        title={roTip}
        options={[
          { value: NO_PROFILE, label: none },
          ...assigneeChoices.map((u) => ({
            value: u.id,
            label: u.name,
            icon: <Avatar id={u.id} size={28} />,
          })),
        ]}
        onChange={(v) =>
          upd(
            field === 'reviewer'
              ? { reviewer: v === NO_PROFILE ? null : v }
              : { assignee: v === NO_PROFILE ? null : v },
          )
        }
      />
    )
  }
  // user-level and up can move the issue to any sub-project they can write in — but
  // only offer the menu item when some target OTHER than the current
  // sub-project exists (else the dialog could never enable its Move button)
  // …in the task's OWN organization: a move never crosses one (0081), so a
  // writable project elsewhere must not light the menu item up
  // …and a task shown from its answer offers it to its editor in any
  // state of its read, saying why it waits
  const canMove =
    (canLabel || answerEditorOn) &&
    P.projects.some(
      (m) =>
        m.type === 'meta' &&
        m.org === it.org &&
        (m.children || []).some((cid: string) => cid !== it.project && P.canWrite(cid)),
    )
  // Archive or delete, likewise
  const canFate = canLabel || answerEditorOn
  // Move and Archive or delete act on the task's whole subtask list and its
  // holders (P.familyOf): a held task's once every task has loaded or its
  // own answer serves it, else they wait for every task; one shown from
  // its answer from that answer's whole list, while its read is current
  const family = it && (canLabel || answerEditorOn) ? P.familyOf(it) : null
  const fateTip = held
    ? family
      ? undefined
      : WAITS_FOR_TASKS
    : !answerEdits
      ? WAITS_FOR_CHECK
      : family
        ? undefined
        : FAMILY_UNKNOWN
  const fateWaits = fateTip !== undefined

  // issue numbers are org-scoped and immutable (0050), so this link is
  // permanent — it survives moves and project renames; lowercase in URLs.
  // Failure must not toast success: a false "copied" pastes stale content.
  // Copy task ID shares this failure toast, since the open task's address
  // also contains its key.
  const copyFailed = () =>
    window.showToast?.("Couldn't copy. Copy the address bar instead.", 'error')
  const copyLink = () => {
    // issueLink names the task's OWN organization in the path — its number
    // alone would be ambiguous for the recipient, since numbers are per-org
    const url = location.origin + issueLink(it.id)
    void copyText(url).then((ok) =>
      ok ? window.showToast?.(`Copied a link to ${it.key}`) : copyFailed(),
    )
  }
  const copyId = () => {
    void copyText(it.key).then((ok) =>
      ok ? window.showToast?.(`Copied ${it.key} to clipboard`) : copyFailed(),
    )
  }

  // one level of subtasks, at most LIMITS.subtasks.max active ones: why this task can
  // take no subtask, or no parent, if it cannot
  // The caps count the larger of the workspace's list and the whole section
  // list (P.capInputs), so a list the workspace holds only part of disables
  // more and never allows more.
  const noSubtask = it ? subtaskBlock({ ...it, children: P.capInputs(it).children }) : undefined
  const noParent = it ? parentBlock(it) : undefined
  const hasParent = !!it && (!!it.parent || it.hasHiddenParent || !!parentRow)
  // The per-task cap on links. A full task takes no new link, and the
  // server's Linked tasks picker says so (convex/lib/relationPicker.ts).
  const noLink = it ? linkBlock(P.capInputs(it).links) : undefined
  // The Parent, Subtasks and Linked tasks changes of the window's task take
  // the window's rule for its fields (canEdit). That is a held task the
  // person can edit, or one shown from a current answer that both the
  // answer and the workspace give them Edit on. A related row's change also
  // reads that row's level together with the workspace's, so a stale source
  // only takes a control away, and waits for a current read of the window's
  // task, as a task shown from the read of its reference takes no change.
  const current = !!held || (!!it && P.editsFromAnswer(it.id))
  const canRelate = canEdit
  const rowEditor = (row: RelatedTaskVM) =>
    (row.level === 'lead' || row.level === 'user') && P.canWrite(row.project)
  // a link needs Edit on either task (convex/model/issues.ts linkAccess),
  // so someone who only views this task links it to a task they can edit
  const canLinkAny = !!it && current && !archived && (canRelate || P.editsSomeProject(it.org))
  // A row's removal sends what its list showed as the expected values (a
  // link's kind, a subtask's parent), so it waits while that list failed
  // or reads again.
  const waits = (section: SectionVM<unknown>) =>
    section.state === 'failed' || section.state === 'retrying'
  const linkEditor = (row: RelatedTaskVM) => canRelate || rowEditor(row)
  const canUnlink = (row: RelatedTaskVM) => current && !waits(linked) && linkEditor(row)
  const canDetach = (row: RelatedTaskVM) => current && !waits(subtasks) && rowEditor(row)
  // the links the picker lists, those the person could take off in any
  // state of the window's read, so a picker opened while that read fails
  // or runs again lists them, locked
  const linkLister = (row: RelatedTaskVM) => canLabel || answerEditorOn || rowEditor(row)
  // the removals on their way of rows the workspace does not hold, which
  // stay listed until their answer drops them
  const [removing, setRemoving] = useStateID<ReadonlySet<string>>(new Set())
  const removeOnce = (uuid: string, send: () => Promise<boolean>) => {
    if (removing.has(uuid)) return
    setRemoving((now) => new Set(now).add(uuid))
    void send().then(() =>
      setRemoving((now) => {
        const next = new Set(now)
        next.delete(uuid)
        return next
      }),
    )
  }
  // The pickers show the window's own current relations first, checked,
  // those the person could take off, and say so while the list they come
  // from is not whole. While a removal waits (canDetach, canUnlink) they
  // show without taking a press. Each picker gets every relation its list
  // holds, those the person cannot take off marked `locked`, so one whose
  // access changed while the picker is open stays checked and locked
  // rather than show as taken off. A subtask the workspace does not hold
  // carries its row from the window's answer, so the picker can make it a
  // subtask again once it took it off.
  const notWhole = (section: SectionVM<unknown>, what: string) =>
    section.state === 'loading'
      ? `Loading the current ${what}…`
      : section.state === 'ready' && section.complete
        ? null
        : `Some current ${what} could not be loaded.`
  const currentParent: CurrentRelations = { rows: parentRow ? [parentRow] : [], note: null }
  const currentSubtasks: CurrentRelations = {
    rows: subtasks.rows.map(
      (row): CurrentRelation => ({
        ...row,
        row: row.held ? undefined : (P.subtaskPickRow(row.uuid) ?? undefined),
        ...(rowEditor(row) ? {} : { locked: true }),
      }),
    ),
    note: notWhole(subtasks, 'subtasks'),
    locked: !current || waits(subtasks),
  }
  const currentLinks: CurrentRelations = {
    rows: linked.rows.map(
      (row): CurrentRelation => ({ ...row, ...(linkLister(row) ? {} : { locked: true }) }),
    ),
    note: notWhole(linked, 'linked tasks'),
    locked: !current || waits(linked),
  }

  // the discussion spine: this issue's comments and activity interleaved in
  // chat order — oldest at the top, newest at the bottom where the reply box
  // is and where the scroller opens. The Comments filter drops the events
  // from the merge, and the store loads them only under All (showHistory).
  // Under All, while the start of the comments or of the history is not
  // loaded, rows older than the later of the two oldest loaded rows stay
  // hidden, so All never shows one beside a gap in the other (spineWindow).
  // History that has not arrived, or failed before it did, is no whole
  // history, so All then shows nothing beside it. A comment the store holds
  // apart for another window's editor (P.pinnedComments) shows only there.
  // A row it holds apart at an instant only the other kind's live rows hold
  // (P.threadApart) sits among the rows it let go, so it shows nowhere,
  // unless this window has it open in its editor.
  const pinned = new Set(P.pinnedComments)
  const apart = new Set(P.threadApart)
  const comments = it
    ? P.comments.filter(
        (c) =>
          c.issue === it.uuid &&
          ((!pinned.has(c.id) && !apart.has(c.id)) || c.id === editingComment),
      )
    : []
  // a row names a task the workspace holds by its handle, and one it does
  // not hold by its uuid (store/viewModels.ts shapeActivity)
  const history = it
    ? P.threadEvents.filter(
        (e) =>
          !apart.has(e.id) &&
          e.targetType === 'issue' &&
          (e.targetId === it.id || e.targetId === it.uuid),
      )
    : []
  const all = actFilter === 'all'
  // whether everything the filter shows has arrived, and whether the thread
  // says it is loading: under All also while the history is on its way,
  // unless the history's failure row speaks for it (ThreadFailure)
  const loaded = P.commentsLoaded && (!all || P.historyLoaded)
  const waitingComments = !P.commentsLoaded && P.commentsFailure === 'none'
  const waitingLine = all
    ? (waitingComments || !P.historyLoaded) && P.historyFailure === 'none'
    : waitingComments
  const from = spineWindow(
    {
      rows: comments.filter((c) => !pinned.has(c.id) && !apart.has(c.id)),
      whole: P.commentsLoaded && P.commentsEarlier === 'none',
    },
    { rows: history, whole: P.historyLoaded && P.historyEarlier === 'none' },
  )
  // The comment being edited in place stays whatever the window, so neither
  // choosing All nor the history arriving unmounts its editor with the
  // draft in it.
  const spine = all
    ? mergeSpine(
        comments.filter((c) => c.ts >= from.start || c.id === editingComment),
        history.filter((e) => e.ts >= from.start),
      )
    : mergeSpine(comments, [])
  // Past its budget the store lets go of rows between the two runs it keeps
  // (P.threadGap), and the newer row stands where they were. Under All rows
  // strictly between the two kinds' gaps stay hidden, so none shows beside a
  // gap in the other kind, and the comment in this window's editor shows
  // whatever the gap hides (spineGap, splitSpine). A gap wholly above where
  // All's spine starts shows no row, since nothing above it shows
  // (newerRow).
  const gapSides = {
    comments: P.threadGap?.comments ?? null,
    events: all ? (P.threadGap?.history ?? null) : null,
  }
  const gap = spineGap(gapSides.comments, gapSides.events)
  const parts = splitSpine(spine, gap, gapSides, editingComment)
  const shown = [...parts.above, ...parts.below]
  const newer = newerRow(
    gap,
    all ? from.start : Number.NEGATIVE_INFINITY,
    all ? [P.commentsNewer, P.historyNewer] : [P.commentsNewer],
  )
  // What the first row says: Comments pages its comments, All both.
  const sides = all ? [P.commentsEarlier, P.historyEarlier] : [P.commentsEarlier]
  const earlier: CommentsEarlier = sides.includes('loading')
    ? 'loading'
    : sides.includes('failed')
      ? 'failed'
      : sides.includes('more')
        ? 'more'
        : 'none'
  // "Show earlier comments" adds a page above the first row. The reader
  // keeps their place, because that row stays where it was on screen in
  // whichever ancestor scrolls (the spine, the stacked window's shared
  // scroller or the phone page). Keyboard focus that went with the pressed
  // control moves to the control that replaces it, or to the thread's first
  // row once none does, unless the reader moved focus elsewhere meanwhile.
  // Rows are found from the pressed control, because the Activity window
  // renders the thread outside this frame.
  const earlierFrom = useRefID<{
    feed: Element
    row: Element | null
    top: number
    focused: boolean
  } | null>(null)
  const loadEarlier = (control: HTMLElement) => {
    const feed = control.closest('[data-spine-feed]')
    if (feed) {
      const row = feed.querySelector('[data-comment], [data-event]')
      const focused = document.activeElement === control && !lastInputWasPointer()
      earlierFrom.current = { feed, row, top: 0, focused }
    }
    // the sides whose page moves the spine back, and any that failed
    if (!all || from.load.comments || P.commentsEarlier === 'failed') void P.loadEarlierComments()
    if (all && (from.load.events || P.historyEarlier === 'failed')) void P.loadEarlierHistory()
  }
  // Measured while rendering the page in, when the screen still shows the
  // thread without it, so scrolling while it loaded is kept as well.
  const pending = earlierFrom.current
  if (pending?.row?.isConnected && earlier !== 'loading') {
    pending.top = pending.row.getBoundingClientRect().top
  }
  useLayoutEffectID(() => {
    const pressed = earlierFrom.current
    if (!pressed || earlier === 'loading') return
    earlierFrom.current = null
    if (pressed.row?.isConnected) {
      const shift = pressed.row.getBoundingClientRect().top - pressed.top
      if (shift !== 0) scrollerOf(pressed.row).scrollTop += shift
    }
    const active = document.activeElement
    if (pressed.focused && (active === null || active === document.body)) {
      const next =
        pressed.feed.querySelector<HTMLElement>('[data-earlier-comments] button') ??
        firstRowForFocus(pressed.feed)
      next?.focus({ preventScroll: true })
    }
  }, [earlier, shown.length])
  // "Show newer comments" adds a page under the row above it and lets go of
  // rows at the oldest end. That row stays where it was on screen, measured
  // and shifted as for Show earlier, so a release above it does not move
  // what the reader sees. Focus that went with the pressed control moves to
  // the control that replaces it, or once the gap closed to the first row
  // that came in, unless the reader moved it meanwhile.
  const newerFrom = useRefID<{
    feed: Element
    row: Element | null
    top: number
    focused: boolean
  } | null>(null)
  const loadNewer = (control: HTMLElement) => {
    const feed = control.closest('[data-spine-feed]')
    const box = control.closest('[data-newer-comments]')
    if (feed && box) {
      let row = box.previousElementSibling
      while (row && !row.matches('[data-comment], [data-event]')) row = row.previousElementSibling
      const focused = document.activeElement === control && !lastInputWasPointer()
      newerFrom.current = { feed, row, top: 0, focused }
    }
    // the kinds whose page moves the gap's start on, and any that failed
    if (!all || gap?.load.comments || P.commentsNewer === 'failed') void P.loadNewerComments()
    if (all && (gap?.load.events || P.historyNewer === 'failed')) void P.loadNewerHistory()
  }
  const newerPending = newerFrom.current
  if (newerPending?.row?.isConnected && newer !== 'loading') {
    newerPending.top = newerPending.row.getBoundingClientRect().top
  }
  useLayoutEffectID(() => {
    const pressed = newerFrom.current
    if (!pressed || newer === 'loading') return
    newerFrom.current = null
    if (pressed.row?.isConnected) {
      const shift = pressed.row.getBoundingClientRect().top - pressed.top
      if (shift !== 0) scrollerOf(pressed.row).scrollTop += shift
    }
    const active = document.activeElement
    if (pressed.focused && (active === null || active === document.body)) {
      const next =
        pressed.feed.querySelector<HTMLElement>('[data-newer-comments] button') ??
        rowAfterForFocus(pressed.row)
      next?.focus({ preventScroll: true })
    }
  }, [newer, shown.length])
  // The window reports the first comment or change on screen as the reader
  // scrolls (P.threadPlace), or null while the newest row shows, or the
  // composer where it scrolls with the rows, so a release keeps the rows
  // the reader sees and a comment that arrives past the budget lets go of
  // rows away from them. An IntersectionObserver rooted at the viewport
  // sees the rows of the floating window's spine, the phone's feed and the
  // Inbox pane alike.
  const placeOwner = useRefID({})
  const placeRow = useRefID<Element | null>(null)
  const spineKey = `${shown.length}:${shown[0]?.id ?? ''}:${shown.at(-1)?.id ?? ''}:${newer}`
  useEffectID(() => {
    const owner = placeOwner.current
    const scroller = actScrollRef.current
    const feed = scroller?.matches('[data-spine-feed]')
      ? scroller
      : scroller?.querySelector('[data-spine-feed]')
    if (!feed || typeof IntersectionObserver === 'undefined') return
    // The composer marks the newest end only where it scrolls with the
    // rows, inside the scroller. On a phone the feed scrolls on its own
    // above a composer that always shows, so the place comes from the
    // feed's rows alone.
    const composer = scroller?.querySelector('[data-composer]') ?? null
    const rows = [...feed.querySelectorAll('[data-comment], [data-event]')]
    const seen = new Set<Element>()
    const report = () => {
      const first = rows.find((row) => seen.has(row)) ?? null
      placeRow.current = first
      const newest = rows.at(-1)
      const atEnd =
        first === null ||
        (newest !== undefined && seen.has(newest)) ||
        (composer !== null && seen.has(composer))
      P.threadPlace(
        owner,
        atEnd ? null : (first.getAttribute('data-comment') ?? first.getAttribute('data-event')),
      )
    }
    const watch = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) seen.add(entry.target)
        else seen.delete(entry.target)
      }
      report()
    })
    for (const row of rows) watch.observe(row)
    if (composer) watch.observe(composer)
    return () => watch.disconnect()
  }, [spineKey, focus, mobile, watchUuid])
  useEffectID(() => {
    const owner = placeOwner.current
    return () => P.threadPlace(owner)
  }, [])
  // A comment that arrives past the budget lets go of rows above the screen.
  // Chromium and Firefox keep the reader's place themselves through CSS
  // scroll anchoring; where the browser does not, as in Safari, the first
  // row on screen stays where it was, measured while rendering and shifted
  // after layout as a press does, except while a press keeps its own row.
  const placeTop = useRefID<number | null>(null)
  placeTop.current = null
  if (
    !SCROLL_ANCHORING &&
    !earlierFrom.current &&
    !newerFrom.current &&
    placeRow.current?.isConnected
  )
    placeTop.current = placeRow.current.getBoundingClientRect().top
  useLayoutEffectID(() => {
    const top = placeTop.current
    const row = placeRow.current
    placeTop.current = null
    if (top === null || !row?.isConnected) return
    const shift = row.getBoundingClientRect().top - top
    if (shift !== 0) scrollerOf(row).scrollTop += shift
  })
  // nothing is said until the thread is in, and under All its history too:
  // watchComments empties the cache first, and against an empty spine every
  // mark degrades to 'tail' — which would flash "New activity on this task"
  // over "Loading comments…" and then resolve into a rule somewhere else
  // It is placed in the rows as shown, so when the unread part starts among
  // released rows it sits under Show newer comments, above the first row
  // after the gap, as it sits under Show earlier comments at the top.
  const mark = loaded ? unreadMark(shown, unreadTs) : { place: 'none', index: -1 }
  // 'tail': something is unread but nothing on screen is at or after it — say
  // so in words rather than drawing a rule with nothing under it. Under
  // Comments, name the All filter when the unread messages tell of a change,
  // frozen with the boundary, since Comments loads no history. It says
  // where changes show rather than that All shows this one: whether the
  // person may see that change's row is the server's to decide.
  const tailNote =
    it && actFilter === 'comments' && frozen.current.unread?.change
      ? 'New activity on this task. Changes show only under All.'
      : 'New activity on this task.'
  /* Resolves whether the server saved the comment; the composer keeps the
     draft until it did. */
  const postComment = (text: string): Promise<boolean> => {
    if (!it) return Promise.resolve(false)
    const saved = P.addComment(it.uuid, text)
    // chat order: follow the fresh comment to the bottom. One tick late —
    // addComment emits synchronously but React's re-render is scheduled, so
    // reading scrollHeight now would use the pre-append height.
    setTimeout(() => {
      const el = actScrollRef.current
      if (narrow && focus !== 'activity') {
        // The shared stacked scroller continues into Details below Activity.
        // Follow the reply box, rather than jumping to the end of Details.
        el?.querySelector('[data-composer]')?.scrollIntoView({ block: 'nearest' })
      } else if (el) el.scrollTop = el.scrollHeight
    }, 0)
    return saved
  }
  const labelClass = 'text-md font-semibold text-text-1'

  /* The description field and the Activity thread each render in exactly ONE
     of two places — in the discussion column, or alone in a focus window — so
     they are written once here and called from whichever is mounted. Never
     both: two copies of the description would be two drafts of one field, and
     two composers two drafts of one reply. The column simply stops rendering
     its copy while the window is up. The window covers most of the gap, and
     its backdrop blurs the rest.
     `capped` is the whole difference. In the column the field stops at a
     fraction of the viewport and scrolls inside itself, leaving room for
     everything under it; popped out it IS the window, so it fills it. */
  const descBody = (capped: boolean) => {
    const box: React.CSSProperties = capped
      ? {
          maxHeight: mobile
            ? Math.max(180, Math.min(400, mobileViewport.height * 0.55))
            : narrow
              ? '22vh'
              : '32vh',
        }
      : { flex: 1, minHeight: 0 }
    return canLabel || answerEditorOn ? (
      // always-mounted, editable in place; while the editor chunk loads the
      // same content renders through Markdown, and both share the .md styles
      // so the swap is seamless. The border (solid twin of the attachments
      // drop zone) marks it as an input; drafts persist only through the
      // editor's Save bar. The cap scrolls INSIDE that border — the text
      // does, between the formatting row and the Save bar (.descfield-capped);
      // the composer below has always capped itself that way, and this one
      // didn't: on an outer wrapper the field's own bottom edge scrolled out
      // of view, leaving its two side borders hanging cut off with nothing
      // closing them. The Activity rule underneath used to hide that; since
      // deviation #65 there is no rule, so the box has to close itself.
      <div
        ref={descWrapRef}
        className="descfield descfield-capped"
        style={box}
        onClick={(e) => {
          if (e.target === e.currentTarget && descRef.current) descRef.current.focus()
        }}
      >
        {/* 104 = the 32px row + the field's 72px floor; a short reservation
            lets useBottomSnap measure the wrong height */}
        <EditorSlot
          fallback={
            <div className="[min-height:104px]">
              {it.description ? <Markdown text={it.description} /> : null}
            </div>
          }
        >
          {/* keyed by the task, not its handle: in-modal navigation swaps
              issues in place, and the editor's committed-text refs are
              per-issue state, but a new task's handle may move while the
              person types (P.watchHandles) */}
          <DescEditor
            key={it.uuid}
            ref={descRef}
            issueKey={it.id}
            org={it.org}
            value={it.description || ''}
          />
        </EditorSlot>
      </div>
    ) : it.description ? (
      // a viewer's copy has no field border to close, so the cap stays on the
      // wrapper here, and the text scrolls inside it, as in the field, rather
      // than over Activity; descWrapRef rides whichever of the two is
      // mounted, which is what the per-issue scroll reset resets
      <div ref={descWrapRef} style={box} className="overflow-y-auto overscroll-contain">
        <Markdown text={it.description} />
      </div>
    ) : (
      <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
        No description.
      </div>
    )
  }

  /* The thread starts at the TOP of the scroller and the reply box follows the
     last row INSIDE it — the box comes up to the conversation rather than the
     conversation going down to the box. (Bottom-aligning the spine was tried
     and rejected: it pushed a short thread to the floor of the column and left
     the gap above it instead of below, which reads as an empty panel.) */
  const spineScroller = (pad: string) => (
    <div
      ref={mobile ? undefined : actScrollRef}
      data-spine-scroll
      style={{ padding: mobile ? 0 : pad }}
      className="[flex:1] [min-height:0] [overflow-y:auto]"
    >
      {/* No spine hairline any more (deviation #65): the column of avatars and
          glyph nodes is the line — they sit on one 28px axis, which is what the
          rule was drawn to trace. The gap goes up with it, since nothing
          threads the rows together now. */}
      <div data-spine-feed ref={mobile ? actScrollRef : undefined}>
        <div data-spine className="relative flex flex-col gap-4">
          {waitingLine && (
            <div
              data-thread-loading
              className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]"
            >
              {all ? 'Loading activity…' : 'Loading comments…'}
            </div>
          )}
          {/* under All, nothing earlier can load before the history is in */}
          {loaded && earlier !== 'none' && (
            <EarlierComments
              state={earlier}
              what={all ? 'activity' : 'comments'}
              onLoad={loadEarlier}
            />
          )}
          {shown.flatMap((s, i) => {
            const row =
              s.kind === 'c' ? (
                <CommentRow
                  key={s.id}
                  c={s.c}
                  it={it}
                  canLead={canLead}
                  locked={archived}
                  editing={editingComment === s.id}
                  onEdit={setEditingComment}
                  onDoneEdit={() => setEditingComment(null)}
                />
              ) : (
                <EventRow key={s.id} e={s.e} />
              )
            // one index, so the mark can only ever be drawn once
            const rows =
              mark.place === 'mark' && i === mark.index
                ? [<UnreadDivider key="unread" />, row]
                : [row]
            // the newer row stands between the two parts, over the mark
            return loaded && newer !== 'none' && i === parts.above.length
              ? [
                  <NewerComments
                    key="newer"
                    state={newer}
                    what={all ? 'activity' : 'comments'}
                    onLoad={loadNewer}
                  />,
                  ...rows,
                ]
              : rows
          })}
          {loaded && newer !== 'none' && parts.below.length === 0 && (
            <NewerComments state={newer} what={all ? 'activity' : 'comments'} onLoad={loadNewer} />
          )}
          {loaded &&
            P.commentsFailure === 'none' &&
            (!all || P.historyFailure === 'none') &&
            shown.length === 0 &&
            earlier === 'none' &&
            newer === 'none' && (
              <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
                {actFilter === 'comments' ? 'No comments yet.' : 'No activity yet.'}
              </div>
            )}
          {mark.place === 'tail' && <UnreadDivider key="unread" place="tail" note={tailNote} />}
          {/* a failed thread never passes for an empty one. The comments
              that did load stay, and this row closes the thread. It says
              "the latest" only while the thread shows some of them. */}
          {P.commentsFailure !== 'none' && (
            <ThreadFailure
              state={P.commentsFailure}
              shown={shown.some((s) => s.kind === 'c')}
              onRetry={P.retryComments}
            />
          )}
          {/* …and failed history never passes for no history: under All
              its own row closes the thread, and the comments' stays theirs */}
          {all && P.historyFailure !== 'none' && (
            <ThreadFailure
              state={P.historyFailure}
              what="activity"
              shown={shown.some((s) => s.kind === 'e')}
              onRetry={P.retryHistory}
            />
          )}
        </div>
      </div>

      {/* The reply box is the last thing IN the thread, not a bar under the
          column: it sits directly beneath the newest row and scrolls with it,
          so on a short thread it is up where the conversation is instead of
          stranded at the floor. No rule above it — deviation #65 took the rules
          out of this window and 16px of space is the parting. The 26vh cap
          stays: the draft scrolls inside the field, between its formatting
          row and its buttons, rather than in this scroller. */}
      {canComment && (
        <div data-composer className="[display:flex] [gap:10px] [margin-top:16px]">
          <span className="[margin-top:9px] [flex-shrink:0]">
            <Avatar id={P.CURRENT_USER} size={28} />
          </span>
          <div className="[flex:1] [min-width:0]">
            <div
              className="descfield descfield-capped max-h-[26vh]"
              onClick={(e) => {
                if (e.target === e.currentTarget && composerRef.current) composerRef.current.focus()
              }}
            >
              <EditorSlot fallback={<div className="[min-height:104px]" />}>
                {/* the description field, verbatim — same dialect, same
                    Save/Discard contract; posting clears it (reset) */}
                <DescEditor
                  key={it.uuid}
                  ref={composerRef}
                  issueKey={null}
                  org={it.org}
                  value=""
                  placeholder="Leave a comment…"
                  ariaLabel="Leave a comment"
                  comment={{ label: 'Comment', reset: true, onCommit: postComment }}
                />
              </EditorSlot>
            </div>
          </div>
        </div>
      )}
    </div>
  )

  /* Both headings carry one: the section, on its own, in a window big enough
     to read a long one in. Same glyph as the whole-task pop-out beside the
     title, because it is the same promise at a smaller scale. */
  const focusBtn = (which: 'desc' | 'activity', what: string, hook: string) => (
    <Button
      variant="ghost"
      size="icon"
      {...{ [hook]: '' }}
      className="w-control-sm h-control-sm [flex-shrink:0]"
      onClick={() => openFocus(which)}
      aria-label={`Open ${what} in a window`}
      title={`Open ${what} in a window`}
    >
      <Icon name="externalLink" size={16} />
    </Button>
  )
  const actSeg = (
    <Seg
      height={24}
      fit
      value={actFilter}
      onChange={setActFilter}
      options={[
        { value: 'all', label: 'All' },
        { value: 'comments', label: 'Comments' },
      ]}
    />
  )

  /* The window's first two lines, drawn the same way by every window that is
     about this task: where it lives, the window's own controls in the corner,
     and the task's name under them. A popped-out section gets it too — it is a
     view OF this task, and a bare `QN-5` badge said much less about which task
     than the two lines the window it came from is showing behind the blur.
     What differs is `chrome` (the task window carries its actions menu, a
     focus window just its own close) and `live`, which is the difference
     between a window the task LIVES in and a view of one of its halves: only
     the live one lets you rename by clicking the title and offers the
     whole-task pop-out. A task shown from its answer keeps its title as it
     is (`held`). Every header links its project and sub-project to their
     boards, including a section's focus window.
     Note both copies carry the SAME hooks. That is the honest encoding of "it
     is the same heading", and it is safe because the task window is rendered
     first: a document-level `querySelector('[data-issue-key]')` still finds
     it, and in any case both name one task. Drives that mean the focus
     window's copy scope through `[data-focus-window]`. */
  const windowHead = ({
    chrome,
    live,
    padBottom = 16,
  }: {
    chrome: React.ReactNode
    live: boolean
    padBottom?: number
  }) => (
    <>
      {showResume && (
        <div data-task-paused className="task-paused-tab" role="status">
          <Icon name="pause" size={12} strokeWidth={3} />
          Paused
        </div>
      )}
      <div
        data-task-topbar
        className="[display:flex] [align-items:center] [gap:9px] [padding:8px_20px_0] [flex-shrink:0]"
      >
        {mobile && live && (
          <Button
            type="button"
            variant="ghost"
            data-mobile-task-back
            className="task-mobile-back"
            onClick={onClose}
          >
            <Icon name="chevronLeft" size={20} />
            {closeLabel}
          </Button>
        )}
        {meta || proj ? (
          <nav
            data-task-crumb
            aria-label="Task location"
            className="[display:flex] [align-items:center] [gap:2px] [flex-wrap:wrap] [flex:1] [min-width:0]"
          >
            {[meta, meta && proj && meta.id !== proj.id ? proj : null]
              .filter(Boolean)
              .map((p, i) => (
                <React.Fragment key={p.id}>
                  {i > 0 && <Icon name="chevronRight" size={12} color="var(--text-3)" />}
                  <HoverTooltip content={`Show ${p.name} on the board`}>
                    <a
                      // the place a plain click goes: the Board with this task's
                      // window over it, or on a phone, where the window fills
                      // the screen, the task list without it
                      href={buildPath({
                        scope: p.id,
                        view: 'kanban',
                        openIssue: mobile ? null : it.id,
                      })}
                      data-task-crumb-project={p.id}
                      onClick={(e) => {
                        if (
                          !onShowOnBoard ||
                          e.defaultPrevented ||
                          e.button !== 0 ||
                          e.metaKey ||
                          e.ctrlKey ||
                          e.shiftKey ||
                          e.altKey
                        )
                          return
                        e.preventDefault()
                        onShowOnBoard(p.id, it.id, !mobile)
                      }}
                      className="max-w-60 overflow-hidden text-ellipsis whitespace-nowrap rounded-sm px-1 py-0.5 text-sm text-text-3 no-underline hover:bg-hover hover:text-text-1 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    >
                      <ProjectName project={p} />
                    </a>
                  </HoverTooltip>
                </React.Fragment>
              ))}
          </nav>
        ) : (
          // with no crumb there is nothing to push the chrome right
          <div className="[flex:1]" />
        )}
        {chrome}
      </div>
      {/* the title row: what the task IS, under the chrome that acts on it */}
      {/* 20px sides, not the old 16: with no rule under it, alignment is what
          says where the window's content column starts, and both columns below
          pad to 20 (deviation #65) */}
      {/* 6px on top, not 14: the top bar above already carries the window's
          top air, in every frame now */}
      <header
        data-issue-header
        style={{ padding: mobile ? '8px 16px 12px' : `6px 20px ${padBottom}px` }}
        className="[display:flex] [align-items:center] [gap:9px] [flex-shrink:0]"
      >
        <Icon name="layers" size={16} color="var(--primary)" />
        {/* The title and the pop-out travel together in their own flex box,
            and the FLEX lives on the box rather than on the title: a `flex: 1`
            h1 fills the header, which parked the button at the far right
            beside the window's controls — where it read as window chrome.
            Inside the box the title wraps when needed and the button follows
            it, because it is
            about the TASK, not the window. */}
        <div className="[flex:1] [min-width:0] [display:flex] [align-items:center] [gap:6px]">
          {live && (held || answerEditorOn) && editTitle ? (
            <LimitedTextarea
              limit={LIMITS.title}
              autoFocus
              aria-label="Task title"
              rows={1}
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const v = titleDraft.trim()
                // a title over the cap keeps the field open with the draft,
                // unless it is the title as it was
                if (v !== titleSeen && overLimit(LIMITS.title, v)) {
                  window.showToast?.(limitSentence(LIMITS.title), 'error')
                  return
                }
                if (v && v !== titleSeen) {
                  // a paused save keeps the field open with the draft, and so
                  // does one from an answer that is not current
                  if (P.refusePausedEdit() || P.refuseStaleEdit(it.id)) return
                  // refused over someone else's rename, the field opens again
                  // with this draft (keepDraft), unless the person has moved on
                  const session = titleSession.current
                  const task = it.uuid
                  void P.updateIssue(
                    it.id,
                    { title: v },
                    {
                      seen: { title: titleSeen },
                      keepDraft: (shown) => {
                        if (!mountedRef.current || titleSession.current !== session) return false
                        if (shownUuid.current !== task) return false
                        // the field takes focus when it opens, so only while
                        // nothing else holds it
                        const at = document.activeElement
                        if (at && at !== document.body) return false
                        // the rename shown now is the title a second save
                        // replaces; until a delivery shows it, wait for it
                        if (typeof shown === 'string' && shown !== titleSeen) setTitleSeen(shown)
                        else titleRebase.current = true
                        setTitleDraft(v)
                        setEditTitle(true)
                        return true
                      },
                    },
                  )
                }
                setEditTitle(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  e.currentTarget.blur()
                }
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditTitle(false)
                }
              }}
              wrapperClassName="[flex:1]"
              className="min-h-0 [margin:0] [font-size:var(--fs-xl)] [font-weight:600] [line-height:1.3] [letter-spacing:-0.01em] [font-family:var(--sans)] [color:var(--text-1)] [background:var(--surface-1)] [border:1px_solid_var(--border-strong)] [border-radius:var(--r-sm)] [padding:3px_8px] [outline:none] [resize:none]"
            />
          ) : (
            <HoverTooltip content={live && (held || answerEditorOn) ? 'Edit title' : undefined}>
              <h1
                data-task-title
                onClick={
                  live && (held || answerEditorOn)
                    ? () => {
                        setTitleDraft(it.title)
                        setTitleSeen(it.title)
                        titleRebase.current = false
                        titleSession.current++
                        setEditTitle(true)
                      }
                    : undefined
                }
                style={{ cursor: live && (held || answerEditorOn) ? 'text' : 'default' }}
                className="[min-width:0] [margin:0] [font-size:var(--fs-xl)] [font-weight:600] [line-height:1.3] [letter-spacing:-0.01em] [color:var(--text-1)] break-words"
              >
                {it.title}
              </h1>
            </HoverTooltip>
          )}
          {/* the same window, floating, with the details column the pane has
              no room for */}
          {live && onPopOut && !editTitle && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-task-popout
              className="w-control-sm h-control-sm [flex-shrink:0]"
              onClick={onPopOut}
              aria-label="Open task in a window"
              title="Open task in a window"
            >
              <Icon name="externalLink" size={16} />
            </Button>
          )}
        </div>
      </header>
    </>
  )

  /* A focus window acts on nothing — archiving or deleting from inside a view
     of one half would leave the view standing on a task that had gone. Its
     corner is the key it is about and its own way out. */
  const focusChrome = (
    <div
      data-focus-chrome
      className="[display:flex] [align-items:center] [gap:9px] [flex-shrink:0]"
    >
      <span data-issue-key className="[display:inline-flex] [align-items:center]">
        <IssueKey id={it ? it.key : ''} />
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-focus-close
        className="w-control-sm h-control-sm"
        onClick={closeFocus}
        aria-label="Close (esc)"
        title="Close (esc)"
      >
        <Icon name="close" size={16} />
      </Button>
    </div>
  )

  // close only when the CLICK also STARTED on the frame around the window.
  // Releasing a text drag (title/description selection) past the modal edge
  // fires a click on the frame as the common ancestor and must not nuke the
  // draft
  const scrimDownRef = useRefID(false)
  // The backdrop fades with the window, and so does a phone's full-screen
  // frame. The desktop frame never fades, because an opacity below 1 would
  // cut the window's blur off from the page for the length of the fade.
  const fade: React.CSSProperties = {
    opacity: open ? 1 : 0,
    transition: reduceMotion ? 'none' : 'opacity var(--dur-mid) var(--ease-out)',
  }
  return (
    <>
      {/* Two frames, one window. Floating, it uses the theme's window material,
          sized and animated like the create dialogs. Embedded, there is no
          scrim to float over and nothing to animate in: it simply IS the pane
          it was handed, so the card loses the border, radius and shadow that
          only ever said "this is standing off the page". */}
      <div
        ref={frameRef}
        data-mobile-task-frame={mobile && (embedded || open) ? '' : undefined}
        // the probe an embedded pane reads to yield Escape to a pop-out of
        // itself — only while one is actually up: outside the inbox a closed
        // floating window stays mounted at opacity 0, and a frame nobody can
        // see must not silence a pane's Escape
        data-task-scrim={!embedded && open ? '' : undefined}
        className={cn(
          embedded
            ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
            : 'fixed inset-0 z-[60] grid items-start justify-items-center overflow-y-auto px-[3vw] pt-[calc(4vh+var(--float-inset-top))] pb-[calc(4vh+var(--float-inset-bottom))]',
          // Override the mobile stylesheet's inset so the measured visual
          // viewport, including its keyboard offset, determines the frame.
          mobile && '!bottom-auto',
        )}
        // A press that dismisses an open menu must not also close the window
        // (layered dismissal): Radix portals a field select's list and a
        // popover outside this tree, and the pointer-events:none it puts on
        // <body> stops at this frame, which sets its own. Read on pointerdown,
        // which reaches this handler before Radix's document-level listener
        // dismisses the menu — so the menu is still in the DOM to be found.
        onPointerDown={
          embedded
            ? undefined
            : (e) => {
                scrimDownRef.current =
                  e.target === e.currentTarget &&
                  !document.querySelector('[data-fieldselect-menu], [data-slot="popover-content"]')
              }
        }
        onClick={
          embedded
            ? undefined
            : (e) => {
                if (e.target === e.currentTarget && scrimDownRef.current) onClose()
                scrimDownRef.current = false
              }
        }
        style={{
          ...(!embedded ? { pointerEvents: open ? 'auto' : 'none', ...(mobile ? fade : {}) } : {}),
          ...(mobile
            ? {
                height: mobileFrame.height,
                top: mobileFrame.top,
                // the status bar's room, less what the notices' band above
                // the frame already holds
                paddingTop: `max(0px, env(safe-area-inset-top) - ${mobileFrame.top - mobileViewport.top}px)`,
              }
            : {}),
        }}
      >
        {/* The backdrop stands beside the window rather than around it, so the
            window's own blur still reaches the page (appearance.css). A phone's
            window fills the screen and needs none. */}
        {!embedded && !mobile && (
          <div
            data-scrim
            aria-hidden="true"
            className="pointer-events-none fixed inset-0 -z-1"
            style={fade}
          />
        )}
        {/* the dialog IS the window: one card, the shared chrome on top and the
          discussion + details columns below */}
        {/* Open as a dialog, the page behind is inert (see the focus effect)
            rather than marked off with aria-modal, which would also silence
            the announcer for toasts. */}
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is dialog or region, and both take aria-label — Biome cannot evaluate the ternary */}
        <div
          role={embedded && !mobile ? 'region' : 'dialog'}
          data-floating-surface={embedded && !mobile ? undefined : ''}
          aria-hidden={!open ? true : undefined}
          aria-label="Task"
          data-issue-design="alignment"
          data-issue-layout={
            mobile ? 'mobile' : embedded ? 'embedded' : narrow ? 'stacked' : 'columns'
          }
          data-mobile-task={mobile ? '' : undefined}
          data-mobile-task-compact={mobile && mobileFrame.height < 600 ? '' : undefined}
          data-mobile-tab={mobile ? mobileTab : undefined}
          // for the drives: whether the task shows from the workspace or
          // from the window's own read, and whether it is archived
          data-task-source={held ? 'workspace' : it ? 'answer' : undefined}
          data-task-archived={archived ? '' : undefined}
          className={`flex flex-col overflow-hidden bg-background !outline-none ${
            embedded
              ? 'min-h-0 min-w-0 flex-1 rounded-none border-0 shadow-none'
              : 'w-[1110px] h-[calc(92vh-var(--float-inset-y))] max-w-[94vw] rounded-xl border border-border shadow-pop'
          }`}
          onClick={embedded ? undefined : (e) => e.stopPropagation()}
          style={
            embedded
              ? undefined
              : {
                  transform: mobile ? 'none' : open || reduceMotion ? 'scale(1)' : 'scale(.97)',
                  opacity: open ? 1 : 0,
                  transition: reduceMotion
                    ? 'none'
                    : 'transform .18s var(--ease-out), opacity .18s var(--ease-out)',
                }
          }
        >
          {gone && !it && (
            <TaskGone
              key={taskKey}
              task={gone}
              found={goneAnswer}
              canRestore={canRestore}
              projectArchived={projectArchived}
              onRetry={P.retryTask}
              retryUnavailable={retryUnavailable}
              // the open Archive or delete window's reason, in the render
              // where the task goes, before the effect above keeps it
              unusedReason={fateOpen ? fateReason.current.trim() || null : unusedReason}
              onCopied={setCopiedReason}
              onClose={onClose}
              mobile={mobile}
            />
          )}
          {waiting && (
            <div data-task-loading className="flex items-center gap-3 p-6 text-sm text-text-2">
              <span role="status" className="flex-1">
                Loading this task…
              </span>
              <Button type="button" variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          )}
          {it && (
            <>
              {/* Where the task lives, over its title, and the window's own
                controls hard against the top-right corner. The breadcrumb
                began as the embedded pane's stand-in for the details column it
                has no room for, and it reads better than the labelled rows
                that column was carrying — so the rows are gone (#81) and this
                is the one place the app says where a task lives. The controls
                used to ride the title row below, vertically centred on it,
                which put the close button a whole crumb-line down from the
                corner it belongs in, with the corner itself left empty (#82).
                Both lines are `windowHead`, which a popped-out section draws
                too: it is a view OF this task, and says which one the same
                way rather than by a bare key badge. */}
              {windowHead({
                live: true,
                chrome: (
                  <div
                    data-task-chrome
                    className="[display:flex] [align-items:center] [gap:9px] [flex-shrink:0]"
                  >
                    {/* a task shown from its answer follows and opens its
                        Subscribers from that answer, for anyone it shows
                        the task to, while its read is current; an archived
                        one has no eye */}
                    {!archived && (
                      <IssueSubscribers
                        key={it.uuid}
                        issue={it}
                        disabled={held || P.editsFromAnswer(it.id) ? undefined : WAITS_FOR_CHECK}
                      />
                    )}
                    <span data-issue-key className="[display:inline-flex] [align-items:center]">
                      <IssueKey id={it.key} />
                    </span>
                    <Popover
                      align="right"
                      width={210}
                      button={(t) => (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="w-control-sm h-control-sm"
                          onClick={() => t()}
                          aria-label="Task actions"
                          title="Task actions"
                        >
                          <Icon name="more" size={16} />
                        </Button>
                      )}
                    >
                      {(close) => (
                        <>
                          {/* the inbox pane is the one host that isn't the board,
                            so only there does the menu offer the way over to it:
                            the same jump as the row's right-click entry, for a
                            task the workspace holds only, since the Board may
                            hold no card of another one to reveal */}
                          {embedded && onShowOnBoard && !archived && !!held && (
                            <MenuItem
                              data-task-open-board
                              onClick={() => {
                                close()
                                onShowOnBoard(it.project, it.id)
                              }}
                            >
                              <Icon name="board" size={14} />
                              Open task in board
                            </MenuItem>
                          )}
                          <MenuItem
                            onClick={() => {
                              copyId()
                              close()
                            }}
                          >
                            <Icon name="copy" size={14} />
                            Copy task ID
                          </MenuItem>
                          <MenuItem
                            onClick={() => {
                              copyLink()
                              close()
                            }}
                          >
                            <Icon name="link" size={14} />
                            Copy link
                          </MenuItem>
                          {canMove && (
                            <MenuItem
                              disabled={fateWaits}
                              title={fateTip}
                              onClick={() => {
                                close()
                                setMoveOpen(true)
                              }}
                            >
                              <Icon name="arrowRight" size={14} />
                              Move to sub-project…
                            </MenuItem>
                          )}
                          {/* one window for both ways a task leaves the board, for
                            every task, Done ones too; viewers see neither */}
                          {canFate && (
                            <MenuItem
                              data-task-fate
                              disabled={fateWaits}
                              title={fateTip}
                              onClick={() => {
                                close()
                                // a reason kept from before a restore fills it
                                fateReason.current = unusedReason ?? ''
                                setFateOpen(true)
                              }}
                            >
                              <Icon name="inbox" size={14} />
                              Archive or delete…
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Popover>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-task-close
                      className="w-control-sm h-control-sm"
                      onClick={onClose}
                      aria-label="Close (esc)"
                      title="Close (esc)"
                    >
                      <Icon name="close" size={16} />
                    </Button>
                  </div>
                ),
              })}

              {/* the task as its last answer had it, while the read after
                  that answer failed or runs again */}
              {stale && (
                <StaleTask
                  taskKey={it.key}
                  retrying={detail?.state === 'retrying'}
                  mobile={mobile}
                />
              )}

              {/* an archived task: what became of it, with Restore for
                  someone who can edit its project, above the task shown
                  read-only. Its own Close stays, as on every such note. */}
              {gone && archived && (
                <TaskGone
                  key={taskKey}
                  inWindow
                  showPlace={embedded && !mobile}
                  task={gone}
                  found={goneAnswer}
                  canRestore={canRestore}
                  projectArchived={projectArchived}
                  onRetry={P.retryTask}
                  unusedReason={fateOpen ? fateReason.current.trim() || null : unusedReason}
                  onCopied={setCopiedReason}
                  onClose={onClose}
                  mobile={mobile}
                />
              )}

              {mobile && (
                <div className="task-mobile-controls">
                  <div className="task-mobile-quick">
                    {!P.isGroup(it) && (
                      <div>
                        <span className="task-mobile-field-label">Status</span>
                        {statusControl()}
                      </div>
                    )}
                    <div>
                      <span className="task-mobile-field-label">Assignee</span>
                      {personControl('assignee')}
                    </div>
                  </div>
                  <fieldset
                    className="m-0 border-0 p-0"
                    aria-label="Task sections"
                    data-mobile-task-sections
                  >
                    <Seg
                      fit
                      value={mobileTab}
                      onChange={setMobileTab}
                      options={[
                        { value: 'activity', label: 'Activity' },
                        { value: 'details', label: 'Details' },
                      ]}
                    />
                  </fieldset>
                </div>
              )}

              {/* the two columns under the shared chrome: discussion left,
                details right (stacked top/bottom when narrow) */}
              <div
                ref={contentRef}
                className={`task-body flex min-h-0 flex-1 ${narrow ? 'flex-col' : 'flex-row'}`}
              >
                {/* ------- left: the discussion column, in chat order —
                description pinned on top, then the Activity header, the
                thread scrolling below it oldest-to-newest, and the reply
                field pinned at the bottom where the thread ends */}
                {/* No rule between the columns and none under this one when they
                stack (deviation #65) — what parts them is the 20px of padding
                each side already carries, doubled across the seam. */}
                <div
                  data-discussion-card
                  className="min-w-0 min-h-0 flex flex-1 flex-col overflow-hidden"
                >
                  {/* Pinned above activity in columns. When stacked this section
                      joins the single content scroll below the header. */}
                  <div
                    data-task-description
                    className={`shrink-0 px-5 pb-0 ${embedded ? 'pt-3' : 'pt-4'}`}
                  >
                    {/* Who the task is on, said in the one frame that has nowhere
                  else to say it: the floating window carries editable
                  Assignee and Reviewer rows in its details column, and
                  repeating them here would be the same duplication the
                  labelled location rows were. Read-only on purpose: the pane
                  is a triage surface, and the pop-out is one click away for
                  anyone who came to reassign. It names the owner: the
                  reviewer while the task waits In Review, labelled so, else
                  the assignee (#314). A readable portrait and one label/name
                  group establish the identity before the discussion. The
                  data-task-assignee hooks keep their names for the drives. */}
                    {embedded && !mobile && (
                      <div
                        data-task-assignee
                        className="[display:flex] [align-items:center] [gap:12px] [margin-bottom:16px] [min-width:0]"
                      >
                        {it.owner && P.user(it.owner) && <Avatar id={it.owner} size={40} />}
                        <div className="min-w-0">
                          <div className="mb-1 text-sm text-text-2">
                            {it.ownerField === 'reviewer' ? 'Reviewer' : 'Assignee'}
                          </div>
                          <div
                            data-task-assignee-name
                            className="text-base font-semibold text-text-1 break-words"
                          >
                            {(it.owner && P.user(it.owner)?.name) || 'Unassigned'}
                          </div>
                        </div>
                      </div>
                    )}
                    {/* Collapsible, and shut to begin with, in the inbox pane only.
                  There the surface is a reading queue: you came for the message
                  and the reply, and a description you have read before was
                  taking the top of a half-width pane before the conversation
                  started. The floating window keeps it pinned open — that one
                  IS the task, and its discussion-first layout (deviation #41)
                  puts the description first on purpose.
                  Collapsing UNMOUNTS the editor, so a dirty draft dies with it
                  and says so — the same contract closing the window has always
                  had. That is the honest half of the trade: the alternative,
                  keeping it mounted under `display: none`, hides an unsaved
                  draft AND its Save bar, which is worse than losing it loudly. */}
                    {embedded && !mobile ? (
                      /* The chevron points where pressing it GOES — down to open,
                   up to close — rather than at the state it is in, which is
                   what a rightwards twisty says and what left this reading as
                   a heading with a decoration. No excerpt of the text beside
                   it either: a first line dressed as a label reads as content
                   that happens to be cut off, so the row said "here is some
                   description" where it needed to say "press me". What is
                   left is a glyph, a word, an arrow, and a hover.
                   The pop-out cannot live INSIDE the toggle — a button in a
                   button is not a thing — so the two share a row, and the
                   row carries the gap the toggle used to. */
                      <div className={`flex items-center gap-2 ${descOpen ? 'mb-2' : ''}`}>
                        <Button
                          type="button"
                          data-desc-toggle
                          aria-expanded={descOpen}
                          onClick={() =>
                            descOpen
                              ? // collapsing drops the editor and any draft in it
                                closeOrAsk([descColumn], () => setDescOpen(false))
                              : setDescOpen(true)
                          }
                          className="flex h-8 items-center gap-2 text-left border-none bg-transparent px-2 py-0 -mx-2 rounded-sm cursor-pointer text-text-3"
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = 'var(--hover)'
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = 'transparent'
                          }}
                          variant="unstyled"
                        >
                          <Icon name="page" size={16} color="var(--text-3)" />
                          <span className={labelClass}>Description</span>
                          {/* its own hook: the glyph above it is an svg too, and
                        "the first path in the toggle" stopped meaning the
                        arrow the moment the heading grew one */}
                          <span data-desc-arrow className="[display:inline-flex]">
                            <Icon
                              name={descOpen ? 'chevronUp' : 'chevronDown'}
                              size={16}
                              color="var(--text-3)"
                            />
                          </span>
                        </Button>
                        {focusBtn('desc', 'description', 'data-desc-popout')}
                      </div>
                    ) : (
                      <SectionHead icon="page" label="Description" inlineAction>
                        {focusBtn('desc', 'description', 'data-desc-popout')}
                      </SectionHead>
                    )}
                    {/* not while it is in a window of its own — one field, one
                  draft; the pane behind the scrim is nobody's view */}
                    {(!descOpen && !mobile) || focus === 'desc' ? null : (
                      <UnsentScopeContext.Provider value={descColumn}>
                        {descBody(true)}
                      </UnsentScopeContext.Provider>
                    )}
                  </div>

                  <div className="task-activity-head flex items-center gap-2 px-5 pt-6 pb-2 shrink-0">
                    <Icon name="comment" size={16} color="var(--text-3)" />
                    <span className={labelClass}>Activity</span>
                    {focusBtn('activity', 'activity', 'data-act-popout')}
                    {/* no "· newest first" any more: that label existed because
                  newest-first was surprising. Chat order is the expectation,
                  and the reply box sitting at the bottom already says it. */}
                    <div className="[flex:1]" />
                    {actSeg}
                  </div>

                  {/* …and the thread likewise: popped out, the column keeps its
                height with an empty box rather than collapsing behind the
                window, so closing it puts everything back where it was */}
                  {focus === 'activity' ? (
                    <div className="[flex:1] [min-height:0]" />
                  ) : (
                    <UnsentScopeContext.Provider value={activityColumn}>
                      {spineScroller('0 20px 20px')}
                    </UnsentScopeContext.Provider>
                  )}
                </div>

                {/* ------- right: the details column — everything else from the
                issue view. Its own scroll. The window chrome (actions menu +
                close) sits in the shared header above the columns. */}
                {/* When stacked, both columns join one content scroll; their
                    inset keeps the boundary between sections visible. */}
                {/* …and NOT at all when embedded: the inbox pane already gives half
                its width to the message list, so a 470px details column beside
                the discussion leaves neither one usable. What the pane keeps is
                the reading surface; the header's breadcrumb names the location
                and the pop-out button reaches everything else. */}
                {(!embedded || mobile) && (
                  <aside
                    aria-label="Task details"
                    data-details-card
                    className="min-w-0 min-h-0 flex flex-col overflow-hidden basis-[470px] shrink-0"
                  >
                    <div
                      ref={bodyRef}
                      className="task-details-scroll flex-1 min-h-0 overflow-y-auto px-5 pt-4 pb-5"
                    >
                      {/* Location and title live in the shared header; the Parent
                          field links ancestors. Every field below respects project
                          write access, while read-only users retain visible values. */}
                      {/* Keep the original field order and shared value edge. */}
                      <div className="task-properties">
                        {!P.isGroup(it) && (
                          <DetailField label="Status">{statusControl()}</DetailField>
                        )}
                        <DetailField label="Priority">
                          <FieldSelect
                            aria-label="Priority"
                            value={it.priority}
                            menuWidth={180}
                            disabled={!canEdit}
                            title={roTip}
                            options={Object.values(P.PRIORITIES).map((pr) => ({
                              value: pr.id,
                              label: pr.name,
                              icon: <PriorityIcon priority={pr.id} />,
                            }))}
                            onChange={(v) => upd({ priority: v })}
                          />
                        </DetailField>
                        <DetailField label="Reporter" person>
                          {/* Set at creation; retained when access or activity changes. */}
                          <span data-task-reporter className="task-reporter">
                            {it.reporter && P.user(it.reporter) ? (
                              <>
                                <Avatar id={it.reporter} size={28} />
                                <span className="min-w-0 break-words">
                                  {P.user(it.reporter).name}
                                </span>
                              </>
                            ) : (
                              <span className="text-text-3">No reporter</span>
                            )}
                          </span>
                        </DetailField>
                        <DetailField label="Assignee" person>
                          {/* Choices need active profiles with project write access.
                      A historical value
                      that is no longer eligible still renders but is not a
                      selectable menu item. */}
                          {personControl('assignee')}
                        </DetailField>
                        {/* Owns the task while it waits In Review; hidden on a
                    group, whose status is dormant (like Status above). */}
                        {!P.isGroup(it) && (
                          <DetailField label="Reviewer" person>
                            {personControl('reviewer')}
                          </DetailField>
                        )}
                        {/* the project / sub-project location leads this column, in
                    the same two-column rows; moving lives in the ... menu */}
                        <DetailField label="Remaining">
                          {totals ? (
                            (() => {
                              // an issue with sub-issues has no hours of its own (0066):
                              // the value is the sum over its whole subtask list, the
                              // subtasks the person can see when some are hidden, and
                              // unknown or still loading without the whole list
                              const rem = totals.remaining
                              const hours =
                                rem.state === 'visible' || rem.state === 'complete'
                                  ? rem.hours
                                  : undefined
                              return (
                                <HoverTooltip
                                  content={
                                    rem.state === 'visible'
                                      ? 'Sum of open hours of the subtasks you can see; parent tasks have no hours of their own'
                                      : 'Sum of open subtask hours; parent tasks have no hours of their own'
                                  }
                                >
                                  <span
                                    data-remaining-rollup={rem.state}
                                    style={{ color: hours != null ? undefined : 'var(--text-3)' }}
                                    className="!font-mono [font-size:var(--fs-sm)]"
                                  >
                                    {rem.state === 'loading'
                                      ? 'Loading…'
                                      : rem.state === 'unknown'
                                        ? 'Unknown'
                                        : hours != null
                                          ? `Σ ${hours}h`
                                          : '—'}
                                  </span>
                                </HoverTooltip>
                              )
                            })()
                          ) : (
                            <>
                              {/* uncontrolled, but the key folds in the STORE value:
                          typing never remounts (the store hasn't moved), while
                          a remote edit or a persistRows rollback replaces the
                          node instead of leaving a number on screen the server
                          doesn't hold — which the next blur would write back.
                          Parsing lives in lib/remaining so this field and the
                          Team sync walk's Remaining box can't drift (empty =
                          unset, and a stored 0 is a value, not a clear). */}
                              <Input
                                data-remaining-input
                                aria-label="Remaining hours"
                                type="number"
                                min={LIMITS.remainingHours.min}
                                max={LIMITS.remainingHours.max}
                                placeholder="—"
                                // and whether the person can change the hours, so hours
                                // typed in a field that turns read-only go with it, and
                                // stay across the switch from the workspace's task to
                                // its answer
                                key={`${it.id}:${hoursEditable ? 'edit' : 'read'}:${it.remaining != null ? it.remaining : ''}`}
                                defaultValue={remainingValue(it.remaining)}
                                disabled={!hoursEditable}
                                title={roTip}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur()
                                }}
                                {...remainingUnsaved}
                                onBlur={(e) => {
                                  const p = remainingPatchFromInput(e.target, it.remaining)
                                  // hours for an answer that is not current wait,
                                  // typed, with the reason
                                  if (p.write && !P.refuseStaleEdit(it.id))
                                    upd({ remaining: p.value })
                                }}
                                // the shared Input chrome, like every other field in
                                // this column (an inline face used to round it tighter
                                // and switch its focus outline off)
                                className="w-15 bg-surface-1 px-2 font-mono text-base"
                              />
                              <span className="[font-size:var(--fs-sm)] [color:var(--text-3)]">
                                h
                              </span>
                            </>
                          )}
                        </DetailField>
                        {(() => {
                          // an archived task shows no delay, as no view does
                          const done = held ? P.isDone(held) : !!detail?.done
                          const overdue = !archived && !!it.due && it.due < P.TODAY_ISO && !done
                          // with delay tracking (0064) the chip carries the projected
                          // status — "Delayed" covers overdue; without it, the plain
                          // overdue chip stays as before. Where the workspace cannot
                          // judge it, before it holds every task or for a task shown
                          // from its answer, the owner's load comes from the server,
                          // as for a Board card (P.windowDelay), so the window of a
                          // task the person created during a load can show a verdict
                          // its card waits for
                          const verdict =
                            archived || !P.tracksDelay(it)
                              ? null
                              : held && P.tasksHeld()
                                ? P.delayOf(it)
                                : P.windowDelay(it)
                          const unknown = verdict === DELAY_UNKNOWN
                          const delay = unknown ? null : verdict
                          const late = delay ? delay.status === 'late' : overdue
                          const tip = delay
                            ? P.DELAY_LABELS[delay.status] +
                              (overdue
                                ? ', the due date has passed'
                                : delay.fin != null
                                  ? ', projected to finish in the week of ' +
                                    P.fmtDate(P.weekToDate(delay.fin))
                                  : '')
                            : undefined
                          return (
                            <DetailField label="Due">
                              <DateInput
                                value={it.due || null}
                                onChange={(v) => upd({ due: v })}
                                disabled={!canEdit}
                                title={roTip}
                                aria-invalid={late}
                                className={late ? '!border-danger' : undefined}
                              />
                              {/* On track draws nothing — the DELAY_COLORS rule, applied
                                  here too; a slipping or lost deadline is a glyph in its
                                  pressure colour beside plain words, the projection in the
                                  tooltip. The colour never goes on text: a lost deadline
                                  is the red border of the date box and the red glyph. An
                                  unknown delay is muted, with a neutral glyph. */}
                              {unknown ? (
                                <HoverTooltip
                                  content={
                                    // a group's verdict reads its subtasks' dates,
                                    // a task's its owner's other work
                                    P.isGroup(it)
                                      ? "Its subtasks' dates decide it, and they have not all loaded yet."
                                      : "Qivo could not read the owner's other work."
                                  }
                                >
                                  <span
                                    data-delay-chip="unknown"
                                    tabIndex={-1}
                                    className="flex h-5 items-center gap-1.5 text-xs font-medium text-text-3"
                                  >
                                    <Icon name="clock8" size={14} strokeWidth={2} />
                                    Delay unknown
                                  </span>
                                </HoverTooltip>
                              ) : delay ? (
                                delay.status !== 'ok' && (
                                  <HoverTooltip content={tip}>
                                    <span
                                      data-delay-chip={delay.status}
                                      className="flex h-5 items-center gap-1.5 text-xs font-medium text-text-2"
                                    >
                                      <Icon
                                        name={DELAY_MARK[delay.status].glyph}
                                        size={14}
                                        strokeWidth={2}
                                        color={DELAY_MARK[delay.status].color}
                                      />
                                      {P.DELAY_LABELS[delay.status]}
                                    </span>
                                  </HoverTooltip>
                                )
                              ) : (
                                overdue && (
                                  <span className="flex h-5 items-center gap-1.5 text-xs font-medium text-text-2">
                                    <Icon
                                      name="warning"
                                      size={14}
                                      strokeWidth={2}
                                      color="var(--danger)"
                                    />
                                    Overdue
                                  </span>
                                )
                              )}
                            </DetailField>
                          )
                        })()}
                        {/* Start/End pickers are always shown (picking a date on an
                    unscheduled issue schedules it — both weeks are set together,
                    so start/end stay both-null or both-set). The planned period
                    may never end after the due date: a pick that would push End
                    past the due week is rejected with a toast rather than
                    silently clamped. Picking the roadmap window itself is a
                    later, separate "Plan on roadmap" feature. A group's dates
                    come from its subtasks, so its pickers show them disabled. */}
                        {(() => {
                          const dueWeek = it.due ? P.isoToWeek(it.due) : null
                          const scheduled = it.start != null && it.end != null
                          const group = P.isGroup(it)
                          const nothingToPlan = !group && doneWithoutDates(it)
                          const planTip = group ? 'Dates come from subtasks' : roTip
                          const rejectPastDue = () => {
                            window.showToast?.("The end date can't be after the due date", 'error')
                          }
                          // clearing either picker unschedules the issue (both weeks
                          // drop together — the pair invariant above)
                          const setStart = (w) => {
                            if (w == null) {
                              upd({ start: null, end: null })
                              return
                            }
                            const end = it.end != null ? Math.max(w, it.end) : w
                            if (dueWeek != null && end > dueWeek) {
                              rejectPastDue()
                              return
                            }
                            upd({ start: w, end })
                          }
                          const setEnd = (w) => {
                            if (w == null) {
                              upd({ start: null, end: null })
                              return
                            }
                            if (dueWeek != null && w > dueWeek) {
                              rejectPastDue()
                              return
                            }
                            upd({ end: w, start: it.start != null ? Math.min(w, it.start) : w })
                          }
                          // a group shown from its answer whose subtasks the answer
                          // does not all hold has dates no one can know here; an
                          // archived one shows no subtasks at all
                          const datesUnknown = fromAnswer && !!detail && !detail.datesKnown
                          return (
                            <DetailField label="Plan">
                              {datesUnknown ? (
                                <HoverTooltip
                                  content={
                                    archived
                                      ? 'Dates come from subtasks, which an archived task does not show'
                                      : 'Dates come from subtasks, which have not all loaded'
                                  }
                                >
                                  <span
                                    data-plan-unknown
                                    tabIndex={-1}
                                    className="text-sm text-text-3"
                                  >
                                    Unknown
                                  </span>
                                </HoverTooltip>
                              ) : (
                                <div className="task-plan-dates">
                                  <fieldset className="task-plan-date" aria-label="Plan start">
                                    <span className="task-plan-caption">Start</span>
                                    <DateSelect
                                      value={it.start}
                                      onChange={setStart}
                                      clearable={!group}
                                      disabled={!canEdit || group}
                                      title={planTip}
                                    />
                                  </fieldset>
                                  <span className="task-plan-arrow">
                                    <Icon name="arrowRight" size={16} color="var(--text-3)" />
                                  </span>
                                  <fieldset className="task-plan-date" aria-label="Plan end">
                                    <span className="task-plan-caption">End</span>
                                    <DateSelect
                                      value={it.end}
                                      onChange={setEnd}
                                      clearable={!group}
                                      disabled={!canEdit || group}
                                      title={planTip}
                                    />
                                  </fieldset>
                                </div>
                              )}
                              {/* plan in context: jumps to the roadmap with this issue
                          spotlit. An unscheduled issue gets a starter bar there
                          (capped at the due week) to drag into place. A group
                          is only shown there, read-only. A Done task without
                          dates is not on the roadmap at all, so its button is
                          off and says why. */}
                              <div className="task-plan-actions">
                                {/* the Roadmap opens at once, asks the server to
                                    keep the task past its filters and spotlights
                                    it once its answer holds it, also one shown
                                    from a current answer, whoever looks; an
                                    archived one says why its fields are off */}
                                <Button
                                  type="button"
                                  variant="ghost"
                                  data-plan-on-roadmap
                                  className="text-text-1 h-control-sm"
                                  disabled={(!held && (archived || stale)) || nothingToPlan}
                                  title={
                                    !held && (archived || stale)
                                      ? archived
                                        ? roTip
                                        : WAITS_FOR_CHECK
                                      : nothingToPlan
                                        ? DONE_WITHOUT_DATES
                                        : undefined
                                  }
                                  onClick={() => onPlanOnRoadmap?.(it.id)}
                                >
                                  <Icon name="timeline" size={16} />
                                  {group ? 'Show on roadmap' : 'Plan on roadmap'}
                                </Button>
                                {scheduled && (
                                  <span className="text-xs text-text-2 font-mono">
                                    {it.end - it.start + 1}w
                                  </span>
                                )}
                              </div>
                            </DetailField>
                          )
                        })()}
                      </div>

                      <section ref={labelSecRef} className="task-section">
                        <SectionHead label="Labels" inlineAction>
                          {/* Keep the trigger mounted while its popup is open. */}
                          {canEdit && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="task-heading-action"
                              aria-label="Add label"
                              title="Add label"
                              onClick={() => openPickerUnder(labelSecRef, setLabelAnchor, 300)}
                            >
                              <Icon name="plus" size={16} />
                            </Button>
                          )}
                        </SectionHead>
                        {shownLabels.length > 0 && (
                          <div className="task-labels">
                            {shownLabels.map((label) => {
                              // a label not named yet waits for its read; one
                              // whose read failed can still come off by id
                              const remove =
                                label.state === 'ok'
                                  ? `Remove label “${label.name}”`
                                  : label.state === 'failed'
                                    ? 'Remove this label'
                                    : 'Available once this label has loaded'
                              return (
                                <span
                                  key={label.id}
                                  className="task-label"
                                  {...(label.state === 'loading'
                                    ? { 'data-label-waiting': '' }
                                    : label.state === 'failed'
                                      ? { 'data-label-failed': '' }
                                      : {})}
                                >
                                  <span
                                    className={cn(
                                      'task-label-name',
                                      label.state !== 'ok' && 'text-text-3',
                                    )}
                                  >
                                    {label.state === 'ok'
                                      ? label.name
                                      : label.state === 'failed'
                                        ? "Couldn't load this label"
                                        : 'Loading label…'}
                                  </span>
                                  {canEdit && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="task-label-remove text-text-2"
                                      aria-label={remove}
                                      title={remove}
                                      disabled={label.state === 'loading'}
                                      onClick={() => P.toggleIssueLabel(it.id, label.id)}
                                    >
                                      <Icon name="close" size={16} />
                                    </Button>
                                  )}
                                </span>
                              )
                            })}
                          </div>
                        )}
                        {taskLabels.failed && (
                          <Button
                            type="button"
                            variant="ghost"
                            data-labels-retry=""
                            className="h-control-sm self-start text-sm"
                            onClick={taskLabels.retry}
                          >
                            Try again
                          </Button>
                        )}
                        {!canEdit && shownLabels.length === 0 && (
                          <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
                            No labels.
                          </div>
                        )}
                      </section>

                      {/* an archived task's answer holds no files, parent,
                          subtasks or links, so its window lists none, and
                          says where it lives and when it was archived */}
                      {archived && detail?.archivedAt != null && (
                        <section className="task-section" data-task-archived-place>
                          <ArchivedPlace project={it.project} archivedAt={detail.archivedAt} />
                        </section>
                      )}

                      {!archived && (
                        <AttachmentsSection it={it} canEdit={canEdit} section={files} />
                      )}

                      {prog && (
                        <div className="task-section" data-progress={prog.state}>
                          <div className="task-section-head flex-wrap text-text-1">
                            <span className={labelClass}>Progress</span>
                            <span className="ml-auto text-xs">
                              {prog.state === 'loading'
                                ? null
                                : prog.state === 'unknown'
                                  ? 'Completion unknown.'
                                  : prog.state === 'visible'
                                    ? `${prog.done} of ${prog.total} visible tasks done. Completion unknown.`
                                    : prog.total > 0
                                      ? `${prog.done} of ${prog.total} tasks done, ${prog.pct}%`
                                      : 'no subtasks yet'}
                            </span>
                          </div>
                          {prog.state === 'complete' ? (
                            <ProgressBar
                              value={prog.pct}
                              color={P.delayColor(it) || undefined}
                              height={7}
                            />
                          ) : prog.state === 'unknown' && !prog.partial ? null : (
                            <span className="text-xs text-text-3">
                              {prog.state === 'loading'
                                ? 'Subtasks are still loading.'
                                : prog.state === 'unknown'
                                  ? 'Not every subtask could be loaded.'
                                  : 'Additional work is outside this view.'}
                            </span>
                          )}
                        </div>
                      )}

                      {!archived && (
                        <>
                          <section ref={parentSecRef} className="task-section">
                            <SectionHead icon="parent" label="Parent" inlineAction>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="task-heading-action"
                                aria-label={hasParent ? 'Change parent' : 'Set parent'}
                                title={
                                  roTip ||
                                  (hasParent ? undefined : noParent) ||
                                  (hasParent ? 'Change parent' : 'Set parent')
                                }
                                disabled={!canRelate || (!hasParent && !!noParent)}
                                onClick={() => openPickerUnder(parentSecRef, setParentAnchor, 340)}
                              >
                                <Icon name={hasParent ? 'pen' : 'plus'} size={16} />
                              </Button>
                            </SectionHead>
                            {parentRow ? (
                              <MiniIssueRow
                                task={parentRow}
                                onOpen={onOpen}
                                remove={{
                                  label: 'Remove parent',
                                  // the window's own task, also one shown from its
                                  // answer, which sends the parent pair it showed
                                  onClick: () => upd({ parent: null }),
                                  disabled: !canEdit,
                                  hint: roTip,
                                }}
                              />
                            ) : it.hasHiddenParent ? (
                              // the parent cannot be shown, but it can be removed,
                              // the one change left to a task with subtasks there
                              <div className="flex items-center gap-2 text-sm text-text-2 italic">
                                <span className="flex-1">
                                  {P.parentLoading(it)
                                    ? 'The parent task is still loading.'
                                    : 'The parent task is outside this view.'}
                                </span>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="task-related-remove h-control-sm w-control-sm shrink-0"
                                  aria-label="Remove parent"
                                  title={roTip || 'Remove parent'}
                                  disabled={!canEdit}
                                  onClick={() => upd({ parent: null })}
                                >
                                  <Icon name="close" size={16} />
                                </Button>
                              </div>
                            ) : (
                              <div className="text-sm text-text-2 italic">
                                {/* a held task's parent is held, or marked hidden
                                    while it may be still to come (hiddenParentsNow),
                                    and the answer's word is exact */}
                                No parent task.
                              </div>
                            )}
                          </section>

                          <section
                            ref={subSecRef}
                            className="task-section"
                            data-section="subtasks"
                            data-section-state={sectionMark(subtasks)}
                            data-section-source={subtasks.source}
                          >
                            <SectionHead
                              icon="child"
                              inlineAction
                              label={`Subtasks${countOf(subtasks)}`}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="task-heading-action"
                                aria-label="Add subtask"
                                title={roTip || noSubtask || 'Add subtask'}
                                disabled={!canRelate || !!noSubtask}
                                onClick={() => openPickerUnder(subSecRef, setSubAnchor, 340)}
                              >
                                <Icon name="plus" size={16} />
                              </Button>
                            </SectionHead>
                            {subtasks.rows.length > 0 ? (
                              <div className="[display:flex] [flex-direction:column] [gap:6px]">
                                {subtasks.rows.map((row) => (
                                  <MiniIssueRow
                                    key={row.uuid}
                                    task={row}
                                    onOpen={onOpen}
                                    remove={{
                                      label: 'Remove subtask',
                                      // detaching edits the subtask, not this task, from
                                      // its row as the window shows it
                                      onClick: () =>
                                        removeOnce(row.uuid, () =>
                                          P.setSubtaskParent(
                                            it.id,
                                            {
                                              uuid: row.uuid,
                                              parent: it.uuid,
                                              hiddenParent: false,
                                            },
                                            false,
                                          ),
                                        ),
                                      disabled: !canDetach(row),
                                      hint: current
                                        ? waits(subtasks)
                                          ? WAITS_FOR_CHECK
                                          : undefined
                                        : roTip,
                                      busy: removing.has(row.uuid),
                                    }}
                                  />
                                ))}
                                {sectionNote('subtasks', subtasks, 'No subtasks.')}
                              </div>
                            ) : (
                              sectionNote('subtasks', subtasks, 'No subtasks.')
                            )}
                          </section>

                          <section
                            ref={linkSecRef}
                            className="task-section"
                            data-section="links"
                            data-section-state={sectionMark(linked)}
                            data-section-source={linked.source}
                          >
                            <SectionHead
                              icon="link"
                              inlineAction
                              label={`Linked tasks${countOf(linked)}`}
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="task-heading-action"
                                aria-label="Link task"
                                title={canLinkAny ? noLink || 'Link task' : roTip}
                                disabled={!canLinkAny || !!noLink}
                                onClick={() => openPickerUnder(linkSecRef, setLinkAnchor, 340)}
                              >
                                <Icon name="plus" size={16} />
                              </Button>
                            </SectionHead>
                            {linked.rows.length > 0 ? (
                              <div className="[display:flex] [flex-direction:column] [gap:6px]">
                                {linked.rows.map((row) => (
                                  <MiniIssueRow
                                    key={row.uuid}
                                    task={row}
                                    onOpen={onOpen}
                                    relation={relMapID[row.type]}
                                    remove={{
                                      label: 'Remove link (both directions)',
                                      // the relation the row shows goes out as the one
                                      // expected
                                      onClick: () =>
                                        removeOnce(row.uuid, () =>
                                          P.unlinkTasks(it.id, { uuid: row.uuid }, row.type),
                                        ),
                                      disabled: !canUnlink(row),
                                      hint: current
                                        ? waits(linked)
                                          ? WAITS_FOR_CHECK
                                          : undefined
                                        : roTip,
                                      busy: removing.has(row.uuid),
                                    }}
                                  />
                                ))}
                                {sectionNote('links', linked, 'No dependencies yet.')}
                              </div>
                            ) : (
                              sectionNote('links', linked, 'No dependencies yet.')
                            )}
                          </section>
                        </>
                      )}
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {/* One half of the task, alone, in a window standing on this one. Both
          are rendered outside the card for the same reason the pickers below
          are, a fixed-position layer inside the scaled or blurred card would
          take the card as its containing block. FocusWindow portals to #root
          for the Inbox pane, which blurs too. */}
      {/* Each one is the task window showing a single section: the SAME two
          heading lines (breadcrumb, then the task name), then the section's
          own heading exactly as the column draws it — minus the pop-out
          button, which is what got you here. */}
      {it && focus === 'desc' && (
        <FocusWindow name="Description" onClose={closeFocus} scope={focusWindow}>
          {windowHead({ chrome: focusChrome, live: false, padBottom: 10 })}
          <div className="[flex:1] [min-height:0] [display:flex] [flex-direction:column] [padding:0_20px_20px]">
            <SectionHead icon="page" label="Description" />
            {descBody(false)}
          </div>
        </FocusWindow>
      )}
      {it && focus === 'activity' && (
        <FocusWindow name="Activity" onClose={closeFocus} scope={focusWindow}>
          {windowHead({ chrome: focusChrome, live: false, padBottom: 4 })}
          <div className="task-activity-head flex items-center gap-2 px-5 py-2 shrink-0">
            <Icon name="comment" size={16} color="var(--text-3)" />
            <span className={labelClass}>Activity</span>
            <div className="[flex:1]" />
            {/* the All ⇄ Comments switch comes with it — the same state, so
                flipping it in here is flipping it in the column behind */}
            {actSeg}
          </div>
          {spineScroller('0 20px 20px')}
        </FocusWindow>
      )}
      {/* Rendered outside the dialog: the cards' scale transform and the
          backdrop's backdrop-filter would each make them the containing block
          for this fixed-position popup and shift it off. */}
      {it && (held || canEdit) && labelAnchor && (
        <LabelPickerPopup it={it} anchor={labelAnchor} onDone={() => setLabelAnchor(null)} />
      )}
      {/* The relation pickers, for the window's task held or shown from its
          answer (lib/relationCandidates.ts names the window's own blocks,
          RelationPicker.tsx how each reads the server). Each keys on the
          window's task, so a reference that turns into its handle keeps
          the picker's rows and busy rows. */}
      {it && active && subAnchor && (
        <RelationPicker
          key={`sub-${taskKey}`}
          kind="subtask"
          task={it}
          anchor={subAnchor}
          onDone={() => setSubAnchor(null)}
          placeholder="Add subtasks: ID or title…"
          current={currentSubtasks}
          seenOf={(c) =>
            c.current
              ? { on: true, busy: false, parent: { id: it.uuid, hidden: false } }
              : {
                  on: false,
                  busy: false,
                  parent: {
                    id: c.candidate?.parent_id ?? null,
                    hidden: !!c.candidate?.has_hidden_parent,
                  },
                }
          }
          toggle={(choice, on, seen) =>
            P.setSubtaskParent(
              it.id,
              {
                uuid: choice.uuid,
                row: choice.candidate,
                parent: seen.parent?.id ?? null,
                hiddenParent: seen.parent?.hidden ?? false,
              },
              on,
            )
          }
          createLabel="Create new subtask:"
          onCreate={
            noSubtask || !canRelate
              ? undefined
              : (title) => {
                  P.addIssue({ project: it.project, title, parent: it.id })
                }
          }
        />
      )}
      {it && active && linkAnchor && (
        <RelationPicker
          key={`link-${taskKey}`}
          kind="link"
          task={it}
          anchor={linkAnchor}
          onDone={() => setLinkAnchor(null)}
          placeholder="Link tasks: ID or title…"
          current={currentLinks}
          linkKind={linkType}
          header={
            <NativeSelect
              value={linkType}
              onChange={(e) => setLinkType(e.target.value)}
              className="h-control-sm shrink-0 cursor-pointer bg-surface-1 text-sm text-text-1"
            >
              <option value="blocked_by">is blocked by</option>
              <option value="blocks">blocks</option>
              <option value="relates">relates to</option>
            </NativeSelect>
          }
          seenOf={(c) =>
            c.current
              ? { on: true, busy: false, link: c.current.type ?? null }
              : { on: false, busy: false, link: null }
          }
          toggle={(choice, on, seen) =>
            on
              ? P.linkTasks(it.id, linkType, { uuid: choice.uuid })
              : P.unlinkTasks(it.id, { uuid: choice.uuid }, seen.link ?? 'relates')
          }
          createLabel="Create new linked task:"
          // the new task lands in this task's project, so only with edit access there
          onCreate={
            canRelate && !noLink
              ? (title) => {
                  void P.createLinked(it.id, linkType, title)
                }
              : undefined
          }
        />
      )}
      {it && active && parentAnchor && (
        <RelationPicker
          key={`parent-${taskKey}`}
          kind="parent"
          task={it}
          anchor={parentAnchor}
          onDone={() => setParentAnchor(null)}
          single
          placeholder="Set parent: ID or title…"
          current={currentParent}
          seenOf={(c) => ({ on: !!c.current, busy: false })}
          toggle={(choice, on) =>
            // a new parent needs the row the server offered; only the
            // current parent's row takes it off
            on
              ? !!choice.candidate &&
                P.updateIssue(it.id, { parent: choice.uuid }, { parentRow: choice.candidate })
              : P.updateIssue(it.id, { parent: null })
          }
          createLabel="Create new parent task:"
          onCreate={
            noParent || !canRelate
              ? undefined
              : (title) => {
                  void P.createParent(it.id, title)
                }
          }
        />
      )}
      {/* stacked ModalShell (like the sub-issue modal): nothing moves until
          its Move button is pressed. It reads what the move takes along
          from the window's task (P.familyOf) */}
      {it && (held || answerEditorOn) && moveOpen && (
        <MoveIssueModal
          issueId={it.id}
          task={it}
          onClose={() => setMoveOpen(false)}
          focusAfterClose={taskActionsButton}
          onMove={(pid) => {
            // a paused move keeps the dialog open with its choice
            if (P.refusePausedEdit()) return
            // the key is org-scoped and immutable (0050): the modal stays
            // anchored to the same issue, nothing to re-open or re-anchor
            const key = P.moveIssue(it.id, pid)
            setMoveOpen(false)
            if (!key) {
              // the target vanished between render and click (concurrent delete)
              window.showToast?.("Couldn't move: the sub-project no longer exists", 'error')
              return
            }
            const t = P.project(pid)
            // the handle is a uuid for another organization's tasks — toasts
            // and every other human-facing string name the readable key
            window.showToast?.(
              `Moved ${P.taskShown(key)?.key || it.key} to ${t ? t.name : 'the sub-project'}`,
            )
          }}
        />
      )}
      {/* stacked like the Move dialog. While its own archive or delete is on
          its way, it stays mounted when the task is off the board for a
          moment (it shows nothing then), so it comes back still busy and
          with the choices the person made. A refusal renders the window
          again (stopLeaving), which shows TaskGone if the task is still
          gone. */}
      {issueId && fateOpen && (held || answerEditorOn || leaving.current === taskKey) && (
        <ArchiveOrDeleteTaskModal
          issueId={it?.id ?? issueId}
          task={it ?? undefined}
          initialReason={unusedReason ?? ''}
          onReasonChange={(reason) => {
            fateReason.current = reason
          }}
          onClose={() => {
            // closing it asked about a typed reason, so the kept one goes too
            fateReason.current = ''
            setUnusedReason(null)
            setFateOpen(false)
          }}
          focusAfterClose={taskActionsButton}
          onArchive={async (reason, keepSubtasks) => {
            // the window shows, and so can be used, only with the task
            if (!it) return false
            const shown = it.key
            const opened = taskKey
            leaving.current = opened
            // the window waits for the server, so a refusal leaves it open
            const archived = await P.archiveIssue(it.id, reason, keepSubtasks)
            if (!archived) {
              stopLeaving(opened)
              return false
            }
            if (archived === 'already') {
              // it was archived before this call, which posted no reason.
              // The toast says so whatever the deliveries show next, such as
              // a restore that brings the task back at once. It names no
              // one: another person, another tab and auto-archive look alike.
              stopLeaving(opened)
              const shownNow = shownIssue.current === opened
              if (shownNow || reason)
                window.showToast?.(
                  `${shown} was already archived.${reason ? ' The reason you typed was not used.' : ''}`,
                )
              if (!shownNow) return true
              // still on the board, or still shown from the window's answer,
              // because it was restored since or no delivery holds the
              // earlier archive yet: the window stays open with the reason,
              // and if the task then leaves the board, the task window keeps
              // it (TaskGone)
              if (P.taskShown(it.id)) return false
              // the task window shows the note and keeps the reason to copy
              // (TaskGone), and a restore then keeps it for the next window
              setUnusedReason(reason || null)
              setFateOpen(false)
              return true
            }
            // the person may have gone to another task meanwhile: leave that one open
            if (shownIssue.current === opened) {
              setFateOpen(false)
              // the task left the board, so the window has nothing to show,
              // and text typed for it has nowhere to go
              closeGone()
            }
            window.showToast?.(`Archived ${shown}`)
            return true
          }}
          onDelete={async (subtasks, reason) => {
            if (!it) return false
            const shown = it.key
            const opened = taskKey
            leaving.current = opened
            const deleted = await P.deleteIssue(it.id, subtasks, true, reason)
            if (!deleted) {
              stopLeaving(opened)
              return false
            }
            if (shownIssue.current === opened) {
              setFateOpen(false)
              closeGone()
            }
            const n = subtasks.length
            window.showToast?.(
              n ? `Deleted ${shown} and ${n} subtask${n === 1 ? '' : 's'}` : `Deleted ${shown}`,
            )
            return true
          }}
        />
      )}
    </>
  )
}

export { IssueDetail }
