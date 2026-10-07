/* Shared UI primitives + icon set. */

import {
  Archive,
  ArrowDown,
  ArrowLeftRight,
  ArrowRight,
  ArrowRightFromLine,
  ArrowRightToLine,
  ArrowUp,
  ArrowUpRight,
  AtSign,
  Ban,
  Bell,
  CalendarDays,
  Camera,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  ChevronUp,
  Circle,
  CircleHelp,
  Clock8,
  ClockFading,
  Columns3,
  Command as CommandIcon,
  Copy,
  Diamond,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Flag,
  GanttChart,
  History,
  Inbox,
  Keyboard,
  Layers,
  Link as LinkIcon,
  List,
  ListFilter,
  type LucideIcon,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Pause,
  PenLine,
  Play,
  Plus,
  RotateCcw,
  Rows2,
  Rows3,
  Search,
  Settings,
  SlidersHorizontal,
  Tag,
  Target,
  Trash2,
  TriangleAlert,
  User,
  Users,
  X,
  Zap,
} from 'lucide-react'
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  cloneElement,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Avatar as UiAvatar } from '@/components/ui/avatar'
import { Badge as UiBadge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { PopoverContent, PopoverTrigger, Popover as ShadcnPopover } from '@/components/ui/popover'
import { Progress as UiProgress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { HoverTooltip, hasOpenTooltip } from '@/components/ui/tooltip'
import { restoreFocus } from '@/lib/focusVisibility'
import { LandscapeContext, type LandscapeViewport } from '@/lib/landscape'
import { useMenuBackLayer } from '@/lib/useMobile'
import { cn } from '@/lib/utils'
import { gravatarUrl } from '../../lib/gravatar'
import { P } from '../../store/planner'

/* ---- Generic chrome icons use lucide; Qivo status/priority glyphs stay below. ---- */
const LUCIDE_ICONS: Record<string, LucideIcon> = {
  search: Search,
  filter: ListFilter,
  plus: Plus,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronRight: ChevronRight,
  chevronLeft: ChevronLeft,
  chevronsDown: ChevronsDown,
  chevronsUp: ChevronsUp,
  board: Columns3,
  timeline: GanttChart,
  people: Users,
  list: List,
  chart: ChartColumn,
  close: X,
  link: LinkIcon,
  parent: ArrowUp,
  child: ArrowDown,
  blocked: Ban,
  pause: Pause,
  play: Play,
  more: MoreHorizontal,
  calendar: CalendarDays,
  check: Check,
  sliders: SlidersHorizontal,
  layers: Layers,
  flag: Flag,
  dot: Circle,
  arrowUpRight: ArrowUpRight,
  externalLink: ExternalLink,
  arrowRight: ArrowRight,
  warning: TriangleAlert,
  user: User,
  zap: Zap,
  trash: Trash2,
  copy: Copy,
  rotateCcw: RotateCcw,
  diamond: Diamond,
  keyboard: Keyboard,
  command: CommandIcon,
  inbox: Inbox,
  archive: Archive,
  mail: Mail,
  bell: Bell,
  tag: Tag,
  paperclip: Paperclip,
  download: Download,
  history: History,
  rows: Rows2,
  rows3: Rows3,
  clock8: Clock8,
  clockFading: ClockFading,
  arrowRightFromLine: ArrowRightFromLine,
  arrowRightToLine: ArrowRightToLine,
  arrowLeftRight: ArrowLeftRight,
  comment: MessageSquare,
  page: FileText,
  pen: PenLine,
  target: Target,
  eye: Eye,
  camera: Camera,
  eyeOff: EyeOff,
  cog: Settings,
  at: AtSign,
}
function Icon({
  name,
  size = 16,
  color = 'currentColor',
  strokeWidth = 1.75,
  style,
  className,
}: {
  name: string
  size?: number
  color?: string
  strokeWidth?: number
  style?: CSSProperties
  className?: string
}) {
  const Glyph = LUCIDE_ICONS[name] ?? CircleHelp
  return (
    <Glyph
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      style={{ width: size, height: size, color, ...style }}
      className={cn('[flex-shrink:0] [display:block]', className)}
      aria-hidden="true"
    />
  )
}

/* The one paused mark: the amber pause glyph, named for readers and drives
   (`[data-paused]`). The Board card, phone task row and Overview list draw it;
   task windows use a labelled edge tab. The Roadmap deliberately draws
   neither (a glyph on the bar would take room the bar cannot spare). */
function PausedMark({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <span
      data-paused
      role="img"
      tabIndex={-1}
      aria-label="Paused"
      className={cn('inline-flex shrink-0', className)}
    >
      <Icon name="pause" size={size} color="var(--warn)" strokeWidth={2} />
    </span>
  )
}

/* ---- Avatars ----------------------------------------------------------
   Three layers, in order of preference, all drawn into the same portrait:
   an uploaded picture, else Gravatar for the person's email address, else the
   initials-on-color chip. The chip is not a placeholder that gets replaced —
   it is always rendered, and the picture is simply painted over it. That is
   what lets the Gravatar request use `d=blank` (an address with no picture
   answers 200 with a transparent PNG, so the initials show through) instead of
   `d=404`, which would log a console error for every person without one. */
/* 20 is the Team sync row's portrait (beside a chevron in a 32px control). */
export type AvatarSize = 20 | 28 | 40

function Avatar({
  id,
  size = 28,
  ring = false,
}: {
  id?: string | null
  size?: AvatarSize
  ring?: boolean
}) {
  const [failed, setFailed] = useState('')
  const u = P.user(id)
  if (!u)
    return (
      <HoverTooltip content="Unassigned">
        <UiAvatar
          tabIndex={-1}
          role="img"
          aria-label="Unassigned"
          style={{ width: size, height: size }}
          className="grid place-items-center rounded-[5px] border border-dashed border-border-strong bg-surface-3"
        >
          <Icon name="user" size={size * 0.55} color="var(--text-3)" />
        </UiAvatar>
      </HoverTooltip>
    )
  // an upload wins — and it wins from the moment we know it EXISTS, not from
  // the moment its signed URL arrives (0097). Falling through to Gravatar in
  // that gap would flash somebody's other face and then replace it.
  const src = u.avatarPath ? u.avatarUrl : P.org.gravatarAvatars ? gravatarUrl(u.email, size) : null
  // The two larger portraits share one readable fallback type step; the
  // 20px row portrait steps its initials down so two letters still fit.
  return (
    <HoverTooltip content={u.name}>
      <UiAvatar
        tabIndex={-1}
        data-avatar={u.id}
        role="img"
        aria-label={u.name}
        style={{
          width: size,
          height: size,
          background: u.color,
          boxShadow: ring ? '0 0 0 2px var(--surface-1)' : 'none',
        }}
        className={cn(
          'grid place-items-center rounded-[5px] font-semibold text-white',
          size === 20 ? 'rounded-[4px] text-[10px]' : '[font-size:var(--fs-sm)]',
        )}
      >
        {u.initials}
        {src && failed !== src && (
          // no-referrer so the page a face is drawn on never reaches the host
          <img
            data-avatar-img
            src={src}
            alt=""
            referrerPolicy="no-referrer"
            onError={() => setFailed(src)}
            className="[position:absolute] [inset:0] [width:100%] [height:100%] [object-fit:cover] [display:block] [border-radius:inherit]"
          />
        )}
      </UiAvatar>
    </HoverTooltip>
  )
}
function AvatarStack({ ids, size = 28 }: { ids: string[]; size?: AvatarSize }) {
  return (
    <div className="[display:flex]">
      {ids.map((id, i) => (
        <div key={id} style={{ marginLeft: i ? -size * 0.3 : 0, zIndex: ids.length - i }}>
          <Avatar id={id} size={size} ring />
        </div>
      ))}
    </div>
  )
}

/* ---- Issue meta glyphs ------------------------------------------------ */
/* Rank is carried TWICE by shape: the glyph fills one, two or three bars, and
   the colour steps up in lightness with it (--prio-low = --text-3, --prio-medium
   = --text-2, --prio-high = --text-1). Only `urgent` spends a hue — it is the
   one level that leaves the lightness ramp, and it drops the bars for a filled
   chip so it is still legible where colour isn't. The colours arrive as
   p.color from the store, already tokens. */
function PriorityIcon({ priority, size = 14 }: { priority: string; size?: number }) {
  const p = P.PRIORITIES[priority]
  if (!p) return null
  if (priority === 'urgent') {
    return (
      /* The chip scales with `size`, so its radius and its glyph are derived
         from it rather than tokenised — but both are ROUNDED, or a 13px chip
         asks for 2.86px of radius and 10.14px of text. Fractional type is the
         one thing the scale exists to stop; proportion survives the rounding. */
      <HoverTooltip content="Urgent priority">
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
        </span>
      </HoverTooltip>
    )
  }
  const filled = priority === 'high' ? 3 : priority === 'medium' ? 2 : 1
  const heights = [0.42, 0.7, 1]
  return (
    <HoverTooltip content={`${p.name} priority`}>
      <span
        tabIndex={-1}
        role="img"
        aria-label={`${p.name} priority`}
        style={{ gap: size * 0.14, height: size, width: size }}
        className="[display:inline-flex] [align-items:flex-end] [flex-shrink:0]"
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              height: heights[i] * size,
              background: i < filled ? p.color : 'var(--border-strong)',
            }}
            className="[flex:1] [border-radius:var(--r-2xs)]"
          />
        ))}
      </span>
    </HoverTooltip>
  )
}
/* Linear-style status glyphs, colored by the status tone: dashed ring =
   backlog, empty ring = todo, ring + pie fill = in progress / in review,
   filled circle with check = done. Unknown statuses fall back to a grey ring. */
