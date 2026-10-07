/* Kanban board: status columns × project or owner swimlanes, with compact sibling
   groups, individual task drag-and-drop, quick add and real empty states. */
import React, { useState as useStateK } from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { boardDropPatch, groupBoardAssignees, groupBoardCell } from '@/lib/boardGroups'
import { Avatar, EmptyState, Icon, StatusDot } from '../components/qivo'
import { useUpdateBlocker } from '../lib/updateSafety'
import {
  type IssueFilters,
  type IssueVM,
  P,
  type ProjectVM,
  type ScopeInfo,
} from '../store/planner'
import { BoardPanelMaterial } from './BoardPanelMaterial'
import { BoardCard } from './kanbanCards'
import { useBoardPanelClipping } from './useBoardPanelClipping'

/* Cards stay below the pinned lane chrome. */
const Z_LANE_HEAD = 7
const Z_LANE_FOOT = 8

/* The status columns sit above the body scrollport. */
const COL_HEAD_H = 48

/* Board geometry shares the app's 20px canvas inset and 24px section gap.
   The filter row supplies 24px above the first panel; status columns sit 8px
   above headed lanes. These constants also drive sticky offsets and lane
   snapping, so visible spacing and scroll geometry stay in agreement. */
const CANVAS_PAD_X = 20
const CANVAS_PAD_T = 0
const CANVAS_PAD_B = 24
const CARD_GAP = 24
const STATUS_GAP = 8

const PANEL_R = 12
const FRAME = '1px solid var(--border)'
/* The foot supplies natural bottom padding. When pinned, its transparent
   border lets body content continue through to the panel's rounded edge. */
const FOOT_H = PANEL_R * 2

type CardDropTarget = {
  projectIds?: string[]
  /** the person lane's owner (null = Unassigned); absent without person lanes */
  owner?: string | null
}

/* Enter the next lane at its heading and the previous lane at its last tasks
   once the current lane has been read in the scroll direction. Leave scrolling
   inside a tall lane to the browser. */
