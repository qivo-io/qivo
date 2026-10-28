/* Every limit people and agents can meet in Qivo, defined once. The server's
 * checks (lib/limitRules.ts), the app's fields, the REST and MCP surfaces
 * and the public docs (scripts/limits-docs.mjs writes the tables) all read
 * their numbers and sentences from here.
 *
 * One rule for every text cap: a text counts UTF-16 code units
 * (String.prototype.length, the count a browser's text field uses) after
 * trimming, and the trimmed text is what is stored. Most emoji count as two.
 *
 * No imports, so the app, the Convex runtime and Node scripts can all load
 * this file. Node scripts load it through scripts/limits.mjs, which first
 * checks that the Node can. Internal transaction budgets stay out of it. */

/** `n` with a comma between groups of three digits, as people read numbers
 * (20,000 and 99,999.9). Written out because the Convex runtime has no Intl. */
export function grouped(n: number): string {
  const [whole, fraction] = String(n).split('.')
  const digits = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction === undefined ? digits : `${digits}.${fraction}`
}

/** Where a limit is met. The REST and MCP docs list the entries marked for
 * them; the guide's Limits page lists every entry marked for any of the
 * three. 'operator' is the operator console, documented nowhere public, and
 * an entry met on no surface (the app splits its own calls by it, or no
 * console field meets it, such as the background curation API's, which
 * docs/rest-api.md describes in its own section) is listed nowhere. */
export type Surface = 'app' | 'rest' | 'mcp' | 'operator'

/** The sections of the Limits page, in order. */
export const LIMIT_GROUPS = {
  text: 'Text',
  files: 'Files and images',
  tasks: 'Tasks and organizations',
  numbers: 'Numbers and settings',
  machine: 'REST and MCP requests',
} as const

/** One limit. A text limit has unit 'characters' and counts trimmed UTF-16
 * code units. A range has a `min`. */
export type Limit = {
  /** The row name in the docs tables, such as "Task title". */
  readonly label: string
  readonly group: keyof typeof LIMIT_GROUPS
  /** The smallest accepted value of a range. */
  readonly min?: number
  readonly max: number
  /** What `max` counts, as the docs print it. */
  readonly unit: string
  /** The refusal past the limit. It names the limit, its number and unit, and
   * what to do. It starts lowercase, as every server refusal does, so the
   * app capitalizes it (src/store/planner.ts asSentence) and REST and MCP
   * answer it as written. */
  readonly refusal: string
  readonly on: readonly Surface[]
}

const ALL: readonly Surface[] = ['app', 'rest', 'mcp']
const MACHINE: readonly Surface[] = ['rest', 'mcp']
const OPERATOR: readonly Surface[] = ['operator']

/** A text limit whose refusal says `subject` must be at most `max`
 * characters, followed by `next`, the step that gets past it. */
const text = (
  label: string,
  max: number,
  subject: string,
  on: readonly Surface[] = ALL,
  next = 'Shorten it.',
  group: Limit['group'] = 'text',
): Limit => ({
  label,
  group,
  max,
  unit: 'characters',
  refusal: `${subject} must be at most ${grouped(max)} characters. ${next}`,
  on,
})

/** A whole-number range whose refusal names `subject`, the range and `unit`. */
const whole = (
  label: string,
  min: number,
  max: number,
  unit: string,
  subject: string,
  on: readonly Surface[],
  group: Limit['group'] = 'numbers',
): Limit & { readonly min: number } => ({
  label,
  group,
  min,
  max,
  unit,
  refusal: `${subject} must be a whole number of ${unit} from ${grouped(min)} to ${grouped(max)}.`,
  on,
})

/** The longest task description, comment or archive reason, formatting
 * included. src/lib/md.ts parses texts up to this length, so the app can edit
 * every text the server accepts. */
export const TEXT_MAX = 20_000

/** The longest name of a project, sub-project, team, milestone,
 * organization, agent key, personal token, person, background curation key
 * or billing plan. */
