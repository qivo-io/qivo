/* The Inbox's pages (model/inboxPage.ts, inbox.page): one page of task
 * groups across the caller's seats, ordered, filtered and searched before
 * the page is cut, with honest stops and a sealed cursor. A page answers
 * only the caller's own items about tasks they are shown, the groups the
 * workspace inbox part shows, says when a seat is not ready or a check a
 * bound stopped left a group out, and never answers an unfinished read as
 * an empty Inbox. The reads at the design size are logged as
 * inboxReads.test.ts logs the summary's. Every case that writes ends with
 * drift() empty, except the seats case, which unbuilds a seat's state on
 * purpose, and the design-size cases, which plant their groups through the
 * item writer or as itemOf makes them and only measure reads. */

import { afterEach, describe, expect, it } from 'vitest'
import { api, internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import { accessOf, OWN_READS } from '../lib/access'
import { newWindowKey } from '../lib/db'
import type { MessageKind } from '../lib/enums'
import { inboxSearchText, itemKinds, kindsMatch, messageDetail, messageLine } from '../lib/inbox'
import { LIMITS } from '../lib/limits'
import { filtersKey } from '../lib/listCursor'
import { MENTION_DETAILS } from '../lib/messageDetails'
import { namedCursor } from '../lib/namedPages'
import { issueKey } from '../lib/taskRefs'
import { TRASH_BUDGET } from '../model/deletedItems'
import { insertTask } from '../model/descriptions'
import { ensureInboxState, itemEdits, itemOf, REKEY } from '../model/inboxItems'
import {
  INBOX_LIST,
  INBOX_PAGE,
  type InboxPage,
  type InboxPageArgs,
  type InboxRow,
  NOT_INBOX_CURSOR,
  readInboxPage,
} from '../model/inboxPage'
import { ITEM_UNREAD_CAP, postMessage } from '../model/messages'
import { SHAPES } from './accessShapes.setup'
import {
  as,
  expectRefusal,
  NOW,
  newT,
  type OrgFixture,
  plantHiddenSibling,
  plantIssue,
  plantLogin,
  plantProject,
  plantSeat,
  type T,
  uuid,
  withOrg,
} from './helpers.setup'
import { archiveRaw, at, drift, grant, measure } from './inboxItems.setup'
import { plantNorthstar } from './northstar.setup'
import { DAY, deleteTask, installTrashTimers, runSteps, START } from './trash.setup'

installTrashTimers()
const DEFAULT_PAGE = structuredClone(INBOX_PAGE)
const DEFAULT_REKEY = { ...REKEY }
const DEFAULT_OWN_READS = structuredClone(OWN_READS)
afterEach(() => {
  Object.assign(INBOX_PAGE, structuredClone(DEFAULT_PAGE))
  Object.assign(REKEY, DEFAULT_REKEY)
  Object.assign(OWN_READS, structuredClone(DEFAULT_OWN_READS))
})

/* ------------------------------------------------------------- planting */

/** One message an item gets, at minute `minute` after NOW. */
type Sent = {
  minute: number
  kind?: MessageKind
  body?: string
  /** the actor's profile id; absent for a machine caller */
  actor?: string
  read?: boolean
}

let nums = 200_000

/** Stores `sent` for `to` about `task` through the item writer
 * (model/inboxItems.ts itemEdits) without postMessage's checks, as messages
 * received while `to` could see the task. Answers the rows. */
async function deliver(t: T, to: Doc<'profiles'>, task: Doc<'issues'>, ...sent: Sent[]) {
  return await t.run(async (ctx) => {
    const edits = itemEdits(ctx)
    await edits.state(to.id, 'ensure')
    const rows = []
    for (const s of sent) {
      const row = {
        id: uuid(),
        org_id: task.org_id,
        recipient_id: to.id,
        actor_id: s.actor,
        issue_id: task.id,
        issue_title: task.title,
        kind: s.kind ?? ('change' as const),
        detail: s.body ?? `Update ${s.minute}`,
        created_at: at(s.minute),
        ...(s.read === true ? { read_at: at(s.minute) } : {}),
      }
      await edits.insert(row, task.project_id)
      rows.push(row)
    }
    await edits.flush()
    return rows
  })
}

/** `n` tasks, the `i`th in project `projectOf(i)` titled `title(i)`, with
 * the fields `task(i)`, each with an item of `to` holding the messages
 * `sent(i)` (one change at minute i by default), `chunk` tasks a
 * transaction through one item writer. Answers the tasks in the order
 * planted, the oldest group first. */
async function plantGroups(
  t: T,
  to: Doc<'profiles'>,
  n: number,
  projectOf: (i: number) => string,
  o: {
    sent?: (i: number) => Sent[]
    title?: (i: number) => string
    task?: (i: number) => Partial<Doc<'issues'>>
    chunk?: number
  } = {},
): Promise<Doc<'issues'>[]> {
  const out: Doc<'issues'>[] = []
  const chunk = o.chunk ?? 250
  for (let from = 0; from < n; from += chunk) {
    const made = await t.run(async (ctx) => {
      const edits = itemEdits(ctx)
      await edits.state(to.id, 'ensure')
      const tasks: Doc<'issues'>[] = []
      for (let i = from; i < Math.min(n, from + chunk); i++) {
        const _id = await insertTask(
          ctx.db,
          {
            id: uuid(),
            org_id: to.org_id,
            project_id: projectOf(i),
            num: nums++,
            title: o.title?.(i) ?? `Calibrate the bench fixture for board revision ${i}`,
            description: '',
            status: 'todo',
            priority: 'medium',
            paused: false,
            created_at: NOW,
            updated_at: NOW,
            window_key: newWindowKey(),
            ...o.task?.(i),
          },
          'restore',
        )
        const task = (await ctx.db.get(_id)) as Doc<'issues'>
        for (const s of o.sent?.(i) ?? [{ minute: i }]) {
          await edits.insert(
            {
              id: uuid(),
              org_id: task.org_id,
              recipient_id: to.id,
              actor_id: s.actor,
              issue_id: task.id,
              issue_title: task.title,
              kind: s.kind ?? 'change',
              detail: s.body ?? `Status changed from Todo to In progress (${i})`,
              created_at: at(s.minute),
              ...(s.read === true ? { read_at: at(s.minute) } : {}),
            },
            task.project_id,
          )
        }
        tasks.push(task)
      }
      await edits.flush()
      return tasks
    })
    out.push(...made)
  }
  return out
}

/** `n` groups of `to` planted raw, the `i`th about a new task in project
 * `projectOf(i)` titled `title(i)`, with the one message `sent(i)` and its
 * item row as model/inboxItems.ts itemOf makes it, `chunk` groups a
 * transaction. It writes no description, used_ids or count row, which the
 * page never reads, and runs no query, so the design size's 6,000 groups
 * plant in seconds where plantGroups' writers take minutes. */
async function plantRaw(
  t: T,
  to: Doc<'profiles'>,
  n: number,
  projectOf: (i: number) => string,
  o: { sent: (i: number) => Sent; title: (i: number) => string; chunk?: number },
) {
  const chunk = o.chunk ?? 2000
  await t.run((ctx) => ensureInboxState(ctx, to.id))
  for (let from = 0; from < n; from += chunk)
    await t.run(async (ctx) => {
      for (let i = from; i < Math.min(n, from + chunk); i++) {
        const task = {
          id: uuid(),
          org_id: to.org_id,
          project_id: projectOf(i),
          num: nums++,
          title: o.title(i),
          status: 'todo' as const,
          priority: 'medium' as const,
          paused: false,
          created_at: NOW,
          updated_at: NOW,
          window_key: newWindowKey(),
        }
        await ctx.db.insert('issues', task)
        const s = o.sent(i)
        const message = {
          id: uuid(),
          org_id: to.org_id,
          recipient_id: to.id,
          actor_id: s.actor,
          issue_id: task.id,
          issue_title: task.title,
          kind: s.kind ?? ('change' as const),
          detail: s.body ?? `Status changed from Todo to In progress (${i})`,
          created_at: at(s.minute),
          ...(s.read === true ? { read_at: at(s.minute) } : {}),
        }
        const _id = await ctx.db.insert('messages', message)
        const item = itemOf(
          { recipient_id: to.id, issue_id: task.id },
          [{ ...message, _id }],
          task.project_id,
        )
        if (item !== null) await ctx.db.insert('inbox_items', item)
      }
    })
}

/** A seat in the fixture's organization with a login, `role` (guest by
 * default), and a grant on each of `projects`. */
async function reader(t: T, f: OrgFixture, projects: readonly Doc<'projects'>[], role = 'guest') {
  const me = await plantLogin(
    t,
    await plantSeat(t, {
      org_id: f.org.id,
      accepted_at: NOW,
      name: 'Reader',
      org_role: role as Doc<'profiles'>['org_role'],
    }),
  )
  for (const p of projects) await grant(t, me, p.id)
  return me
}

/* ---------------------------------------------------------------- reading */

/** The arguments of a browse: newest first, everything but snoozed. */
const BROWSE: InboxPageArgs = {
  order: 'newest',
  unread_only: false,
  include_snoozed: false,
  kinds: [],
}

/** One page of `who`'s Inbox for `a`. */
const pageOf = (t: T, who: Doc<'profiles'>, a: Partial<InboxPageArgs> = {}) =>
  as(t, who).query(api.inbox.page, { ...BROWSE, ...a })

/** Every page of `who`'s Inbox for `a`, following `next` to the end. */
async function pages(t: T, who: Doc<'profiles'>, a: Partial<InboxPageArgs> = {}, most = 200) {
  const out: InboxPage[] = []
  let after: string | undefined
  for (let i = 0; i < most; i++) {
    const page = await pageOf(t, who, { ...a, ...(after === undefined ? {} : { after }) })
    out.push(page)
    if (page.next === null) return out
    after = page.next
  }
  throw new Error('the pages did not end')
}

/** The task ids of `rows`. */
const ids = (rows: readonly InboxRow[]) => rows.map((row) => row.issue_id)

/** The task ids of every row of `ps`. */
const allIds = (ps: readonly InboxPage[]) => ps.flatMap((p) => ids(p.rows))

/** The ids of `tasks`, newest group first when they were planted oldest
 * first. */
const newestFirst = (tasks: readonly Doc<'issues'>[]) => tasks.map((task) => task.id).reverse()

/** One page read as inbox.page reads it, in one transaction, with what the
 * transaction read in all. */
const measured = (t: T, who: Doc<'profiles'>, a: Partial<InboxPageArgs> = {}) =>
  measure(t, async (ctx) => {
    const seats = await ctx.db
      .query('profiles')
      .withIndex('by_auth', (q) => q.eq('auth_user_id', who.auth_user_id))
      .collect()
    return await readInboxPage(
      ctx,
      who.auth_user_id as string,
      seats.filter((s) => s.active),
      { ...BROWSE, ...a },
    )
  })

/** Every page of a measured read, following `next`, with each page's reads. */
async function measuredPages(t: T, who: Doc<'profiles'>, a: Partial<InboxPageArgs> = {}) {
  const out: { page: InboxPage; ranges: number; documents: number; bytes: number }[] = []
  let after: string | undefined
  for (let i = 0; i < 200; i++) {
    const read = await measured(t, who, { ...a, ...(after === undefined ? {} : { after }) })
    out.push({
      page: read.answer,
      ranges: read.ranges,
      documents: read.documents,
      bytes: read.bytes,
    })
    if (read.answer.next === null) return out
    after = read.answer.next
  }
  throw new Error('the pages did not end')
}

/** The figures of one measured page, for the log. */
const figures = (r: { page: InboxPage; ranges: number; documents: number; bytes: number }) =>
  `${r.page.rows.length} rows, ${r.ranges} ranges, ${r.documents} documents, ` +
  `${Math.round(r.bytes / 1024)} KB read, ${r.page.stopped ? 'stopped' : r.page.next === null ? 'the end' : 'full'}, ` +
  `answer ${Math.round(JSON.stringify(r.page).length / 1024)} KB`

/* ------------------------------------------------------------ the rules */

describe('the shared rules of an Inbox row', () => {
  it('write the second line, the detail and the search text as src/panels/Inbox.tsx does', () => {
    // 0075's fallback with the former noun
    expect(messageDetail('Moved to an issue in another project')).toBe(
      'Moved to a task in another project',
    )
    expect(messageDetail('Status changed from Todo to Done')).toBe(
      'Status changed from Todo to Done',
    )
    expect(messageLine({ kind: 'mention', detail: MENTION_DETAILS.comment }, 'Ada')).toBe(
      'from @Ada',
    )
    expect(messageLine({ kind: 'mention', detail: MENTION_DETAILS.description }, null)).toBe(
      'from @Someone',
    )
    expect(messageLine({ kind: 'comment', detail: 'New comment from Ada' }, 'Ada')).toBe(
      'New comment',
    )
    expect(
      messageLine({ kind: 'change', detail: 'Moved to an issue in another project' }, null),
    ).toBe('Moved to a task in another project')
    expect(
      inboxSearchText({
        title: 'Ship the bench',
        key: 'QN-12',
        line: 'New comment',
        places: ['Testbed platform', 'Firmware'],
        messages: [
          { actor_name: 'Ada', detail: 'Moved to an issue in another project' },
          { actor_name: null, detail: 'Status changed' },
        ],
      }),
    ).toBe(
      [
        'Ship the bench',
        'QN-12',
        'New comment',
        'Testbed platform',
        'Firmware',
        'Ada',
        'Moved to a task in another project',
        'API',
        'Status changed',
      ].join('\n'),
    )
    // a top-level project has no place above it
    expect(
      inboxSearchText({
        title: 'T',
        key: 'QN-1',
        line: 'L',
        places: [undefined, 'Solo'],
        messages: [],
      }),
    ).toBe('T\nQN-1\nL\nSolo')
  })

  it('give the kinds an item holds and match the kind filter on any of them', () => {
    const counts = (mentions: number, changes: number, comments: number) => ({
      mentions,
      changes,
      comments,
    })
    expect(itemKinds(counts(1, 2, 0))).toEqual(['mention', 'change'])
    expect(itemKinds(counts(0, 0, 3))).toEqual(['comment'])
    expect(itemKinds(counts(2, 1, 1))).toEqual(['mention', 'change', 'comment'])
    expect(kindsMatch(counts(0, 1, 0), [])).toBe(true)
    // a mention behind a newer change still matches Mentions
    expect(kindsMatch(counts(1, 5, 0), ['mention'])).toBe(true)
    expect(kindsMatch(counts(0, 5, 2), ['mention'])).toBe(false)
    expect(kindsMatch(counts(0, 0, 2), ['mention', 'comment'])).toBe(true)
  })
})

/* -------------------------------------------------------- the arguments */

describe('the arguments', () => {
  it('refuse a kind named twice and a search past LIMITS.search, and take a blank search as none', async () => {
    const t = newT()
    const f = await withOrg(t)
    await plantGroups(t, f.guest, 3, () => f.sub.id)
    await expectRefusal(
      pageOf(t, f.guest, { kinds: ['mention', 'mention'] }),
      'bad_request',
      /each message kind at most once/,
    )
    await expectRefusal(
      pageOf(t, f.guest, { search: 'a'.repeat(LIMITS.search.max + 1) }),
      'rule',
      /Search for fewer words/,
    )
    // the longest search is taken, and trimmed first
    expect(
      (await pageOf(t, f.guest, { search: ` ${'a'.repeat(LIMITS.search.max)} ` })).rows,
    ).toEqual([])
    const plain = await pageOf(t, f.guest)
    expect(plain.rows).toHaveLength(3)
    expect(await pageOf(t, f.guest, { search: '   ' })).toEqual(plain)
    expect(await pageOf(t, f.guest, { search: '' })).toEqual(plain)
    expect(await drift(t)).toEqual([])
  })

  it('refuse an after or through of another login, order, filter or search, a changed one and another list’s', async () => {
    const t = newT()
    const f = await withOrg(t)
    // the guest and the viewer both see TBED's sub-projects
    await plantGroups(t, f.guest, 5, () => f.sub.id)
    await plantGroups(t, f.viewer, 5, () => f.sub.id)
    INBOX_PAGE.rows = 2
    const asked: Partial<InboxPageArgs> = { kinds: ['change', 'mention'], search: 'bench' }
    const first = await pageOf(t, f.guest, asked)
    expect(first.rows).toHaveLength(2)
    const next = first.next as string
    // the same page asked with the kinds in another order continues
    const same = await pageOf(t, f.guest, { ...asked, kinds: ['mention', 'change'], after: next })
    expect(same.rows).toHaveLength(2)
    const flipped = `${next.slice(0, 10)}${next[10] === '0' ? '1' : '0'}${next.slice(11)}`
    const labels = await t.run(() =>
      namedCursor('labels.settings', [f.org.id], { key: 'x', tie: [1, 'a'] }),
    )
    const active = await t.run(() =>
      namedCursor('tasks.active.rest', [f.org.id], { key: 'x', tie: ['a'] }),
    )
    // a cursor of this list with a tie of another shape
    const shape = await t.run(async () =>
      namedCursor(
        INBOX_LIST,
        [
          f.guest.auth_user_id as string,
          'newest',
          await filtersKey({
            unread_only: false,
            include_snoozed: false,
            kinds: ['change', 'mention'],
            search: 'bench',
          }),
        ],
        { key: at(1), tie: [1] },
      ),
    )
    const refused: [string, Doc<'profiles'>, Partial<InboxPageArgs>][] = [
      ['another login', f.viewer, { ...asked, after: next }],
      ['another order', f.guest, { ...asked, order: 'oldest', after: next }],
      ['unread only', f.guest, { ...asked, unread_only: true, after: next }],
      ['show snoozed', f.guest, { ...asked, include_snoozed: true, after: next }],
      ['other kinds', f.guest, { ...asked, kinds: ['change'], after: next }],
      ['another search', f.guest, { ...asked, search: 'fixture', after: next }],
      ['no search', f.guest, { ...asked, search: undefined, after: next }],
      ['a changed cursor', f.guest, { ...asked, after: flipped }],
      ['a labels cursor', f.guest, { ...asked, after: labels }],
      ['an active tasks cursor', f.guest, { ...asked, after: active }],
      ['not a cursor', f.guest, { ...asked, after: 'abc' }],
      ['a tie of another shape', f.guest, { ...asked, after: shape }],
      ['through of another login', f.viewer, { ...asked, through: next }],
      ['through of another order', f.guest, { ...asked, order: 'oldest', through: next }],
      ['through of other kinds', f.guest, { ...asked, kinds: ['change'], through: next }],
      ['a changed through', f.guest, { ...asked, through: flipped }],
      ['through of another list', f.guest, { ...asked, through: labels }],
    ]
    for (const [why, who, a] of refused) {
      const args = Object.fromEntries(Object.entries(a).filter(([, value]) => value !== undefined))
      await expect(
        expectRefusal(pageOf(t, who, args), 'bad_request', /cursors from an earlier Inbox page/),
        why,
      ).resolves.toBeDefined()
    }
    // a through that does not come after `after`
    await expectRefusal(
      pageOf(t, f.guest, { ...asked, after: next, through: next }),
      'bad_request',
      /through must be a cursor after the one in after/,
    )
    expect(
      (await pageOf(t, f.guest, { ...asked, after: next, through: same.next as string })).rows,
    ).toEqual(same.rows)
    expect(NOT_INBOX_CURSOR).toMatch(/start again from the first page/)
    expect(await drift(t)).toEqual([])
  })
})

/* ------------------------------------------------------------- parity */

describe('parity with the workspace inbox part', () => {
  it('pages the groups the part shows, with their counts, kinds, snooze and newest message, for every person of Northstar', async () => {
    const t = newT()
    const { org, profiles } = await plantNorthstar(t)
    INBOX_PAGE.rows = 3
    let compared = 0
    for (const person of profiles.filter((p) => p.auth_user_id !== undefined)) {
      const caller = t.withIdentity({ subject: person.auth_user_id as string })
      const part = await caller.query(api.workspace.inbox, { org_id: org.id })
      if (part.state !== 'ok') throw new Error(part.state)
      // Northstar holds far fewer than 500 messages a person, so the part is complete
      expect(part.truncated, person.name).toBe(false)
      const byTask = new Map<string, (typeof part.unread)[number][]>()
      for (const m of [...part.unread, ...part.read])
        byTask.set(m.issue_id, [...(byTask.get(m.issue_id) ?? []), m])
      const facts = new Map(
        await t.run(async (ctx) => {
          const out = new Map<
            string,
            { task: Doc<'issues'>; project: Doc<'projects'>; parent: Doc<'projects'> | null }
          >()
          for (const id of byTask.keys()) {
            const task = await ctx.db
              .query('issues')
              .withIndex('by_uuid', (q) => q.eq('id', id))
              .unique()
            if (task === null) throw new Error('a shown task is gone')
            const project = await ctx.db
              .query('projects')
              .withIndex('by_uuid', (q) => q.eq('id', task.project_id))
              .unique()
            if (project === null) throw new Error('a shown task has no project')
            const parent =
              project.parent_id === undefined
                ? null
                : await ctx.db
                    .query('projects')
                    .withIndex('by_uuid', (q) => q.eq('id', project.parent_id as string))
                    .unique()
            out.set(id, { task, project, parent })
          }
          return [...out]
        }),
      )
      const groups = [...byTask].map(([issue_id, rows]) => {
        const fact = facts.get(issue_id)
        if (fact === undefined) throw new Error('no task')
        const item = itemOf(
          { recipient_id: person.id, issue_id },
          rows as unknown as Parameters<typeof itemOf>[1],
          fact.task.project_id,
        )
        if (item === null) throw new Error('no item')
        return { item, ...fact }
      })
      const combos: Partial<InboxPageArgs>[] = [
        { include_snoozed: true },
        { include_snoozed: false },
        { include_snoozed: true, unread_only: true },
        { include_snoozed: true, kinds: ['mention'] },
        { include_snoozed: true, kinds: ['comment'] },
        { include_snoozed: true, kinds: ['change'] },
        { include_snoozed: true, kinds: ['mention', 'comment'] },
      ]
      for (const combo of combos)
        for (const order of ['newest', 'oldest'] as const) {
          const a = { ...combo, order }
          const want = groups
            .filter(({ item }) => a.include_snoozed === true || !item.snoozed)
            .filter(({ item }) => a.unread_only !== true || item.unread)
            .filter(({ item }) => kindsMatch(item, a.kinds ?? []))
            .sort((x, y) => {
              const by =
                x.item.sort_at !== y.item.sort_at
                  ? x.item.sort_at < y.item.sort_at
                    ? -1
                    : 1
                  : x.item.issue_id < y.item.issue_id
                    ? -1
                    : 1
              return order === 'oldest' ? by : -by
            })
          const got = await pages(t, person, a)
          const rows = got.flatMap((p) => p.rows)
          const how = `${person.name} ${JSON.stringify(a)}`
          expect(
            got.every((p) => !p.stopped && p.not_ready.length === 0 && !p.unchecked),
            how,
          ).toBe(true)
          expect(ids(rows), how).toEqual(want.map(({ item }) => item.issue_id))
          for (const [i, row] of rows.entries()) {
            const { item, task, project, parent } = want[i]
            expect(row, how).toMatchObject({
              org_id: org.id,
              issue_id: item.issue_id,
              num: task.num,
              title: task.title,
              project: { id: project.id, num: project.num, name: project.name },
              parent:
                parent === null ? null : { id: parent.id, num: parent.num, name: parent.name },
              sort_at: item.sort_at,
              latest_at: item.latest_at,
              woke_at: item.woke_at ?? null,
              latest: { id: item.latest_id },
              unread_count: item.unread_count,
              dropped: item.dropped,
              count: item.mentions + item.changes + item.comments,
              kinds: itemKinds(item),
              snoozed_until: item.snoozed_until ?? null,
            })
            compared += 1
          }
        }
    }
    // the seed leaves groups to compare
    expect(compared).toBeGreaterThan(0)
    expect(await drift(t)).toEqual([])
  })
})

/* -------------------------------------------------------------- access */

describe('who sees what', () => {
  it('never shows a group about a task the caller is not shown, and shows it again when access returns', async () => {
    const t = newT()
    const f = await withOrg(t)
    const task = (project_id = f.sub.id) => plantIssue(t, { org_id: f.org.id, project_id })
    const shown = await task()
    await deliver(t, f.guest, shown, { minute: 1 })
    // in a project the guest loses
    const lost = await plantProject(t, { org_id: f.org.id })
    const revoke = await grant(t, f.guest, lost.id)
    const inLost = await task(lost.id)
    await deliver(t, f.guest, inLost, { minute: 2 })
    // in a project archived later
    const shelved = await plantProject(t, { org_id: f.org.id })
    await grant(t, f.guest, shelved.id)
    const inShelved = await task(shelved.id)
    await deliver(t, f.guest, inShelved, { minute: 3 })
    // archived itself, by the archive, whose read steps the fake timers hold
    const archived = await task()
    await deliver(t, f.guest, archived, { minute: 4 })
    // archived raw, as a task archived before its read step ran
    const raw = await task()
    await deliver(t, f.guest, raw, { minute: 5 })
    // moved to Deleted items, before its drain
    const trashed = await task()
    await deliver(t, f.guest, trashed, { minute: 6 })
    // another login's item about a task the guest sees
    const theirs = await task()
    await deliver(t, f.user, theirs, { minute: 7 })
    expect(ids((await pageOf(t, f.guest)).rows)).toEqual(
      [shown, inLost, inShelved, archived, raw, trashed].map((x) => x.id).reverse(),
    )
    await revoke()
    await t.run((ctx) => ctx.db.patch(shelved._id, { archived_at: NOW }))
    await as(t, f.user).mutation(api.issues.archive, { org_id: f.org.id, id: archived.id })
    await archiveRaw(t, [raw])
    TRASH_BUDGET.rows = 1
    await deleteTask(t, f, trashed.id)
    const after = await pageOf(t, f.guest, { include_snoozed: true })
    expect(after).toEqual({
      rows: [expect.objectContaining({ issue_id: shown.id })],
      next: null,
      stopped: false,
      checked_to: at(1),
      not_ready: [],
      unchecked: false,
    })
    // the archive left its message unread, so only the task check hides it
    expect(
      (await pageOf(t, f.guest, { unread_only: true })).rows.map((row) => row.issue_id),
    ).toEqual([shown.id])
    expect(ids((await pageOf(t, f.user)).rows)).toEqual([theirs.id])
    // access back, the group shows again
    await grant(t, f.guest, lost.id)
    expect(ids((await pageOf(t, f.guest)).rows)).toEqual([inLost.id, shown.id])
    // the drain deletes the trashed task's item after its messages
    await runSteps(t)
    expect(await drift(t)).toEqual([])
  })

  it('leaves a task moved into a hidden project out at once, and shows one moved into a visible project once its re-key runs', async () => {
    const t = newT()
    const f = await withOrg(t)
    const hidden = await plantHiddenSibling(t, f, f.guest)
    const move = (id: string, project_id: string) =>
      as(t, f.admin).mutation(api.issues.move, { org_id: f.org.id, id, project_id })
    const away = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id })
    await deliver(t, f.guest, away, { minute: 1 })
    expect(ids((await pageOf(t, f.guest)).rows)).toEqual([away.id])
    REKEY.inline = 0
    await move(away.id, hidden.id)
    // its hint still names FW, and its task is checked by its own project
    expect(await pageOf(t, f.guest)).toMatchObject({ rows: [], next: null, checked_to: null })
    await runSteps(t)
    expect((await pageOf(t, f.guest)).rows).toEqual([])
    // from the hidden project into a visible one, past the inline re-key
    const back = await plantIssue(t, { org_id: f.org.id, project_id: hidden.id })
    await deliver(t, f.guest, back, { minute: 2 })
    expect((await pageOf(t, f.guest)).rows).toEqual([])
    await move(back.id, f.sub2.id)
    // left out by its hint until the step runs, never a hidden task
    expect((await pageOf(t, f.guest)).rows).toEqual([])
    await runSteps(t)
    expect(ids((await pageOf(t, f.guest)).rows)).toEqual([back.id])
    expect(await drift(t)).toEqual([])
  })

  it('lists for every access shape, guest or organization Viewer, what inbox.item and the summary show', async () => {
    for (const [name, plant] of SHAPES)
      for (const role of ['guest', 'viewer']) {
        const t = newT()
        const f = await withOrg(t)
        const me = await reader(t, f, [], role)
        await t.run((ctx) => plant(ctx, f, me))
        const tasks: Doc<'issues'>[] = []
        for (const p of [f.meta, f.sub, f.sub2, f.hidden, f.otherProject]) {
          const task = await plantIssue(t, { org_id: p.org_id, project_id: p.id })
          tasks.push(task)
          if (p.org_id === f.org.id) await deliver(t, me, task, { minute: tasks.length })
        }
        const shown: string[] = []
        for (const task of tasks) {
          const item = await as(t, me).query(api.inbox.item, {
            org_id: f.org.id,
            issue_id: task.id,
          })
          if (item.state === 'ok' && item.item !== null) shown.push(task.id)
        }
        const how = `${name} as ${role}`
        const page = await pageOf(t, me, { order: 'oldest' })
        expect(ids(page.rows), how).toEqual(shown)
        expect(page, how).toMatchObject({ next: null, stopped: false, unchecked: false })
        const summary = await as(t, me).query(api.inbox.summary, {})
        expect(summary.unread_count, how).toBe(shown.length)
        expect(await drift(t), how).toEqual([])
      }
  })

  it('names an actor only from the seat’s own organization, in the row and in the search', async () => {
    const t = newT()
    const f = await withOrg(t)
    const [own, foreign] = await plantGroups(t, f.guest, 2, () => f.sub.id, {
      title: (i) => ['Own', 'Foreign'][i],
      sent: (i) => [
        {
          minute: i,
          kind: 'mention' as const,
          body: MENTION_DETAILS.comment,
          actor: [f.admin.id, f.otherAdmin.id][i],
        },
      ],
    })
    const rows = (await pageOf(t, f.guest)).rows
    expect(rows.find((r) => r.issue_id === own.id)?.latest.actor_name).toBe('admin')
    expect(rows.find((r) => r.issue_id === foreign.id)?.latest.actor_name).toBeNull()
    // the other organization's admin is "Someone" on the line and "API" in the text
    expect(ids((await pageOf(t, f.guest, { search: 'otherAdmin' })).rows)).toEqual([])
    expect(ids((await pageOf(t, f.guest, { search: 'someone api' })).rows)).toEqual([foreign.id])
    expect(await drift(t)).toEqual([])
  })

  it('lists for an organization admin what the summary counts for them', async () => {
    const t = newT()
    const f = await withOrg(t)
    for (const [i, p] of [f.meta, f.sub, f.sub2, f.hidden].entries())
      await deliver(t, f.admin, await plantIssue(t, { org_id: f.org.id, project_id: p.id }), {
        minute: i,
        actor: f.user.id,
      })
    const page = await pageOf(t, f.admin)
    const summary = await as(t, f.admin).query(api.inbox.summary, {})
    expect(page.rows.length).toBe(summary.unread_count)
    expect(page.rows.length).toBeGreaterThan(0)
    expect(await drift(t)).toEqual([])
  })
})