function useLaneWheelSnap(enabled: boolean) {
  const [pane, setPane] = React.useState<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (!enabled || !pane) return
    let wheelBoundary: { panel: HTMLElement; direction: number } | null = null
    let pendingSnap: {
      from: number
      top: number
      direction: number
      lastTop: number
      lastMovementAt: number
    } | null = null
    const clearBoundary = () => {
      wheelBoundary = null
    }
    const snapTo = (top: number, direction: number, from = pane.scrollTop) => {
      const max = pane.scrollHeight - pane.clientHeight
      top = Math.max(0, Math.min(max, top))
      from = Math.max(0, Math.min(max, from))
      pendingSnap = {
        from,
        top,
        direction,
        lastTop: pane.scrollTop,
        lastMovementAt: performance.now(),
      }
      pane.scrollTo({
        top,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      })
    }
    const onOtherInput = () => {
      clearBoundary()
      if (pendingSnap) {
        pendingSnap = null
        pane.scrollTo({ top: pane.scrollTop, behavior: 'instant' })
      }
    }
    const onScroll = () => {
      if (wheelBoundary) {
        const { panel, direction } = wheelBoundary
        if (!pane.contains(panel)) {
          clearBoundary()
        } else {
          const bounds = pane.getBoundingClientRect()
          const rect = panel.getBoundingClientRect()
          const heading =
            rect.top - bounds.top - Number.parseFloat(getComputedStyle(pane).scrollPaddingTop)
          const offset =
            direction > 0
              ? Math.max(heading, rect.bottom - bounds.top - pane.clientHeight)
              : heading
          // Native wheel animation can carry even a modest tick past an edge.
          // Stop at the edge actually crossed, without accumulating or holding
          // ticks inside the lane. Keep the boundary until another input so an
          // animated wheel's remaining movement cannot skip the final row.
          if (direction * offset < -1) {
            pane.scrollTo({ top: pane.scrollTop + offset, behavior: 'instant' })
          }
        }
      }
      if (!pendingSnap) return
      if (pendingSnap.direction * (pane.scrollTop - pendingSnap.top) >= -1) {
        pendingSnap = null
      } else if (pane.scrollTop !== pendingSnap.lastTop) {
        pendingSnap.lastTop = pane.scrollTop
        pendingSnap.lastMovementAt = performance.now()
      }
    }
    const onWheel = (event: WheelEvent) => {
      clearBoundary()
      if (
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      )
        return
      const direction = Math.sign(event.deltaY)
      const now = performance.now()
      const bounds = pane.getBoundingClientRect()
      const snapTop = bounds.top + Number.parseFloat(getComputedStyle(pane).scrollPaddingTop)
      if (pendingSnap) {
        const arrived = pendingSnap.direction * (pane.scrollTop - pendingSnap.top) >= -1
        // Protect only a moving snap. Refreshing a timeout on each wheel
        // event would swallow steady mouse ticks forever after arrival.
        // Actual movement also bounds the wait if a resize or interruption
        // makes the original target unreachable.
        const moving = now - pendingSnap.lastMovementAt < 180
        if (direction === pendingSnap.direction && !arrived && moving) {
          event.preventDefault()
          return
        }
        if (direction !== pendingSnap.direction && !arrived && moving) {
          event.preventDefault()
          const { from, top } = pendingSnap
          pane.scrollTo({ top: pane.scrollTop, behavior: 'instant' })
          // Reverse between the same readable edges, even when one wheel tick
          // could not cover the distance already travelled. Swapping endpoints
          // also keeps repeated reversals aimed at those edges.
          snapTo(from, direction, top)
          return
        }
        // Native wheel scrolling does not reliably cancel a smooth scrollTo.
        // Stop an unfinished snap before reading geometry in the new direction.
        if (!arrived) pane.scrollTo({ top: pane.scrollTop, behavior: 'instant' })
        pendingSnap = null
      }
      const panels = Array.from(pane.querySelectorAll<HTMLElement>('[data-swimlane-panel]'))
      const current = panels.findIndex((panel) => {
        const rect = panel.getBoundingClientRect()
        if (direction < 0) {
          // Keep the lane being left active throughout the upward transition.
          // Native wheel motion can carry its heading past the pin line before
          // the next event, into the gap or over the preceding panel. That
          // preceding lane is ready to read only when its bottom (or its
          // heading, if it fits) reaches the corresponding viewport edge.
          const heading = rect.top - snapTop
          const bottom = rect.bottom - bounds.top - pane.clientHeight
          return Math.max(heading, bottom) >= -1
        }
        return rect.top <= snapTop + 1 && rect.bottom > snapTop
      })
      const next = current + direction
      if (current < 0) return
      const currentBounds = panels[current].getBoundingClientRect()
      if (direction > 0) {
        // The natural panel bottom includes the sticky foot's height. Once
        // it fits, the final task row is fully visible above the foot.
        if (currentBounds.bottom > bounds.top + pane.clientHeight + 1) {
          wheelBoundary = { panel: panels[current], direction }
          return
        }
      } else if (currentBounds.top < snapTop - 1) {
        // A sticky heading can stay pinned while earlier task rows are off
        // screen. Scroll back through those rows before leaving this lane.
        wheelBoundary = { panel: panels[current], direction }
        return
      }
      if (next < 0 || next >= panels.length) return
      event.preventDefault()
      const destination = panels[next].getBoundingClientRect()
      const headingOffset = destination.top - snapTop
      // Read a tall preceding lane from its bottom instead of skipping its
      // lower tasks. A short lane fits in full at its heading. clientHeight
      // keeps the bottom above any horizontal scrollbar.
      const offset =
        direction > 0
          ? headingOffset
          : Math.max(headingOffset, destination.bottom - (bounds.top + pane.clientHeight))
      const top = Math.max(
        0,
        Math.min(pane.scrollHeight - pane.clientHeight, pane.scrollTop + offset),
      )
      snapTo(top, direction)
    }
    pane.addEventListener('wheel', onWheel, { passive: false })
    pane.addEventListener('scroll', onScroll, { passive: true })
    pane.addEventListener('scrollend', clearBoundary, { passive: true })
    window.addEventListener('pointerdown', onOtherInput, { capture: true, passive: true })
    window.addEventListener('keydown', onOtherInput, { capture: true })
    return () => {
      pane.removeEventListener('wheel', onWheel)
      pane.removeEventListener('scroll', onScroll)
      pane.removeEventListener('scrollend', clearBoundary)
      window.removeEventListener('pointerdown', onOtherInput, true)
      window.removeEventListener('keydown', onOtherInput, true)
    }
  }, [enabled, pane])
  return setPane
}

/* The Overview's card, whole — for the panels one element can draw by itself
   (the status-column header, a side-board). A swimlane's box is drawn by two
   elements and assembles the same look out of FRAME and PANEL_R piece by
   piece; see below for why it has to. */
/* A swimlane's heading — the sub-project (or, across all projects, the
   project) the cards under it belong to. It PINS under the status-column
   headers while its own lane scrolls, and the next lane's heading pushes it
   out, so a long board never leaves you reading nameless cards. That is what
   the lane lives outside the shared column grid for: a sticky grid ITEM is
   constrained to its own grid area — one row tall — so it has nowhere to
   travel. Each lane gets a grid of its own instead, with identical
   `gridTemplateColumns` inside the same width, so the columns still line up
   across lanes.

   THE HEADING IS THE TOP OF THE BOX. Not a bar inside one: it carries the
   panel's top border and its top two corners, and the grid below it carries
   the other three sides. The first cut of this had the box drawn by a single
   wrapper with the heading floating inside, and the moment the lane's own top
   scrolled past the pin line the box lost its lid — two side hairlines running
   up out of a heading and stopping dead against the sticky band. Moving the
   lid onto the thing that stays means the box is closed at every scroll
   position, which is the whole point of pinning the heading in the first
   place.

   useBoardPanelClipping stops body content at the pinned heading's bottom.
   Hidden cards and side borders cannot show through the lid or outside its
   corners. One continuous underlay supplies the panel's tint and blur. The
   same clipping keeps a departing heading below the status-header band. */