export const NAME_MAX = 80

/** The rows of a list page REST and MCP answer when the call names no limit. */
export const DEFAULT_PAGE_SIZE = 50

/** The most projects one of the app's milestone reads names (milestones.ts
 * section and between). The app cuts the projects of a view to this many
 * and says when it holds more. */
export const MILESTONE_READ_PROJECTS = 200

/** The most messages one seat's bounded inbox walk examines in each of its
 * unread and read halves (lib/inbox.ts). */
export const INBOX_LIMIT = 500

/** Days a read inbox message is kept when the person has not chosen. */
export const DEFAULT_MESSAGE_RETENTION_DAYS = 7

/** The shape of an organization address (LIMITS.slug): groups of lowercase
 * letters and digits joined by single hyphens, none leading or trailing. '~'
 * cannot be spelled, which /app/~/ routing depends on. */
export const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** The refusal of a send again while the seat's newest invitation email is
 * still being sent. */
export const INVITE_SENDING = 'this invitation email is being sent; wait for it to finish'

/** The refusal of a send again for an invitation whose newest email went
 * out, or may have. */
export const INVITE_NOT_HELD =
  'only an invitation email that was held back or could not be sent can be sent again'

/** The refusal of a parent that is itself a subtask. A task has one level of
 * subtasks: a subtask has no subtasks of its own. */
export const PARENT_IS_SUBTASK =
  'the parent task is a subtask, and a subtask cannot have subtasks of its own'

/** The refusal of a parent for a task that has subtasks, which would make it
 * a subtask with subtasks. */
export const SUBTASK_WITH_SUBTASKS =
  'this task has subtasks, so it cannot become a subtask; a subtask cannot have subtasks of its own'

/** The currencies a billing plan can be priced in, in Polar's lowercase
 * ISO 4217 codes. The operator console offers exactly these. */
export const PLAN_CURRENCIES = [
  'usd',
  'eur',
  'gbp',
  'nok',
  'sek',
  'dkk',
  'cad',
  'aud',
  'chf',
  'nzd',
] as const

/** The refusal of a billing plan currency outside PLAN_CURRENCIES. */
export const PLAN_CURRENCY = `a billing plan must be priced in ${PLAN_CURRENCIES.slice(0, -1)
  .map((c) => c.toUpperCase())
  .join(', ')} or ${PLAN_CURRENCIES[PLAN_CURRENCIES.length - 1].toUpperCase()}. Choose one of them.`

/** Bytes in one MiB, for size checks written in MiB. */
export const MIB = 1024 * 1024

/** The largest file a public demo stores, a background image included
 * (model/demoUploads.ts). The demo app checks it before it uploads a
 * background image or an attachment. */
export const DEMO_FILE_BYTES = 5 * MIB

/** The largest request body the sign-in endpoints under /api/auth take
 * (http.ts readAuthBody), 64 KiB. The largest any of them needs is an OAuth
 * client registration, whose metadata may hold 8 KiB
 * (lib/oauthRegistration.ts); a sign-up or sign-in takes under 1 KiB. */
export const AUTH_BODY_MAX_BYTES = 64 * 1024

/** The most values (every object, array and scalar, at any depth) a sign-in
 * request's body or query may hold for Better Auth to check every one and
 * list every problem (lib/authValidation.ts). A sign-in, sign-up or OAuth
 * client registration holds under 100. Over this, the check stops at the
 * first problems. */
export const AUTH_FULL_CHECK_VALUES = 1_000

/** The longest message, in characters, a sign-in request's validation error
 * answers with (lib/authValidation.ts). */
export const AUTH_VALIDATION_MESSAGE_MAX = 2_048