/* ----------------------------------------------------- stopped checks */

describe('a check of the caller’s access that a bound stops', () => {
  it('leaves its groups out and says unchecked, keeps the others, and one bound up answers as with the default bounds', async () => {
    const t = newT()
    const f = await withOrg(t)
    const me = await reader(t, f, [f.sub], 'user')
    await t.run(async (ctx) => {
      await ctx.db.insert('team_members', {
        team_id: f.team.id,
        profile_id: me.id,
        is_leader: false,
      })
      await ctx.db.insert('project_team_access', {
        project_id: f.sub2.id,
        team_id: f.team.id,
        level: 'user',
      })
    })
    const [a, b] = await plantGroups(t, me, 2, () => f.sub.id)
    const [shared] = await plantGroups(t, me, 1, () => f.sub2.id, { sent: () => [{ minute: 5 }] })
    const usual = await pageOf(t, me)
    expect(ids(usual.rows)).toEqual([shared.id, b.id, a.id])
    expect(usual.unchecked).toBe(false)
    // the check of PCB, shared with the seat's team, stops
    Object.assign(OWN_READS, { projectShares: 0, rows: 0, lookups: 0, teamReads: 0 })
    const stopped = await pageOf(t, me)
    expect(stopped).toMatchObject({ next: null, stopped: false, unchecked: true })
    expect(ids(stopped.rows)).toEqual([b.id, a.id])
    // room for the team asked by itself and its own row
    Object.assign(OWN_READS, { lookups: 1, teamReads: 2 })
    expect(await pageOf(t, me)).toEqual(usual)
    expect(await drift(t)).toEqual([])
  })
})

