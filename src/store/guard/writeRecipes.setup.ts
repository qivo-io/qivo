import type { FunctionReturnType } from 'convex/server'
import type { api } from '../../../convex/_generated/api'
import type { Row } from '../rows'

/* One recipe per write the store sends (layerGuard.test.ts checks that each
   mutation has one, and each mutator is named). writeRecipes.test.ts runs
   every recipe through four scenarios against the shared Convex double.
   A recipe's `truth` is the snapshot as the server holds it after the
   write, written from the server's code with its own stamps, so a paint
   that differs from what the server stores shows up. */

export type Snapshot = NonNullable<FunctionReturnType<typeof api.snapshot.forMe>>
export type Thread = FunctionReturnType<typeof api.snapshot.commentThread>
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
}

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
    three tasks, a link, a label, a milestone, an attachment and two
    messages. */
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
        next_project_num: 3,
        date_format: 'iso',
        week_start: 1,
        week_one_rule: 'first4day',
        default_plannable_hours: 40,
        gravatar_avatars: false,
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
    milestones: [
      {
        id: 'ms-a',
        project_id: 'plan',
        name: 'Launch',
        week: '2026-11-02',
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
    readMessageCount: 1,
    unreadTruncated: false,
    readTruncated: false,
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
    events: [],
    events_earlier: false,
    events_next: null,
  }
}

const issue = (snap: Snapshot, id: string) => snap.issues.find((r) => r.id === id)!
const profile = (snap: Snapshot, id: string) => snap.profiles.find((r) => r.id === id)!
const str = (value: unknown) => String(value)

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

const file = (name: string, type: string) => new File(['bytes'], name, { type })

