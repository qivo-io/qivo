/* The workspace's live part (convex/workspace.ts) as the store adopts it:
   once per Convex transition, with the side queries (lib/liveQueries.ts).

   The registry subscribes to the root part, which carries the caller's
   seats, organizations and own profiles, team memberships and teams, and
   to nothing per organization. No part sends a task, another person, a
   team the caller is not in, a label, a message or a project. Every view
   and the task window read their own answers (tasks.board, tasks.roadmap,
   teamSync.agenda, the Overview's reads, taskWindow.task and the others),
   the views read people and labels by id or a batch at a time, the Inbox
   reads convex/inbox.ts, and every project the app shows comes through
   the navigation reads, the store's project cache (store/projectCache.ts,
   projectNav.byIds) and the views' own answers. So the root's current
   answer alone completes the workspace (convex/lib/workspaceJoin.ts
   rootWorkspace). After each transition the registry tells the store
   (report) whether the root holds a current answer. Only then is the
   workspace complete; otherwise the store keeps what it shows, and
   nothing a transition brought is dropped, since the next complete one
   holds it.

   - A seat that goes leaves with the root part's answer, quietly. When the
     last seats go because their organization is being deleted, the root
     part says so and the report passes it on.
   - After the socket reconnects, Convex sends every result again, and none
     counts until it arrived again.
   - A root that failed, or refused to load with a sentence, fails the
     workspace, and Retry runs it again.
   - A workspace that stays incomplete while online, with the root not
     answering for STALL.ms, from the start on, fails, so a root that never
     answers shows instead of a frozen screen.

   Named side queries ride along (SideName): the open task's comment thread
   and, while a window shows All, its history, the window's task with its
   subtasks, and while a window shows the task's details, its links and
   attachments (convex/taskWindow.ts), and the read of a task a window
   names by a reference before it knows the task's uuid and organization
   (store/planner.ts P.watchTaskRef). A boot on a task's address subscribes
   that read itself, once the root part names the organization the
   address's slug names (createLiveParts `address`), so the task's answer
   comes with the first transitions. A transition that brings the
   workspace and the sides repaints once. Each side is its own. Its failure
   never holds the workspace or another side.

   Three sides concern the Inbox. The unread summary (convex/inbox.ts
   summary) is watched by every registry as it starts, right after the
   root part, so its first answer comes with the first parts, and a retry's
   or a re-init's registry watches it again. It runs while the tab is
   hidden, as the root does, since the badge counts unread tasks also then.
   The open task's inbox item (convex/inbox.ts item) rides with the thread
   (store/planner.ts subscribeThread), with the thread's own arguments. The
   feed of new unread events (convex/inbox.ts feed) is watched by the
   leader tab's desktop alert client (lib/notificationLeader.ts,
   lib/notificationFeed.ts) with the floor it holds, while it can notify,
   and also runs while the tab is hidden. No part sends a message.

   Watching one query with the same arguments twice shares one Convex
   subscription and one token (lib/liveQueries.ts), and a watch that joins
   one hears no transition for an answer that arrived already. So a side
   whose query and arguments the `reference` side watches takes that
   subscription over (watchSide), with its answer, rather than watching
   again, as the task side does when it reads the task a reference read
   named. No side takes another's: the store never starts a reference read
   with the arguments the task side reads with (store/planner.ts
   runRefRead).

   The open task's reads pause while the page is hidden (VIEW_SIDES). The
   store tells the registry so (pauseViews), from the one visibility watch
   of store/planner.ts (watchWindowVisibility), and a registry created
   while the page is hidden starts paused (createLiveParts `paused`), the
   boot's address read included. A paused view side holds no
   subscription and keeps its registration, its query and arguments, so
   sideArgs still answers them and the store's checks of what runs hold.
   Watching a view side while paused registers the new arguments, and
   stopping it drops them. On return every registered view side
   subscribes afresh at once, so its first news is a new run, never an
   answer held from before the pause. The summary and the feed never
   pause. */

import { type FunctionReference, getFunctionName } from 'convex/server'
import { ConvexError, type Value } from 'convex/values'
import { api } from '../../convex/_generated/api'
import {
  type RootAnswer,
  rootOrgs,
  rootWorkspace,
  type Seatless,
  type Workspace,
} from '../../convex/lib/workspaceJoin'
import type { LiveQueries } from '../lib/liveQueries'

/** How long an incomplete workspace may go without any part answering
    while online before it fails. Tests lower it. */
export const STALL = { ms: 60_000 }