/* -------------------------------------------------------------- seats */

describe('the seats of a login', () => {
  it('merges two seats in one order, and names a seat that is not ready instead of walking it', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.guest.auth_user_id,
      org_role: 'guest',
      name: 'guest',
    })
    await grant(t, elsewhere, f.otherProject.id)
    const here = await plantGroups(t, f.guest, 3, () => f.sub.id, {
      sent: (i) => [{ minute: 2 * i }],
    })
    const there = await plantGroups(t, elsewhere, 3, () => f.otherProject.id, {
      sent: (i) => [{ minute: 2 * i + 1 }],
    })
    const both = [there[2], here[2], there[1], here[1], there[0], here[0]].map((x) => x.id)
    expect(ids((await pageOf(t, f.guest)).rows)).toEqual(both)
    INBOX_PAGE.rows = 4
    expect(allIds(await pages(t, f.guest))).toEqual(both)
    expect(allIds(await pages(t, f.guest, { order: 'oldest' }))).toEqual([...both].reverse())
    INBOX_PAGE.rows = DEFAULT_PAGE.rows
    // the other seat still being built
    const state = await t.run((ctx) =>
      ctx.db
        .query('inbox_state')
        .withIndex('by_profile', (q) => q.eq('profile_id', elsewhere.id))
        .unique(),
    )
    await t.run((ctx) => ctx.db.patch(state!._id, { built: false }))
    expect(await pageOf(t, f.guest)).toMatchObject({
      rows: here.map((x) => expect.objectContaining({ issue_id: x.id })).reverse(),
      next: null,
      not_ready: [f.otherOrg.id],
    })
    // and with messages from before its state
    await t.run((ctx) => ctx.db.delete(state!._id))
    expect((await pageOf(t, f.guest)).not_ready).toEqual([f.otherOrg.id])
    // with every seat not ready, no row and no next, but never an empty Inbox
    const mine = await t.run((ctx) =>
      ctx.db
        .query('inbox_state')
        .withIndex('by_profile', (q) => q.eq('profile_id', f.guest.id))
        .unique(),
    )
    await t.run((ctx) => ctx.db.patch(mine!._id, { built: false }))
    expect(await pageOf(t, f.guest)).toEqual({
      rows: [],
      next: null,
      stopped: false,
      checked_to: null,
      not_ready: [f.org.id, f.otherOrg.id].sort(),
      unchecked: false,
    })
    // another login in the other organization reads none of them
    expect((await pageOf(t, f.otherAdmin)).rows).toEqual([])
  })

  it('keeps two seats’ items at one list time and task id apart, each once in both orders, also where a page ends between them', async () => {
    const t = newT()
    const f = await withOrg(t)
    const elsewhere = await plantSeat(t, {
      org_id: f.otherOrg.id,
      auth_user_id: f.guest.auth_user_id,
      org_role: 'guest',
      name: 'guest',
    })
    await grant(t, elsewhere, f.otherProject.id)
    const [lo, hi] = [f.guest, elsewhere].sort((x, y) => (x.id < y.id ? -1 : 1))
    const home = (seat: Doc<'profiles'>) => (seat.id === f.guest.id ? f.sub : f.otherProject)
    // a group of seat `shown` at `minute`, and an item of seat `gone` with
    // the same task id and list time, as a create in another organization
    // can take the id of a task deleted for good (schema.ts) while the
    // item waits for its teardown; the walk reads it and leaves it out
    const shared = async (shown: Doc<'profiles'>, gone: Doc<'profiles'>, minute: number) => {
      const [task] = await plantGroups(t, shown, 1, () => home(shown).id, {
        sent: () => [{ minute }],
      })
      await deliver(t, gone, { ...task, org_id: gone.org_id }, { minute })
      return task
    }
    const [first] = await plantGroups(t, f.guest, 1, () => f.sub.id, {
      sent: () => [{ minute: 1 }],
    })
    // the left-out item comes first at its position oldest first in the
    // first pair, newest first in the second
    const up = await shared(hi, lo, 10)
    const down = await shared(lo, hi, 20)
    const [last] = await plantGroups(t, elsewhere, 1, () => f.otherProject.id, {
      sent: () => [{ minute: 30 }],
    })
    const order = [first, up, down, last].map((x) => x.id)
    expect(ids((await pageOf(t, f.guest)).rows)).toEqual([...order].reverse())
    expect(ids((await pageOf(t, f.guest, { order: 'oldest' })).rows)).toEqual(order)
    // one item a page, so a page ends on the left-out item and the next
    // reads the other seat's item at the same list time and task id
    INBOX_PAGE.rows = 1
    INBOX_PAGE.reads = { ranges: 0, documents: 0, bytes: 0 }
    const newest = await pages(t, f.guest)
    expect(newest.some((p) => p.rows.length === 0 && p.stopped)).toBe(true)
    expect(allIds(newest)).toEqual([...order].reverse())
    expect(allIds(await pages(t, f.guest, { order: 'oldest' }))).toEqual(order)
    expect(await drift(t)).toEqual([])
  })
})

