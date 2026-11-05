import { afterEach, describe, expect, it, vi } from 'vitest'
import { idWindows, startWindows } from '../../convex/lib/idWindows'

/* The browser benchmark's stand-in server (scripts/perf/server.mjs), loaded
   as its worker would be, with the page's parameters as the worker's name. */

/* The id of the stand-in workspace's first task, and its id maker
   (server.mjs id). */
let TASK_1 = ''
let id = (_kind, _n) => ''

/** Loads the server for page parameters `params` and answers what it posts
    and a way to send it a message. */
async function server(params) {
  vi.resetModules()
  const posted = []
  vi.stubGlobal('self', { name: params, postMessage: (message) => posted.push(message) })
  ;({ id } = await import('./server.mjs'))
  TASK_1 = id('4', 1)
  const send = (data) => self.onmessage({ data })
  return { posted, send }
}

/** The snapshot the server answers a query with. */
async function snapshotOf(params) {
  const { posted, send } = await server(`latency=0&mbps=100000&${params}`)
  await send({ type: 'query', id: 'q', name: 'snapshot:forMe', args: {} })
  const result = posted.find((message) => message.type === 'result')
  return { snapshot: JSON.parse(result.text), bytes: result.bytes, text: result.text }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the benchmark server', () => {
  it('makes as many links, attachments and follows as each share asks', async () => {
    const dense = await snapshotOf('tasks=100&links=1&attachments=0.5&follows=0.5')
    expect(dense.snapshot.links.length).toBeGreaterThan(90)
    expect(dense.snapshot.attachments).toHaveLength(50)
    expect(dense.snapshot.issueSubs).toHaveLength(50)
    const usual = await snapshotOf('tasks=100')
    expect(usual.snapshot.attachments).toHaveLength(10)
    // shares that are no reciprocal of a whole number
    const odd = await snapshotOf('tasks=100&attachments=0.4&follows=0.7')
    expect(odd.snapshot.attachments).toHaveLength(40)
    expect(odd.snapshot.issueSubs).toHaveLength(70)
  })

  it('puts each label on a task once, whatever orglabels gives', async () => {
    // a stride of 5 over 1 or 5 labels meets the same label again
    for (const orglabels of [1, 5]) {
      const { snapshot } = await snapshotOf(`tasks=100&orglabels=${orglabels}`)
      const pairs = snapshot.issueLabels.map((row) => `${row.issue_id} ${row.label_id}`)
      expect(new Set(pairs).size, `orglabels=${orglabels}`).toBe(pairs.length)
      expect(pairs, `orglabels=${orglabels}`).toHaveLength(snapshot.issues.length)
    }
    // the default gives every task its two labels
    const usual = await snapshotOf('tasks=100')
    expect(usual.snapshot.issueLabels).toHaveLength(2 * usual.snapshot.issues.length)
  })

  it('counts the UTF-8 bytes it sends', async () => {
    const { bytes, text } = await snapshotOf('tasks=20')
    // the workspace holds names past ASCII, so the two counts differ
    expect(text.length).toBeLessThan(Buffer.byteLength(text))
    expect(bytes).toBe(Buffer.byteLength(text))
    const { utf8 } = await import('./server.mjs')
    for (const sample of ['Ship 🚀', 'åäö', '日本', 'plain'])
      expect(utf8(sample), sample).toBe(Buffer.byteLength(sample))
  })

  it('answers a write that changes nothing only after the results before it', async () => {
    // 1 Mbps, so a result takes long enough to be on its way
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    // another person's rename, whose result is on its way when the write
    // comes, and a write of the status task 1 has already
    void send({ type: 'scenario', id: 'rename', name: 'deliverRemote', args: [0] })
    await send({
      type: 'mutation',
      id: 'write',
      name: 'issues:update',
      args: { id: TASK_1, patch: { status: 'todo' } },
    })
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order.slice(0, 2)).toEqual(['result', 'write'])
  }, 60_000)

  it('answers writes in the order they came', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    const task = TASK_1
    // a write that changes the task, then one that changes nothing
    const changing = send({
      type: 'mutation',
      id: 'changing',
      name: 'issues:update',
      args: { id: task, patch: { title: 'Renamed' } },
    })
    const same = send({
      type: 'mutation',
      id: 'same',
      name: 'issues:update',
      args: { id: task, patch: { status: 'todo' } },
    })
    await Promise.all([changing, same])
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order).toEqual(['result', 'changing', 'same'])
  }, 60_000)

  it('fails a read it cannot answer and goes on with the rest', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    await send({ type: 'query', id: 'unknown', name: 'files:nothing', args: {} })
    await send({ type: 'query', id: 'known', name: 'snapshot:forMe', args: {} })
    const unknown = posted.find((m) => m.to === 'unknown')
    expect(unknown.error).toContain('Unimplemented benchmark query')
    expect(posted.find((m) => m.to === 'known').text).toBeTruthy()
  })

  it('answers main Search a page at a time, tasks before projects, by the server word rules', async () => {
    const { posted, send } = await server('tasks=40&latency=0&mbps=100000')
    const page = async (id, args) => {
      await send({ type: 'query', id, name: 'search:page', args })
      const answer = posted.find((m) => m.to === id)
      if (answer.error) throw new Error(answer.error)
      return JSON.parse(answer.text)
    }
    // every visible title holds "signed" and a word that starts with "firm"
    const first = await page('first', { text: 'signed firm', include_archived: false })
    expect(first.rows).toHaveLength(25)
    expect(first.coverage).toEqual({ complete: true })
    expect(first.rows.every((row) => row.kind === 'task')).toBe(true)
    // a phrase in order ranks first, then the newest number
    expect(first.rows[0].title).toMatch(/signed firmware/)
    const second = await page('second', {
      text: 'signed firm',
      include_archived: false,
      cursor: first.next_cursor,
    })
    expect(second.rows).toHaveLength(15)
    expect(second.next_cursor).toBeNull()
    const ids = [...first.rows, ...second.rows].map((row) => row.id)
    expect(new Set(ids).size).toBe(40)
    // only the last word may be the start of a longer one, and a project's
    // name finds the project, not its tasks
    expect((await page('order', { text: 'firm signed', include_archived: false })).rows).toEqual([])
    const projects = await page('projects', { text: 'testbed project', include_archived: false })
    expect(projects.rows.map((row) => row.kind)).toEqual(Array(10).fill('project'))
    expect(projects.rows[0].parent?.name).toBe('Testbed program')
    // a cursor of another search is refused
    await expect(
      page('other', { text: 'firmware', include_archived: false, cursor: first.next_cursor }),
    ).rejects.toThrow('cursor must be the next_cursor of an earlier page')
  })

  it("answers the Board's query for the selection the app opens, under and over the ceiling", async () => {
    /** What tasks:board answers for the first program, or `scope`, on a
        workspace with page parameters `params`. */
    const board = async (params, scope = null, filters = {}) => {
      const { posted, send } = await server(`latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      const program = snap.projects.find((p) => p.type === 'meta')
      const args = {
        scope: scope ?? { kind: 'project', org_id: snap.orgs[0].id, project_id: program.id },
        filters: {
          mine: false,
          owners: [],
          priority: null,
          stale_before: null,
          focus: false,
          search: '',
          ...filters,
        },
      }
      await send({ type: 'query', id: 'board', name: 'tasks:board', args })
      const answer = posted.find((m) => m.to === 'board')
      if (answer.error) throw new Error(answer.error)
      return { answer: JSON.parse(answer.text), posted: answer, snap, program }
    }
    // 1,000 tasks, a parent in each block of ten: 900 cards
    const ok = await board('tasks=1000')
    expect(ok.answer.state).toBe('ok')
    expect(ok.answer.rows.filter((row) => !row.has_subtasks)).toHaveLength(900)
    expect(ok.posted.boardCards).toBe(900)
    expect(ok.answer.projects).toHaveLength(10)
    expect(ok.answer.rows.every((row) => row.description === undefined)).toBe(true)
    // 10,000 tasks over one program pass the ceiling…
    expect((await board('tasks=10000')).answer).toMatchObject({
      state: 'over_ceiling',
      ceiling: 1000,
    })
    // …and over ten programs the first holds a tenth of them
    const spread = await board('tasks=10000&programs=10')
    expect(spread.answer.state).toBe('ok')
    expect(spread.answer.rows.filter((row) => !row.has_subtasks)).toHaveLength(900)
    expect(spread.posted.boardCards).toBe(900)
    expect(spread.posted.cards).toBe(9000)
    expect(spread.snap.projects.filter((p) => p.type === 'meta')).toHaveLength(10)
    // many programs of many sub-projects, each with its own id and a key
    // the schema takes
    const wide = await board('tasks=100&programs=12&subprojects=200')
    const ids = wide.snap.projects.map((p) => p.id)
    const keys = wide.snap.projects.map((p) => p.key)
    expect(ids).toHaveLength(12 * 201)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((key) => /^[A-Z0-9]{1,5}$/.test(key))).toBe(true)
    // fewer sub-projects to a program
    const three = await board('tasks=3000&programs=3&subprojects=3')
    expect(three.answer.projects).toHaveLength(3)
    // the first program takes three of the nine sub-projects' blocks of ten
    expect(three.posted.boardCards).toBe(
      three.answer.rows.filter((row) => !row.has_subtasks).length,
    )
    expect(three.posted.boardCards).toBe(918)
    // a filter, the person's own tasks and a forced state
    const urgent = await board('tasks=1000', null, { priority: 'urgent', search: '  signed ' })
    expect(urgent.answer.rows.every((row) => row.priority === 'urgent')).toBe(true)
    expect(urgent.answer.rows.length).toBeGreaterThan(0)
    const mine = await board('tasks=1000', { kind: 'mine' })
    expect(mine.answer.state).toBe('ok')
    expect(mine.answer.rows.length).toBeGreaterThan(0)
    expect(mine.answer).not.toHaveProperty('projects')
    expect((await board('tasks=100&board=over_budget')).answer.state).toBe('over_budget')
  }, 60_000)

  it("answers the task window's comment page and, apart, its history page", async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    const args = { issue_id: TASK_1 }
    await send({ type: 'query', id: 'comments', name: 'snapshot:threadComments', args })
    await send({ type: 'query', id: 'history', name: 'snapshot:threadHistory', args })
    const answer = (id) => JSON.parse(posted.find((m) => m.to === id).text)
    expect(Object.keys(answer('comments')).sort()).toEqual(['comments', 'earlier'])
    expect(answer('history')).toEqual({ events: [], earlier: false, next: null })
  })

  it("answers the task window's own lists from the workspace, each whole", async () => {
    const { posted, send } = await server(
      'tasks=40&latency=0&mbps=100000&links=1&attachments=1&subtasks=0.2',
    )
    // task 6 of each block of ten is a parent; task 6 links to task 9
    const parent = id('4', 5)
    await send({ type: 'query', id: 'task', name: 'taskWindow:task', args: { ref: parent } })
    await send({ type: 'query', id: 'links', name: 'taskWindow:links', args: { issue_id: parent } })
    await send({
      type: 'query',
      id: 'files',
      name: 'taskWindow:attachments',
      args: { issue_id: parent },
    })
    await send({ type: 'query', id: 'none', name: 'taskWindow:task', args: { ref: 'unknown' } })
    const answer = (to) => JSON.parse(posted.find((m) => m.to === to).text)
    const task = answer('task')
    expect(task).toMatchObject({ state: 'ok', level: 'user', subtasks: { complete: true } })
    expect(task.task).toMatchObject({ id: parent, has_subtasks: true })
    expect(task.subtasks.rows.map((row) => row.num)).toEqual([7, 8])
    for (const row of task.subtasks.rows) {
      expect(row).toMatchObject({ has_subtasks: false, level: 'user' })
      expect(row).not.toHaveProperty('parent_id')
      expect(row).not.toHaveProperty('description')
    }
    const links = answer('links')
    expect(links).toMatchObject({ state: 'ok', complete: true })
    expect(links.links.length).toBeGreaterThan(0)
    expect(links.tasks.map((row) => row.id).sort()).toEqual(
      [
        ...new Set(
          links.links.map((link) => (link.source_id === parent ? link.target_id : link.source_id)),
        ),
      ].sort(),
    )
    const files = answer('files')
    expect(files).toMatchObject({ state: 'ok', complete: true, count: files.rows.length })
    expect(files.rows.every((row) => row.issue_id === parent)).toBe(true)
    expect(answer('none')).toEqual({ state: 'unavailable' })
  })

  it('answers the appearance mode the page asks for, dark unless it asks for light', async () => {
    const modeOf = async (params) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000${params}`)
      await send({ type: 'query', id: 'appearance', name: 'appearance:get', args: {} })
      return JSON.parse(posted.find((m) => m.to === 'appearance').text).mode
    }
    expect(await modeOf('&appearance=light')).toBe('light')
    expect(await modeOf('')).toBe('dark')
    expect(await modeOf('&appearance=sepia')).toBe('dark')
  })

  it('signs the person in as an organization Viewer or admin only when the page asks for one', async () => {
    const roleOf = async (params) => {
      const { snapshot } = await snapshotOf(`tasks=20${params}`)
      return snapshot.profiles.find((p) => p.id === snapshot.myProfileIds[0]).org_role
    }
    expect(await roleOf('&role=viewer')).toBe('viewer')
    expect(await roleOf('&role=admin')).toBe('admin')
    expect(await roleOf('')).toBe('user')
    expect(await roleOf('&role=owner')).toBe('user')
  })

  it("answers Settings › Labels' batches for an admin, with the labels and states the page asks for", async () => {
    /** What labels:settingsPage answers with `args` on a workspace with
        page parameters `params`, read by an admin unless they say. */
    const page = async (params, args = {}) => {
      const { posted, send } = await server(`tasks=100&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({
        type: 'query',
        id: 'labels',
        name: 'labels:settingsPage',
        args: { org_id: snap.orgs[0].id, ...args },
      })
      const answer = posted.find((m) => m.to === 'labels')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    const plain = await page('role=admin')
    expect(plain.snap.labels).toHaveLength(12)
    expect(plain.answer.rows.map((row) => row.name)).toEqual(
      Array.from({ length: 12 }, (_, n) => `Label ${String.fromCharCode(65 + n)}`),
    )
    expect(plain.answer).toMatchObject({ next: null, stopped: false, counting: false })
    // the tasks' labels spread over every label, each counted
    expect(plain.answer.rows.every((row) => row.active_tasks > 0)).toBe(true)
    const sixty = await page('role=admin&orglabels=60')
    expect(new Set(sixty.snap.labels.map((l) => l.name)).size).toBe(60)
    expect(sixty.snap.labels.map((l) => l.name)).toContain('Field test 01')
    expect(sixty.answer.rows).toHaveLength(25)
    expect(sixty.answer.next).not.toBeNull()
    // the forced states
    const counting = await page('role=admin&labelpage=counting')
    expect(counting.answer.counting).toBe(true)
    expect(counting.answer.rows.every((row) => row.active_tasks === null)).toBe(true)
    const uncounted = await page('role=admin&labelpage=uncounted')
    expect(uncounted.answer.counting).toBe(false)
    expect(uncounted.answer.rows.filter((row) => row.active_tasks === null)).toHaveLength(4)
    const stopped = await page('role=admin&orglabels=60&labelpage=stopped')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(10)
    const small = await page('role=admin&orglabels=60&labelpage=small,counting')
    expect(small.answer.rows).toHaveLength(5)
    expect(small.answer.counting).toBe(true)
    expect((await page('role=admin&labelpage=error')).answer.error).toContain('fails')
    // only an admin reads the list
    expect((await page('')).answer.error).toContain('only organization admins')
  }, 60_000)

  it("answers the removal window's reads from the workspace, with the states the page asks for", async () => {
    /** What `name` answers with `args(snap)` on a workspace with page
        parameters `params`. */
    const ask = async (params, name, args) => {
      const { posted, send } = await server(`tasks=100&people=60&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({
        type: 'query',
        id: 'read',
        name,
        args: { org_id: snap.orgs[0].id, ...args(snap) },
      })
      const answer = posted.find((m) => m.to === 'read')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    // the third person of the first team leaves it
    const leaving = (snap) => ({
      change: { kind: 'team_member', team_id: snap.teams[0].id, user_id: snap.profiles[2].id },
    })
    const plain = await ask('removal=open', 'accessRemovals:preview', leaving)
    expect(plain.snap.teamAccess).toHaveLength(1)
    expect(plain.answer).toMatchObject({ state: 'ok', pending: true, leave_only: false })
    expect(plain.answer.people.map((p) => p.id)).toEqual([plain.snap.profiles[2].id])
    expect(plain.answer.tasks).toBeGreaterThan(0)
    expect(plain.answer.items.every((i) => i.holder_id === plain.snap.profiles[2].id)).toBe(true)
    expect(plain.answer.reassign).toEqual({ allowed: true, refusal: null, permitted: true })
    // without the parameter no team shares a program, as the benchmark measures
    expect((await ask('', 'accessRemovals:preview', leaving)).snap.teamAccess).toEqual([])
    // the forced states
    const many = await ask('removal=many', 'accessRemovals:preview', leaving)
    expect(many.answer.tasks - new Set(many.answer.items.map((i) => i.task_id)).size).toBe(40)
    expect(many.answer.reassign.allowed).toBe(false)
    const capped = await ask('removal=capped', 'accessRemovals:preview', leaving)
    expect(capped.answer.keep.allowed || capped.answer.reassign.allowed).toBe(false)
    const unsettled = await ask('removal=unsettled', 'accessRemovals:preview', leaving)
    expect(unsettled.answer.reassign.permitted).toBe(false)
    expect((await ask('removal=too_large', 'accessRemovals:preview', leaving)).answer.state).toBe(
      'too_large',
    )
    // the picker: everyone who can hold work but the person leaving, 25 a batch
    const first = await ask('removal=open', 'accessRemovals:reassignChoices', leaving)
    expect(first.answer.rows).toHaveLength(25)
    expect(first.answer.rows.map((r) => r.id)).not.toContain(first.snap.profiles[2].id)
    expect(first.answer).toMatchObject({ state: 'ready', next: '25', stopped: false })
    const last = await ask('removal=open', 'accessRemovals:reassignChoices', (snap) => ({
      ...leaving(snap),
      after: '50',
    }))
    expect(last.answer.rows).toHaveLength(9)
    expect(last.answer.next).toBeNull()
    const zoe = await ask('removal=open', 'accessRemovals:reassignChoices', (snap) => ({
      ...leaving(snap),
      search: 'zoe 4',
    }))
    expect(zoe.answer.rows.map((r) => r.name)).toEqual([
      'Zoë 24',
      'Zoë 4',
      'Zoë 40',
      'Zoë 44',
      'Zoë 48',
    ])
    const stopped = await ask('removal=choices-stopped', 'accessRemovals:reassignChoices', leaving)
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(13)
    expect(
      (await ask('removal=choices-not-ready', 'accessRemovals:reassignChoices', leaving)).answer,
    ).toEqual({ state: 'not_ready' })
    expect(
      (await ask('removal=choices-error', 'accessRemovals:reassignChoices', leaving)).answer.error,
    ).toContain('fails')
  }, 60_000)

  it('answers a scenario that fails with its failure', async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    // no comment thread is open
    await send({ type: 'scenario', id: 'comments', name: 'deliverComments', args: [] })
    expect(posted.find((m) => m.id === 'comments').failure).toContain('one open comment thread')
  })

  it("answers a write once its own results are in, not a later write's", async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=1')
    await send({ type: 'subscribe', id: 's', name: 'snapshot:forMe', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'result')).toBe(true), 30_000)
    posted.length = 0
    const task = TASK_1
    const first = send({
      type: 'mutation',
      id: 'first',
      name: 'issues:update',
      args: { id: task, patch: { title: 'First' } },
    })
    // the second write comes while the first one's result is on its way
    const second = send({
      type: 'mutation',
      id: 'second',
      name: 'issues:update',
      args: { id: task, patch: { title: 'Second' } },
    })
    await Promise.all([first, second])
    const order = posted.filter((m) => m.type !== 'state').map((m) => m.id ?? m.type)
    expect(order).toEqual(['result', 'first', 'result', 'second'])
  }, 60_000)

  it('leaves the unheld tasks out of the workspace, and answers them in Search and in the task window', async () => {
    // forMe, which a baseline build reads, leaves them out too; each server
    // this file loads takes the worker's place, so this one goes first
    const { snapshot } = await snapshotOf('tasks=40&unheld=3')
    expect(snapshot.issues).toHaveLength(37)
    const { posted, send } = await server('tasks=40&latency=0&mbps=100000&unheld=3')
    await send({ type: 'query', id: 'root', name: 'workspace:root', args: {} })
    const [org] = JSON.parse(posted.find((m) => m.to === 'root').text).orgs
    const windows = idWindows(startWindows(org).tasks)
    for (const [i, w] of windows.entries())
      send({ type: 'watch', id: `w${i}`, name: 'workspace:tasks', args: { org_id: org.id, ...w } })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'transition')).toBe(true))
    const parts = posted
      .filter((m) => m.type === 'transition')
      .flatMap((m) => m.results.map((r) => JSON.parse(r.text)))
    const held = new Set(parts.flatMap((part) => part.issues.map((row) => row.id)))
    // every task is visible here; the three highest-numbered loose ones are
    // not held, nor any row hung on them, nor a parent link to them
    expect(held.size).toBe(37)
    const missing = [...Array(40).keys()].map((n) => id('4', n)).filter((uuid) => !held.has(uuid))
    expect(missing).toHaveLength(3)
    for (const part of parts) {
      for (const row of part.issueLabels ?? []) expect(missing).not.toContain(row.issue_id)
      for (const row of part.issues) expect(missing).not.toContain(row.parent_id)
    }
    // the window's read answers one of them, and a write changes it and sends
    // its read again
    await send({ type: 'watch', id: 'window', name: 'taskWindow:task', args: { ref: missing[0] } })
    await vi.waitFor(() =>
      expect(
        posted.some((m) => m.type === 'transition' && m.results.some((r) => r.to === 'window')),
      ).toBe(true),
    )
    const answers = () =>
      posted
        .filter((m) => m.type === 'transition')
        .flatMap((m) => m.results.filter((r) => r.to === 'window'))
        .map((r) => JSON.parse(r.text))
    expect(answers().at(-1)).toMatchObject({ state: 'ok', task: { id: missing[0] } })
    await send({
      type: 'mutation',
      id: 'label',
      name: 'labels:toggle',
      args: { issue_id: missing[0], label_id: id('8', 0), on: true },
    })
    await send({
      type: 'mutation',
      id: 'follow',
      name: 'issues:subscribe',
      args: { issue_id: missing[0] },
    })
    await vi.waitFor(() => expect(answers().at(-1)?.follow).not.toBeNull())
    expect(
      answers()
        .at(-1)
        .labels.map((row) => row.label_id),
    ).toContain(id('8', 0))
    await send({
      type: 'mutation',
      id: 'unfollow',
      name: 'issues:unsubscribe',
      args: { issue_id: missing[0] },
    })
    await vi.waitFor(() => expect(answers().at(-1)?.follow).toBeNull())
    // Search still finds it
    await send({
      type: 'query',
      id: 'search',
      name: 'search:page',
      args: { text: answers().at(-1).task.title, include_archived: false },
    })
    const found = JSON.parse(posted.find((m) => m.to === 'search').text).rows
    expect(found.map((row) => row.id)).toContain(missing[0])
  })

  it("fails the task window's read after its first answer, or answers its subtask list cut short, as the page asks", async () => {
    const parent = () => id('4', 5)
    const failing = await server('tasks=40&latency=0&mbps=100000&subtasks=0.2&window=failed')
    await failing.send({ type: 'watch', id: 'w', name: 'taskWindow:task', args: { ref: parent() } })
    const results = () =>
      failing.posted
        .filter((m) => m.type === 'transition')
        .flatMap((m) => m.results.filter((r) => r.to === 'w'))
    await vi.waitFor(() => expect(results().length).toBeGreaterThan(0))
    expect(JSON.parse(results()[0].text)).toMatchObject({ state: 'ok' })
    await vi.waitFor(() => expect(results().some((r) => r.error)).toBe(true), 5000)
    expect(results().find((r) => r.error)?.error).toContain('window=failed')
    const cut = await server('tasks=40&latency=0&mbps=100000&subtasks=0.2&window=incomplete')
    await cut.send({ type: 'query', id: 'task', name: 'taskWindow:task', args: { ref: parent() } })
    const answer = JSON.parse(cut.posted.find((m) => m.to === 'task').text)
    expect(answer.subtasks.complete).toBe(false)
    expect(answer.task).toMatchObject({ has_subtasks: true, has_hidden_subtasks: true })
    expect(answer.subtasks.rows.length).toBeLessThan(2)
  })

  it('serves the workspace in parts and re-sends only the window a remote rename changed, in one transition', async () => {
    const { posted, send } = await server('tasks=500&latency=0&mbps=100000')
    await send({ type: 'query', id: 'root', name: 'workspace:root', args: {} })
    const [org] = JSON.parse(posted.find((m) => m.to === 'root').text).orgs
    const windows = idWindows(startWindows(org).tasks)
    expect(windows.length).toBeGreaterThan(2)
    for (const [i, w] of windows.entries())
      send({ type: 'watch', id: `w${i}`, name: 'workspace:tasks', args: { org_id: org.id, ...w } })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'transition')).toBe(true))
    const first = posted.filter((m) => m.type === 'transition')
    expect(first).toHaveLength(1)
    expect(first[0].results).toHaveLength(windows.length)
    const issues = first[0].results.flatMap((r) => JSON.parse(r.text).issues)
    expect(issues.length).toBeGreaterThan(400)
    expect(issues).toHaveLength(new Set(issues.map((i) => i.id)).size)
    posted.length = 0
    await send({ type: 'scenario', id: 'rename', name: 'deliverRemote', args: [250] })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'transition')).toBe(true))
    const [change] = posted.filter((m) => m.type === 'transition')
    expect(change.results).toHaveLength(1)
  })
})
