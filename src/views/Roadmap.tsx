/* Roadmap owns the timeline window, folds, planning sessions and dependency
   corrections. Drag previews commit on release; grid epochs reject stale dates.
   TimelineMarks renders tasks/milestones, WindowControls edits the viewport,
   and PlanCard shows workload while ResourceStrip shares the same week grid. */
import type React from 'react'
import {
  useCallback,
  useEffect as useEffectR,
  useLayoutEffect as useLayoutEffectR,
  useRef as useRefR,
  useState as useStateR,
} from 'react'
import { Button } from '@/components/ui/button'
import { HoverTooltip } from '@/components/ui/tooltip'
import { isRoadmapTaskVisible } from '@/lib/roadmapVisibility'
import { useUpdateBlocker } from '@/lib/updateSafety'
import { useMobile } from '@/lib/useMobile'
import { EmptyState, Icon } from '../components/qivo'
import { RoadmapUndo } from '../components/RoadmapUndo'
import { WorkspaceToolbar } from '../components/WorkspaceShell'
import { solvablePairs } from '../lib/schedule'
import { captureWeekDates, restoreWeekDates } from '../lib/weekDrafts'
import { committedByWeek, fitEndWeek, type LoadItem, plannableHoursOf } from '../lib/workload'
import { UpdateEstimateModal } from '../panels/UpdateEstimate'
import { type IssueFilters, type IssueVM, P, type ScopeInfo } from '../store/planner'
import { LandscapeRoadmap } from './LandscapeRoadmap'
import { MobileRoadmap } from './MobileRoadmap'
import { ResourceStrip, STRIP_HEAD_H, stripHeight } from './Resources'
import { GRID_X, GUTTER_W, HEAD_STICK, LABEL_W, ROW_H, SUB_STICK } from './roadmap/layout'
import { PlanCard, type PlanSession } from './roadmap/PlanCard'
import { createRowObserver } from './roadmap/rowObserver'
import { MilestoneFlag } from './roadmap/TimelineMarks'
import { TimelineRow } from './roadmap/TimelineRow'
import { WinMenu, WinRangePicker } from './roadmap/WindowControls'
import '../styles/mobile-views.css'
import './Roadmap.css'

const BASE_WEEK_W = 36
// Below this width the grid scrolls; wider weeks fill the selected window.
const MIN_WEEK_W = 24

// Week labels and milestone flags share a fixed header above the task grid.
const HEAD_PAD_T = 6 // breathing room above the week numbers
const WEEK_BAND_H = 33 // calendar week number over the week's first workday
const MS_BAND_H = 36 // milestone flags with up to two lines of text
const HEAD_H = HEAD_PAD_T + WEEK_BAND_H + MS_BAND_H

// how long a read-only reveal keeps its spotlight ring
const REVEAL_MS = 2400

/* The timeline panel keeps its Task/week header above the task scrollport.
   Header, tasks and Team share a horizontal origin, while only task rows
   participate in the timeline's vertical scrolling. */
const CANVAS_PAD_X = 20
const CANVAS_PAD_B = 24
const CARD_GAP = 24