/* ---------------------------------------------------- filters and order */

describe('the filters and the order', () => {
  it('apply Unread only, Show snoozed with a wake, the kinds and the phone’s segments before the page is cut', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    // 8 groups, minute order: change, mention, comment, change+mention, read change, ...
    const tasks = await plantGroups(t, f.guest, 8, () => f.sub.id, {
      sent: (i) =>
        [
          [{ minute: 0 }],
          [
            {
              minute: 1,
              kind: 'mention' as const,
              body: MENTION_DETAILS.comment,
              actor: f.admin.id,
            },
          ],
          [{ minute: 2, kind: 'comment' as const, body: 'New comment' }],
          [
            { minute: 3, kind: 'mention' as const, body: MENTION_DETAILS.description },
            { minute: 4 },
          ],
          [{ minute: 5, read: true }],
          [{ minute: 6, kind: 'mention' as const, read: true }],
          [{ minute: 7 }],
          [{ minute: 8 }],
        ][i],
    })
    const [change, mention, comment, both, readChange, readMention, sleeper, waker] = tasks
    const until = new Date(START + DAY).toISOString()
    for (const task of [sleeper, waker])
      await guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: task.id, until })
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: waker.id,
      until,
    })
    const order = async (a: Partial<InboxPageArgs>) => ids((await pageOf(t, f.guest, a)).rows)
    // the woken group floats by its wake, the snoozed one is left out
    expect(await order({})).toEqual(
      [waker, readMention, readChange, both, comment, mention, change].map((x) => x.id),
    )
    expect(await order({ include_snoozed: true })).toEqual(
      [waker, sleeper, readMention, readChange, both, comment, mention, change].map((x) => x.id),
    )
    expect(await order({ order: 'oldest', include_snoozed: true })).toEqual(
      [change, mention, comment, both, readChange, readMention, sleeper, waker].map((x) => x.id),
    )
    expect(await order({ unread_only: true })).toEqual(
      [waker, both, comment, mention, change].map((x) => x.id),
    )
    expect(await order({ kinds: ['mention'] })).toEqual(
      [readMention, both, mention].map((x) => x.id),
    )
    expect(await order({ kinds: ['comment'] })).toEqual([comment.id])
    expect(await order({ kinds: ['change'] })).toEqual(
      [waker, readChange, both, change].map((x) => x.id),
    )
    expect(await order({ kinds: ['comment', 'mention'] })).toEqual(
      [readMention, both, comment, mention].map((x) => x.id),
    )
    // the phone's Unread, Mentions and All
    expect(await order({ unread_only: true, kinds: [] })).toEqual(
      [waker, both, comment, mention, change].map((x) => x.id),
    )
    expect(await order({ unread_only: false, kinds: ['mention'] })).toEqual(
      [readMention, both, mention].map((x) => x.id),
    )
    expect(await order({ unread_only: false, kinds: [] })).toEqual(await order({}))
    // a filter that leaves out every group of a full page still fills one
    INBOX_PAGE.rows = 2
    expect(allIds(await pages(t, f.guest, { kinds: ['mention'] }))).toEqual(
      [readMention, both, mention].map((x) => x.id),
    )
    expect(await drift(t)).toEqual([])
  })

  it('breaks equal list times by task id, descending newest first and ascending oldest first', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantGroups(t, f.guest, 7, () => f.sub.id, {
      sent: (i) => [{ minute: i < 5 ? 10 : i }],
    })
    const tied = tasks.slice(0, 5).map((x) => x.id)
    const up = [...tied].sort()
    INBOX_PAGE.rows = 2
    expect(allIds(await pages(t, f.guest))).toEqual([
      ...[...up].reverse(),
      tasks[6].id,
      tasks[5].id,
    ])
    expect(allIds(await pages(t, f.guest, { order: 'oldest' }))).toEqual([
      tasks[5].id,
      tasks[6].id,
      ...up,
    ])
    expect(await drift(t)).toEqual([])
  })
})

