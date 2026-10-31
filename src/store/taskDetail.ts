/* The task window's view of a task the workspace does not hold
   (store/planner.ts P.taskDetail), shaped from the window's own read of the
   task (convex/taskWindow.ts task, the 'task' side of the live parts) into
   the view model the workspace gives its tasks (store/viewModels.ts
   shapeIssue), so the window draws it with the same code, read-only but
   for its comments. Its context comes from that answer, not from the task
   index: the handles of the task, its parent and its subtasks by the
   store's rule (P.handleNow), its labels in the task index's order, the
   caller's follow, and its links and files while the window's sections
   read them for the same task.

   A group's dates and Done state follow the workspace's rules
   (lib/issueGroups.ts groupSpan and isIssueDone) over the answer's subtask
   rows, so a group reads the same before and after it arrives. They are
   unknown only where the answer lacks their inputs: a subtask list that is
   not complete, or a subtask that is itself a group, whose leaves the
   answer does not hold, and an archived group, whose answer holds no
   subtasks. The answer of an archived task holds no parent, subtasks,
   links or files. */

import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../convex/_generated/api'
import type { AccessLevel } from '../../convex/lib/enums'
import { ISSUE_PREFIX } from '../../convex/lib/taskRefs'
import { isoToWeek } from '../lib/dates'
import { type DatedGroupIssue, groupSpan, isIssueDone, isIssueGroup } from '../lib/issueGroups'
import { byCreation, byNumber, linkViews } from '../lib/taskSections'
import type { RelatedTaskVM } from './planner'
import type { Row } from './rows'
import { type AttachmentVM, type IssueVM, shapeAttachment, shapeIssue } from './viewModels'

type TaskAnswer = FunctionReturnType<typeof api.taskWindow.task>
type TaskOk = Extract<TaskAnswer, { state: 'ok' }>
type TaskArchived = Extract<TaskAnswer, { state: 'archived' }>
/** An archived answer as it may arrive: a backend from before this release
    answers the page row alone (convex/lib/taskWindow.ts readWindowTask). */
type ArchivedAnswer = Pick<TaskArchived, 'state' | 'task'> &
  Partial<Pick<TaskArchived, 'description' | 'labels' | 'level'>>
type LinksOk = Extract<FunctionReturnType<typeof api.taskWindow.links>, { state: 'ok' }>
type AttachmentsOk = Extract<FunctionReturnType<typeof api.taskWindow.attachments>, { state: 'ok' }>

/** Where the window's read of the task stands: before its first answer,
    what the last answer said, or that the read failed (P.retryTask runs it
    again) and, from Retry, that it runs again until the server answers. */
export type TaskDetailState = 'loading' | 'ok' | 'archived' | 'unavailable' | 'failed' | 'retrying'

/** A task the workspace does not hold, as the window shows it from its own
    read. `answered` is what the last answer said, kept through a failure,
    and `view` the task from that answer, null before the first and for an
    unavailable task. */
export type TaskDetailVM = {
  /** the task's uuid and organization */
  task: string
  org: string
  state: TaskDetailState
  answered: 'ok' | 'archived' | 'unavailable' | null
  view: IssueVM | null
  /** an archived answer from a backend before this release, which holds
      no text: the window says what became of the task and nothing more */
  textless: boolean
  /** the caller's level on the task's project, by which the window offers
      comments and Restore, null without an answer */
  level: AccessLevel | null
  /** the parent as a row of Parent, null for none or a hidden one */
  parent: RelatedTaskVM | null
  /** when it was archived (ms), null for an active task */
  archivedAt: number | null
  /** whether a group's dates are known (always true for a leaf); unknown
      dates are null in `view` */
  datesKnown: boolean
  /** whether a group's span leaves out subtasks the person cannot see,
      which limits its delay verdict (convex/lib/delay.ts) */
  partial: boolean
  /** whether the task is Done: for a group, every leaf of a whole list,
      at least one, since P.isDone walks the workspace's tasks */
  done: boolean
}

/** What shapeTaskDetail reads besides the answer. */
export type DetailInputs = {
  task: string
  org: string
  answer: TaskOk | ArchivedAnswer | { state: 'unavailable' } | null
  failure: 'none' | 'failed' | 'retrying'
  /** the window's links and files of the same task, while its sections
      read them */
  links: LinksOk | null
  attachments: AttachmentsOk | null
  /** the handle the app opens a task by now (P.handleNow) */
  handleNow: (uuid: string, org: string, num: number) => string
  /** the name of a label the workspace holds, undefined for another */
  labelName: (id: string) => string | undefined
  /** a short row's task as a row of Parent (store/planner.ts relatedTask) */
  related: (row: TaskOk['subtasks']['rows'][number]) => RelatedTaskVM | null
}

/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Label ids by name, then id, as the task index orders a task's labels,
    without those the workspace does not hold. */
function labelsInOrder(ids: readonly string[], name: (id: string) => string | undefined) {
  return ids
    .flatMap((id) => {
      const named = name(id)
      return named === undefined ? [] : [{ id, key: named.toLowerCase() }]
    })
    .sort((a, b) => order(a.key, b.key) || order(a.id, b.id))
    .map((label) => label.id)
}

