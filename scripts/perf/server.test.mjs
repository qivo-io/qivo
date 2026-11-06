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

  it('makes the share of Done tasks and the title length the page asks for', async () => {
    // the visible tasks' ids (server.mjs id), not the hidden projects'
    const visible = (snapshot) => snapshot.issues.filter((row) => row.id.includes('-0004-'))
    const share = (rows) => rows.filter((row) => row.status === 'done').length / rows.length
    // by default about a sixth of the tasks are Done, with titles of about 40
    const usual = visible((await snapshotOf('tasks=600&hidden=0')).snapshot)
    expect(share(usual)).toBeGreaterThan(0.1)
    expect(share(usual)).toBeLessThan(0.25)
    expect(usual.every((row) => row.title.length < 60)).toBe(true)
    // a third Done, spread over the numbers, and titles of 91 characters
    const asked = visible((await snapshotOf('tasks=600&hidden=0&done=0.33&titles=91')).snapshot)
    expect(share(asked)).toBeCloseTo(0.33, 1)
    expect(share(asked.slice(0, 60))).toBeGreaterThan(0.2)
    expect(share(asked.slice(0, 60))).toBeLessThan(0.45)
    for (const row of asked) expect(row.title.length).toBeGreaterThanOrEqual(88)
    for (const row of asked) expect(row.title.length).toBeLessThanOrEqual(91)
    // none Done, and every open status still there
    const open = visible((await snapshotOf('tasks=60&hidden=0&done=0')).snapshot)
    expect(share(open)).toBe(0)
    expect(new Set(open.map((row) => row.status))).toEqual(new Set(['todo', 'progress', 'review']))
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

  it("answers Team sync's agenda from its stand-in, with the states the page asks for", async () => {
    /** What teamSync:agenda answers for the first program on a workspace
        with page parameters `params`, and ways to read it again and to send
        the server a write. */
    const agenda = async (params) => {
      const { posted, send } = await server(`latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      const program = snap.projects.find((p) => p.type === 'meta')
      // a Monday-start week of the clock as the app sends it
      const week = '2026-11-02'
      const start = Date.parse('2026-11-02T00:00:00.000Z')
      const args = {
        org_id: snap.orgs[0].id,
        scope: { kind: 'project', project_id: program.id },
        day: '2026-11-04',
        week,
        week_starts: Array.from({ length: 53 }, (_, i) => start - (52 - i) * 7 * 86_400_000),
        week_end: start + 7 * 86_400_000,
      }
      const read = async (at) => {
        await send({ type: 'query', id: at, name: 'teamSync:agenda', args })
        const answer = posted.find((m) => m.to === at)
        return answer.error ? { error: answer.error } : JSON.parse(answer.text)
      }
      return { answer: await read('agenda'), read, send, org: args.org_id }
    }
    const ok = await agenda('tasks=200')
    expect(ok.answer.state).toBe('ok')
    expect(ok.answer.rows.length).toBeGreaterThan(0)
    expect(ok.answer.people.length).toBeGreaterThan(0)
    expect(ok.answer.hidden).toBe('counted')
    expect(ok.answer.people.every((p) => p.week.state === 'ok')).toBe(true)
    // a card's change stamps the page owner, whom the next answer carries so
    const person = ok.answer.people.find((p) => p.stamp === null)
    await ok.send({
      type: 'mutation',
      id: 'stamp',
      name: 'teamSync:stamp',
      args: { org_id: ok.org, profile_id: person.id },
    })
    const stamped = (await ok.read('stamped')).people.find((p) => p.id === person.id)
    expect(stamped.stamp?.at).toEqual(expect.any(String))
    for (const state of ['over_ceiling', 'over_budget', 'unavailable'])
      expect((await agenda(`tasks=200&sync=${state}`)).answer.state).toBe(state)
    expect((await agenda('tasks=200&sync=access_unchecked')).answer).toMatchObject({
      state: 'unavailable',
      reason: 'access_unchecked',
    })
    const weeks = await agenda('tasks=200&sync=weeks-unknown')
    expect(weeks.answer.people.every((p) => p.week.state === 'unavailable')).toBe(true)
    const viewer = await agenda('tasks=200&sync=viewer')
    expect(viewer.answer.hidden).toBe('own_only')
    expect((await agenda('tasks=200&sync=error')).answer.error).toContain('sync=error')
    // the agenda's own ceiling rules at a lowered ceiling, never seeded past
    // the design size. The meeting fits a ceiling of all its tasks, and its
    // rows and asks alone pass one below theirs
    const fixed = ok.answer.rows.length + ok.answer.asks.length
    const all = fixed + ok.answer.done.length
    expect((await agenda(`tasks=200&sync=ceiling:${all}`)).answer.state).toBe('ok')
    expect((await agenda(`tasks=200&sync=ceiling:${fixed - 1}`)).answer).toEqual({
      state: 'over_ceiling',
      ceiling: fixed - 1,
    })
    // a meeting that stops fitting while it is open
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const stale = await agenda('tasks=200&sync=stale')
      expect(stale.answer.state).toBe('ok')
      vi.setSystemTime(Date.now() + 5000)
      expect((await stale.read('later')).state).toBe('over_ceiling')
    } finally {
      vi.useRealTimers()
    }
  }, 60_000)

  it("posts a replaced server's late timer to its own port, never into a later server's messages", async () => {
    // sync=stale arms a real timer that outlives its case; the server posts
    // through the port it was loaded with, so the timer's transition lands in
    // the finished case's messages and never in the next server's
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      /** Sends `message` and lets the server's own short timers run. */
      const sent = async (send, message) => {
        const done = send(message)
        await vi.advanceTimersByTimeAsync(100)
        await done
      }
      const first = await server('tasks=200&latency=0&mbps=100000&sync=stale')
      await sent(first.send, { type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(first.posted.find((m) => m.to === 'snap').text)
      const program = snap.projects.find((p) => p.type === 'meta')
      const start = Date.parse('2026-11-02T00:00:00.000Z')
      await sent(first.send, {
        type: 'query',
        id: 'agenda',
        name: 'teamSync:agenda',
        args: {
          org_id: snap.orgs[0].id,
          scope: { kind: 'project', project_id: program.id },
          day: '2026-11-04',
          week: '2026-11-02',
          week_starts: Array.from({ length: 53 }, (_, i) => start - (52 - i) * 7 * 86_400_000),
          week_end: start + 7 * 86_400_000,
        },
      })
      expect(JSON.parse(first.posted.find((m) => m.to === 'agenda').text).state).toBe('ok')
      const second = await server('tasks=40&latency=0&mbps=100000')
      const before = second.posted.length
      await vi.advanceTimersByTimeAsync(5000)
      expect(second.posted.length).toBe(before)
      expect(first.posted.some((m) => m.type === 'transition')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("answers the Roadmap's two reads for the selection the app opens, with the states the page asks for", async () => {
    /** What tasks:roadmap and tasks:roadmapDependencies answer for the
        first program on a workspace with page parameters `params`. */
    const roadmap = async (params, filters = {}) => {
      const { posted, send } = await server(`latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      const program = snap.projects.find((p) => p.type === 'meta')
      const scope = { kind: 'project', org_id: snap.orgs[0].id, project_id: program.id }
      const args = {
        scope,
        filters: { mine: false, owners: [], priority: null, search: '', ...filters },
        window: { from: '2026-09-07', to: '2026-11-02' },
      }
      await send({ type: 'query', id: 'roadmap', name: 'tasks:roadmap', args })
      await send({ type: 'query', id: 'deps', name: 'tasks:roadmapDependencies', args: { scope } })
      const read = (to) => {
        const answer = posted.find((m) => m.to === to)
        return answer.error ? { error: answer.error } : JSON.parse(answer.text)
      }
      return { answer: read('roadmap'), deps: read('deps') }
    }
    const ok = await roadmap('tasks=300')
    expect(ok.answer.state).toBe('ok')
    expect(ok.answer.rows.length).toBeGreaterThan(0)
    expect(ok.answer.projects).toHaveLength(10)
    expect(ok.answer.remaining.state).toBe('ok')
    expect(ok.answer.rows.every((row) => row.description === undefined)).toBe(true)
    expect(ok.deps.state).toBe('ok')
    expect(ok.deps.auto_move.state).toBe('ok')
    // the forced states, several at once
    expect((await roadmap('tasks=100&roadmap=over_ceiling')).answer).toMatchObject({
      state: 'over_ceiling',
      ceiling: 1000,
    })
    expect((await roadmap('tasks=100&roadmap=over_budget')).answer.state).toBe('over_budget')
    const both = await roadmap('tasks=100&roadmap=counting,deps-budget')
    expect(both.answer.remaining).toEqual({ state: 'unavailable', reason: 'counting' })
    expect(both.deps).toEqual({ state: 'over_budget' })
    const auto = await roadmap('tasks=100&roadmap=remaining-budget,automove-budget')
    expect(auto.answer.remaining).toEqual({ state: 'unavailable', reason: 'budget' })
    expect(auto.deps.auto_move).toEqual({ state: 'over_budget' })
    expect((await roadmap('tasks=100&roadmap=access_unchecked')).answer).toMatchObject({
      state: 'unavailable',
      reason: 'access_unchecked',
    })
    expect((await roadmap('tasks=100&roadmap=error')).answer.error).toContain('roadmap=error')
    // the owner loads answer every owner unavailable, or not at all
    const loads = async (params) => {
      const { posted, send } = await server(`latency=0&mbps=100000&tasks=100&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      const args = { org_id: snap.orgs[0].id, owner_ids: [snap.profiles[0].id] }
      await send({ type: 'query', id: 'loads', name: 'planning:ownerLoads', args })
      const answer = posted.find((m) => m.to === 'loads')
      return answer ? JSON.parse(answer.text) : null
    }
    expect((await loads('loads=unavailable')).owners[0].state).toBe('unavailable')
    expect(await loads('loads=loading')).toBeNull()
    expect((await loads('')).owners[0].state).toBe('ok')
    // an organization Viewer may edit no project of a part
    const viewer = await roadmap('tasks=300&role=viewer')
    if (viewer.deps.state === 'ok' && viewer.deps.auto_move.state === 'ok')
      expect(viewer.deps.auto_move.editable_projects).toEqual([])
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

  it("reads the task window's task by its uuid in any case, or its number or key in the organization asked only", async () => {
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000')
    const org = '00000000-0000-4000-8000-000000000001'
    const other = '00000000-0000-4000-8000-0000000000ff'
    const answer = (to) => JSON.parse(posted.find((m) => m.to === to).text)
    const ask = (id, args) => send({ type: 'query', id, name: 'taskWindow:task', args })
    await ask('uuid', { org_id: org, ref: TASK_1.toUpperCase() })
    const { num } = answer('uuid').task
    const asks = {
      number: { org_id: org, ref: String(num) },
      key: { org_id: org, ref: `qn-${num}` },
      elsewhere: { org_id: other, ref: `QN-${num}` },
      uuidElsewhere: { org_id: other, ref: TASK_1 },
      unknown: { org_id: org, ref: 'QN-999' },
      junk: { org_id: org, ref: 'not-a-task' },
    }
    for (const [id, args] of Object.entries(asks)) await ask(id, args)
    for (const id of ['uuid', 'number', 'key'])
      expect(answer(id), id).toMatchObject({ state: 'ok', task: { id: TASK_1, num } })
    for (const id of ['elsewhere', 'uuidElsewhere', 'unknown', 'junk'])
      expect(answer(id), id).toEqual({ state: 'unavailable' })
  })

  it("leaves the task window's read unanswered with window=loading, and fails it from the first with window=error", async () => {
    const args = { org_id: '00000000-0000-4000-8000-000000000001', ref: 'QN-1' }
    const loading = await server('tasks=20&latency=0&mbps=100000&window=loading')
    await loading.send({ type: 'query', id: 'task', name: 'taskWindow:task', args })
    expect(loading.posted.filter((m) => m.to === 'task')).toEqual([])
    const failing = await server('tasks=20&latency=0&mbps=100000&window=error')
    await failing.send({ type: 'query', id: 'task', name: 'taskWindow:task', args })
    expect(failing.posted.find((m) => m.to === 'task')?.error).toContain('window=error')
  })

  it("answers the relation pickers' read from its stand-in, never as an attachments list", async () => {
    const { posted, send } = await server('tasks=40&latency=0&mbps=100000&relations=rows-2')
    const org = '00000000-0000-4000-8000-000000000001'
    const ask = (to, args) =>
      send({ type: 'query', id: to, name: 'taskWindow:relationCandidates', args })
    const answer = (to) => JSON.parse(posted.find((m) => m.to === to).text)
    await ask('link', { org_id: org, issue_id: TASK_1, kind: 'link' })
    const first = answer('link')
    expect(first).toMatchObject({ state: 'ok', stopped: false, blocked: null })
    expect(first.rows).toHaveLength(2)
    expect(first).not.toHaveProperty('count')
    // the next batch goes on from the first one's cursor, without repeats
    await ask('next', { org_id: org, issue_id: TASK_1, kind: 'link', cursor: first.next })
    const second = answer('next')
    expect(second.rows).toHaveLength(2)
    expect(second.rows.map((r) => r.id)).not.toContain(first.rows[0].id)
    // a cursor of another search is refused
    await ask('other', {
      org_id: org,
      issue_id: TASK_1,
      kind: 'link',
      search: 'x',
      cursor: first.next,
    })
    expect(posted.find((m) => m.to === 'other')?.error).toBeTruthy()
    const stopped = await server('tasks=40&latency=0&mbps=100000&relations=stopped')
    await stopped.send({
      type: 'query',
      id: 's',
      name: 'taskWindow:relationCandidates',
      args: { org_id: org, issue_id: TASK_1, kind: 'link', search: 'nothing-matches' },
    })
    expect(JSON.parse(stopped.posted.find((m) => m.to === 's').text)).toMatchObject({
      state: 'ok',
      rows: [],
      stopped: true,
    })
  })

  it("decides each relation picker's exclusions by its own kind, and offers all your projects at every family end, as the reader does", async () => {
    const { posted, send } = await server('tasks=40&latency=0&mbps=100000')
    const org = '00000000-0000-4000-8000-000000000001'
    const { issueKey } = await import('../../convex/lib/taskRefs')
    let asks = 0
    /* The rows of picker `kind` for task number `n`, searching the task
       ID of task number `m`. */
    const rowsOf = async (kind, n, m) => {
      const to = `ask-${asks++}`
      await send({
        type: 'query',
        id: to,
        name: 'taskWindow:relationCandidates',
        args: { org_id: org, issue_id: id('4', n), kind, search: issueKey(m + 1) },
      })
      return JSON.parse(posted.find((msg) => msg.to === to).text).rows.map((r) => r.id)
    }
    // task 5 is the parent of tasks 6 and 7 (server.mjs parentOf), and
    // task 18 is linked to task 21 (the links share)
    expect(await rowsOf('link', 5, 6)).toEqual([id('4', 6)])
    expect(await rowsOf('link', 6, 5)).toEqual([id('4', 5)])
    expect(await rowsOf('parent', 18, 21)).toEqual([id('4', 21)])
    expect(await rowsOf('subtask', 18, 21)).toEqual([id('4', 21)])
    // each kind still leaves out its own current relations
    expect(await rowsOf('link', 18, 21)).toEqual([])
    expect(await rowsOf('parent', 6, 5)).toEqual([])
    expect(await rowsOf('subtask', 5, 6)).toEqual([])
    // with one program and no other project, Search all your projects
    // still shows at the family's end, and goes on to an empty end
    await send({
      type: 'query',
      id: 'end',
      name: 'taskWindow:relationCandidates',
      args: { org_id: org, issue_id: TASK_1, kind: 'link', search: 'nothing-matches' },
    })
    const end = JSON.parse(posted.find((msg) => msg.to === 'end').text)
    expect(end).toMatchObject({ rows: [], next: null, all_projects: expect.any(String) })
    await send({
      type: 'query',
      id: 'all',
      name: 'taskWindow:relationCandidates',
      args: {
        org_id: org,
        issue_id: TASK_1,
        kind: 'link',
        search: 'nothing-matches',
        cursor: end.all_projects,
      },
    })
    expect(JSON.parse(posted.find((msg) => msg.to === 'all').text)).toMatchObject({
      rows: [],
      next: null,
      all_projects: null,
    })
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

  it('answers the milestone reads from the workspace, with the states the page asks for', async () => {
    /** What `name` answers with `args` on a workspace with page parameters
        `params`, and the workspace. */
    const read = async (params, name, args) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'ms', name, args: args(snap) })
      const answer = posted.find((m) => m.to === 'ms')
      if (!answer) return { snap, answer: undefined }
      return {
        snap,
        answer: answer.error ? { error: answer.error, data: answer.data } : JSON.parse(answer.text),
      }
    }
    const projects = (snap) => snap.projects.filter((p) => !p.parent_id).map((p) => p.id)
    const range = (snap) => ({
      projects: projects(snap),
      from: snap.milestones[0].week,
      to: snap.milestones[3].week,
    })
    const between = await read('', 'milestones:between', range)
    expect(between.answer.rows.map((row) => row.name)).toEqual([
      'Milestone 1',
      'Milestone 2',
      'Milestone 3',
    ])
    expect(between.answer).toMatchObject({ next: null, stopped: null })
    const next = await read('', 'milestones:section', (snap) => ({
      projects: projects(snap),
      from: snap.milestones[1].week,
      side: 'upcoming',
      limit: 1,
    }))
    expect(next.answer.rows.map((row) => row.name)).toEqual(['Milestone 2'])
    expect(next.answer.past).toBe(true)
    const get = (snap) => ({ id: snap.milestones[0].id })
    expect((await read('', 'milestones:get', get)).answer).toMatchObject({
      row: { name: 'Milestone 1' },
    })
    // a Viewer opens it read-only
    expect((await read('role=viewer', 'milestones:get', get)).answer.can_write).toBe(false)
    // the forced states
    expect((await read('milestones=open-loading', 'milestones:get', get)).answer).toBeUndefined()
    expect((await read('milestones=open-unavailable', 'milestones:get', get)).answer).toBeNull()
    expect((await read('milestones=open-error', 'milestones:get', get)).answer.error).toContain(
      'failed',
    )
    expect(
      (await read('milestones=open-refused', 'milestones:get', get)).answer.data,
    ).toMatchObject({ reason: 'milestone_read_too_large' })
    const partial = await read('milestones=sync-partial', 'milestones:between', range)
    expect(partial.answer.rows).toHaveLength(1)
    expect(partial.answer.stopped).not.toBeNull()
    expect(
      (await read('milestones=sync-refused', 'milestones:between', range)).answer.data,
    ).toMatchObject({ reason: 'milestone_read_too_large' })
    expect(
      (await read('milestones=sync-loading', 'milestones:between', range)).answer,
    ).toBeUndefined()
  }, 60_000)

  it("answers the project picker's navigation reads from the workspace, with the states the page asks for", async () => {
    /** What `name` answers with `args` on a workspace with page parameters
        `params`, each program with the everyday 3 sub-projects, so 45
        programs give one person 135 readable sub-projects, inside the
        design size's 200. */
    const nav = async (params, name, args = {}) => {
      const { posted, send } = await server(
        `tasks=20&subprojects=3&latency=0&mbps=100000&${params}`,
      )
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'nav', name, args })
      const answer = posted.find((m) => m.to === 'nav')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    const page = await nav('programs=30', 'projectNav:page')
    expect(page.answer.state).toBe('ok')
    expect(page.answer.rows).toHaveLength(25)
    expect(page.answer.next).not.toBeNull()
    expect(page.answer.rows.every((row) => row.favorite === false)).toBe(true)
    // the hidden program, without a grant, never lists
    expect(page.answer.rows.map((row) => row.name)).not.toContain('Hidden program')
    const first = page.snap.projects.find((p) => p.name === 'Testbed program')
    const kids = await nav('programs=30', 'projectNav:children', { project_id: first.id })
    expect(kids.answer.rows).toHaveLength(3)
    expect(kids.answer.rows.every((row) => row.parent_id === first.id)).toBe(true)
    const found = await nav('programs=30', 'projectNav:search', { search: 'project 3' })
    expect(found.answer.rows.length).toBeGreaterThan(0)
    expect(found.answer.rows.every((row) => row.parent !== null)).toBe(true)
    expect((await nav('', 'projectNav:resolve', { project_id: first.id })).answer).toMatchObject({
      state: 'ok',
      project: { id: first.id, parent: null, favorite: false },
    })
    // a Viewer reads the same lists
    expect((await nav('role=viewer', 'projectNav:page')).answer.rows).toHaveLength(1)
    // the forced states
    expect((await nav('projectnav=not-ready', 'projectNav:page')).answer).toEqual({
      state: 'not_ready',
    })
    expect(
      (await nav('projectnav=unchecked', 'projectNav:search', { search: 'x' })).answer,
    ).toMatchObject({ state: 'unavailable', reason: 'access_unchecked' })
    const stopped = await nav('programs=6&projectnav=stopped', 'projectNav:page')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(2)
    expect((await nav('programs=45&projectnav=small', 'projectNav:page')).answer.rows).toHaveLength(
      5,
    )
    expect((await nav('projectnav=error', 'projectNav:page')).answer.error).toContain('fails')
    const starred = await nav('programs=4&projectnav=favorites', 'projectNav:page')
    expect(starred.answer.rows.map((row) => [row.name, row.favorite])).toEqual([
      ['Testbed program', true],
      ['Testbed program 2', true],
      ['Testbed program 3', false],
      ['Testbed program 4', false],
    ])
    // the server's refusals
    expect((await nav('', 'projectNav:search', { search: '  ' })).answer.error).toContain(
      'browse with projectNav.page',
    )
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
    // a chosen person: one the picker lists can take the tasks, the person
    // leaving cannot, and nobody can while Reassign is refused
    const asking = (who) => (snap) => ({ ...leaving(snap), reassign_to: who(snap) })
    const listed = () => first.answer.rows[0].id
    const eligible = await ask('removal=open', 'accessRemovals:preview', asking(listed))
    expect(eligible.answer.reassign).toMatchObject({ allowed: true, holder_eligible: true })
    const leaver = await ask(
      'removal=open',
      'accessRemovals:preview',
      asking((snap) => snap.profiles[2].id),
    )
    expect(leaver.answer.reassign.holder_eligible).toBe(false)
    const refused = await ask('removal=over', 'accessRemovals:preview', asking(listed))
    expect(refused.answer.reassign).toMatchObject({ allowed: false, holder_eligible: false })
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

  it("answers a project's Settings page reads from the workspace, with the states and grants the page asks for", async () => {
    /** What `name` answers with `args(snap, project)` on a workspace with
        page parameters `params`, read by an admin, and the server. */
    const ask = async (params, name, args = () => ({})) => {
      const at = await server(`tasks=100&latency=0&mbps=100000&role=admin&${params}`)
      await at.send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(at.posted.find((m) => m.to === 'snap').text)
      const project = snap.projects.find((p) => p.type === 'meta')
      await at.send({
        type: 'query',
        id: 'read',
        name,
        args: { org_id: snap.orgs[0].id, project_id: project.id, ...args(snap, project) },
      })
      const answer = at.posted.find((m) => m.to === 'read')
      return {
        ...at,
        snap,
        project,
        answer: answer.error ? { error: answer.error } : JSON.parse(answer.text),
      }
    }
    const byId = (_, project) => ({ id: project.id, project_id: undefined })
    const get = await ask('', 'projectSettings:get', byId)
    expect(get.answer).toMatchObject({ state: 'ok', can_manage_users: true })
    expect(get.answer.project.name).toBe('Testbed program')
    // the signed-in admin's own grant only, unless the page asks for more
    const plain = await ask('', 'projectSettings:users')
    expect(plain.answer.rows).toHaveLength(1)
    const grants = await ask('grants=210', 'projectSettings:users')
    expect(grants.snap.profiles.length).toBeGreaterThanOrEqual(212)
    expect(grants.answer.rows).toHaveLength(25)
    expect(grants.answer.next).not.toBeNull()
    // the forced states
    expect((await ask('projectsettings=not-ready', 'projectSettings:users')).answer).toEqual({
      state: 'not_ready',
    })
    const stopped = await ask('grants=60&projectsettings=stopped', 'projectSettings:users')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(10)
    const small = await ask('grants=60&projectsettings=small', 'projectSettings:users')
    expect(small.answer.rows).toHaveLength(5)
    expect((await ask('projectsettings=error', 'projectSettings:teams')).answer.error).toContain(
      'fails',
    )
    expect((await ask('projectsettings=refused', 'projectSettings:candidates')).answer).toEqual({
      state: 'refused',
      message: 'no permission to manage users on this project',
    })
    // unheld: once read, the workspace's parts leave the project out while
    // its page's reads still answer it
    const unheld = await ask('projectsettings=unheld', 'projectSettings:get', byId)
    expect(unheld.answer.state).toBe('ok')
    await new Promise((resolve) => setTimeout(resolve, 10))
    await unheld.send({ type: 'query', id: 'after', name: 'snapshot:forMe', args: {} })
    const after = JSON.parse(unheld.posted.find((m) => m.to === 'after').text)
    expect(after.projects.some((p) => p.id === unheld.project.id)).toBe(false)
    // a level change goes into the workspace the reads answer from
    await unheld.send({
      type: 'mutation',
      id: 'write',
      name: 'projects:setAccess',
      args: {
        org_id: unheld.snap.orgs[0].id,
        id: unheld.project.id,
        user_id: unheld.snap.profiles[3].id,
        level: 'viewer',
        expected: { level: null },
      },
    })
    await vi.waitFor(() => expect(unheld.posted.some((m) => m.id === 'write')).toBe(true))
    await unheld.send({
      type: 'query',
      id: 'users',
      name: 'projectSettings:users',
      args: { org_id: unheld.snap.orgs[0].id, project_id: unheld.project.id },
    })
    const users = JSON.parse(unheld.posted.find((m) => m.to === 'users').text)
    expect(users.rows.map((r) => [r.id, r.level])).toContainEqual([
      unheld.snap.profiles[3].id,
      'viewer',
    ])
  }, 60_000)

  it("answers Settings' project lists from the workspace, with the archive, the hidden projects and the states the page asks for", async () => {
    /** What list `name` answers with `args` on a workspace with page
        parameters `params`, and the snapshot. */
    const ask = async (params, name, args = {}) => {
      const at = await server(`tasks=60&latency=0&mbps=100000&${params}`)
      await at.send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(at.posted.find((m) => m.to === 'snap').text)
      await at.send({
        type: 'query',
        id: 'read',
        name,
        args: { org_id: snap.orgs[0].id, ...args },
      })
      const answer = at.posted.find((m) => m.to === 'read')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    // 60 live and 60 archived programs of three sub-projects
    const world = 'programs=120&subprojects=3&archivedprojects=60'
    const live = await ask(world, 'projectSettings:projects')
    expect(live.answer).toMatchObject({ state: 'ready', stopped: false })
    expect(live.answer.rows).toHaveLength(25)
    expect(live.answer.rows[0]).toMatchObject({ parent: null, can_create_sub_project: false })
    const metas = live.snap.projects.filter((p) => p.type === 'meta')
    expect(metas.filter((p) => p.archived_at)).toHaveLength(60)
    // no task of an archived program is in the workspace
    const archivedIds = new Set(live.snap.projects.filter((p) => p.archived_at).map((p) => p.id))
    expect(live.snap.issues.some((t) => archivedIds.has(t.project_id))).toBe(false)
    const old = await ask(world, 'projectSettings:archived')
    expect(old.answer.rows).toHaveLength(25)
    // newest first, and no sub-project beneath an archived program is an
    // entry, also one archived on its own before it
    expect(old.answer.rows.every((r) => r.parent === null && r.has_sub_projects)).toBe(true)
    const times = old.answer.rows.map((r) => r.archived_at)
    expect([...times].sort().reverse()).toEqual(times)
    const first = old.answer.rows[0]
    const chips = await ask(world, 'projectSettings:archivedSubProjects', { project_id: first.id })
    expect(chips.answer.rows.map((c) => c.with_parent).sort()).toEqual([false, true, true])
    // an admin also lists the hidden program the workspace leaves out
    const asAdmin = await ask('role=admin&hidden=4', 'projectSettings:projects')
    const hiddenRow = asAdmin.answer.rows.find((r) => r.name === 'Hidden program')
    expect(hiddenRow).toMatchObject({ can_create_sub_project: true })
    expect(asAdmin.snap.projects.some((p) => p.id === hiddenRow.id)).toBe(false)
    const page = await ask('role=admin&hidden=4', 'projectSettings:get', { id: hiddenRow.id })
    expect(page.answer).toMatchObject({ state: 'ok', project: { name: 'Hidden program' } })
    const subs = await ask('role=admin&hidden=4', 'projectSettings:subProjects', {
      project_id: hiddenRow.id,
    })
    expect(subs.answer.rows).toHaveLength(4)
    // anyone else lists none of it
    const asUser = await ask('hidden=4', 'projectSettings:projects')
    expect(asUser.answer.rows.some((r) => r.name === 'Hidden program')).toBe(false)
    // the forced states
    expect((await ask('projectlists=not-ready', 'projectSettings:archived')).answer).toEqual({
      state: 'not_ready',
    })
    expect((await ask('projectlists=unchecked', 'projectSettings:projects')).answer).toMatchObject({
      state: 'unavailable',
      reason: 'access_unchecked',
    })
    expect((await ask('projectlists=error', 'projectSettings:projects')).answer.error).toContain(
      'fails',
    )
    const stopped = await ask(`${world}&projectlists=stopped`, 'projectSettings:projects')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(10)
    const small = await ask(`${world}&projectlists=small`, 'projectSettings:archived')
    expect(small.answer.rows).toHaveLength(5)
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
    // a task opened by its number is read by number, then by the window by
    // uuid, and each read answers first and fails only after that
    const byNumber = await server('tasks=40&latency=0&mbps=100000&window=failed')
    const org = '00000000-0000-4000-8000-000000000001'
    const ask = (id, ref) =>
      byNumber.send({ type: 'query', id, name: 'taskWindow:task', args: { org_id: org, ref } })
    await ask('number', 'QN-1')
    const first = JSON.parse(byNumber.posted.find((m) => m.to === 'number').text)
    expect(first).toMatchObject({ state: 'ok', task: { num: 1 } })
    await ask('uuid', first.task.id)
    expect(JSON.parse(byNumber.posted.find((m) => m.to === 'uuid').text)).toMatchObject({
      state: 'ok',
      task: { id: first.task.id },
    })
    await ask('again', 'QN-1')
    expect(byNumber.posted.find((m) => m.to === 'again')?.error).toContain('window=failed')
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