/* ------------------------------------------------------------- search */

describe('the search', () => {
  it('finds every word in the title, key, second line, places and every message, in any case, accents kept', async () => {
    const t = newT()
    const f = await withOrg(t)
    // a person with a name of their own, an actor of the organization
    const ada = await plantSeat(t, { org_id: f.org.id, name: 'Ada Lovelace', accepted_at: NOW })
    const [plain, older, mention, comment, moved, machine, cafe] = await plantGroups(
      t,
      f.guest,
      7,
      () => f.sub.id,
      {
        title: (i) =>
          ['Ship the bench', 'Tune the oscillator', 'Plan', 'Review', 'Port', 'Sync', 'Café order'][
            i
          ],
        sent: (i) =>
          [
            [{ minute: 0, actor: f.admin.id, body: 'Priority changed from Low to High' }],
            [
              { minute: 1, actor: ada.id, body: 'Raised the clock to 48 MHz' },
              { minute: 2, actor: f.admin.id, body: 'Priority changed from Low to High' },
            ],
            [{ minute: 3, kind: 'mention' as const, body: MENTION_DETAILS.comment, actor: ada.id }],
            [{ minute: 4, kind: 'comment' as const, body: 'Comment notice', actor: f.admin.id }],
            [{ minute: 5, body: 'Moved to an issue in another project', actor: f.admin.id }],
            [{ minute: 6, body: 'Status changed from Todo to Done' }],
            [{ minute: 7, actor: f.admin.id, body: 'Priority changed from Low to High' }],
          ][i],
      },
    )
    const found = async (search: string) =>
      ids((await pageOf(t, f.guest, { search, include_snoozed: true })).rows)
    expect(await found('bench')).toEqual([plain.id])
    expect(await found(issueKey(older.num))).toEqual([older.id])
    expect(await found(issueKey(older.num).toLowerCase())).toEqual([older.id])
    // the project above and the sub-project, every group's
    expect((await found('Testbed')).length).toBe(7)
    expect((await found('firmware')).length).toBe(7)
    expect(await found('from @ada')).toEqual([mention.id])
    expect(await found('new comment')).toEqual([comment.id])
    // the 0075 wording, as the line shows it and as the message holds it
    expect(await found('a task in another')).toEqual([moved.id])
    expect(await found('an issue in another')).toEqual([])
    // an older message's actor and detail
    expect(await found('48 MHz')).toEqual([older.id])
    expect(await found('lovelace oscillator')).toEqual([older.id])
    // a message without an actor reads as API
    expect(await found('api todo')).toEqual([machine.id])
    // words over several fields, in any case
    expect(await found('FIRMWARE bench')).toEqual([plain.id])
    expect(await found('Tune MHZ testbed')).toEqual([older.id])
    // accents kept
    expect(await found('café')).toEqual([cafe.id])
    expect(await found('cafe')).toEqual([])
    expect(await found('å')).toEqual([])
    expect(await drift(t)).toEqual([])
  })

  it('searches the whole Inbox, never a hidden group, and answers a search that is not finished as stopped, page after page', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 120 groups, the oldest one holding a word no other does
    const tasks = await plantGroups(t, f.guest, 120, () => f.sub.id, {
      title: (i) => (i === 0 ? 'Wire the zebra harness' : `Calibrate fixture ${i}`),
    })
    // a group the guest is not shown that would match, the newest
    const lost = await plantProject(t, { org_id: f.org.id })
    const hiddenTask = await plantIssue(t, {
      org_id: f.org.id,
      project_id: lost.id,
      title: 'Zebra plan',
    })
    await deliver(t, f.guest, hiddenTask, { minute: 500 })
    // on the third page of a browse, on the first of a search
    const found = await pageOf(t, f.guest, { search: 'zebra' })
    expect(found).toMatchObject({ next: null, stopped: false })
    expect(ids(found.rows)).toEqual([tasks[0].id])
    // a search that matches nothing under a budget that reads a few groups
    INBOX_PAGE.reads = { ranges: 30, documents: 1e9, bytes: 1e12 }
    const missed = await pages(t, f.guest, { search: 'no such word' })
    expect(missed.length).toBeGreaterThan(3)
    for (const page of missed.slice(0, -1))
      expect(page).toMatchObject({ rows: [], stopped: true, next: expect.any(String) })
    expect(missed.at(-1)).toMatchObject({ rows: [], next: null })
    // it said how far it had looked, by a shown group's time
    expect(missed[0].checked_to).not.toBeNull()
    expect(missed[0].checked_to! < at(500)).toBe(true)
    // the match found across stopped pages, once
    expect(allIds(await pages(t, f.guest, { search: 'zebra' }))).toEqual([tasks[0].id])
    expect(await drift(t)).toEqual([])
  })
})

/* -------------------------------------------------------- continuation */

describe('continuation', () => {
  it('gives 120 groups as 50, 50 and 20, and keeps a live page whole as groups move between pages', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const tasks = await plantGroups(t, f.guest, 120, () => f.sub.id)
    const all = await pages(t, f.guest)
    expect(all.map((p) => [p.rows.length, p.stopped, p.next === null])).toEqual([
      [50, false, false],
      [50, false, false],
      [20, false, true],
    ])
    expect(allIds(all)).toEqual(newestFirst(tasks))
    const cursor = all[0].next as string
    // between pages: a group before the cursor gets a new message, groups
    // after it are snoozed, removed, read and woken, and a new group comes
    const until = new Date(START + DAY).toISOString()
    await deliver(t, f.guest, tasks[100], { minute: 1000 })
    await guest.mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: tasks[60].id,
      until,
    })
    await guest.mutation(api.messages.removeItem, { org_id: f.org.id, issue_id: tasks[55].id })
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: tasks[50].id })
    await guest.mutation(api.messages.snoozeItem, {
      org_id: f.org.id,
      issue_id: tasks[40].id,
      until,
    })
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: tasks[40].id,
      until,
    })
    const [fresh] = await plantGroups(t, f.guest, 1, () => f.sub.id, {
      sent: () => [{ minute: 2000 }],
    })
    const left = newestFirst(tasks.slice(0, 70)).filter(
      (id) => ![tasks[60].id, tasks[55].id, tasks[40].id].includes(id),
    )
    const second = await pageOf(t, f.guest, { after: cursor })
    const third = await pageOf(t, f.guest, { after: second.next as string })
    expect(third.next).toBeNull()
    expect([...ids(second.rows), ...ids(third.rows)]).toEqual(left)
    for (const page of [second, third]) expect(new Set(ids(page.rows)).size).toBe(page.rows.length)
    // the moved groups wait before the cursor
    expect(ids((await pageOf(t, f.guest)).rows).slice(0, 3)).toEqual([
      tasks[40].id,
      fresh.id,
      tasks[100].id,
    ])
    // a page read again holds what now follows its cursor
    await guest.mutation(api.messages.removeItem, { org_id: f.org.id, issue_id: tasks[69].id })
    expect(ids((await pageOf(t, f.guest, { after: cursor })).rows)).toEqual(
      left.filter((id) => id !== tasks[69].id).slice(0, 50),
    )
    // under Unread only, a group read after the cursor leaves and the page fills from after it
    const unread = await pageOf(t, f.guest, { unread_only: true })
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: tasks[30].id })
    const unreadNext = await pageOf(t, f.guest, { unread_only: true, after: unread.next as string })
    expect(ids(unreadNext.rows)).not.toContain(tasks[30].id)
    expect(ids(unreadNext.rows)).toContain(tasks[29].id)
    expect(await drift(t)).toEqual([])
  })

  it('keeps loaded pages live with through, together holding every group once as groups move, leave or are read, and stops one past four times its rows', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const tasks = await plantGroups(t, f.guest, 12, () => f.sub.id)
    INBOX_PAGE.rows = 4
    // three pages loaded, the first two kept live up to their own next
    const loaded = async (a: Partial<InboxPageArgs> = {}) => {
      const [one, two, three] = await pages(t, f.guest, a)
      expect(three.next).toBeNull()
      const [c1, c2] = [one.next as string, two.next as string]
      const read = async () => [
        await pageOf(t, f.guest, { ...a, through: c1 }),
        await pageOf(t, f.guest, { ...a, after: c1, through: c2 }),
        await pageOf(t, f.guest, { ...a, after: c2 }),
      ]
      return { c1, read }
    }
    const browse = await loaded()
    expect((await browse.read()).map((p) => ids(p.rows))).toEqual([
      newestFirst(tasks.slice(8)),
      newestFirst(tasks.slice(4, 8)),
      newestFirst(tasks.slice(0, 4)),
    ])
    // a group of the second page gets a new message and moves to the top
    // of the first, and a group of the first leaves; each page keeps its
    // end, so no group falls between two pages or shows on two
    await deliver(t, f.guest, tasks[5], { minute: 100 })
    await guest.mutation(api.messages.removeItem, { org_id: f.org.id, issue_id: tasks[10].id })
    const moved = await browse.read()
    expect(moved.map((p) => ids(p.rows))).toEqual([
      [tasks[5], tasks[11], tasks[9], tasks[8]].map((x) => x.id),
      [tasks[7], tasks[6], tasks[4]].map((x) => x.id),
      newestFirst(tasks.slice(0, 4)),
    ])
    expect(moved.every((p) => !p.stopped)).toBe(true)
    // under Unread only, a group read on the first page leaves that page alone
    const unread = await loaded({ unread_only: true })
    await guest.mutation(api.messages.readItem, { org_id: f.org.id, issue_id: tasks[9].id })
    expect((await unread.read()).map((p) => ids(p.rows))).toEqual([
      [tasks[5], tasks[11], tasks[8]].map((x) => x.id),
      [tasks[7], tasks[6], tasks[4], tasks[3]].map((x) => x.id),
      newestFirst(tasks.slice(0, 3)),
    ])
    // a live page that would hold more than four times INBOX_PAGE.rows
    // stops there, as if the read budget stopped it, and the page after
    // that stop takes the rest up to the same end
    const fresh = await plantGroups(t, f.guest, 17, () => f.sub.id, {
      sent: (i) => [{ minute: 200 + i }],
    })
    const capped = await pageOf(t, f.guest, { through: browse.c1 })
    expect(capped.stopped).toBe(true)
    expect(ids(capped.rows)).toEqual(newestFirst(fresh).slice(0, 4 * INBOX_PAGE.rows))
    const split = await pageOf(t, f.guest, { after: capped.next as string, through: browse.c1 })
    expect(split.stopped).toBe(false)
    expect(ids(split.rows)).toEqual(
      [fresh[0], tasks[5], tasks[11], tasks[9], tasks[8]].map((x) => x.id),
    )
    expect(await drift(t)).toEqual([])
  })

  it('oldest first, shows a group a new message moved past the cursor again on a later page, never twice on one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantGroups(t, f.guest, 6, () => f.sub.id)
    INBOX_PAGE.rows = 2
    const first = await pageOf(t, f.guest, { order: 'oldest' })
    expect(ids(first.rows)).toEqual([tasks[0].id, tasks[1].id])
    await deliver(t, f.guest, tasks[0], { minute: 100 })
    const rest = []
    let after = first.next
    while (after !== null) {
      const page = await pageOf(t, f.guest, { order: 'oldest', after })
      expect(new Set(ids(page.rows)).size).toBe(page.rows.length)
      rest.push(...ids(page.rows))
      after = page.next
    }
    expect(rest).toEqual([tasks[2], tasks[3], tasks[4], tasks[5], tasks[0]].map((x) => x.id))
    expect(await drift(t)).toEqual([])
  })
})