export const recipes: Recipe[] = [
  /* --- tasks ---------------------------------------------------------- */
  {
    mutation: 'issues:create',
    mutator: 'addIssue',
    what: 'a new task',
    pause: 'P',
    act: (P) => P.addIssue({ project: 'work', title: 'New task' }),
    answers: { 'issues:create': () => ({ num: 4 }) },
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
    mutation: 'issues:createParent',
    mutator: 'createParent',
    what: 'a new parent task',
    pause: 'P',
    act: (P) => P.createParent('QN-3', 'New parent'),
    answers: { 'issues:createParent': () => ({ parent_num: 4 }) },
    truth: (snap, args) => {
      created(snap, str(args.parent_id), 4, { title: 'New parent' })
      Object.assign(issue(snap, 'task-c'), { parent_id: str(args.parent_id), updated_at: SERVER })
      issue(snap, str(args.parent_id)).updated_at = SERVER
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
    mutator: 'archiveIssue',
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
    mutation: 'files:attach',
    mutator: 'addAttachment',
    what: 'a new attachment',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.addAttachment('QN-1', file('notes.txt', 'text/plain')),
    answers: {
      'files:uploadUrl': () => 'https://files.test/upload',
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
    act: (P) => P.syncStamp(PAT),
    // a first stamp keeps the reading day the page sent
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
    act: (P) => P.setAvatar(PAT, file('pat.png', 'image/png')),
    // the address then refuses the bytes, so the upload ends there
    answers: { 'files:avatarUploadUrl': () => 'https://files.test/refused' },
  },
  {
    mutation: 'files:setAvatar',
    mutator: 'setAvatar',
    what: 'a new portrait',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.setAvatar(PAT, file('pat.png', 'image/png')),
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
    act: (P) => P.clearAvatar(PAT),
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
    mutation: 'messages:markRead',
    mutator: 'markMessagesRead',
    what: 'a read message',
    pause: 'U',
    act: (P) => P.markMessagesRead(['msg-1']),
    truth: (snap) => {
      snap.messages[0].read_at = SERVER
      snap.readMessageCount = 2
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
      snap.readMessageCount = 2
    },
  },
  {
    mutation: 'messages:markUnread',
    mutator: 'markMessagesUnread',
    what: 'a message back to unread',
    pause: 'U',
    act: (P) => P.markMessagesUnread(['msg-2']),
    truth: (snap) => {
      snap.messages[1].read_at = undefined
      snap.readMessageCount = 0
    },
  },
  {
    mutation: 'messages:remove',
    mutator: 'deleteMessages',
    what: 'a removed message',
    pause: 'U',
    act: (P) => P.deleteMessages(['msg-2']),
    truth: (snap) => {
      snap.messages = [snap.messages[0]]
      snap.readMessageCount = 0
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
      snap.readMessageCount = 0
    },
  },
  {
    mutation: 'messages:snooze',
    mutator: 'snoozeMessages',
    what: 'a snoozed message',
    pause: 'U',
    act: (P) => P.snoozeMessages(['msg-1'], '2026-10-27T08:00:00.000Z'),
    truth: (snap) => {
      snap.messages[0].snoozed_until = '2026-10-27T08:00:00.000Z'
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
    mutator: 'restoreDeletedItems',
    what: 'a restored Deleted item',
    pause: 'P',
    act: (P) => P.restoreDeletedItems([{ id: 'item-1', org_id: ORG }]),
    answers: { 'deletedItems:restore': () => ({ restored: ['item-1'], refused: [] }) },
  },
  {
    mutation: 'deletedItems:purge',
    mutator: 'purgeDeletedItems',
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
    // an admin creator leads it and gets no grant of their own
    truth: (snap, args) => {
      snap.orgs[0].next_project_num = 4
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
    mutation: 'projects:update',
    mutator: 'updateProject',
    what: 'a renamed project',
    pause: 'P',
    act: (P) => P.updateProject('plan', { name: 'Renamed plan' }),
    truth: (snap) => {
      snap.projects[0].name = 'Renamed plan'
    },
  },
  {
    mutation: 'projects:update',
    mutator: 'updateProject',
    what: 'a project led by someone else',
    pause: 'P',
    act: (P) => P.updateProject('plan', { lead: PAT }),
    // grantsAfterHandover: the outgoing lead keeps User, the incoming one's grant goes
    truth: (snap) => {
      snap.projects[0].lead_id = PAT
      snap.access = [{ project_id: 'plan', profile_id: ME, level: 'user' }]
    },
  },
  {
    mutation: 'projects:archive',
    mutator: 'archiveProject',
    what: 'an archived sub-project',
    pause: 'P',
    act: (P) => P.archiveProject('work2'),
    truth: (snap) => {
      snap.projects[2].archived_at = SERVER
    },
  },
  {
    mutation: 'projects:unarchive',
    mutator: 'unarchiveProject',
    what: 'a restored project',
    pause: 'P',
    seed: (snap) => {
      snap.projects[2].archived_at = '2026-10-10T08:00:00.000Z'
    },
    act: (P) => P.unarchiveProject('work2'),
  },
  {
    mutation: 'projects:deleteDeep',
    mutator: 'removeProject',
    what: 'a deleted sub-project',
    paintsOnAccept: true,
    pause: 'P',
    act: (P) => P.removeProject('work2'),
    truth: (snap) => {
      snap.projects = snap.projects.filter((p) => p.id !== 'work2')
    },
  },
  {
    mutation: 'projects:setAccess',
    mutator: 'setProjectAccess',
    what: "a person's access level",
    pause: 'P',
    act: (P) => P.setProjectAccess('plan', PAT, 'viewer'),
    truth: (snap) => {
      snap.access[0].level = 'viewer'
    },
  },
  {
    mutation: 'projects:setAccess',
    mutator: 'setProjectTeamAccess',
    what: "a team's access level",
    pause: 'P',
    act: (P) => P.setProjectTeamAccess('plan', 'team-b', 'user'),
    truth: (snap) => snap.teamAccess.push({ project_id: 'plan', team_id: 'team-b', level: 'user' }),
  },
  {
    mutation: 'projects:removeAccess',
    mutator: 'removeAtOnce',
    what: "a person's access removed",
    pause: 'P',
    act: (P) =>
      P.removeAccess({ kind: 'userGrant', projectId: 'plan', userId: PAT }, { keep: true }, []),
    truth: (snap) => {
      snap.access = []
    },
  },
  {
    mutation: 'teams:removeMember',
    mutator: 'removeAtOnce',
    what: 'a member leaving a team',
    pause: 'P',
    act: (P) =>
      P.removeAccess({ kind: 'teamMember', teamId: 'team-a', userId: PAT }, { keep: true }, []),
    truth: (snap) => {
      snap.teamMembers = snap.teamMembers.filter((m) => m.profile_id !== PAT)
    },
  },
  {
    mutation: 'projects:addMilestone',
    mutator: 'addMilestone',
    what: 'a new milestone',
    pause: 'P',
    act: (P) => P.addMilestone({ project: 'work', name: 'Beta', week: P.isoToWeek('2026-11-09') }),
    truth: (snap, args) =>
      snap.milestones.push({
        id: str(args.id),
        project_id: 'plan',
        name: 'Beta',
        week: '2026-11-09',
        created_at: SERVER,
      }),
  },
  {
    mutation: 'projects:updateMilestone',
    mutator: 'updateMilestone',
    what: 'a renamed milestone',
    pause: 'P',
    act: (P) => P.updateMilestone('ms-a', { name: 'Release' }),
    truth: (snap) => {
      snap.milestones[0].name = 'Release'
    },
  },
  {
    mutation: 'projects:removeMilestone',
    mutator: 'removeMilestone',
    what: 'a removed milestone',
    pause: 'P',
    act: (P) => P.removeMilestone('ms-a'),
    truth: (snap) => {
      snap.milestones = []
    },
  },
  {
    mutation: 'roadmap:change',
    mutator: 'submitRoadmapChanges',
    what: 'a planning change on Roadmap',
    pause: 'P',
    prepare: (P) => P.roadmapContext(true, false),
    act: (P) => P.updateIssue('QN-1', { remaining: 5 }),
    answers: { 'roadmap:change': () => ({ count: 1 }) },
    truth: (snap) =>
      Object.assign(issue(snap, 'task-a'), {
        remaining_hours: 5,
        remaining_set_at: SERVER,
        updated_at: SERVER,
      }),
  },
  {
    mutation: 'roadmap:undo',
    mutator: 'undoRoadmap',
    what: 'an undone Roadmap change',
    pause: 'P',
    // a saved Roadmap change to undo
    prepare: async (P, server) => {
      P.roadmapContext(true, false)
      P.updateIssue('QN-1', { remaining: 5 })
      await server.answer('roadmap:change', { count: 1 }, (snap) =>
        Object.assign(issue(snap, 'task-a'), {
          remaining_hours: 5,
          remaining_set_at: SERVER,
          updated_at: SERVER,
        }),
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
    act: (P) => P.updateTeam('team-a', { name: 'Field crew' }),
    truth: (snap) => {
      snap.teams[0].name = 'Field crew'
    },
  },
  {
    mutation: 'teams:addMember',
    mutator: 'addTeamMember',
    what: 'a new team member',
    pause: 'P',
    act: (P) => P.addTeamMember('team-b', PAT),
    truth: (snap) =>
      snap.teamMembers.push({ team_id: 'team-b', profile_id: PAT, is_leader: false }),
  },
  {
    mutation: 'teams:setLeader',
    mutator: 'setTeamLeader',
    what: 'a new team leader',
    pause: 'P',
    act: (P) => P.setTeamLeader('team-a', PAT, true),
    truth: (snap) => {
      snap.teamMembers[1].is_leader = true
    },
  },
  {
    mutation: 'teams:deleteDeep',
    mutator: 'removeAtOnce',
    what: 'a deleted team',
    pause: 'P',
    act: (P) => P.removeAccess({ kind: 'deleteTeam', teamId: 'team-b' }, { keep: true }, []),
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
    act: (P) => P.updateUser(PAT, { plannableHours: 30 }),
    truth: (snap) => {
      profile(snap, PAT).plannable_hours = 30
    },
  },
  {
    mutation: 'profiles:deactivate',
    mutator: 'updateUser',
    what: 'a person switched off',
    pause: 'U',
    act: (P) => P.updateUser(PAT, { active: false }),
    truth: (snap) => {
      profile(snap, PAT).active = false
    },
  },
  {
    mutation: 'profiles:update',
    mutator: 'updateUser',
    what: "a person's name and teams",
    pause: 'P',
    act: (P) => P.updateUser(PAT, { name: 'Pat Quinn', teams: ['team-b'] }),
    truth: (snap) => {
      Object.assign(profile(snap, PAT), { name: 'Pat Quinn', initials: 'PQ' })
      snap.teamMembers = [
        snap.teamMembers[0],
        { team_id: 'team-b', profile_id: PAT, is_leader: false },
      ]
    },
  },
  {
    mutation: 'profiles:remove',
    mutator: 'removeUser',
    what: 'a removed person',
    pause: 'U',
    act: (P) => P.removeUser(PAT),
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
    act: (P) => P.updateLabel('label-a', { name: 'Defect' }),
    truth: (snap) => Object.assign(snap.labels[0], { name: 'Defect', name_lower: 'defect' }),
  },
  {
    mutation: 'labels:remove',
    mutator: 'removeLabel',
    what: 'a removed label',
    pause: 'P',
    act: (P) => P.removeLabel('label-a'),
    truth: (snap) => {
      snap.labels = []
      snap.issueLabels = []
    },
  },
  {
    mutation: 'labels:toggle',
    mutator: 'toggleIssueLabel',
    what: 'a label put on a task',
    pause: 'P',
    act: (P) => P.toggleIssueLabel('QN-3', 'label-a'),
    truth: (snap) => snap.issueLabels.push({ issue_id: 'task-c', label_id: 'label-a' }),
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
