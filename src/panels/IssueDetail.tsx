/* Issue detail — top-anchored floating modal over a blurred scrim.
   Everything is editable in place: title, status, priority, assignee,
   reviewer, remaining, description, roadmap timeline, dependency links
   (add/remove), sub-issues.
   The details card (right) owns the window chrome: an actions menu
   (copy ID, copy link, move to another sub-project, delete) and close. */

import React, {
  lazy,
  Suspense,
  useEffect as useEffectID,
  useRef as useRefID,
  useState as useStateID,
} from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { HoverTooltip, hasOpenTooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { usePlannerVersion } from '@/store/usePlannerVersion'
import type { DescEditorHandle } from '../components/descEditor'
import { IssueSubscribers } from '../components/IssueSubscribers'
import { Markdown } from '../components/markdown'
import {
  AnchoredPop,
  Avatar,
  DateInput,
  DateSelect,
  FieldSelect,
  Icon,
  IssueKey,
  Kbd,
  MenuItem,
  Popover,
  PriorityIcon,
  ProgressBar,
  Seg,
  StatusDot,
  UnreadDivider,
  useBottomSnap,
} from '../components/qivo'
import { DELAY_MARK } from '../lib/delay'
import { restoreFocus } from '../lib/focusVisibility'
import { remainingPatchFromInput, remainingValue } from '../lib/remaining'
import { buildPath, issueLink } from '../lib/router'
import { matchesAllWords } from '../lib/search'
import { firstUnreadTs, mergeSpine, unreadMark } from '../lib/spine'
import { useUpdateBlocker } from '../lib/updateSafety'
import { useMobile } from '../lib/useMobile'
import '../styles/mobile-issue.css'
import {
  type ActivityVM,
  type AttachmentVM,
  type CommentVM,
  type IssueVM,
  P,
} from '../store/planner'
import { ArchiveIssueModal, fmtSize, MoveIssueModal, useWindowDropGuard } from './Modals'

// the editor chunk (~150 KB gz of TipTap) loads only for users who can edit,
// when the modal opens; viewers render the plain Markdown component
const DescEditor = lazy(() => import('../components/descEditor'))
const NO_PROFILE = '__none__'

function MiniIssueRow({
  id,
  onOpen,
  relation,
  remove,
}: {
  id: string
  onOpen: (id: string) => void
  relation?: { label: string; glyph: string; completedLabel?: string }
  remove?: { label: string; onClick: () => void }
}) {
  const it = P.issueById[id]
  if (!it) return null
  const proj = P.project(it.project)
  const done = P.isDone(it)
  return (
    <div
      data-related-task={id}
      data-control-fill
      className="flex w-full items-center rounded-md border border-border bg-surface-1 transition-colors hover:border-border-strong hover:bg-hover focus-within:border-border-strong"
    >
      <Button
        type="button"
        variant="unstyled"
        onClick={() => onOpen(id)}
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
            {it.title}
          </span>
          <span className="[font-size:var(--fs-xs)] [color:var(--text-3)] [max-width:100%] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
            {proj.name}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {!P.isGroup(it) && <StatusDot status={it.status} size={14} />}
          {it.owner && <Avatar id={it.owner} size={28} />}
        </span>
      </Button>
      {remove && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="task-related-remove mr-1 h-control-sm w-control-sm shrink-0"
          aria-label={remove.label}
          title={remove.label}
          onClick={remove.onClick}
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
   store has one thread. Nobody sees the gap behind: this window's own scrim
   covers it.

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
  children,
}: {
  name: string
  onClose: () => void
  children?: React.ReactNode
}) {
  useEffectID(() => {
    const h = (e) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (hasOpenTooltip()) return
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
  return (
    <div
      data-modal-shell
      data-focus-window={name}
      onMouseDown={onClose}
      className="[position:fixed] [inset:0] [z-index:100] [background:var(--scrim)] [backdrop-filter:blur(4px)] [-webkit-backdrop-filter:blur(4px)] [display:grid] [place-items:start_center] [padding:8vh_6vw]"
    >
      {/* 980 × 84vh against the task window's 1110 × 92vh, and 8vh down its
          4vh: a clear inset on every side, whichever frame it came from */}
      <div
        data-issue-design="alignment"
        data-floating-surface
        className="animate-in fade-in zoom-in-95 [width:980px] [max-width:88vw] [height:84vh] [display:flex] [flex-direction:column] [background:var(--background)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-pop)] [overflow:hidden]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
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

function AttachmentRow({ att, canEdit }: { att: AttachmentVM; canEdit: boolean }) {
  const [arm, setArm] = useStateID(false)
  useEffectID(() => {
    if (!arm) return
    const t = setTimeout(() => setArm(false), 3500)
    return () => clearTimeout(t)
  }, [arm])
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
          title={arm ? 'Confirm removal' : 'Remove attachment'}
          onClick={() => {
            if (!arm) {
              setArm(true)
              return
            }
            P.removeAttachment(att.id)
          }}
        >
          <Icon name={arm ? 'trash' : 'close'} size={16} />
        </Button>
      )}
    </div>
  )
}

function AttachmentsSection({ it, canEdit }: { it: IssueVM; canEdit: boolean }) {
  const [drag, setDrag] = useStateID(false)
  const [uploading, setUploading] = useStateID([] as string[])
  const inputRef = useRefID<HTMLInputElement>(null)
  useWindowDropGuard()
  const limitMb = Math.round(P.attachmentLimit(it.id) / 1048576)
  const list = it.attachments || []
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
    <section className="task-section">
      <SectionHead
        icon="paperclip"
        label={`Attachments${list.length ? ` (${list.length})` : ''}`}
      />
      {(list.length > 0 || uploading.length > 0) && (
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
        </div>
      )}
      {canEdit ? (
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
            className="[background:none] [border:none] [padding:0] [cursor:pointer] [color:var(--text-1)] [font-size:var(--fs-sm)] [font-family:var(--sans)] underline underline-offset-2"
            variant="unstyled"
          >
            browse
          </Button>
          <div className="[font-size:var(--fs-xs)] [margin-top:3px]">
            Max {limitMb} MiB per file
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
      ) : list.length === 0 && uploading.length === 0 ? (
        <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
          No attachments.
        </div>
      ) : null}
    </section>
  )
}

/* Label picker: a temporary floating popup (Linear-style) anchored under the
   Labels heading. Searches the organization's shared label list, toggles on
   click; stays open for multiple toggles, closes on Escape or outside click.
   When the query matches nothing exactly, a clearly-marked "Create new
   label" row appears — creating is deliberate, never accidental. */
function LabelPickerPopup({
  it,
  anchor,
  onDone,
}: {
  it: IssueVM
  anchor: { x: number; y: number }
  onDone: () => void
}) {
  const [q, setQ] = useStateID('')
  // the task's OWN organization's vocabulary — a label from mine would be
  // rejected by the attach trigger (0028/0081)
  const all = P.orgLabels(it.org)
  const ql = q.trim().toLowerCase()
  const matches = ql ? all.filter((l) => matchesAllWords(l.name, ql)) : all
  // creating one lands in the home org, so it is offered only there
  const canCreate =
    !!ql &&
    it.org === P.homeOrg &&
    P.canWriteOrgLabels() &&
    !all.some((l) => l.name.toLowerCase() === ql)
  const create = () => {
    const id = P.addLabel({ name: q.trim() })
    if (id && !(it.labels || []).includes(id)) P.toggleIssueLabel(it.id, id)
    setQ('')
  }
  return (
    <AnchoredPop
      x={anchor.x}
      y={anchor.y}
      width={Math.min(300, window.innerWidth - 24)}
      onClose={onDone}
    >
      {/* no rule under the search row (deviation #65) — the pop is the task
          view's own, so it loses its hairlines with the window */}
      <div className="[display:flex] [align-items:center] [gap:8px] [padding:10px_12px_8px]">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (matches.length === 1) {
                P.toggleIssueLabel(it.id, matches[0].id)
                setQ('')
              } else if (canCreate && matches.length === 0) create()
            }
          }}
          placeholder="Add labels…"
          className="[flex:1] [min-width:0] [background:transparent] [border:none] [outline:none] [color:var(--text-1)] [font-size:var(--fs-base)] [font-family:var(--sans)] [padding:0]"
        />
        <Kbd>L</Kbd>
      </div>
      <div className="[display:flex] [flex-direction:column] [gap:2px] [max-height:240px] [overflow-y:auto] [padding:5px]">
        {matches.map((l) => {
          const on = (it.labels || []).includes(l.id)
          return (
            <Button
              type="button"
              key={l.id}
              onClick={() => P.toggleIssueLabel(it.id, l.id)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-text-1 hover:bg-hover"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
              variant="unstyled"
            >
              <span
                style={{ background: l.color }}
                className="[width:9px] [height:9px] [border-radius:50%] [flex-shrink:0]"
              />
              <span className="[flex:1] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                {l.name}
              </span>
              {on && <Icon name="check" size={14} color="var(--primary)" />}
            </Button>
          )
        })}
        {matches.length === 0 && !canCreate && (
          <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [padding:4px_5px]">
            {ql ? 'No matching labels.' : 'No labels yet.'}
          </div>
        )}
        {canCreate && (
          <Button
            type="button"
            onClick={create}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 pb-1.5 pt-2 text-left text-base text-text-1 hover:bg-hover ${matches.length ? 'mt-1.5' : ''}`}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--hover)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
            variant="unstyled"
          >
            <Icon name="plus" size={13} color="var(--text-2)" />
            <span className="[font-weight:600]">Create new label:</span>
            <span className="[color:var(--text-3)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
              “{q.trim()}”
            </span>
          </Button>
        )}
      </div>
    </AnchoredPop>
  )
}

/* Issue picker: same floating-popup concept as the label picker — search
   existing issues by key or title and pick on click. `single` closes after
   one pick (parent), otherwise it stays open for multiple toggles
   (sub-issues, linked issues). When the query matches nothing, a
   clearly-marked create row appears — the new issue is created in the same
   sub-project. `header` slots extra controls into the search row (the
   linked-issues relation selector). */
function IssuePickerPopup({
  anchor,
  onDone,
  placeholder,
  candidates,
  isOn,
  onPick,
  single,
  createLabel,
  onCreate,
  header,
}: {
  anchor: { x: number; y: number }
  onDone: () => void
  placeholder: string
  candidates: IssueVM[]
  isOn: (x: IssueVM) => boolean
  onPick: (x: IssueVM) => void
  single?: boolean
  createLabel: string
  onCreate?: (title: string) => void
  header?: React.ReactNode
}) {
  const [q, setQ] = useStateID('')
  const ql = q.trim().toLowerCase()
  const pool = ql
    ? candidates.filter((x) => matchesAllWords(`${x.key}\n${x.title}`, ql))
    : candidates
  const matches = pool.slice(0, 8)
  // like the label picker: no create row when the query IS an existing issue,
  // so an exact search can't accidentally create a duplicate
  const canCreate = !!ql && !!onCreate && !pool.some((x) => x.title.toLowerCase() === ql)
  const pick = (x: IssueVM) => {
    onPick(x)
    if (single) onDone()
    else setQ('')
  }
  const create = () => {
    onCreate?.(q.trim())
    if (single) onDone()
    else setQ('')
  }
  return (
    <AnchoredPop
      x={anchor.x}
      y={anchor.y}
      width={Math.min(340, window.innerWidth - 24)}
      onClose={onDone}
    >
      {/* unruled like the label pop above it (deviation #65) */}
      <div className="[display:flex] [align-items:center] [gap:8px] [padding:10px_12px_8px]">
        {header}
        <Input
          autoFocus
          value={q}
          maxLength={P.TITLE_MAX}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (matches.length === 1) pick(matches[0])
              else if (canCreate && matches.length === 0) create()
            }
          }}
          placeholder={placeholder}
          className="[flex:1] [min-width:0] [background:transparent] [border:none] [outline:none] [color:var(--text-1)] [font-size:var(--fs-base)] [font-family:var(--sans)] [padding:0]"
        />
      </div>
      <div className="[display:flex] [flex-direction:column] [gap:2px] [max-height:260px] [overflow-y:auto] [padding:5px]">
        {matches.map((x) => {
          const on = isOn(x)
          return (
            <Button
              type="button"
              key={x.id}
              onClick={() => pick(x)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 py-1.5 text-left text-base text-text-1 hover:bg-hover"
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--hover)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
              variant="unstyled"
            >
              <IssueKey id={x.key} />
              <span className="[flex:1] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
                {x.title}
              </span>
              {on && <Icon name="check" size={14} color="var(--primary)" />}
            </Button>
          )
        })}
        {matches.length === 0 && !canCreate && (
          <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [padding:4px_5px]">
            {ql ? 'No matching tasks.' : 'No eligible tasks.'}
          </div>
        )}
        {canCreate && (
          <Button
            type="button"
            onClick={create}
            className={`flex w-full cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-2 pb-1.5 pt-2 text-left text-base text-text-1 hover:bg-hover ${matches.length ? 'mt-1.5' : ''}`}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--hover)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
            variant="unstyled"
          >
            <Icon name="plus" size={13} color="var(--text-2)" />
            <span className="[font-weight:600]">{createLabel}</span>
            <span className="[color:var(--text-3)] [overflow:hidden] [text-overflow:ellipsis] [white-space:nowrap]">
              “{q.trim()}”
            </span>
          </Button>
        )}
      </div>
    </AnchoredPop>
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
      <span className="[font-size:var(--fs-sm)] [color:var(--text-3)] [min-width:0]">
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

function CommentRow({
  c,
  it,
  canLead,
  editing,
  onEdit,
  onDoneEdit,
}: {
  c: CommentVM
  it: IssueVM
  canLead: boolean
  editing: boolean
  onEdit: (id: string) => void
  onDoneEdit: () => void
}) {
  const [hover, setHover] = useStateID(false)
  const [armDel, setArmDel] = useStateID(false)
  useEffectID(() => {
    if (!armDel) return
    const t = setTimeout(() => setArmDel(false), 3500)
    return () => clearTimeout(t)
  }, [armDel])
  // mine = authored by ANY of my seats (0081): a comment I left in a
  // foreign project is authored by my guest profile there, not CURRENT_USER
  const own = !!c.author && P.myProfileIds.includes(c.author)
  const u = c.author ? P.user(c.author) : null
  const canEdit = own || canLead
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
                onClick={() => {
                  if (!armDel) {
                    setArmDel(true)
                    return
                  }
                  P.deleteComment(c.id)
                }}
              >
                <Icon name={armDel ? 'trash' : 'close'} size={16} />
              </Button>
            </div>
          )}
        </div>
        {editing ? (
          <div className="descfield [margin-top:3px]">
            <Suspense fallback={<Markdown text={c.body} />}>
              <DescEditor
                issueKey={null}
                org={it.org}
                value={c.body}
                placeholder="Comment…"
                ariaLabel="Edit comment"
                autoFocus
                comment={{
                  label: 'Save',
                  onCommit: (text: string) => {
                    P.updateComment(c.id, text)
                    onDoneEdit()
                  },
                  onDiscard: onDoneEdit,
                }}
              />
            </Suspense>
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
   `unreadTs` overrides where this visit's unread part starts. The window
   normally freezes that itself on open, but the inbox marks an item read the
   moment you click its row — before this component has rendered at all — so
   the only surviving answer is the one the inbox froze first.
   `holdThread` says somebody else owns the store's one comment cache — the
   pane behind a popped-out window, which is on the same task. Without it the
   pop-out's unmount would release a thread the pane is still showing. */
function IssueDetail({
  issueId,
  onClose,
  onOpen,
  onPlanOnRoadmap,
  embedded = false,
  unreadTs: unreadTsIn,
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
  unreadTs?: number | null
  onPopOut?: () => void
  onShowOnBoard?: (projectId: string, issueKey?: string) => void
  holdThread?: boolean
  closeLabel?: string
  modalActive?: boolean
}) {
  usePlannerVersion('comments')
  const mobile = useMobile()
  const [mobileTab, setMobileTab] = useStateID('activity')
  const [mobileViewport, setMobileViewport] = useStateID(() => ({
    height: window.visualViewport?.height || window.innerHeight,
    top: window.visualViewport?.offsetTop || 0,
  }))
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
  const mobileFrameRef = useRefID<HTMLDivElement>(null)
  const [editTitle, setEditTitle] = useStateID(false)
  const [titleDraft, setTitleDraft] = useStateID('')
  const [labelAnchor, setLabelAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [subAnchor, setSubAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [parentAnchor, setParentAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [linkAnchor, setLinkAnchor] = useStateID<{ x: number; y: number } | null>(null)
  const [linkType, setLinkType] = useStateID('blocked_by')
  const [confirmDel, setConfirmDel] = useStateID(false)
  const [moveOpen, setMoveOpen] = useStateID(false)
  const [archiveOpen, setArchiveOpen] = useStateID(false)
  const [actFilter, setActFilter] = useStateID('comments') // comments ⇄ all
  // the description discloses only in the embedded pane; the floating window
  // pins it open, which is what discussion-first means there
  const [descOpen, setDescOpen] = useStateID(!embedded)
  // …and either half can be lifted out into a window of its own, for reading
  // (or writing) a lot of text without the rest of the task around it. Only
  // one at a time: they are two views of the same column, and stacking them
  // would put a scrim over a scrim for nothing.
  const [focus, setFocus] = useStateID(null as null | 'desc' | 'activity')
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
    // L works from anywhere in a long panel: bring the heading on screen
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
  const openLabelPicker = () => {
    if (mobile) {
      setMobileTab('details')
      requestAnimationFrame(() => openPickerUnder(labelSecRef, setLabelAnchor, 300))
    } else openPickerUnder(labelSecRef, setLabelAnchor, 300)
  }
  useEffectID(() => {
    setEditTitle(false)
    setLabelAnchor(null)
    setSubAnchor(null)
    setParentAnchor(null)
    setLinkAnchor(null)
    setLinkType('blocked_by')
    setConfirmDel(false)
    setMoveOpen(false)
    setArchiveOpen(false)
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
  }, [issueId])
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
  useEffectID(() => {
    // L opens the label picker (unless focus is in a form control) — never in
    // the embedded frame, which has no Labels section for it to open under
    if (!issueId || embedded) return
    const h = (e) => {
      if (e.key !== 'l' && e.key !== 'L') return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      )
        return
      // a focused FieldSelect trigger/menu owns the keyboard like a native select would
      if (t?.closest?.('[data-fieldselect],[data-fieldselect-menu]')) return
      if (t?.closest?.('[data-task-subscribers]')) return
      e.preventDefault()
      openLabelPicker()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [issueId])

  const it = issueId ? P.issueById[issueId] : null
  useUpdateBlocker(editTitle && !!it && titleDraft !== it.title)
  // point the store's one-thread comment cache at this issue; release it when
  // the modal closes (uuid null) or the component unmounts
  const watchUuid = it ? it.uuid : null
  // …unless another window on the SAME task already holds it (holdThread): a
  // pop-out over the inbox pane would otherwise release, on its way out, a
  // thread the pane behind it is still showing.
  useEffectID(() => {
    if (!holdThread) P.watchComments(watchUuid)
  }, [watchUuid, holdThread])
  useEffectID(
    () => () => {
      if (!holdThread) P.watchComments(null)
    },
    [holdThread],
  )

  // Where this visit's unread part starts, frozen the moment the task opens.
  // Opening marks the task's messages read (below), so an unfrozen mark would
  // vanish while you were looking at it. Assigned DURING render, before any
  // effect runs — that ordering is the whole trick. Keyed on the uuid, not
  // issueId: on a cold deep link P.issueById[issueId] is still undefined on the
  // first render, and a null key would freeze "nothing unread" forever.
  // …unless the surface that opened us froze it first (the inbox, whose click
  // marks the item read before this render): then that answer IS the frozen
  // one, and asking again here would only ever find nothing.
  const frozen = useRefID<{ key: string | null | undefined; ts: number | null }>({
    key: undefined,
    ts: null,
  })
  if (frozen.current.key !== watchUuid) {
    frozen.current = {
      key: watchUuid,
      ts: unreadTsIn !== undefined ? unreadTsIn : firstUnreadTs(P.messages, watchUuid),
    }
  }
  const unreadTs = frozen.current.ts
  // …and mark them read, so the sidebar badge and this window cannot disagree.
  // The per-visit `done` set is the belt to the optimistic flip's braces: a
  // write persistRows rolls back must not re-arm on every realtime refetch.
  // It does re-arm for messages that ARRIVE while the window is open, which is
  // right — you are looking at the task as the comment lands.
  const readSent = useRefID<{ key: string | null | undefined; done: Set<string> }>({
    key: undefined,
    done: new Set(),
  })
  if (readSent.current.key !== watchUuid) readSent.current = { key: watchUuid, done: new Set() }
  // A snoozed item is a reminder that must return unread, so looking at its
  // task does not read it (the inbox's own select() skips it the same way).
  const toRead = watchUuid
    ? P.messages
        .filter(
          (m) =>
            m.issueUuid === watchUuid &&
            !m.read &&
            m.snoozedUntil === null &&
            !readSent.current.done.has(m.id),
        )
        .map((m) => m.id)
    : []
  const toReadKey = toRead.join(',')
  useEffectID(() => {
    if (!toRead.length) return
    toRead.forEach((id: string) => {
      readSent.current.done.add(id)
    })
    P.markMessagesRead(toRead)
  }, [toReadKey])

  // The spine opens at its newest end, like the inbox thread it now matches.
  // All four key terms earn their place: a different task is a different
  // thread; watchComments empties the cache first, so the opening render has
  // an empty spine and the snap must re-fire when the thread lands;
  // All ⇄ Comments changes the content height wholesale; and popping the
  // thread out moves it into a taller scroller that opens at the top unless
  // this fires again (actScrollRef follows it — only one is ever mounted).
  useBottomSnap(
    actScrollRef,
    issueId
      ? String(issueId) +
          ':' +
          (P.commentsLoaded ? '1' : '0') +
          ':' +
          actFilter +
          ':' +
          (focus === 'activity' ? 'pop' : 'in')
      : null,
  )
  const upd = (patch) => {
    P.updateIssue(it.id, patch)
  }
  const open = !!it
  useEffectID(() => {
    if (!mobile || !open || !modalActive) return
    const frame = mobileFrameRef.current
    if (!frame) return
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The Inbox task lives inside main. Isolate sibling branches on the way
    // to body, rather than making its own ancestor inert. Menus and dialogs
    // created later in portals remain available above the task.
    const outside = new Map<HTMLElement, boolean>()
    let branch: HTMLElement = frame
    while (branch.parentElement) {
      for (const sibling of branch.parentElement.children) {
        if (
          sibling !== branch &&
          sibling instanceof HTMLElement &&
          !sibling.matches('[data-focus-window], [data-modal-shell]')
        ) {
          outside.set(sibling, sibling.inert)
          sibling.inert = true
        }
      }
      if (branch.parentElement === document.body) break
      branch = branch.parentElement
    }
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
    const initialFocus = requestAnimationFrame(() => {
      if (!document.querySelector('[data-focus-window]')) {
        frame.querySelector<HTMLElement>('[data-mobile-task-back]')?.focus({ preventScroll: true })
      }
    })
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !(event.target instanceof Node) || !frame.contains(event.target))
        return
      const controls = focusable()
      const first = controls[0]
      const last = controls[controls.length - 1]
      if (!first) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    frame.addEventListener('keydown', trap)
    return () => {
      cancelAnimationFrame(initialFocus)
      frame.removeEventListener('keydown', trap)
      for (const [element, wasInert] of outside) element.inert = wasInert
      if (previousFocus?.isConnected && !previousFocus.closest('[inert]')) {
        restoreFocus(previousFocus)
      }
    }
  }, [mobile, open, modalActive])
  const reduceMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const proj = it ? P.project(it.project) : null
  const prog = it && P.isGroup(it) ? P.progressOf(it) : null
  const meta = it ? P.metaOf(it.project) : null
  // A task lives in its sub-project. The parent may be navigation-only for a
  // child grant, so all task edits must follow the task's own write level.
  const canLabel = !!it && P.canWrite(it.project)
  // one roster for both people pickers: the reviewer follows the assignee rule
  const assigneeChoices = it ? P.issueAssigneesFor(it.project) : []
  // one sentence for every control the read-only case switches off, so a
  // viewer is told WHY rather than left prodding a dead field
  const roTip = canLabel ? undefined : 'Read-only project access'
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
        disabled={!canLabel}
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
          disabled={!canLabel}
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
        disabled={!canLabel}
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
  const canMove =
    canLabel &&
    P.projects.some(
      (m) =>
        m.type === 'meta' &&
        m.org === it.org &&
        (m.children || []).some((cid: string) => cid !== it.project && P.canWrite(cid)),
    )

  // issue numbers are org-scoped and immutable (0050), so this link is
  // permanent — it survives moves and project renames; lowercase in URLs.
  // Failure must not toast success: a false "copied" pastes stale content.
  const copyLink = () => {
    // issueLink names the task's OWN organization in the path — its number
    // alone would be ambiguous for the recipient, since numbers are per-org
    const url = location.origin + issueLink(it.id)
    const done = () => window.showToast?.(`Copied a link to ${it.key}`)
    const fail = () => window.showToast?.("Couldn't copy — copy the address bar instead")
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done, fail)
      else fail()
    } catch {
      fail()
    }
  }
  const copyId = () => {
    const done = () => window.showToast?.(`Copied ${it.key} to clipboard`)
    try {
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(it.key).then(done, done)
      else done()
    } catch {
      done()
    }
  }

  // ancestor chain (parent -> ... -> root)
  const chain = []
  if (it) {
    let p = it.parent
    let guard = 0
    while (p && P.issueById[p] && guard++ < 12) {
      chain.unshift(p)
      p = P.issueById[p].parent
    }
  }

  // picker candidates (cycle-safe), same sub-project first; only while open.
  // Every relation is same-ORGANIZATION by DB guard (parents 0057, links
  // 0078), so the blended snapshot is narrowed before it is offered.
  const sameOrg = (x) => x.org === it.org
  const sameProjFirst = (a, b) =>
    Number(b.project === it.project) - Number(a.project === it.project)
  let subCandidates = []
  if (it && subAnchor) {
    // anything except the issue itself and its ancestors (would form a cycle);
    // current children show a check and toggle off
    const chainSet = new Set(chain)
    subCandidates = P.issues
      .filter((x) => sameOrg(x) && x.id !== it.id && !chainSet.has(x.id))
      .sort(sameProjFirst)
  }
  let parentCandidates = []
  if (it && parentAnchor) {
    // anything except the issue itself and its descendants (would form a cycle)
    const desc = new Set()
    const stack = [...(it.children || [])]
    while (stack.length) {
      const c = stack.pop()
      if (desc.has(c)) continue
      desc.add(c)
      ;(P.issueById[c]?.children || []).forEach((k) => {
        stack.push(k)
      })
    }
    parentCandidates = P.issues
      .filter((x) => sameOrg(x) && x.id !== it.id && !desc.has(x.id))
      .sort(sameProjFirst)
  }
  let linkCandidates = []
  if (it && linkAnchor) {
    // anything except the issue itself; already-linked issues show a check
    // and toggle off (link direction has no cycle concerns)
    linkCandidates = P.issues.filter((x) => sameOrg(x) && x.id !== it.id).sort(sameProjFirst)
  }

  // the discussion spine: this issue's comments and activity interleaved in
  // chat order — oldest at the top, newest at the bottom where the reply box
  // is and where the scroller opens. The Comments filter simply drops the
  // events from the merge.
  const comments = it ? P.comments.filter((c) => c.issue === it.uuid) : []
  const events =
    it && actFilter === 'all'
      ? P.activity.filter((e) => e.targetType === 'issue' && e.targetId === it.id)
      : []
  const spine = mergeSpine(comments, events)
  // nothing is said until the thread is in: watchComments empties the cache
  // first, and against an empty spine every mark degrades to 'tail' — which
  // would flash "New activity on this task" over "Loading comments…" and then
  // resolve into a rule somewhere else
  const mark = P.commentsLoaded ? unreadMark(spine, unreadTs) : { place: 'none', index: -1 }
  // 'tail': something is unread but nothing on screen is at or after it — say
  // so in words rather than drawing a rule with nothing under it. Point at the
  // All filter only when flipping to it would actually show the thing.
  const tailNote =
    it &&
    actFilter === 'comments' &&
    P.activity.some(
      (e) =>
        e.targetType === 'issue' && e.targetId === it.id && unreadTs !== null && e.ts >= unreadTs,
    )
      ? 'New activity on this task — see All.'
      : 'New activity on this task.'
  const canLead = !!it && P.levelOn(it.project) === 'lead'
  const postComment = (text: string) => {
    if (!it) return
    P.addComment(it.uuid, text)
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
  }
  const labelClass = 'text-md font-semibold text-text-1'

  /* The description field and the Activity thread each render in exactly ONE
     of two places — in the discussion column, or alone in a focus window — so
     they are written once here and called from whichever is mounted. Never
     both: two copies of the description would be two drafts of one field, and
     two composers two drafts of one reply. The column simply stops rendering
     its copy while the window is up, which nobody sees, because the window's
     own scrim is over it.
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
    return canLabel ? (
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
        <Suspense
          fallback={
            <div className="[min-height:104px]">
              {it.description ? <Markdown text={it.description} /> : null}
            </div>
          }
        >
          {/* keyed: in-modal navigation swaps issues in place, and the
              editor's committed-text refs are per-issue state */}
          <DescEditor
            key={it.id}
            ref={descRef}
            issueKey={it.id}
            org={it.org}
            value={it.description || ''}
          />
        </Suspense>
      </div>
    ) : it.description ? (
      // a viewer's copy has no field border to close, so the cap stays on the
      // wrapper here; descWrapRef rides whichever of the two is mounted, which
      // is what the per-issue scroll reset resets
      <div ref={descWrapRef} style={box}>
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
          {!P.commentsLoaded && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
              Loading comments…
            </div>
          )}
          {spine.flatMap((s, i) => {
            const row =
              s.kind === 'c' ? (
                <CommentRow
                  key={s.id}
                  c={s.c}
                  it={it}
                  canLead={canLead}
                  editing={editingComment === s.id}
                  onEdit={setEditingComment}
                  onDoneEdit={() => setEditingComment(null)}
                />
              ) : (
                <EventRow key={s.id} e={s.e} />
              )
            // one index, so the mark can only ever be drawn once
            return mark.place === 'mark' && i === mark.index
              ? [<UnreadDivider key="unread" />, row]
              : [row]
          })}
          {P.commentsLoaded && spine.length === 0 && (
            <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
              {actFilter === 'comments' ? 'No comments yet.' : 'No activity yet.'}
            </div>
          )}
          {mark.place === 'tail' && <UnreadDivider key="unread" place="tail" note={tailNote} />}
        </div>
      </div>

      {/* The reply box is the last thing IN the thread, not a bar under the
          column: it sits directly beneath the newest row and scrolls with it,
          so on a short thread it is up where the conversation is instead of
          stranded at the floor. No rule above it — deviation #65 took the rules
          out of this window and 16px of space is the parting. The 26vh cap
          stays: the draft scrolls inside the field, between its formatting
          row and its buttons, rather than in this scroller. */}
      {canLabel && (
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
              <Suspense fallback={<div className="[min-height:104px]" />}>
                {/* the description field, verbatim — same dialect, same
                    Save/Discard contract; posting clears it (reset) */}
                <DescEditor
                  key={it.id}
                  ref={composerRef}
                  issueKey={null}
                  org={it.org}
                  value=""
                  placeholder="Leave a comment…"
                  ariaLabel="Leave a comment"
                  comment={{ label: 'Comment', reset: true, onCommit: postComment }}
                />
              </Suspense>
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
      onClick={() => setFocus(which)}
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
     whole-task pop-out. Every header links its project and sub-project to
     their boards, including a section's focus window.
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
                      href={buildPath({ scope: p.id, view: 'kanban' })}
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
                        onShowOnBoard(p.id)
                      }}
                      className="max-w-60 overflow-hidden text-ellipsis whitespace-nowrap rounded-sm px-1 py-0.5 text-sm text-text-3 no-underline hover:bg-hover hover:text-text-1 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    >
                      {p.name}
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
          {live && editTitle ? (
            <Textarea
              autoFocus
              aria-label="Task title"
              rows={1}
              value={titleDraft}
              maxLength={P.TITLE_MAX}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => {
                const v = titleDraft.trim()
                if (v && v !== it.title) upd({ title: v })
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
              className="min-h-0 [flex:1] [min-width:0] [margin:0] [font-size:var(--fs-xl)] [font-weight:600] [line-height:1.3] [letter-spacing:-0.01em] [font-family:var(--sans)] [color:var(--text-1)] [background:var(--surface-1)] [border:1px_solid_var(--border-strong)] [border-radius:var(--r-sm)] [padding:3px_8px] [outline:none] [resize:none]"
            />
          ) : (
            <HoverTooltip content={live ? 'Edit title' : undefined}>
              <h1
                data-task-title
                onClick={
                  live
                    ? () => {
                        setTitleDraft(it.title)
                        setEditTitle(true)
                      }
                    : undefined
                }
                style={{ cursor: live ? 'text' : 'default' }}
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
        onClick={() => setFocus(null)}
        aria-label="Close (esc)"
        title="Close (esc)"
      >
        <Icon name="close" size={16} />
      </Button>
    </div>
  )

  // close only when the CLICK also STARTED on the scrim: releasing a text
  // drag (title/description selection) past the modal edge fires a click on
  // the scrim as the common ancestor and must not nuke the draft
  const scrimDownRef = useRefID(false)
  return (
    <>
      {/* Two frames, one window. Floating, it uses the theme's window material,
          sized and animated like the create dialogs. Embedded, there is no
          scrim to float over and nothing to animate in: it simply IS the pane
          it was handed, so the card loses the border, radius and shadow that
          only ever said "this is standing off the page". */}
      <div
        ref={mobileFrameRef}
        data-mobile-task-frame={mobile && (embedded || open) ? '' : undefined}
        // the probe an embedded pane reads to yield Escape to a pop-out of
        // itself — only while one is actually up: outside the inbox a closed
        // floating window stays mounted at opacity 0, and a scrim nobody can
        // see must not silence a pane's Escape
        data-task-scrim={!embedded && open ? '' : undefined}
        className={cn(
          embedded
            ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
            : 'fixed inset-0 z-[60] grid items-start justify-items-center overflow-y-auto bg-scrim px-[3vw] py-[4vh] backdrop-blur-sm',
          // Override the mobile stylesheet's inset so the measured visual
          // viewport, including its keyboard offset, determines the frame.
          mobile && '!bottom-auto',
        )}
        // A press that dismisses an open menu must not also close the window
        // (layered dismissal): Radix portals a field select's list and a
        // popover outside this tree, and the pointer-events:none it puts on
        // <body> stops at this scrim, which sets its own. Read on pointerdown,
        // which reaches this handler before Radix's document-level listener
        // dismisses the menu — so the menu is still in the DOM to be found.
        onPointerDown={
          embedded
            ? undefined
            : (e) => {
                scrimDownRef.current =
                  e.target === e.currentTarget &&
                  !document.querySelector(
                    '[data-fieldselect-menu], [data-slot="popover-content"], [data-slot="dropdown-menu-content"]',
                  )
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
          ...(!embedded
            ? {
                opacity: open ? 1 : 0,
                pointerEvents: open ? 'auto' : 'none',
                transition: reduceMotion ? 'none' : 'opacity var(--dur-mid) var(--ease-out)',
              }
            : {}),
          ...(mobile ? { height: mobileViewport.height, top: mobileViewport.top } : {}),
        }}
      >
        {/* the dialog IS the window: one card, the shared chrome on top and the
          discussion + details columns below */}
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is set only on the branch where role is dialog — Biome cannot evaluate the paired ternaries */}
        <div
          role={embedded && !mobile ? 'region' : 'dialog'}
          data-floating-surface={embedded && !mobile ? undefined : ''}
          aria-modal={embedded && !mobile ? undefined : 'true'}
          aria-hidden={!open ? true : undefined}
          aria-label="Task"
          data-issue-design="alignment"
          data-issue-layout={
            mobile ? 'mobile' : embedded ? 'embedded' : narrow ? 'stacked' : 'columns'
          }
          data-mobile-task={mobile ? '' : undefined}
          data-mobile-task-compact={mobile && mobileViewport.height < 600 ? '' : undefined}
          data-mobile-tab={mobile ? mobileTab : undefined}
          className={`flex flex-col overflow-hidden bg-background ${
            embedded
              ? 'min-h-0 min-w-0 flex-1 rounded-none border-0 shadow-none'
              : 'w-[1110px] h-[92vh] max-w-[94vw] rounded-xl border border-border shadow-pop'
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
                    <IssueSubscribers key={it.uuid} issue={it} />
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
                          onClick={() => {
                            setConfirmDel(false)
                            t()
                          }}
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
                            the same jump as the row's right-click entry */}
                          {embedded && onShowOnBoard && (
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
                              onClick={() => {
                                close()
                                setMoveOpen(true)
                              }}
                            >
                              <Icon name="arrowRight" size={14} />
                              Move to sub-project…
                            </MenuItem>
                          )}
                          {/* archiving takes the whole subtree with it, so only an
                            issue whose leaf work is entirely Done archives on the
                            spot — any unfinished leaf work
                            asks for a why first (ArchiveIssueModal → comment,
                            0070). Mirrors the sweep's leaf-up caution:
                            unfinished work never leaves the board silently. */}
                          {canLabel &&
                            (() => {
                              const needsWhy = !P.isDone(it)
                              return (
                                <MenuItem
                                  onClick={() => {
                                    close()
                                    if (needsWhy) {
                                      setArchiveOpen(true)
                                      return
                                    }
                                    const id = it.id
                                    const shown = it.key
                                    onClose()
                                    P.archiveIssue(id)
                                    window.showToast?.(`Archived ${shown}`)
                                  }}
                                >
                                  <Icon name="inbox" size={14} />
                                  {needsWhy ? 'Archive task…' : 'Archive task'}
                                </MenuItem>
                              )
                            })()}
                          {/* the rule that fenced Delete off is gone with the rest
                            of the window's lines (deviation #65) — `danger`
                            already paints the entry red, which is the warning
                            the divider was repeating */}
                          <MenuItem
                            danger
                            onClick={() => {
                              if (!confirmDel) {
                                setConfirmDel(true)
                                return
                              }
                              const id = it.id
                              const shown = it.key
                              close()
                              onClose()
                              P.deleteIssue(id)
                              window.showToast?.(`Deleted ${shown}`)
                            }}
                          >
                            <Icon name="trash" size={14} />
                            {confirmDel ? 'Confirm delete' : 'Delete task'}
                          </MenuItem>
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
                          onClick={() => setDescOpen((v) => !v)}
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
                    {(!descOpen && !mobile) || focus === 'desc' ? null : descBody(true)}
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
                    spineScroller('0 20px 20px')
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
                            disabled={!canLabel}
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
                          {P.isGroup(it) ? (
                            (() => {
                              // an issue with sub-issues has no hours of its own (0066):
                              // the value is the recursive sum over the subtree
                              const rem = P.remainingOf(it)
                              return (
                                <HoverTooltip content="Sum of subtask hours; parent tasks have no hours of their own">
                                  <span
                                    data-remaining-rollup
                                    style={{ color: rem != null ? undefined : 'var(--text-3)' }}
                                    className="!font-mono [font-size:var(--fs-sm)]"
                                  >
                                    {rem != null ? `Σ ${rem}h` : '—'}
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
                          Update Estimate walk can't drift (empty = unset, and
                          a stored 0 is a value, not a clear). */}
                              <Input
                                data-remaining-input
                                aria-label="Remaining hours"
                                type="number"
                                min="0"
                                placeholder="—"
                                key={`${it.id}:${it.remaining != null ? it.remaining : ''}`}
                                defaultValue={remainingValue(it.remaining)}
                                disabled={!canLabel}
                                title={roTip}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') e.currentTarget.blur()
                                }}
                                onBlur={(e) => {
                                  const p = remainingPatchFromInput(e.target, it.remaining)
                                  if (p.write) upd({ remaining: p.value })
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
                          const overdue = !!it.due && it.due < P.TODAY_ISO && !P.isDone(it)
                          // with delay tracking (0064) the chip carries the projected
                          // status — "Delayed" covers overdue; without it, the plain
                          // overdue chip stays as before
                          const delay = P.tracksDelay(it) ? P.delayOf(it) : null
                          const late = delay ? delay.status === 'late' : overdue
                          const tip = delay
                            ? P.DELAY_LABELS[delay.status] +
                              (overdue
                                ? ' — the due date has passed'
                                : delay.fin != null
                                  ? ' — projected to finish in the week of ' +
                                    P.fmtDate(P.weekToDate(delay.fin))
                                  : '')
                            : undefined
                          return (
                            <DetailField label="Due">
                              <DateInput
                                value={it.due || null}
                                onChange={(v) => upd({ due: v })}
                                disabled={!canLabel}
                                title={roTip}
                                aria-invalid={late}
                                className={late ? '!border-danger' : undefined}
                              />
                              {/* On track draws nothing — the DELAY_COLORS rule, applied
                                  here too; a slipping or lost deadline is a glyph in its
                                  pressure colour beside plain words, the projection in the
                                  tooltip. The colour never goes on text: a lost deadline
                                  is the red border of the date box and the red glyph. */}
                              {delay
                                ? delay.status !== 'ok' && (
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
                                : overdue && (
                                    <span className="flex h-5 items-center gap-1.5 text-xs font-medium text-text-2">
                                      <Icon
                                        name="warning"
                                        size={14}
                                        strokeWidth={2}
                                        color="var(--danger)"
                                      />
                                      Overdue
                                    </span>
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
                    later, separate "Plan on roadmap" feature. */}
                        {(() => {
                          const dueWeek = it.due ? P.isoToWeek(it.due) : null
                          const scheduled = it.start != null && it.end != null
                          const rejectPastDue = () => {
                            window.showToast?.("The end date can't be after the due date")
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
                          return (
                            <DetailField label="Plan">
                              <div className="task-plan-dates">
                                <fieldset className="task-plan-date" aria-label="Plan start">
                                  <span className="task-plan-caption">Start</span>
                                  <DateSelect
                                    value={it.start}
                                    onChange={setStart}
                                    clearable
                                    disabled={!canLabel}
                                    title={roTip}
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
                                    clearable
                                    disabled={!canLabel}
                                    title={roTip}
                                  />
                                </fieldset>
                              </div>
                              {/* plan in context: jumps to the roadmap with this issue
                          spotlit. An unscheduled issue gets a starter bar there
                          (capped at the due week) to drag into place. */}
                              <div className="task-plan-actions">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  data-plan-on-roadmap
                                  className="text-text-1 h-control-sm"
                                  onClick={() => onPlanOnRoadmap?.(it.id)}
                                >
                                  <Icon name="timeline" size={16} />
                                  Plan on roadmap
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
                          {canLabel && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="task-heading-action"
                              aria-label="Add label"
                              title="Add label (L)"
                              onClick={openLabelPicker}
                            >
                              <Icon name="plus" size={16} />
                            </Button>
                          )}
                        </SectionHead>
                        {(it.labels || []).length > 0 && (
                          <div className="task-labels">
                            {it.labels.map((lid) => {
                              const l = P.labelById[lid]
                              if (!l) return null
                              return (
                                <span key={lid} className="task-label">
                                  <span className="task-label-name">{l.name}</span>
                                  {canLabel && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="icon"
                                      className="task-label-remove text-text-2"
                                      aria-label={`Remove label “${l.name}”`}
                                      title={`Remove label “${l.name}”`}
                                      onClick={() => P.toggleIssueLabel(it.id, lid)}
                                    >
                                      <Icon name="close" size={16} />
                                    </Button>
                                  )}
                                </span>
                              )
                            })}
                          </div>
                        )}
                        {!canLabel && (it.labels || []).length === 0 && (
                          <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
                            No labels.
                          </div>
                        )}
                      </section>

                      <AttachmentsSection it={it} canEdit={canLabel} />

                      {prog && (
                        <div className="task-section">
                          <div className="task-section-head flex-wrap text-text-1">
                            <span className={labelClass}>Progress</span>
                            <span className="ml-auto text-xs">
                              {prog.unknown
                                ? `${prog.done} of ${prog.total} visible tasks done. Completion unknown.`
                                : prog.total > 0
                                  ? prog.done +
                                    ' of ' +
                                    prog.total +
                                    ' tasks done, ' +
                                    prog.pct +
                                    '%'
                                  : 'no subtasks yet'}
                            </span>
                          </div>
                          {prog.unknown ? (
                            <span className="text-xs text-text-3">
                              Additional work is outside this view.
                            </span>
                          ) : (
                            <ProgressBar
                              value={prog.pct}
                              color={P.delayColor(it) || undefined}
                              height={7}
                            />
                          )}
                        </div>
                      )}

                      <section ref={parentSecRef} className="task-section">
                        <SectionHead icon="parent" label="Parent" inlineAction>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="task-heading-action"
                            aria-label={it.parent ? 'Change parent' : 'Set parent'}
                            title={it.parent ? 'Change parent' : 'Set parent'}
                            onClick={() => openPickerUnder(parentSecRef, setParentAnchor, 340)}
                          >
                            <Icon name={it.parent ? 'pen' : 'plus'} size={16} />
                          </Button>
                        </SectionHead>
                        {it.parent ? (
                          <MiniIssueRow
                            id={it.parent}
                            onOpen={onOpen}
                            remove={{
                              label: 'Remove parent',
                              onClick: () => upd({ parent: null }),
                            }}
                          />
                        ) : (
                          <div className="text-sm text-text-2 italic">No parent task.</div>
                        )}
                      </section>

                      <section ref={subSecRef} className="task-section">
                        <SectionHead
                          icon="child"
                          inlineAction
                          label={
                            'Subtasks' +
                            ((it.children || []).length ? ` (${it.children.length})` : '')
                          }
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="task-heading-action"
                            aria-label="Add subtask"
                            title="Add subtask"
                            onClick={() => openPickerUnder(subSecRef, setSubAnchor, 340)}
                          >
                            <Icon name="plus" size={16} />
                          </Button>
                        </SectionHead>
                        {(it.children || []).length > 0 ? (
                          <div className="[display:flex] [flex-direction:column] [gap:6px]">
                            {it.children.map((cid) => (
                              <MiniIssueRow
                                key={cid}
                                id={cid}
                                onOpen={onOpen}
                                remove={{
                                  label: 'Remove subtask',
                                  onClick: () => P.updateIssue(cid, { parent: null }),
                                }}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
                            No subtasks.
                          </div>
                        )}
                      </section>

                      <section ref={linkSecRef} className="task-section">
                        <SectionHead
                          icon="link"
                          inlineAction
                          label={
                            'Linked tasks' +
                            ((it.links || []).length ? ` (${it.links.length})` : '')
                          }
                        >
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="task-heading-action"
                            aria-label="Link task"
                            title="Link task"
                            onClick={() => openPickerUnder(linkSecRef, setLinkAnchor, 340)}
                          >
                            <Icon name="plus" size={16} />
                          </Button>
                        </SectionHead>
                        {(it.links || []).length > 0 ? (
                          <div className="[display:flex] [flex-direction:column] [gap:6px]">
                            {it.links.map((l) => (
                              <MiniIssueRow
                                key={l.id}
                                id={l.id}
                                onOpen={onOpen}
                                relation={relMapID[l.type]}
                                remove={{
                                  label: 'Remove link (both directions)',
                                  onClick: () => P.removeLink(it.id, l.id),
                                }}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="[font-size:var(--fs-sm)] [color:var(--text-3)] [font-style:italic]">
                            No dependencies yet.
                          </div>
                        )}
                      </section>
                    </div>
                  </aside>
                )}
              </div>
            </>
          )}
        </div>
      </div>
      {/* One half of the task, alone, in a window standing on this one. Both
          are rendered here for the same reason the pickers below are: a
          fixed-position layer inside the scaled/blurred card would take the
          card as its containing block. */}
      {/* Each one is the task window showing a single section: the SAME two
          heading lines (breadcrumb, then the task name), then the section's
          own heading exactly as the column draws it — minus the pop-out
          button, which is what got you here. */}
      {it && focus === 'desc' && (
        <FocusWindow name="Description" onClose={() => setFocus(null)}>
          {windowHead({ chrome: focusChrome, live: false, padBottom: 10 })}
          <div className="[flex:1] [min-height:0] [display:flex] [flex-direction:column] [padding:0_20px_20px]">
            <SectionHead icon="page" label="Description" />
            {descBody(false)}
          </div>
        </FocusWindow>
      )}
      {it && focus === 'activity' && (
        <FocusWindow name="Activity" onClose={() => setFocus(null)}>
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
      {it && labelAnchor && (
        <LabelPickerPopup it={it} anchor={labelAnchor} onDone={() => setLabelAnchor(null)} />
      )}
      {it && subAnchor && (
        <IssuePickerPopup
          anchor={subAnchor}
          onDone={() => setSubAnchor(null)}
          placeholder="Add subtasks: ID or title…"
          candidates={subCandidates}
          isOn={(x) => x.parent === it.id}
          onPick={(x) => P.updateIssue(x.id, { parent: x.parent === it.id ? null : it.id })}
          createLabel="Create new subtask:"
          onCreate={(title) => {
            P.addIssue({ project: it.project, title, parent: it.id })
          }}
        />
      )}
      {it && linkAnchor && (
        <IssuePickerPopup
          anchor={linkAnchor}
          onDone={() => setLinkAnchor(null)}
          placeholder="Link tasks: ID or title…"
          candidates={linkCandidates}
          header={
            <NativeSelect
              value={linkType}
              onChange={(e) => setLinkType(e.target.value)}
              className="h-control-sm shrink-0 cursor-pointer rounded-sm border border-border bg-surface-1 px-1 py-0 text-sm text-text-1"
            >
              <option value="blocked_by">is blocked by</option>
              <option value="blocks">blocks</option>
              <option value="relates">relates to</option>
            </NativeSelect>
          }
          isOn={(x) => (it.links || []).some((l) => l.id === x.id)}
          onPick={(x) => {
            if ((it.links || []).some((l) => l.id === x.id)) P.removeLink(it.id, x.id)
            else P.addLink(it.id, linkType, x.id)
          }}
          createLabel="Create new linked task:"
          onCreate={(title) => {
            const key = P.addIssue({ project: it.project, title })
            if (key) P.addLink(it.id, linkType, key)
          }}
        />
      )}
      {it && parentAnchor && (
        <IssuePickerPopup
          anchor={parentAnchor}
          onDone={() => setParentAnchor(null)}
          single
          placeholder="Set parent: ID or title…"
          candidates={parentCandidates}
          isOn={(x) => it.parent === x.id}
          onPick={(x) => upd({ parent: it.parent === x.id ? null : x.id })}
          createLabel="Create new parent task:"
          onCreate={(title) => {
            const key = P.addIssue({ project: it.project, title })
            if (key) upd({ parent: key })
          }}
        />
      )}
      {/* stacked ModalShell (like the sub-issue modal): nothing moves until
          its Move button is pressed */}
      {it && moveOpen && (
        <MoveIssueModal
          issueId={it.id}
          onClose={() => setMoveOpen(false)}
          onMove={(pid) => {
            // the key is org-scoped and immutable (0050): the modal stays
            // anchored to the same issue, nothing to re-open or re-anchor
            const key = P.moveIssue(it.id, pid)
            setMoveOpen(false)
            if (!key) {
              // the target vanished between render and click (concurrent delete)
              window.showToast?.("Couldn't move: the sub-project no longer exists")
              return
            }
            const t = P.project(pid)
            // the handle is a uuid for another organization's tasks — toasts
            // and every other human-facing string name the readable key
            window.showToast?.(
              `Moved ${P.issueById[key]?.key || key} to ${t ? t.name : 'the sub-project'}`,
            )
          }}
        />
      )}
      {/* stacked like the Move dialog; only reachable for non-Done issues */}
      {it && archiveOpen && (
        <ArchiveIssueModal
          issueId={it.id}
          onClose={() => setArchiveOpen(false)}
          onArchive={(reason) => {
            const id = it.id
            const shown = it.key
            setArchiveOpen(false)
            onClose() // the issue leaves the snapshot — the window has nothing to show
            P.archiveIssue(id, reason)
            window.showToast?.(`Archived ${shown}`)
          }}
        />
      )}
    </>
  )
}

export { IssueDetail }