function LaneHeader({
  proj,
  owner,
  stick,
  onOpen,
  onAdd,
}: {
  proj?: ProjectVM | null
  /** a person lane's owner (null = Unassigned) */
  owner?: string | null
  stick: number
  onOpen?: (id: string) => void
  /** opens the new-task window on the lane's own project or sub-project */
  onAdd?: (id: string) => void
}) {
  const leadId = proj ? P.leadOf(proj.id) : owner
  const lead = leadId ? P.user(leadId) : null
  const name = proj?.name || lead?.name || (owner ? 'Unknown user' : 'Unassigned')
  return (
    <div
      data-lane={proj?.id || `assignee:${owner || 'unassigned'}`}
      style={{
        border: FRAME,
        borderRadius: `var(--board-heading-radius, ${PANEL_R}px ${PANEL_R}px 0 0)`,
        boxShadow: `0 -${PANEL_R}px 0 0 var(--board-pin-mask, var(--bg))`,
        top: stick,
        zIndex: Z_LANE_HEAD,
      }}
      className="board-panel-heading [display:flex] [align-items:center] [gap:8px] [padding:8px] [background:var(--surface-1)] [position:sticky]"
    >
      {/* the lid is a fixed-height bar now, so the name has to be one line —
          a wrapped project name (and across all projects a lane IS a project,
          which is where the long names are) would deepen the bar at every pin */}
      {/* …and the name is the way IN to what it names: across every project
          this heading is the only place a project is written on the board, and
          it was the one label in the app you could read but not follow. It
          re-scopes to the lane's own project (a sub-project at project scope,
          the project across all of them), the same move the top bar's crumb
          makes one altitude up. A button, not a div with a click: it is
          keyboard-reachable and says what it is. It hovers as a fill, like the
          Roadmap's heading of the same kind and every quiet control (deviation
          #232), never an underline (deviation #237); the negative margin keeps
          the name where the lid's padding put it. No hover help (deviation
          #238): the name is the whole label, and the fill says it is pressable. */}
      {proj ? (
        <Button
          type="button"
          data-lane-open={proj.id}
          onClick={() => onOpen?.(proj.id)}
          className="-mx-1 h-control-xs min-w-0 justify-start rounded-sm border-0 px-1 text-md font-semibold"
          variant="ghost"
        >
          <span className="truncate">{name}</span>
        </Button>
      ) : (
        <HoverTooltip content={name}>
          <span className="min-w-0 truncate text-md font-semibold text-text-1">{name}</span>
        </HoverTooltip>
      )}
      {/* …and the way to put something IN what it names (deviation #236): a +
          right after the name opens the new-task window on this lane's own
          project or sub-project — the promise the side-board's + keeps, behind
          the same gate, since a viewer's grant can't hold a task. An assignee
          lane names a person, not a place, so it has none. */}
      {proj && P.canWrite(proj.id) && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="w-control-xs h-control-xs shrink-0"
          data-lane-add={proj.id}
          aria-label={`New task in ${name}`}
          title={`New task in ${name}`}
          onClick={() => onAdd?.(proj.id)}
        >
          <Icon name="plus" size={16} />
        </Button>
      )}
      {/* no task counter after the name in either kind of lane (deviation
          #232): the status columns already count, and a lane's width is the
          measure that matters */}
      {!proj && lead?.isAgent && <span className="text-xs text-text-3">Agent</span>}
      <div className="[flex:1]" />
      {/* The lane lead's full name stays available through the portrait's
          tooltip and accessible label. */}
      {(lead || !proj) && <Avatar id={leadId} size={28} />}
    </div>
  )
}

/* The other end of the box, and the lid's mirror in every way that matters.
   It pins to the FOOT of the pane instead of the head, and it carries the
   bottom border and the bottom two corners so that a lane running off the
   bottom of the window closes there instead of having its two side hairlines
   sheared off by the window edge — which was the same open box the lid was
   built to fix, just upside down.
   It is also what bounds the lid: the lid lives in a block of its own beside
   this, so it can travel no further than that block's foot, which is this
   element's head. The lid is pushed up the instant the corners would reach it,
   and neither ever paints on the other. */
function LaneFoot() {
  return (
    <div
      data-lane-foot
      aria-hidden="true"
      style={{
        height: FOOT_H,
        borderLeft: `var(--board-body-frame, ${FRAME})`,
        borderRight: `var(--board-body-frame, ${FRAME})`,
        borderBottom: `var(--board-body-frame, ${FRAME})`,
        borderRadius: `0 0 ${PANEL_R}px ${PANEL_R}px`,
        boxShadow: `0 ${PANEL_R}px 0 0 var(--board-pin-mask, var(--bg))`,
        zIndex: Z_LANE_FOOT,
      }}
      className="[background:transparent] [position:sticky] [bottom:0] [pointer-events:none]"
    />
  )
}