function StatusDot({ status, size = 14 }: { status: string; size?: number }) {
  const s = P.statusOf(status)
  const tone = s ? s.tone : 'var(--text-3)'
  const id = s ? s.id : ''
  const pie = id === 'progress' ? 0.4 : id === 'review' ? 0.7 : 0
  const pieR = 1.65 // stroke-width 2r paints a disc; dasharray carves the wedge
  return (
    <HoverTooltip content={s ? s.name : status}>
      <span
        tabIndex={-1}
        role="img"
        aria-label={s ? s.name : status}
        className="[display:inline-flex] [flex-shrink:0]"
      >
        <svg
          width={size}
          height={size}
          viewBox="0 0 14 14"
          className="[display:block]"
          aria-hidden="true"
        >
          {id === 'done' ? (
            <>
              <circle cx="7" cy="7" r="6" fill={tone} />
              <path
                d="M4.4 7.3 6.2 9.1 9.8 5.3"
                fill="none"
                stroke="#fff"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          ) : (
            <>
              {/* 2.4 + 1.85 divides the r=5.4 circumference into 8 whole dashes */}
              <circle
                cx="7"
                cy="7"
                r="5.4"
                fill="none"
                stroke={tone}
                strokeWidth="1.5"
                strokeDasharray={id === 'backlog' ? '2.4 1.85' : undefined}
              />
              {pie > 0 && (
                <circle
                  cx="7"
                  cy="7"
                  r={pieR}
                  fill="none"
                  stroke={tone}
                  strokeWidth={pieR * 2}
                  strokeDasharray={`${pie * 2 * Math.PI * pieR} ${2 * Math.PI * pieR}`}
                  transform="rotate(-90 7 7)"
                />
              )}
            </>
          )}
        </svg>
      </span>
    </HoverTooltip>
  )
}

