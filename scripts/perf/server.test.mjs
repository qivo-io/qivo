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

  it('shows a remote task on the Roadmap, and the same rows again once it goes', async () => {
    // at everyday tasks, as the forced state's case above reaches the ceiling
    const { posted, send } = await server('latency=0&mbps=100000&tasks=100')
    await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
    const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
    const program = snap.projects.find((p) => p.type === 'meta')
    // a window over every task's weeks, which start within 3 weeks of today
    const from = new Date()
    from.setUTCDate(from.getUTCDate() - 7 * 3)
    const to = new Date(from)
    to.setUTCDate(to.getUTCDate() + 7 * 12)
    const args = {
      scope: { kind: 'project', org_id: snap.orgs[0].id, project_id: program.id },
      filters: { mine: false, owners: [], priority: null, search: '' },
      window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    }
    let n = 0
    const roadmap = async () => {
      n++
      await send({ type: 'query', id: `roadmap${n}`, name: 'tasks:roadmap', args })
      return JSON.parse(posted.find((m) => m.to === `roadmap${n}`).text)
    }
    const at = await roadmap()
    expect(at.state).toBe('ok')
    expect(at.rows.length).toBeGreaterThan(0)
    const before = at.rows.map((row) => row.id)
    await send({ type: 'scenario', id: 'create', name: 'deliverCreate', args: [] })
    const grown = await roadmap()
    expect(grown.state).toBe('ok')
    expect(grown.rows).toHaveLength(before.length + 1)
    const made = grown.rows.map((row) => row.id).filter((id) => !before.includes(id))
    expect(made).toHaveLength(1)
    await send({ type: 'scenario', id: 'delete', name: 'deliverDelete', args: [] })
    const back = await roadmap()
    expect(back.state).toBe('ok')
    expect(back.rows.map((row) => row.id)).toEqual(before)
    // nothing more of its own to delete
    await send({ type: 'scenario', id: 'again', name: 'deliverDelete', args: [] })
    expect((await roadmap()).rows.map((row) => row.id)).toEqual(before)
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

  it("pages the opened task's long thread as the server does, and refuses another task's ids", async () => {
    const { posted, send } = await server(
      'tasks=20&latency=0&mbps=100000&thread=120&threadchanges=75',
    )
    const args = { issue_id: TASK_1 }
    let n = 0
    const ask = async (name, extra = {}, task = args) => {
      const id = `q${n++}`
      await send({ type: 'query', id, name, args: { ...task, ...extra } })
      const message = posted.find((m) => m.to === id)
      return message.error ? { refused: message.data ?? message.error } : JSON.parse(message.text)
    }
    // the newest 50 comments, oldest first, and the 50 before the first
    const live = await ask('snapshot:threadComments')
    expect(live.comments).toHaveLength(50)
    expect(live.earlier).toBe(true)
    const before = await ask('snapshot:commentsBefore', { before: live.comments[0].id })
    expect(before.comments).toHaveLength(50)
    expect(before.earlier).toBe(true)
    expect(before.comments.at(-1).created_at < live.comments[0].created_at).toBe(true)
    const start = await ask('snapshot:commentsBefore', { before: before.comments[0].id })
    expect(start.comments).toHaveLength(20)
    expect(start.earlier).toBe(false)
    // every comment once, in thread order, with times in that order
    const thread = [...start.comments, ...before.comments, ...live.comments]
    expect(new Set(thread.map((c) => c.id)).size).toBe(120)
    const times = thread.map((c) => c.created_at)
    expect(times).toEqual([...times].sort())
    // ordinary text: a few sentences, some with a list, a link or a mention
    expect(thread.every((c) => c.body.length > 100 && c.body.length < 1200)).toBe(true)
    expect(thread.some((c) => c.body.includes('\n- '))).toBe(true)
    expect(thread.some((c) => c.body.includes('](https://'))).toBe(true)
    expect(thread.some((c) => c.body.startsWith('@['))).toBe(true)
    // the history in pages of 50 with `next`, the oldest row each read
    const history = await ask('snapshot:threadHistory')
    expect(history.events).toHaveLength(50)
    expect(history).toMatchObject({ earlier: true, next: history.events[0].id })
    const older = await ask('snapshot:historyBefore', { before: history.next })
    expect(older.events).toHaveLength(25)
    expect(older).toMatchObject({ earlier: false, next: null })
    const rows = [...older.events, ...history.events]
    expect(rows.every((row) => row.target_id === TASK_1 && row.target_type === 'issue')).toBe(true)
    expect(rows.map((row) => row.ts)).toEqual(rows.map((row) => row.ts).toSorted())
    // a `before` that is no row of this task refuses as the server does
    const other = { issue_id: id('4', 2) }
    expect(await ask('snapshot:commentsBefore', { before: live.comments[0].id }, other)).toEqual({
      refused: { code: 'bad_request', message: 'before must be the id of a comment on this task' },
    })
    expect(await ask('snapshot:historyBefore', { before: 'nothing' })).toEqual({
      refused: {
        code: 'bad_request',
        message: "before must be the id of a row in this task's history",
      },
    })
    // other tasks hold no thread
    expect(await ask('snapshot:threadComments', {}, other)).toEqual({
      comments: [],
      earlier: false,
    })
  })

  it('gives the first task the thread from the start with threadunread, and an unread message at that comment', async () => {
    const { posted, send } = await server(
      'tasks=20&latency=0&mbps=100000&thread=200&threadunread=120',
    )
    await send({ type: 'query', id: 'q', name: 'snapshot:forMe', args: {} })
    const snapshot = JSON.parse(posted.find((m) => m.to === 'q').text)
    const first = id('4', 0)
    const message = snapshot.messages.find((m) => m.issue_id === first)
    expect(message).toMatchObject({ kind: 'comment', recipient_id: snapshot.myProfileIds[0] })
    expect(message.read_at ?? null).toBeNull()
    await send({
      type: 'query',
      id: 'live',
      name: 'snapshot:threadComments',
      args: { issue_id: first },
    })
    const live = JSON.parse(posted.find((m) => m.to === 'live').text)
    expect(live.comments).toHaveLength(50)
    // the message's time is comment #120's, among the released ones
    expect(message.created_at < live.comments[0].created_at).toBe(true)
    // every tenth comment is the signed-in person's
    const mine = live.comments.filter((c) => c.author === snapshot.myProfileIds[0])
    expect(mine).toHaveLength(5)
    // without threadunread the first task holds no message
    const usual = await server('tasks=20&latency=0&mbps=100000&thread=200')
    await usual.send({ type: 'query', id: 'q', name: 'snapshot:forMe', args: {} })
    const plain = JSON.parse(usual.posted.find((m) => m.to === 'q').text)
    expect(plain.messages.filter((m) => m.issue_id === first)).toEqual([])
  })

  it('fails or holds the thread reads that threadstate names, and only those', async () => {
    const { posted, send } = await server(
      'tasks=20&latency=0&mbps=100000&thread=200&threadstate=newer-error',
    )
    const args = { issue_id: TASK_1 }
    let n = 0
    const ask = async (extra) => {
      const id = `q${n++}`
      await send({
        type: 'query',
        id,
        name: 'snapshot:commentsBefore',
        args: { ...args, ...extra },
      })
      return posted.find((m) => m.to === id)
    }
    await send({ type: 'query', id: 'live', name: 'snapshot:threadComments', args })
    const live = JSON.parse(posted.find((m) => m.to === 'live').text)
    // Show earlier walks back: each read asks before an older comment
    const first = JSON.parse((await ask({ before: live.comments[0].id })).text)
    const second = JSON.parse((await ask({ before: first.comments[0].id })).text)
    expect(second.comments).toHaveLength(50)
    // a read before a later comment, as Show newer asks, fails
    expect((await ask({ before: live.comments[10].id })).error).toContain('newer-error')
    // and an earlier one still answers
    expect((await ask({ before: second.comments[0].id })).text).toBeTruthy()
    // earlier-error fails the first read already
    const failing = await server(
      'tasks=20&latency=0&mbps=100000&thread=200&threadstate=earlier-error',
    )
    await failing.send({ type: 'query', id: 'live', name: 'snapshot:threadComments', args })
    const shown = JSON.parse(failing.posted.find((m) => m.to === 'live').text)
    await failing.send({
      type: 'query',
      id: 'e',
      name: 'snapshot:commentsBefore',
      args: { ...args, before: shown.comments[0].id },
    })
    expect(failing.posted.find((m) => m.to === 'e').error).toContain('earlier-error')
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

  it("answers the label picker, the window's labels by id and the mention suggestions, with the states the page asks for", async () => {
    /** What `name` answers with `args` on a workspace with page parameters
        `params`, and the snapshot. */
    const read = async (params, name, args = {}) => {
      const { posted, send } = await server(`tasks=100&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'read', name, args: { org_id: snap.orgs[0].id, ...args } })
      const answer = posted.find((m) => m.to === 'read')
      if (!answer) return { snap, answer: 'none' }
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    // the picker, for any seat, with can_create by role
    const sixty = await read('orglabels=60', 'labels:picker')
    expect(sixty.answer.rows).toHaveLength(25)
    expect(sixty.answer).toMatchObject({ can_create: true, stopped: false, exact: null })
    expect((await read('role=viewer', 'labels:picker')).answer.can_create).toBe(false)
    expect((await read('', 'labels:picker', { search: 'label c' })).answer.exact).toMatchObject({
      name: 'Label C',
    })
    const stopped = await read('orglabels=60&labelpicker=stopped', 'labels:picker')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(5)
    expect(
      (await read('orglabels=60&labelpicker=small', 'labels:picker')).answer.rows,
    ).toHaveLength(5)
    expect((await read('labelpicker=unchecked', 'labels:picker')).answer.can_create).toBeNull()
    expect((await read('labelpicker=error', 'labels:picker')).answer.error).toContain('fails')
    // the workspace's parts hold no label (the root sends none, and no
    // other part does); the picker and byIds answer every one
    const root = await read('', 'workspace:root')
    expect(root.answer).not.toHaveProperty('labels')
    const all = await read('', 'labels:picker')
    expect(all.answer.rows.map((row) => row.name)).toContain('Label L')
    const far = all.answer.rows.filter((row) => /^Label [JKL]$/.test(row.name)).map((row) => row.id)
    expect(far).toHaveLength(3)
    const byIds = await read('', 'labels:byIds', { ids: far })
    expect(byIds.answer.rows.map((row) => row.name).sort()).toEqual([
      'Label J',
      'Label K',
      'Label L',
    ])
    expect((await read('labelpicker=byids-error', 'labels:byIds', { ids: far })).answer.error).toBe(
      'the label lookup fails, as the stand-in was asked',
    )
    expect((await read('labelpicker=byids-loading', 'labels:byIds', { ids: far })).answer).toBe(
      'none',
    )
    // the mention suggestions over every person, 8 at a time
    const people = await read('people=1000', 'pickers:mentions')
    expect(people.answer).toMatchObject({ state: 'ready', stopped: false })
    expect(people.answer.rows).toHaveLength(8)
    expect(Object.keys(people.answer.rows[0]).sort()).toEqual([
      'color',
      'email',
      'id',
      'initials',
      'name',
    ])
    const zoe = await read('', 'pickers:mentions', { search: 'zoë' })
    expect(zoe.answer.rows.every((row) => row.name.startsWith('Zoë'))).toBe(true)
    expect((await read('mentions=not-ready', 'pickers:mentions')).answer).toEqual({
      state: 'not_ready',
    })
    expect((await read('mentions=stopped', 'pickers:mentions')).answer.stopped).toBe(true)
    expect((await read('mentions=small', 'pickers:mentions')).answer.rows).toHaveLength(3)
    expect((await read('mentions=error', 'pickers:mentions')).answer.error).toContain('fail')
  }, 60_000)

  it("answers a task's owner lists, its Mention window and its checks, with the states and unheld people the page asks for", async () => {
    /** What `name` answers with `args(snap)` on a workspace with page
        parameters `params`, and the snapshot. */
    const read = async (params, name, args = () => ({})) => {
      const { posted, send } = await server(`tasks=100&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      const task = snap.issues[0]
      await send({
        type: 'query',
        id: 'read',
        name,
        args: { org_id: snap.orgs[0].id, issue_id: task.id, ...args(snap) },
      })
      const answer = posted.find((m) => m.to === 'read')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    // a batch's shape, on the everyday workspace of 50 people in 5 teams
    const owners = await read('', 'pickers:taskOwners', () => ({ field: 'assignee' }))
    expect(owners.answer).toMatchObject({ state: 'ready', stopped: false })
    expect(owners.snap.teams).toHaveLength(5)
    expect(owners.answer.rows).toHaveLength(25)
    expect(Object.keys(owners.answer.rows[0]).sort()).toEqual([
      'active',
      'id',
      'kind',
      'name',
      'org_role',
      'pending',
    ])
    const recipients = await read('', 'pickers:syncRecipients')
    expect(recipients.answer.rows.map((row) => row.id)).not.toContain(
      recipients.snap.myProfileIds[0],
    )
    const zoe = await read('', 'pickers:taskOwners', () => ({ field: 'reviewer', search: 'zoe' }))
    expect(zoe.answer.rows.length).toBeGreaterThan(0)
    expect(zoe.answer.rows.every((row) => row.name.startsWith('Zoë'))).toBe(true)
    const checked = await read('owners=check-ineligible', 'pickers:canOwn', (snap) => ({
      field: 'assignee',
      ids: [snap.profiles[1].id],
    }))
    expect(checked.answer).toMatchObject({ state: 'ready', rows: [{ eligible: false }] })
    const list = (params) => read(params, 'pickers:taskOwners', () => ({ field: 'assignee' }))
    expect((await list('owners=not-ready')).answer).toEqual({ state: 'not_ready' })
    expect((await list('owners=unavailable')).answer).toEqual({ state: 'unavailable' })
    expect((await list('owners=over-budget')).answer).toEqual({ state: 'over_budget' })
    expect((await list('owners=refused')).answer).toMatchObject({ state: 'refused' })
    expect((await list('owners=stopped&people=100')).answer.stopped).toBe(true)
    expect((await list('owners=small')).answer.rows).toHaveLength(5)
    expect((await list('owners=error')).answer.error).toContain('fails')
    expect(
      (await read('owners=group', 'pickers:taskOwners', () => ({ field: 'reviewer' }))).answer,
    ).toMatchObject({ state: 'refused' })
    expect(
      (
        await read('owners=check-error', 'pickers:canOwn', (snap) => ({
          field: 'assignee',
          ids: [snap.profiles[0].id],
        }))
      ).answer.error,
    ).toContain('fails')
    // the root holds the signed-in person alone; the pickers and byIds
    // answer everyone
    const root = await read('people=50', 'workspace:root')
    expect(root.answer.profiles.map((p) => p.id)).toEqual(root.snap.myProfileIds)
    const faces = await read('people=50', 'people:byIds', () => ({
      ids: [id('1', 48), id('1', 49)],
    }))
    expect(faces.answer.rows.map((row) => row.id).sort()).toEqual([id('1', 48), id('1', 49)])
    const listed = await read('people=50', 'pickers:taskOwners', () => ({
      field: 'assignee',
      search: 'asa 50',
    }))
    expect(listed.answer.rows.map((row) => row.id)).toEqual([id('1', 49)])
  }, 60_000)

  it('answers people by id with their pictures, and the forced states of peoplebyids', async () => {
    /** What `name` answers with `args(snap)` on a workspace with page
        parameters `params`, and the snapshot. */
    const read = async (params, name, args = () => ({})) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
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
    // the server's ids exist once a test loaded it; the workspace holds
    // nobody but the signed-in person, so every other person is read so
    const unheld = () => [id('1', 48), id('1', 49)]
    const faces = await read('people=50&pictures=1', 'people:byIds', () => ({
      ids: unheld(),
    }))
    // each person comes with a picture's version and hours
    expect(faces.answer.rows.map((row) => typeof row.avatar)).toEqual(['string', 'string'])
    expect(faces.answer.rows.every((row) => 'plannable_hours' in row)).toBe(true)
    // and files:mintUrls answers their pictures by that version
    const minted = await read('people=50&pictures=1', 'files:mintUrls', () => ({
      profile_ids: unheld(),
    }))
    for (const row of faces.answer.rows)
      expect(minted.answer.avatars[row.id].url).toContain(`v=${row.avatar}`)
    expect(
      (
        await read('people=50&peoplebyids=byids-error', 'people:byIds', () => ({
          ids: unheld(),
        }))
      ).answer.error,
    ).toContain('fails')
    expect(
      (
        await read('people=50&peoplebyids=byids-gone', 'people:byIds', () => ({
          ids: unheld(),
        }))
      ).answer,
    ).toEqual({ rows: [] })
    // byids-slow holds a live read's answer two seconds, as a subscription
    // and as the watched part the app's profile cache reads
    const { posted, send } = await server(
      'tasks=20&latency=0&mbps=100000&people=50&peoplebyids=byids-slow',
    )
    await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
    const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
    const args = { org_id: snap.orgs[0].id, ids: unheld() }
    await send({ type: 'subscribe', id: 'faces', name: 'people:byIds', args })
    await send({ type: 'watch', id: 'watched', name: 'people:byIds', args })
    const answered = (to) =>
      posted.some(
        (m) => m.to === to || (m.type === 'transition' && m.results.some((r) => r.to === to)),
      )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect([answered('faces'), answered('watched')]).toEqual([false, false])
    await vi.waitFor(() => expect([answered('faces'), answered('watched')]).toEqual([true, true]), {
      timeout: 4000,
    })
  }, 60_000)

  it("answers Settings › Teams and a team's page from the workspace, with the states the page asks for", async () => {
    /** What `name` answers with `args` on a workspace with page parameters
        `params`, and the workspace. */
    const read = async (params, name, args = {}) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'read', name, args: { org_id: snap.orgs[0].id, ...args } })
      const answer = posted.find((m) => m.to === 'read')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    const admin = await read('role=admin', 'teams:settingsPage')
    expect(admin.answer.rows.map((r) => r.name)).toEqual(
      [...admin.snap.teams].map((t) => t.name).sort(),
    )
    expect(admin.answer).toMatchObject({ state: 'ready', next: null, teams: 3 })
    expect(admin.answer.rows.every((r) => r.member_count === 10)).toBe(true)
    // a user leads the first team only, and reads it alone
    const user = await read('', 'teams:settingsPage')
    expect(user.answer.rows.map((r) => r.id)).toEqual([user.snap.teams[0].id])
    const team = admin.snap.teams[0].id
    expect((await read('role=admin', 'teams:get', { id: team })).answer).toMatchObject({
      state: 'ok',
      member_count: 10,
      can_manage: true,
    })
    expect((await read('role=admin', 'teams:members', { team_id: team })).answer.rows).toHaveLength(
      10,
    )
    // every person outside the team may join it
    expect((await read('role=admin', 'teams:addable', { team_id: team })).answer.rows).toHaveLength(
      25,
    )
    // the forced states
    const uncounted = await read('role=admin&teamsettings=uncounted', 'teams:settingsPage')
    expect(uncounted.answer.rows.filter((r) => r.member_count === null)).toHaveLength(2)
    const stopped = await read('role=admin&teamsettings=stopped', 'teams:settingsPage')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(2)
    const small = await read('role=admin&teamsettings=batch-2', 'teams:settingsPage')
    expect(small.answer.rows).toHaveLength(2)
    expect(small.answer.next).not.toBeNull()
    expect(
      (await read('role=admin&teamsettings=not-ready', 'teams:members', { team_id: team })).answer,
    ).toEqual({ state: 'not_ready' })
    expect(
      (await read('role=admin&teamsettings=error', 'teams:settingsPage')).answer.error,
    ).toContain('fails')
    expect(
      (await read('role=admin&teamsettings=get-error', 'teams:get', { id: team })).answer.error,
    ).toContain('fails')
    // a Viewer cannot open the list
    expect((await read('role=viewer', 'teams:settingsPage')).answer).toMatchObject({
      state: 'refused',
    })
  }, 60_000)

  it("answers Team sync's scope menu and a task's followers from the whole, with the states the page asks for", async () => {
    /** What `name` answers with `args(snap)` on a workspace with page
        parameters `params`, and the snapshot. */
    const read = async (params, name, args = () => ({})) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({
        type: 'query',
        id: 'read',
        name,
        args: { org_id: snap.orgs[0].id, ...args(snap) },
      })
      const answer = posted.find((m) => m.to === 'read')
      if (!answer) return { snap, answer: 'none' }
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    // every team, for any seat, a Viewer's too, each its id and name alone
    const teams = await read('role=viewer', 'teams:picker')
    expect(teams.answer).toMatchObject({ state: 'ready', next: null, stopped: false })
    expect(new Set(teams.answer.rows.map((row) => row.id))).toEqual(
      new Set(teams.snap.teams.map((t) => t.id)),
    )
    for (const row of teams.answer.rows) expect(Object.keys(row).sort()).toEqual(['id', 'name'])
    expect((await read('teampicker=not-ready', 'teams:picker')).answer).toEqual({
      state: 'not_ready',
    })
    // batches of five, so ten teams reach a second batch
    const small = await read('teampicker=small&people=100', 'teams:picker')
    expect(small.snap.teams).toHaveLength(10)
    expect(small.answer.rows).toHaveLength(5)
    expect(small.answer.next).not.toBeNull()
    expect((await read('teampicker=stopped', 'teams:picker')).answer.stopped).toBe(true)
    expect((await read('teampicker=error', 'teams:picker')).answer.error).toContain('fails')
    // a task's followers as rows, and the Add list's batch, which leaves
    // out the caller and every follower
    const task = (snap) => snap.issueSubs[0]?.issue_id ?? snap.issues[0].id
    const roster = await read('role=admin', 'issues:subscribers', (snap) => ({
      issue_id: task(snap),
    }))
    expect(roster.answer).toMatchObject({ canManage: true, more: false })
    const following = roster.snap.issueSubs
      .filter((s) => s.issue_id === task(roster.snap))
      .map((s) => s.profile_id)
    expect(roster.answer.subscribers.map((row) => row.id).sort()).toEqual([...following].sort())
    const offered = await read('role=admin', 'pickers:taskFollowers', (snap) => ({
      issue_id: task(snap),
    }))
    expect(offered.answer.state).toBe('ready')
    expect(offered.answer.rows.length).toBeGreaterThan(0)
    for (const row of offered.answer.rows) {
      expect(following).not.toContain(row.id)
      expect(offered.snap.myProfileIds).not.toContain(row.id)
    }
    expect(
      (
        await read('followers=small', 'pickers:taskFollowers', (snap) => ({
          issue_id: task(snap),
        }))
      ).answer.rows,
    ).toHaveLength(5)
    expect(
      (
        await read('followers=viewer', 'pickers:taskFollowers', (snap) => ({
          issue_id: task(snap),
        }))
      ).answer.state,
    ).toBe('refused')
    expect(
      (
        await read('followers=error', 'issues:subscribers', (snap) => ({
          issue_id: task(snap),
        }))
      ).answer.error,
    ).toContain('fails')
  }, 60_000)

  it("answers Settings › Users, the agents' keys and the creators line from the workspace, with the states the page asks for", async () => {
    /** What `name` answers with `args` on a workspace with page parameters
        `params`, and the workspace. */
    const read = async (params, name, args = {}) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'read', name, args: { org_id: snap.orgs[0].id, ...args } })
      const answer = posted.find((m) => m.to === 'read')
      return { snap, answer: answer.error ? { error: answer.error } : JSON.parse(answer.text) }
    }
    const page = await read('role=admin&people=1000', 'people:settingsPage')
    expect(page.snap.profiles).toHaveLength(1000)
    expect(page.answer).toMatchObject({ state: 'ready', admins: 2, stopped: false })
    expect(page.answer.rows).toHaveLength(25)
    expect(page.answer.next).not.toBeNull()
    const found = await read('role=admin&people=1000', 'people:settingsPage', {
      search: 'planner1000@',
    })
    expect(found.answer.rows.map((r) => r.email)).toEqual(['planner1000@testbed.example'])
    const person = page.answer.rows[3]
    expect(
      (await read('role=admin&people=1000', 'people:get', { id: person.id })).answer,
    ).toMatchObject({ state: 'ok', person: { id: person.id } })
    // the agents and their keys
    const agents = await read('role=admin&agents=3', 'people:settingsPage', { search: 'agent' })
    const ids = agents.answer.rows.map((r) => r.id)
    expect(ids).toHaveLength(3)
    const keys = await read('role=admin&agents=3', 'tokens:agentKeys', { agent_ids: ids })
    expect(keys.answer.agents.map((a) => a.keys.length)).toEqual([3, 3, 3])
    expect(keys.answer.agents[0].keys[0].name).toBe('Key 3')
    const capped = await read('role=admin&agents=3&agentkeys=capped', 'tokens:agentKeys', {
      agent_ids: ids,
    })
    expect(capped.answer.agents[0]).toMatchObject({ more: true })
    expect(capped.answer.agents[0].keys).toHaveLength(2)
    expect(
      (await read('role=admin&agents=3&agentkeys=error', 'tokens:agentKeys', { agent_ids: ids }))
        .answer.error,
    ).toContain('fails')
    // the creators line at 1,000 people
    expect((await read('role=admin&people=1000', 'orgs:projectCreators')).answer).toMatchObject({
      state: 'ok',
      setting: 'users',
      others: 100,
      more: true,
    })
    expect((await read('role=admin&creators=unavailable', 'orgs:projectCreators')).answer).toEqual({
      state: 'unavailable',
    })
    expect(
      (await read('role=admin&creators=error', 'orgs:projectCreators')).answer.error,
    ).toContain('fails')
    // the forced states of the page
    const stopped = await read('role=admin&people=1000&userspage=stopped', 'people:settingsPage')
    expect(stopped.answer).toMatchObject({ stopped: true })
    expect(stopped.answer.rows).toHaveLength(10)
    expect(
      (await read('role=admin&userspage=small', 'people:settingsPage')).answer.rows,
    ).toHaveLength(5)
    expect((await read('role=admin&userspage=not-ready', 'people:settingsPage')).answer).toEqual({
      state: 'not_ready',
    })
    expect(
      (await read('role=admin&userspage=last-admin', 'people:settingsPage')).answer.admins,
    ).toBe(1)
    expect(
      (await read('role=admin&userspage=error', 'people:settingsPage')).answer.error,
    ).toContain('fails')
    // only an admin reads the page
    expect((await read('', 'people:settingsPage')).answer.error).toContain(
      'only organization admins',
    )
  }, 60_000)

  it("answers MCP access's two lists from its stand-in, with the tokens, apps and states the page asks for", async () => {
    /** What `name` answers with `args` for page parameters `params`. */
    const read = async (params, name, args = {}) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'read', name, args })
      const answer = posted.find((m) => m.to === 'read')
      return answer.error ? { error: answer.error } : JSON.parse(answer.text)
    }
    // two of each by default, the oldest token revoked, the second app by an admin
    const tokens = await read('', 'tokens:personalTokens')
    expect(tokens.rows.map((t) => [t.name, t.revokedAt !== null])).toEqual([
      ['Raycast on my Mac', false],
      ['Old laptop', true],
    ])
    expect(tokens).toMatchObject({ next: null, stopped: false })
    const apps = await read('', 'connectedApps:list')
    expect(apps.rows.map((a) => [a.clientName, a.revokedByAdmin])).toEqual([
      ['ChatGPT', true],
      ['Claude Desktop', false],
    ])
    // 30 of each reach Load more and the search
    const many = await read('tokens=30&apps=30', 'tokens:personalTokens')
    expect(many.rows).toHaveLength(25)
    expect(
      (await read('tokens=30&apps=30', 'tokens:personalTokens', { cursor: many.next })).rows,
    ).toHaveLength(5)
    expect(
      (await read('tokens=30&apps=30', 'connectedApps:list', { search: 'claude' })).rows.map(
        (a) => a.clientName,
      ),
    ).toEqual([
      'Claude Desktop 5',
      'Claude Desktop 4',
      'Claude Desktop 3',
      'Claude Desktop 2',
      'Claude Desktop',
    ])
    expect((await read('tokens=0&apps=0', 'connectedApps:list')).rows).toEqual([])
    // the forced states, which hold for both lists
    const stopped = await read('tokens=30&credlists=stopped', 'tokens:personalTokens')
    expect(stopped).toMatchObject({ stopped: true })
    expect(stopped.rows).toHaveLength(3)
    expect((await read('apps=30&credlists=small', 'connectedApps:list')).rows).toHaveLength(5)
    expect((await read('credlists=error', 'tokens:personalTokens')).error).toContain('fails')
    expect((await read('credlists=error', 'connectedApps:list')).error).toContain('fails')
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
    // the Roadmap's states force the range read alone
    expect(
      (await read('milestones=roadmap-loading', 'milestones:between', range)).answer,
    ).toBeUndefined()
    expect(
      (await read('milestones=roadmap-error', 'milestones:between', range)).answer.error,
    ).toContain('failed')
    expect(
      (await read('milestones=roadmap-refused', 'milestones:between', range)).answer.data,
    ).toMatchObject({ reason: 'milestone_read_too_large' })
    expect(
      (await read('milestones=roadmap-unchecked', 'milestones:between', range)).answer.data,
    ).toMatchObject({ reason: 'access_unchecked' })
    const stopped = await read('milestones=roadmap-partial', 'milestones:between', range)
    expect(stopped.answer.rows).toHaveLength(1)
    expect(stopped.answer.stopped).not.toBeNull()
    // must fail: a Roadmap state that held back Team sync's next milestone
    const nextOne = (snap) => ({
      projects: projects(snap),
      from: snap.milestones[1].week,
      side: 'upcoming',
      limit: 1,
    })
    expect(
      (await read('milestones=roadmap-loading', 'milestones:section', nextOne)).answer.rows,
    ).toHaveLength(1)
  }, 60_000)

  it('plants the milestones on the first programs milestoneprograms names', async () => {
    const { posted, send } = await server(
      'tasks=20&latency=0&mbps=100000&programs=3&milestoneprograms=2',
    )
    await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
    const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
    const tops = snap.projects.filter((p) => !p.parent_id && !p.archived_at)
    const on = new Map()
    for (const m of snap.milestones) on.set(m.project_id, (on.get(m.project_id) ?? 0) + 1)
    // four on each of the first two programs, none on the third
    expect([...on.values()]).toEqual([4, 4])
    expect(on.has(tops.find((p) => p.name === 'Testbed program').id)).toBe(true)
    expect(on.has(tops.find((p) => p.name === 'Testbed program 3').id)).toBe(false)
    expect(new Set(snap.milestones.map((m) => m.id)).size).toBe(8)
  }, 60_000)

  it('sends no milestone in its projects part, while the milestone reads answer the planted ones', async () => {
    const { posted, send } = await server(
      'tasks=20&latency=0&mbps=100000&programs=3&milestoneweeks=3&milestoneprograms=2',
    )
    /** What query `name` answers with `args`. */
    const read = async (name, args) => {
      const id = `q${posted.length}`
      await send({ type: 'query', id, name, args })
      return JSON.parse(posted.find((m) => m.to === id).text)
    }
    // the whole the server holds keeps the planted milestones
    const snap = await read('snapshot:forMe', {})
    expect(snap.milestones).toHaveLength(12)
    const root = await read('workspace:root', {})
    const org = root.orgs[0]
    const parts = []
    for (const w of idWindows(startWindows(org).projects))
      parts.push(await read('workspace:projects', { org_id: org.id, ...w }))
    expect(parts.flatMap((part) => part.projects).length).toBe(snap.projects.length)
    for (const part of parts) {
      expect(part.state).toBe('ok')
      expect(part).not.toHaveProperty('milestones')
      expect(part.more ?? {}).not.toHaveProperty('milestones')
    }
    // the milestone reads answer them, upcoming and past
    const hosts = [...new Set(snap.milestones.map((m) => m.project_id))]
    const from = snap.milestones[0].week
    const upcoming = await read('milestones:section', {
      projects: hosts,
      from,
      side: 'upcoming',
      limit: 25,
    })
    const past = await read('milestones:section', {
      projects: hosts,
      from,
      side: 'past',
      limit: 25,
    })
    expect([...upcoming.rows, ...past.rows].map((m) => m.id).sort()).toEqual(
      snap.milestones.map((m) => m.id).sort(),
    )
  }, 60_000)

  it("plants weekly milestones and forces the Milestones window's section states", async () => {
    /** What milestones:section answers with `args` on a workspace with page
        parameters `params`, and the workspace. */
    const section = async (params, args) => {
      const { posted, send } = await server(
        `tasks=20&latency=0&mbps=100000&milestoneweeks=3&${params}`,
      )
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      const projects = snap.projects.filter((p) => !p.parent_id).map((p) => p.id)
      // from this week's first planted day, the first upcoming milestone's
      const from = snap.milestones[0].week
      await send({
        type: 'query',
        id: 'ms',
        name: 'milestones:section',
        args: { projects, from, limit: 25, ...args },
      })
      const answer = posted.find((m) => m.to === 'ms')
      if (!answer) return { snap, answer: undefined }
      return {
        snap,
        answer: answer.error ? { error: answer.error, data: answer.data } : JSON.parse(answer.text),
      }
    }
    const upcoming = await section('', { side: 'upcoming' })
    expect(upcoming.snap.milestones).toHaveLength(6)
    expect(upcoming.answer.rows.map((row) => row.name)).toEqual([
      'Design review 1',
      'Prototype build 1',
      'Field test 1',
    ])
    expect(upcoming.answer).toMatchObject({ next: null, past: true })
    const past = await section('', { side: 'past' })
    expect(past.answer.rows.map((row) => row.name)).toEqual([
      'Design review 1 signed off',
      'Prototype build 1 signed off',
      'Field test 1 signed off',
    ])
    // the window's states, each on its own side or ask
    expect(
      (await section('milestones=window-loading', { side: 'upcoming' })).answer,
    ).toBeUndefined()
    expect((await section('milestones=window-loading', { side: 'past' })).answer.rows).toHaveLength(
      3,
    )
    const partial = await section('milestones=window-partial', { side: 'upcoming' })
    expect(partial.answer.rows).toHaveLength(1)
    expect(partial.answer.stopped).not.toBeNull()
    expect(
      (await section('milestones=window-refused', { side: 'upcoming' })).answer.data,
    ).toMatchObject({ reason: 'milestone_read_too_large' })
    expect((await section('milestones=window-error', { side: 'upcoming' })).answer.error).toContain(
      'failed',
    )
    expect((await section('milestones=past-error', { side: 'past' })).answer.error).toContain(
      'failed',
    )
    expect((await section('milestones=past-loading', { side: 'past' })).answer).toBeUndefined()
    expect((await section('milestones=past-error', { side: 'upcoming' })).answer.rows).toHaveLength(
      3,
    )
    // a Load more is an ask above the page's first batch
    const grown = { side: 'upcoming', limit: 4 }
    expect((await section('milestones=more-error&milestonecap=2', grown)).answer.error).toContain(
      'failed',
    )
    expect(
      (await section('milestones=more-error&milestonecap=2', { side: 'upcoming', limit: 2 })).answer
        .rows,
    ).toHaveLength(2)
    // the Overview's first Upcoming batch of 10 and the window's 25 are
    // not a Load more, the Overview's 20 is, and a one-row read is not
    const more = (limit) => section('milestones=more-error', { side: 'upcoming', limit })
    expect((await more(10)).answer.rows).toHaveLength(3)
    expect((await more(25)).answer.rows).toHaveLength(3)
    expect((await more(1)).answer.rows).toHaveLength(1)
    expect((await more(20)).answer.error).toContain('failed')
    // My view's sections read with `mine`, which a project's do not
    const mine = { side: 'upcoming', projects: [], mine: true }
    const listed = await section('', mine)
    expect(listed.answer.projects?.length).toBeGreaterThan(0)
    expect((await section('milestones=mine-refused', mine)).answer.data).toMatchObject({
      reason: 'milestone_read_too_large',
    })
    expect((await section('milestones=mine-too-many', mine)).answer.data).toMatchObject({
      reason: 'milestone_too_many',
    })
    expect(
      (await section('milestones=mine-too-many', { side: 'upcoming' })).answer.rows,
    ).toHaveLength(3)
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
    expect((await nav('programs=4&projectnav=empty', 'projectNav:page')).answer).toEqual({
      state: 'ok',
      rows: [],
      next: null,
      stopped: false,
    })
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

  it('leaves the programs unheldprojects names out of the projects part while projectNav.byIds answers them, with its forced states', async () => {
    /** What snapshot:forMe and then byIds of the programs answer with `params`. */
    const byIds = async (params) => {
      const { posted, send } = await server(
        `tasks=20&programs=4&subprojects=2&latency=0&mbps=100000&${params}`,
      )
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'all', name: 'projectNav:page', args: {} })
      const page = JSON.parse(posted.find((m) => m.to === 'all').text)
      const ids = page.rows.map((row) => row.id)
      await send({ type: 'query', id: 'ids', name: 'projectNav:byIds', args: { ids } })
      const answer = posted.find((m) => m.to === 'ids')
      return {
        snap,
        ids,
        answer:
          answer === undefined
            ? null
            : answer.error
              ? { error: answer.error }
              : JSON.parse(answer.text),
      }
    }
    const plain = await byIds('')
    expect(plain.snap.projects.filter((p) => !p.parent_id)).toHaveLength(4)
    expect(plain.answer.rows.map((row) => row.id)).toEqual(plain.ids)
    expect(plain.answer.unchecked).toEqual([])
    const left = await byIds('unheldprojects=2')
    // the two highest-numbered programs and their sub-projects leave the part
    const held = left.snap.projects.filter((p) => !p.parent_id).map((p) => p.name)
    expect(held).toEqual(['Testbed program', 'Testbed program 2'])
    expect(left.snap.projects).toHaveLength(6)
    // while byIds still answers them
    expect(left.answer.rows).toHaveLength(4)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await byIds('unheldprojects=2&projectnav=byids-loading')).answer).toBeNull()
    expect((await byIds('unheldprojects=2&projectnav=byids-error')).answer.error).toContain('fails')
    const apart = await byIds('unheldprojects=2&projectnav=byids-unchecked')
    expect(apart.answer).toMatchObject({ rows: [], unchecked: apart.ids })
    expect(apart.answer.message).toContain('could not finish checking')
  }, 60_000)

  it('remembers the first program as the project opened last, or none or a lost one as startup asks', async () => {
    /** What prefs:get and then resolve of its project answer with `params`. */
    const startup = async (params) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
      const snap = JSON.parse(posted.find((m) => m.to === 'snap').text)
      await send({ type: 'query', id: 'prefs', name: 'prefs:get', args: {} })
      const prefs = JSON.parse(posted.find((m) => m.to === 'prefs').text)
      const asked = prefs?.prefs.lastProject?.project_id
      if (asked === undefined) return { snap, prefs, resolve: null }
      await send({
        type: 'query',
        id: 'r',
        name: 'projectNav:resolve',
        args: { project_id: asked },
      })
      const answer = posted.find((m) => m.to === 'r')
      return {
        snap,
        prefs,
        resolve: answer.error ? { error: answer.error } : JSON.parse(answer.text),
      }
    }
    const first = await startup('')
    const program = first.snap.projects.find((p) => p.name === 'Testbed program')
    expect(first.prefs.prefs).toEqual({
      lastProject: { org_id: program.org_id, project_id: program.id },
    })
    expect(first.resolve).toMatchObject({ state: 'ok', project: { id: program.id } })
    // nothing remembered, and no removed scope answered for older builds
    expect((await startup('startup=none')).prefs).toBeNull()
    const lost = await startup('startup=lost')
    expect(lost.prefs.prefs.lastProject.project_id).not.toBe(program.id)
    expect(lost.resolve).toEqual({ state: 'unavailable' })
    // the check that could not finish, and the one that fails
    expect((await startup('projectnav=unchecked')).resolve).toMatchObject({
      state: 'unavailable',
      reason: 'access_unchecked',
    })
    expect((await startup('projectnav=error')).resolve.error).toContain('fails')
    // Team sync's scope beside it, under the key the app reads only
    const sync = await startup('syncscope=program')
    expect(sync.prefs.prefs).toEqual({
      lastProject: { org_id: program.org_id, project_id: program.id },
      teamSyncScope: `project:${program.id}`,
    })
    expect((await startup('startup=none&syncscope=program')).prefs.prefs).toEqual({
      teamSyncScope: `project:${program.id}`,
    })
  }, 60_000)

  it('stars and unstars a project of the All projects directory and sends the page again', async () => {
    const { posted, send } = await server(
      'tasks=20&programs=4&subprojects=3&latency=0&mbps=100000&projectnav=favorites',
    )
    await send({ type: 'watch', id: 'page', name: 'projectNav:page', args: {} })
    /** The page's latest rows, as name and favorite. */
    const latest = () => {
      const results = posted
        .filter((m) => m.type === 'transition')
        .flatMap((m) => m.results.filter((r) => r.to === 'page'))
      const page = JSON.parse(results.at(-1)?.text ?? '{"rows":[]}')
      return page.rows.map((row) => [row.name, row.favorite])
    }
    await vi.waitFor(() => expect(latest()).toHaveLength(4))
    expect(latest()[0]).toEqual(['Testbed program', true])
    const page = JSON.parse(
      posted
        .filter((m) => m.type === 'transition')
        .at(-1)
        .results.at(-1).text,
    )
    const fourth = page.rows.find((row) => row.name === 'Testbed program 4')
    const star = (favorite, project = fourth) =>
      send({
        type: 'mutation',
        id: `star-${favorite}`,
        name: 'projectNav:setFavorite',
        args: { org_id: project.org_id, project_id: project.id, favorite },
      })
    const sent = posted.length
    await star(true)
    // the page comes again before the star's answer, with the program among
    // the favorites by name
    const after = posted.slice(sent)
    const pageAt = after.findIndex(
      (m) => m.type === 'transition' && m.results.some((r) => r.to === 'page'),
    )
    expect(pageAt).toBeGreaterThan(-1)
    expect(pageAt).toBeLessThan(after.findIndex((m) => m.id === 'star-true'))
    expect(latest()).toEqual([
      ['Testbed program', true],
      ['Testbed program 2', true],
      ['Testbed program 4', true],
      ['Testbed program 3', false],
    ])
    await star(false)
    expect(latest().at(-1)).toEqual(['Testbed program 4', false])
    // a star of a project the person cannot see is refused with its data
    await star(true, { id: 'perf-unknown', org_id: fourth.org_id })
    expect(posted.find((m) => m.id === 'star-true' && m.error)?.error).toMatchObject({
      code: 'not_found',
    })
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
    // Keep as Viewer alone, Reassign refused for want of Edit
    const keepOnly = await ask('removal=keep-only', 'accessRemovals:preview', leaving)
    expect(keepOnly.answer.keep).toMatchObject({ offered: true, allowed: true, permitted: true })
    expect(keepOnly.answer.reassign).toEqual({
      allowed: false,
      refusal: 'no write access to this project',
      permitted: false,
    })
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
    // get takes the project by id, or by its organization and number, and
    // no other organization beside an id
    const byId = (_, project) => ({ id: project.id, project_id: undefined, org_id: undefined })
    const byNum = (snap, project) => ({
      org_id: snap.orgs[0].id,
      num: project.num,
      project_id: undefined,
    })
    const get = await ask('', 'projectSettings:get', byId)
    expect(get.answer).toMatchObject({ state: 'ok', can_manage_users: true })
    expect(get.answer.project.name).toBe('Testbed program')
    expect((await ask('', 'projectSettings:get', byNum)).answer).toEqual(get.answer)
    const free = (snap) => ({ org_id: snap.orgs[0].id, num: 999_999, project_id: undefined })
    expect((await ask('', 'projectSettings:get', free)).answer).toEqual({ state: 'unavailable' })
    const both = (snap, project) => ({
      id: project.id,
      org_id: snap.orgs[0].id,
      project_id: undefined,
    })
    expect((await ask('', 'projectSettings:get', both)).answer.error).toBeDefined()
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
    // a page read by its number leaves the project it found out as well
    const numbered = await ask('projectsettings=unheld', 'projectSettings:get', byNum)
    expect(numbered.answer).toMatchObject({ state: 'ok', project: { id: numbered.project.id } })
    await new Promise((resolve) => setTimeout(resolve, 10))
    await numbered.send({ type: 'query', id: 'after', name: 'snapshot:forMe', args: {} })
    const afterNum = JSON.parse(numbered.posted.find((m) => m.to === 'after').text)
    expect(afterNum.projects.some((p) => p.id === numbered.project.id)).toBe(false)
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
    const page = await ask('role=admin&hidden=4', 'projectSettings:get', {
      id: hiddenRow.id,
      org_id: undefined,
    })
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

  it('creates projects as the server stores them, with a sub-project of the hidden program left out of the workspace', async () => {
    const at = await server('tasks=20&latency=0&mbps=100000&role=admin&hidden=4')
    const snap = async (tag) => {
      await at.send({ type: 'query', id: tag, name: 'snapshot:forMe', args: {} })
      return JSON.parse(at.posted.find((m) => m.to === tag).text)
    }
    const before = await snap('before')
    const org = before.orgs[0].id
    const create = async (tag, args) => {
      await at.send({
        type: 'mutation',
        id: tag,
        name: 'projects:create',
        args: { org_id: org, ...args },
      })
      await vi.waitFor(() =>
        expect(at.posted.some((m) => m.id === tag && m.type === 'answer')).toBe(true),
      )
      return at.posted.find((m) => m.id === tag && m.type === 'answer').value
    }
    const program = before.projects.find((p) => p.type === 'meta')
    // a sub-project of a held program, placed after its siblings, led by me
    const made = await create('sub', {
      id: 'made-sub',
      type: 'project',
      parent_id: program.id,
      key: 'MADE',
      name: 'Made',
    })
    expect(made).toMatchObject({ id: 'made-sub', key: 'MADE' })
    const after = await snap('after')
    const row = after.projects.find((p) => p.id === 'made-sub')
    const siblings = before.projects.filter((p) => p.parent_id === program.id)
    expect(row).toMatchObject({
      parent_id: program.id,
      lead_id: before.profiles[0].id,
      sort_order: Math.max(...siblings.map((p) => p.sort_order)) + 1,
    })
    expect(after.orgs[0].next_project_num).toBe(before.orgs[0].next_project_num + 1)
    // under the hidden program, which the workspace leaves out, it stays out
    // and Settings' lists and its page still answer it
    const lists = async (tag) => {
      await at.send({
        type: 'query',
        id: tag,
        name: 'projectSettings:projects',
        args: { org_id: org, sub_project_parents: true },
      })
      return JSON.parse(at.posted.find((m) => m.to === tag).text)
    }
    const hiddenRow = (await lists('parents')).rows.find((r) => r.name === 'Hidden program')
    await create('unseen', {
      id: 'unseen-sub',
      type: 'project',
      parent_id: hiddenRow.id,
      key: 'UNSN',
      name: 'Unseen',
      lead_id: before.profiles[1].id,
    })
    expect((await snap('later')).projects.some((p) => p.id === 'unseen-sub')).toBe(false)
    await at.send({
      type: 'query',
      id: 'page',
      name: 'projectSettings:get',
      args: { id: 'unseen-sub' },
    })
    expect(JSON.parse(at.posted.find((m) => m.to === 'page').text)).toMatchObject({
      state: 'ok',
      project: { name: 'Unseen', lead_id: before.profiles[1].id },
    })
  })

  it("creates the person's own task as the server stores it, answers the stored row, and shows it on the Board and in its window", async () => {
    // a uuid, as the app's creates name their tasks
    const MADE = '0f6e2c7a-1111-4222-8333-444455556666'
    const at = await server('tasks=40&latency=0&mbps=100000')
    const snap = async (tag) => {
      await at.send({ type: 'query', id: tag, name: 'snapshot:forMe', args: {} })
      return JSON.parse(at.posted.find((m) => m.to === tag).text)
    }
    const before = await snap('before')
    const org = before.orgs[0].id
    const me = before.profiles[0].id
    const program = before.projects.find((p) => p.type === 'meta')
    const sub = before.projects.find((p) => p.parent_id === program.id)
    const create = async (tag, args) => {
      await at.send({
        type: 'mutation',
        id: tag,
        name: 'issues:create',
        args: { org_id: org, ...args },
      })
      await vi.waitFor(() =>
        expect(at.posted.some((m) => m.id === tag && m.type === 'answer')).toBe(true),
      )
      return at.posted.find((m) => m.id === tag && m.type === 'answer')
    }
    const made = await create('made', {
      id: MADE,
      project_id: sub.id,
      title: '  Order the spare sensors  ',
      description: 'For the north bench.  ',
      status: 'todo',
      priority: 'high',
      assignee_id: me,
      reviewer_id: null,
      parent_id: null,
      start_week: null,
      end_week: null,
      due_date: null,
      remaining_hours: null,
      paused: false,
    })
    // the stored row, numbered next, without its text
    expect(made.value).toMatchObject({
      id: MADE,
      org_id: org,
      project_id: sub.id,
      num: before.orgs[0].next_issue_num + 1,
      title: 'Order the spare sensors',
      status: 'todo',
      priority: 'high',
      assignee_id: me,
      reporter_id: me,
      created_by: me,
    })
    expect(made.value).not.toHaveProperty('description')
    expect(made.value).not.toHaveProperty('reviewer_id')
    const after = await snap('after')
    expect(after.orgs[0].next_issue_num).toBe(before.orgs[0].next_issue_num + 1)
    // the Board's answer and the window's read hold it
    await at.send({
      type: 'query',
      id: 'board',
      name: 'tasks:board',
      args: {
        scope: { kind: 'project', org_id: org, project_id: program.id },
        filters: {
          mine: false,
          owners: [],
          priority: null,
          stale_before: null,
          focus: false,
          search: '',
        },
      },
    })
    const board = JSON.parse(at.posted.find((m) => m.to === 'board').text)
    expect(board.rows.some((row) => row.id === MADE)).toBe(true)
    await at.send({
      type: 'query',
      id: 'window',
      name: 'taskWindow:task',
      args: { org_id: org, ref: MADE },
    })
    expect(JSON.parse(at.posted.find((m) => m.to === 'window').text)).toMatchObject({
      state: 'ok',
      task: { id: MADE, description: 'For the north bench.' },
    })
    // a top-level project and one the person does not see are refused with
    // the server's sentences, and nothing is stored
    const meta = await create('meta', { id: 'in-meta', project_id: program.id, title: 'No' })
    expect(meta.error).toEqual({
      code: 'rule',
      message: 'tasks can only be created in sub-projects, not meta-projects',
    })
    const unseen = await create('unseen', { id: 'unseen', project_id: 'not-mine', title: 'No' })
    expect(unseen.error).toEqual({ code: 'forbidden', message: 'no write access to this project' })
    expect((await snap('last')).orgs[0].next_issue_num).toBe(before.orgs[0].next_issue_num + 1)
  })

  it("gives a standard creator who names another lead the server's User grant, unless they declined it", async () => {
    const at = await server('tasks=20&latency=0&mbps=100000')
    const snap = async (tag) => {
      await at.send({ type: 'query', id: tag, name: 'snapshot:forMe', args: {} })
      return JSON.parse(at.posted.find((m) => m.to === tag).text)
    }
    const before = await snap('before')
    const [me, , lead] = before.profiles
    expect(me.org_role).toBe('user')
    const create = async (id, access) => {
      await at.send({
        type: 'mutation',
        id,
        name: 'projects:create',
        args: {
          org_id: before.orgs[0].id,
          id,
          type: 'meta',
          key: id.slice(0, 4).toUpperCase(),
          name: id,
          lead_id: lead.id,
          access,
        },
      })
      await vi.waitFor(() =>
        expect(at.posted.some((m) => m.id === id && m.type === 'answer')).toBe(true),
      )
    }
    // the dialog leaves out the creator's automatic entry, which the
    // server adds, and sends null for one the creator removed
    await create('kept', {})
    await create('declined', { [me.id]: null })
    const after = await snap('after')
    const grantsOf = (project) =>
      after.access
        .filter((a) => a.project_id === project)
        .map(({ profile_id, level }) => ({ profile_id, level }))
    expect(grantsOf('kept')).toEqual([{ profile_id: me.id, level: 'user' }])
    expect(grantsOf('declined')).toEqual([])
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

  it("answers the Inbox's unread summary and the open task's item, and reads the item to its through", async () => {
    const ORG = '00000000-0000-4000-8000-000000000001'
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000&unread=12')
    /** What query `name` answers with `args`, or undefined for none. */
    const ask = async (name, args) => {
      const asked = `${name}:${posted.length}`
      await send({ type: 'query', id: asked, name, args })
      const answer = posted.find((m) => m.to === asked)
      if (!answer) return undefined
      return answer.error ? { error: answer.error } : JSON.parse(answer.text)
    }
    expect(await ask('inbox:summary', {})).toEqual({
      seats: [{ org_id: ORG, ready: true, can_mark_all_read: true, can_remove_read: false }],
      unread_count: 12,
      unread_more: false,
      complete: true,
    })
    const task = id('4', 3)
    const item = await ask('inbox:item', { org_id: ORG, issue_id: task })
    expect(item).toMatchObject({
      state: 'ok',
      item: { unread_count: 1, unread_change: true, snoozed_until: null },
    })
    expect(item.item.through).toBe(Date.parse(item.item.latest_at))
    expect(await ask('inbox:item', { org_id: ORG, issue_id: id('4', 15) })).toEqual({
      state: 'ok',
      item: null,
    })
    // the item read marks the item's messages up to its through, and a
    // through before them marks nothing
    await send({
      type: 'mutation',
      id: 'early',
      name: 'messages:readItem',
      args: { org_id: ORG, issue_id: task, through: item.item.through - 1 },
    })
    expect((await ask('inbox:summary', {})).unread_count).toBe(12)
    await send({
      type: 'mutation',
      id: 'read',
      name: 'messages:readItem',
      args: { org_id: ORG, issue_id: task, through: item.item.through },
    })
    expect(posted.find((m) => m.id === 'read')).toMatchObject({ type: 'answer', value: null })
    expect((await ask('inbox:summary', {})).unread_count).toBe(11)
    expect((await ask('inbox:item', { org_id: ORG, issue_id: task })).item).toMatchObject({
      unread_count: 0,
      first_unread_at: null,
    })
  })

  it('re-sends the watched summary after a write changed it', async () => {
    const ORG = '00000000-0000-4000-8000-000000000001'
    const { posted, send } = await server('tasks=20&latency=0&mbps=100000&unread=2')
    send({ type: 'watch', id: 'summary', name: 'inbox:summary', args: {} })
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'transition')).toBe(true))
    const [first] = posted.filter((m) => m.type === 'transition')
    expect(JSON.parse(first.results[0].text).unread_count).toBe(2)
    posted.length = 0
    await send({
      type: 'mutation',
      id: 'read',
      name: 'messages:readItem',
      args: { org_id: ORG, issue_id: id('4', 0) },
    })
    const sent = posted.filter((m) => m.type === 'transition').flatMap((m) => m.results)
    expect(sent.map((r) => JSON.parse(r.text).unread_count)).toEqual([1])
  })

  it("answers the Inbox's pages, 50 groups a page, and runs a row's item writes", async () => {
    const ORG = '00000000-0000-4000-8000-000000000001'
    const { posted, send } = await server('tasks=150&latency=0&mbps=100000&unread=120')
    /** What query `name` answers with `args`. */
    const ask = async (name, args) => {
      const asked = `${name}:${posted.length}`
      await send({ type: 'query', id: asked, name, args })
      const answer = posted.find((m) => m.to === asked)
      return answer.error ? { error: answer.error, data: answer.data } : JSON.parse(answer.text)
    }
    const first = { order: 'newest', unread_only: false, include_snoozed: false, kinds: [] }
    const pages = [await ask('inbox:page', first)]
    while (pages.at(-1).next)
      pages.push(await ask('inbox:page', { ...first, after: pages.at(-1).next }))
    expect(pages.map((p) => p.rows.length)).toEqual([50, 50, 20])
    expect(pages[0].rows[0]).toMatchObject({ org_id: ORG, issue_id: id('4', 119), num: 120 })
    expect(pages[0]).toMatchObject({ stopped: false, not_ready: [], unchecked: false })
    const row = pages[0].rows[0]
    const write = async (name, args) => {
      await send({ type: 'mutation', id: name, name, args: { org_id: ORG, ...args } })
      expect(posted.find((m) => m.id === name)).toMatchObject({ type: 'answer', value: null })
    }
    await write('messages:readItem', { issue_id: row.issue_id, through: row.through })
    expect((await ask('inbox:page', first)).rows[0].unread_count).toBe(0)
    await write('messages:unreadItem', { issue_id: row.issue_id })
    expect((await ask('inbox:page', first)).rows[0].unread_count).toBe(1)
    await write('messages:snoozeItem', {
      issue_id: row.issue_id,
      until: '2099-01-01T00:00:00.000Z',
    })
    expect((await ask('inbox:page', first)).rows[0].issue_id).not.toBe(row.issue_id)
    const snoozed = await ask('inbox:page', { ...first, include_snoozed: true })
    expect(snoozed.rows.find((r) => r.issue_id === row.issue_id)?.snoozed_until).toBe(
      '2099-01-01T00:00:00.000Z',
    )
    await write('messages:snoozeItem', { issue_id: row.issue_id, until: null })
    // a removal up to a cutoff before the message leaves it, at it removes it
    await write('messages:removeItem', { issue_id: row.issue_id, through: row.through - 1 })
    expect((await ask('inbox:page', first)).rows.some((r) => r.issue_id === row.issue_id)).toBe(
      true,
    )
    await write('messages:removeItem', { issue_id: row.issue_id, through: row.through })
    expect((await ask('inbox:page', first)).rows.some((r) => r.issue_id === row.issue_id)).toBe(
      false,
    )
  })

  it('ends a snooze as the server does, the row back in its Newest first place and an item without one left as it was', async () => {
    const ORG = '00000000-0000-4000-8000-000000000001'
    const { posted, send } = await server('tasks=150&latency=0&mbps=100000&unread=120')
    const ask = async (args) => {
      const asked = `page:${posted.length}`
      await send({ type: 'query', id: asked, name: 'inbox:page', args })
      return JSON.parse(posted.find((m) => m.to === asked).text)
    }
    const write = async (name, args) => {
      const asked = `${name}:${posted.length}`
      await send({ type: 'mutation', id: asked, name, args: { org_id: ORG, ...args } })
      expect(posted.find((m) => m.id === asked)).toMatchObject({ type: 'answer', value: null })
    }
    /** Every row with Show snoozed on, Newest first, page by page. */
    const all = async () => {
      const first = { order: 'newest', unread_only: false, include_snoozed: true, kinds: [] }
      const pages = [await ask(first)]
      while (pages.at(-1).next) pages.push(await ask({ ...first, after: pages.at(-1).next }))
      return pages.flatMap((page) => page.rows)
    }
    const order = (await all()).map((r) => r.issue_id)
    // a row whose newest message is older than now, so a wake stamped now
    // would move it to the top
    const middle = order[80]
    await write('messages:snoozeItem', { issue_id: middle, until: '2099-01-01T00:00:00.000Z' })
    await write('messages:snoozeItem', { issue_id: middle, until: null })
    const after = await all()
    expect(after.map((r) => r.issue_id)).toEqual(order)
    expect(after[80]).toMatchObject({ issue_id: middle, snoozed_until: null, woke_at: null })
    expect(after[80].unread_count).toBeGreaterThan(0)
    // an item that carries no snooze keeps its read state
    const row = after[90]
    await write('messages:readItem', { issue_id: row.issue_id, through: row.through })
    await write('messages:snoozeItem', { issue_id: row.issue_id, until: null })
    expect((await all())[90]).toMatchObject({ issue_id: row.issue_id, unread_count: 0 })
  })

  it("answers the Inbox's page in the states the page asks for", async () => {
    /** What the first and the second page answer on a page with `params`. */
    const read = async (params) => {
      const { posted, send } = await server(`tasks=150&latency=0&mbps=100000&unread=120&${params}`)
      const ask = async (args) => {
        const asked = `page:${posted.length}`
        await send({ type: 'query', id: asked, name: 'inbox:page', args })
        const got = posted.find((m) => m.to === asked)
        if (!got) return undefined
        return got.error ? { error: got.error } : JSON.parse(got.text)
      }
      const first = { order: 'newest', unread_only: false, include_snoozed: false, kinds: [] }
      const one = await ask(first)
      const after = one?.next ?? 'none'
      return { one, two: await ask({ ...first, after }) }
    }
    expect((await read('inboxpage=loading')).one).toBeUndefined()
    expect((await read('inboxpage=failed')).one.error).toContain('fails')
    const stopped = (await read('inboxpage=stopped')).one
    expect(stopped).toMatchObject({ stopped: true })
    expect(stopped.rows).toHaveLength(10)
    expect(stopped.checked_to).toBe(stopped.rows.at(-1).sort_at)
    expect((await read('inboxpage=blind')).one).toMatchObject({ stopped: true, checked_to: null })
    expect((await read('inboxpage=notready')).one).toMatchObject({
      rows: [],
      next: null,
      not_ready: ['00000000-0000-4000-8000-000000000001'],
    })
    const unchecked = (await read('inboxpage=unchecked')).one
    expect(unchecked).toMatchObject({ unchecked: true })
    expect(unchecked.rows).toHaveLength(50)
    expect((await read('inboxpage=badcursor')).two.error).toContain('cursors from an earlier')
    const stuck = await read('inboxpage=stuck')
    expect(stuck.two).toMatchObject({ rows: [], next: stuck.one.next, stopped: true })
  })

  it('answers the inbox reads in the states the page asks for', async () => {
    const ORG = '00000000-0000-4000-8000-000000000001'
    /** What the summary and one item answer on a page with `params`. */
    const read = async (params) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&unread=12&${params}`)
      const answer = async (name, args) => {
        await send({ type: 'query', id: name, name, args })
        const got = posted.find((m) => m.to === name)
        if (!got) return undefined
        return got.error ? { error: got.error } : JSON.parse(got.text)
      }
      return {
        summary: await answer('inbox:summary', {}),
        item: await answer('inbox:item', { org_id: ORG, issue_id: id('4', 0) }),
      }
    }
    expect(await read('inbox=loading')).toEqual({ summary: undefined, item: undefined })
    const failed = await read('inbox=failed')
    expect(failed.summary.error).toContain('fails')
    expect(failed.item.error).toContain('fails')
    expect((await read('inbox=incomplete')).summary).toMatchObject({
      unread_count: 12,
      unread_more: false,
      complete: false,
    })
    expect((await read('inbox=more')).summary).toMatchObject({
      unread_count: 100,
      unread_more: true,
      complete: true,
    })
    const notReady = await read('inbox=notready')
    expect(notReady.summary).toMatchObject({
      seats: [{ org_id: ORG, ready: false }],
      unread_count: 0,
      complete: false,
    })
    expect(notReady.item).toEqual({ state: 'building' })
  })

  it('answers the Inbox feed and the notification calls in the states the page asks for', async () => {
    /** What the feed answers after `after` on a page with `params`, and
        what the notification calls answer. */
    const read = async (params, after = 0) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&unread=12&${params}`)
      await send({ type: 'query', id: 'feed', name: 'inbox:feed', args: { after } })
      const got = posted.find((m) => m.to === 'feed')
      const feed =
        got === undefined ? undefined : got.error ? { error: got.error } : JSON.parse(got.text)
      const call = async (name, args) => {
        await send({ type: 'mutation', id: name, name, args })
        return posted.find((m) => m.id === name)?.value
      }
      return {
        feed,
        beat: await call('notifications:beat', {
          instance: 'tab',
          can_notify: true,
          active: false,
        }),
        claim: await call('notifications:claimAlerts', {
          events: [{ key: 'k', at: 1 }],
          through: 1,
        }),
        summary: await call('notifications:claimSummary', {}),
      }
    }
    const plain = await read('')
    // the twelve unread messages, newest first, with their keys and times
    expect(plain.feed.events).toHaveLength(12)
    expect(plain.feed.more).toBe(false)
    expect(plain.feed.through).toBe(plain.feed.events[0].at)
    expect(plain.beat).toMatchObject({ every_ms: 60_000, live_ms: 180_000 })
    expect(plain.claim).toEqual({ state: 'granted', keys: ['k'], limited: false })
    expect(plain.summary).toEqual({ state: 'none' })
    // a floor past every message answers none, and through is the floor
    const late = Date.parse('2999-01-01T00:00:00.000Z')
    expect((await read('', late)).feed).toEqual({ events: [], through: late, more: false })
    expect((await read('inboxfeed=more')).feed.more).toBe(true)
    expect((await read('inboxfeed=failed')).feed.error).toContain('fails')
    expect((await read('inboxfeed=loading')).feed).toBeUndefined()
    expect((await read('notify=summary')).summary).toEqual({ state: 'summary' })
  })

  it('answers Notification delivery and the leader’s calls in the states the page asks for', async () => {
    /** What settings, setDelivery, beat and end answer on a page with
        `params`, and the settings a watch held after the change. */
    const read = async (params) => {
      const { posted, send } = await server(`tasks=20&latency=0&mbps=100000&${params}`)
      await send({ type: 'query', id: 'settings', name: 'notifications:settings', args: {} })
      const got = posted.find((m) => m.to === 'settings')
      const settings =
        got === undefined ? undefined : got.error ? { error: got.error } : JSON.parse(got.text)
      await send({ type: 'watch', id: 'watched', name: 'notifications:settings', args: {} })
      await new Promise((resolve) => setTimeout(resolve, 5))
      const call = async (name, args) => {
        await send({ type: 'mutation', id: name, name, args })
        const answer = posted.find((m) => m.id === name)
        return answer?.error ? { error: answer.error } : answer?.value
      }
      const beat = await call('notifications:beat', {
        instance: 'tab',
        can_notify: true,
        active: true,
      })
      const set = await call('notifications:setDelivery', { delivery: 'all' })
      const watched = posted
        .filter((m) => m.type === 'transition')
        .flatMap((m) => m.results)
        .filter((r) => r.to === 'watched' && r.text)
        .map((r) => JSON.parse(r.text))
      return {
        settings,
        beat,
        set,
        watched,
        end: await call('notifications:end', { instance: 'tab' }),
      }
    }
    const plain = await read('')
    expect(plain.settings).toEqual({ delivery: 'recent' })
    expect(plain.beat).toMatchObject({ every_ms: 60_000, live_ms: 180_000 })
    expect(plain.set).toEqual({ delivery: 'all' })
    // the watch heard the mode before and after the change
    expect(plain.watched).toEqual([{ delivery: 'recent' }, { delivery: 'all' }])
    expect(plain.end).toBeNull()
    const all = await read('notify=all')
    expect(all.settings).toEqual({ delivery: 'all' })
    expect(all.beat).toMatchObject({ every_ms: 21_600_000 })
    expect((await read('notify=loading')).settings).toBeUndefined()
    expect((await read('notify=error')).settings.error).toContain('fails')
    const limited = await read('notify=demo-limit')
    expect(limited.set).toEqual({
      error: {
        code: 'forbidden',
        message: 'Your demo has reached its change limit. Try again later.',
        reason: 'demo_limit',
      },
    })
    expect(limited.watched).toEqual([{ delivery: 'recent' }])
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

describe('Deleted items on the benchmark page', () => {
  /** A server with page parameters `params`, its snapshot, and a way to ask
      a Deleted items read or write and answer what it posted back. */
  async function deleted(params) {
    const at = await server(`tasks=60&latency=0&mbps=100000&${params}`)
    await at.send({ type: 'query', id: 'snap', name: 'snapshot:forMe', args: {} })
    const snap = JSON.parse(at.posted.find((m) => m.to === 'snap').text)
    let n = 0
    const read = async (name, args = {}) => {
      const id = `read-${n++}`
      await at.send({ type: 'query', id, name, args })
      const answer = at.posted.find((m) => m.to === id)
      return answer.error ? { error: answer.error, data: answer.data } : JSON.parse(answer.text)
    }
    const write = async (name, args) => {
      const id = `write-${n++}`
      await at.send({ type: 'mutation', id, name, args })
      for (let i = 0; i < 50 && !at.posted.some((m) => m.id === id); i++)
        await new Promise((resolve) => setTimeout(resolve, 5))
      return at.posted.find((m) => m.type === 'answer' && m.id === id)
    }
    return { snap, read, write, org: snap.orgs[0].id }
  }

  it('answers the page, the roles and the people from the stand-in', async () => {
    const { read, org } = await deleted('deleted=30&role=admin')
    const first = await read('deletedItems:page')
    // without a scope, the deleted sub-project and the scope note
    expect(first.entries).toHaveLength(1)
    expect(first.scope_needed).toBe(true)
    const all = await read('deletedItems:page', { scope: { org_id: org, all: true } })
    expect(all.entries).toHaveLength(25)
    expect(all.next_cursor).toEqual(expect.any(String))
    const next = await read('deletedItems:page', {
      scope: { org_id: org, all: true },
      cursor: all.next_cursor,
    })
    expect(next.entries).toHaveLength(6)
    expect(await read('deletedItems:roles')).toEqual([
      { org_id: org, org_name: 'Testbed Labs', role: 'admin', can_purge: true },
    ])
    const people = await read('deletedItems:people', { org_id: org })
    expect(people).toMatchObject({ state: 'ready', stopped: false })
    expect(people.rows).toHaveLength(25)
    // anyone but an admin sees their own deletes only
    const mine = await deleted('deleted=30')
    const own = await mine.read('deletedItems:page', { scope: { org_id: mine.org, all: true } })
    expect(own.items.every((row) => row.deleter.you)).toBe(true)
    expect(own.entries.length).toBeLessThan(25)
    // no deleted items by default
    const none = await deleted('')
    expect((await none.read('deletedItems:page')).entries).toEqual([])
  }, 60_000)

  it('holds the second organization of two-orgs in the workspace, its parts and the project picker', async () => {
    const two = await deleted('deleted=5&role=admin&deletedstate=two-orgs')
    // the root names both seats, so the page asks for projects before Deleted by
    const root = await two.read('workspace:root')
    expect(root.orgs.map((o) => o.name)).toEqual(['Testbed Labs', 'Partner Co'])
    expect(root.myProfileIds).toHaveLength(2)
    const partner = root.orgs[1]
    // its parts hold its projects, the root its seat, and the first one's
    // parts neither
    const [projectWindow] = idWindows(startWindows(partner).projects)
    const projects = await two.read('workspace:projects', { org_id: partner.id, ...projectWindow })
    expect(projects.projects.map((p) => p.name)).toEqual(['Partner launch', 'Partner web'])
    expect(root.profiles.filter((p) => p.org_id === partner.id).map((p) => p.id)).toEqual([
      'perf-partner-seat',
    ])
    const [firstWindow] = idWindows(startWindows(root.orgs[0]).projects)
    const first = await two.read('workspace:projects', { org_id: two.org, ...firstWindow })
    expect(first.projects.length).toBeGreaterThan(0)
    expect(first.projects.some((p) => p.org_id === partner.id)).toBe(false)
    // the project picker offers its project, so its scope can be chosen
    const nav = await two.read('projectNav:page')
    expect(nav.rows.filter((row) => row.org_id === partner.id).map((row) => row.name)).toEqual([
      'Partner launch',
    ])
    // Deleted items reads both, and the scope of Partner Co its own
    const both = await two.read('deletedItems:page')
    expect(new Set(both.items.map((row) => row.org_name))).toEqual(
      new Set(['Testbed Labs', 'Partner Co']),
    )
    const scoped = await two.read('deletedItems:page', { scope: { org_id: partner.id, all: true } })
    expect(scoped.items.map((row) => row.title)).toEqual(['Partner web'])
    // without it the workspace holds one organization
    const one = await deleted('deleted=5&role=admin')
    expect((await one.read('workspace:root')).orgs).toHaveLength(1)
  }, 60_000)

  it('answers the forced states the page asks for, and a restore that changes the page', async () => {
    const wide = await deleted('deleted=30&deletedstate=too-wide')
    expect(
      await wide.read('deletedItems:page', { scope: { org_id: wide.org, all: true } }),
    ).toMatchObject({ entries: [], too_wide: true })
    const notes = await deleted('deleted=30&deletedstate=missing-matches,legacy,stopped')
    const noted = await notes.read('deletedItems:page', { scope: { org_id: notes.org, all: true } })
    expect(noted).toMatchObject({ missing: 'matches', legacy: true })
    expect(noted.entries).toHaveLength(10)
    expect(noted.next_cursor).toEqual(expect.any(String))
    const hidden = await deleted('deleted=5&role=admin&deletedstate=hidden')
    const shown = await hidden.read('deletedItems:page', {
      scope: { org_id: hidden.org, all: true },
    })
    const task = shown.items.find((row) => row.kind === 'task')
    expect(task).toMatchObject({ title: '', hidden: true })
    const failing = await deleted('deleted=5&deletedstate=error')
    expect((await failing.read('deletedItems:page')).error).toContain('failed')
    // the second write is refused whole, with its data
    const refusing = await deleted('deleted=30&role=admin&deletedstate=refuse-at-2')
    const page = await refusing.read('deletedItems:page', {
      scope: { org_id: refusing.org, all: true },
    })
    const ids = page.entries.map((e) => e.item_id)
    const restored = await refusing.write('deletedItems:restore', {
      org_id: refusing.org,
      ids: ids.slice(0, 25),
    })
    expect(restored.value.restored).toHaveLength(25)
    const after = await refusing.read('deletedItems:page', {
      scope: { org_id: refusing.org, all: true },
    })
    expect(after.entries.some((e) => ids.slice(0, 25).includes(e.item_id))).toBe(false)
    const refused = await refusing.write('deletedItems:restore', {
      org_id: refusing.org,
      ids: after.entries.map((e) => e.item_id),
    })
    expect(refused.error).toMatchObject({ code: 'rule' })
    // Delete now's count past its bound, and failing
    const counts = async (state) => {
      const at = await deleted(`deleted=5&role=admin&deletedstate=${state}`)
      const project = (await at.read('deletedItems:page')).entries[0].item_id
      return at.read('deletedItems:purgeSummary', { id: project })
    }
    expect(await counts('purge-at-least')).toEqual({ along: 1000, exact: false })
    expect((await counts('purge-failed')).error).toContain('failed')
    const pausing = await deleted('deleted=5&role=admin&deletedstate=pause-at-2')
    const any = (
      await pausing.read('deletedItems:page', { scope: { org_id: pausing.org, all: true } })
    ).entries[0].item_id
    await pausing.write('deletedItems:purge', { org_id: pausing.org, ids: [any] })
    const paused = await pausing.write('deletedItems:purge', { org_id: pausing.org, ids: [any] })
    expect(paused.error).toMatchObject({ code: 'paused' })
  }, 60_000)
})

describe('files on the benchmark page', () => {
  /* What files:mintUrls answers for `args` on a server of `params`. */
  async function mint(params, args) {
    const { posted, send } = await server(`latency=0&mbps=100000&${params}`)
    await send({ type: 'query', id: 'm', name: 'files:mintUrls', args })
    const result = posted.find((message) => message.type === 'result' && message.to === 'm')
    return result.error ? { error: result.error, data: result.data } : JSON.parse(result.text)
  }

  it('gives the share of people a picture asks for, and the first task the images it asks for', async () => {
    const { snapshot } = await snapshotOf('tasks=20&people=1000&pictures=1&images=100&bigimages=3')
    const people = snapshot.profiles.filter((p) => p.kind === 'person')
    expect(people).toHaveLength(1000)
    expect(people.every((p) => p.avatar_storage_id)).toBe(true)
    expect(new Set(people.map((p) => p.avatar_storage_id)).size).toBe(1000)
    const half = (await snapshotOf('tasks=20&people=100&pictures=0.5')).snapshot
    expect(half.profiles.filter((p) => p.avatar_storage_id)).toHaveLength(50)
    const none = (await snapshotOf('tasks=20')).snapshot
    expect(none.profiles.some((p) => p.avatar_storage_id)).toBe(false)
    const first = snapshot.issues.find((row) => row.num === 1)
    const images = snapshot.attachments.filter((a) => a.issue_id === first.id && a.inline)
    expect(images).toHaveLength(100)
    expect(images.filter((a) => a.mime === 'image/png')).toHaveLength(3)
    const shown = [...first.description.matchAll(/!\[[^\]]*\]\(att:([^)]+)\)/g)].map((m) => m[1])
    expect(shown).toEqual(images.map((a) => a.id))
    // text between the images, one a paragraph, inside the description's
    // 20,000 characters, past which the app shows it as plain text
    expect(first.description.split('\n\n')).toHaveLength(200)
    expect(first.description.length).toBeLessThanOrEqual(20_000)
  })

  it('answers files:mintUrls with perf.invalid URLs for what the workspace holds, pictures with their version', async () => {
    const params = 'tasks=20&people=10&pictures=0.5&images=2&bigimages=1'
    const { snapshot } = await snapshotOf(params)
    const images = snapshot.attachments.filter(
      (a) => a.name.startsWith('survey-') || a.name.startsWith('bench-photo-'),
    )
    const big = images.find((a) => a.mime === 'image/png')
    const photo = images.find((a) => a.mime === 'image/webp')
    const pictured = snapshot.profiles.filter((p) => p.avatar_storage_id)
    const bare = snapshot.profiles.find((p) => !p.avatar_storage_id)
    const answer = await mint(params, {
      attachment_ids: [big.id, photo.id, 'unknown-file'],
      profile_ids: [...pictured.map((p) => p.id), bare.id, 'unknown-person'],
    })
    expect(Object.keys(answer.attachments).sort()).toEqual([big.id, photo.id].sort())
    expect(answer.attachments[big.id].url).toContain('size=big')
    expect(answer.attachments[photo.id].url).toMatch(/^https:\/\/perf\.invalid\/files\//)
    expect(Object.keys(answer.avatars).sort()).toEqual(pictured.map((p) => p.id).sort())
    for (const p of pictured)
      expect(new URL(answer.avatars[p.id].url).searchParams.get('v')).toBe(p.avatar_storage_id)
  })

  it('refuses files:mintUrls past 100 attachments or 1,000 pictures, as the server does', async () => {
    const tooMany = await mint('tasks=20', {
      attachment_ids: Array.from({ length: 101 }, (_, n) => `file-${n}`),
    })
    expect(tooMany.data).toEqual({
      code: 'bad_request',
      message: 'attachment_ids must name at most 100 attachments',
    })
    const pictures = await mint('tasks=20', {
      profile_ids: Array.from({ length: 1001 }, (_, n) => `person-${n}`),
    })
    expect(pictures.data?.message).toBe('profile_ids must name at most 1000 profiles')
    const atCap = await mint('tasks=20', {
      profile_ids: Array.from({ length: 1000 }, (_, n) => `person-${n}`),
    })
    expect(atCap).toEqual({ attachments: {}, avatars: {} })
  })

  it('serves valid PNGs of the sizes the pictures and images stand for', async () => {
    const { bytesFor, pngOf } = await import('./files.mjs')
    const png = pngOf(4, 3)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(png.readUInt32BE(16)).toBe(4)
    expect(png.readUInt32BE(20)).toBe(3)
    const picture = bytesFor('https://perf.invalid/avatars/p?v=s')
    expect(picture.readUInt32BE(16)).toBe(256)
    expect(picture.length).toBeLessThan(256 * 1024)
    const big = bytesFor('https://perf.invalid/files/f?size=big')
    expect(big.readUInt32BE(16)).toBe(4096)
  })

  it('has the benchmark driver serve the files a page asks for, and report them', async () => {
    const { servesFiles } = await import('./files.mjs')
    expect(['images=100', '?people=1000&pictures=1', '&bigimages=6'].map(servesFiles)).toEqual([
      true,
      true,
      true,
    ])
    expect(['', 'images=0', 'pictureskept=1000000&tasks=100'].map(servesFiles)).toEqual([
      false,
      false,
      false,
    ])
    const { readFileSync } = await import('node:fs')
    const driver = readFileSync(new URL('../benchmark-browser.mjs', import.meta.url), 'utf8')
    // every page the driver opens takes --files and routes perf.invalid
    // before it loads
    const open = driver.slice(driver.indexOf('async function openPage('))
    const routed = open.indexOf('servesFiles(query + filesQuery) ? await routePerfFiles(page)')
    expect(routed).toBeGreaterThan(0)
    expect(routed).toBeLessThan(open.indexOf('await page.goto('))
    expect(open).toMatch(/\$\{query\}\$\{filesQuery\}`/)
    // each sample records what the page served before it closes
    expect(driver.match(/opened\.recordFiles\(\)\n {2}await context\.close\(\)/g)).toHaveLength(3)
  })
})