function ColHeaderRow({
  statuses,
  counts,
  onAdd,
}: {
  statuses: typeof P.STATUSES
  counts: Record<string, number>
  onAdd: ((statusId: string) => void) | null
}) {
  return (
    <div className="[display:contents]">
      {statuses.map((s, i) => (
        // the panel around the row draws the outer edge — the divider is
        // between columns only, never against the card's own border
        <div
          key={s.id}
          style={{
            borderRight: i < statuses.length - 1 ? '1px solid var(--border)' : 'none',
            minHeight: COL_HEAD_H,
          }}
          className="[display:flex] [align-items:center] [gap:8px] [padding:8px]"
        >
          <StatusDot status={s.id} size={13} />
          <span className="[font-size:var(--fs-md)] [font-weight:600] [color:var(--text-1)]">
            {s.name}
          </span>
          <span data-status-count={s.id} className="[font-size:var(--fs-xs)] [color:var(--text-3)]">
            {counts[s.id] || 0}
          </span>
          <div className="[flex:1]" />
          {/* a column names a status, not a place — across all projects there
              is no project behind it to create in (each side-board's own + is
              the affordance that still names one) */}
          {onAdd && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="w-control-sm h-control-sm"
              aria-label={`New task in ${s.name}`}
              title={`New task in ${s.name}`}
              onClick={() => onAdd(s.id)}
            >
              <Icon name="plus" size={16} />
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

function NoMatchNote({ onClear }: { onClear: () => void }) {
  return (
    <div className="board-empty-note animate-in fade-in slide-in-from-bottom-1 [display:flex] [flex-direction:column] [align-items:center] [gap:6px] [padding:26px_16px]">
      <span className="[font-size:var(--fs-base)] [color:var(--text-3)]">
        Nothing matches your filters
      </span>
      <Button type="button" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  )
}

function Kanban({
  info,
  filters,
  tweaks,
  actions,
}: {
  info: ScopeInfo
  filters: IssueFilters
  tweaks: { metaViz: string }
  actions: Record<string, (...args: unknown[]) => void>
}) {
  const onOpenIssue = actions.openIssue
  const [dragId, setDragId] = useStateK(null)
  useUpdateBlocker(!!dragId)
  const [dragOver, setDragOver] = useStateK(null)

  // `wide` = a scope that names no project (All projects, My view); `mine` is
  // the one that also narrows to my own tasks
  const wide = info.wide
  const mine = info.mine
  // Scopes that hold project groups worth labelling: one project's sub-projects, or —
  // across all projects (deviation #47) — the projects themselves. A lone sub-project
  // is its own project group, which pools unless assignee grouping is selected.
  const grouped = wide || info.isMeta
  const byAssignee = tweaks.metaViz === 'assignees'
  const subIds = info.subIds
  const snapRef = useLaneWheelSnap(
    (byAssignee || (grouped && tweaks.metaViz === 'swimlanes')) && !dragId,
  )
  const { paneRef: clippingRef, materialRef } = useBoardPanelClipping()
  const headerRef = React.useRef<HTMLDivElement>(null)
  const bodyRef = React.useRef<HTMLDivElement>(null)
  const scrollRef = React.useCallback(
    (pane: HTMLDivElement | null) => {
      bodyRef.current = pane
      snapRef(pane)
      clippingRef(pane)
    },
    [snapRef, clippingRef],
  )

  const scoped = P.scopedIssues(info)
  const scopedLeaves = scoped.filter((it) => !P.isGroup(it))
  const visible = scopedLeaves.filter((it) => P.passesFilters(it, filters))
  // Focus drops the Backlog and Done COLUMNS, not just their cards —
  // passesFilters already emptied them, and an empty shell column would
  // read as "no backlog" rather than "backlog hidden"
  const statuses = filters.focus
    ? P.STATUSES.filter((s) => s.id !== 'backlog' && s.id !== 'done')
    : P.STATUSES
  /* Two questions the one `anyFilter` flag used to answer at once, and they
     came apart when a SCOPE gained the power to narrow (My view).
     · `clearable` — is a TOOLBAR filter on? It gates the "nothing matches"
       note, whose only action is Clear. The scope's own narrowing is not one
       (Clear can't undo a scope) and neither is Focus, which survives Clear —
       the same reason deviation #33 kept Focus out of this test.
     · `holdsScoped` — does the SCOPE put anything in this group at all? That
       is what decides whether a group belongs on this board: in My view a
       project I have no task in isn't part of the board, while a project I do
       have work in keeps its lane even when Focus empties it — exactly what a
       project scope has always done, and what "the board keeps its shape"
       promises. Asking `anyFilter` here instead would hide EVERY group the
       moment Focus emptied them, with no note (it isn't clearable) and, in
       the Boards layout, nothing left to draw. */
  const clearable =
    (!mine && filters.mine) ||
    filters.assignees.length > 0 ||
    filters.priority ||
    filters.stale ||
    filters.search
  const scopedProjects = new Set(scoped.map((i) => i.project))
  const holdsScoped = (gsubIds) => gsubIds.some((id) => scopedProjects.has(id))
  const byPrio = (a, b) => P.PRIORITIES[a.priority].rank - P.PRIORITIES[b.priority].rank

  const counts = {}
  statuses.forEach((s) => {
    counts[s.id] = visible.filter((i) => i.status === s.id).length
  })

  /* What to print on the card: the sub-project it lives in, prefixed with its
     PROJECT when nothing else on the board names that (the pooled board across
     all projects). Lanes and side-boards name their own group, so they ask for
     the short form. */
  const cardLabel = (it, withOwner) => {
    const p = P.project(it.project)
    if (!p) return ''
    if (!withOwner) return p.name
    const m = P.metaOf(it.project)
    return m && m.id !== p.id ? `${m.name}, ${p.name}` : p.name
  }

  // Group only after scope, filters, lane and status have selected the cell.
  // Keep the surrounding column counts and empty-state geometry unchanged.
  function renderCards(items, projectLabel, over: boolean) {
    // Recede destination cards as a whole so the column reads as the target.
    // Keep the source cell unchanged, including its dragged row's own opacity.
    const dimmed = over && !items.some((it) => it.id === dragId)
    return groupBoardCell(items, P.issueById).map((group) => (
      <BoardCard
        key={group.key}
        group={group}
        projectLabel={projectLabel}
        dimmed={dimmed}
        onOpen={onOpenIssue}
        onDragStart={setDragId}
        onDragEnd={() => {
          setDragId(null)
          setDragOver(null)
        }}
        dragId={dragId}
      />
    ))
  }

  /* What dropping the task into this status cell writes (boardDropPatch),
     or null when the cell refuses it. The person the patch names, a new
     assignee or reviewer, must be able to hold the task; clearing one, or a
     status-only move, needs no roster check. */
  const dropPatchFor = (id: string, statusId: string, { projectIds, owner }: CardDropTarget) => {
    const task = P.issueById[id]
    if (!task || P.isGroup(task) || !P.canWrite(task.project)) return null
    if (projectIds && !projectIds.includes(task.project)) return null
    const patch = boardDropPatch(task, statusId as IssueVM['status'], owner)
    if (!patch) return null
    const person =
      'assignee' in patch ? patch.assignee : 'reviewer' in patch ? patch.reviewer : null
    return person == null || P.issueAssigneesFor(task.project).some((u) => u.id === person)
      ? patch
      : null
  }
  const moveCard = (statusId: string, id: string, target: CardDropTarget) => {
    const iid = id || dragId
    // a drop can also arrive from a keyboard/HTML5 path that never went
    // through the card's own `draggable`, so the right is re-checked here
    const patch = dropPatchFor(iid, statusId, target)
    // One mutation keeps the owner change and status move atomic.
    if (patch && Object.keys(patch).length) P.updateIssue(iid, patch)
    setDragId(null)
    setDragOver(null)
  }
  // Native drag previews can leave the board. Only advertise and accept a
  // drop where the task already belongs (or an eligible person lane).
  const cardDropHandlers = (key: string, statusId: string, target: CardDropTarget) => ({
    onDragOver: (e: React.DragEvent) => {
      const patch = dragId ? dropPatchFor(dragId, statusId, target) : null
      if (patch) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        // Returning to the source is a harmless drop, not a new destination.
        const nextOver = Object.keys(patch).length ? key : null
        if (dragOver !== nextOver) setDragOver(nextOver)
      } else {
        e.dataTransfer.dropEffect = 'none'
        if (dragOver !== null) setDragOver(null)
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDragOver((current) => (current === key ? null : current))
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      moveCard(statusId, e.dataTransfer.getData('text/plain'), target)
    },
  })
  const defaultProject = subIds[0] || null
  // null in either sentinel scope: a create needs a project, and a status
  // column across every project names none — ColHeaderRow drops the + rather
  // than opening a dialog with nothing chosen
  const addTo =
    wide || !P.canWrite(info.id)
      ? null
      : (statusId) => actions.newIssue({ status: statusId, project: defaultProject })

  /* ---------- empty states ---------- */
  if (subIds.length === 0) {
    if (wide) {
      return (
        <EmptyState
          icon="layers"
          title="Nothing to show yet"
          hint={
            info.metas.length === 0
              ? 'No projects are available to you yet.'
              : 'Tasks live in sub-projects.'
          }
        />
      )
    }
    return (
      <EmptyState
        icon="layers"
        title="No sub-projects yet"
        hint="Tasks live in sub-projects."
        actionLabel={P.canWrite(info.id) ? 'New sub-project' : undefined}
        onAction={() => actions.newProject({ parent: info.id })}
      />
    )
  }
  if (scoped.length === 0) {
    // My view empties for a reason of its own — an empty board here doesn't
    // mean nobody has created anything, only that none of it landed on me
    if (mine) {
      return <EmptyState icon="user" title="Nothing assigned to you" />
    }
    // no action across all projects: the task would have nowhere named to go
    if (wide) {
      return <EmptyState icon="board" title="No tasks yet" />
    }
    return (
      <EmptyState
        icon="board"
        title="No tasks yet"
        actionLabel={P.canWrite(info.id) ? 'New task' : undefined}
        onAction={() => actions.newIssue({ project: defaultProject })}
      />
    )
  }
  // a filter that matches nothing keeps the status columns standing (empty)
  // with an inline note — a full-screen empty state would hide the board.
  // Gated on the CLEARABLE filters: the note's only action is Clear.
  const noMatches = visible.length === 0 && clearable

  const minColumnWidth = 220
  const gridCols = `repeat(${statuses.length}, minmax(${minColumnWidth}px, 1fr))`

  // ---- side-boards layout (each group its own mini board) ----------------
  if (grouped && tweaks.metaViz === 'sideboards') {
    return (
      /* The canvas padding is on the div INSIDE the scroller, not on the
         scroller — measured, and it is not cosmetic: a scroll container's own
         padding insets the offsets its sticky descendants resolve against, so
         with `padding: 14px … 28px` here a head asking for `top: 14` pinned 28
         below the pane and a foot asking for `bottom: 0` stopped 28 short. The
         swimlane pane never hit it because its padding already lives on the
         band and the lane list; this one is now built the same way. */
      <div
        ref={scrollRef}
        data-scroll
        className="[flex:1] [overflow:auto] [scrollbar-gutter:stable]"
      >
        <BoardPanelMaterial materialRef={materialRef} />
        <div style={{ padding: `${CANVAS_PAD_T}px ${CANVAS_PAD_X}px ${CANVAS_PAD_B}px` }}>
          {/* every sub-board hides itself when filtered empty, so a zero-match
            filter leaves nothing — say so instead of a blank pane */}
          {noMatches && <NoMatchNote onClear={actions.clearFilters} />}
          <div
            style={{ gap: CARD_GAP }}
            className="[position:relative] [display:flex] [align-items:flex-start]"
          >
            {info.groups.map((g) => {
              const proj = g.proj
              const gset = new Set(g.subIds)
              const list = visible.filter((i) => gset.has(i.project))
              if (!holdsScoped(g.subIds) || (clearable && list.length === 0)) return null
              return (
                /* Built like a swimlane, for the same reason: a box whose edges
                 scroll past the pane's is not a box. This layout is a row of
                 tall narrow panels and BOTH its ends used to shear off — the
                 head against the top of the pane, the foot against the window
                 edge — so the head pins and carries the lid, and LaneFoot
                 closes the bottom. Pinning the head is the same bargain the
                 swimlanes struck: it is the only thing naming which board a
                 column of cards belongs to, and here there are four or five of
                 them side by side, so reading a nameless one is easier still.
                 Its lid pins at CANVAS_PAD_T rather than under a header block,
                 because this layout has no status-column band above it.
                 The shared clipping hook keeps body content below the lid
                 and inside the foot's rounded border, above one underlay. */
                <div
                  key={proj.id}
                  data-board-group={proj.id}
                  style={{ borderRadius: PANEL_R }}
                  className="[width:248px] [flex-shrink:0] [overflow:clip] [box-shadow:var(--qivo-shadow-card)]"
                >
                  <div>
                    <div
                      style={{
                        border: FRAME,
                        borderRadius: `var(--board-heading-radius, ${PANEL_R}px ${PANEL_R}px 0 0)`,
                        boxShadow: `0 -${CANVAS_PAD_T + PANEL_R}px 0 0 var(--board-pin-mask, var(--bg))`,
                        top: CANVAS_PAD_T,
                        zIndex: Z_LANE_HEAD,
                      }}
                      className="board-panel-heading [display:flex] [align-items:center] [gap:8px] [padding:8px] [background:var(--surface-1)] [position:sticky]"
                    >
                      {/* pressable for the same reason the swimlane lid is, and by
                      the same hook: a heading that names a project is the way
                      into it, whichever layout drew it */}
                      <Button
                        type="button"
                        data-lane-open={proj.id}
                        onClick={() => actions.setScope(proj.id)}
                        className="-mx-1 h-control-xs min-w-0 justify-start rounded-sm border-0 px-1 text-md font-semibold"
                        variant="ghost"
                      >
                        <span className="truncate">{proj.name}</span>
                      </Button>
                      <div className="[flex:1]" />
                      {/* the one create affordance left in a sentinel scope, so it
                      has to keep its promise: a viewer's grant can't hold a
                      task, and the dialog would silently fall back to some
                      OTHER project's sub-projects. In My view the task it
                      creates is unassigned, so it won't land on this board —
                      createIssue's inScope jumps to its sub-project instead. */}
                      {['lead', 'user'].includes(P.levelOn(proj.id) || '') && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="w-control-xs h-control-xs"
                          aria-label={`New task in ${proj.name}`}
                          title={`New task in ${proj.name}`}
                          onClick={() => actions.newIssue({ project: proj.id })}
                        >
                          <Icon name="plus" size={16} />
                        </Button>
                      )}
                    </div>
                    <div
                      style={{
                        borderLeft: `var(--board-body-frame, ${FRAME})`,
                        borderRight: `var(--board-body-frame, ${FRAME})`,
                      }}
                      className="board-lane-body [background:var(--surface-1)]"
                    >
                      {statuses.map((s) => {
                        const items = list.filter((i) => i.status === s.id).sort(byPrio)
                        const dkey = `${proj.id}:${s.id}`
                        return (
                          <div
                            key={s.id}
                            data-board-cell={proj.id}
                            data-status={s.id}
                            {...cardDropHandlers(dkey, s.id, { projectIds: g.subIds })}
                            style={{
                              background:
                                dragId && dragOver === dkey ? 'var(--accent-soft)' : 'transparent',
                              outline:
                                dragId && dragOver === dkey ? '2px dashed var(--primary)' : 'none',
                            }}
                            className="[padding:8px] [outline-offset:-3px] [transition:background_var(--dur-fast)_var(--ease-out)]"
                          >
                            <div className="[display:flex] [align-items:center] [gap:6px] [padding:4px_2px] [font-size:var(--fs-xs)] [color:var(--text-3)] [font-weight:600]">
                              <StatusDot status={s.id} size={12} />
                              {s.name} <span className="[font-weight:400]">{items.length}</span>
                            </div>
                            {/* the board's own header names the group; across all
                          projects that leaves the sub-project still to say */}
                            <div className="[display:flex] [flex-direction:column] [gap:8px] [min-height:8px]">
                              {renderCards(
                                items,
                                (it) => (wide ? cardLabel(it, false) : ''),
                                !!dragId && dragOver === dkey,
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <LaneFoot />
                </div>
              )
            })}
          </div>
        </div>
      </div>
    )
  }

  // ---- swimlanes / pooled layout (shared grid) ---------------------------
  const swimlanes = grouped && tweaks.metaViz === 'swimlanes'
  type Lane = {
    key: string
    proj: ProjectVM | null
    projectIds?: string[]
    owner?: string | null
    items: IssueVM[]
  }
  let lanes: Lane[] = byAssignee
    ? groupBoardAssignees(scopedLeaves, visible, (id) => P.user(id)?.name || 'Unknown user')
        .map((lane) => ({ ...lane, proj: null }))
        .filter((lane) => !(clearable && lane.items.length === 0))
    : swimlanes
      ? info.groups
          .filter((g) => holdsScoped(g.subIds))
          .map((g) => {
            const gset = new Set(g.subIds)
            return {
              key: g.proj.id,
              proj: g.proj,
              projectIds: g.subIds,
              items: visible.filter((i) => gset.has(i.project)),
            }
          })
          .filter((l) => !(clearable && l.items.length === 0))
      : [{ key: 'pool', proj: null, items: visible }]
  // all swimlanes filtered away: keep one unlabeled empty lane so the status
  // columns still render their (empty) stacks
  if (lanes.length === 0) lanes = [{ key: 'pool', proj: null, items: [] }]
  const headed = (lane: Lane) => !!lane.proj || lane.owner !== undefined
  // A sub-project heading already names the card's home; a project heading
  // still owes the sub-project. Pooled and assignee lanes owe both when wide.
  const laneLabel = (it) => (swimlanes ? (wide ? cardLabel(it, false) : '') : cardLabel(it, wide))

  /* One panel with nothing to head it — the pooled layout, or a scope that IS
     a single sub-project — has no sticky heading to carry its lid. The
     status-column header is pinned up there anyway, so it BECOMES the lid and
     the two close up into one box. With swimlanes the header stays a strip of
     its own, because it heads all of them and no single one of them.
     Weld only a single headless lane. Assignee lanes, including Unassigned,
     carry their own heading even when only one remains after filtering. */
  const fused = lanes.length === 1 && !headed(lanes[0])
  const foot = `0 0 ${PANEL_R}px ${PANEL_R}px`

  return (
    /* The gutter is reserved whether or not the scrollbar is up (the Roadmap's
       pane already does this). Without it, anything that takes the content
       under the pane height — Focus dropping two columns, a filter, dragging
       the last card out of the tallest column — reclaims 20px and every panel
       edge and column divider on screen jumps sideways. On the old full-bleed
       grid there was nothing whose edge you could watch move.

       The wheel handler stops at each lane's corresponding edge, then enters
       the next heading going down or the previous lane's last tasks going up.
       Native CSS snapping must stay off: its compositor can latch a discrete
       mouse-wheel gesture at an oversized lane's edge and ignore later ticks,
       even when no application listener prevents their default action. */
    <div className="[display:flex] [flex-direction:column] [flex:1] [min-height:0] [overflow:hidden]">
      <div
        ref={headerRef}
        onScroll={(event) => {
          if (bodyRef.current && bodyRef.current.scrollLeft !== event.currentTarget.scrollLeft) {
            bodyRef.current.scrollLeft = event.currentTarget.scrollLeft
          }
        }}
        className="[flex-shrink:0] [overflow:hidden] [scrollbar-gutter:stable]"
      >
        {/* The status columns and their gap sit outside vertical scrolling.
            Match the body's gutter and horizontal offset so every column
            remains aligned even when the board is wider than the viewport. */}
        <div
          style={{
            minWidth: statuses.length * minColumnWidth + CANVAS_PAD_X * 2,
            padding: `${CANVAS_PAD_T}px ${CANVAS_PAD_X}px ${fused ? 0 : STATUS_GAP}px`,
          }}
          className="board-status-band [background:var(--bg)]"
        >
          {/* `hidden` is allowed HERE, unlike on a lane (see below): nothing
              inside this card is sticky, so there is no pinning for it to
              break. It aligns with the lanes below only because both are a
              1px-bordered box inside the same 20px of padding — the header
              draws its sides on the same element as its grid, a lane draws
              them on the grid inside a border-less wrapper, and the two arrive
              at the same content width by different routes. Padding added to
              either one desynchronises the column dividers, which are the only
              thing carrying the column structure at 4/255 of fill contrast. */}
          <div
            style={{
              gridTemplateColumns: gridCols,
            }}
            className={`board-status-panel grid overflow-hidden border border-border bg-surface-1 ${
              fused ? 'rounded-t-[12px] shadow-none' : 'rounded-[12px] shadow-card'
            }`}
            data-board-fused={fused}
          >
            <ColHeaderRow statuses={statuses} counts={counts} onAdd={addTo} />
          </div>
        </div>
      </div>
      <div
        ref={scrollRef}
        data-scroll
        onScroll={(event) => {
          if (
            headerRef.current &&
            headerRef.current.scrollLeft !== event.currentTarget.scrollLeft
          ) {
            headerRef.current.scrollLeft = event.currentTarget.scrollLeft
          }
        }}
        className="[flex:1] [min-height:0] [overflow:auto] [scrollbar-gutter:stable] [container-type:size] [scroll-padding-top:0]"
      >
        <BoardPanelMaterial materialRef={materialRef} />
        <div
          style={{ minWidth: statuses.length * minColumnWidth + CANVAS_PAD_X * 2 }}
          className="[position:relative]"
        >
          {/* "pool" keys the unlabelled lane below — it is not a scope id */}
          <div
            style={{
              padding: `0 ${CANVAS_PAD_X}px ${CANVAS_PAD_B}px`,
              gap: CARD_GAP,
              // The last headed lane needs room to reach the snap line even
              // when its cards are shorter than the pane. Grow its grid row,
              // leaving the panel at its natural height with blank canvas below.
              // cqh follows this scrollport, including resizes and toolbar changes.
              gridTemplateRows: headed(lanes[lanes.length - 1])
                ? `${lanes.length > 1 ? `repeat(${lanes.length - 1}, auto) ` : ''}minmax(max(0px, calc(100cqh - ${CANVAS_PAD_B}px)), auto)`
                : undefined,
            }}
            className="[display:grid] [align-items:start]"
          >
            {lanes.map((lane) => (
              /* The box's corners live on this wrapper, not on either of the two
             elements that draw its sides.

             THE HEADING IS EVICTED BEFORE IT REACHES THE FOOT. A sticky element
             may travel to the bottom of its containing block's CONTENT box, so
             left alone the heading walks all the way down onto the corners and
             the box's foot turns to mush: the heading's own bottom border comes
             to rest on the foot's, and the two strokes, clipped to the arc,
             read as one thick smeared curve instead of a 1px corner. Clipping
             alone cannot fix that; it shapes the heading's fill but the arc's
             stroke is still behind it. So the lid and the grid share a block of
             their own, one level in, and the foot sits outside it — the lid's
             containing block now ends exactly where the foot begins, and it is
             pushed up the moment the corners would reach it.

             `clip`, not `hidden`. `hidden` would make this wrapper the
             heading's scrollport — a box that never scrolls, so the heading
             would never pin at all (measured: with `hidden` it tracks the
             scroll 1:1 and sails straight past the band). `clip` does not
             create a scroll container, so the pane stays the scrollport and
             the corners still cut. Where it isn't supported the declaration is
             simply dropped and the only thing lost is the push-out rounding.
             Leave this wrapper free of stacking contexts so sticky headings
             keep their shared z-order across lanes. A fixed underlay paints
             the material through a clip of the visible panel shapes. */
              <div
                key={lane.key}
                data-swimlane-panel={headed(lane) ? '' : undefined}
                style={{ borderRadius: fused ? foot : PANEL_R }}
                className="board-lane [overflow:clip] [box-shadow:var(--qivo-shadow-card)]"
              >
                <div>
                  {headed(lane) && (
                    <LaneHeader
                      proj={lane.proj}
                      owner={lane.owner}
                      stick={0}
                      onOpen={actions.setScope}
                      onAdd={(id) => actions.newIssue({ project: id })}
                    />
                  )}
                  {/* the lid — this lane's heading, or the fused header card above —
                  draws the top border and the foot draws the bottom, so the
                  grid is only ever the two sides */}
                  <div
                    style={{
                      gridTemplateColumns: gridCols,
                      borderLeft: `var(--board-body-frame, ${FRAME})`,
                      borderRight: `var(--board-body-frame, ${FRAME})`,
                    }}
                    className="board-lane-body [display:grid] [background:var(--surface-1)]"
                  >
                    {statuses.map((s, ci) => {
                      const laneKey = `${lane.key}:${s.id}`
                      return (
                        <ColumnStackInline
                          key={s.id}
                          laneId={lane.key}
                          status={s.id}
                          last={ci === statuses.length - 1}
                          over={!!dragId && dragOver === laneKey}
                          {...cardDropHandlers(laneKey, s.id, lane)}
                        >
                          {renderCards(
                            lane.items.filter((i) => i.status === s.id).sort(byPrio),
                            laneLabel,
                            !!dragId && dragOver === laneKey,
                          )}
                        </ColumnStackInline>
                      )
                    })}
                  </div>
                </div>
                <LaneFoot />
              </div>
            ))}
            {noMatches && <NoMatchNote onClear={actions.clearFilters} />}
          </div>
        </div>
      </div>
    </div>
  )
}

function ColumnStackInline({
  children,
  laneId,
  status,
  over,
  last,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  children?: React.ReactNode
  laneId: string
  status: string
  over: boolean
  last: boolean
  onDragOver: React.DragEventHandler
  onDragLeave: React.DragEventHandler
  onDrop: React.DragEventHandler
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      // 12 at the top, not 9: a headless lane (pooled, or a scope that is one
      // sub-project) has the grid as the clip wrapper's first child, so at 9
      data-board-cell={laneId}
      data-status={status}
      // Keep the established inset under the bordered lid. The sticky foot
      // supplies bottom padding; grouping changes only the cards inside.
      style={{
        borderRight: last ? 'none' : '1px solid var(--board-column-rule, var(--border))',
        background: over ? 'var(--accent-soft)' : 'transparent',
        outline: over ? '2px dashed var(--primary)' : 'none',
      }}
      className="[display:flex] [flex-direction:column] [gap:8px] [padding:8px_8px_0] [min-height:60px] [outline-offset:-3px] [transition:background_var(--dur-fast)_var(--ease-out)]"
    >
      {children}
    </div>
  )
}

export { Kanban }