/* ---- Small atoms ------------------------------------------------------ */
function Chip({
  children,
  color,
  tone = 'soft',
  style,
  className,
}: {
  children?: ReactNode
  color?: string
  tone?: 'soft' | 'solid'
  style?: CSSProperties
  className?: string
}) {
  const base =
    tone === 'solid'
      ? { background: color, color: '#fff', borderColor: 'transparent' }
      : {
          background: color ? `color-mix(in oklab, ${color} 10%, transparent)` : 'var(--surface-3)',
          color: color || 'var(--text-1)',
          borderColor: color ? `color-mix(in oklab, ${color} 20%, transparent)` : 'var(--border)',
        }
  return (
    <UiBadge
      variant="outline"
      style={{ ...base, ...style }}
      className={cn(
        '[display:inline-flex] [align-items:center] [gap:5px] [height:20px] [padding:0_7px] [border-radius:var(--r-sm)] [font-size:var(--fs-xs)] [font-weight:600] [border:1px_solid] [white-space:nowrap]',
        className,
      )}
    >
      {children}
    </UiBadge>
  )
}
/* `--r-pill`, not `borderRadius: height`. Both draw the same fully-rounded bar,
   but the arithmetic version emitted whatever the caller's height happened to
   be — 4px and 5px and 6px radii that belong to no step of the scale. The
   width transition stays a width: this is the one place a length IS the thing
   being animated, and scaleX would smear the rounded caps. */
function ProgressBar({
  value,
  color = 'var(--primary)',
  height = 5,
}: {
  value: number
  color?: string
  height?: number
}) {
  return (
    <UiProgress
      value={Math.max(0, Math.min(100, value))}
      aria-label={`${Math.round(value)}% complete`}
      style={{ height }}
      indicatorStyle={{ background: color }}
      className="w-full rounded-pill bg-surface-3"
      indicatorClassName="rounded-pill transition-transform duration-200"
    />
  )
}
function IssueKey({ id, dim }: { id: string; dim?: boolean }) {
  return (
    <span className={cn('!font-mono text-sm font-medium', dim ? 'text-text-2' : 'text-text-1')}>
      {id}
    </span>
  )
}
function Kbd({ children }: { children?: ReactNode }) {
  return (
    <span className="!font-mono [font-size:var(--fs-xs)] [background:var(--surface-3)] [border:1px_solid_var(--border)] [color:var(--text-3)] [padding:1px_5px] [border-radius:var(--r-sm)] [line-height:1.4]">
      {children}
    </span>
  )
}

/* Button-anchored portal with a transparent backdrop. It consumes outside
   clicks and the first Escape so dismissal cannot also close a parent modal.
   Portaling avoids transformed/scrolling ancestors; the backdrop stops wheel
   scrolling and resize closes the menu to preserve trigger alignment.
   wrapStyle controls the measured trigger box; flex rows may need display:flex
   and flexShrink:0. With backLayer, close(then) waits for the phone Back entry
   to close before a callback changes the page. */
type PopoverProps = {
  button: (toggle: () => void, open: boolean) => ReactNode
  children: (close: (then?: () => void) => void) => ReactNode
  width?: number
  align?: 'left' | 'right'
  wrapStyle?: CSSProperties
  backLayer?: boolean
}

function landscapeBottomAnchor(
  rect: DOMRect,
  landscape: LandscapeViewport,
  align: 'left' | 'center' | 'right' = 'center',
) {
  const bottom = [
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.top },
    { x: rect.left, y: rect.bottom },
    { x: rect.right, y: rect.bottom },
  ]
    .map((point) => ({ ...point, local: landscape.toLocal(point.x, point.y) }))
    .sort((a, b) => b.local.y - a.local.y)
    .slice(0, 2)
    .sort((a, b) => a.local.x - b.local.x)
  if (align === 'center')
    return { x: (bottom[0].x + bottom[1].x) / 2, y: (bottom[0].y + bottom[1].y) / 2 }
  return { x: bottom[align === 'left' ? 0 : 1].x, y: bottom[align === 'left' ? 0 : 1].y }
}

function LandscapePopover({
  button,
  children,
  width = 220,
  align = 'left',
  wrapStyle,
}: PopoverProps) {
  const landscape = useContext(LandscapeContext)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const triggerElement = () =>
    wrapRef.current?.querySelector<HTMLElement>('button, [role="button"]')
  const close = (then?: () => void) => {
    setAnchor(null)
    triggerElement()?.focus({ preventScroll: true })
    then?.()
  }
  const toggle = () => {
    if (anchor) return close()
    const trigger = triggerElement() || wrapRef.current
    if (!trigger || !landscape) return
    const rect = trigger.getBoundingClientRect()
    // Choose the physical corner corresponding to the logical bottom edge.
    // This works for either rotation direction and for the unrotated frame.
    setAnchor(landscapeBottomAnchor(rect, landscape, align))
  }
  useLayoutEffect(() => {
    if (!anchor || !contentRef.current || contentRef.current.contains(document.activeElement))
      return
    const target = contentRef.current.querySelector<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]',
    )
    target?.focus({ preventScroll: true })
  }, [anchor, landscape?.host])
  const trigger = button(toggle, !!anchor)
  const triggerId = isValidElement(trigger)
    ? (trigger.props as { id?: string }).id || `${id}-trigger`
    : `${id}-trigger`
  return (
    <div ref={wrapRef} style={wrapStyle}>
      {isValidElement(trigger)
        ? cloneElement(trigger as ReactElement<Record<string, unknown>>, {
            id: triggerId,
            'aria-expanded': !!anchor,
            'aria-haspopup': 'dialog',
            'aria-controls': anchor ? id : undefined,
          })
        : trigger}
      {anchor && (
        <AnchoredPop
          x={anchor.x}
          y={anchor.y}
          width={width}
          align={align}
          gap={6}
          onClose={() => close()}
        >
          <div ref={contentRef} id={id} role="dialog" aria-labelledby={triggerId} className="p-1">
            {children(close)}
          </div>
        </AnchoredPop>
      )}
    </div>
  )
}