/** The shapeIssue context of one task, `uuid`, from what its answer holds. */
function contextOf(
  uuid: string,
  facts: {
    handle: string
    key: string
    parent?: { uuid: string; handle: string }
    children?: string[]
    hiddenSubtasks: boolean
    hiddenParent: boolean
    links?: { type: string; id: string }[]
    labels: string[]
    attachments?: AttachmentVM[]
    attachmentCount?: number
    follows: boolean
  },
) {
  const only = <T>(value: T) => ({ get: (id: string) => (id === uuid ? value : undefined) })
  const handles = new Map([[uuid, facts.handle]])
  if (facts.parent) handles.set(facts.parent.uuid, facts.parent.handle)
  return {
    uuidToKey: handles,
    uuidToDisplayKey: only(facts.key),
    hiddenSubtaskParents: { has: (id: string) => id === uuid && facts.hiddenSubtasks },
    hiddenParentTasks: { has: (id: string) => id === uuid && facts.hiddenParent },
    linkViews: only(facts.links ?? []),
    childKeys: only(facts.children ?? []),
    labelsByIssue: only(facts.labels),
    attByIssue: only(facts.attachments ?? []),
    attachmentCounts: only(facts.attachmentCount ?? 0),
    subscribedIssues: { has: (id: string) => id === uuid && facts.follows },
  }
}

/* A week index of an ISO date, or null. */
const weekOf = (iso: string | null | undefined) => (iso == null ? null : isoToWeek(iso))

/** The view, group facts and parent of an `ok` answer. */
function okView(answer: TaskOk, inputs: DetailInputs) {
  const row = answer.task
  const handleOf = (task: { id: string; org_id: string; num: number }) =>
    inputs.handleNow(task.id, task.org_id, task.num)
  const kids = [...answer.subtasks.rows].sort(byNumber)
  const ends = new Map((inputs.links?.tasks ?? []).map((end) => [end.id, end]))
  const links = inputs.links
    ? linkViews(row.id, inputs.links.links, (other) => ends.has(other)).flatMap((view) => {
        const end = ends.get(view.other)
        return end ? [{ type: view.type, id: handleOf(end) }] : []
      })
    : []
  const files = inputs.attachments ? [...inputs.attachments.rows].sort(byCreation) : []
  const view = shapeIssue(
    row,
    contextOf(row.id, {
      handle: handleOf(row),
      key: `${ISSUE_PREFIX}-${row.num}`,
      parent: answer.parent
        ? { uuid: answer.parent.id, handle: handleOf(answer.parent) }
        : undefined,
      children: kids.map(handleOf),
      hiddenSubtasks: row.has_hidden_subtasks,
      hiddenParent: row.has_hidden_parent,
      links,
      labels: labelsInOrder(
        answer.labels.map((label) => label.label_id),
        inputs.labelName,
      ),
      attachments: files.filter((file) => !file.inline).map(shapeAttachment),
      attachmentCount: inputs.attachments?.count,
      follows: answer.follow !== null,
    }),
  )
  // the subtasks as the group rules read them: each a leaf with its own
  // dates, or a group whose leaves the answer does not hold
  const byId: Record<string, DatedGroupIssue> = { [view.id]: view }
  for (const kid of kids) {
    const start = weekOf(kid.start_week)
    const end = weekOf(kid.end_week)
    byId[handleOf(kid)] = {
      id: handleOf(kid),
      status: kid.status,
      isGroup: kid.has_subtasks,
      start,
      end: end === null ? null : Math.max(start ?? end, end),
    }
  }
  const group = isIssueGroup(view)
  const datesKnown =
    !group || (answer.subtasks.complete && !answer.subtasks.rows.some((kid) => kid.has_subtasks))
  const span = groupSpan(view, byId)
  if (span) {
    view.start = datesKnown ? span.start : null
    view.end = datesKnown ? span.end : null
  }
  return {
    view,
    datesKnown,
    partial: !!span?.partial,
    done: group ? isIssueDone(view, byId) : view.status === 'done',
    parent: answer.parent ? inputs.related(answer.parent) : null,
    level: answer.level,
  }
}

/** The view and facts of an `archived` answer, which holds no parent,
    subtasks, links or files. An archived group's dates and progress are
    unknown. */
function archivedView(answer: ArchivedAnswer, inputs: DetailInputs) {
  const { is_group, ...page } = answer.task
  const row: Row<'issues'> = { ...page, description: answer.description ?? '' }
  const view = shapeIssue(
    row,
    contextOf(row.id, {
      handle: inputs.handleNow(row.id, row.org_id, row.num),
      key: `${ISSUE_PREFIX}-${row.num}`,
      hiddenSubtasks: is_group,
      hiddenParent: false,
      labels: labelsInOrder(
        (answer.labels ?? []).map((label) => label.label_id),
        inputs.labelName,
      ),
      follows: false,
    }),
  )
  if (is_group) {
    view.start = null
    view.end = null
  }
  return {
    view,
    datesKnown: !is_group,
    partial: false,
    done: !is_group && view.status === 'done',
    parent: null,
    level: answer.level ?? null,
    archivedAt: Date.parse(answer.task.archived_at),
    textless: answer.description === undefined,
  }
}

/** The window's view of task `inputs.task` from its last answer, in the
    state its read is in. A failure keeps what the answer before it said. */
export function shapeTaskDetail(inputs: DetailInputs): TaskDetailVM {
  const { answer, failure } = inputs
  const state: TaskDetailState =
    failure !== 'none' ? failure : answer === null ? 'loading' : answer.state
  const base = {
    task: inputs.task,
    org: inputs.org,
    state,
    textless: false,
    archivedAt: null,
  }
  if (answer?.state === 'ok') return { ...base, answered: 'ok', ...okView(answer, inputs) }
  if (answer?.state === 'archived')
    return { ...base, answered: 'archived', ...archivedView(answer, inputs) }
  return {
    ...base,
    answered: answer === null ? null : 'unavailable',
    view: null,
    level: null,
    parent: null,
    datesKnown: true,
    partial: false,
    done: false,
  }
}
