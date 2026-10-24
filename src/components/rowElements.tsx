/* Elements for rows that a list renders thousands of times, such as Board
   cards. Every component a card mounts adds to mounting a Board and to
   leaving it, so a card builds these parts as elements: in the static scope
   `statics` (liveControls.tsx, null once a row is live) each one is the DOM
   its component renders there, without a component of its own. Avatar,
   PriorityIcon, ProjectName and AssigneeAvatar render through them too, so
   both stay the same DOM. */
import {
  type DragEvent,
  Fragment,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type SyntheticEvent,
} from 'react'
import { Avatar as UiAvatar } from '@/components/ui/avatar'
import { avatarHooks } from '@/components/ui/avatar-hooks'
import { buttonElement } from '@/components/ui/button-element'
import { LiveTooltip } from '@/components/ui/tooltip'
import { staticTooltipTarget } from '@/components/ui/tooltip-target'
import type { StaticControls } from '@/lib/liveControls'
import { cn } from '@/lib/utils'
import { type IssueVM, P } from '@/store/planner'

/** The Lucide glyphs drawn by one element each (styles/glyphs.css). */
type GlyphName = 'pause' | 'user'

/** Lucide's `name` as one element painted through a mask, `size` pixels
    square, in `color` (the text color by default). Rows that a page holds
    thousands of, such as Board cards, use it in place of Icon: an inline
    <svg> costs every frame while it is in the page, even hidden. */
export function glyph(name: GlyphName, size: number, color?: string) {
  return (
    <span
      aria-hidden="true"
      className={`glyph glyph-${name}`}
      style={{ width: size, height: size, color }}
    />
  )
}

/** HoverTooltip: `children` with `content` as its tooltip. */
export function hoverTooltip(
  statics: StaticControls | null,
  content: ReactNode,
  children: ReactElement<HTMLAttributes<HTMLElement>>,
) {
  return statics ? (
    staticTooltipTarget(content, children)
  ) : (
    <LiveTooltip content={content}>{children}</LiveTooltip>
  )
}

/* ---- Avatars ----------------------------------------------------------
   An uploaded picture painted over the initials-on-color chip. The chip is
   not a placeholder that gets replaced: it is always rendered, so a person
   without a picture, or one whose picture fails to load, shows initials. */
/* 20 is the Team sync row's portrait (beside a chevron in a 32px control). */
export type AvatarSize = 20 | 28 | 40

/** A picture that fails to load hides, which shows the initials under it.
    The picture is keyed by its address, so a new address shows again. */
const hidePicture = (event: SyntheticEvent<HTMLImageElement>) => {
  event.currentTarget.style.display = 'none'
}

type AvatarRootProps = HTMLAttributes<HTMLSpanElement> & { 'data-avatar'?: string }

/** Avatar: the portrait of the person `id`, or Unassigned's. */
export function avatar(
  statics: StaticControls | null,
  id: string | null | undefined,
  size: AvatarSize,
  ring = false,
) {
  // a static row renders the root's span without Radix (ui/avatar.tsx)
  const root = ({ className, ...props }: AvatarRootProps) =>
    statics ? (
      <span {...avatarHooks('default', className)} {...props} />
    ) : (
      <UiAvatar className={className} {...props} />
    )
  const u = P.user(id)
  if (!u)
    return hoverTooltip(
      statics,
      'Unassigned',
      root({
        tabIndex: -1,
        role: 'img',
        'aria-label': 'Unassigned',
        style: { width: size, height: size },
        className:
          'flex items-center justify-center rounded-[5px] border border-dashed border-border-strong bg-surface-3',
        children: glyph('user', size * 0.55, 'var(--text-3)'),
      }),
    )
  // null until an uploaded picture's signed URL arrives (0097)
  const src = u.avatarPath ? u.avatarUrl : null
  // The two larger portraits share one readable fallback type step; the
  // 20px row portrait steps its initials down so two letters still fit.
  return hoverTooltip(
    statics,
    u.name,
    root({
      tabIndex: -1,
      'data-avatar': u.id,
      role: 'img',
      'aria-label': u.name,
      style: {
        width: size,
        height: size,
        backgroundColor: u.color,
        boxShadow: ring ? '0 0 0 2px var(--surface-1)' : undefined,
      },
      // centered by flex: a grid would keep its track sizes for every
      // portrait, and a Board holds thousands
      className: cn(
        'flex items-center justify-center rounded-[5px] font-semibold text-white',
        size === 20 ? 'rounded-[4px] text-[10px]' : '[font-size:var(--fs-sm)]',
      ),
      // one text node when there is no picture
      children: src ? (
        <>
          {u.initials}
          {/* no-referrer so the page a face is drawn on never reaches the host */}
          <img
            key={src}
            data-avatar-img
            src={src}
            alt=""
            referrerPolicy="no-referrer"
            onError={hidePicture}
            className="[position:absolute] [inset:0] [width:100%] [height:100%] [object-fit:cover] [display:block] [border-radius:inherit]"
          />
        </>
      ) : (
        u.initials
      ),
    }),
  )
}