function Popover({
  button,
  children,
  width = 220,
  align = 'left',
  wrapStyle,
  backLayer = false,
}: PopoverProps) {
  const [open, setOpen] = useState(false)
  const close = useMenuBackLayer(open, () => setOpen(false), backLayer)
  const landscape = useContext(LandscapeContext)
  if (landscape)
    return (
      <LandscapePopover button={button} width={width} align={align} wrapStyle={wrapStyle}>
        {children}
      </LandscapePopover>
    )
  return (
    <ShadcnPopover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <div style={wrapStyle}>
        <PopoverTrigger asChild>{button(() => undefined, open)}</PopoverTrigger>
      </div>
      <PopoverContent
        align={align === 'right' ? 'end' : 'start'}
        sideOffset={6}
        className="z-[120] rounded-lg p-1 shadow-pop"
        style={{ width }}
      >
        {children(close)}
      </PopoverContent>
    </ShadcnPopover>
  )
}
/* `...rest` reaches the button so a call site can hang its own data-hook on a
   menu row — an action that moved INTO a menu keeps the selector it had when
   it was a button in the page. */
/* `disabled` keeps a readable supporting tone and stops the row hovering,
   rather than dropping it: a menu that changes length depending on state is
   a menu you have to re-read, and a missing row cannot tell you why. */
function MenuItem({
  active,
  danger,
  disabled,
  onClick,
  children,
  title,
  ...rest
}: ComponentPropsWithoutRef<'button'> & {
  active?: boolean
  danger?: boolean
  // call sites hang data-hooks on menu rows (see the comment above)
  [key: `data-${string}`]: unknown
}) {
  return (
    <Button
      {...rest}
      type="button"
      variant="ghost"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={cn(
        'h-auto min-h-8 w-full justify-start gap-2 px-2 py-1 text-left text-base text-text-1 has-[[data-slot=avatar]]:py-2',
        active && 'bg-primary-soft font-semibold hover:bg-primary-soft',
        danger && 'text-danger hover:bg-danger-soft hover:text-danger',
        disabled && 'cursor-default disabled:opacity-100',
        disabled && !danger && 'text-text-2',
      )}
    >
      {children}
    </Button>
  )
}
function MenuDivider() {
  return <Separator className="mx-1 my-1 w-auto" />
}

/* ---- Unread mark ------------------------------------------------------
   Where the part of a conversation you haven't read begins — drawn in the
   task window's spine and in the inbox thread, from the one thing the app
   calls unread (messages.read_at), so it can never disagree with the sidebar
   badge or the row dot.

   Yes, this is a rule inside a window deviation #65 took the rules out of —
   and it stays. #65 removed rules that were decorative: hairlines separating
   zones the 20 px padding already parted. This one carries information. It
   names a position in time, and spacing cannot say that. It is --primary, not
   --border, precisely so it doesn't read as chrome coming back.

   `tail` is the case where nothing rendered sits at or after the mark (an
   unread status change while the Comments filter hides events, an unread
   comment since deleted). A rule at the bottom with nothing under it would
   lie about where the new part starts, so the caller supplies a sentence. */
function UnreadDivider({ place = 'mark', note }: { place?: 'mark' | 'tail'; note?: ReactNode }) {
  if (place === 'tail') {
    return (
      <div
        data-unread-divider="tail"
        className="[font-size:var(--fs-sm)] [color:var(--text-2)] [padding:2px_0]"
      >
        {note}
      </div>
    )
  }
  return (
    <div data-unread-divider="mark" className="[display:flex] [align-items:center] [gap:8px]">
      <span className="[font-size:var(--fs-sm)] [font-weight:600] [color:var(--text-1)]">New</span>
      <span className="[flex:1] [height:2px] [background:var(--primary)] [opacity:0.45]" />
    </div>
  )
}

/* Keep a scroller pinned to its bottom whenever `key` changes — the working
   end of a chat-ordered thread. Shared by the inbox thread and the task
   window's spine so the claim "they read the same" is true in code rather
   than by convention; two copies of this would drift.
   A null key means there is nothing to snap to (the task window stays mounted
   with no task open). */
function useBottomSnap(ref: RefObject<HTMLElement>, key: string | null) {
  useEffect(() => {
    const el = ref.current
    if (!el || key === null) return
    el.scrollTop = el.scrollHeight
    // inline images load after the snap and grow the content below the
    // viewport — chase them (img load doesn't bubble; capture catches it)
    // for a few seconds, then leave the user's scroll alone
    let chasing = true
    const onLoad = () => {
      if (chasing) el.scrollTop = el.scrollHeight
    }
    el.addEventListener('load', onLoad, true)
    const t = setTimeout(() => {
      chasing = false
      el.removeEventListener('load', onLoad, true)
    }, 4000)
    return () => {
      clearTimeout(t)
      el.removeEventListener('load', onLoad, true)
    }
  }, [key]) // eslint-disable-line
}

/* Radix select supports glyphs, keyboard navigation and focus restoration.
   Its body portal avoids clipping; outside clicks and first Escape dismiss
   only the menu, preserving a parent task modal and its draft.
   menuWidth is a minimum; the menu respects trigger width and available height.
   An action row invokes onSelect without changing the selected value; trailing
   content belongs only to the closed trigger. backLayer gives the menu a phone
   Back entry and waits for it to close before applying a pick. */