function Roadmap({
  info,
  filters: rawFilters,
  actions,
  filterControls: renderFilterControls,
  focusPlan,
  onFocusConsumed,
  revealTask = null,
  onRevealConsumed,
}: {
  info: ScopeInfo
  filters: IssueFilters
  actions: Record<string, (...args: unknown[]) => void>
  filterControls: (mobile: boolean) => React.ReactNode
  focusPlan: { id: string; n: number } | null
  onFocusConsumed?: () => void
  /* Show a task without planning it (Team sync's Roadmap jump): { id, n }
     like focusPlan, n a nonce. Its bar scrolls into view and wears the
     planning spotlight for a moment; no session, no card, nothing written. */
  revealTask?: { id: string; n: number } | null
  onRevealConsumed?: () => void
}) {
  const phone = useMobile()
  useUpdateBlocker(P.roadmapUndo.count > 0)
  // Keep the phone layer after physical rotation crosses the desktop width.
  // A fresh desktop visit still gets the ordinary workspace timeline.
  const [mobileLayout, setMobileLayout] = useStateR<'agenda' | 'timeline' | null>(null)
  const mobile = phone || mobileLayout !== null
  const filters = mobile ? { ...rawFilters, search: '' } : rawFilters
  const filterControls = renderFilterControls(mobile)
  const canvasPadX = mobile ? 12 : CANVAS_PAD_X
  const canvasPadB = mobile ? 12 : CANVAS_PAD_B
  const cardGap = mobile ? 8 : CARD_GAP
  const [mobileAgendaSection, setMobileAgendaSection] = useStateR<'milestones' | 'tasks'>(
    'milestones',
  )
  const [mobileTaskState, setMobileTaskState] = useStateR<'all' | 'planned' | 'unplanned'>('all')
  const returnToAgenda = useRefR(false)
  useEffectR(() => {
    if (mobileLayout !== 'agenda' || !returnToAgenda.current) return
    returnToAgenda.current = false
    document
      .querySelector<HTMLButtonElement>('.mobile-roadmap-open-timeline button')
      ?.focus({ preventScroll: true })
  }, [mobileLayout])
  useEffectR(() => {
    if (focusPlan && mobile) setMobileLayout('timeline')
  }, [focusPlan?.n])
  useEffectR(() => {
    if (revealTask && mobile) setMobileLayout('timeline')
  }, [revealTask?.n])
  const onOpenIssue = actions.openIssue
  // `wide` = a scope that names no project (All projects, My view); `mine` is
  // the one that also narrows to my own tasks
  const wide = info.wide
  const mine = info.mine

  /* The active "Plan on roadmap" session (spotlight + card + auto-fit); a ref
     mirror lets commit() read it without a stale closure. It is declared this
     high because the rail's SHAPE now depends on which tasks pass the filters,
     and the session's own task is one of them (see `passes`). */
  const [session, setSession] = useStateR<PlanSession | null>(null)
  useUpdateBlocker(!!session)
  const sessionRef = useRefR<PlanSession | null>(null)
  const planRequest = useRefR(0)
  sessionRef.current = session
  useEffectR(
    () => () => {
      sessionRef.current = null
    },
    [],
  )
  const planningBacklog = session && P.issueById[session.issueId]?.status === 'backlog'
  useEffectR(() => {
    if (P.roadmapUndo.disabled || planningBacklog) {
      sessionRef.current = null
      setSession(null)
    }
  }, [P.roadmapUndo.disabled, planningBacklog])
  const undoPlanning = () => {
    // A late workload reply must not re-apply auto-fit after Undo. Ending the
    // planning card also prevents Cancel from restoring its older baseline.
    sessionRef.current = null
    setSession(null)
    P.undoRoadmap()
  }
  /* ---------- view window (per-user, persisted) ----------
     TWO persisted windows, and they are different kinds of thing. `win` is
     where you are looking RIGHT NOW — written on every pan and every span
     pick, so it survives a reload the way a scroll position would if scroll
     positions were worth keeping. `winDefault` is where you WANT to be
     looking: the range ⟲ and `Default window` restore, and the one a person
     who has never panned opens on. It changes only when someone decides it
     should, from the menu's own row.

     It is per-user for the same reason the window itself is: a quarter is the
     right horizon for the person planning it and the wrong one for the person
     shipping this week, and neither of them is wrong. −2w … +6w stays as the
     value everybody starts from, not as the value everybody keeps. */
  // both read INSIDE the initializer, never in the render body: loadUI parses
  // localStorage on every call, and this component re-renders on every pan
  const [winDefault, setWinDefaultState] = useStateR(() =>
    P.sanitizeWin(P.loadUI().roadmapWinDefault),
  )
  // never panned? then open on your default rather than on the built-in —
  // otherwise the setting would only take effect the first time you pressed ⟲
  const [win, setWinState] = useStateR(() => {
    const ui = P.loadUI()
    return P.sanitizeWin(ui.roadmapWin ? ui.roadmapWin : ui.roadmapWinDefault)
  })
  const setWin = (w) => {
    setWinState(w)
    P.saveUI({ roadmapWin: w })
  }
  const { w0, w1 } = P.resolveWin(win)
  const NW = w1 - w0 + 1
  // Planning can bypass toolbar filters, but never the roadmap's status rule.
  const passes = (it: IssueVM) =>
    isRoadmapTaskVisible(it, w0, w1) &&
    ((session && session.issueId === it.id) || P.passesFilters(it, filters))
  /* Is a filter the Clear button can undo switched on? The same question the
     board asks (its `clearable`), and it gates the same two things here: the
     pruning below, and the zero-match note. **Focus** is not one of them: it
     has no button here and App hands this view `focus: false` (deviation
     #241), so it can never narrow the timeline. In My view the two people
     filters are not rendered and `effFilters` forces `mine` on, so neither
     counts there. */
  const clearable =
    (!mine && filters.mine) ||
    filters.assignees.length > 0 ||
    !!filters.priority ||
    !!filters.stale ||
    !!filters.search

  /* Tracks follow the scope's grouping unit: one per sub-project inside a
     project, one per PROJECT across all of them (deviation #47) — a track per
     sub-project of every project would bury the timeline. Alphabetical either
     way; the sort lives here (not in the store) because it is this view's. */
  const allTracks = info.groups.slice().sort((a, b) => a.proj.name.localeCompare(b.proj.name))

  /* One pass to bucket the scoped issues by sub-project; everything below
     reads the buckets. Filtering P.issues per group instead would rescan every
     issue twice per sub-project — on every render, which during a bar drag is
     every pointermove. Two questions come out of the same walk, and they are
     NOT the same question:
     · `held` — which sub-projects does the SCOPE put a task in? My view spans
       every project, so without this the rail would print one empty track per
       project I hold no task in, each labelled with that project's whole
       remaining hours. Null wherever the scope narrows nothing.
     · `bucket` — which of them hold a task that also passes the TOOLBAR
       filters, and which tasks those are. */
  const held = info.only ? new Set() : null
  const bucket = new Map()
  P.issues.forEach((i) => {
    // the scope's own narrowing, then the toolbar's. `filters` already carries
    // My view's `mine` (App derives it), but the scope predicate is what makes
    // the row set honest no matter who passes what
    if (!info.subIdSet.has(i.project) || (info.only && !info.only(i))) return
    if (held) held.add(i.project)
    if (!passes(i)) return
    const b = bucket.get(i.project) || { dated: [], undated: [] }
    ;(i.start != null ? b.dated : b.undated).push(i)
    bucket.set(i.project, b)
  })
  /* Does this sub-project earn a place on the rail? Two independent gates, and
     both altitudes — the track list and the sub-project bands under a track —
     ask this one predicate, so the rail never opens onto a stack of empty
     headings.
     · The SCOPE decides whether it belongs to this roadmap at all.
     · The toolbar filters decide whether it has anything to show right now
       (deviation #50): a project or sub-project the filter empties drops off
       the rail entirely, the same rule the board's lanes and side-boards have
       always followed, rather than standing there as a heading over nothing.
       Gated on `clearable` — with no filter on, every group keeps its place
       whether or not it holds work, so the rail's shape still reads as the
       scope's shape. */
  const shows = (id) => (!held || held.has(id)) && (!clearable || bucket.has(id))
  /* …but only ASK when something is actually narrowing. With both gates open
     `shows` is identically true, so the filter would still differ from the
     whole list in one place: a project with no sub-project at all, whose
     `subIds.some()` is vacuously false. That project's empty track is the
     honest picture of the scope — it is what "the rail's shape is the scope's
     shape" means — and it kept it before either gate existed. */
  const pruning = !!held || clearable
  const tracks = pruning ? allTracks.filter((tr) => tr.subIds.some(shows)) : allTracks
  // the track an issue's sub-project rolls up into
  const trackIdOf = (projectId) => {
    if (!wide) return projectId
    const m = P.metaOf(projectId)
    return m ? m.id : projectId
  }
  /* A milestone flag draws a full-height guide line down the grid, so it reads
     as a deadline for the tracks it crosses — and a flag whose project has no
     track left would rule that line through somebody else's rows. Only a scope
     whose tracks ARE projects can ask that, which is exactly `wide`: inside one
     project the tracks are its sub-projects while its milestones belong to the
     project itself, so there would be no id to match and every flag would
     vanish. With nothing pruned the test is a no-op — every visible project
     has a track, and `info.milestones` holds only those projects' flags.
     The Overview's milestone list is unaffected: it names each one's project
     on the row, so there it is context rather than a claim.
     `tracks.length` guards the one case where the rule has nothing to protect:
     a filter that pruned the rail to nothing leaves no rows for a stray line
     to run through, and the timeline that stays behind the "nothing matches"
     note should be the same frame at every scope — week grid, window, flags. */
  const trackIds = new Set(tracks.map((tr) => tr.proj.id))
  const projMilestones =
    wide && tracks.length ? info.milestones.filter((m) => trackIds.has(m.project)) : info.milestones

  // "Update Estimate" walk — organization-wide (wider than the roadmap's own
  // top-project scope), so it lists everything the user can see
  const [updEst, setUpdEst] = useStateR(false)

  const jump = Math.max(1, Math.ceil(NW * 0.2)) // pan = 20% of the span
  const isDefaultWin = P.sameWin(win, winDefault)
  // whether the DEFAULT itself has been moved off the one everybody starts on
  const winDefaultIsStock = P.sameWin(winDefault, P.DEFAULT_WIN)
  /* saveUINow, not saveUI: this is a decision, not a gesture, and the pan's
     600 ms debounce would lose it to a navigation made straight afterwards. */
  const saveWinDefault = (w) => {
    setWinDefaultState(w)
    P.saveUINow({ roadmapWinDefault: w })
    window.showToast?.(
      P.sameWin(w, P.DEFAULT_WIN)
        ? `Your default window is the standard one again — ${P.winLabel(w)}`
        : `The Roadmap will open on ${P.winLabel(w)} from now on`,
    )
  }
  /* Two popovers, one anchor: the calendar glyph opens the menu, and the
     menu's last row swaps it for the range picker at the same coordinates —
     so "Custom range…" reads as going one level deeper rather than as a
     second thing appearing somewhere else. */
  const [winMenu, setWinMenu] = useStateR(null) // { x, y }
  const [picker, setPicker] = useStateR(null) // { x, y }
  const openWinMenu = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    setWinMenu({ x: r.left + r.width / 2, y: r.bottom + 2 })
  }
  /* A span preset writes BOTH endpoints, off the RESOLVED start — so a pair
     left backwards by an earlier edit comes back forwards, and the endpoint
     KIND is preserved: a relative window stays relative (and goes on following
     today), a pinned one stays pinned. */
  const setSpan = (n) => {
    const mk = (w) =>
      win.start.mode === 'date'
        ? { mode: 'date', value: P.isoFromDate(P.weekToDate(w)) }
        : { mode: 'weeks', value: w - P.TODAY_WEEK }
    setWin({ start: mk(w0), end: mk(w0 + n - 1) })
  }

  // weeks stretch to fill the pane (down to MIN → horizontal scroll takes over)
  const [paneW, setPaneW] = useStateR(0)
  const [rowObserver] = useStateR(createRowObserver)
  const roRef = useRefR(null)
  const paneElRef = useRefR(null)
  const headerElRef = useRefR<HTMLDivElement>(null)
  const paneRefBox = useRefR(null) // stable callback ref — a fresh closure each
  if (!paneRefBox.current) {
    // render would detach/reattach every pass
    paneRefBox.current = (el) => {
      paneElRef.current = el
      rowObserver.setRoot(el)
      if (roRef.current) {
        roRef.current.disconnect()
        roRef.current = null
      }
      if (el) {
        setPaneW(el.clientWidth)
        roRef.current = new ResizeObserver(() => setPaneW(el.clientWidth))
        roRef.current.observe(el)
      }
    }
  }
  const paneRef = paneRefBox.current

  /* The dependency overlay is clipped to the timeline so it never paints over
     the sticky rail (see the <svg/> below). The rail is pinned to the pane's
     left edge, the overlay's coordinates are the content's, so the boundary
     is LABEL_W + however far the pane is scrolled. Read straight off the DOM
     rather than held in state: this changes on every horizontal scroll frame,
     and a re-render per frame would land on top of the bar drags.

     LABEL_W, not GRID_X. The rail is what must never be painted over, and it
     still occupies exactly [scrollLeft, scrollLeft + LABEL_W]; clipping at
     GRID_X instead would cut the gutter width off the left end of every path while the
     grid is scrolled home. Nothing reaches into the gutter band anyway —
     `geom.x0` clamps at GRID_X and a bezier between two points inside the grid
     cannot bow out of it — so the extra gutter width of clip is slack, not cover. */
  const depsRef = useRefR(null)
  const railClip = () => LABEL_W + (paneElRef.current ? paneElRef.current.scrollLeft : 0)
  const syncPinnedHeaders = () => {
    const pane = paneElRef.current
    if (!pane) return
    // These are timeline layout coordinates, so phone rotation does not
    // affect the pin boundary. Keep a departing heading raised while its
    // containing group pushes it out of the scrollport.
    for (const heading of pane.querySelectorAll('[data-roadmap-heading-top]')) {
      const stickyTop = heading.hasAttribute('data-subtrack') ? SUB_STICK : HEAD_STICK
      const pinned = pane.scrollTop + stickyTop >= Number(heading.dataset.roadmapHeadingTop)
      heading.dataset.roadmapPinned = String(pinned)
    }
  }
  const syncRailClip = (scrollLeft) => {
    if (depsRef.current) depsRef.current.style.clipPath = `inset(0 0 0 ${LABEL_W + scrollLeft}px)`
    // Transparent pinned labels share the panel's single tint/blur. Clip
    // scrolling weeks and bars at their edges instead of covering them up.
    for (const el of [paneElRef.current, headerElRef.current, stripBodyRef.current]) {
      if (!el) continue
      if (el.scrollLeft !== scrollLeft) el.scrollLeft = scrollLeft
      el.style.setProperty('--roadmap-scroll-left', `${scrollLeft}px`)
      el.style.setProperty('--roadmap-rail-clip', `${Math.max(0, scrollLeft - GUTTER_W)}px`)
    }
  }

  /* ---------- resource strip plumbing ---------- */
  // strip sizing: "normal" shares the pane, "max" fills the space below the
  // week header, "min" leaves only the strip's header bar
  const [stripMode, setStripMode] = useStateR('normal')
  useEffectR(() => {
    if (!mobile) return
    // On a small phone, the sticky week/project headings otherwise consume
    // every task row. Start with Team's header; its expand controls still
    // reveal the people or give the whole panel to utilization.
    const fitPhone = () => {
      if (Math.min(innerWidth, innerHeight) < 360)
        setStripMode((mode) => (mode === 'normal' ? 'min' : mode))
    }
    fitPhone()
    window.addEventListener('resize', fitPhone)
    return () => window.removeEventListener('resize', fitPhone)
  }, [mobile])
  const taskScrollTop = useRefR<number | null>(null)
  const changeStripMode = (mode) => {
    if (mode === 'max') taskScrollTop.current = paneElRef.current?.scrollTop ?? 0
    setStripMode(mode)
  }
  // Hiding the task rows clamps the pane's scrollTop. Put it back when the
  // rows return so expanding Team does not lose the reader's place.
  useEffectR(() => {
    if (stripMode !== 'max' && taskScrollTop.current !== null && paneElRef.current) {
      paneElRef.current.scrollTop = taskScrollTop.current
      taskScrollTop.current = null
    }
  }, [stripMode])
  // person clicked in the strip: their bars ring, other rows fade. The
  // EFFECTIVE highlight is derived below (hl) — it suspends while the person
  // is out of the strip (filters, window, reassignment), so a stale selection
  // can never dim the whole roadmap with no visible cause.
  const [hlUser, setHlUser] = useStateR(null)
  const stripPanelRef = useRefR<HTMLElement | null>(null)
  const toolbarRef = useRefR<HTMLDivElement | null>(null)
  useEffectR(() => {
    if (!hlUser) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHlUser(null)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (stripPanelRef.current?.contains(target) || toolbarRef.current?.contains(target)) return
      // Filter popovers render in portals. Their trigger's aria-controls
      // connects both desktop and landscape menus back to this toolbar.
      const menu = target instanceof Element ? target.closest('[role="dialog"][id]') : null
      if (
        menu &&
        [...(toolbarRef.current?.querySelectorAll('[aria-controls]') ?? [])].some(
          (trigger) => trigger.getAttribute('aria-controls') === menu.id,
        )
      )
        return
      setHlUser(null)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [hlUser])
  const [resourceWeek, setResourceWeek] = useStateR<number | null>(null)
  // total height shared by the roadmap pane and the resource strip
  const [splitAreaH, setSplitAreaH] = useStateR(0)
  const splitRoRef = useRefR(null)
  const splitRefBox = useRefR(null)
  if (!splitRefBox.current) {
    splitRefBox.current = (el) => {
      if (splitRoRef.current) {
        splitRoRef.current.disconnect()
        splitRoRef.current = null
      }
      if (el) {
        setSplitAreaH(el.clientHeight)
        splitRoRef.current = new ResizeObserver(() => setSplitAreaH(el.clientHeight))
        splitRoRef.current.observe(el)
      }
    }
  }
  // The two panes share a horizontal scroll origin, including keyboard focus
  // moving into another utilization week. Empty strips cannot drive the pane.
  const stripBodyRef = useRefR(null)
  const stripBodyRefBox = useRefR(null)
  if (!stripBodyRefBox.current) {
    stripBodyRefBox.current = (el) => {
      stripBodyRef.current = el
      if (el && paneElRef.current) el.scrollLeft = paneElRef.current.scrollLeft
    }
  }
  // re-pin after every render: when the strip empties (browser clamps its
  // scrollLeft to 0) and later repopulates, the scroller never remounts, so
  // neither the mount sync above nor a pane scroll event would re-align it
  useLayoutEffectR(() => {
    if (paneElRef.current) {
      syncRailClip(paneElRef.current.scrollLeft)
      syncPinnedHeaders()
    }
  })
  /* The gutters come off the top: they are not week columns, so a week must
     not be sized as though it could spend their pixels — that would overflow
     the pane by exactly 2 × GUTTER_W and put a horizontal scrollbar under the
     default window. */
  const weekW = paneW ? Math.max(MIN_WEEK_W, (paneW - GRID_X - GUTTER_W) / NW) : BASE_WEEK_W

  const revealEdge = useCallback(
    (side: 'before' | 'after', endpoint: number) => {
      setWin(P.shiftWin(win, endpoint - (side === 'before' ? w0 : w1)))
      syncRailClip(side === 'before' ? 0 : Math.max(0, GRID_X + NW * weekW + GUTTER_W - paneW))
    },
    [win, w0, w1, NW, weekW, paneW],
  )

  // live (uncommitted) drag positions; committed values live on the issues
  const [live, setLive] = useStateR({})
  useUpdateBlocker(Object.keys(live).length > 0)
  const liveRef = useRefR({})
  const draftEpoch = useRefR(P.gridEpoch)
  const draftCurrent = draftEpoch.current === P.gridEpoch
  const getS = (it) => (draftCurrent && live[it.id] ? live[it.id].start : it.start)
  const getE = (it) => (draftCurrent && live[it.id] ? live[it.id].end : it.end)
  const onSched = useCallback((id, start, end) => {
    const n = { ...liveRef.current, [id]: { start, end } }
    liveRef.current = n
    setLive(n)
  }, [])
  useEffectR(() => {
    // A realtime status/date change can hide a bar during a drag. Its removed
    // pointer target may never release, so discard that invisible draft here.
    const entries = Object.entries(liveRef.current)
    const visible = entries.filter(([id]) => {
      const it = P.issueById[id]
      return it && isRoadmapTaskVisible(it, w0, w1)
    })
    if (visible.length === entries.length) return
    const next = Object.fromEntries(visible)
    liveRef.current = next
    setLive(next)
  })
  const commit = useCallback((id, epoch) => {
    const l = liveRef.current[id]
    liveRef.current = {}
    setLive({})
    // the grid re-anchored mid-drag: the held positions are OLD-grid units and
    // would silently write dates the user never saw — discard the gesture
    // (pickers/modals don't need this: they re-render their dates live)
    if (epoch !== undefined && epoch !== P.gridEpoch) {
      window.showToast?.('The week grid changed mid-drag — reschedule discarded')
      return
    }
    const it = P.issueById[id]
    if (!l || !it) return
    const sess = sessionRef.current
    // auto-fit: the planned issue's end follows the owner's free capacity —
    // a move sets the start and recomputes the end; dragging the end is
    // overridden by the same recompute ("checked against the rest of the plan")
    if (
      sess &&
      sess.issueId === id &&
      sess.autoFit &&
      !P.isGroup(it) &&
      it.owner &&
      sess.loadOwner === it.owner &&
      sess.loadEpoch === P.gridEpoch &&
      it.remaining > 0 &&
      sess.load
    ) {
      // the fit consumes capacity from the week the remaining hours were
      // measured (never before the dragged start) — the same anchor the delay
      // projection walks from, so the fitted end and the status agree
      const from = it.remainingSet != null ? Math.max(l.start, it.remainingSet) : l.start
      const end = fitEndWeek(
        from,
        it.remaining,
        capacityFor(it),
        committedByWeek(sess.load, it.uuid),
      )
      if (l.start !== it.start || end !== it.end) P.updateIssue(id, { start: l.start, end })
      return
    }
    // a drag that came back to (or was pinned at) its committed position is a
    // no-op: don't write, don't log 'rescheduled' — and don't let the store's
    // envelope clamp "repair" a legacy-violating bar the user merely poked
    if (l.start !== it.start || l.end !== it.end) P.updateIssue(id, { start: l.start, end: l.end })
  }, [])

  // milestone live drag
  const [msLive, setMsLive] = useStateR({})
  useUpdateBlocker(Object.keys(msLive).length > 0)
  const msLiveRef = useRefR({})
  const msWeek = (m) => (draftCurrent && msLive[m.id] != null ? msLive[m.id] : m.week)
  const msOnLive = (id, w) => {
    const n = { ...msLiveRef.current, [id]: w }
    msLiveRef.current = n
    setMsLive(n)
  }
  const msCommit = (id, epoch) => {
    const w = msLiveRef.current[id]
    msLiveRef.current = {}
    setMsLive({})
    // same mid-drag grid-re-anchor guard as the bar commit above
    if (epoch !== undefined && epoch !== P.gridEpoch) {
      window.showToast?.('The week grid changed mid-drag — move discarded')
      return
    }
    if (w != null) P.setMilestone(id, w)
  }
  useLayoutEffectR(() => {
    if (draftEpoch.current === P.gridEpoch) return
    draftEpoch.current = P.gridEpoch
    liveRef.current = {}
    msLiveRef.current = {}
    setLive({})
    setMsLive({})
    setResourceWeek(null)
  }, [P.gridEpoch])

  /* Tracks and their sub-project headers both start open, and both fold from
     this ONE set (a project id and a sub-project id can never collide). It
     holds what is CLOSED, not what is open, so that a group the user has never
     seen — a sub-project or project created, moved in, or arriving by realtime
     after this mount — renders expanded instead of silently hiding its rows. */
  const [collapsed, setCollapsed] = useStateR(() => new Set())
  const isOpen = (id) => !collapsed.has(id)
  const toggle = useCallback(
    (id) =>
      setCollapsed((s) => {
        const n = new Set(s)
        n.has(id) ? n.delete(id) : n.add(id)
        return n
      }),
    [],
  )
  /* Every foldable heading the rail can hold — the tracks, plus the
     sub-project bands where a track is not simply itself (the same test the
     row build makes below). Read off the TRACKS, not the emitted rows: a band
     inside a closed track has no row, and must still fold with the rest so
     opening its track back up agrees with what the master toggle said.
     TWO lists, because the master toggle's halves ask different questions —
     they were the same list until a transient filter could shrink the rail:
     · `groupIds` — what is on screen right now. The button's LABEL reads this:
       it has to describe what clicking it does to the rail you can see.
     · `scopeGroupIds` — that, plus whatever the toolbar filter is hiding at
       this moment. Collapse-all WRITES this, for exactly the reason it already
       reaches a band inside a folded track: the fold is a fact about the rail,
       not about the rows that happen to be rendered. Writing the visible list
       instead would silently discard the fold state of everything the filter
       pruned, so clearing the search would hand back a rail unfolded in places
       the user had folded. A SCOPE switch still drops its ids — this list is
       built from this scope's own tracks, so nothing accumulates across one. */
  const groupIds = []
  const scopeGroupIds = []
  const onScreen = new Set(tracks.map((tr) => tr.proj.id))
  allTracks.forEach((tr) => {
    if (held && !tr.subIds.some((id) => held.has(id))) return // not this scope's
    const shown = onScreen.has(tr.proj.id)
    scopeGroupIds.push(tr.proj.id)
    if (shown) groupIds.push(tr.proj.id)
    if (tr.subIds.length === 1 && tr.subIds[0] === tr.proj.id) return
    tr.subIds.forEach((id) => {
      if (!P.project(id) || (held && !held.has(id))) return
      scopeGroupIds.push(id)
      if (shown && shows(id)) groupIds.push(id)
    })
  })
  // one master toggle in the column head: anything folded → open everything,
  // else fold everything. The set holds what is CLOSED, so expand-all empties
  // it and collapse-all rewrites it as exactly this scope's headings — either
  // way ids left behind by a scope switch are dropped rather than accumulated.
  const anyCollapsed = groupIds.some((id) => collapsed.has(id))
  const foldAll = () => setCollapsed(anyCollapsed ? new Set() : new Set(scopeGroupIds))

  /* Planning sessions preserve original dates for Cancel and size auto-fit to
     the effective owner's capacity. focusPlan.n distinguishes repeat requests;
     onFocusConsumed acknowledges each one. Resolve owner capacity on every use
     so reassignment or review transitions update both workload and capacity.
     Unowned tasks use the default but cannot auto-fit. */
  const capacityFor = (it) => plannableHoursOf(it?.owner ? P.user(it.owner) : null)
  const autoFitEnd = (id, startW, load, capacity, uuid, remaining) => {
    // same measurement-week anchor as the drag commit and the delay projection
    const rs = P.issueById[id]?.remainingSet
    const from = rs != null ? Math.max(startW, rs) : startW
    P.updateIssue(id, {
      start: startW,
      end: fitEndWeek(from, remaining, capacity, committedByWeek(load, uuid)),
    })
  }
  const receivePlanningLoad = (s: PlanSession, load: LoadItem[] | null) => {
    const loaded = { ...s, load, loading: false, fitOnLoad: false }
    sessionRef.current = loaded
    setSession(loaded)
    const it = P.issueById[s.issueId]
    // Initial placement waits for valid workload, including a reload after
    // the grid changes. Later reloads leave the user's chosen dates alone.
    if (
      s.fitOnLoad &&
      s.autoFit &&
      load &&
      it?.owner &&
      !P.isGroup(it) &&
      it.remaining > 0 &&
      it.start != null
    )
      autoFitEnd(it.id, it.start, load, capacityFor(it), it.uuid, it.remaining)
  }
  const toggleAutoFit = () => {
    const s = sessionRef.current
    if (!s) return
    const autoFit = !s.autoFit
    setSession({ ...s, autoFit })
    const it = P.issueById[s.issueId]
    // side effect OUTSIDE the state updater — a store write there would setState
    // on App (its store subscription) mid-render
    if (
      autoFit &&
      it?.owner &&
      s.loadOwner === it.owner &&
      s.loadEpoch === P.gridEpoch &&
      !P.isGroup(it) &&
      it.remaining > 0 &&
      s.load &&
      it.start != null
    )
      autoFitEnd(s.issueId, it.start, s.load, capacityFor(it), it.uuid, it.remaining)
  }
  const confirmPlanning = () => {
    const s = sessionRef.current
    sessionRef.current = null
    setSession(null)
    if (s) window.showToast?.(`Planned ${s.issueId}`)
  }
  const cancelPlanning = () => {
    const s = sessionRef.current
    sessionRef.current = null
    if (s && P.issueById[s.issueId]) P.updateIssue(s.issueId, restoreWeekDates(s.orig))
    setSession(null)
  }
  /* The two ways here that must SHOW one task (planning and the read-only
     reveal) share these steps. `openTo` gives the timeline its pane back (a
     maxed strip hides it) and opens the task's track and, where they differ,
     the sub-project header under it. */
  const openTo = (it: IssueVM) => {
    setStripMode((m) => (m === 'max' ? 'normal' : m))
    const track = trackIdOf(it.project)
    setCollapsed((s) => {
      if (!s.has(track) && !s.has(it.project)) return s
      const n = new Set(s)
      n.delete(track)
      n.delete(it.project)
      return n
    })
  }
  /* Pan the window to include the task's bar, then center it below the
     pinned headings once the expanded groups, restored task pane and new date
     window have laid out (a task with no bar centers its revealed row).
     `done` runs in that same frame; the returned cleanup cancels the frames,
     so a consumer that clears its signal must do it through `done`. */
  const bringIntoView = (id: string, done?: () => void) => {
    const it = P.issueById[id]
    const ps = it ? it.start : null,
      pe = it ? it.end : null
    if (ps != null) {
      const { w0: cw0, w1: cw1 } = P.resolveWin(win)
      if (ps < cw0 + 1 || pe > cw1 - 1) {
        const pad = 2
        setWin({
          start: { mode: 'date', value: P.isoFromDate(P.weekToDate(ps - pad)) },
          end: { mode: 'date', value: P.isoFromDate(P.weekToDate(pe + pad)) },
        })
      }
    }
    const track = it ? trackIdOf(it.project) : null
    let r1 = 0,
      r2 = 0
    r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        const pane = paneElRef.current
        const el = pane?.querySelector(`[data-bar="${id}"]`)
        const row =
          el?.closest('[data-roadmap-task-top]') ||
          pane?.querySelector(`[data-roadmap-revealed="${id}"]`)
        if (pane && it && row) {
          const stickyH = ROW_H.track + 1 + (track !== it.project ? ROW_H.sub + 1 : 0)
          // Layout coordinates also work in the phone's rotated timeline.
          // Center below pinned headings and to the right of the name rail;
          // the scrollport clamps naturally at either end of a short list.
          pane.scrollTo({
            top:
              Number(row.dataset.roadmapTaskTop) +
              (el ? el.offsetTop + el.offsetHeight / 2 : row.offsetHeight / 2) -
              (pane.clientHeight + stickyH) / 2,
            left: el
              ? GRID_X + el.offsetLeft + el.offsetWidth / 2 - (pane.clientWidth + LABEL_W) / 2
              : pane.scrollLeft,
            behavior: 'smooth',
          })
        }
        done?.()
      })
    })
    return () => {
      cancelAnimationFrame(r1)
      cancelAnimationFrame(r2)
    }
  }
  useEffectR(() => {
    if (!focusPlan) return
    const request = ++planRequest.current
    const loadEpoch = P.gridEpoch
    const undoDisabledAtStart = P.roadmapUndo.disabled
    const it = P.issueById[focusPlan.id]
    if (!it) {
      onFocusConsumed?.()
      return
    }
    // The task can change after the detail window requested planning.
    if (it.status === 'backlog') {
      window.showToast?.('Move this task out of Backlog before planning it on the roadmap')
      onFocusConsumed?.()
      return
    }
    // the planning task must be visible and draggable: a bar the session
    // can't show is a bar the session can't plan
    openTo(it)
    const wasUnscheduled = it.start == null
    const orig = captureWeekDates(it)
    // give an unscheduled issue a provisional bar to plan (due-capped, like the
    // Plan pickers); auto-fit refines its end once the workload arrives
    if (wasUnscheduled) {
      const dueWeek = it.due ? P.isoToWeek(it.due) : null
      let end = P.TODAY_WEEK + 1
      if (dueWeek != null) end = Math.min(end, dueWeek)
      P.updateIssue(it.id, { start: Math.min(P.TODAY_WEEK, end), end })
    }
    setSession({
      issueId: it.id,
      autoFit: true,
      fitOnLoad: wasUnscheduled,
      orig,
      loadOwner: it.owner ?? null,
      loadEpoch,
      load: null,
      loading: !!it.owner,
    })
    if (it.owner) {
      P.assigneeLoad(it.owner).then((load) => {
        const s = sessionRef.current
        if (
          P.roadmapUndo.disabled !== undoDisabledAtStart ||
          loadEpoch !== P.gridEpoch ||
          request !== planRequest.current ||
          !s ||
          s.issueId !== it.id ||
          P.issueById[it.id]?.owner !== it.owner
        )
          return
        receivePlanningLoad(s, load)
      })
    }
    // Pan to the (possibly just placed) bar and center it. Consuming earlier
    // changes focusPlan and cancels these frames in the effect cleanup
    // before the task can be scrolled into view.
    return bringIntoView(it.id, onFocusConsumed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusPlan?.n])

  /* ---------- read-only reveal (Team sync's Roadmap jump) ----------
     The planning spotlight without the session: show the task and ring its
     bar for a moment. No card opens, nothing is written, and an unscheduled
     task keeps no bar (its row is scrolled to instead). Keyed on
     revealTask.n like focusPlan; `revealed` holds the ring after the signal
     is consumed. */
  const [revealed, setRevealed] = useStateR<{ id: string; n: number } | null>(null)
  useEffectR(() => {
    if (!revealTask) return
    const it = P.issueById[revealTask.id]
    if (!it) {
      onRevealConsumed?.()
      return
    }
    openTo(it)
    setRevealed(revealTask)
    return bringIntoView(it.id, onRevealConsumed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTask?.n])
  useEffectR(() => {
    if (!revealed) return
    const t = window.setTimeout(() => setRevealed(null), REVEAL_MS)
    return () => window.clearTimeout(t)
  }, [revealed?.n])

  const sessionOwner = session ? (P.issueById[session.issueId]?.owner ?? null) : null
  useEffectR(() => {
    const s = sessionRef.current
    if (!s || (s.loadOwner === sessionOwner && s.loadEpoch === P.gridEpoch)) return
    // Workload indexes belong to both an owner and a grid. A handoff or
    // re-anchor invalidates them, including any pending response.
    const request = ++planRequest.current
    const loadEpoch = P.gridEpoch
    const refreshed = {
      ...s,
      fitOnLoad: s.loadOwner === sessionOwner && s.fitOnLoad,
      loadOwner: sessionOwner,
      loadEpoch,
      load: null,
      loading: !!sessionOwner,
    }
    sessionRef.current = refreshed
    setSession(refreshed)
    if (!sessionOwner) return
    P.assigneeLoad(sessionOwner).then((load) => {
      const current = sessionRef.current
      if (
        request !== planRequest.current ||
        loadEpoch !== P.gridEpoch ||
        !current ||
        current.issueId !== s.issueId ||
        P.issueById[s.issueId]?.owner !== sessionOwner
      )
        return
      receivePlanningLoad(current, load)
    })
  }, [session?.issueId, sessionOwner, P.gridEpoch])

  /* WHAT THE WINDOW IS, in words — the accessible name and the tooltip of a
     glyph that has no label. Two endpoint chips used to say this at rest, in
     193px of toolbar; the ruler under the glyph says it in full and nine times
     over, so the button only has to answer when asked. */
  const winSays = `View window: ${P.fmtRange(w0, w1)}, ${NW} weeks`

  // Keep controls available in empty states so filters can be cleared and
  // estimates opened. Pass moves explicitly and defer autoArrange through the
  // click handler: empty returns occur before those bindings are initialized.
  const toolbarRow = (moves: { id: string; start: number; end: number }[]) => (
    /* The 12px top inset combines with the shell's 12px bottom inset for
       a 24px section gap. Controls sit 8px above the timeline. */
    // This hook remains mounted for empty scopes as well as the full grid.
    <div
      ref={toolbarRef}
      data-roadmap-toolbar
      style={{ padding: mobile ? '8px 0 12px' : `12px ${canvasPadX}px 8px` }}
      className="[display:flex] [gap:8px] [background:var(--bg)] [flex-wrap:wrap] [align-items:center] [justify-content:center] [flex-shrink:0]"
    >
      {/* Filters and actions wrap as separate groups while sharing one control well. */}
      <div
        data-filter-well
        className="flex min-w-0 flex-wrap items-center justify-center gap-1 rounded-md border border-border bg-background p-1"
      >
        <div data-filter-group className="flex min-w-0 flex-wrap items-center justify-center gap-1">
          {filterControls}
        </div>

        {/* the verbs wear the well's shape — quiet, the tighter radius its
            corners leave room for — the way ViewFilters' `ground` decides it */}
        <div data-roadmap-verbs className="flex shrink-0 items-center gap-1">
          {/* "Estimates" — the button names what the window is about; the
            window it opens keeps its "Update Estimate" title (deviation #236).
            Never disabled — an empty scope opens the window with its note
            instead (deviation #28). The walk is organization-wide anyway, so
            it needs nothing from the scope and stays on in both sentinel scopes. */}
          <Button
            type="button"
            variant="quiet"
            className="rounded-sm"
            data-ue-open
            onClick={() => setUpdEst(true)}
            title="Review remaining time by assignee"
          >
            <Icon name="clockFading" size={16} />
            Estimates
          </Button>
          {/* a milestone lands on ONE project's roadmap (0078) — across every
            them there is no project to put it on, so the button belongs to a
            project scope. Existing flags still render and still drag.
            "Milestone", not "New milestone": the row it now shares with the
            filters cannot afford the word, the diamond in front already says
            which kind of thing, and the shorter label fits beside the other
            verbs. */}
          {!wide && P.canWrite(info.id) && (
            <Button
              type="button"
              variant="quiet"
              className="rounded-sm"
              data-new-milestone
              onClick={() => actions.newMilestone({})}
            >
              <Icon name="diamond" size={16} />
              Milestone
            </Button>
          )}
          {/* "Auto-move" (deviation #236; "Auto-correct" before that, and
            "Auto-schedule" before that): it MOVES the tasks whose dates
            contradict a dependency they already have — after their blockers —
            and it can only ever be pressed when there are some. Neither old
            name said that: one promised a planner that fills an empty
            timeline, the other a judgement about what is correct. The
            `data-auto-correct` hook keeps its name — renaming one is a
            breaking change for the drives. */}
          <Button
            type="button"
            variant="quiet"
            className="rounded-sm"
            data-auto-correct
            onClick={() => autoArrange()}
            disabled={moves.length === 0}
            title={
              moves.length
                ? 'Move ' +
                  moves.length +
                  ' blocked task' +
                  (moves.length > 1 ? 's' : '') +
                  ' after their blockers, including dependent tasks'
                : 'No task starts before its blocker ends'
            }
          >
            <Icon name="arrowRightFromLine" size={16} />
            Auto-move
            {moves.length > 0 && (
              <span className="!font-mono [font-size:var(--fs-xs)] [background:var(--accent-soft)] [color:var(--text-1)] [padding:1px_6px] [border-radius:var(--r-lg)]">
                {moves.length}
              </span>
            )}
          </Button>
          <RoadmapUndo ground="well" onUndo={undoPlanning} />
        </div>
      </div>
    </div>
  )

  /* THE WINDOW'S TWO POPOVERS, in one place: the menu behind the calendar
     glyph and the range picker behind the menu's last row. Rendered by both
     the empty frame and the grid below, because the glyph they hang off is in
     the header — and an empty roadmap still has a header. */
  const winPops = (
    <>
      {winMenu && (
        <WinMenu
          x={winMenu.x}
          y={winMenu.y}
          span={NW}
          isDefault={isDefaultWin}
          defaultWin={winDefault}
          defaultIsStock={winDefaultIsStock}
          onSpan={setSpan}
          onDefault={() => setWin(winDefault)}
          onSaveDefault={() => saveWinDefault(win)}
          // forgetting also LEAVES you on the stock default rather than on a
          // range that is no longer anybody's default — the row says "go back"
          onForgetDefault={() => {
            saveWinDefault(P.DEFAULT_WIN)
            setWin(P.DEFAULT_WIN)
          }}
          onCustom={() => {
            setPicker({ x: winMenu.x, y: winMenu.y })
            setWinMenu(null)
          }}
          onClose={() => setWinMenu(null)}
        />
      )}
      {picker && (
        <WinRangePicker
          x={picker.x}
          y={picker.y}
          win={win}
          onApply={(w) => setWin(w)}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  )

  /* The frame an empty roadmap keeps: the toolbar and the estimate walk its
     button can open — everything that still has something to do when there is
     no grid under it. The window controls are NOT here: they live in the
     timeline's header, and an empty scope has no timeline. */
  const showMobileAgenda =
    mobile && mobileLayout !== 'timeline' && !session && !focusPlan && !revealTask
  const mobileAgenda = (corrections: number, onAutoCorrect: () => void) => (
    <>
      <MobileRoadmap
        info={info}
        windowStart={w0}
        windowEnd={w1}
        filters={filters}
        filterControls={filterControls}
        actions={actions}
        onTimeline={() => setMobileLayout('timeline')}
        onUpdateEstimate={() => setUpdEst(true)}
        corrections={corrections}
        onAutoCorrect={onAutoCorrect}
        undoControls={<RoadmapUndo onUndo={undoPlanning} />}
        section={mobileAgendaSection}
        onSectionChange={setMobileAgendaSection}
        taskState={mobileTaskState}
        onTaskStateChange={setMobileTaskState}
      />
      {updEst && <UpdateEstimateModal onClose={() => setUpdEst(false)} />}
    </>
  )
  const withMobileTimeline = (timeline: React.ReactNode) =>
    mobile ? (
      <LandscapeRoadmap
        title={info.name}
        planning={!!session}
        onClose={() => {
          if (sessionRef.current) cancelPlanning()
          returnToAgenda.current = true
          setMobileLayout('agenda')
        }}
      >
        {timeline}
      </LandscapeRoadmap>
    ) : (
      timeline
    )
  const timelineToolbar = (moves: { id: string; start: number; end: number }[]) =>
    mobile ? (
      <details className="mobile-roadmap-timeline-tools mobile-roadmap-tools">
        <summary>
          <Icon name="sliders" size={16} />
          Filters &amp; planning
        </summary>
        {toolbarRow(moves)}
      </details>
    ) : (
      <WorkspaceToolbar>{toolbarRow(moves)}</WorkspaceToolbar>
    )
  const emptyFrame = (note: React.ReactNode) =>
    showMobileAgenda
      ? mobileAgenda(0, () => {})
      : withMobileTimeline(
          <div className="roadmap-view [flex:1] [display:flex] [flex-direction:column] [overflow:hidden] [background:var(--bg)]">
            {timelineToolbar([])}
            {note}
            {updEst && <UpdateEstimateModal onClose={() => setUpdEst(false)} />}
          </div>,
        )

  /* ---------- empty state ---------- */
  if (info.subIds.length === 0) {
    if (wide) {
      return emptyFrame(
        <EmptyState
          icon="timeline"
          title="Nothing to schedule yet"
          hint={
            info.metas.length === 0
              ? 'No projects are available to you yet.'
              : 'Tasks live in sub-projects.'
          }
        />,
      )
    }
    return emptyFrame(
      <EmptyState
        icon="timeline"
        title="Nothing to schedule yet"
        hint="Tasks live in sub-projects."
        actionLabel={P.canWrite(info.id) ? 'New sub-project' : undefined}
        onAction={() => actions.newProject({ parent: info.id })}
      />,
    )
  }
  /* My view empties for a reason of its own, and the test above can't see it:
     the sub-projects all exist, they just hold none of my work — so the rail
     is empty while `subIds` is not. Without this it renders as a bare grid of
     weeks with nothing in it and no explanation. (The Board and Overview reach
     the same state through their own `scoped.length === 0`.) Asked of the
     SCOPE's own set, never of `tracks`: since deviation #50 a toolbar filter
     can empty the rail too, and that has its own note — one the Clear button
     can actually act on. */
  if (mine && held && held.size === 0) {
    return emptyFrame(<EmptyState icon="user" title="Nothing assigned to you" />)
  }

  /* Build rows; tasks within a group ordered by COMMITTED start date, so the
     list re-sorts only when a drag is released, never mid-drag.

     A track holding several sub-projects (a sentinel scope) gets one **sub-project
     header** per sub-project, so the timeline reads project → sub-project →
     task instead of dropping every discipline's work into one flat list. The
     headers collapse from the same `collapsed` set as the tracks do — project
     and sub-project ids can't collide — so folding one discipline away works
     exactly like folding a track. Inside one project the track already IS the
     sub-project, so there is nothing to insert. */
  const emit = (out, subIds, proj, pid) => {
    const dated = [],
      undated = []
    subIds.forEach((id) => {
      const b = bucket.get(id)
      if (b) {
        dated.push(...b.dated)
        undated.push(...b.undated)
      }
    })
    dated
      .sort((a, b) => a.start - b.start)
      .forEach((t) => {
        out.push({ kind: 'task', proj, issue: t, pid })
      })
    // undated issues after the scheduled rows (due-date order, undated last)
    undated
      .sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : 0))
      .forEach((t) => {
        out.push({ kind: 'unsched', proj, issue: t, pid })
      })
  }
  const rows = []
  tracks.forEach((tr) => {
    const proj = tr.proj
    const pid = proj.id
    rows.push({ kind: 'track', proj, pid, subIds: tr.subIds })
    if (!isOpen(pid)) return
    if (tr.subIds.length === 1 && tr.subIds[0] === pid) {
      emit(rows, tr.subIds, proj, pid)
      return
    }
    // the same rule the track list follows, one altitude down: a discipline I
    // hold no task in — or that the filter row has emptied — gets no band
    // either, or the track opens onto a stack of empty headings
    tr.subIds
      .filter(shows)
      .map((id) => P.project(id))
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((sp) => {
        rows.push({ kind: 'sub', proj: sp, pid: sp.id, parentPid: pid, subIds: [sp.id] })
        if (isOpen(sp.id)) emit(rows, [sp.id], sp, sp.id)
      })
  })

  // one indent rule for the whole rail: task rows step past a sub-project
  // header only where the roadmap actually has them
  const hasSubHeads = rows.some((r) => r.kind === 'sub')
  /* Every track hides itself when a filter empties it, so a zero-match filter
     leaves the rail bare — say so, the same words and the same one action the
     board's note carries. It stays INSIDE the timeline rather than replacing
     it with a full-screen empty state: the window controls, the week grid and
     the milestone flags are still the answer to "what am I looking at", and a
     filter is a thing you undo, not a state you are in. */
  const noMatches = clearable && tracks.length === 0

  // vertical layout + bar geometry for dependency arrows (windowed bars only)
  const laid = []
  let top = 0
  const geom = {}
  rows.forEach((row) => {
    const h = ROW_H[row.kind]
    laid.push({ row, top, h })
    if (row.kind === 'task' && getS(row.issue) != null) {
      const s = getS(row.issue),
        e = getE(row.issue)
      if (e >= w0 && s <= w1) {
        const barMid = 8 + 10
        // clamped to the grid edges: a clipped bar's arrow must anchor at its
        // visible edge, not at virtual coordinates past the timeline border
        // GRID_X: week 0 starts after the rail AND after the gutter the back
        // arrow stands in. Reading these off LABEL_W would point them all into the
        // gutter instead of at the bars they connect.
        geom[row.issue.id] = {
          x0: Math.max(GRID_X, GRID_X + (s - w0) * weekW),
          x1: Math.min(GRID_X + NW * weekW, GRID_X + (e + 1 - w0) * weekW - 6),
          yc: top + barMid,
        }
      }
    }
    top += h + 1
  })
  const totalH = top

  /* ---------- resource strip: people owning work in the visible window ---------- */
  // membership follows what the roadmap displays: scoped issues that pass the
  // filters and intersect the window (collapsed tracks still count — folding a
  // track hides its rows, it doesn't remove them from the roadmap)
  const stripUsers = (() => {
    const ids = new Set()
    P.issues.forEach((it) => {
      if (!info.subIdSet.has(it.project) || (info.only && !info.only(it))) return
      if (it.start == null || !it.owner) return
      if (!passes(it)) return
      if (getE(it) < w0 || getS(it) > w1) return
      ids.add(it.owner)
    })
    return P.users.filter((u) => ids.has(u.id)).sort((a, b) => a.name.localeCompare(b.name))
  })()
  // effective highlight: only while the selected person is actually in the strip
  const hl = hlUser && stripUsers.some((u) => u.id === hlUser) ? hlUser : null
  const activeResourceWeek =
    stripMode !== 'min' &&
    stripUsers.length > 0 &&
    resourceWeek !== null &&
    resourceWeek >= w0 &&
    resourceWeek <= w1
      ? resourceWeek
      : null
  // Fit all visible people in the heatmap up to a 620px
  // panel. Leave the actual timeline's header, project/sub-project bands and
  // several task rows above it; smaller viewports scroll the remaining people.
  // Header and its rule, the rows, and the panel's two borders.
  const roadContentH = HEAD_H + 1 + totalH + 2
  const splitT = splitAreaH || 480
  const roadMinimum = Math.min(roadContentH, HEAD_H + ROW_H.track + ROW_H.sub + ROW_H.task * 3 + 6)
  const stripCap = Math.min(
    620,
    Math.max(
      stripHeight(Math.min(1, stripUsers.length)),
      splitT - cardGap - canvasPadB - roadMinimum,
    ),
  )
  const stripH =
    stripMode === 'min' ? STRIP_HEAD_H + 2 : Math.min(stripHeight(stripUsers.length), stripCap)

  // dependency pairs (blocker -> blocked), dedup, both bars visible
  const seen = new Set()
  const deps = []
  P.issues.forEach((it) => {
    ;(it.links || []).forEach((l) => {
      let blocker: string, blocked: string
      if (l.type === 'blocked_by') {
        blocker = l.id
        blocked = it.id
      } else if (l.type === 'blocks') {
        blocker = it.id
        blocked = l.id
      } else return
      const key = `${blocker}>${blocked}`
      if (seen.has(key)) return
      seen.add(key)
      if (geom[blocker] && geom[blocked]) deps.push({ blocker, blocked })
    })
  })
  const depColor = (dp) =>
    getE(P.issueById[dp.blocker]) >= getS(P.issueById[dp.blocked])
      ? 'var(--danger)'
      : 'var(--success)'
  const barRing = {}
  deps.forEach((dp) => {
    if (getE(P.issueById[dp.blocker]) >= getS(P.issueById[dp.blocked]))
      barRing[dp.blocked] = 'color-mix(in oklab, var(--danger) 67%, transparent)'
  })

  // Auto-move: push blocked issues past their blockers, cascading.
  // Computed every render so the button can disable itself when there is
  // nothing to move. Weeks are unbounded — no viewport clamp on the result.
  const autoMoves = (() => {
    const pairs = []
    const pseen = new Set()
    P.issues.forEach((it) => {
      ;(it.links || []).forEach((l) => {
        let blocker: string, blocked: string
        if (l.type === 'blocked_by') {
          blocker = l.id
          blocked = it.id
        } else if (l.type === 'blocks') {
          blocker = it.id
          blocked = l.id
        } else return
        const k = `${blocker}>${blocked}`
        if (!pseen.has(k)) {
          pseen.add(k)
          pairs.push({ blocker, blocked })
        }
      })
    })
    // The date envelope (an issue spans its scheduled sub-issues) makes a
    // subtree one schedulable unit: dependencies read EFFECTIVE bounds
    // (own span ∪ scheduled children, recursively) and a push moves the
    // whole subtree by the same delta. Relative positions inside a family
    // are preserved — never "repaired" — so the preview matches what the
    // store's clamps commit and re-runs converge instead of growing a
    // clamped parent further on every click.
    const kids = {}
    P.issues.forEach((it) => {
      if (it.start == null || !it.parent) return
      const par = P.issueById[it.parent]
      if (!par || par.start == null) return // unscheduled parents break the chain
      kids[it.parent] ||= []
      kids[it.parent].push(it.id)
    })
    // some dependencies can never be satisfied by push-forward relaxation:
    // plain dep cycles, deps threading one scheduled parent chain (the
    // envelope drags the blocker along with the blocked), true cross-family
    // runaways. Relaxing them would chase their own tail — with weeks
    // unbounded, committing runaway far-future dates. solvablePairs filters
    // them on a two-layer moves/widens graph (see src/lib/schedule.ts);
    // their red conflict arrows stay on as the signal to untangle by hand.
    const solvable = solvablePairs(
      pairs,
      kids,
      P.issues.filter((it) => it.start != null).map((it) => it.id),
    )
    const work = {}
    P.issues.forEach((it) => {
      if (it.start != null) work[it.id] = { start: it.start, end: it.end }
    })
    // kids only links issues that are in work, and the pickers keep the
    // hierarchy acyclic — the depth caps are a corrupt-data backstop
    const effStart = (id, depth = 0) => {
      let s = work[id].start
      if (depth < 32)
        (kids[id] || []).forEach((k) => {
          s = Math.min(s, effStart(k, depth + 1))
        })
      return s
    }
    const effEnd = (id, depth = 0) => {
      let e = work[id].end
      if (depth < 32)
        (kids[id] || []).forEach((k) => {
          e = Math.max(e, effEnd(k, depth + 1))
        })
      return e
    }
    const push = (id, dw, depth = 0) => {
      work[id].start += dw
      work[id].end += dw
      if (depth < 32)
        (kids[id] || []).forEach((k) => {
          push(k, dw, depth + 1)
        })
    }
    let changed = true,
      guard = 0
    while (changed && guard++ < P.issues.length + 5) {
      changed = false
      solvable.forEach(({ blocker, blocked }) => {
        if (!work[blocker] || !work[blocked]) return
        const need = effEnd(blocker) + 1
        const cur = effStart(blocked)
        if (cur < need) {
          push(blocked, need - cur)
          changed = true
        }
      })
    }
    const moves = []
    Object.keys(work).forEach((id) => {
      const it = P.issueById[id]
      if (work[id].start !== it.start || work[id].end !== it.end)
        moves.push({ id, start: work[id].start, end: work[id].end })
    })
    return moves
  })()
  const autoArrange = () => {
    if (!autoMoves.length) return
    // deepest first: a parent's envelope clamp reads its children's rows, so
    // the children must land their new dates before the parent commits —
    // committing the parent first would clamp it back to the children's OLD
    // spot and the solver would push it again on the next click
    const depth = (id) => {
      let d = 0,
        it = P.issueById[id]
      while (it?.parent && P.issueById[it.parent] && d < 32) {
        d++
        it = P.issueById[it.parent]
      }
      return d
    }
    P.batchRoadmapChanges(() => {
      autoMoves
        .slice()
        .sort((a, b) => depth(b.id) - depth(a.id))
        .forEach((m) => {
          P.updateIssue(m.id, { start: m.start, end: m.end })
        })
    })
    window.showToast?.(
      `Moved ${autoMoves.length} task${autoMoves.length > 1 ? 's' : ''} after their blockers`,
    )
  }

  // month boundaries across the window — the weeks whose first workday opens
  // a new month, so every month line sits on a week boundary (the window's
  // own left edge is not one). With the month band gone these carry the month
  // rhythm on their own: a solid gridline, and a brighter date in the cell
  // that opens the month. Same walk the team strip does.
  const monthStarts = new Set()
  for (let w = w0 + 1; w <= w1; w++) {
    if (P.weekToDate(w).getMonth() !== P.weekToDate(w - 1).getMonth()) monthStarts.add(w)
  }
  const timelineW = NW * weekW
  const dueX = (iso) =>
    ((P.isoToDate(iso).getTime() - P.weekToDate(w0).getTime()) / 86400000) * (weekW / 7)

  // The due tick of a scheduled row: a day-precise line, colored by the
  // judgment its hover text spells out. Null when the due date is outside
  // the window (x === timelineW is the Monday AFTER the last visible week).
  // The judgment is about the DUE date only: with delay tracking (0064) it
  // uses the projected finish; 'behind' alone keeps a green tick — the bar
  // already carries the against-plan warning.
  const dueMark = (iss) => {
    const x = dueX(iss.due)
    if (x < 0 || x >= timelineW) return null
    const dueT = P.isoToDate(iss.due).getTime()
    const endW = getE(iss)
    const wkStart = endW != null ? P.weekToDate(endW).getTime() : null
    const wkEnd = endW != null ? P.weekToDate(endW + 1).getTime() - 86400000 : null
    const di = P.tracksDelay(iss) ? P.delayOf(iss) : null
    let color: string, state: string
    if (P.isDone(iss)) {
      color = 'var(--text-3)'
      state = 'complete'
    } else if (di && di.status === 'late') {
      color = 'var(--danger)'
      state = iss.due < P.TODAY_ISO ? 'overdue' : 'projected to finish after the due date'
    } else if (di && di.fin != null && di.fin === P.isoToWeek(iss.due)) {
      color = 'var(--warn)'
      state = 'tight — projected to finish in the due week'
    } else if (di) {
      color = 'var(--success)'
      state = 'on track — projected to finish before the due date'
    } else if (iss.due < P.TODAY_ISO) {
      color = 'var(--danger)'
      state = 'overdue'
    } else if (wkStart != null && dueT < wkStart) {
      color = 'var(--danger)'
      state = 'planned end is after the due date'
    } else if (wkEnd != null && dueT <= wkEnd) {
      color = 'var(--warn)'
      state = 'tight — due falls in the final planned week'
    } else {
      color = 'var(--success)'
      state = 'on track — plan ends before the due date'
    }
    return { x, color, state }
  }

  // every gridline sits on a week boundary — the first workday of that week:
  // month-start weeks get a solid line (aligned with the header's month
  // segments), every other week a thin dashed one. The today line is the one
  // exception: like a due-date marker it is drawn at DAY precision (TODAY_POS),
  // so it sits inside its week's column on the actual date. It is also the only
  // guide that carries the hook and the tooltip: the line the header used to
  // draw is gone, so `[data-today]` and the date-on-hover live here now — once
  // per row, because the "line" has always been one segment per row rather than
  // one element. The topmost segment is where it begins, directly under the
  // header's bottom border.
  const resourceWeekHighlight = () =>
    activeResourceWeek !== null && (
      <div
        aria-hidden="true"
        data-resource-week-column={activeResourceWeek}
        className="roadmap-resource-week"
        style={{ left: (activeResourceWeek - w0) * weekW, width: weekW }}
      />
    )
  const guidesKey = JSON.stringify([
    P.gridEpoch,
    P.TODAY_ISO,
    P.TODAY_POS,
    w0,
    w1,
    weekW,
    activeResourceWeek,
    projMilestones.map((milestone) => [milestone.id, msWeek(milestone)]),
  ])
  const guides = () => (
    <>
      {resourceWeekHighlight()}
      {Array.from({ length: NW }).map((_, i) => {
        // keyed on the WEEK the gridline stands on (the same identity the
        // week band's cells key on), not the column index
        const w = w0 + i
        return i === 0 ? null : monthStarts.has(w) ? (
          <div
            key={w}
            style={{ left: i * weekW }}
            className="[position:absolute] [top:0] [bottom:0] [width:1px] [background:var(--border-strong)]"
          />
        ) : (
          <div
            key={w}
            style={{ left: i * weekW }}
            className="[position:absolute] [top:0] [bottom:0] [width:0] [border-left:1px_dashed_var(--border)] [opacity:0.6]"
          />
        )
      })}
      {projMilestones
        .filter((m) => msWeek(m) >= w0 && msWeek(m) <= w1)
        .map((m) => (
          <div
            key={m.id}
            style={{
              left: (msWeek(m) - w0) * weekW,
              borderLeft: `1px dashed color-mix(in oklab, ${P.MILESTONE_COLOR} 40%, transparent)`,
            }}
            className="[position:absolute] [top:0] [bottom:0] [width:0]"
          />
        ))}
      {P.TODAY_WEEK >= w0 && P.TODAY_WEEK <= w1 && (
        <HoverTooltip content={`Today, ${P.fmtISO(P.TODAY_ISO)}`}>
          <div
            data-today
            tabIndex={-1}
            style={{ left: (P.TODAY_POS - w0) * weekW }}
            className="[position:absolute] [top:0] [bottom:0] [width:2px] [background:var(--primary)] [opacity:0.9]"
          />
        </HoverTooltip>
      )}
    </>
  )

  /* Heading rows PIN while the rows they head scroll past, so a long track
     never leaves you reading nameless bars. A sticky element travels only
     inside its own containing block, which is why the flat row list is
     regrouped into one container per track and one per sub-project band —
     the track's heading then rides the top of the pane until the track ends
     and the next one pushes it out, and a band's heading does the same one
     step down. Row ORDER, the row heights and the `top` offsets `geom` gave
     the dependency arrows are all untouched: this only nests what was flat.
     A track always opens its group (`rows` is built that way), but the guard
     keeps a stray leading row out of a crash rather than into one. */
  const groups = []
  laid.forEach((L) => {
    if (L.row.kind === 'track') {
      groups.push({ head: L, own: [], bands: [] })
      return
    }
    const g = groups[groups.length - 1]
    if (!g) return
    if (L.row.kind === 'sub') {
      g.bands.push({ head: L, rows: [] })
      return
    }
    ;(g.bands.length ? g.bands[g.bands.length - 1].rows : g.own).push(L)
  })

  if (showMobileAgenda) return mobileAgenda(autoMoves.length, autoArrange)

  return withMobileTimeline(
    <div className="roadmap-view [flex:1] [display:flex] [flex-direction:column] [overflow:hidden] [background:var(--bg)]">
      {/* The row is drawn by `toolbarRow` above, so that the empty states can
          draw it too — see its header for why that matters. */}
      {timelineToolbar(autoMoves)}

      {winPops}

      <div
        ref={splitRefBox.current}
        className="[flex:1] [display:flex] [flex-direction:column] [overflow:hidden]"
      >
        <div
          data-roadmap-panel
          style={{
            margin: `0 ${canvasPadX}px`,
          }}
          className={`flex flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-card ${
            stripMode === 'max' ? 'flex-none' : 'min-h-0 flex-initial'
          }`}
        >
          {/* The panel is as tall as its rows and no taller: a short roadmap
              ends after its last row and Team follows directly beneath it,
              with the canvas showing through the rest. Only when the rows
              outgrow the space Team leaves does the panel shrink and scroll. */}
          {/* The header has its own horizontal viewport, sized to the task
              scrollport so its week columns exclude the vertical scrollbar. */}
          <div className="shrink-0 border-b border-border">
            <div
              data-roadmap-header
              ref={headerElRef}
              style={{ width: paneW || undefined }}
              className="overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              onScroll={(e) => syncRailClip(e.currentTarget.scrollLeft)}
            >
              <div style={{ minWidth: GRID_X + timelineW + GUTTER_W }} className="flex">
                {/* column head: the master fold sits in the chevron column the track
              rows use, so it reads as the one above all of them. Both ride the
              week band's centre line, so the rail's heading and the week
              numbers read as one row. */}
                <div
                  style={{
                    width: LABEL_W,
                    padding: `${HEAD_PAD_T + Math.round((WEEK_BAND_H - 32) / 2)}px 12px 0`,
                  }}
                  className="[flex-shrink:0] [position:sticky] [left:0] [z-index:2] [border-right:1px_solid_var(--border)] [display:flex] [align-items:flex-start] [gap:8px] [font-size:var(--fs-sm)] [font-weight:600] [color:var(--text-1)]"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-rail-fold={anyCollapsed ? 'expand' : 'collapse'}
                    className="size-8"
                    onClick={foldAll}
                    aria-label={
                      anyCollapsed
                        ? 'Expand all projects and sub-projects'
                        : 'Collapse all projects and sub-projects'
                    }
                    title={
                      anyCollapsed
                        ? 'Expand all projects and sub-projects'
                        : 'Collapse all projects and sub-projects'
                    }
                  >
                    <Icon name={anyCollapsed ? 'chevronsDown' : 'chevronsUp'} size={16} />
                  </Button>
                  {/* hooked, because the cell no longer holds only this word: a check
                that read the cell's text to prove the heading says "Task" would
                now be reading the glyphs' company too */}
                  <span data-rail-cap className="[line-height:32px]">
                    Task
                  </span>

                  {/* ═══ THE VIEW WINDOW, in the corner of its own column heading ═══
                The far end of the heading row is the only 100px on this screen
                that was carrying nothing, and it is directly above the rail
                and beside the weeks — so a control for WHICH weeks lands
                between the two things it concerns. Two glyphs, no borders:
                they sit on the header's own ground beside a word, and a pair
                of framed buttons up here would read as a toolbar that had
                slipped into the grid. .iconbtn is already borderless and
                answers on hover, which is the affordance.

                THE RESET ONLY EXISTS WHEN IT CAN DO SOMETHING. A permanently
                dimmed ⟲ is a control you have to check before you can use it;
                absent, its arrival IS the signal that the view has moved off
                the default. It appears to the LEFT of the calendar so the
                calendar — the one that is always there — never moves. */}
                  <span
                    data-win-controls
                    className="[margin-left:auto] [display:inline-flex] [align-items:center] [gap:8px]"
                  >
                    {!isDefaultWin && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-win="reset"
                        className="size-8"
                        onClick={() => setWin(winDefault)}
                        aria-label="Restore the default window"
                        title={`Restore the default window (${P.winLabel(winDefault)})`}
                      >
                        <Icon name="rotateCcw" size={16} />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      data-win="menu"
                      className="size-8"
                      onClick={openWinMenu}
                      aria-expanded={!!winMenu}
                      aria-label={winSays}
                      title={winSays}
                    >
                      <Icon name="calendar" size={16} />
                    </Button>
                  </span>
                </div>
                {/* ═══ THE PAN ARROWS, one at each end of the ruler ═══════════════
              Press the end you want to see more of. They were two of the five
              controls in the toolbar row, where "back" and "forward" had to be
              read as words for a direction the screen was not pointing in;
              here the control IS the edge it moves toward.

              BESIDE the week cells, never over them — that is what the gutter
              is for, and it is why the weeks are sized against a pane
              2 × GUTTER_W narrower. An arrow floating on top of the first
              column would cover the one label that column has.

              STICKY, because past about twenty weeks the cells hit their 24px
              floor and the grid scrolls sideways: an arrow that scrolled away
              with the band would be gone exactly when the window is too wide
              to read. The left one pins against the rail, the right one
              against the pane's edge. */}
                <div
                  style={{
                    width: GUTTER_W,
                    left: LABEL_W,
                    padding: `${HEAD_PAD_T}px 0 ${MS_BAND_H}px`,
                  }}
                  className="roadmap-edge-column roadmap-edge-before [position:sticky] [z-index:3] [display:grid] [place-items:center]"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-win="back"
                    className="size-8"
                    onClick={() => setWin(P.shiftWin(win, -jump))}
                    aria-label={`Back ${jump} weeks`}
                    title={`Back ${jump} week${jump > 1 ? 's' : ''}`}
                  >
                    <Icon name="chevronLeft" size={16} />
                  </Button>
                </div>

                <div
                  style={{
                    width: timelineW,
                    height: HEAD_H,
                    // Keep the week ruler between its two pinned pan controls.
                    clipPath: `inset(0 max(0px, calc(${GRID_X + timelineW + GUTTER_W - paneW}px - var(--roadmap-scroll-left, 0px))) 0 var(--roadmap-scroll-left, 0px))`,
                  }}
                  className="[position:relative] [overflow:hidden]"
                >
                  {resourceWeekHighlight()}
                  {/* week band — the header's only labels now: calendar week number
                over the week's first workday. The week that OPENS a month
                brightens its date (with the month band gone, that plus the
                solid boundary gridline is the month rhythm), and the week
                that opens a YEAR appends it — the one thing the removed band
                said that no week label does. Every cell's full date and
                week-year stay one hover away, in the tooltip. Narrow columns
                drop the date, then the "W". */}
                  {Array.from({ length: NW }).map((_, i) => {
                    const w = w0 + i
                    const wk = P.weekNumberOf(w)
                    const d = P.weekToDate(w)
                    const curWeek = w === P.TODAY_WEEK
                    const opensMonth = monthStarts.has(w)
                    // ≥54 is the width "26 Jan 27" needs — a year that would be cut
                    // off mid-digit is worse than one the tooltip still carries
                    const opensYear =
                      weekW >= 54 &&
                      d.getMonth() === 0 &&
                      (i === 0 || P.weekToDate(w - 1).getFullYear() !== d.getFullYear())
                    return (
                      <HoverTooltip
                        key={w}
                        content={
                          'Week ' +
                          wk.num +
                          ' of ' +
                          wk.year +
                          ' — starts ' +
                          P.fmtFull(d) +
                          (curWeek ? `, today: ${P.fmtISO(P.TODAY_ISO)}` : '')
                        }
                      >
                        <div
                          data-wkcell={w}
                          data-wkcur={curWeek ? '1' : undefined}
                          data-resource-week-active={activeResourceWeek === w || undefined}
                          style={{
                            left: i * weekW,
                            width: weekW,
                            top: HEAD_PAD_T,
                            height: WEEK_BAND_H,
                            borderLeft:
                              i > 0
                                ? opensMonth
                                  ? '1px solid var(--border-strong)'
                                  : '1px dashed var(--border)'
                                : 'none',
                            background:
                              activeResourceWeek === null && curWeek
                                ? 'var(--accent-soft)'
                                : 'transparent',
                          }}
                          className="[position:absolute] [display:flex] [flex-direction:column] [justify-content:center] [gap:1px] [padding:0_0_0_6px] [overflow:hidden]"
                        >
                          <span
                            style={{
                              fontSize: weekW >= 34 ? 'var(--fs-base)' : 'var(--fs-sm)',
                            }}
                            className="!font-mono [font-weight:700] [line-height:1.15] [white-space:nowrap] [color:var(--text-1)]"
                          >
                            {weekW >= 30 ? `W${wk.num}` : wk.num}
                          </span>
                          {weekW >= 46 && (
                            <span
                              style={{
                                fontWeight: opensMonth ? 600 : 500,
                              }}
                              className="[font-size:var(--fs-xs)] [line-height:1.15] [white-space:nowrap] [color:var(--text-2)]"
                            >
                              {P.fmtDate(d) +
                                (opensYear ? ` ${String(d.getFullYear()).slice(2)}` : '')}
                            </span>
                          )}
                        </div>
                      </HoverTooltip>
                    )
                  })}
                  {projMilestones
                    .filter((m) => msWeek(m) >= w0 && msWeek(m) <= w1)
                    .map((m) => (
                      <MilestoneFlag
                        key={m.id}
                        m={m}
                        week={msWeek(m)}
                        w0={w0}
                        w1={w1}
                        weekW={weekW}
                        onLive={msOnLive}
                        onCommit={msCommit}
                        onEdit={actions.editMilestone}
                      />
                    ))}
                  {/* THE TODAY LINE IS NOT DRAWN HERE. It belongs to the grid, and
                it starts under the header's bottom border — where the rows do.
                Run up through this band and it crosses the one row of text the
                header has, striking through a week number to say a thing that
                band already says twice: the current week's cell is tinted and
                its label is in the accent colour. A ruler's own markings are
                what a ruler is for; the line measures what is under it. */}
                </div>

                {/* the forward arrow's gutter — pinned to the pane's right edge for
              the same reason its twin pins to the rail */}
                <div
                  style={{ width: GUTTER_W, padding: `${HEAD_PAD_T}px 0 ${MS_BAND_H}px` }}
                  className="roadmap-edge-column roadmap-edge-after [position:sticky] [right:0] [z-index:3] [display:grid] [place-items:center]"
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-win="fwd"
                    className="size-8"
                    onClick={() => setWin(P.shiftWin(win, jump))}
                    aria-label={`Forward ${jump} weeks`}
                    title={`Forward ${jump} week${jump > 1 ? 's' : ''}`}
                  >
                    <Icon name="chevronRight" size={16} />
                  </Button>
                </div>
              </div>
            </div>
          </div>
          <div
            data-scroll
            ref={paneRef}
            onScroll={(e) => {
              syncRailClip(e.currentTarget.scrollLeft)
              syncPinnedHeaders()
            }}
            className={`[scrollbar-gutter:stable] ${
              stripMode === 'max' ? 'h-0 flex-none overflow-hidden' : 'min-h-0 flex-1 overflow-auto'
            }`}
          >
            {/* Keep a nonempty scroll extent when Team hides the task rows. */}
            <div style={{ minWidth: GRID_X + timelineW + GUTTER_W }} className="min-h-px">
              {/* rows + dependency overlay */}
              <div
                hidden={stripMode === 'max'}
                style={{ width: GRID_X + timelineW + GUTTER_W }}
                className="relative min-w-full"
              >
                {(() => {
                  const renderRow = ({ row, h, top }) => {
                    const isTrack = row.kind === 'track'
                    const isSub = row.kind === 'sub'
                    const isGroup = isTrack || isSub // the two heading kinds
                    const planning = !isGroup && session?.issueId === row.issue.id
                    // planning and a read-only reveal wear the same spotlight
                    const revealing = !isGroup && revealed?.id === row.issue.id
                    const spotlit = planning || revealing
                    const remH = isGroup ? P.remainingIn(row.subIds, info.only) : 0
                    // stale rows fade label contents + timeline cell, NOT the row div:
                    // opacity on the row would wrap the sticky label in a stacking
                    // context and hoist the dependency-arrow overlay above it
                    const stale = !isGroup && P.isStale(row.issue)
                    // a person highlighted in the strip fades everyone else's rows the
                    // same way; the planning row stays fully visible.
                    const hlDim = hl && !isGroup && row.issue.owner !== hl && !spotlit
                    const fade = spotlit ? 1 : (stale ? 0.5 : 1) * (hlDim ? 0.3 : 1)
                    // due ticks belong to scheduled rows (spec §5) — the unsched
                    // pill carries its own due text instead
                    const due = row.kind === 'task' && row.issue.due ? dueMark(row.issue) : null
                    // the bar's highlight ring, shared with its connected edge chips
                    const ring =
                      row.kind !== 'task'
                        ? undefined
                        : spotlit || (hl && row.issue.owner === hl)
                          ? 'var(--primary)'
                          : barRing[row.issue.id]
                    return (
                      <TimelineRow
                        key={row.pid + row.kind + (row.issue?.uuid ?? '')}
                        row={row}
                        top={top}
                        h={h}
                        remH={remH}
                        open={isOpen(row.pid)}
                        planning={planning}
                        revealing={revealing}
                        fade={fade}
                        ring={ring}
                        due={due}
                        start={row.issue ? getS(row.issue) : null}
                        end={row.issue ? getE(row.issue) : null}
                        w0={w0}
                        w1={w1}
                        weekW={weekW}
                        timelineW={timelineW}
                        hasSubHeads={hasSubHeads}
                        workspaceVersion={P.updates.workspace.getSnapshot()}
                        observer={rowObserver}
                        guidesKey={guidesKey}
                        renderGuides={guides}
                        onToggle={toggle}
                        onScope={actions.setScope}
                        onOpen={onOpenIssue}
                        onSchedule={onSched}
                        onCommit={commit}
                        onEdgeReveal={revealEdge}
                      />
                    )
                  }
                  /* One container per track, one per band inside it — the nesting the
             pinned headings need. Nothing else about the rail changes: the
             rows come out in exactly the order `laid` put them in. */
                  return groups.map((g) => (
                    <div key={`track:${g.head.row.pid}`}>
                      {renderRow(g.head)}
                      {g.own.map((L) => renderRow(L))}
                      {g.bands.map((b) => (
                        <div key={`band:${b.head.row.pid}`}>
                          {renderRow(b.head)}
                          {b.rows.map((L) => renderRow(L))}
                        </div>
                      ))}
                    </div>
                  ))
                })()}

                {/* the rail pruned to nothing — sticky-left so the note sits in the
              visible pane, not centred somewhere out along the week grid */}
                {noMatches && (
                  <div
                    className="animate-in fade-in slide-in-from-bottom-1 [position:sticky] [left:0] [display:flex] [flex-direction:column] [align-items:center] [gap:8px] [padding:26px_16px]"
                    data-no-match
                    style={{ width: paneW || GRID_X + timelineW + GUTTER_W }}
                  >
                    <span className="[font-size:var(--fs-base)] [color:var(--text-3)]">
                      Nothing matches your filters
                    </span>
                    <Button type="button" onClick={actions.clearFilters}>
                      Clear filters
                    </Button>
                  </div>
                )}

                {/* Arrows cross heading rows while they scroll normally. Only
                    pinned headings rise above this overlay, covering the
                    segments beneath them without removing the rest of a line.
                    Horizontal clipping keeps all arrows out of the label rail. */}
                {deps.length > 0 && (
                  <svg
                    ref={depsRef}
                    aria-hidden="true"
                    style={{
                      width: GRID_X + timelineW + GUTTER_W,
                      height: totalH,
                      clipPath: `inset(0 0 0 ${railClip()}px)`,
                    }}
                    className="[position:absolute] [left:0] [top:0] [pointer-events:none] [z-index:5] [overflow:visible]"
                  >
                    {deps.map((dp) => {
                      const a = geom[dp.blocker],
                        b = geom[dp.blocked]
                      const x1 = a.x1,
                        y1 = a.yc,
                        x2 = b.x0,
                        y2 = b.yc
                      const c = Math.max(16, Math.abs(x2 - x1) / 2)
                      const d = `M ${x1} ${y1} C ${x1 + c} ${y1}, ${x2 - c} ${y2}, ${x2 - 7} ${y2}`
                      const col = depColor(dp)
                      return (
                        // one arrow per dedup'd pair — the same key `seen` holds
                        <g key={`${dp.blocker}>${dp.blocked}`}>
                          <circle cx={x1} cy={y1} r={3} fill={col} />
                          <path
                            d={d}
                            fill="none"
                            stroke={col}
                            strokeWidth={1.6}
                            strokeOpacity={0.9}
                          />
                          <path d={`M ${x2} ${y2} l -7 -4 l 0 8 Z`} fill={col} />
                        </g>
                      )
                    })}
                  </svg>
                )}
              </div>
            </div>
          </div>
        </div>
        {/* In "max", the week header keeps its natural height and the strip
          fills the remaining canvas. Both retain the same horizontal grid. */}
        <div
          style={{ padding: `${cardGap}px ${canvasPadX}px ${canvasPadB}px` }}
          className={stripMode === 'max' ? 'min-h-0 flex-1' : 'shrink-0'}
        >
          {/* `gutter` keeps the strip's week columns under the roadmap's. The two
          panels are separate scrollers kept in sync by scrollLeft, so a
          timeline that starts a gutter further right and a strip that does not
          would put every load box a fifth of a column off the week it counts. */}
          <ResourceStrip
            users={stripUsers}
            w0={w0}
            w1={w1}
            weekW={weekW}
            labelW={LABEL_W}
            gutter={GUTTER_W}
            height={stripMode === 'max' ? '100%' : stripH}
            info={info}
            panelRef={stripPanelRef}
            bodyRef={stripBodyRefBox.current}
            livePositions={live}
            mode={stripMode}
            onMode={changeStripMode}
            selectedUser={hl}
            onSelectUser={(id) => setHlUser((h) => (h === id ? null : id))}
            filterKey={JSON.stringify(filters)}
            onActiveWeek={setResourceWeek}
            // Horizontal wheel, scrollbar and keyboard focus in either pane
            // keep each cell under the timeline's week. Ignore an empty strip's
            // clamp-to-zero so clearing filters cannot pan the timeline.
            onBodyScroll={stripUsers.length > 0 ? syncRailClip : undefined}
          />
        </div>
      </div>
      {session && P.issueById[session.issueId] && (
        <PlanCard
          issue={P.issueById[session.issueId]}
          session={session}
          onToggleAutoFit={toggleAutoFit}
          onConfirm={confirmPlanning}
          onCancel={cancelPlanning}
        />
      )}
      {updEst && <UpdateEstimateModal onClose={() => setUpdEst(false)} />}
    </div>,
  )
}

export { Roadmap }