/* -------------------------------------------------- budget and coverage */

describe('the read budget', () => {
  it('ends pages short and stopped under a lowered budget, each moving forward, every group once to the end', async () => {
    const t = newT()
    const f = await withOrg(t)
    const tasks = await plantGroups(t, f.guest, 30, () => f.sub.id)
    // a ceiling the request has passed: one group a page, read whatever the budget
    INBOX_PAGE.reads = { ranges: 0, documents: 0, bytes: 0 }
    const one = await pages(t, f.guest)
    expect(one.slice(0, -1).every((p) => p.rows.length === 1 && p.stopped)).toBe(true)
    expect(allIds(one)).toEqual(newestFirst(tasks))
    // a ceiling a few groups wide
    INBOX_PAGE.reads = { ranges: 40, documents: 1e9, bytes: 1e12 }
    const few = await pages(t, f.guest)
    expect(few.length).toBeGreaterThan(2)
    expect(few.slice(0, -1).every((p) => p.stopped && p.rows.length < INBOX_PAGE.rows)).toBe(true)
    expect(allIds(few)).toEqual(newestFirst(tasks))
    expect(await drift(t)).toEqual([])
  })

  it('counts the task reads of groups it leaves out, so archived tasks stop a page within its budget', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shown = await plantGroups(t, f.guest, 5, () => f.sub.id)
    // 200 groups of archived tasks in a visible project, newer than the shown ones
    const archived = await plantGroups(t, f.guest, 200, () => f.sub.id, {
      sent: (i) => [{ minute: 100 + i }],
    })
    await archiveRaw(t, archived)
    INBOX_PAGE.reads = { ranges: 60, documents: 1e9, bytes: 1e12 }
    const first = await measured(t, f.guest)
    // stopped on the archived groups, well before 200 task reads
    expect(first.answer).toMatchObject({ rows: [], stopped: true, checked_to: null })
    expect(first.ranges).toBeLessThan(120)
    const all = await pages(t, f.guest)
    expect(allIds(all)).toEqual(newestFirst(shown))
    expect(await drift(t)).toEqual([])
  })

  it('counts the checks of projects whose groups it skips by their hint', async () => {
    const t = newT()
    const f = await withOrg(t)
    const shown = await plantGroups(t, f.guest, 3, () => f.sub.id)
    // 60 projects the guest no longer sees, a group each, newer than the shown ones
    for (let i = 0; i < 60; i++) {
      const lost = await plantProject(t, { org_id: f.org.id })
      const task = await plantIssue(t, { org_id: f.org.id, project_id: lost.id })
      await deliver(t, f.guest, task, { minute: 100 + i })
    }
    INBOX_PAGE.reads = { ranges: 40, documents: 1e9, bytes: 1e12 }
    const first = await measured(t, f.guest)
    // each project's check reads its row and the guest's levels, which the
    // walk counts by a look at the metrics after the group
    expect(first.answer).toMatchObject({ rows: [], stopped: true })
    expect(first.ranges).toBeLessThan(100)
    expect(allIds(await pages(t, f.guest))).toEqual(newestFirst(shown))
    expect(await drift(t)).toEqual([])
  })

  it('counts every message a search and an unread change read, so a lowered document or byte budget alone ends pages within it', async () => {
    const t = newT()
    const f = await withOrg(t)
    // 30 groups at the item cap: a read change that holds the search word,
    // then 50 unread mentions in comments, so the search reads every message
    // of each group and unreadChange walks every unread one
    const tasks = await plantGroups(t, f.guest, 30, () => f.sub.id, {
      chunk: 10,
      sent: (i) => [
        {
          minute: 100 * i,
          read: true,
          actor: f.admin.id,
          body: 'Wired the zebra harness to the bench',
        },
        ...Array.from({ length: ITEM_UNREAD_CAP }, (_, j) => ({
          minute: 100 * i + 1 + j,
          kind: 'mention' as const,
          body: MENTION_DETAILS.comment,
          actor: f.admin.id,
        })),
      ],
    })
    const search = { search: 'zebra' }
    // what a page of one group reads, that group's own reads included
    INBOX_PAGE.rows = 1
    const one = await measured(t, f.guest, search)
    expect(one.answer.rows).toHaveLength(1)
    INBOX_PAGE.rows = DEFAULT_PAGE.rows
    for (const [figure, reads] of [
      ['documents', { ranges: 1e9, documents: 1000, bytes: 1e12 }],
      ['bytes', { ranges: 1e9, documents: 1e9, bytes: 512 * 1024 }],
    ] as const) {
      INBOX_PAGE.reads = { ...reads }
      const all = await measuredPages(t, f.guest, search)
      // each page ends within its ceiling and one group's reads past it
      for (const r of all) expect(r[figure], figure).toBeLessThan(reads[figure] + one[figure])
      expect(all.length, figure).toBeGreaterThan(2)
      for (const r of all.slice(0, -1)) {
        expect(r.page.stopped, figure).toBe(true)
        expect(r.page.rows.length, figure).toBeLessThan(INBOX_PAGE.rows)
      }
      expect(allIds(all.map((r) => r.page)), figure).toEqual(newestFirst(tasks))
      expect(all.flatMap((r) => r.page.rows).some((row) => row.unread_change)).toBe(false)
    }
    expect(await drift(t)).toEqual([])
  })

  it('says how far it checked by the last shown group, never a later hidden one', async () => {
    const t = newT()
    const f = await withOrg(t)
    const lost = await plantProject(t, { org_id: f.org.id })
    const hiddenTask = (minute: number) =>
      plantIssue(t, { org_id: f.org.id, project_id: lost.id }).then((task) =>
        deliver(t, f.guest, task, { minute }),
      )
    await hiddenTask(1)
    const [shown] = await plantGroups(t, f.guest, 1, () => f.sub.id, {
      sent: () => [{ minute: 2 }],
    })
    await hiddenTask(3)
    const newest = await pageOf(t, f.guest)
    expect(newest).toMatchObject({ rows: [{ issue_id: shown.id }], next: null, checked_to: at(2) })
    const oldest = await pageOf(t, f.guest, { order: 'oldest' })
    expect(oldest).toMatchObject({ rows: [{ issue_id: shown.id }], next: null, checked_to: at(2) })
    // a search that misses the shown group still names how far it looked
    expect(await pageOf(t, f.guest, { search: 'nothing here' })).toMatchObject({
      rows: [],
      checked_to: at(2),
    })
    // and none when the kind filter left out every group before any check
    expect(await pageOf(t, f.guest, { kinds: ['comment'] })).toMatchObject({
      rows: [],
      next: null,
      checked_to: null,
    })
    expect(await drift(t)).toEqual([])
  })
})

/* --------------------------------------------------------------- rows */