const ACTION_VALUE = '\0action' // no option id can collide with it
function FieldSelect<T extends string>({
  value,
  options,
  onChange,
  action,
  trailing,
  placeholder = 'Select…',
  menuWidth = 200,
  style,
  className,
  disabled = false,
  title,
  'aria-label': ariaLabel,
  backLayer = false,
}: {
  // generic like Seg's: `value` alone names T, so a literal-union state
  // setter passes straight through while options keep their plain-string ids
  value?: T | null
  options: { value: string; label: string; icon?: ReactNode }[]
  onChange: (value: T) => void
  action?: { label: string; icon?: ReactNode; onSelect: () => void }
  trailing?: ReactNode
  placeholder?: string
  menuWidth?: number
  style?: CSSProperties
  className?: string
  disabled?: boolean
  title?: string
  'aria-label'?: string
  backLayer?: boolean
}) {
  const [open, setOpen] = useState(false)
  const close = useMenuBackLayer(open, () => setOpen(false), backLayer)
  // a menu pick arrives just before the menu's own close, which carries it
  const pick = useRef<(() => void) | null>(null)
  return (
    <Select
      value={value ?? undefined}
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        if (next) return setOpen(true)
        const then = pick.current
        pick.current = null
        close(then ?? undefined)
      }}
      onValueChange={(next) => {
        const apply = () => {
          if (next === ACTION_VALUE) action?.onSelect()
          else if (next !== value) onChange(next as T)
        }
        if (open) pick.current = apply
        else apply()
      }}
    >
      <SelectTrigger
        data-fieldselect
        title={title}
        aria-label={ariaLabel}
        className={cn(
          'h-control max-w-full gap-2 bg-surface-1 px-2 text-base text-text-1 has-[[data-slot=avatar]]:h-auto has-[[data-slot=avatar]]:min-h-[46px] has-[[data-slot=avatar]]:py-2',
          className,
        )}
        style={style}
      >
        <SelectValue placeholder={placeholder} />
        {/* mr-auto hugs the glyph to the label: the trigger justifies its
            children between its ends, and the chevron keeps the far one */}
        {trailing && <span className="mr-auto flex items-center">{trailing}</span>}
      </SelectTrigger>
      <SelectContent
        data-fieldselect-menu
        position="popper"
        align="start"
        className="z-[120] rounded-lg shadow-pop"
        style={{ minWidth: menuWidth }}
        // Radix restores the trigger. Shared modality styles keep pointer
        // picks quiet while preserving real focus and the next Tab stop.
      >
        {options.map((o) => (
          <SelectItem
            key={String(o.value)}
            value={String(o.value)}
            className="text-base text-text-1 data-[state=checked]:font-semibold"
          >
            {o.icon}
            <span className="truncate">{o.label}</span>
          </SelectItem>
        ))}
        {action && (
          <>
            <SelectSeparator />
            <SelectItem value={ACTION_VALUE} className="text-base text-text-1">
              {action.icon}
              <span className="truncate">{action.label}</span>
            </SelectItem>
          </>
        )}
      </SelectContent>
    </Select>
  )
}

/* ---- Anchored pop (fixed, opens at a point; used by grid cells) -------- */
// open AnchoredPops, outermost first — Escape belongs to the TOPMOST pop
// only. Capture listeners on window fire in registration order, so without
// the stack an OUTER pop (the roadmap's WinPicker) would consume Escape and
// unmount the calendar nested inside it. ModalShell also yields Escape while
// any pop is open (via the [data-anchoredpop-backdrop] probe).
const popStack: object[] = []

