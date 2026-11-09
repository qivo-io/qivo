import type { FunctionReturnType } from 'convex/server'
import { ConvexError } from 'convex/values'
import type { api } from '../../../convex/_generated/api'
import type { BoardAnswer } from '../../../convex/lib/board'
import type { RelationCandidate } from '../../../convex/lib/relationPicker'
import type { ViewRow } from '../../../convex/lib/viewReads'
import type { MilestoneAsk } from '../milestoneRows'
import { labelShownOf, shownOf } from '../personShown.setup'
import type { Row } from '../rows'
import type { Whole } from './liveDouble.setup'

/* One recipe per write the store sends (layerGuard.test.ts checks that each
   mutation has one, and each mutator is named). writeRecipes.test.ts runs
   every recipe through four scenarios against the shared Convex double.
   A recipe's `truth` is the snapshot as the server holds it after the
   write, written from the server's code with its own stamps, so a paint
   that differs from what the server stores shows up. */

export type Snapshot = Whole & Required<Pick<Whole, 'messages'>>
export type Thread = FunctionReturnType<typeof api.snapshot.threadComments>
/** The task window's own answer of a task (convex/taskWindow.ts task). */
export type TaskAnswer = FunctionReturnType<typeof api.taskWindow.task>
/** The task window's attachments answer of a task. */
export type AttachmentsAnswer = FunctionReturnType<typeof api.taskWindow.attachments>
type Store = typeof import('../planner')
type Planner = Store['P']

/** How a recipe's preparation answers the writes it sends. */
export type Prepare = {
  answer: (name: string, value: unknown, edit?: (snap: Snapshot) => void) => Promise<void>
}

/* The time the store's clock reads in the runner, and the later time the
   server stamps its rows with. */
export const NOW = '2026-10-20T10:00:00.000Z'
export const SERVER = '2026-10-20T10:00:05.000Z'
export const ORG = 'org-1'
export const ME = 'me'
export const PAT = 'pat'

/** Which pause holds a write back (store/planner.ts isUnpausedWrite): every
    snapshot trouble (`P`), a lost seat or sign-in but not a failed query
    (`U`), or only the pause while Qivo cannot save (`U-all`). Every write
    pauses then. */
export type PauseClass = 'P' | 'U' | 'U-all'

export type Recipe = {
  /** The mutation, as `module:name`. */
  mutation: string
  /** The store function that sends it. */
  mutator: string
  /** What the recipe does, for the test's name. */
  what: string
  pause: PauseClass
  /** Rows to add to the fixture first. */
  seed?: (snap: Snapshot) => void
  /** Store steps before the write, such as opening Roadmap. `server`
      answers the writes they send, with the server's rows changed by
      `edit` first. */
  prepare?: (P: Planner, server: Prepare) => void | Promise<void>
  /** Makes the store send the write, through P or, for the boot, the
      store's module. Never rejects. */
  act: (P: Planner, store: Store) => unknown
  /** The server's answer to each write the act sends, by mutation. */
  answers?: Record<string, (args: Record<string, unknown>) => unknown>
  /** The snapshot after the server applied the write, for a write that
      paints the snapshot's rows. */
  truth?: (snap: Snapshot, args: Record<string, unknown>) => void
  /** The watched thread after the server applied the write, for a comment
      write. */
  thread?: (page: Thread, args: Record<string, unknown>) => void
  /** The write paints only once the server accepts it (a keep), such as
      an upload or a removal the window waits for. */
  paintsOnAccept?: true
  /** For a write on a task only the Board's answer brings
      (store/viewRows.ts): the view the runner opens (P.watchBoard), and the
      Board's answer before the write and, given its arguments, as the
      server answers after it. */
  view?: { slot: string; answer: (args?: Record<string, unknown>) => BoardAnswer }
  /** For a write on task WINDOW_TASK, which the task window shows from its
      own answer because the workspace does not hold it (store/planner.ts
      answerTaskOf): the window's answer before the write and, given its
      arguments, as the server answers after it, and with `files` its
      attachments answer, which the runner shows (P.showSections). */
  detail?: {
    answer: (args?: Record<string, unknown>) => TaskAnswer
    files?: (args?: Record<string, unknown>) => AttachmentsAnswer
  }
  /** For a write on a milestone, which only a milestone read holds
      (store/milestoneRows.ts) as the projects part sends no milestone, the
      read the runner opens (P.watchMilestones), its query as Convex names
      it, and its answer before the write and, given its arguments, as the
      server answers after it. */
  milestones?: {
    slot: string
    ask: MilestoneAsk
    query: string
    answer: (args?: Record<string, unknown>) => unknown
  }
}

/** The task the window shows from its own answer in a `detail` recipe:
    QN-80 of sub-project Work, which the workspace does not hold. */
export const WINDOW_TASK = 'task-w'

const task = (id: string, num: number, over: Partial<Row<'issues'>> = {}): Row<'issues'> => ({
  id,
  org_id: ORG,
  project_id: 'work',
  num,
  title: `Task ${num}`,
  description: '',
  status: 'todo',
  priority: 'medium',
  paused: false,
  status_at: '2026-10-01T08:00:00.000Z',
  created_at: '2026-10-01T08:00:00.000Z',
  updated_at: '2026-10-01T08:00:00.000Z',
  ...over,
})

/** A small workspace every recipe starts from: one organization where I am
    an admin, Pat a member, two teams, a project with two sub-projects,
    three tasks, a link, a label, an attachment, and two messages the
    server stores, which no part sends and the inbox reads answer from. The
    milestone recipes bring their milestone in a milestone read. */