describe('the rows', () => {
  it('answer every field for unread, read, snoozed, woken and trimmed groups, with the item read’s unread fields and cutoff', async () => {
    const t = newT()
    const f = await withOrg(t)
    const guest = as(t, f.guest)
    const [unread, read, snoozed, woken, trimmed] = await plantGroups(
      t,
      f.guest,
      5,
      () => f.sub.id,
      {
        title: (i) => `Group ${i}`,
        sent: (i) =>
          [
            [
              { minute: 0, kind: 'comment' as const, actor: f.user.id },
              {
                minute: 1,
                kind: 'mention' as const,
                body: MENTION_DETAILS.description,
                actor: f.user.id,
              },
            ],
            [{ minute: 2, read: true, actor: f.admin.id }],
            [{ minute: 3, kind: 'comment' as const }],
            [{ minute: 4, kind: 'change' as const, body: 'Moved to an issue in another project' }],
            [{ minute: 5, kind: 'comment' as const }],
          ][i],
      },
    )
    const until = new Date(START + DAY).toISOString()
    for (const task of [snoozed, woken])
      await guest.mutation(api.messages.snoozeItem, { org_id: f.org.id, issue_id: task.id, until })
    await t.mutation(internal.messages.wake, {
      recipient_id: f.guest.id,
      issue_id: woken.id,
      until,
    })
    // past the item cap, through postMessage, which trims
    const trimTask = trimmed
    for (let i = 0; i < ITEM_UNREAD_CAP + 2; i++)
      await t.run(async (ctx) => {
        await postMessage(ctx, {
          org_id: f.org.id,
          recipient_id: f.guest.id,
          issue_id: trimTask.id,
          kind: 'comment',
          body: 'Comment notice',
          actor_id: f.admin.id,
          now: at(10 + i),
        })
      })
    const page = await pageOf(t, f.guest, { include_snoozed: true })
    const row = (id: string) => {
      const got = page.rows.find((r) => r.issue_id === id)
      if (got === undefined) throw new Error('no row')
      return got
    }
    const place = {
      project: { id: f.sub.id, num: f.sub.num, name: 'Firmware' },
      parent: { id: f.meta.id, num: f.meta.num, name: 'Testbed platform' },
    }
    expect(row(unread.id)).toMatchObject({
      org_id: f.org.id,
      num: unread.num,
      title: 'Group 0',
      ...place,
      sort_at: at(1),
      latest_at: at(1),
      woke_at: null,
      latest: {
        kind: 'mention',
        detail: MENTION_DETAILS.description,
        actor_id: f.user.id,
        actor_name: 'user',
      },
      unread_count: 2,
      dropped: 0,
      count: 2,
      kinds: ['mention', 'comment'],
      snoozed_until: null,
      first_unread_at: at(0),
      unread_change: true,
    })
    expect(row(read.id)).toMatchObject({
      latest: { kind: 'change', actor_name: 'admin' },
      unread_count: 0,
      count: 1,
      kinds: ['change'],
      first_unread_at: null,
      unread_change: false,
    })
    expect(row(snoozed.id)).toMatchObject({ snoozed_until: until, woke_at: null, sort_at: at(3) })
    expect(row(woken.id)).toMatchObject({
      snoozed_until: null,
      woke_at: new Date(START).toISOString(),
      sort_at: new Date(START).toISOString(),
      latest_at: at(4),
      latest: { actor_id: null, actor_name: null, detail: 'Moved to an issue in another project' },
      unread_change: true,
    })
    expect(row(trimmed.id)).toMatchObject({
      unread_count: ITEM_UNREAD_CAP,
      dropped: 3,
      count: ITEM_UNREAD_CAP,
      latest_at: at(10 + ITEM_UNREAD_CAP + 1),
    })
    // the unread fields and the cutoff are inbox.item's
    for (const r of page.rows) {
      const item = await guest.query(api.inbox.item, { org_id: f.org.id, issue_id: r.issue_id })
      if (item.state !== 'ok' || item.item === null) throw new Error('no item')
      expect(
        { through: r.through, first: r.first_unread_at, change: r.unread_change },
        r.title,
      ).toEqual({
        through: item.item.through,
        first: item.item.first_unread_at,
        change: item.item.unread_change,
      })
    }
    // readItem with the row's cutoff leaves a later message unread
    const cut = row(unread.id).through
    await deliver(t, f.guest, unread, { minute: 50 })
    await guest.mutation(api.messages.readItem, {
      org_id: f.org.id,
      issue_id: unread.id,
      through: cut,
    })
    expect((await pageOf(t, f.guest)).rows.find((r) => r.issue_id === unread.id)).toMatchObject({
      unread_count: 1,
      latest_at: at(50),
    })
    expect(await drift(t)).toEqual([])
  })
})

/* ------------------------------------------------ reads at the design size */

/** A reader of everyday reach (AGENTS.md, the design size): a member of the
 * fixture's organization in `teams` teams, each sharing 7 top-level
 * projects of 3 sub-projects, about 20 sub-projects a team, and a grant on
 * each of `more` further top-level projects of 3 sub-projects, the last of
 * them with `last`. Answers the reader and every sub-project it sees,
 * those of one parent in a row. */
async function everyday(t: T, f: OrgFixture, teams = 3, more = 0, last = 3) {
  const me = await reader(t, f, [], 'user')
  const subs = await t.run(async (ctx) => {
    const out: Doc<'projects'>[] = []
    let num = 1000
    const project = async (parent: Doc<'projects'> | null, name: string) => {
      const _id = await ctx.db.insert('projects', {
        id: uuid(),
        org_id: f.org.id,
        type: parent === null ? 'meta' : 'project',
        ...(parent === null ? {} : { parent_id: parent.id }),
        key: `E${num}`,
        name,
        description: '',
        sort_order: num,
        num: num++,
        track_delay: false,
        created_at: NOW,
        window_key: newWindowKey(),
      })
      return (await ctx.db.get(_id)) as Doc<'projects'>
    }
    const family = async (i: number, children = 3) => {
      const parent = await project(null, `Product line ${i}`)
      for (const name of ['Firmware', 'Hardware', 'Validation'].slice(0, children))
        out.push(await project(parent, `${name} ${i}`))
      return parent
    }
    for (let k = 0; k < teams; k++) {
      const team = uuid()
      await ctx.db.insert('teams', {
        id: team,
        org_id: f.org.id,
        name: `Team ${k}`,
        track_delay_default: false,
        created_at: NOW,
      })
      await ctx.db.insert('team_members', { team_id: team, profile_id: me.id, is_leader: false })
      for (let i = 0; i < 7; i++) {
        const parent = await family(k * 7 + i)
        await ctx.db.insert('project_team_access', {
          project_id: parent.id,
          team_id: team,
          level: 'user',
        })
      }
    }
    for (let i = 0; i < more; i++) {
      const parent = await family(1000 + i, i === more - 1 ? last : 3)
      await ctx.db.insert('project_access', {
        project_id: parent.id,
        profile_id: me.id,
        level: 'user',
      })
    }
    return out
  })
  return { me, subs }
}

/** How many live sub-projects of `me`'s organization `me` sees
 * (lib/access.ts accessOf), whatever gave it the access. */
const readable = (t: T, me: Doc<'profiles'>) =>
  t.run(async (ctx) => {
    const access = accessOf(ctx, me)
    let n = 0
    for (const p of await ctx.db.query('projects').collect())
      if (
        p.org_id === me.org_id &&
        p.parent_id !== undefined &&
        (await access.live(p.id)) &&
        (await access.visible(p.id))
      )
        n++
    return n
  })

/** `n` people of the fixture's organization, the actors of a case. */
async function actors(t: T, f: OrgFixture, n: number) {
  const out: Doc<'profiles'>[] = []
  for (let i = 0; i < n; i++)
    out.push(await plantSeat(t, { org_id: f.org.id, name: `Engineer ${i}`, accepted_at: NOW }))
  return out
}

/** A title of about 80 characters, ordinary text. */
const title = (i: number) =>
  `Calibrate the bench fixture for board revision ${i} before the thermal soak run`

/** Logs one measured call of a design size case and checks it stayed
 * inside Convex's limits for one call, as inboxReads.test.ts logs the
 * summary's reads, with every check of the reader's access finished
 * (OWN_READS.teamReads included) and every seat ready. */
function logged(
  label: string,
  r: { page: InboxPage; ranges: number; documents: number; bytes: number },
) {
  console.log(`${label}: ${figures(r)}`)
  expect(r.page.unchecked, label).toBe(false)
  expect(r.page.not_ready, label).toEqual([])
  expect(r.ranges, label).toBeLessThan(4096)
  expect(r.documents, label).toBeLessThan(32_000)
  expect(r.bytes, label).toBeLessThan(16 * 1024 * 1024)
  return r
}

/** The first page of `a` measured and logged. */
const first = async (t: T, who: Doc<'profiles'>, label: string, a: Partial<InboxPageArgs> = {}) => {
  const read = await measured(t, who, a)
  return logged(label, {
    page: read.answer,
    ranges: read.ranges,
    documents: read.documents,
    bytes: read.bytes,
  })
}

/** Every page of `a` measured, logged with the number of pages. */
async function every(t: T, who: Doc<'profiles'>, label: string, a: Partial<InboxPageArgs> = {}) {
  const all = await measuredPages(t, who, a)
  all.forEach((r, i) => {
    logged(`${label}, page ${i + 1} of ${all.length}`, r)
  })
  return all
}