function AnchoredPop({
  x,
  y,
  width = 300,
  align = 'center',
  gap = 10,
  onClose,
  stayOnScroll = false,
  children,
}: {
  x: number
  y: number
  width?: number
  align?: 'left' | 'center' | 'right'
  gap?: number
  onClose: () => void
  stayOnScroll?: boolean
  children?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const landscape = useContext(LandscapeContext)
  const viewportWidth = landscape?.width ?? window.innerWidth
  const viewportHeight = landscape?.height ?? window.innerHeight
  const popupWidth = landscape ? Math.min(width, Math.max(0, viewportWidth - 20)) : width
  const anchor = landscape ? landscape.toLocal(x, y) : { x, y }
  // No hidden-until-measured state: the pop must be focusable while mount
  // effects run (autoFocus and friends fire before the reposition flushes),
  // and the layout effect below corrects the position before first paint.
  const clampLeft = (vx: number) =>
    Math.min(
      Math.max(10, vx - (align === 'left' ? 0 : align === 'right' ? popupWidth : popupWidth / 2)),
      viewportWidth - popupWidth - 10,
    )
  const [pos, setPos] = useState({ left: clampLeft(anchor.x), top: Math.max(10, anchor.y + gap) })
  // reposition reads x/y from the latest render; the ResizeObserver below
  // outlives any single render, so it calls through a ref
  const repositionRef = useRef<(() => void) | null>(null)
  repositionRef.current = () => {
    const el = ref.current
    if (!el) return
    const height = landscape ? el.offsetHeight : el.getBoundingClientRect().height
    let top = anchor.y + gap
    if (top + height > viewportHeight - 10) top = anchor.y - height - gap
    setPos({ left: clampLeft(anchor.x), top: Math.max(10, top) })
  }
  useLayoutEffect(() => {
    repositionRef.current()
  }, [anchor.x, anchor.y, popupWidth, viewportWidth, viewportHeight, align, gap, landscape?.host])
  useEffect(() => {
    // content can grow after open (the calendar's 4→6-row months, WinPicker's
    // tab switch) — anything past the viewport bottom would be unreachable,
    // since the pop is fixed and page scrolling closes it
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => repositionRef.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [landscape?.host])
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const entry = {}
    popStack.push(entry)
    // Outside mousedowns land on the backdrop below, which consumes them —
    // no document-level listener, so the dismissing click can't also hit
    // whatever sits underneath (the issue modal's scrim in particular).
    const k = (e) => {
      if (e.key !== 'Escape' || hasOpenTooltip()) return
      if (popStack[popStack.length - 1] !== entry) return // a pop stacked on top owns Escape
      e.stopImmediatePropagation()
      closeRef.current()
    }
    // The anchor is a one-shot snapshot: close rather than drift when the page
    // scrolls or resizes under the pop (scrolls inside the pop don't count).
    // The backdrop parks wheel scrolling, but keyboard focus can Tab past it
    // and scroll a pane underneath, so the listener stays as the safety net.
    // stayOnScroll opts out for pops whose anchor sits in non-scrolling chrome
    // — their own layout changes may clamp a pane's scrollLeft mid-use.
    const s = (e) => {
      if (
        !stayOnScroll &&
        ref.current &&
        e.target instanceof Node &&
        !ref.current.contains(e.target)
      )
        closeRef.current()
    }
    const rz = () => closeRef.current()
    window.addEventListener('keydown', k, true)
    window.addEventListener('scroll', s, true)
    window.addEventListener('resize', rz)
    return () => {
      popStack.splice(popStack.indexOf(entry), 1)
      window.removeEventListener('keydown', k, true)
      window.removeEventListener('scroll', s, true)
      window.removeEventListener('resize', rz)
    }
  }, [stayOnScroll])
  useEffect(() => {
    // Wheel over the pop's non-scrollable chrome must not scroll the page
    // underneath (Chromium scrolls the scroller under the point regardless of
    // DOM ancestry) — that scroll would trip the close-on-scroll handler
    // above. Let inner scrollables consume the delta; block everything else.
    // Native listener because React's onWheel is passive (can't preventDefault).
    const el = ref.current
    if (!el) return
    const w = (e) => {
      let n = e.target as HTMLElement | null
      while (n && (n !== el || landscape)) {
        if (n.scrollHeight > n.clientHeight + 1) {
          if (
            (e.deltaY < 0 && n.scrollTop > 0) ||
            (e.deltaY > 0 && n.scrollTop + n.clientHeight < n.scrollHeight - 1)
          )
            return
        }
        if (n === el) break
        n = n.parentElement
      }
      e.preventDefault()
    }
    el.addEventListener('wheel', w, { passive: false })
    return () => el.removeEventListener('wheel', w)
  }, [landscape?.host])
  // Portaled to <body>: with a scrollable DOM ancestor, wheel events over the
  // pop's non-scrollable chrome would chain to that ancestor, and the scroll
  // handler above would close the pop mid-use. body is overflow:hidden, so the
  // chain dies there (this also keeps transformed ancestors from hijacking the
  // fixed positioning). The transparent backdrop makes the dismissing click
  // land nowhere else (FieldSelect's pattern) — clicking the issue modal's
  // scrim to dismiss a picker must not also close the modal.
  if (landscape && !landscape.host) return null
  return createPortal(
    <>
      {/* z 110/111: above ModalShell (100) — the calendar opens from fields
          inside the new-issue/milestone modals — below palette (120)/toasts (130).
          pointer-events-auto on both, in every case: a Radix modal dialog
          (ModalShell) turns pointer events OFF on <body> while it is open, and
          a portal to <body> inherits that — the calendar painted above the
          dialog and took no clicks (deviation #239). The dialog stays open
          when the backdrop is pressed: this portal is inside its React tree,
          so Radix counts the press as inside. */}
      <div
        data-anchoredpop-backdrop
        onMouseDown={(e) => {
          e.preventDefault()
          onClose()
        }}
        onClick={(e) => e.stopPropagation()}
        className={cn('inset-0 z-[110] pointer-events-auto', landscape ? 'absolute' : 'fixed')}
      />
      <div
        ref={ref}
        data-floating-surface
        className={cn(
          'animate-in fade-in zoom-in-95 pointer-events-auto [z-index:111] [background:var(--popover)] [border:1px_solid_var(--border)] [border-radius:var(--r-lg)] [box-shadow:var(--qivo-shadow-pop)]',
          landscape ? 'absolute overflow-y-auto overscroll-contain' : 'fixed',
        )}
        style={{
          left: pos.left,
          top: pos.top,
          width: popupWidth,
          maxHeight: landscape ? Math.max(0, viewportHeight - 20) : undefined,
        }}
      >
        {children}
      </div>
    </>,
    landscape?.host || document.body,
  )
}

/* ---- Segmented control -------------------------------------------------- */
/* `ground` selects the surrounding surface: ordinary controls use
   --background, while controls inside raised popovers use --surface-3.
   Themes choose the fills; in Dark, Light and Blue --surface-3 is a
   translucent ink, so a raised well tints whatever popover it sits in. */
/* Generic over the value string (inferred from `value`) so a caller whose
   state is a literal union can pass its setter straight through; the store's
   option ids are plain strings, so the one cast at the onClick is the seam. */
/* `height` (24px by default) is only the fallback of `--seg-height`: each tab
   is `var(--seg-height, <height>)`, so a surrounding well can name the tab
   height from its stylesheet — the view-switch well makes it its page
   heading's 32px (appearance.css, deviation #232). */
/* Three option extras serve the top bar's switch: `badge` is drawn on the
   icon's corner (the caller styles and positions it, relative to the 16px
   icon), `divider` stands a vertical rule after the option, splitting the
   switch into groups, and `ariaLabel` names an icon-only option without the
   hover tooltip `title` would open. */
function Seg<T extends string>({
  value,
  options,
  onChange,
  height = 24,
  ground = 'page',
  fit = true,
}: {
  value: T
  options: {
    value: string
    label?: ReactNode
    icon?: string
    title?: string
    badge?: ReactNode
    divider?: boolean
    ariaLabel?: string
  }[]
  onChange: (value: T) => void
  height?: string | number
  ground?: 'page' | 'raised'
  fit?: boolean
}) {
  const page = ground === 'page'
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next as T)
      }}
      spacing={3}
      className={cn(
        'shrink-0 flex-wrap gap-[3px] rounded-md border p-[3px]',
        fit ? 'w-fit' : 'w-auto',
        page ? 'border-border bg-background' : 'border-transparent bg-surface-3',
      )}
    >
      {/* `o.title` is optional, and most callers want none: an option whose
          label already names the thing needs no tooltip. One standing for a
          whole destination does — the view switcher's "Board" is "Board view" —
          and that tooltip is also the only text an icon-led option carries. */}
      {options.map((o) => (
        <Fragment key={o.value}>
          <HoverTooltip content={o.title}>
            <ToggleGroupItem
              aria-label={o.ariaLabel ?? (o.label ? undefined : o.title)}
              value={o.value}
              className={cn(
                // the lit slab is the shared toggle on-state (deviation #232);
                // on a raised well — itself --surface-3 — it is --surface-1 so
                // it still stands apart from its ground
                'h-auto gap-2 rounded-sm px-2.5 text-sm text-text-2 [&_svg]:!size-4',
                !page && 'data-[state=on]:bg-surface-1 data-[state=on]:hover:bg-surface-1',
                !fit && 'flex-1',
              )}
              style={{
                height: `var(--seg-height, ${typeof height === 'number' ? `${height}px` : height})`,
              }}
            >
              {o.icon &&
                (o.badge ? (
                  <span className="relative inline-flex">
                    <Icon name={o.icon} size={16} />
                    {o.badge}
                  </span>
                ) : (
                  <Icon name={o.icon} size={16} />
                ))}
              {o.label}
            </ToggleGroupItem>
          </HoverTooltip>
          {o.divider && (
            <span aria-hidden="true" className="h-5 w-px shrink-0 self-center bg-border-strong" />
          )}
        </Fragment>
      ))}
    </ToggleGroup>
  )
}