export function fixture(): Snapshot {
  const person = (id: string, name: string, role: Row<'profiles'>['org_role']) => ({
    id,
    org_id: ORG,
    auth_user_id: id === ME ? 'test-account' : undefined,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    color: '#335577',
    org_role: role,
    active: true,
    kind: 'person' as const,
    plannable_hours: 40,
    message_retention_days: 7,
    created_at: '2026-09-01T08:00:00.000Z',
  })
  const project = (id: string, over: Partial<Row<'projects'>>): Row<'projects'> => ({
    id,
    org_id: ORG,
    type: 'project',
    key: id.toUpperCase(),
    num: 1,
    name: id,
    description: '',
    sort_order: 0,
    track_delay: true,
    created_at: '2026-09-01T08:00:00.000Z',
    ...over,
  })
  return {
    auth_user_id: 'test-account',
    myProfileIds: [ME],
    orgs: [
      {
        id: ORG,
        name: 'Testbed Labs',
        slug: 'testbed',
        created_at: '2026-09-01T08:00:00.000Z',
        next_issue_num: 3,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
      },
    ],
    profiles: [person(ME, 'Planner', 'admin'), person(PAT, 'Pat', 'user')],
    teams: ['team-a', 'team-b'].map((id, n) => ({
      id,
      org_id: ORG,
      name: n ? 'Ops' : 'Field',
      track_delay_default: true,
      created_at: '2026-09-01T08:00:00.000Z',
    })),
    teamMembers: [
      { team_id: 'team-a', profile_id: ME, is_leader: false },
      { team_id: 'team-a', profile_id: PAT, is_leader: false },
    ],
    projects: [
      project('plan', { type: 'meta', key: 'PLAN', name: 'Plan', lead_id: ME, num: 1 }),
      project('work', { parent_id: 'plan', key: 'WORK', name: 'Work', num: 2 }),
      project('work2', { parent_id: 'plan', key: 'WRK2', name: 'Work 2', num: 3, sort_order: 1 }),
    ],
    access: [{ project_id: 'plan', profile_id: PAT, level: 'user' }],
    teamAccess: [],
    issues: [
      {
        ...task('task-a', 1, { assignee_id: PAT }),
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
      {
        ...task('task-b', 2, {
          status: 'review',
          reviewer_id: ME,
          review_at: '2026-10-02T08:00:00.000Z',
          remaining_hours: 2,
          remaining_set_at: '2026-10-02T08:00:00.000Z',
        }),
        has_hidden_subtasks: false,
        has_hidden_parent: false,
      },
      { ...task('task-c', 3), has_hidden_subtasks: false, has_hidden_parent: false },
    ],
    links: [
      {
        id: 'link-a',
        source_id: 'task-a',
        target_id: 'task-b',
        type: 'blocks',
        pair_key: 'task-a:task-b',
        created_at: '2026-10-01T08:00:00.000Z',
      },
    ],
    labels: [
      {
        id: 'label-a',
        org_id: ORG,
        name: 'Bug',
        name_lower: 'bug',
        color: '#aa3333',
        created_at: '2026-10-01T08:00:00.000Z',
      },
    ],
    issueLabels: [{ issue_id: 'task-a', label_id: 'label-a' }],
    issueSubs: [{ issue_id: 'task-b', profile_id: ME, created_at: '2026-10-01T08:00:00.000Z' }],
    attachments: [
      {
        id: 'att-a',
        issue_id: 'task-a',
        name: 'plan.pdf',
        mime: 'application/pdf',
        size_bytes: 10,
        storage_id: 'storage-att' as Row<'issue_attachments'>['storage_id'],
        inline: false,
        created_at: '2026-10-01T08:00:00.000Z',
      },
    ],
    orgLoad: [],
    messages: [
      {
        id: 'msg-1',
        org_id: ORG,
        recipient_id: ME,
        issue_id: 'task-a',
        issue_title: 'Task 1',
        kind: 'change',
        detail: 'Status changed',
        created_at: '2026-10-19T08:00:00.000Z',
      },
      {
        id: 'msg-2',
        org_id: ORG,
        recipient_id: ME,
        issue_id: 'task-b',
        issue_title: 'Task 2',
        kind: 'change',
        detail: 'Status changed',
        created_at: '2026-10-19T08:00:00.000Z',
        read_at: '2026-10-19T09:00:00.000Z',
      },
    ],
    delivered_at: '2026-10-20T09:59:00.000Z',
  }
}

/** The thread of task-a every recipe watches. */
export function thread(): Thread {
  const comment = (id: string, body: string, minute: number): Row<'comments'> => ({
    id,
    issue_id: 'task-a',
    author: PAT,
    body,
    created_at: `2026-10-19T08:0${minute}:00.000Z`,
  })
  return {
    comments: [comment('comment-a', 'First', 1), comment('comment-b', 'Second', 2)],
    earlier: false,
  }
}

const issue = (snap: Snapshot, id: string) => snap.issues.find((r) => r.id === id)!
const profile = (snap: Snapshot, id: string) => snap.profiles.find((r) => r.id === id)!
const str = (value: unknown) => String(value)

/** Milestone ms-a of Plan, as the server stores it. */
const MS_A: Row<'milestones'> = {
  id: 'ms-a',
  project_id: 'plan',
  name: 'Launch',
  week: '2026-11-02',
  created_at: '2026-10-01T08:00:00.000Z',
}

/** A milestone read of Plan's milestones from 26 October to 16 November,
    as Team sync's opening reads a range, whose rows are `rows`, before the
    write and, given its arguments, after it. */
const milestoneRange = (
  rows: (args?: Record<string, unknown>) => Row<'milestones'>[],
): NonNullable<Recipe['milestones']> => ({
  slot: 'milestones:sync-ahead',
  ask: { kind: 'between', projects: ['plan'], from: '2026-10-26', to: '2026-11-16' },
  query: 'milestones:between',
  answer: (args) => ({ rows: rows(args), next: null, stopped: null }),
})

/* The dates a Roadmap recipe plans a task on, as the server stores them,
   and as the store's patch takes them. */
const PLANNED = { start_week: '2026-11-02', end_week: '2026-11-09' }
const planned = (P: Planner) => ({
  start: P.isoToWeek(PLANNED.start_week),
  end: P.isoToWeek(PLANNED.end_week),
})

/* A task the server creates: createIssueCore's defaults with the stamps of
   its clock. */
const created = (snap: Snapshot, id: string, num: number, over: Partial<Row<'issues'>>) => {
  snap.orgs[0].next_issue_num = num
  snap.issues.push({
    ...task(id, num, { status: 'backlog', priority: 'low', reporter_id: ME, created_by: ME }),
    status_at: SERVER,
    created_at: SERVER,
    updated_at: SERVER,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...over,
  })
}

/* What issues.create and issues.createLinked answer for new task `id`,
   number `num`: the row the server stored, as `created` adds it, without
   its text (convex/issues.ts pubFor). */
const stored = (id: string, num: number, over: Partial<Row<'issues'>>) => {
  const snap = fixture()
  created(snap, id, num, over)
  const {
    description: _text,
    has_hidden_subtasks: _h,
    has_hidden_parent: _p,
    ...row
  } = snap.issues.at(-1) as Snapshot['issues'][number]
  return row
}

/* What issues.createParent answers: the task `row` under its new parent
   `parent`, stamped by the server, without its text, and the new parent's
   number `num`. */
const underNew = (row: Row<'issues'>, parent: string, num: number) => {
  const { description: _text, ...rest } = row
  return { ...rest, parent_id: parent, updated_at: SERVER, parent_num: num }
}

const file = (name: string, type: string) => new File(['bytes'], name, { type })

/** Task task-v (QN-90) of sub-project Work as the Board's answer sends it,
    which the workspace does not hold, changed by `over`. */
function viewTask(over: Partial<ViewRow> = {}): ViewRow {
  const { description: _text, ...fields } = task('task-v', 90)
  return {
    ...fields,
    has_subtasks: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...over,
  }
}

/** WINDOW_TASK as the window's answer sends it, changed by `over`. */
function windowTask(over: Partial<Extract<TaskAnswer, { state: 'ok' }>['task']> = {}) {
  return {
    ...task(WINDOW_TASK, 80),
    has_subtasks: false,
    has_hidden_subtasks: false,
    has_hidden_parent: false,
    ...over,
  }
}

/** The window's answer for WINDOW_TASK: its row changed by `over`, and the
    rest of the answer by `extra`. */
const windowAnswer = (
  over: Partial<Extract<TaskAnswer, { state: 'ok' }>['task']> = {},
  extra: Partial<Extract<TaskAnswer, { state: 'ok' }>> = {},
): TaskAnswer => ({
  state: 'ok',
  task: windowTask(over),
  level: 'lead',
  labels: [],
  follow: null,
  parent: null,
  subtasks: { rows: [], complete: true },
  ...extra,
})

/** A subtask of WINDOW_TASK as a short row of its answer. */
const windowKid = () => {
  const { description: _text, ...fields } = task('task-wk', 81, { parent_id: WINDOW_TASK })
  const { parent_id: _parent, ...rest } = fields
  return { ...rest, has_subtasks: false, level: 'lead' as const }
}

/** Task `id`, number `num`, as a relation picker's row offers it
    (convex/lib/relationPicker.ts RelationCandidate), which the workspace
    does not hold. */
const pickerRow = (id: string, num: number): RelationCandidate => {
  const { description: _text, parent_id: _parent, ...fields } = task(id, num)
  return { ...fields, level: 'lead' }
}

/** Picker row `row` as the window's answer lists it once a pick made it
    a subtask (`has_subtasks` false) or the parent (true). */
const shortOf = (row: RelationCandidate, has_subtasks: boolean) => {
  const { parent_id: _parent, has_hidden_parent: _hidden, exact: _exact, ...fields } = row
  return { ...fields, has_subtasks }
}

/** New task `id`, number `num`, as createIssueCore stores it and the
    window's answer lists it, with `over`. */
const createdShort = (
  id: string,
  num: number,
  has_subtasks: boolean,
  over: Partial<Row<'issues'>>,
) => {
  const {
    description: _text,
    parent_id: _parent,
    ...fields
  } = task(id, num, {
    status: 'backlog',
    priority: 'low',
    reporter_id: ME,
    created_by: ME,
    status_at: SERVER,
    created_at: SERVER,
    updated_at: SERVER,
    ...over,
  })
  return { ...fields, has_subtasks, level: 'lead' as const }
}

/** A file of WINDOW_TASK as its attachments answer sends it. */
const windowFile = {
  id: 'att-w',
  issue_id: WINDOW_TASK,
  name: 'notes.pdf',
  mime: 'application/pdf',
  size_bytes: 10,
  storage_id: 'storage-w' as Row<'issue_attachments'>['storage_id'],
  inline: false,
  created_at: '2026-10-01T08:00:00.000Z',
}

/** The Board's answer for sub-project Work with task-v alone. */
const viewAnswer = (over: Partial<ViewRow> = {}): BoardAnswer => ({
  state: 'ok',
  rows: [viewTask(over)],
  parents: [],
  held_projects: ['work'],
  projects: ['work'],
})

export const recipes: Recipe[] = [
  /* --- tasks ---------------------------------------------------------- */
  {
    mutation: 'issues:create',
    mutator: 'addIssue',
    what: 'a new task',
    pause: 'P',
    act: (P) => P.addIssue({ project: 'work', title: 'New task' }),
    answers: {
      'issues:create': (args) => stored(str(args.id), 4, { title: 'New task', description: '' }),
    },
    truth: (snap, args) => created(snap, str(args.id), 4, { title: 'New task' }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateIssue',
    what: 'a renamed task',
    pause: 'P',
    act: (P) => P.updateIssue('QN-1', { title: 'Renamed task' }),
    truth: (snap) =>
      Object.assign(issue(snap, 'task-a'), { title: 'Renamed task', updated_at: SERVER }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateIssue',
    what: 'a task moved into Review',
    pause: 'P',
    act: (P) => P.updateIssue('QN-3', { status: 'review' }),
    // updateIssueCore: the status stamp, the review hand-off and the
    // project's review time (the default, 2 hours)
    truth: (snap) =>
      Object.assign(issue(snap, 'task-c'), {
        status: 'review',
        status_at: SERVER,
        review_at: SERVER,
        remaining_hours: 2,
        remaining_set_at: SERVER,
        updated_at: SERVER,
      }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateViewTask',
    what: "a drop's status on a task only the Board's answer brings",
    pause: 'P',
    view: {
      slot: 'board:desktop',
      answer: (args) =>
        viewAnswer(args ? { status: 'progress', status_at: SERVER, updated_at: SERVER } : {}),
    },
    act: (P) => P.updateIssue('QN-90', { status: 'progress' }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateViewTask',
    what: "an owner change on a task only the Board's answer brings",
    pause: 'P',
    view: {
      slot: 'board:desktop',
      answer: (args) => viewAnswer(args ? { assignee_id: PAT, updated_at: SERVER } : {}),
    },
    act: (P) => P.updateIssue('QN-90', { assignee: PAT }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateViewTask',
    what: "a Remaining on a task only a view's answer brings, as Team sync's card writes it",
    pause: 'P',
    view: {
      slot: 'board:desktop',
      answer: (args) =>
        viewAnswer(
          args ? { remaining_hours: 6, remaining_set_at: SERVER, updated_at: SERVER } : {},
        ),
    },
    act: (P) => P.updateIssue('QN-90', { remaining: 6 }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateViewTask',
    what: "a Pause on a task only a view's answer brings, as Team sync's card writes it",
    pause: 'P',
    view: {
      slot: 'board:desktop',
      answer: (args) => viewAnswer(args ? { paused: true, updated_at: SERVER } : {}),
    },
    act: (P) => P.updateIssue('QN-90', { paused: true }),
  },
  /* --- a task the window shows from its own answer ------------------- */
  {
    mutation: 'issues:update',
    mutator: 'updateAnswerTask',
    what: 'a renamed task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        windowAnswer(args ? { title: 'Renamed in the window', updated_at: SERVER } : {}),
    },
    act: (P) => P.updateIssue('QN-80', { title: 'Renamed in the window' }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateAnswerTask',
    what: 'a hidden parent removed from a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        windowAnswer(
          args ? { has_hidden_parent: false, updated_at: SERVER } : { has_hidden_parent: true },
        ),
    },
    act: (P) => P.updateIssue('QN-80', { parent: null }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateAnswerTask',
    what: "a group's priority from an answer whose subtask list is not whole",
    pause: 'P',
    detail: {
      answer: (args) =>
        windowAnswer(
          {
            has_subtasks: true,
            has_hidden_subtasks: true,
            ...(args ? { priority: 'high' as const, updated_at: SERVER } : {}),
          },
          { subtasks: { rows: [windowKid()], complete: false } },
        ),
    },
    act: (P) => P.updateIssue('QN-80', { priority: 'high' }),
  },
  {
    mutation: 'issues:move',
    mutator: 'moveAnswerTask',
    what: 'a task the window shows from its own answer moved to another sub-project',
    pause: 'P',
    detail: {
      // movedStamps: no status stamp
      answer: (args) =>
        windowAnswer(
          args ? { project_id: 'work2', status_at: undefined, updated_at: SERVER } : {},
          { subtasks: { rows: [windowKid()], complete: true } },
        ),
    },
    act: (P) => P.moveIssue('QN-80', 'work2'),
  },
  {
    mutation: 'issues:archive',
    mutator: 'sendArchive',
    what: 'a task the window shows from its own answer archived',
    paintsOnAccept: true,
    pause: 'P',
    detail: {
      answer: (args) =>
        args
          ? {
              state: 'archived',
              task: {
                ...(({ description: _text, ...row }) => row)(task(WINDOW_TASK, 80)),
                archived_at: SERVER,
                is_group: false,
              },
              description: '',
              labels: [],
              level: 'lead',
              project_archived: false,
            }
          : windowAnswer(),
    },
    act: (P) => P.archiveIssue('QN-80', 'Not needed'),
  },
  {
    mutation: 'issues:deleteDeep',
    mutator: 'deleteAnswerTask',
    what: 'a task the window shows from its own answer deleted',
    paintsOnAccept: true,
    pause: 'P',
    detail: { answer: (args) => (args ? { state: 'unavailable' } : windowAnswer()) },
    act: (P) => P.deleteIssue('QN-80', [], true),
  },
  {
    mutation: 'labels:toggle',
    mutator: 'toggleAnswerLabel',
    what: 'a label put on a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        windowAnswer({}, args ? { labels: [{ issue_id: WINDOW_TASK, label_id: 'label-a' }] } : {}),
    },
    act: (P) => P.toggleIssueLabel('QN-80', 'label-a'),
  },
  {
    mutation: 'issues:subscribe',
    mutator: 'followAnswerTask',
    what: 'following a task the window shows from its own answer',
    pause: 'U',
    detail: {
      answer: (args) =>
        windowAnswer(
          {},
          args ? { follow: { issue_id: WINDOW_TASK, profile_id: ME, created_at: SERVER } } : {},
        ),
    },
    act: (P) => P.setIssueSubscribed('QN-80', true),
  },
  {
    mutation: 'issues:unsubscribe',
    mutator: 'followAnswerTask',
    what: 'no longer following a task the window shows from its own answer',
    pause: 'U',
    detail: {
      answer: (args) =>
        windowAnswer(
          {},
          args
            ? {}
            : {
                follow: {
                  issue_id: WINDOW_TASK,
                  profile_id: ME,
                  created_at: '2026-10-01T08:00:00.000Z',
                },
              },
        ),
    },
    act: (P) => P.setIssueSubscribed('QN-80', false),
  },
  {
    mutation: 'issues:setSubscriber',
    mutator: 'setIssueSubscriber',
    what: 'another person following a task the window shows from its own answer',
    pause: 'U',
    detail: { answer: () => windowAnswer() },
    act: (P) => {
      const shown = P.taskShown('QN-80')
      if (shown) P.setIssueSubscriber(shown, PAT, true, () => {})
    },
  },
  {
    mutation: 'files:removeAttachment',
    mutator: 'removeUnheldAttachment',
    what: 'a file only the window’s attachments answer holds removed',
    pause: 'P',
    detail: {
      answer: () => windowAnswer(),
      files: (args) => ({
        state: 'ok',
        rows: args ? [] : [windowFile],
        count: args ? 0 : 1,
        complete: true,
      }),
    },
    act: (P) => P.removeAttachment('att-w'),
  },
  /* --- the relation pickers' writes, with an end only an answer holds - */
  {
    mutation: 'issues:update',
    mutator: 'updateIssue',
    what: 'a parent only a picker row names set on a task the workspace holds',
    pause: 'P',
    act: (P) => P.updateIssue('QN-1', { parent: 'task-p' }, { parentRow: pickerRow('task-p', 85) }),
    truth: (snap) =>
      Object.assign(issue(snap, 'task-a'), { parent_id: 'task-p', updated_at: SERVER }),
  },
  {
    mutation: 'issues:update',
    mutator: 'updateAnswerTask',
    what: 'a parent only a picker row names set on a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        args
          ? windowAnswer(
              { parent_id: 'task-p', updated_at: SERVER },
              { parent: shortOf(pickerRow('task-p', 85), true) },
            )
          : windowAnswer(),
    },
    act: (P) =>
      P.updateIssue('QN-80', { parent: 'task-p' }, { parentRow: pickerRow('task-p', 85) }),
  },
  {
    mutation: 'issues:update',
    mutator: 'setSubtaskParent',
    what: 'a task only a picker row names made a subtask of a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        args
          ? windowAnswer(
              { has_subtasks: true },
              {
                subtasks: {
                  rows: [{ ...shortOf(pickerRow('task-p', 85), false), updated_at: SERVER }],
                  complete: true,
                },
              },
            )
          : windowAnswer(),
    },
    act: (P) =>
      P.setSubtaskParent(
        'QN-80',
        { uuid: 'task-p', row: pickerRow('task-p', 85), parent: null, hiddenParent: false },
        true,
      ),
  },
  {
    mutation: 'issues:update',
    mutator: 'setSubtaskParent',
    what: 'a subtask the workspace does not hold taken off a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        args
          ? windowAnswer()
          : windowAnswer(
              { has_subtasks: true },
              { subtasks: { rows: [windowKid()], complete: true } },
            ),
    },
    act: (P) =>
      P.setSubtaskParent(
        'QN-80',
        { uuid: 'task-wk', parent: WINDOW_TASK, hiddenParent: false },
        false,
      ),
  },
  {
    mutation: 'issues:addLink',
    mutator: 'linkTasks',
    what: 'a link from a task the window shows from its own answer',
    pause: 'P',
    detail: { answer: () => windowAnswer() },
    act: (P) => P.linkTasks('QN-80', 'blocks', { uuid: 'task-a' }),
  },
  {
    mutation: 'issues:removeLink',
    mutator: 'unlinkTasks',
    what: 'a link removed from a task the window shows from its own answer',
    pause: 'P',
    detail: { answer: () => windowAnswer() },
    act: (P) => P.unlinkTasks('QN-80', { uuid: 'task-a' }, 'blocked_by'),
  },
  {
    mutation: 'issues:createParent',
    mutator: 'createParent',
    what: 'a new parent for a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        args
          ? windowAnswer(
              { parent_id: str(args.parent_id), updated_at: SERVER },
              {
                parent: createdShort(str(args.parent_id), 4, true, { title: 'New parent' }),
              },
            )
          : windowAnswer(),
    },
    act: (P) => P.createParent('QN-80', 'New parent'),
    // the task with its new parent, and the parent's number
    answers: {
      'issues:createParent': (args) => underNew(task(WINDOW_TASK, 80), str(args.parent_id), 4),
    },
    truth: (snap, args) => created(snap, str(args.parent_id), 4, { title: 'New parent' }),
  },
  {
    mutation: 'issues:createLinked',
    mutator: 'createLinked',
    what: 'a new task linked to a task the window shows from its own answer',
    pause: 'P',
    detail: { answer: () => windowAnswer() },
    act: (P) => P.createLinked('QN-80', 'relates', 'New linked task'),
    answers: {
      'issues:createLinked': (args) => stored(str(args.new_id), 4, { title: 'New linked task' }),
    },
    truth: (snap, args) => created(snap, str(args.new_id), 4, { title: 'New linked task' }),
  },
  {
    mutation: 'issues:create',
    mutator: 'addIssue',
    what: 'a new subtask of a task the window shows from its own answer',
    pause: 'P',
    detail: {
      answer: (args) =>
        args
          ? windowAnswer(
              { has_subtasks: true },
              {
                subtasks: {
                  rows: [createdShort(str(args.id), 4, false, { title: 'New subtask' })],
                  complete: true,
                },
              },
            )
          : windowAnswer(),
    },
    act: (P) => P.addIssue({ project: 'work', title: 'New subtask', parent: 'QN-80' }),
    answers: {
      'issues:create': (args) =>
        stored(str(args.id), 4, { title: 'New subtask', parent_id: WINDOW_TASK }),
    },
    truth: (snap, args) =>
      created(snap, str(args.id), 4, { title: 'New subtask', parent_id: WINDOW_TASK }),
  },
  {
    mutation: 'issues:createParent',
    mutator: 'createParent',
    what: 'a new parent task',
    pause: 'P',
    act: (P) => P.createParent('QN-3', 'New parent'),
    answers: {
      'issues:createParent': (args) => underNew(task('task-c', 3), str(args.parent_id), 4),
    },
    truth: (snap, args) => {
      created(snap, str(args.parent_id), 4, { title: 'New parent' })
      Object.assign(issue(snap, 'task-c'), { parent_id: str(args.parent_id), updated_at: SERVER })
      issue(snap, str(args.parent_id)).updated_at = SERVER
    },
  },
  {
    mutation: 'issues:createLinked',
    mutator: 'createLinked',
    what: 'a new linked task',
    pause: 'P',
    act: (P) => P.createLinked('QN-1', 'blocks', 'New linked task'),
    answers: {
      'issues:createLinked': (args) => stored(str(args.new_id), 4, { title: 'New linked task' }),
    },
    truth: (snap, args) => {
      created(snap, str(args.new_id), 4, { title: 'New linked task' })
      snap.links.push({
        id: str(args.link_id),
        source_id: 'task-a',
        target_id: str(args.new_id),
        type: 'blocks',
        pair_key: [str(args.new_id), 'task-a'].sort().join(':'),
        created_at: SERVER,
      })
    },
  },
  {
    mutation: 'issues:move',
    mutator: 'moveIssue',
    what: 'a task moved to another sub-project',
    pause: 'P',
    act: (P) => P.moveIssue('QN-2', 'work2'),
    // movedStamps: no status stamp, the review hand-off restarts
    truth: (snap) =>
      Object.assign(issue(snap, 'task-b'), {
        project_id: 'work2',
        status_at: undefined,
        review_at: SERVER,
        updated_at: SERVER,
      }),
  },
  {
    mutation: 'issues:deleteDeep',
    mutator: 'deleteIssue',
    what: 'a deleted task',
    pause: 'P',
    act: (P) => P.deleteIssue('QN-1'),
    truth: (snap) => {
      snap.issues = snap.issues.filter((r) => r.id !== 'task-a')
      snap.links = []
      snap.issueLabels = []
      snap.attachments = []
      snap.messages = snap.messages.filter((m) => m.issue_id !== 'task-a')
    },
  },
  {
    mutation: 'issues:deleteDeep',
    mutator: 'deleteIssue',
    what: 'a task deleted from the window that waits',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.deleteIssue('QN-3', [], true),
    truth: (snap) => {
      snap.issues = snap.issues.filter((r) => r.id !== 'task-c')
    },
  },
  {
    mutation: 'issues:archive',
    mutator: 'sendArchive',
    what: 'an archived task',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.archiveIssue('QN-3'),
    truth: (snap) => {
      snap.issues = snap.issues.filter((r) => r.id !== 'task-c')
    },
  },
  {
    mutation: 'issues:unarchive',
    mutator: 'unarchiveIssue',
    what: 'a restored task',
    pause: 'P',
    act: (P) => P.unarchiveIssue('task-z', 'Old task', 'work'),
    answers: { 'issues:unarchive': () => ({ issue: { id: 'task-z' }, left_parent: false }) },
  },
  {
    mutation: 'issues:addLink',
    mutator: 'addLink',
    what: 'a new link',
    pause: 'P',
    act: (P) => P.addLink('QN-1', 'relates', 'QN-3'),
    truth: (snap, args) =>
      snap.links.push({
        id: str(args.id),
        source_id: 'task-a',
        target_id: 'task-c',
        type: 'relates',
        pair_key: 'task-a:task-c',
        created_at: SERVER,
      }),
  },
  {
    mutation: 'issues:removeLink',
    mutator: 'removeLink',
    what: 'a removed link',
    pause: 'P',
    act: (P) => P.removeLink('QN-1', 'QN-2'),
    truth: (snap) => {
      snap.links = []
    },
  },
  {
    mutation: 'issues:setSubscriber',
    mutator: 'setIssueSubscriber',
    what: 'another person following a task',
    pause: 'U',
    act: (P) => P.setIssueSubscriber('QN-1', PAT, true, () => {}),
  },
  {
    mutation: 'issues:subscribe',
    mutator: 'setIssueSubscribed',
    what: 'following a task',
    pause: 'U',
    act: (P) => P.setIssueSubscribed('QN-1', true),
    truth: (snap) =>
      snap.issueSubs.push({ issue_id: 'task-a', profile_id: ME, created_at: SERVER }),
  },
  {
    mutation: 'issues:unsubscribe',
    mutator: 'setIssueSubscribed',
    what: 'no longer following a task',
    pause: 'U',
    act: (P) => P.setIssueSubscribed('QN-2', false),
    truth: (snap) => {
      snap.issueSubs = []
    },
  },
  /* --- files and Team sync ------------------------------------------- */
  {
    mutation: 'files:uploadUrl',
    mutator: 'addAttachment',
    what: 'an upload address',
    pause: 'P',
    act: (P) => P.addAttachment('QN-1', file('notes.txt', 'text/plain')),
    // the address then refuses the bytes, so the upload ends there
    answers: { 'files:uploadUrl': () => 'https://files.test/refused' },
  },
  {
    mutation: 'files:cancelDemoUpload',
    mutator: 'cancelDemoReservation',
    what: 'a cancelled demo upload',
    pause: 'P',
    act: (P) => P.addAttachment('QN-1', file('notes.txt', 'text/plain')),
    // the POST to the demo's upload address ends without an answer
    answers: { 'files:uploadUrl': () => 'https://files.test/demo-uploads/lost-1?e=1&m=me&t=t' },
  },
  {
    mutation: 'files:attach',
    mutator: 'addAttachment',
    what: 'a new attachment',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.addAttachment('QN-1', file('notes.txt', 'text/plain')),
    answers: {
      // an upload ticket's address, whose id the attachment takes
      'files:uploadUrl': () =>
        'https://files.test/attachment-uploads/0b7d6f4e-1c2a-4d3b-9e8f-7a6b5c4d3e2f?e=1&m=me&t=t',
      'files:attach': (args) => ({ attachment: attachmentOf(args) }),
    },
    truth: (snap, args) => snap.attachments.push(attachmentOf(args)),
  },
  {
    mutation: 'files:removeAttachment',
    mutator: 'removeAttachment',
    what: 'a removed attachment',
    pause: 'P',
    act: (P) => P.removeAttachment('att-a'),
    truth: (snap) => {
      snap.attachments = []
    },
  },
  {
    mutation: 'teamSync:stamp',
    mutator: 'syncStamp',
    what: 'a Team sync stamp',
    pause: 'P',
    act: (P) => P.syncStamp({ id: PAT, stamp: null }, ORG),
    // a first stamp keeps the reading day the page sent; the store paints
    // nothing, as the agenda answers the new stamp
    truth: (snap, args) =>
      Object.assign(profile(snap, PAT), {
        sync_at: SERVER,
        ...(args.first_since ? { sync_since: str(args.first_since) } : {}),
      }),
  },
  {
    mutation: 'files:avatarUploadUrl',
    mutator: 'setAvatar',
    what: 'a portrait upload address',
    pause: 'P',
    act: (P) => P.setAvatar(PAT, file('pat.png', 'image/png'), null),
    // the address then refuses the bytes, so the upload ends there
    answers: { 'files:avatarUploadUrl': () => 'https://files.test/refused' },
  },
  {
    mutation: 'files:cancelDemoUpload',
    mutator: 'cancelDemoReservation',
    what: 'a cancelled demo portrait upload',
    pause: 'P',
    act: (P) => P.setAvatar(PAT, file('pat.png', 'image/png'), null),
    // the POST to the demo's upload address ends without an answer
    answers: {
      'files:avatarUploadUrl': () => 'https://files.test/demo-uploads/lost-2?e=1&m=me&t=t',
    },
  },
  {
    mutation: 'files:setAvatar',
    mutator: 'setAvatar',
    what: 'a new portrait',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.setAvatar(PAT, file('pat.png', 'image/png'), null),
    answers: { 'files:avatarUploadUrl': () => 'https://files.test/avatar' },
    truth: (snap) => {
      profile(snap, PAT).avatar_storage_id = STORED as Row<'profiles'>['avatar_storage_id']
    },
  },
  {
    mutation: 'files:clearAvatar',
    mutator: 'clearAvatar',
    what: 'a removed portrait',
    paintsOnAccept: true,
    pause: 'P',
    seed: (snap) => {
      profile(snap, PAT).avatar_storage_id = STORED as Row<'profiles'>['avatar_storage_id']
    },
    // the page shows the picture's version from its own answer, as the
    // store holds nobody but the signed-in person
    act: (P) => P.clearAvatar(PAT, STORED),
    truth: (snap) => {
      profile(snap, PAT).avatar_storage_id = undefined
    },
  },
  /* --- comments ------------------------------------------------------- */
  {
    mutation: 'comments:create',
    mutator: 'addComment',
    what: 'a new comment',
    pause: 'P',
    act: (P) => P.addComment('task-a', 'A new comment'),
    thread: (page, args) =>
      page.comments.push({
        id: str(args.id),
        issue_id: 'task-a',
        author: ME,
        body: 'A new comment',
        created_at: SERVER,
      }),
  },
  {
    mutation: 'comments:countThread',
    mutator: 'countAfterRefusal',
    what: "the count a comment refused while the task's comments are counted starts",
    pause: 'P',
    act: (P) => P.addComment('task-a', 'Posted while the comments are counted'),
    // the post's refusal, which a resolve with a rejected promise delivers
    answers: {
      'comments:create': () =>
        Promise.reject(
          new ConvexError({
            code: 'rule',
            message: "Qivo is still counting this task's comments. Try again in 60 seconds.",
            reason: 'comments_counting',
            retry_after: 60,
            task_id: 'task-a',
          }),
        ),
    },
  },
  {
    mutation: 'comments:update',
    mutator: 'updateComment',
    what: 'an edited comment',
    pause: 'P',
    act: (P) => P.updateComment('comment-a', 'Edited'),
    thread: (page) =>
      Object.assign(page.comments[0], { body: 'Edited', edited_at: SERVER, edited_by: ME }),
  },
  {
    mutation: 'comments:remove',
    mutator: 'deleteComment',
    what: 'a deleted comment',
    pause: 'P',
    act: (P) => P.deleteComment('comment-b'),
    thread: (page) => {
      page.comments = page.comments.filter((c) => c.id !== 'comment-b')
    },
  },
  /* --- inbox ---------------------------------------------------------- */
  {
    // the item read of P.readItem, which the read on open (P.readOnOpen)
    // sends too. The server marks every unread message of the item stored
    // up to `through` read and prunes the item to its newest message, the
    // one msg-1 here
    mutation: 'messages:readItem',
    mutator: 'sendItemRead',
    what: "a task's inbox item read",
    pause: 'U',
    act: (P) =>
      P.readItem({
        org: ORG,
        task: 'task-a',
        through: Date.parse('2026-10-19T08:00:00.000Z'),
      }),
    truth: (snap) => {
      snap.messages[0].read_at = SERVER
    },
  },
  {
    // the Inbox row's Mark as unread (P.unreadItem). The server marks every
    // message of the item unread, msg-2 here
    mutation: 'messages:unreadItem',
    mutator: 'unreadItem',
    what: "a task's inbox item back to unread",
    pause: 'U',
    act: (P) =>
      P.unreadItem({ org: ORG, task: 'task-b', through: Date.parse('2026-10-19T08:00:00.000Z') }),
    truth: (snap) => {
      snap.messages[1].read_at = undefined
    },
  },
  {
    // the Inbox row's Remove notification (P.removeItem). The server removes
    // every message of the item stored up to `through`, msg-2 here
    mutation: 'messages:removeItem',
    mutator: 'removeItem',
    what: "a task's inbox item removed",
    pause: 'U',
    act: (P) =>
      P.removeItem({
        org: ORG,
        task: 'task-b',
        through: Date.parse('2026-10-19T08:00:00.000Z'),
      }),
    truth: (snap) => {
      snap.messages = [snap.messages[0]]
    },
  },
  {
    // the Inbox row's Snooze (P.snoozeItem). The server stamps every message
    // of the item, msg-1 here
    mutation: 'messages:snoozeItem',
    mutator: 'snoozeItem',
    what: "a task's inbox item snoozed",
    pause: 'U',
    act: (P) =>
      P.snoozeItem(
        { org: ORG, task: 'task-a', through: Date.parse('2026-10-19T08:00:00.000Z') },
        '2026-10-27T08:00:00.000Z',
      ),
    truth: (snap) => {
      snap.messages[0].snoozed_until = '2026-10-27T08:00:00.000Z'
    },
  },
  {
    mutation: 'messages:markAllRead',
    mutator: 'markAllMessagesRead',
    what: 'every message read',
    pause: 'U',
    act: (P) => P.markAllMessagesRead(),
    answers: {
      'messages:markAllRead': () => ({ marked: 1, ids: ['msg-1'], hasMore: false, before: 1 }),
    },
    truth: (snap) => {
      snap.messages[0].read_at = SERVER
    },
  },
  {
    mutation: 'messages:removeRead',
    mutator: 'deleteReadMessages',
    what: 'every read message removed',
    pause: 'U',
    act: (P) => P.deleteReadMessages(),
    answers: { 'messages:removeRead': () => ({ removed: 1, ids: ['msg-2'], hasMore: false }) },
    truth: (snap) => {
      snap.messages = [snap.messages[0]]
    },
  },
  {
    mutation: 'profiles:setMessageRetention',
    mutator: 'setMessageRetention',
    what: 'a longer message retention',
    pause: 'U',
    act: (P) => P.setMessageRetention(30),
    truth: (snap) => {
      profile(snap, ME).message_retention_days = 30
    },
  },
  /* --- the person's own settings and credentials ---------------------- */
  {
    mutation: 'appearance:save',
    mutator: 'setAppearance',
    what: 'an appearance',
    pause: 'U-all',
    act: (P) => P.setAppearance({ mode: 'dark', image_source: 'none' }).catch(() => {}),
  },
  {
    mutation: 'notifications:setDelivery',
    mutator: 'setNotificationDelivery',
    what: 'a notification delivery',
    pause: 'U-all',
    act: (P) => P.setNotificationDelivery('all').catch(() => {}),
  },
  {
    mutation: 'appearance:removeCustom',
    mutator: 'removeAppearanceImage',
    what: 'a removed background',
    pause: 'U-all',
    act: (P) => P.removeAppearanceImage().catch(() => {}),
  },
  {
    mutation: 'appearance:createUpload',
    mutator: 'uploadAppearanceImage',
    what: 'a background upload',
    pause: 'U-all',
    act: (P) =>
      P.uploadAppearanceImage(file('bg.png', 'image/png'), new AbortController().signal).catch(
        () => {},
      ),
    answers: {
      'appearance:createUpload': () => ({
        ticket_id: 'ticket-1',
        upload_url: 'https://files.test/background',
        expires_at: 0,
      }),
    },
  },
  {
    mutation: 'appearance:cancelUpload',
    mutator: 'uploadAppearanceImage',
    what: 'a cancelled background upload',
    pause: 'U-all',
    act: (P) =>
      P.uploadAppearanceImage(file('bg.png', 'image/png'), new AbortController().signal).catch(
        () => {},
      ),
    answers: {
      // the upload address refuses the bytes, so the ticket is cancelled
      'appearance:createUpload': () => ({
        ticket_id: 'ticket-1',
        upload_url: 'https://files.test/refused',
        expires_at: 0,
      }),
    },
  },
  {
    mutation: 'profiles:setDisplayName',
    mutator: 'setDisplayName',
    what: 'a new display name',
    pause: 'P',
    act: (P) => P.setDisplayName('Planner Two'),
  },
  {
    mutation: 'tokens:createAgentKey',
    mutator: 'createAgentKey',
    what: 'a new agent key',
    pause: 'P',
    act: (P) => P.createAgentKey(PAT, 'Key'),
  },
  {
    mutation: 'tokens:revokeAgentKey',
    mutator: 'revokeAgentKey',
    what: 'a revoked agent key',
    pause: 'U',
    act: (P) => P.revokeAgentKey('key-1'),
  },
  {
    mutation: 'tokens:deleteAgentKey',
    mutator: 'deleteAgentKey',
    what: 'a deleted agent key',
    pause: 'U',
    act: (P) => P.deleteAgentKey('key-1'),
  },
  {
    mutation: 'apiAccess:revoke',
    mutator: 'revokeApiCredential',
    what: 'a revoked credential',
    pause: 'U',
    act: (P) => P.revokeApiCredential('agent_keys', 'key-1'),
  },
  {
    mutation: 'oauthConnections:getContext',
    mutator: 'getOAuthConnectionContext',
    what: 'a connected app consent page',
    pause: 'U',
    act: (P) => P.getOAuthConnectionContext('client_id=app').catch(() => {}),
  },
  {
    mutation: 'oauthConnections:revoke',
    mutator: 'revokeOAuthConnection',
    what: 'a removed connected app',
    pause: 'U-all',
    act: (P) => P.revokeOAuthConnection('connection-1'),
  },
  {
    mutation: 'tokens:createMcpToken',
    mutator: 'createMcpToken',
    what: 'a new personal token',
    pause: 'P',
    act: (P) => P.createMcpToken('Token', { access: 'read' }),
  },
  {
    mutation: 'tokens:revokeMcpToken',
    mutator: 'revokeMcpToken',
    what: 'a revoked personal token',
    pause: 'U',
    act: (P) => P.revokeMcpToken('token-1'),
  },
  {
    mutation: 'tokens:deleteMcpToken',
    mutator: 'deleteMcpToken',
    what: 'a deleted personal token',
    pause: 'U',
    act: (P) => P.deleteMcpToken('token-1'),
  },
  {
    mutation: 'prefs:save',
    mutator: 'write',
    what: 'saved view preferences',
    pause: 'U',
    act: (P) => P.saveUINow({ view: 'board' }),
  },
  // a favorite reaches no snapshot, so the star has no truth: the
  // navigation reads' next answers show it
  {
    mutation: 'projectNav:setFavorite',
    mutator: 'setFavorite',
    what: 'a starred project',
    pause: 'U',
    act: (P) => P.setFavorite({ id: 'plan', org_id: ORG }, true),
  },
  /* --- organization setup -------------------------------------------- */
  {
    mutation: 'identity:createOrganization',
    mutator: 'createOrg',
    what: 'a new organization',
    pause: 'P',
    act: (P) => P.createOrg('New Labs'),
    // the boot createOrg runs again claims the seats first
    answers: { 'identity:claimMySeats': () => null },
  },
  {
    mutation: 'identity:claimMySeats',
    mutator: 'initStore',
    what: 'the seat claim at boot',
    pause: 'P',
    // the boot run again, as createOrg does
    act: (_P, store) => store.initStore(),
  },
  {
    mutation: 'projects:inviteGuest',
    mutator: 'inviteToProject',
    what: 'a guest invitation',
    pause: 'P',
    answers: { 'projects:inviteGuest': () => ({ id: 'guest-1', emailed: true }) },
    act: (P) => P.inviteToProject('plan', 'guest@example.test'),
  },
  {
    mutation: 'deletedItems:restore',
    // P.restoreDeletedItems sends its calls on the shared runner
    // (runDeletedItems), each through restoreCall
    mutator: 'restoreCall',
    what: 'a restored Deleted item',
    pause: 'P',
    act: (P) => P.restoreDeletedItems([{ id: 'item-1', org_id: ORG }]),
    answers: { 'deletedItems:restore': () => ({ restored: ['item-1'], refused: [] }) },
  },
  {
    mutation: 'deletedItems:purge',
    mutator: 'purgeCall',
    what: 'a Deleted item deleted for good',
    pause: 'P',
    act: (P) => P.purgeDeletedItems([{ id: 'item-1', org_id: ORG }]),
    answers: { 'deletedItems:purge': () => ({ purged: ['item-1'], refused: [] }) },
  },
  /* --- projects, access, milestones ---------------------------------- */
  {
    mutation: 'projects:create',
    mutator: 'addProject',
    what: 'a new project',
    pause: 'P',
    act: (P) => P.addProject({ type: 'meta', key: 'NEW', name: 'New project', access: {} }),
    answers: { 'projects:create': () => ({ num: 4, key: 'NEW' }) },
    // an admin creator leads it and gets no grant of their own; it goes one
    // past Plan, the organization's one top-level project, as the server
    // places a create without a sort_order (nextSiblingPlace)
    truth: (snap, args) => {
      snap.projects.push({
        id: str(args.id),
        org_id: ORG,
        type: 'meta',
        key: 'NEW',
        num: 4,
        name: 'New project',
        lead_id: ME,
        description: '',
        sort_order: 1,
        track_delay: true,
        created_at: SERVER,
      })
    },
  },
  {
    mutation: 'projects:create',
    mutator: 'addProject',
    what: 'a new sub-project in the organization its dialog showed',
    pause: 'P',
    act: (P) =>
      P.addProject(
        { type: 'project', key: 'DOCS', name: 'Docs', parent: 'plan', lead: ME },
        undefined,
        undefined,
        { orgId: ORG },
      ),
    answers: { 'projects:create': () => ({ num: 4, key: 'DOCS' }) },
    // one past Work 2, the last of Plan's sub-projects
    truth: (snap, args) => {
      snap.projects.push({
        id: str(args.id),
        org_id: ORG,
        type: 'project',
        parent_id: 'plan',
        key: 'DOCS',
        num: 4,
        name: 'Docs',
        lead_id: ME,
        description: '',
        sort_order: 2,
        track_delay: true,
        created_at: SERVER,
      })
    },
  },
  /* the writes of a project's Settings page, which send what the page
     showed (store/planner.ts ProjectShown and GrantShown): the store holds
     no project, so every project write names the organization of the page
     that showed it, and refuses without one */
  {
    mutation: 'projects:update',
    mutator: 'updateProject',
    what: 'a renamed project',
    pause: 'P',
    act: (P) => P.updateProject('plan', { name: 'Renamed plan' }, {}, { orgId: ORG }),
    truth: (snap) => {
      snap.projects[0].name = 'Renamed plan'
    },
  },
  {
    mutation: 'projects:update',
    mutator: 'updateProject',
    what: "a project's delay tracking as its settings page showed it",
    pause: 'P',
    act: (P) =>
      P.updateProject(
        'plan',
        { trackDelay: false },
        { seen: { track_delay: true } },
        { orgId: ORG },
      ),
    truth: (snap) => {
      snap.projects[0].track_delay = false
    },
  },
  {
    mutation: 'projects:update',
    mutator: 'updateProject',
    what: "a project's lead as its settings page showed it",
    pause: 'P',
    act: (P) => P.updateProject('plan', { lead: PAT }, { seen: { lead_id: ME } }, { orgId: ORG }),
    truth: (snap) => {
      snap.projects[0].lead_id = PAT
      snap.access = [{ project_id: 'plan', profile_id: ME, level: 'user' }]
    },
  },
  {
    mutation: 'projects:setAccess',
    mutator: 'setProjectAccess',
    what: "a person's access level as the settings page's list showed it",
    pause: 'P',
    act: (P) =>
      P.setProjectAccess('plan', PAT, 'viewer', { orgId: ORG, level: 'user', leadId: ME }),
    truth: (snap) => {
      snap.access[0].level = 'viewer'
    },
  },
  {
    mutation: 'projects:setAccess',
    mutator: 'setProjectTeamAccess',
    what: "a team added through the settings page's picker",
    pause: 'P',
    act: (P) => P.setProjectTeamAccess('plan', 'team-b', 'viewer', { orgId: ORG, level: null }),
    truth: (snap) =>
      snap.teamAccess.push({ project_id: 'plan', team_id: 'team-b', level: 'viewer' }),
  },
  {
    mutation: 'projects:archive',
    mutator: 'archiveProject',
    what: 'an archived sub-project',
    pause: 'P',
    act: (P) => P.archiveProject('work2', { orgId: ORG }),
    truth: (snap) => {
      snap.projects[2].archived_at = SERVER
    },
  },
  {
    mutation: 'projects:unarchive',
    mutator: 'unarchiveProject',
    what: 'a project restored from Archived projects, which names its organization',
    pause: 'P',
    seed: (snap) => {
      snap.projects[2].archived_at = '2026-10-10T08:00:00.000Z'
    },
    act: (P) => P.unarchiveProject('work2', { orgId: ORG }),
  },
  {
    mutation: 'projects:deleteDeep',
    mutator: 'removeProject',
    what: 'a deleted sub-project',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.removeProject('work2', undefined, { orgId: ORG }),
    truth: (snap) => {
      snap.projects = snap.projects.filter((p) => p.id !== 'work2')
    },
  },
  {
    mutation: 'projects:setAccess',
    mutator: 'setProjectTeamAccess',
    what: "a team's access level",
    pause: 'P',
    act: (P) => P.setProjectTeamAccess('plan', 'team-b', 'user', { orgId: ORG, level: null }),
    truth: (snap) => snap.teamAccess.push({ project_id: 'plan', team_id: 'team-b', level: 'user' }),
  },
  {
    mutation: 'projects:removeAccess',
    mutator: 'sendRemoval',
    what: "a person's access removed",
    pause: 'P',
    act: (P) =>
      P.removeAccess({ kind: 'userGrant', projectId: 'plan', userId: PAT }, { keep: true }),
    truth: (snap) => {
      snap.access = []
    },
  },
  {
    mutation: 'projects:removeAccess',
    mutator: 'sendRemoval',
    what: "a person's access removed from the settings page, which names its organization",
    pause: 'P',
    act: (P) =>
      P.removeAccess(
        { kind: 'userGrant', projectId: 'plan', userId: PAT, orgId: ORG },
        { keep: true },
      ),
    truth: (snap) => {
      snap.access = []
    },
  },
  {
    mutation: 'teams:removeMember',
    mutator: 'sendRemoval',
    what: 'a member leaving a team',
    pause: 'P',
    act: (P) =>
      P.removeAccess({ kind: 'teamMember', teamId: 'team-a', userId: PAT }, { keep: true }),
    truth: (snap) => {
      snap.teamMembers = snap.teamMembers.filter((m) => m.profile_id !== PAT)
    },
  },
  {
    mutation: 'teams:removeMember',
    mutator: 'sendRemoval',
    what: 'a member leaving a team from its page, which names the organization and the member',
    pause: 'P',
    act: (P) =>
      P.removeAccess(
        { kind: 'teamMember', teamId: 'team-a', userId: PAT, orgId: ORG, label: 'Pat as shown' },
        { keep: true },
      ),
    truth: (snap) => {
      snap.teamMembers = snap.teamMembers.filter((m) => m.profile_id !== PAT)
    },
  },
  // the milestone writes, each from a milestone read, as the projects
  // part sends no milestone
  {
    mutation: 'projects:addMilestone',
    mutator: 'addMilestone',
    what: 'a new milestone in a read that covers it',
    pause: 'P',
    milestones: milestoneRange((args) =>
      args
        ? [
            MS_A,
            {
              id: str(args.id),
              project_id: 'plan',
              name: 'Beta',
              week: '2026-11-09',
              created_at: SERVER,
            },
          ]
        : [MS_A],
    ),
    act: (P) => P.addMilestone({ project: 'work', name: 'Beta', week: P.isoToWeek('2026-11-09') }),
  },
  {
    mutation: 'projects:updateMilestone',
    mutator: 'updateMilestone',
    what: 'a renamed milestone only a read holds',
    pause: 'P',
    milestones: milestoneRange((args) => [args ? { ...MS_A, name: 'Release' } : MS_A]),
    act: (P) => P.updateMilestone('ms-a', { name: 'Release' }),
  },
  {
    mutation: 'projects:updateMilestone',
    mutator: 'updateMilestone',
    what: 'a moved milestone only an opened read holds',
    pause: 'P',
    milestones: {
      slot: 'milestone:open',
      ask: { kind: 'get', id: 'ms-a' },
      query: 'milestones:get',
      answer: (args) => ({
        row: args ? { ...MS_A, week: '2026-11-09' } : MS_A,
        project: { id: 'plan', name: 'Plan', key: 'QN', org_id: ORG },
        can_write: true,
      }),
    },
    act: (P) => P.updateMilestone('ms-a', { week: P.isoToWeek('2026-11-09') }),
  },
  {
    mutation: 'projects:removeMilestone',
    mutator: 'removeMilestone',
    what: 'a removed milestone only a read holds',
    pause: 'P',
    milestones: milestoneRange((args) => (args ? [] : [MS_A])),
    act: (P) => P.removeMilestone('ms-a'),
  },
  {
    mutation: 'roadmap:change',
    mutator: 'submitRoadmapChanges',
    what: 'a planning change on Roadmap',
    pause: 'P',
    prepare: (P) => P.roadmapContext(true, false),
    act: (P) => P.updateIssue('QN-1', planned(P)),
    answers: { 'roadmap:change': () => ({ count: 1 }) },
    truth: (snap) => Object.assign(issue(snap, 'task-a'), PLANNED, { updated_at: SERVER }),
  },
  {
    mutation: 'issues:update',
    mutator: 'moveDependencyTask',
    what: "Auto-move's move of a task only the dependency answer holds, with no visit to record it",
    pause: 'P',
    // no screen shows the task, so it paints nothing: the delivery shows it
    paintsOnAccept: true,
    act: (P) => {
      const { start, end } = planned(P)
      return P.moveDependencyTask(
        {
          id: 'task-a',
          org_id: ORG,
          project_id: 'work',
          num: 1,
          status: 'todo',
          has_subtasks: false,
        },
        start,
        end,
      )
    },
    truth: (snap) => Object.assign(issue(snap, 'task-a'), PLANNED, { updated_at: SERVER }),
  },
  {
    mutation: 'roadmap:undo',
    mutator: 'undoRoadmap',
    what: 'an undone Roadmap change',
    pause: 'P',
    // a saved Roadmap change to undo
    prepare: async (P, server) => {
      P.roadmapContext(true, false)
      P.updateIssue('QN-1', planned(P))
      await server.answer('roadmap:change', { count: 1 }, (snap) =>
        Object.assign(issue(snap, 'task-a'), PLANNED, { updated_at: SERVER }),
      )
    },
    act: (P) => P.undoRoadmap(),
    answers: { 'roadmap:undo': () => ({ count: 0 }) },
  },
  /* --- organization, teams, people, labels --------------------------- */
  {
    mutation: 'orgs:update',
    mutator: 'setOrg',
    what: 'a renamed organization',
    pause: 'P',
    act: (P) => P.setOrg({ name: 'Renamed Labs' }),
    truth: (snap) => {
      snap.orgs[0].name = 'Renamed Labs'
    },
  },
  {
    mutation: 'orgs:setSlug',
    mutator: 'setOrgSlug',
    what: 'a new organization address',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.setOrgSlug('renamed'),
    truth: (snap) => {
      snap.orgs[0].slug = 'renamed'
    },
  },
  {
    mutation: 'teams:create',
    mutator: 'addTeam',
    what: 'a new team',
    pause: 'P',
    act: (P) => P.addTeam('Design'),
    truth: (snap, args) =>
      snap.teams.push({
        id: str(args.id),
        org_id: ORG,
        name: 'Design',
        track_delay_default: true,
        created_at: SERVER,
      }),
  },
  {
    mutation: 'teams:update',
    mutator: 'updateTeam',
    what: 'a renamed team',
    pause: 'P',
    act: (P) =>
      P.updateTeam(
        'team-a',
        { name: 'Field crew' },
        {},
        { orgId: P.homeOrg, name: P.teamById('team-a')?.name ?? '' },
      ),
    truth: (snap) => {
      snap.teams[0].name = 'Field crew'
    },
  },
  {
    mutation: 'teams:update',
    mutator: 'updateTeam',
    what: 'a renamed team the workspace does not hold, which paints nothing',
    pause: 'P',
    act: (P) =>
      P.updateTeam('team-far', { name: 'Far crew' }, {}, { orgId: ORG, name: 'Far team' }),
  },
  {
    mutation: 'teams:addMember',
    mutator: 'addTeamMember',
    what: 'a new team member',
    pause: 'P',
    act: (P) => P.addTeamMember('team-b', PAT, { orgId: P.homeOrg }),
    truth: (snap) =>
      snap.teamMembers.push({ team_id: 'team-b', profile_id: PAT, is_leader: false }),
  },
  {
    mutation: 'teams:setLeader',
    mutator: 'setTeamLeader',
    what: 'a new team leader',
    pause: 'P',
    act: (P) => P.setTeamLeader('team-a', PAT, true, { orgId: P.homeOrg, isLeader: false }),
    truth: (snap) => {
      snap.teamMembers[1].is_leader = true
    },
  },
  {
    mutation: 'teams:deleteDeep',
    mutator: 'sendRemoval',
    what: 'a deleted team from Settings › Teams, which names its organization and the team',
    pause: 'P',
    act: (P) =>
      P.removeAccess(
        { kind: 'deleteTeam', teamId: 'team-b', orgId: ORG, label: 'Team B as shown' },
        { keep: true },
      ),
    truth: (snap) => {
      snap.teams = [snap.teams[0]]
    },
  },
  {
    mutation: 'profiles:create',
    mutator: 'addUser',
    what: 'a new person',
    pause: 'P',
    act: (P) => P.addUser({ name: 'New Person', email: 'new@example.test', teams: ['team-b'] }),
    truth: (snap, args) => {
      snap.profiles.push({
        id: str(args.id),
        org_id: ORG,
        email: 'new@example.test',
        name: 'New Person',
        initials: 'NP',
        color: str(args.color),
        org_role: 'user',
        kind: 'person',
        active: true,
        plannable_hours: 40,
        message_retention_days: 7,
        created_at: SERVER,
      })
      snap.teamMembers.push({ team_id: 'team-b', profile_id: str(args.id), is_leader: false })
    },
  },
  {
    mutation: 'profiles:setPlannableHours',
    mutator: 'updateUser',
    what: "a person's plannable hours",
    pause: 'P',
    act: (P) => P.updateUser(PAT, { plannableHours: 30 }, {}, shownOf(fixture(), PAT)),
    truth: (snap) => {
      profile(snap, PAT).plannable_hours = 30
    },
  },
  {
    mutation: 'invites:sendAgain',
    mutator: 'sendInvitationAgain',
    what: 'an invitation email sent again, which paints nothing',
    pause: 'P',
    act: (P) => P.sendInvitationAgain(ORG, PAT),
  },
  {
    mutation: 'profiles:deactivate',
    mutator: 'updateUser',
    what: 'a person switched off',
    pause: 'U',
    act: (P) => P.updateUser(PAT, { active: false }, {}, shownOf(fixture(), PAT)),
    truth: (snap) => {
      profile(snap, PAT).active = false
    },
  },
  {
    mutation: 'profiles:update',
    mutator: 'updateUser',
    what: "a person's name and teams",
    pause: 'P',
    act: (P) =>
      P.updateUser(PAT, { name: 'Pat Quinn', teams: ['team-b'] }, {}, shownOf(fixture(), PAT)),
    truth: (snap) => {
      Object.assign(profile(snap, PAT), { name: 'Pat Quinn', initials: 'PQ' })
      snap.teamMembers = [
        snap.teamMembers[0],
        { team_id: 'team-b', profile_id: PAT, is_leader: false },
      ]
    },
  },
  {
    mutation: 'profiles:update',
    mutator: 'updateUser',
    what: 'a renamed person the workspace does not hold, which paints nothing',
    pause: 'P',
    act: (P) =>
      P.updateUser(
        'person-far',
        { name: 'Far Person' },
        {},
        {
          orgId: ORG,
          name: 'Far',
          isAgent: false,
          pending: false,
          orgRole: 'user',
          active: true,
          plannableHours: null,
        },
      ),
  },
  {
    mutation: 'profiles:remove',
    mutator: 'removeUser',
    what: 'a removed person',
    pause: 'U',
    act: (P) => P.removeUser(PAT, { orgId: P.homeOrg }),
    // the server clears the person from tasks and grants in one transaction
    truth: (snap) => {
      snap.profiles = [snap.profiles[0]]
      snap.teamMembers = [snap.teamMembers[0]]
      snap.access = []
      Object.assign(issue(snap, 'task-a'), { assignee_id: undefined, updated_at: SERVER })
    },
  },
  {
    mutation: 'labels:create',
    mutator: 'addLabel',
    what: 'a new label',
    pause: 'P',
    act: (P) => P.addLabel({ name: 'Feature', color: '#33aa33' }),
    truth: (snap, args) =>
      snap.labels.push({
        id: str(args.id),
        org_id: ORG,
        name: 'Feature',
        name_lower: 'feature',
        color: '#33aa33',
        created_at: SERVER,
      }),
  },
  {
    mutation: 'labels:update',
    mutator: 'updateLabel',
    what: 'a renamed label',
    pause: 'P',
    act: (P) =>
      P.updateLabel('label-a', { name: 'Defect' }, {}, labelShownOf(fixture(), 'label-a')),
    truth: (snap) => Object.assign(snap.labels[0], { name: 'Defect', name_lower: 'defect' }),
  },
  {
    mutation: 'labels:update',
    mutator: 'updateLabel',
    what: 'a renamed label the workspace does not hold, which paints nothing',
    pause: 'P',
    act: (P) =>
      P.updateLabel(
        'label-far',
        { name: 'Far defect' },
        {},
        { orgId: ORG, name: 'Far label', color: '#335577' },
      ),
  },
  {
    mutation: 'labels:remove',
    mutator: 'removeLabel',
    what: 'a removed label',
    pause: 'P',
    act: (P) => P.removeLabel('label-a', labelShownOf(fixture(), 'label-a')),
    truth: (snap) => {
      snap.labels = []
      snap.issueLabels = []
    },
  },
  {
    mutation: 'labels:remove',
    mutator: 'removeLabel',
    what: 'a removed label the workspace does not hold, which paints nothing',
    pause: 'P',
    act: (P) => P.removeLabel('label-far', { orgId: ORG, name: 'Far label', color: '#335577' }),
  },
  {
    mutation: 'labels:toggle',
    mutator: 'toggleIssueLabel',
    what: 'a label put on a task',
    pause: 'P',
    act: (P) => P.toggleIssueLabel('QN-3', 'label-a'),
    truth: (snap) => snap.issueLabels.push({ issue_id: 'task-c', label_id: 'label-a' }),
  },
  {
    mutation: 'labels:toggle',
    mutator: 'toggleIssueLabel',
    what: 'a label the workspace does not hold put on a task, as the picker or the window named it',
    pause: 'P',
    act: (P) => P.toggleIssueLabel('QN-3', 'label-far'),
    truth: (snap) => snap.issueLabels.push({ issue_id: 'task-c', label_id: 'label-far' }),
  },
]

/* The portrait a recipe's upload stores. */
const STORED = 'storage-portrait'

/* The attachment row files:attach answers with and the snapshot holds. */
function attachmentOf(args: Record<string, unknown>): Row<'issue_attachments'> {
  return {
    id: str(args.id),
    issue_id: str(args.issue_id),
    name: str(args.name),
    mime: args.mime === undefined ? undefined : str(args.mime),
    size_bytes: 5,
    inline: !!args.inline,
    storage_id: str(args.storage_id) as Row<'issue_attachments'>['storage_id'],
    created_at: SERVER,
  }
}
