import { getFunctionName } from 'convex/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_PASSWORD_LOGIN } from '../../convex/lib/email'
import { LIMITS, TEXT_MAX } from '../../convex/lib/limits'
import { limitSentence, sentence } from '../lib/fieldLimits'
import { plannerFixture, type Snapshot } from './plannerFixture.setup'
import type { Row } from './rows'

const network = vi.hoisted(() => ({ mutation: vi.fn(), query: vi.fn(), onUpdate: vi.fn() }))
vi.mock('../lib/convex', async () => ({
  convex: network,
  live: (await import('./guard/liveDouble.setup')).liveOver(network),
}))
vi.mock('../lib/auth', () => ({
  armConvexAuth: async () => true,
  authClient: {
    getSession: async () => ({ data: { session: {}, user: { id: 'test-account' } } }),
  },
  signOut: vi.fn(),
}))

const NOW = '2026-09-14T08:00:00.000Z'
const AT_CAP = 'a'.repeat(TEXT_MAX)
const OVER = 'a'.repeat(TEXT_MAX + 1)
const NAME_AT_CAP = 'n'.repeat(LIMITS.projectName.max)
const NAME_OVER = 'n'.repeat(LIMITS.projectName.max + 1)
// a text that mentions `n` distinct people
const mentions = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `@[P${i}](user:00000000-0000-4000-8000-${String(i).padStart(12, '0')})`,
  ).join(' ')
const TOO_MANY = 'A text can mention at most 100 people. Remove some mentions and save again.'
const MENTION_MAX = LIMITS.mentions.max

/* The store refuses a value outside its registry limit before it paints or
 * sends, with the limit's sentence, so a refused draft is never replaced by
 * a rollback. Text counts UTF-16 code units after trimming, as the server
 * counts it. One task, its thread, a team, a milestone and a label. */