/** The side queries that ride along with the workspace: the open task's
    comment thread and, while a window shows All, its history, the task a
    window shows with its subtasks, and while a window shows the task's
    details, its links and its attachments (convex/taskWindow.ts task, links
    and attachments). `reference` reads a task a window names by a
    reference (lib/taskReference.ts) by its number, or by its uuid in one
    organization after another, until an answer names its uuid and
    organization (store/planner.ts P.watchTaskRef). `summary` is the
    unread summary across the login's seats (convex/inbox.ts summary),
    which every registry watches from its start, `item` the open task's
    inbox item (convex/inbox.ts item), beside its thread, and `feed` the
    newest unread events after a floor (convex/inbox.ts feed), which the
    desktop alert client watches (store/planner.ts startAlerts). */
export const SIDE_NAMES = [
  'thread',
  'history',
  'task',
  'links',
  'attachments',
  'reference',
  'summary',
  'item',
  'feed',
] as const
export type SideName = (typeof SIDE_NAMES)[number]

/** The side queries a hidden page pauses (pauseViews), the open task
    window's reads, its thread, history, task, links, attachments, the
    reference read and the inbox item. `summary` and `feed` never pause,
    by the owner's rule that the unread count and notifications keep
    running while nobody looks. */
export const VIEW_SIDES: readonly SideName[] = [
  'thread',
  'history',
  'task',
  'links',
  'attachments',
  'reference',
  'item',
]
const isViewSide = (name: SideName) => VIEW_SIDES.includes(name)

/** What one transition brought a side query: its answer or its failure. */
export type SideNews = { value: unknown } | { error: unknown }

/** What the store hears after each transition, and when the workspace
    fails outside one. */
export type PartsReport = {
  /** the server time of the state, in ms */
  at: number
  /** the socket's connection count of the newest transition the registry
      heard, 0 before the first: after a reconnect every result arrives
      again, and a side's news counts as current only once it arrived on
      the newest connection (store/planner.ts latestConnection) */
  connection: number
  workspace:
    | {
        state: 'complete'
        /** null when the caller holds no seat it can open */
        value: Workspace | null
        /** with no such seat, the root part's answer when an organization
            deletion holds the caller's seats or an organization
            deactivated it (convex/lib/workspaceParts.ts readRoot) */
        seatless?: Seatless
        /** whether the root part changed since the last complete report */
        changed: boolean
      }
    | { state: 'held' }
    | { state: 'failed'; error: unknown }
  /** the news of each side query this transition brought news of, when
      it brought any */
  sides?: Partial<Record<SideName, SideNews>>
}

/* One subscription and what the transitions brought it. */
type Slot = {
  token: string
  stop: () => void
  ref: FunctionReference<'query'>
  args: Record<string, Value>
  /** the latest answer, undefined before one arrived */
  value?: unknown
  error?: unknown
  /** whether the answer arrived since the socket last connected */
  fresh: boolean
  /** the side query it is, for a side query's slot */
  side?: SideName
}

/** The task a boot's address names under an organization's slug
    (lib/router.ts addressedTask), with its ref as taskWindow.task reads it,
    `QN-12` or a lowercase uuid. */
export type AddressedTask = { slug: string; ref: string }

/* A side's query and arguments, which a paused view side keeps without
   a subscription. */
type Registration = { ref: FunctionReference<'query'>; args: Record<string, Value> }

/* Whether side `slot` watches, or will watch, query `ref` with `args`. */
const sameQuery = (
  slot: Registration,
  ref: FunctionReference<'query'>,
  args: Record<string, Value>,
) =>
  getFunctionName(slot.ref) === getFunctionName(ref) &&
  JSON.stringify(slot.args) === JSON.stringify(args)

/** Creates a registry over `live` that reports to `report`. `online` says
    whether the stall check may fail the workspace, false while the socket
    is down or saves pause offline. With `address`, it subscribes the
    `reference` side to the task the boot's address names, taskWindow.task
    in the organization its slug names, once the root part names that
    organization. A slug the root part does not name subscribes nothing.
    With `paused`, as for a page hidden when the registry starts, the view
    sides start paused (pauseViews). */