/* ---- Issue meta glyphs ------------------------------------------------ */
/* Rank is carried TWICE by shape: the glyph fills one, two or three bars, and
   the colour steps up in lightness with it (--prio-low = --text-3, --prio-medium
   = --text-2, --prio-high = --text-1). Only `urgent` spends a hue — it is the
   one level that leaves the lightness ramp, and it drops the bars for a filled
   chip so it is still legible where colour isn't. The colours arrive as
   p.color from the store, already tokens. */
/** PriorityIcon: the glyph of `priority`, `size` pixels square. */
export function priorityIcon(statics: StaticControls | null, priority: string, size = 14) {
  const p = P.PRIORITIES[priority]
  if (!p) return null
  if (priority === 'urgent') {
    return (
      /* The chip scales with `size`, so its radius and its glyph are derived
         from it rather than tokenised — but both are ROUNDED, or a 13px chip
         asks for 2.86px of radius and 10.14px of text. Fractional type is the
         one thing the scale exists to stop; proportion survives the rounding. */
      hoverTooltip(
        statics,
        'Urgent priority',
        <span
          tabIndex={-1}
          role="img"
          aria-label="Urgent priority"
          style={{
            width: size,
            height: size,
            borderRadius: Math.round(size * 0.22),
            background: p.color,
            fontSize: Math.round(size * 0.78),
          }}
          className="[color:#fff] [display:inline-grid] [place-items:center] [font-weight:800] [line-height:1] [flex-shrink:0] [font-family:var(--sans)]"
        >
          !
        </span>,
      )
    )
  }
  // one element: the bars are a mask over a fill (styles/glyphs.css)
  return hoverTooltip(
    statics,
    `${p.name} priority`,
    <span
      tabIndex={-1}
      role="img"
      aria-label={`${p.name} priority`}
      data-prio={priority}
      style={{ height: size, width: size }}
      className="prio-bars"
    />,
  )
}

type ProjectRef = { id: string; name: string }

/** ProjectName: a project's name, with its number when another project
    shown has the same name. Plain text when no name needs its number. */
export function projectName({
  project,
  owner,
  wrap,
}: {
  project: ProjectRef
  owner?: ProjectRef | null
  wrap?: boolean
}) {
  const names = owner && owner.id !== project.id ? [owner, project] : [project]
  const parts = names.map((p) => ({ id: p.id, name: p.name, tag: P.projectTag(p.id) }))
  if (!parts.some((p) => p.tag)) return names.map((p) => p.name).join(', ')
  // line-height 1 keeps the mono number from deepening the line it sits on
  const number = (tag: string) => (
    <span
      data-project-tag
      className="whitespace-nowrap !font-mono text-xs leading-none font-normal text-text-2"
    >
      {tag}
    </span>
  )
  // real spaces keep "Test #4" apart for screen readers and copied text
  if (wrap) {
    return (
      <>
        {parts.map((p, i) => (
          <Fragment key={p.id}>
            {i > 0 && ', '}
            {p.name}
            {p.tag && <> {number(p.tag)}</>}
          </Fragment>
        ))}
      </>
    )
  }
  // One grid column per part. Numbers and separators keep their width; the
  // names truncate and share what is left equally, so a short name stays
  // whole beside a long one. A grid drops plain spaces, so separators
  // preserve them; the space before a number is drawn 6px wide.
  const gap = (text: string, className?: string) => (
    <span className={cn('whitespace-pre', className)}>{text}</span>
  )
  return (
    <span className="inline-grid min-w-0 max-w-full grid-flow-col items-baseline align-bottom">
      {parts.map((p, i) => (
        <Fragment key={p.id}>
          {i > 0 && gap(', ')}
          <span className="truncate">{p.name}</span>
          {p.tag && (
            <>
              {gap(' ', 'w-1.5 overflow-hidden')}
              {number(p.tag)}
            </>
          )}
        </Fragment>
      ))}
    </span>
  )
}