describe('reads at the design size', () => {
  it('1. the everyday Inbox, 60 groups over 3 sub-projects, browsed and searched', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 10)
    await plantGroups(t, me, 60, (i) => subs[i % 3].id, {
      title,
      sent: (i) => [
        {
          minute: i,
          kind: (['change', 'comment', 'mention'] as const)[i % 3],
          body: ['Status changed from Todo to In progress', 'New comment', MENTION_DETAILS.comment][
            i % 3
          ],
          actor: people[i % 10].id,
        },
      ],
    })
    const browse = await first(t, me, 'everyday, browse')
    expect(browse.page.rows).toHaveLength(50)
    const missed = await every(t, me, 'everyday, a search that matches nothing', {
      search: 'oscilloscope',
    })
    expect(allIds(missed.map((r) => r.page))).toEqual([])
    expect(missed.at(-1)?.page.next).toBeNull()
  })

  it('2. one sub-project’s 300 open and 150 Done tasks, a group each, in each order, filtered and searched', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 50)
    // the open and Done-not-archived figures at their sum, as one page reads
    // both: every third group is of a Done task, and the 10 oldest groups of
    // open tasks are the only mentions
    const done = (i: number) => i % 3 === 2
    const mention = (i: number) => !done(i) && i < 15
    const tasks = await plantGroups(t, me, 450, () => subs[0].id, {
      title: (i) =>
        i === 0 ? 'Wire the zebra harness for the bench fixture of board revision zero' : title(i),
      task: (i) => (done(i) ? { status: 'done', done_at: NOW } : {}),
      sent: (i) => [
        {
          minute: i,
          kind: mention(i) ? ('mention' as const) : ('change' as const),
          body: mention(i)
            ? MENTION_DETAILS.comment
            : done(i)
              ? 'Status changed from In progress to Done'
              : 'Status changed from Todo to In progress',
          // any 50 groups in a row each by a different person
          actor: people[i % 50].id,
        },
      ],
    })
    const mentioned = tasks.filter((_, i) => mention(i))
    expect(mentioned).toHaveLength(10)
    const newest = await first(t, me, '450 in a sub-project, newest first')
    expect(new Set(newest.page.rows.map((r) => r.latest.actor_id)).size).toBe(50)
    await first(t, me, '450 in a sub-project, oldest first', { order: 'oldest' })
    await first(t, me, '450 in a sub-project, unread only', { unread_only: true })
    const mentions = await every(
      t,
      me,
      '450 in a sub-project, the 10 oldest of open tasks are the only mentions',
      {
        kinds: ['mention'],
      },
    )
    expect(allIds(mentions.map((r) => r.page))).toEqual(newestFirst(mentioned))
    const missed = await every(t, me, '450 in a sub-project, a search that matches nothing', {
      search: 'oscilloscope',
    })
    expect(allIds(missed.map((r) => r.page))).toEqual([])
    const oldest = await every(
      t,
      me,
      '450 in a sub-project, a search that matches the oldest group',
      {
        search: 'zebra',
      },
    )
    expect(allIds(oldest.map((r) => r.page))).toEqual([tasks[0].id])
  })

  it('3. one project’s 800 open and 200 Done tasks over 3 sub-projects, the same calls', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    const people = await actors(t, f, 50)
    // every fifth group is of a Done task, at their sum as in case 2
    const done = (i: number) => i % 5 === 4
    const mention = (i: number) => !done(i) && i < 12
    const tasks = await plantGroups(t, me, 1000, (i) => subs[i % 3].id, {
      title: (i) =>
        i === 0 ? 'Wire the zebra harness for the bench fixture of board revision zero' : title(i),
      task: (i) => (done(i) ? { status: 'done', done_at: NOW } : {}),
      sent: (i) => [
        {
          minute: i,
          kind: mention(i) ? ('mention' as const) : ('change' as const),
          body: mention(i)
            ? MENTION_DETAILS.comment
            : done(i)
              ? 'Status changed from In progress to Done'
              : 'Status changed from Todo to In progress',
          actor: people[i % 50].id,
        },
      ],
    })
    const mentioned = tasks.filter((_, i) => mention(i))
    expect(mentioned).toHaveLength(10)
    await first(t, me, '1,000 in a project, newest first')
    await first(t, me, '1,000 in a project, oldest first', { order: 'oldest' })
    await first(t, me, '1,000 in a project, unread only', { unread_only: true })
    const mentions = await every(
      t,
      me,
      '1,000 in a project, the 10 oldest of open tasks are the only mentions',
      {
        kinds: ['mention'],
      },
    )
    expect(allIds(mentions.map((r) => r.page))).toEqual(newestFirst(mentioned))
    const missed = await every(t, me, '1,000 in a project, a search that matches nothing', {
      search: 'oscilloscope',
    })
    expect(allIds(missed.map((r) => r.page))).toEqual([])
    console.log(`1,000 in a project: a search that matches nothing takes ${missed.length} pages`)
    const oldest = await every(
      t,
      me,
      '1,000 in a project, a search that matches the oldest group',
      {
        search: 'zebra',
      },
    )
    expect(allIds(oldest.map((r) => r.page))).toEqual([tasks[0].id])
  })

  it('4. one project’s 200 Done tasks not yet archived, a read group each, browsed', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    await plantGroups(t, me, 200, (i) => subs[i % 3].id, {
      title,
      task: () => ({ status: 'done', done_at: NOW }),
      sent: (i) => [{ minute: i, read: true, actor: f.admin.id }],
    })
    const browse = await first(t, me, '200 Done in a project, browse')
    expect(browse.page.rows).toHaveLength(50)
    const unread = await first(t, me, '200 Done in a project, unread only', { unread_only: true })
    expect(unread.page).toMatchObject({ rows: [], next: null })
  })

  it('6. a project of 800 groups the reader no longer sees, newer than every visible group', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    const visible = await plantGroups(t, me, 60, (i) => subs[i % 3].id, { title })
    // a top-level project of 3 sub-projects the reader does not see
    const parent = await plantProject(t, { org_id: f.org.id, name: 'Retired line' })
    const gone: Doc<'projects'>[] = []
    for (const name of ['Firmware', 'Hardware', 'Validation'])
      gone.push(
        await plantProject(t, { org_id: f.org.id, type: 'project', parent_id: parent.id, name }),
      )
    await plantGroups(t, me, 800, (i) => gone[i % 3].id, {
      title,
      sent: (i) => [{ minute: 1000 + i }],
    })
    const page = await first(t, me, '800 hidden groups newer than 60 visible ones, newest first')
    expect(ids(page.page.rows)).toEqual(newestFirst(visible).slice(0, 50))
  })

  it('7. a person in 5 teams with an everyday Inbox', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f, 5)
    await plantGroups(t, me, 60, (i) => subs[i % 3].id, { title })
    const browse = await first(t, me, 'in 5 teams, browse')
    expect(browse.page.rows).toHaveLength(50)
    await every(t, me, 'in 5 teams, a search that matches nothing', { search: 'oscilloscope' })
  })

  it('8. 50 groups at the item cap, 51 messages each, browsed and searched for each group’s oldest message', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    const at51 = (i: number, unread: (j: number) => Sent): Sent[] => [
      {
        minute: 100 * i,
        read: true,
        actor: f.admin.id,
        body: 'Wired the zebra harness to the bench',
      },
      ...Array.from({ length: ITEM_UNREAD_CAP }, (_, j) => unread(100 * i + 1 + j)),
    ]
    const tasks = await plantGroups(t, me, 50, () => subs[0].id, {
      title,
      chunk: 10,
      sent: (i) =>
        at51(i, (minute) => ({
          minute,
          kind: 'comment',
          body: 'New comment',
          actor: f.admin.id,
        })),
    })
    const browse = await first(t, me, '50 groups at the cap, browse')
    expect(browse.page.rows).toHaveLength(50)
    expect(browse.page.rows[0]).toMatchObject({
      unread_count: ITEM_UNREAD_CAP,
      count: ITEM_UNREAD_CAP + 1,
    })
    const found = await first(
      t,
      me,
      '50 groups at the cap, a search that matches only the oldest message',
      {
        search: 'zebra',
      },
    )
    expect(ids(found.page.rows)).toEqual(newestFirst(tasks))
    // every unread message a mention in a comment, which unreadChange walks
    const t2 = newT()
    const f2 = await withOrg(t2)
    const second = await everyday(t2, f2)
    await plantGroups(t2, second.me, 50, () => second.subs[0].id, {
      title,
      chunk: 10,
      sent: (i) => [
        {
          minute: 100 * i,
          read: true,
          actor: f2.admin.id,
          body: 'Status changed from Todo to Done',
        },
        ...Array.from({ length: ITEM_UNREAD_CAP }, (_, j) => ({
          minute: 100 * i + 1 + j,
          kind: 'mention' as const,
          body: MENTION_DETAILS.comment,
          actor: f2.admin.id,
        })),
      ],
    })
    const walked = await first(
      t2,
      second.me,
      '50 groups at the cap, every unread message a mention in a comment',
    )
    expect(walked.page.rows.every((r) => !r.unread_change)).toBe(true)
  })

  it('reads one task for each group of an archived task it passes, so pages over them can be counted', async () => {
    const t = newT()
    const f = await withOrg(t)
    const { me, subs } = await everyday(t, f)
    const shown = await plantGroups(t, me, 60, (i) => subs[i % 3].id, { title })
    const base = await first(t, me, 'oldest first, 60 visible groups', { order: 'oldest' })
    // 300 read groups of archived tasks, older than every visible group, which
    // oldest first meets first
    const archived = await plantGroups(t, me, 300, () => subs[0].id, {
      title,
      sent: (i) => [{ minute: -1000 + i, read: true }],
    })
    await archiveRaw(t, archived)
    const past = await first(
      t,
      me,
      'oldest first, 300 archived-task groups before 60 visible ones',
      {
        order: 'oldest',
      },
    )
    expect(ids(past.page.rows)).toEqual(shown.slice(0, 50).map((x) => x.id))
    const perItem = (past.ranges - base.ranges) / 300
    console.log(
      `an archived-task group costs about ${perItem.toFixed(2)} ranges and ` +
        `${((past.documents - base.documents) / 300).toFixed(2)} documents; at NAMED_READ a page passes about ` +
        `${Math.floor(DEFAULT_PAGE.reads.ranges / perItem)} of them`,
    )
  })
})

/* Case 5 of the reads at the design size, the 200 sub-projects one person
 * can read with 30 groups each. It plants its 6,000 groups in under a
 * second (plantRaw) but takes 68 to 102 s on a large Boat sandbox, nearly
 * all of it the 12 pages of the search that matches nothing, each about
 * 2,000 index ranges, which convex-test serves by scanning every stored
 * document. So it runs on demand with QIVO_INBOX_PERSON_READS=1, outside
 * the normal suite (AGENTS.md), with a timeout of its own above vitest's
 * 60 s, an exception to the test rule. Its figures are in
 * model/inboxPage.ts INBOX_PAGE. */
describe.runIf(process.env.QIVO_INBOX_PERSON_READS === '1')(
  'reads at the design size, on demand',
  () => {
    it('5. the 200 sub-projects one person can read, 30 groups each', async () => {
      const t = newT()
      const f = await withOrg(t)
      // 63 sub-projects through the person's 3 teams and 137 through grants
      // on 46 more, the last of them with 2, so exactly 200 in all
      const { me, subs } = await everyday(t, f, 3, 46, 2)
      expect(subs).toHaveLength(200)
      expect(await readable(t, me)).toBe(200)
      await plantRaw(t, me, 6000, (i) => subs[i % 200].id, {
        title,
        sent: (i) => ({
          minute: i,
          kind: i < 60 ? ('mention' as const) : ('change' as const),
          body: i < 60 ? MENTION_DETAILS.comment : 'Status changed from Todo to In progress',
          actor: f.admin.id,
        }),
      })
      const browse = await first(t, me, '6,000 over 200 sub-projects, browse')
      expect(browse.page.rows).toHaveLength(50)
      const mentions = await every(
        t,
        me,
        '6,000 over 200 sub-projects, the 60 oldest are the only mentions',
        {
          kinds: ['mention'],
        },
      )
      expect(allIds(mentions.map((r) => r.page))).toHaveLength(60)
      const missed = await every(
        t,
        me,
        '6,000 over 200 sub-projects, a search that matches nothing',
        {
          search: 'oscilloscope',
        },
      )
      expect(allIds(missed.map((r) => r.page))).toEqual([])
      console.log(
        `6,000 over 200 sub-projects: a search that matches nothing takes ${missed.length} pages`,
      )
    }, 180_000)
  },
)