export function createLiveParts(
  live: LiveQueries,
  report: (news: PartsReport) => void,
  online: () => boolean,
  opts?: { address?: AddressedTask; paused?: boolean },
) {
  let stopped = false
  let connection: number | null = null
  const slots = new Map<string, Slot>()
  // whether the root part changed since the last complete report
  let dirty = true
  const sides = new Map<SideName, Slot>()
  // whether the view sides pause, and the registrations of those that
  // wait for the page to show, apart from the slots, since none holds a
  // subscription or a token
  let viewsPaused = opts?.paused === true
  const waiting = new Map<SideName, Registration>()
  let lastAt = 0
  let stallTimer: ReturnType<typeof setTimeout> | null = null
  // whether the root part's first answer was read for the boot's address
  let addressed = !opts?.address

  const watch = (ref: FunctionReference<'query'>, args: Record<string, Value>): Slot => {
    const { token, stop } = live.watch(ref, args)
    const slot: Slot = { token, stop, ref, args, fresh: false }
    slots.set(token, slot)
    return slot
  }
  const drop = (slot: Slot) => {
    slot.stop()
    if (slots.get(slot.token) === slot) slots.delete(slot.token)
  }

  let root: Slot | null = null

  /** The root part's current answer, or undefined while it has none. */
  const rootAnswer = (): RootAnswer | undefined =>
    root?.fresh && root.error === undefined ? (root.value as RootAnswer) : undefined

  /** Subscribes the boot's address once the root part first answers. */
  function readAddress() {
    const answer = rootAnswer()
    if (addressed || answer === undefined || !opts?.address) return
    addressed = true
    const { slug, ref } = opts.address
    const org = rootOrgs(answer).find((row) => row.slug === slug.toLowerCase())
    if (org) watchSide('reference', api.taskWindow.task, { org_id: org.id, ref })
  }

  /** The error the root part holds, a refusal as one, or undefined. */
  function failure(): unknown {
    if (!root) return undefined
    if (root.error !== undefined) return root.error
    const value = root.value
    if (root.fresh && typeof value === 'object' && value !== null && 'state' in value) {
      const answer = value as { state: unknown; message?: string }
      if (answer.state === 'refused')
        return new ConvexError({ code: 'rule', message: answer.message })
    }
    return undefined
  }

  /** The workspace when the root part holds a current answer, else null. */
  function join(): { value: Workspace | null; seatless?: Seatless } | null {
    const answer = rootAnswer()
    if (answer === undefined) return null
    if (answer === null) return { value: null }
    if ('deleting' in answer) return { value: null, seatless: answer }
    return { value: rootWorkspace(answer, new Date(lastAt).toISOString()) }
  }

  /** Tells the store the workspace's state after a transition, `news` the
      side queries'. Outside one, after Retry, it tells only of a failure:
      the workspace cannot be newer than the last transition, so a complete
      answer then would let the store take writes as shown that no
      transition brought yet. */
  function settle(transition?: { news?: PartsReport['sides']; progress?: boolean }) {
    if (stopped) return
    readAddress()
    const error = failure()
    let workspace: PartsReport['workspace']
    if (error !== undefined) workspace = { state: 'failed', error }
    else {
      const done = transition ? join() : null
      if (done) {
        workspace = {
          state: 'complete',
          value: done.value,
          changed: dirty,
          ...(done.seatless ? { seatless: done.seatless } : {}),
        }
        dirty = false
      } else workspace = { state: 'held' }
    }
    watchStall(workspace.state === 'held', transition?.progress === true)
    if (transition || workspace.state === 'failed')
      report({
        at: lastAt,
        connection: connection ?? 0,
        workspace,
        ...(transition?.news ? { sides: transition.news } : {}),
      })
  }

  /** Starts or ends the stall check of an incomplete workspace, starting
      it over when the root part answered (`progress`). */
  function watchStall(held: boolean, progress: boolean) {
    if (!held || progress) {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = null
      if (!held) return
    }
    stallTimer ??= setTimeout(function check() {
      if (stopped) return
      if (!online()) {
        stallTimer = setTimeout(check, STALL.ms)
        return
      }
      stallTimer = null
      report({
        at: lastAt,
        connection: connection ?? 0,
        workspace: {
          state: 'failed',
          error: new ConvexError({
            code: 'rule',
            message: 'Part of the workspace did not arrive in time. Try again in a moment.',
          }),
        },
      })
    }, STALL.ms)
  }

  /** Watches `ref` with `args` as side `name`, replacing that side's
      subscription. A fresh subscription runs the query again, so its
      answer is never one held from before. A `reference` side that
      watches the same query with the same arguments holds the one
      subscription Convex keeps for both, so side `name` takes it over
      instead, and the news it answers is that subscription's current
      answer, when one arrived on the newest connection, else undefined.
      Only the reference side's is handed over: a read that another side
      needs goes on, and the caller never watches its arguments again.
      While the view sides pause, a view side only registers its query and
      arguments, a reference registration of the same query moving over
      to it, and answers no news. */
  function watchSide(
    name: SideName,
    ref: FunctionReference<'query'>,
    args: Record<string, Value>,
  ): SideNews | undefined {
    if (viewsPaused && isViewSide(name)) {
      const reference = waiting.get('reference')
      if (name !== 'reference' && reference && sameQuery(reference, ref, args))
        waiting.delete('reference')
      waiting.set(name, { ref, args })
      return undefined
    }
    const before = sides.get(name)
    for (const [other, slot] of sides) {
      if (other !== 'reference' || other === name || !sameQuery(slot, ref, args)) continue
      if (before) drop(before)
      sides.delete(other)
      slot.side = name
      sides.set(name, slot)
      if (!slot.fresh) return undefined
      if (slot.error !== undefined) return { error: slot.error }
      return slot.value === undefined ? undefined : { value: slot.value }
    }
    if (before) drop(before)
    const slot = watch(ref, args)
    slot.side = name
    sides.set(name, slot)
    return undefined
  }

  /** Runs `slot` again from a fresh subscription (Convex never keeps a
      failed run). */
  function rerun(slot: Slot) {
    slot.stop()
    const again = live.watch(slot.ref, slot.args)
    slots.delete(slot.token)
    Object.assign(slot, {
      token: again.token,
      stop: again.stop,
      value: undefined,
      error: undefined,
      fresh: false,
    })
    slots.set(slot.token, slot)
  }

  const stopTransitions = live.onTransition((transition) => {
    if (stopped) return
    lastAt = Math.max(lastAt, transition.at)
    if (connection !== null && transition.connection !== connection)
      for (const slot of slots.values()) slot.fresh = false
    connection = transition.connection
    let news: PartsReport['sides']
    let progress = false
    for (const token of transition.tokens) {
      const slot = slots.get(token)
      if (!slot) continue
      let value: unknown
      let error: unknown
      try {
        value = live.read(token)
      } catch (e) {
        error = e ?? new Error('query failed')
      }
      if (value === undefined && error === undefined) {
        slot.fresh = false
        continue
      }
      slot.value = value
      slot.error = error
      slot.fresh = true
      if (slot.side) {
        news ??= {}
        news[slot.side] = error === undefined ? { value } : { error }
      } else {
        // a side query never holds the workspace, so only the root's
        // answer is progress
        progress = true
        dirty = true
      }
    }
    settle({ news, progress })
  })

  root = watch(api.workspace.root, {})
  // the unread summary from the start, right after the root part, so its
  // first answer comes with the first parts
  watchSide('summary', api.inbox.summary, {})
  // the wait runs from the start, so a root that never answers fails too
  watchStall(true, false)

  return {
    /** Runs the root part again from a fresh subscription when it failed
        (Convex never keeps a failed run). Answers whether it did. */
    retry(): boolean {
      if (!root || failure() === undefined) return false
      rerun(root)
      settle()
      return true
    },
    watchSide,
    /** The arguments side `name` watches with, or undefined while it does
        not run. */
    sideArgs: (name: SideName): Record<string, Value> | undefined =>
      sides.get(name)?.args ?? waiting.get(name)?.args,
    /** Runs side `name` again from a fresh subscription when its latest
        result is a failure, as Convex never keeps a failed run. Answers
        whether it did, and false for a paused view side, which has no
        result. */
    rerunSide(name: SideName): boolean {
      const slot = sides.get(name)
      if (!slot || slot.error === undefined) return false
      rerun(slot)
      return true
    },
    /** Stops the side query `name`, and keeps the others. A paused view
        side loses its registration. */
    stopSide(name: SideName) {
      const slot = sides.get(name)
      if (slot) drop(slot)
      sides.delete(name)
      waiting.delete(name)
    },
    /** Pauses the view sides (VIEW_SIDES) or ends the pause. A pause stops
        each view side's subscription and keeps its registration; its end
        subscribes every registered view side afresh, so their news are
        new runs and reach the report as any side's do. The summary and
        the feed keep running throughout. */
    pauseViews(paused: boolean) {
      if (stopped || paused === viewsPaused) return
      viewsPaused = paused
      if (paused) {
        for (const [name, slot] of sides) {
          if (!isViewSide(name)) continue
          drop(slot)
          sides.delete(name)
          waiting.set(name, { ref: slot.ref, args: slot.args })
        }
        return
      }
      for (const [name, { ref, args }] of waiting) {
        const slot = watch(ref, args)
        slot.side = name
        sides.set(name, slot)
      }
      waiting.clear()
    },
    /** Stops every subscription, the side queries included. */
    stop() {
      stopped = true
      stopTransitions()
      if (stallTimer) clearTimeout(stallTimer)
      // a Map lets its loop delete the entry it is on
      for (const slot of slots.values()) drop(slot)
      sides.clear()
      waiting.clear()
    },
  }
}

export type LiveParts = ReturnType<typeof createLiveParts>