/* ---- The owner portrait (AssigneeAvatar) ------------------------------ */

/** The attributes a closed Radix popover gives its trigger, which a static
    trigger carries in their place. */
export const POPOVER_CLOSED = {
  'aria-haspopup': 'dialog',
  'aria-expanded': false,
  'data-state': 'closed',
} as const

export const PORTRAIT_CLASS =
  'flex cursor-pointer rounded-md outline-none hover:ring-2 hover:ring-border-strong focus-visible:ring-2 focus-visible:ring-primary'

/** The span around the owner control, which keeps its clicks from the row. */
export const OWNER_WRAP = {
  role: 'presentation',
  className: 'pointer-events-auto relative inline-flex shrink-0',
  onClick: (event: MouseEvent) => event.stopPropagation(),
}

/** The portrait variant's face: `face`, a 28px portrait, as it is, or in
    an 18px box that shrinks it when `compact`. */
export function portraitFace(compact: boolean, face: ReactNode) {
  if (!compact) return face
  return (
    <span className="inline-flex size-[18px] shrink-0 [&>*]:!size-[18px] [&>*]:!rounded-[4px] [&>*]:!text-[9px]">
      {face}
    </span>
  )
}

/** The owner trigger's props after its variant's, for the owner `shown`:
    its hooks, name, hover text and the press that runs `toggle`. */
export function ownerTrigger(
  issue: IssueVM,
  shown: 'assignee' | 'reviewer',
  canWrite: boolean,
  toggle: (event: MouseEvent<HTMLElement>) => void,
) {
  const name = P.user(issue[shown])?.name || (shown === 'reviewer' ? 'No reviewer' : 'Unassigned')
  return {
    'data-assignee-edit': issue.id,
    'data-owner-field': shown,
    'data-focus-key': 'owner',
    'aria-label': `Change ${shown} for ${issue.title}: ${name}`,
    title: canWrite ? `Change ${shown} · ${name}` : 'Read-only project access',
    disabled: !canWrite,
    draggable: false,
    onDragStart: (event: DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
    },
    onPointerDown: (event: PointerEvent) => event.stopPropagation(),
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation()
      toggle(event)
    },
  }
}

/** AssigneeAvatar's bare portrait of `issue`'s owner in the static scope
    `statics`: the DOM Button, its tooltip and a static Popover render for
    it. A press makes the row live and opens the live portrait's picker. */
export function staticOwnerPortrait(statics: StaticControls, issue: IssueVM, compact = false) {
  const shown = issue.ownerField
  const canWrite = P.canWrite(issue.project)
  const face = portraitFace(compact, avatar(statics, issue[shown], 28))
  if (!canWrite) return face
  const { title, ...trigger } = ownerTrigger(issue, shown, canWrite, (event) =>
    statics.activate(event.currentTarget.parentElement),
  )
  return (
    <span {...OWNER_WRAP}>
      <div data-popover-wrap>
        {hoverTooltip(
          statics,
          title,
          buttonElement({
            type: 'button',
            ...trigger,
            ...POPOVER_CLOSED,
            variant: 'unstyled',
            className: PORTRAIT_CLASS,
            children: face,
          }),
        )}
      </div>
    </span>
  )
}