/* ---- Date controls --------------------------------------------------------
   The visible face is drawn in the organization's date format, and the
   calendar popup is our own: its columns start on the org's first workday
   ("Workdays start on") and its gutter shows the org's calendar week
   numbers. A native date input can do neither — its popup grid is locked
   to the browser locale — so the native control is gone entirely. */

function CalendarPop({
  x,
  y,
  value,
  contentRef,
  onPick,
  onClear,
  onClose,
}: {
  x: number
  y: number
  value?: string | null
  contentRef: RefObject<HTMLDivElement | null>
  onPick: (iso: string) => void
  onClear?: () => void
  onClose: () => void
}) {
  const [view, setView] = useState(() => {
    const d = value ? P.isoToDate(value) : new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const ws = P.org.weekStart ?? 1 // JS getDay numbering — the org's first workday
  // Read the clock when rendering the picker, including immediately after resume.
  const todayIso = P.isoFromDate(new Date())
  // rows of 7 days from the week containing the 1st through the week
  // containing the last day of the viewed month (4–6 rows). Compared as
  // calendar days, not epoch ms: in zones whose DST skips midnight (Havana,
  // Santiago) setDate lands on 01:00 and an exact getTime comparison would
  // drop the final row when the month ends on a week-start day.
  const lastIso = P.isoFromDate(new Date(view.getFullYear(), view.getMonth() + 1, 0))
  const rows = []
  {
    const cur = P.weekStartOf(view)
    while (P.isoFromDate(cur) <= lastIso) {
      const row = []
      for (let i = 0; i < 7; i++) {
        row.push(new Date(cur))
        cur.setDate(cur.getDate() + 1)
      }
      rows.push(row)
    }
  }
  const cell = (d) => {
    const iso = P.isoFromDate(d)
    const isSel = value === iso
    const isToday = iso === todayIso
    const inMonth = d.getMonth() === view.getMonth()
    return (
      <Button
        key={iso}
        type="button"
        data-cal-day={iso}
        title={P.fmtFull(d)}
        onClick={() => onPick(iso)}
        onMouseEnter={(e) => {
          if (!isSel) e.currentTarget.style.background = 'var(--hover)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = isSel ? 'var(--primary)' : 'transparent'
        }}
        style={{
          border: `1px solid ${isToday && !isSel ? 'var(--primary)' : 'transparent'}`,
          background: isSel ? 'var(--primary)' : 'transparent',
          color: isSel ? '#fff' : inMonth ? 'var(--text-1)' : 'var(--text-3)',
        }}
        className="grid size-control place-items-center rounded-sm p-0 text-sm font-mono cursor-pointer"
        variant="unstyled"
      >
        {d.getDate()}
      </Button>
    )
  }
  return (
    <AnchoredPop x={x} y={y} width={280} onClose={onClose}>
      <div ref={contentRef} data-calendar className="p-2 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-control-sm h-control-sm"
            title="Previous month"
            aria-label="Previous month"
            onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() - 1, 1))}
          >
            <Icon name="chevronLeft" size={16} />
          </Button>
          <div className="[flex:1] [text-align:center] [font-size:var(--fs-base)] [font-weight:600]">
            {P.MONTHS[view.getMonth()]} {view.getFullYear()}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="w-control-sm h-control-sm"
            title="Next month"
            aria-label="Next month"
            onClick={() => setView((v) => new Date(v.getFullYear(), v.getMonth() + 1, 1))}
          >
            <Icon name="chevronRight" size={16} />
          </Button>
        </div>
        <div className="grid grid-cols-[24px_repeat(7,32px)] gap-px justify-center items-center">
          <span />
          {Array.from({ length: 7 }).map((_, i) => (
            <span
              key={P.WEEKDAYS[(ws + i) % 7]}
              className="[text-align:center] [font-size:var(--fs-xs)] [font-weight:600] [color:var(--text-1)]"
            >
              {P.WEEKDAYS[(ws + i) % 7].slice(0, 2)}
            </span>
          ))}
          {rows.map((row) => {
            const wk = P.weekNumberOf(P.isoToWeek(P.isoFromDate(row[0])))
            return [
              <HoverTooltip key={`w${wk.year}-${wk.num}`} content={`Week ${wk.num} of ${wk.year}`}>
                <span className="[text-align:center] [font-size:var(--fs-xs)] !font-mono [color:var(--text-2)] [cursor:default]">
                  {wk.num}
                </span>
              </HoverTooltip>,
              ...row.map(cell),
            ]
          })}
        </div>
        <div className="flex justify-between border-t border-border pt-2">
          <Button
            type="button"
            variant="ghost"
            className="h-control-sm [font-size:var(--fs-sm)]"
            onClick={() => onPick(todayIso)}
          >
            Today
          </Button>
          {onClear && (
            <Button
              type="button"
              variant="ghost"
              className="h-control-sm [font-size:var(--fs-sm)] [color:var(--text-1)]"
              onClick={onClear}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
    </AnchoredPop>
  )
}

/* the clickable face both date controls share */
function DateCtl({
  display,
  value,
  onPick,
  onClear,
  style,
  disabled = false,
  title,
  className,
}: {
  display: string
  value?: string | null
  onPick: (iso: string) => void
  onClear?: () => void
  style?: CSSProperties
  disabled?: boolean
  title?: string
  className?: string
}) {
  const [pop, setPop] = useState(null)
  const landscape = useContext(LandscapeContext)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const calendarRef = useRef<HTMLDivElement>(null)
  const close = () => {
    const active = document.activeElement
    // Tab can move into the underlying form and scroll its pane, which closes
    // the calendar. Keep that new focus instead of pulling it back here.
    const ownsFocus =
      active === document.body ||
      active === triggerRef.current ||
      calendarRef.current?.contains(active)
    setPop(null)
    if (ownsFocus) restoreFocus(triggerRef.current)
  }
  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        // a select-look field: lit while focused or while its calendar is open
        // (tokens.css's field rule keys on data-field-trigger + aria-expanded)
        data-field-trigger
        aria-haspopup="dialog"
        aria-expanded={!!pop}
        className={cn(
          'datectl inline-flex items-center gap-2 h-control px-2.5 bg-surface-1 border border-border rounded-sm text-text-1 text-sm font-mono whitespace-nowrap cursor-pointer disabled:cursor-default disabled:opacity-100',
          className,
        )}
        disabled={disabled}
        title={title}
        onClick={(e) => {
          if (disabled) return
          const r = e.currentTarget.getBoundingClientRect()
          setPop(
            landscape
              ? landscapeBottomAnchor(r, landscape)
              : { x: r.left + r.width / 2, y: r.bottom - 4 },
          )
        }}
        style={style}
        variant="unstyled"
      >
        <span className={cn('flex-1 text-left', display ? 'text-inherit' : 'text-text-2')}>
          {display || (P.org.dateFormat || 'YYYY-MM-DD').toLowerCase()}
        </span>
        <Icon name="calendar" size={16} color="var(--text-3)" />
      </Button>
      {pop && (
        <CalendarPop
          x={pop.x}
          y={pop.y}
          value={value}
          contentRef={calendarRef}
          onClose={close}
          onPick={(iso) => {
            close()
            onPick(iso)
          }}
          onClear={
            onClear
              ? () => {
                  close()
                  onClear()
                }
              : undefined
          }
        />
      )}
    </>
  )
}