export const LIMITS = {
  title: text('Task title', 255, 'a task title'),
  description: text(
    'Task description',
    TEXT_MAX,
    'a task description',
    ALL,
    'Formatting counts too. Shorten it.',
  ),
  comment: text('Comment', TEXT_MAX, 'a comment', ALL, 'Formatting counts too. Shorten it.'),
  projectName: text('Project or sub-project name', NAME_MAX, 'a project name'),
  projectDescription: text('Project description', 500, 'a project description'),
  teamName: text('Team name', NAME_MAX, 'a team name'),
  milestoneName: text('Milestone name', NAME_MAX, 'a milestone name'),
  orgName: text('Organization name', NAME_MAX, 'an organization name', ['app', 'operator']),
  personName: text('Person name', NAME_MAX, 'a name', ['app', 'operator']),
  keyName: text('Agent key name', NAME_MAX, 'an agent key name', ['app']),
  tokenName: text('Personal token name', NAME_MAX, 'a personal token name', ['app']),
  labelName: text('Label name', 40, 'a label name'),
  deleteReason: text('Delete reason', 500, 'a delete reason', ['app']),
  archiveReason: text('Archive reason', 500, 'an archive reason'),
  search: text('Search text', 200, 'a search', ALL, 'Search for fewer words.'),
  email: text(
    'Email address',
    254,
    'an email address',
    ['app', 'operator'],
    'Use a shorter address.',
  ),
  slug: {
    label: 'Organization address',
    group: 'text',
    max: 40,
    unit: 'characters',
    refusal:
      'an organization address must be at most 40 characters of lowercase letters, digits and single hyphens between them. Choose another address.',
    on: ['app', 'operator'],
  },
  attachmentName: text(
    'Attachment file name',
    255,
    'a file name',
    ALL,
    'Rename the file and attach it again.',
    'files',
  ),
  mediaType: text(
    'Attachment media type',
    255,
    "a file's media type",
    MACHINE,
    'Send a media type such as application/pdf.',
    'files',
  ),
  // The background image library in the operator console. The background
  // curation API (lib/panoramaCuration.ts) takes the same credits.
  imageTitle: text('Background image title', 300, 'an image title', OPERATOR),
  imageCreator: text('Background image creator', 300, 'a creator name', OPERATOR),
  imageLocation: text('Background image location', 300, 'an image location', OPERATOR),
  imageRemoveNote: text('Background image removal reason', 500, 'a removal reason', OPERATOR),
  proposalDeclineNote: text(
    'Background proposal decline reason',
    2_000,
    'a decline reason',
    OPERATOR,
  ),
  curationKeyName: text('Background curation key name', NAME_MAX, 'an agent name', OPERATOR),
  // No console field meets these two. The background curation API checks
  // both, and an operator upload through panoramaUploads.addFile checks the
  // source URL, which the console does not send.
  curationReason: text('Background curation reason', 2_000, 'a reason', []),
  curationUrl: text('Background image source URL', 2_048, 'a source URL', [], 'Use a shorter URL.'),
  planName: text('Billing plan name', NAME_MAX, 'a plan name', OPERATOR),
  backgroundName: text(
    'Background image file name',
    255,
    'an image file name',
    ['app'],
    'Rename the file and upload it again.',
    'files',
  ),
  attachmentSize: {
    label: 'Attachment size',
    group: 'files',
    max: 20,
    unit: 'MiB per file',
    refusal: attachmentTooLarge(20),
    on: ALL,
  },
  avatarSize: {
    label: 'Profile picture size',
    group: 'files',
    max: 2,
    unit: 'MiB',
    refusal: 'a profile picture must be at most 2 MiB. Choose a smaller image.',
    on: ['app'],
  },
  backgroundSize: {
    label: 'Background image size',
    group: 'files',
    max: 8,
    unit: 'MiB',
    refusal: 'a background image must be at most 8 MiB. Choose a smaller image.',
    on: ['app', 'operator'],
  },
  textFile: {
    label: 'Text file from attach_text_file',
    group: 'files',
    max: 256,
    unit: 'KiB as UTF-8',
    refusal: `text must be at most 256 KiB (${grouped(256 * 1024)} bytes) as UTF-8. Split it into several files.`,
    on: ['mcp'],
  },
  subtasks: {
    label: 'Active subtasks per task',
    group: 'tasks',
    max: 100,
    unit: 'active subtasks',
    refusal:
      'the parent task already has 100 active subtasks, the most a task can have. Archive or remove one of them first.',
    on: ALL,
  },
  moveSubtree: {
    label: 'Subtasks a move to another project carries',
    group: 'tasks',
    max: 200,
    unit: 'subtasks, archived ones included',
    refusal:
      'this task has more than 200 subtasks, archived ones included, and a move to another project carries them all. Restore some archived subtasks and remove them from this task first, or move it within its project.',
    on: ALL,
  },
  attachments: {
    label: 'Attachments per task',
    group: 'tasks',
    max: 100,
    unit: 'attachments, description images included',
    refusal:
      'this task already has 100 attachments, images in its description included, the most a task can have. Remove one first.',
    on: ALL,
  },
  links: {
    label: 'Links per task',
    group: 'tasks',
    max: 100,
    unit: 'links',
    refusal: linksFull('this task'),
    on: ALL,
  },
  labels: {
    label: 'Labels per task',
    group: 'tasks',
    max: 20,
    unit: 'labels',
    refusal: 'this task already has 20 labels, the most a task can have. Remove one first.',
    on: ALL,
  },
  // Every comment counts, archive reasons and comments posted before the cap
  // included, so a task that held more then keeps them but takes no new one
  // until it has fewer (model/commentLimits.ts).
  comments: {
    label: 'Comments per task',
    group: 'tasks',
    max: 1_000,
    unit: 'comments',
    refusal:
      'this task has reached 1,000 comments, the most a task can have. Ask a project lead to delete comments until it has fewer than 1,000, then post again.',
    on: ALL,
  },
  // Successful posts by one person or agent on one task, in any 60 seconds
  // of server time, archive reasons included. Deleting a comment gives no
  // post back (model/commentLimits.ts).
  commentRate: {
    label: 'Comments one person or agent posts on one task',
    group: 'tasks',
    max: 10,
    unit: 'comments in any 60 seconds',
    refusal: tooManyComments(60),
    on: ALL,
  },
  followers: {
    label: 'Followers per task',
    group: 'tasks',
    max: 100,
    unit: 'followers',
    refusal:
      'this task already has 100 followers, the most a task can have. Someone must unfollow it first.',
    on: ALL,
  },
  mentions: {
    label: 'People mentioned in one text',
    group: 'tasks',
    max: 100,
    unit: 'people',
    refusal: 'a text can mention at most 100 people. Remove some mentions and save again.',
    on: ALL,
  },
  invitesPerHour: {
    label: 'Invitation emails per organization',
    group: 'tasks',
    max: 50,
    unit: 'emails per hour',
    refusal:
      'this organization sent 50 invitation emails in the last hour, the most it can send. Send this one again once the hour has passed.',
    on: ['app', 'operator'],
  },
  // One milestone a calendar week of the organization for each top-level
  // project, a milestone named on a sub-project included
  // (model/milestones.ts assertWeekFree). The check allows exactly one, as
  // it refuses when any other milestone holds the week, so `max` documents
  // the rule and a change of it needs a change of weekHolder.
  milestonesPerWeek: {
    label: 'Milestones per project week',
    group: 'tasks',
    max: 1,
    unit: 'milestone in each calendar week, for a project and its sub-projects together',
    refusal: milestoneWeekTaken(),
    on: ALL,
  },
  roadmapWeeks: {
    label: 'Weeks the Roadmap shows',
    group: 'numbers',
    max: 260,
    unit: 'weeks (5 years)',
    refusal: 'the Roadmap shows at most 260 weeks (5 years). Move the start or the end closer.',
    on: ['app'],
  },
  reassign: {
    label: 'Tasks one access removal reassigns',
    group: 'tasks',
    max: 120,
    unit: 'tasks',
    refusal:
      'a removal can reassign at most 120 tasks at once, fewer when the change is too large for one request. Keep the people as Viewers or reassign some of the tasks first.',
    on: ALL,
  },
  removalHolders: {
    label: 'People with open tasks one access removal settles',
    group: 'tasks',
    max: 700,
    unit: 'people',
    refusal:
      "a removal that keeps people as Viewers or reassigns their tasks can take access from at most 700 people with open tasks at once. Leave the tasks with them, or remove some of the team's members first.",
    on: ALL,
  },
  teamDeleteRows: {
    label: 'Memberships and project shares one team deletion removes',
    group: 'tasks',
    max: 3_000,
    unit: 'memberships and project shares',
    refusal:
      'deleting a team can remove at most 3,000 of its memberships and project shares at once. Remove some of its members or project shares first.',
    on: ['app'],
  },
  // The delete hides the project and every sub-project in one transaction,
  // and its restore brings them back in one (model/deletedItems.ts).
  projectDeleteSubProjects: {
    label: 'Sub-projects one project deletion takes',
    group: 'tasks',
    max: 200,
    unit: 'sub-projects, archived ones included',
    refusal:
      'a project with more than 200 sub-projects, archived ones included, cannot be deleted at once. Delete some of its sub-projects first, then delete the project.',
    on: ['app'],
  },
  // A removal clears the person as the lead of each project in the
  // transaction that ends their access (model/cascade.ts removeProfile).
  removalLeads: {
    label: 'Projects a removed person may lead',
    group: 'tasks',
    max: 1_000,
    unit: 'projects',
    refusal:
      'this person leads more than 1,000 projects and cannot be removed at once. Give some of those projects another lead first, or make the person Inactive to end their access now.',
    on: ['app', 'operator'],
  },
  inboxShown: {
    label: 'Inbox messages the app shows',
    group: 'tasks',
    max: INBOX_LIMIT,
    unit: 'messages',
    refusal: `the app shows your newest ${grouped(INBOX_LIMIT)} inbox messages. Mark older ones read or remove them to see the rest.`,
    on: ['app'],
  },
  restoreBatch: {
    label: 'Deleted items restored per call',
    group: 'tasks',
    max: 25,
    unit: 'items',
    refusal: 'at most 25 items can be restored at a time. Restore the rest in another call.',
    on: [],
  },
  purgeBatch: {
    label: 'Deleted items deleted for good per call',
    group: 'tasks',
    max: 25,
    unit: 'items',
    refusal: 'at most 25 items can be deleted for good at a time. Delete the rest in another call.',
    on: [],
  },
  billingSeats: {
    label: 'Active billable users with online billing',
    group: 'tasks',
    max: 1_000,
    unit: 'users',
    refusal: `online billing supports up to ${grouped(1_000)} active billable users. Email support@qivo.io to arrange billing for a larger organization.`,
    on: ['app', 'operator'],
  },
  invitePeople: {
    label: 'People per operator invitation',
    group: 'tasks',
    max: 50,
    unit: 'people',
    refusal: 'invite at most 50 people at a time. Send the rest in another invitation.',
    on: ['operator'],
  },
  plannableHours: whole(
    'Plannable hours per week',
    1,
    168,
    'hours',
    'plannable hours per week',
    ALL,
  ),
  remainingHours: {
    label: 'Remaining hours of a task',
    group: 'numbers',
    min: 0,
    max: 99_999.9,
    unit: 'hours',
    refusal: `remaining hours must be a number from 0 to ${grouped(99_999.9)}. Enter a number in that range.`,
    on: ALL,
  },
  reviewHours: {
    label: 'Review hours of a project',
    group: 'numbers',
    min: 0,
    max: 999,
    unit: 'hours',
    refusal: 'review hours must be a number from 0 to 999. Enter a number in that range.',
    on: ALL,
  },
  attachmentLimit: whole(
    'Organization attachment size setting',
    1,
    20,
    'MiB',
    'the attachment size limit',
    ['app'],
  ),
  messageRetention: whole('Read message retention', 1, 3_650, 'days', 'message retention', ['app']),
  snooze: {
    label: 'Snooze',
    group: 'numbers',
    max: 366,
    unit: 'days ahead',
    refusal: 'a snooze can be at most 366 days ahead. Pick an earlier time.',
    on: ALL,
  },
  listTasks: whole('Tasks per list page', 1, 200, 'tasks', 'limit', MACHINE, 'machine'),
  listInbox: whole('Inbox items per list page', 1, 200, 'items', 'limit', MACHINE, 'machine'),
  listComments: whole('Comments per list page', 1, 50, 'comments', 'limit', MACHINE, 'machine'),
  workloadWeeks: {
    label: 'Workload weeks',
    group: 'machine',
    min: 1,
    max: 52,
    unit: 'weeks',
    refusal: 'weeks must be a whole number from 1 to 52.',
    on: MACHINE,
  },
  inboxTasks: {
    label: 'Tasks per inbox change',
    group: 'machine',
    max: 100,
    unit: 'tasks',
    refusal: 'tasks must name at most 100 tasks per call. Send the rest in another call.',
    on: MACHINE,
  },
  webhookTtl: {
    label: 'Webhook subscription lifetime',
    group: 'machine',
    min: 60_000,
    max: 7 * 24 * 60 * 60_000,
    unit: 'milliseconds',
    refusal: `ttlMs must be a whole number of milliseconds from ${grouped(60_000)} (1 minute) to ${grouped(7 * 24 * 60 * 60_000)} (7 days), or null for no expiry.`,
    on: MACHINE,
  },
  webhooksPerOrg: {
    label: 'Webhook subscriptions per organization',
    group: 'machine',
    max: 100,
    unit: 'subscriptions',
    refusal: webhookQuota(),
    on: MACHINE,
  },
  webhooksPerKey: {
    label: 'Webhook subscriptions per agent key, token or OAuth connection',
    group: 'machine',
    max: 20,
    unit: 'subscriptions',
    refusal: webhookQuota(),
    on: MACHINE,
  },
  webhookUrl: text(
    'Webhook callback URL',
    2_048,
    'a callback URL',
    MACHINE,
    'Use a shorter URL.',
    'machine',
  ),
  eventParams: text(
    'Event subscription request',
    16_384,
    'an event subscription request',
    MACHINE,
    'Send fewer or shorter parameters.',
    'machine',
  ),
  requestBody: {
    label: 'Request body',
    group: 'machine',
    max: 1,
    unit: 'MiB',
    refusal: 'a request body must be at most 1 MiB. Send less in one request.',
    on: MACHINE,
  },
  requestRate: {
    label: 'Requests per person or agent',
    group: 'machine',
    max: 300,
    unit: 'requests per minute',
    refusal: tooManyRequests(60),
    on: MACHINE,
  },
} as const satisfies Record<string, Limit>

