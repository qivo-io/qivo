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