describe('the limits in the store', () => {
  let store: typeof import('./planner')
  let sent: string[]
  let args: Record<string, unknown>[]
  let toast: ReturnType<typeof vi.fn>
  let publishComments: (rows: Row<'comments'>[]) => void

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    toast = vi.fn()
    vi.stubGlobal('window', { showToast: toast })
    sent = []
    args = []
    const snap: Snapshot = plannerFixture()
    snap.issues.push({
      id: 'task-a',
      org_id: snap.orgs[0].id,
      project_id: snap.projects[0].id,
      num: 1,
      title: 'Long brief',
      description: 'The brief',
      status: 'todo',
      priority: 'low',
      paused: false,
      created_at: NOW,
      updated_at: NOW,
      has_hidden_subtasks: false,
      has_hidden_parent: false,
    })
    snap.teams.push({
      id: 'team-a',
      org_id: snap.orgs[0].id,
      name: 'Field crew',
      track_delay_default: false,
      created_at: NOW,
    })
    snap.milestones.push({
      id: 'milestone-a',
      project_id: snap.projects[0].id,
      name: 'Beta',
      week: '2026-09-14',
      created_at: NOW,
    })
    snap.labels.push({
      id: 'label-a',
      org_id: snap.orgs[0].id,
      name: 'n'.repeat(LIMITS.labelName.max),
      name_lower: 'n'.repeat(LIMITS.labelName.max),
      color: '#335577',
      created_at: NOW,
    })
    network.query.mockResolvedValue(null)
    network.mutation.mockImplementation((ref, sentArgs) => {
      const name = getFunctionName(ref)
      if (name === 'identity:claimMySeats') return Promise.resolve(null)
      sent.push(name)
      args.push(sentArgs)
      return new Promise(() => {})
    })
    network.onUpdate.mockImplementation((ref, _args, receive) => {
      if (getFunctionName(ref) === 'workspace:whole') receive(structuredClone(snap))
      else if (getFunctionName(ref) === 'snapshot:commentThread') {
        publishComments = (comments) => receive({ comments, earlier: false, events: [] })
      }
      return () => {}
    })
    store = await import('./planner')
    await store.initStore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  const task = () => store.P.issues.find((it) => it.uuid === 'task-a')

  it('refuses a description over the cap before painting or sending', async () => {
    const { P } = store
    const key = task()?.id ?? ''
    expect(await P.updateIssue(key, { description: OVER })).toBe(false)
    expect(toast).toHaveBeenCalledWith(limitSentence(LIMITS.description), 'error')
    expect(task()?.description).toBe('The brief')
    expect(sent).toEqual([])
  })

  it('counts a description after trimming, so blank lines and spaces around one at the cap pass', () => {
    const { P } = store
    void P.updateIssue(task()?.id ?? '', { description: `\n${AT_CAP}  ` })
    expect(sent).toEqual(['issues:update'])
    expect(toast).not.toHaveBeenCalled()
    // painted as the server stores it, so the editor stays within the parse cap
    expect(task()?.description).toBe(AT_CAP)
  })

  it('takes a title of 255 characters whole and refuses one more, never cutting it', async () => {
    const { P } = store
    const key = task()?.id ?? ''
    const long = 't'.repeat(LIMITS.title.max)
    expect(await P.updateIssue(key, { title: `${long}t` })).toBe(false)
    expect(toast).toHaveBeenCalledWith(
      'A task title must be at most 255 characters. Shorten it.',
      'error',
    )
    expect(task()?.title).toBe('Long brief')
    expect(sent).toEqual([])
    void P.updateIssue(key, { title: ` ${long} ` })
    expect(task()?.title).toBe(long)
    expect(sent).toEqual(['issues:update'])
  })

  it('posts a comment of 20,000 characters after trimming and refuses one more', async () => {
    const { P } = store
    P.watchComments('task-a')
    publishComments([])
    expect(await P.addComment('task-a', ` ${OVER} `)).toBe(false)
    expect(toast).toHaveBeenCalledWith(limitSentence(LIMITS.comment), 'error')
    expect(P.comments).toEqual([])
    expect(sent).toEqual([])
    void P.addComment('task-a', `  ${AT_CAP}  `)
    expect(P.comments.map((c) => c.body)).toEqual([AT_CAP])
    expect(sent).toEqual(['comments:create'])
  })

  it('refuses a name over its cap before painting or sending, and sends one at it', async () => {
    const { P } = store
    const project = P.projects[0].id
    expect(await P.updateProject(project, { name: NAME_OVER })).toBe(false)
    expect(await P.updateTeam('team-a', { name: NAME_OVER })).toBe(false)
    expect(await P.setOrg({ name: NAME_OVER })).toBe(false)
    expect(await P.updateMilestone('milestone-a', { name: NAME_OVER })).toBe(false)
    expect(toast.mock.calls.map(([message]) => message)).toEqual([
      'A project name must be at most 80 characters. Shorten it.',
      'A team name must be at most 80 characters. Shorten it.',
      'An organization name must be at most 80 characters. Shorten it.',
      'A milestone name must be at most 80 characters. Shorten it.',
    ])
    expect(P.teamById('team-a')?.name).toBe('Field crew')
    expect(sent).toEqual([])
    void P.updateProject(project, { name: NAME_AT_CAP })
    void P.updateTeam('team-a', { name: ` ${NAME_AT_CAP} ` })
    expect(sent).toEqual(['projects:update', 'teams:update'])
  })

  it('refuses a label name over its cap without creating or matching a label', () => {
    const { P } = store
    // the first 40 characters are an existing label's name
    const over = 'n'.repeat(LIMITS.labelName.max + 1)
    expect(P.addLabel({ name: over })).toBeNull()
    expect(P.updateLabel('label-a', { name: over })).toBe(false)
    expect(toast.mock.calls.map(([message]) => message)).toEqual([
      'A label name must be at most 40 characters. Shorten it.',
      'A label name must be at most 40 characters. Shorten it.',
    ])
    expect(P.orgLabels().map((l) => l.id)).toEqual(['label-a'])
    expect(sent).toEqual([])
  })

  it('refuses plannable hours of 0 and 169 instead of clamping them', async () => {
    const { P } = store
    const sentence = 'Plannable hours per week must be a whole number of hours from 1 to 168.'
    expect(await P.setOrg({ defaultPlannableHours: 0 })).toBe(false)
    expect(await P.setOrg({ defaultPlannableHours: 169 })).toBe(false)
    expect(P.updateUser(P.CURRENT_USER, { plannableHours: 169 })).toBe(false)
    expect(toast.mock.calls.map(([message]) => message)).toEqual([sentence, sentence, sentence])
    expect(sent).toEqual([])
    void P.setOrg({ defaultPlannableHours: 168 })
    expect(sent).toEqual(['orgs:update'])
  })

  it("stores a new person's address as the server does: lowercased, its domain punycode", () => {
    const { P } = store
    P.addUser({ name: 'Anna Berg', email: ' Anna@Bücher.DE ', orgRole: 'user' })
    expect(sent).toEqual(['profiles:create'])
    expect(args[0]).toMatchObject({ email: 'anna@xn--bcher-kva.de' })
    expect(P.emailLooksValid('a@b.c, d@e.f')).toBe(false)
    expect(P.emailLooksValid(`${'a'.repeat(250)}@b.io`)).toBe(false)
  })

  it('counts a person name as the server stores it, with whitespace runs collapsed', () => {
    const { P } = store
    // 81 characters typed, 80 once the double space is one
    const typed = `${'a'.repeat(40)}  ${'b'.repeat(39)}`
    P.addUser({ name: typed, email: 'anna@example.com', orgRole: 'user' })
    expect(sent).toEqual(['profiles:create'])
    expect(args[0]).toMatchObject({ name: `${'a'.repeat(40)} ${'b'.repeat(39)}` })
    P.addUser({ name: `${typed}b`, email: 'bo@example.com', orgRole: 'user' })
    expect(toast).toHaveBeenCalledWith(limitSentence(LIMITS.personName), 'error')
    expect(sent).toEqual(['profiles:create'])
  })

  it('says an address is too long when its stored form is over the email cap', () => {
    const { P } = store
    const long = `${'a'.repeat(LIMITS.email.max - 'b.io'.length)}@b.io`
    P.addUser({ name: 'Anna Berg', email: long, orgRole: 'user' })
    expect(toast).toHaveBeenCalledWith(limitSentence(LIMITS.email), 'error')
    P.addUser({ name: 'Anna Berg', email: 'anna@', orgRole: 'user' })
    expect(toast).toHaveBeenLastCalledWith('Enter an email address for sign-in.', 'error')
    // the mail sender takes it, but a password login cannot use it
    P.addUser({ name: 'Ivan Petrov', email: 'ivan@правительство.рф', orgRole: 'user' })
    expect(toast).toHaveBeenLastCalledWith(sentence(NO_PASSWORD_LOGIN), 'error')
    expect(sent).toEqual([])
  })

  it('leaves a comment unchanged when the edit is over the cap', () => {
    const { P } = store
    P.watchComments('task-a')
    publishComments([
      {
        id: 'comment-a',
        issue_id: 'task-a',
        author: P.CURRENT_USER,
        body: 'Original',
        created_at: NOW,
      },
    ])
    P.updateComment('comment-a', OVER)
    expect(toast).toHaveBeenCalledWith(limitSentence(LIMITS.comment), 'error')
    expect(P.comments.map((c) => c.body)).toEqual(['Original'])
    expect(sent).toEqual([])
    P.updateComment('comment-a', AT_CAP)
    expect(P.comments.map((c) => c.body)).toEqual([AT_CAP])
    expect(sent).toEqual(['comments:update'])
  })

  it(`refuses a text that mentions more than ${MENTION_MAX} people before painting or sending`, async () => {
    const { P } = store
    const key = task()?.id ?? ''
    expect(await P.updateIssue(key, { description: mentions(MENTION_MAX + 1) })).toBe(false)
    P.watchComments('task-a')
    publishComments([])
    expect(await P.addComment('task-a', mentions(MENTION_MAX + 1))).toBe(false)
    expect(toast.mock.calls).toEqual([
      [TOO_MANY, 'error'],
      [TOO_MANY, 'error'],
    ])
    expect(task()?.description).toBe('The brief')
    expect(sent).toEqual([])
    void P.updateIssue(key, { description: mentions(MENTION_MAX) })
    void P.addComment('task-a', mentions(MENTION_MAX))
    expect(sent).toEqual(['issues:update', 'comments:create'])
  })
})