export type LimitName = keyof typeof LIMITS

/** The refusal of a file over the organization's per-file limit of `capMb`
 * MiB, which an admin chooses from 1 to 20. */
export function attachmentTooLarge(capMb: number): string {
  return `a file must be at most ${capMb} MiB, this organization's attachment limit. Attach a smaller file.`
}

/** The refusal of a milestone in a week its top-level project already holds
 * another milestone in (LIMITS.milestonesPerWeek): `week` names that week
 * and `name` the milestone there, and `next` is the step that gets past it. */
export function milestoneWeekTaken(
  week = 'that week',
  name?: string,
  next = 'Pick another week, or move that milestone first.',
): string {
  const held = name === undefined ? 'a milestone' : `the milestone “${name}”`
  return `this project already has ${held} in ${week}, and a project can have at most 1 milestone a week. ${next}`
}

/** The reasons of the two refusals of a change of an organization's first
 * day of the week (model/milestones.ts assertWeekStartFits): the change
 * would put two milestones of one project in one week, or Qivo could not
 * check every milestone in one transaction. Both are `rule` refusals, and
 * the app shows them beside the setting. */
export const WEEK_START_REFUSALS = {
  conflicts: 'week_start_conflicts',
  unchecked: 'week_start_unchecked',
} as const

/** The refusal of a link to task `key`, either end of the link, once it has
 * LIMITS.links.max links. */