/* ---- Date select (value/onChange use a week index) ------------------------ */
function DateSelect({
  value,
  onChange,
  clearable = false,
  style,
  disabled = false,
  title,
  className,
}: {
  value?: number | null
  onChange: (week: number | null) => void
  clearable?: boolean
  style?: CSSProperties
  disabled?: boolean
  title?: string
  className?: string
}) {
  // picks round to the NEAREST week-grid start; unclamped — weeks are
  // unbounded. clearable → onChange(null): the way back to "unscheduled"
  // (the new-issue modal and the drawer's Plan pickers both use it)
  return (
    <DateCtl
      style={style}
      disabled={disabled}
      title={title}
      className={className}
      display={value == null ? '' : P.fmtFull(P.weekToDate(value))}
      value={value == null ? null : P.isoFromDate(P.weekToDate(value))}
      onPick={(iso) => onChange(P.nearestWeek(iso))}
      onClear={clearable && value != null ? () => onChange(null) : undefined}
    />
  )
}

/* ---- Due-date input (value is an ISO date string) -------------------------- */
function DateInput({
  value,
  onChange,
  clearable = true,
  style,
  disabled = false,
  title,
  className,
}: {
  value?: string | null
  onChange: (iso: string | null) => void
  clearable?: boolean
  style?: CSSProperties
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <DateCtl
      style={style}
      disabled={disabled}
      title={title}
      className={className}
      display={value ? P.fmtISO(value) : ''}
      value={value || null}
      onPick={(iso) => onChange(iso)}
      onClear={clearable && value ? () => onChange(null) : undefined}
    />
  )
}

/* ---- Empty state ---------------------------------------------------------- */
function EmptyState({
  icon = 'inbox',
  title,
  hint,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  icon?: string
  title: ReactNode
  hint?: ReactNode
  actionLabel?: ReactNode
  onAction?: () => void
  secondaryLabel?: ReactNode
  onSecondary?: () => void
}) {
  return (
    <div className="qivo-empty-state animate-in fade-in slide-in-from-bottom-1 [flex:1] [display:flex] [flex-direction:column] [align-items:center] [justify-content:center] [gap:6px] [padding:40px] [min-height:260px]">
      <div className="[width:52px] [height:52px] [border-radius:var(--r-xl)] [background:var(--surface-2)] [border:1px_solid_var(--border)] [display:grid] [place-items:center] [margin-bottom:8px] [box-shadow:var(--qivo-shadow-card)]">
        <Icon name={icon} size={22} color="var(--text-3)" />
      </div>
      <div className="[font-size:var(--fs-md)] [font-weight:600]">{title}</div>
      {hint && (
        <div className="[font-size:var(--fs-base)] [color:var(--text-3)] [max-width:380px] [text-align:center] [line-height:1.5]">
          {hint}
        </div>
      )}
      {(actionLabel || secondaryLabel) && (
        <div className="[display:flex] [gap:8px] [margin-top:12px]">
          {actionLabel && (
            <Button
              type="button"
              onClick={onAction}
              className="[background:var(--primary)] [border-color:var(--primary)] [color:#fff] [font-weight:600]"
            >
              <Icon name="plus" size={14} />
              {actionLabel}
            </Button>
          )}
          {secondaryLabel && (
            <Button type="button" onClick={onSecondary}>
              {secondaryLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export {
  AnchoredPop,
  Avatar,
  AvatarStack,
  Chip,
  DateInput,
  DateSelect,
  EmptyState,
  FieldSelect,
  Icon,
  IssueKey,
  Kbd,
  MenuDivider,
  MenuItem,
  PausedMark,
  Popover,
  PriorityIcon,
  ProgressBar,
  Seg,
  StatusDot,
  UnreadDivider,
  useBottomSnap,
}