export function linksFull(key: string): string {
  return `${key} already has 100 links, the most a task can have. Remove one of its links first.`
}

/** The refusal of a webhook subscription past either quota. Unexpired
 * subscriptions count, disabled ones included. */
function webhookQuota(): string {
  return 'an organization can have at most 100 unexpired webhook subscriptions, and one agent key, token or OAuth connection at most 20. Delete an unused subscription first.'
}

/** The refusal of a request past the per-minute rate, `seconds` before the
 * minute's window ends (model/billingUsage.ts machineRetryAfter). */
export function tooManyRequests(seconds: number): string {
  const wait = seconds === 1 ? '1 second' : `${seconds} seconds`
  return `too many requests, at most 300 a minute for one person or agent. Try again in ${wait}.`
}

/** The refusal reason of a comment past LIMITS.commentRate
 * (convex/model/commentLimits.ts). Its `retry_after` is the wait in
 * seconds; REST answers it 429 with Retry-After. */
export const COMMENT_RATE = 'comment_rate'

/** The refusal reason of a comment, or an archive with a reason, on a task
 * whose comments are still being counted (convex/model/commentLimits.ts).
 * Its `task_id` names the task, whose count the caller then asks to start:
 * REST and MCP through machine/registry.ts, the app through
 * comments.countThread. REST answers it 503 with Retry-After. */
export const COMMENTS_COUNTING = 'comments_counting'

/** The refusal of a comment past LIMITS.commentRate, `seconds` before the
 * oldest of the author's last 10 posts on the task stops counting. */
export function tooManyComments(seconds: number): string {
  const wait = seconds === 1 ? '1 second' : `${seconds} seconds`
  return `too many comments on this task, at most 10 in any 60 seconds from one person or agent. Try again in ${wait}.`
}

/** The refusal of a request when every person and agent together pass
 * Qivo's request rate for the whole deployment, `seconds` before the
 * minute's window ends. Unlike tooManyRequests, it does not blame the
 * caller's own rate. */
export function serviceBusy(seconds: number): string {
  const wait = seconds === 1 ? '1 second' : `${seconds} seconds`
  return `Qivo is receiving too many requests right now. Try again in ${wait}.`
}

/** A person name as Qivo stores and counts it against LIMITS.personName:
 * each run of whitespace one space, then trimmed. The server and the app's
 * name fields both use it, so they accept the same names. */
export const cleanName = (raw: string): string => raw.replace(/\s+/g, ' ').trim()

/** Markdown text, a task description or a comment, as Qivo stores and
 * counts it: blank lines at the start and every space and line break at the
 * end removed. Spaces that start the first line stay, because they are part
 * of it: " # Heading" is a paragraph that reads "# Heading", and trimming
 * them would make it a heading. */
export const trimMarkdown = (text: string): string =>
  text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()

/** Whether `value`, already trimmed, is over a text limit. */
export const overText = (limit: Limit, value: string): boolean => value.length > limit.max

/** The first `max` UTF-16 code units of `text`, one fewer when the last of
 * them would split a surrogate pair, so an emoji is kept whole or left out.
 * For display text and names Qivo writes itself and for input a refusal
 * shows, never to shorten a person's input, which is refused instead. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text
  const last = text.charCodeAt(max - 1)
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

/** Whether `n` is outside a whole-number range. */
export const outsideWhole = (limit: Limit, n: number): boolean =>
  !Number.isInteger(n) || n < (limit.min ?? 0) || n > limit.max
