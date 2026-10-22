/* Write conflicts on REST and MCP (machine/registry.ts retryConflicts).
 *
 *   1. Only Convex's report of a mutation that gave up on a write conflict
 *      counts as one, and only its report of a mutation that ran out of
 *      execution time as a time out. Any other failure, a refusal quoting
 *      that text included, is never retried, because it may have come after
 *      a commit.
 *   2. A conflicted or timed out write runs again, at most twice, after a
 *      random wait, and a time out that persists says so.
 *   3. Over HTTP a comment whose fan-out write conflicts is posted exactly
 *      once after a retry. A conflict that outlasts the retries changes
 *      nothing and answers REST 503 with Retry-After, and the MCP tool's
 *      error result. A time out that persists answers the same way with its
 *      own sentence. A conflict before dispatch answers 503 on both, and
 *      any other failure there answers MCP's JSON 500 with CORS.
 *   4. attach_text_file, the one write tool that runs an action, retries
 *      its attach the same way and deletes the stored text when the
 *      conflict outlasts the retries.
 *   5. The answer's sentence and wait are pinned, and the public docs quote
 *      them.
 *   6. The attachment upload URL, whose POSTs all write one ticket, retries
 *      its claim, record and cleanup the same way. A conflict that outlasts
 *      the retries stores nothing, frees the URL and answers 503 with
 *      Retry-After, and a cleanup that keeps failing is logged.
 *
 * Convex's conflicts cannot happen in convex-test, which runs one
 * transaction at a time, so the comment fan-out, the ingress count, the
 * attach and the upload URL's mutations throw Convex's message for as many
 * calls as `faults` asks. The throw rolls the transaction back like the real
 * failure. */
/// <reference types="vite/client" />

import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { internal } from '../_generated/api'
import type { Doc } from '../_generated/dataModel'
import type { Refusal } from '../lib/functions'
import { badRequest } from '../lib/functions'
import { sha256hex } from '../machine/auth'
import {
  CONFLICT_RETRIES,
  isMutationTimeout,
  isWriteConflict,
  retryConflicts,
} from '../machine/registry'
import {
  INTERNAL_ERROR,
  WRITE_CONFLICT,
  WRITE_CONFLICT_MESSAGE,
  WRITE_CONFLICT_RETRY_AFTER,
  WRITE_TIMEOUT_MESSAGE,
} from '../machine/shared'
import { UPLOAD_URL_USED } from '../model/attachments'
import { NOW, newT, type OrgFixture, plantIssue, type T, uuid, withOrg } from './helpers.setup'

/* What ctx.runMutation rejects with when a mutation kept conflicting on a
 * table, worded as the local backend reported it for two parallel comment
 * posts (the document id made low-entropy). */
const USER_CONFLICT =
  'Documents read from or written to the "messages" table changed while this mutation was ' +
  'being run and on every subsequent retry. Another call to this mutation changed the document ' +
  'with ID "m1111111111111111111111111111111". See https://docs.convex.dev/error#1'

/* The same failure on a system table. */
const SYSTEM_CONFLICT =
  'Data read or written in this mutation changed while it was being run. Consider reducing the ' +
  'amount of data read by using indexed queries with selective index range expressions ' +
  '(https://docs.convex.dev/database/indexes/).'

/* What ctx.runMutation rejects with when a mutation ran past its 1 s
 * execution time, as the local backend reported it for a mutation retried
 * on conflicts while busy. */
const TIMEOUT = 'Function execution timed out (maximum duration: 1s)\n'

/* How many of the next calls of each faulty write throw, and with what. */
const faults = vi.hoisted(() => ({
  comment: 0,
  commentError: '',
  ingress: [] as unknown[],
  attach: 0,
  claim: 0,
  finish: 0,
  abandon: 0,
}))

/* Wraps `write` so that its next `faults[key]` calls throw USER_CONFLICT. */
const faulty =
  <A extends unknown[], R>(key: 'claim' | 'finish' | 'abandon', write: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    if (faults[key] > 0) {
      faults[key]--
      throw new Error(USER_CONFLICT)
    }
    return await write(...a)
  }

// A post's fan-out runs after its insert, so a throw there undoes the comment.
vi.mock('../model/messages', async (importOriginal) => {
  const real = await importOriginal<typeof import('../model/messages')>()
  return {
    ...real,
    notifyCommentInsert: async (...a: Parameters<typeof real.notifyCommentInsert>) => {
      if (faults.comment > 0) {
        faults.comment--
        throw new Error(faults.commentError || USER_CONFLICT)
      }
      return await real.notifyCommentInsert(...a)
    },
  }
})

vi.mock('../model/attachments', async (importOriginal) => {
  const real = await importOriginal<typeof import('../model/attachments')>()
  return {
    ...real,
    attachFileCore: async (...a: Parameters<typeof real.attachFileCore>) => {
      if (faults.attach > 0) {
        faults.attach--
        throw new Error(SYSTEM_CONFLICT)
      }
      return await real.attachFileCore(...a)
    },
    // wrapped at call time, since the mock runs before `faulty` is defined
    beginTicketUpload: (...a: Parameters<typeof real.beginTicketUpload>) =>
      faulty('claim', real.beginTicketUpload)(...a),
    finishTicketUpload: (...a: Parameters<typeof real.finishTicketUpload>) =>
      faulty('finish', real.finishTicketUpload)(...a),
    abandonTicketUpload: (...a: Parameters<typeof real.abandonTicketUpload>) =>
      faulty('abandon', real.abandonTicketUpload)(...a),
  }
})

vi.mock('../model/billingUsage', async (importOriginal) => {
  const real = await importOriginal<typeof import('../model/billingUsage')>()
  return {
    ...real,
    consumeIngress: async (...a: Parameters<typeof real.consumeIngress>) => {
      const fault = faults.ingress.shift()
      if (fault !== undefined) throw fault
      return await real.consumeIngress(...a)
    },
  }
})

const SECRET = `qva_${'conflicts1'.repeat(5)}`

beforeEach(() => {
  faults.comment = 0
  faults.commentError = ''
  faults.ingress = []
  faults.attach = 0
  faults.claim = 0
  faults.finish = 0
  faults.abandon = 0
  // the shortest waits, 100 ms and then 200 ms
  vi.spyOn(Math, 'random').mockReturnValue(0)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

/* ---------------------------------------------------- 1. what is a conflict */

describe('isWriteConflict', () => {
  it("matches Convex's reports of a mutation that gave up on a conflict", () => {
    expect(isWriteConflict(new Error(USER_CONFLICT))).toBe(true)
    expect(
      isWriteConflict(
        new Error(
          'Documents read from or written to some table changed while this mutation was being run and on every subsequent retry. See https://docs.convex.dev/error#1',
        ),
      ),
    ).toBe(true)
    expect(isWriteConflict(new Error(SYSTEM_CONFLICT))).toBe(true)
  })

  it('matches nothing else, so a failure that may have committed is never retried', () => {
    for (const e of [
      new Error(TIMEOUT),
      // a refusal, even one quoting the text
      new ConvexError(USER_CONFLICT),
      badRequest(USER_CONFLICT),
      // an error inside a mutation that only quotes it
      new Error(`Uncaught Error: ${USER_CONFLICT}`),
      new Error(
        'Uncaught Error: Too many bytes read in a single function execution (limit: 16777216 bytes).',
      ),
      new Error("Your request couldn't be completed. Try again later."),
      USER_CONFLICT,
      null,
    ]) {
      expect(isWriteConflict(e), String(e)).toBe(false)
    }
  })
})

describe('isMutationTimeout', () => {
  it("matches Convex's report of a query or mutation that ran out of time, and nothing else", () => {
    expect(isMutationTimeout(new Error(TIMEOUT))).toBe(true)
    for (const e of [
      new Error(USER_CONFLICT),
      new ConvexError(TIMEOUT),
      new Error(`Uncaught Error: ${TIMEOUT}`),
      // an action's own limit is longer, and an action may have committed
      new Error('Function execution timed out (maximum duration: 600s)'),
      TIMEOUT,
      null,
    ]) {
      expect(isMutationTimeout(e), String(e)).toBe(false)
    }
  })
})

/* ------------------------------------------------------------- 2. retrying */

describe('retryConflicts', () => {
  /* A write whose first `conflicts` calls fail with USER_CONFLICT. */
  const flaky = (conflicts: number) => {
    let calls = 0
    return vi.fn(async () => {
      calls++
      if (calls <= conflicts) throw new Error(USER_CONFLICT)
      return 'written'
    })
  }

  it('runs a conflicted write again after a wait, up to twice', async () => {
    vi.useFakeTimers()
    try {
      const write = flaky(CONFLICT_RETRIES)
      const done = retryConflicts(write)
      await vi.advanceTimersByTimeAsync(0)
      expect(write).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(99)
      expect(write).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(write).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(200)
      expect(write).toHaveBeenCalledTimes(3)
      expect(await done).toBe('written')
    } finally {
      vi.useRealTimers()
    }
  })

  it('turns a conflict that outlasts the retries into the WRITE_CONFLICT refusal', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const write = flaky(CONFLICT_RETRIES + 1)
    const e = await retryConflicts(write).then(
      () => null,
      (x: unknown) => x,
    )
    expect(write).toHaveBeenCalledTimes(CONFLICT_RETRIES + 1)
    expect(e).toBeInstanceOf(ConvexError)
    expect((e as ConvexError<Refusal>).data).toEqual({
      code: 'conflict',
      message: WRITE_CONFLICT_MESSAGE,
      reason: WRITE_CONFLICT,
    })
    expect(log).toHaveBeenCalledWith(new Error(USER_CONFLICT))
  })

  it('retries a time out the same way, and says so when it persists', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let calls = 0
    const write = vi.fn(async () => {
      calls++
      if (calls <= CONFLICT_RETRIES) throw new Error(TIMEOUT)
      return 'written'
    })
    expect(await retryConflicts(write)).toBe('written')
    const stuck = vi.fn(async () => {
      throw new Error(TIMEOUT)
    })
    const e = await retryConflicts(stuck).then(
      () => null,
      (x: unknown) => x,
    )
    expect(stuck).toHaveBeenCalledTimes(CONFLICT_RETRIES + 1)
    expect((e as ConvexError<Refusal>).data).toEqual({
      code: 'conflict',
      message: WRITE_TIMEOUT_MESSAGE,
      reason: WRITE_CONFLICT,
    })
    expect(log).toHaveBeenCalledWith(new Error(TIMEOUT))
  })

  it('rethrows any other failure at once', async () => {
    for (const failure of [new Error('Uncaught Error: limit'), badRequest('refused')]) {
      const write = vi.fn(async () => {
        throw failure
      })
      await expect(retryConflicts(write)).rejects.toBe(failure)
      expect(write).toHaveBeenCalledTimes(1)
    }
  })
})

/* ------------------------------------------------------------ 3. over HTTP */

type Fx = OrgFixture & { t: T; task: Doc<'issues'> }

/* withOrg, with the agent holding Edit on TBED and an agent key, and a task
 * in FW. */
async function setup(): Promise<Fx> {
  const t = newT()
  const f = await withOrg(t)
  const key_hash = await sha256hex(SECRET)
  await t.run(async (ctx) => {
    await ctx.db.insert('project_access', {
      project_id: f.meta.id,
      profile_id: f.agent.id,
      level: 'user',
    })
    await ctx.db.insert('agent_keys', {
      id: uuid(),
      profile_id: f.agent.id,
      name: 'Conflicts',
      key_prefix: SECRET.slice(0, 11),
      key_hash,
      created_at: NOW,
    })
  })
  const task = await plantIssue(t, { org_id: f.org.id, project_id: f.sub.id, title: 'Busy thread' })
  return { t, ...f, task }
}

type Wire = { status: number; headers: Headers; json: unknown }

async function send(fx: Fx, path: string, body: unknown, headers = {}): Promise<Wire> {
  const http = fx.t as unknown as {
    fetch(
      path: string,
      init: { method: string; headers: Record<string, string>; body: string },
    ): Promise<Response>
  }
  const res = await http.fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, headers: res.headers, json: text === '' ? null : JSON.parse(text) }
}

const restPost = (fx: Fx, body: string) =>
  send(fx, `/v1/tasks/QN-${fx.task.num}/comments`, { body })

/* One modern-leg tools/call of add_comment. */
const mcpPost = (fx: Fx, body: string) =>
  send(
    fx,
    '/mcp',
    {
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'add_comment',
        arguments: { ref: `QN-${fx.task.num}`, body },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'conflicts', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      id: 1,
    },
    {
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'add_comment',
    },
  )

/* The bodies of the task's comments. */
const stored = (fx: Fx) =>
  fx.t.run(async (ctx) => {
    const comments = await ctx.db
      .query('comments')
      .withIndex('by_issue', (q) => q.eq('issue_id', fx.task.id))
      .collect()
    return { bodies: comments.map((c) => c.body) }
  })

describe('a comment whose write conflicts', () => {
  it('is posted once after a retry on REST and MCP', async () => {
    const fx = await setup()
    faults.comment = CONFLICT_RETRIES
    expect(await restPost(fx, 'Over REST')).toMatchObject({ status: 201 })
    faults.comment = 1
    const mcp = await mcpPost(fx, 'Over MCP')
    expect(mcp.status).toBe(200)
    expect((mcp.json as { result: { isError?: true } }).result.isError).toBeUndefined()
    expect(faults.comment).toBe(0)
    expect(await stored(fx)).toEqual({ bodies: ['Over REST', 'Over MCP'] })
  })

  it('changes nothing and answers REST 503 with Retry-After when the conflict persists', async () => {
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    faults.comment = CONFLICT_RETRIES + 1
    const res = await restPost(fx, 'Lost in the crowd')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe(String(WRITE_CONFLICT_RETRY_AFTER))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.json).toEqual({ error: WRITE_CONFLICT_MESSAGE })
    expect(faults.comment).toBe(0)
    expect(await stored(fx)).toEqual({ bodies: [] })
    // sending it again posts it
    expect(await restPost(fx, 'Lost in the crowd')).toMatchObject({ status: 201 })
    expect(await stored(fx)).toEqual({ bodies: ['Lost in the crowd'] })
  })

  it('changes nothing and answers 503 with its own sentence when the write keeps timing out', async () => {
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    faults.commentError = TIMEOUT
    faults.comment = CONFLICT_RETRIES + 1
    const res = await restPost(fx, 'Too slow')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe(String(WRITE_CONFLICT_RETRY_AFTER))
    expect(res.json).toEqual({ error: WRITE_TIMEOUT_MESSAGE })
    faults.comment = CONFLICT_RETRIES + 1
    const mcp = await mcpPost(fx, 'Too slow')
    expect((mcp.json as { result: unknown }).result).toMatchObject({
      content: [{ type: 'text', text: WRITE_TIMEOUT_MESSAGE }],
      isError: true,
    })
    expect(await stored(fx)).toEqual({ bodies: [] })
    // one that clears within the retries posts the comment once
    faults.comment = CONFLICT_RETRIES
    expect(await restPost(fx, 'Too slow')).toMatchObject({ status: 201 })
    expect(await stored(fx)).toEqual({ bodies: ['Too slow'] })
  })

  it("changes nothing and answers the MCP tool's error result when the conflict persists", async () => {
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    faults.comment = CONFLICT_RETRIES + 1
    const res = await mcpPost(fx, 'Lost in the crowd')
    expect(res.status).toBe(200)
    expect((res.json as { result: unknown }).result).toMatchObject({
      content: [{ type: 'text', text: WRITE_CONFLICT_MESSAGE }],
      isError: true,
    })
    expect(await stored(fx)).toEqual({ bodies: [] })
  })
})

describe('a failure before dispatch', () => {
  it('answers 503 with Retry-After on REST and MCP when a write there keeps conflicting', async () => {
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const post of [restPost, mcpPost]) {
      faults.ingress = Array.from({ length: CONFLICT_RETRIES + 1 }, () => new Error(USER_CONFLICT))
      const res = await post(fx, 'Never sent')
      expect(res.status).toBe(503)
      expect(res.headers.get('Retry-After')).toBe(String(WRITE_CONFLICT_RETRY_AFTER))
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
      expect(res.json).toEqual({ error: WRITE_CONFLICT_MESSAGE })
      faults.ingress = Array.from({ length: CONFLICT_RETRIES + 1 }, () => new Error(TIMEOUT))
      expect((await post(fx, 'Never sent')).json).toEqual({ error: WRITE_TIMEOUT_MESSAGE })
    }
    // a conflict that clears within the retries does not show
    faults.ingress = [new Error(SYSTEM_CONFLICT)]
    expect(await mcpPost(fx, 'Sent')).toMatchObject({ status: 200 })
    expect(await stored(fx)).toEqual({ bodies: ['Sent'] })
  })

  it("answers MCP's JSON 500 with CORS for any other failure, and logs it", async () => {
    const fx = await setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error(
      'Uncaught Error: at async handler (../../convex/billingMetering.ts:9:3)',
    )
    faults.ingress = [failure]
    const res = await mcpPost(fx, 'Never sent')
    expect(res.status).toBe(500)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Content-Type')).toBe('application/json')
    expect(res.json).toEqual({ error: INTERNAL_ERROR })
    expect(log).toHaveBeenCalledWith(failure)
    expect(await stored(fx)).toEqual({ bodies: [] })
  })
})

/* ----------------------------------------------------- 4. attach_text_file */

describe('attach_text_file', () => {
  const attachText = (fx: Fx) =>
    fx.t.action(internal.machine.records.mcpAttachTextFile, {
      callerId: fx.agent.id,
      access: 'write',
      ref: fx.task.id,
      name: 'notes.txt',
      text: 'Calibrated at 3.5 C',
    })

  const files = (fx: Fx) =>
    fx.t.run(async (ctx) => ({
      stored: (await ctx.db.system.query('_storage').collect()).length,
      attached: (await ctx.db.query('issue_attachments').collect()).length,
    }))

  it('retries a conflicted attach, and deletes the text when the conflict persists', async () => {
    // the answer carries a download link, which this signs
    vi.stubEnv('BETTER_AUTH_SECRET', 'write-conflicts-files-secret')
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    faults.attach = CONFLICT_RETRIES
    expect(JSON.parse(await attachText(fx))).toMatchObject({ name: 'notes.txt' })
    expect(await files(fx)).toEqual({ stored: 1, attached: 1 })

    faults.attach = CONFLICT_RETRIES + 1
    const e = await attachText(fx).then(
      () => null,
      (x: unknown) => x,
    )
    expect((e as ConvexError<Refusal>).data).toMatchObject({ reason: WRITE_CONFLICT })
    expect(faults.attach).toBe(0)
    expect(await files(fx)).toEqual({ stored: 1, attached: 1 })
  })
})

/* ------------------------------------------------------------- 5. the pin */

describe('the write conflict answer', () => {
  it('is the pinned sentence and wait, which the public docs quote', () => {
    expect(WRITE_CONFLICT_MESSAGE).toBe(
      'the request conflicted with other changes made at the same time and changed nothing; send it again',
    )
    expect(WRITE_TIMEOUT_MESSAGE).toBe(
      'the request took too long and changed nothing; send it again, or change less at once if it keeps happening',
    )
    expect(WRITE_CONFLICT_RETRY_AFTER).toBe(1)
    const docs = import.meta.glob(
      ['../../docs/rest-api.md', '../../docs/mcp.md', '../../public/skill.md'],
      {
        eager: true,
        query: '?raw',
        import: 'default',
      },
    ) as Record<string, string>
    expect(Object.keys(docs)).toHaveLength(3)
    for (const [path, text] of Object.entries(docs)) {
      // a wrapped line reads as one space
      const prose = text.replace(/\s+/g, ' ')
      expect(prose, path).toContain(WRITE_CONFLICT_MESSAGE)
      expect(prose, path).toContain(WRITE_TIMEOUT_MESSAGE)
      expect(prose, path).toContain(`Retry-After: ${WRITE_CONFLICT_RETRY_AFTER}`)
    }
  })
})

/* ------------------------------------------------------- 6. the upload URL */

describe('the attachment upload URL', () => {
  /* A ticket for 4 bytes on the task, and the path of its upload URL. */
  const ticket = async (fx: Fx): Promise<string> => {
    const started = await send(fx, `/v1/tasks/QN-${fx.task.num}/attachments`, {
      name: 'notes.txt',
      size: 4,
    })
    expect(started.status).toBe(201)
    const url = new URL((started.json as { upload_url: string }).upload_url)
    return `${url.pathname}${url.search}`
  }

  /* POSTs `size` bytes to the upload URL at `path`. */
  const post = async (fx: Fx, path: string, size = 4): Promise<Wire> => {
    const res = await (
      fx.t as unknown as {
        fetch(
          path: string,
          init: { method: string; headers: Record<string, string>; body: Uint8Array },
        ): Promise<Response>
      }
    ).fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: new Uint8Array(size),
    })
    return { status: res.status, headers: res.headers, json: JSON.parse(await res.text()) }
  }

  const stored = (fx: Fx) =>
    fx.t.run(async (ctx) => (await ctx.db.system.query('_storage').collect()).length)

  it('stores the file after a claim that conflicted within the retries', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'write-conflicts-files-secret')
    const fx = await setup()
    const path = await ticket(fx)
    faults.claim = CONFLICT_RETRIES
    expect(await post(fx, path)).toMatchObject({
      status: 200,
      json: { storageId: expect.any(String) },
    })
    expect(faults.claim).toBe(0)
  })

  it('answers 503 with Retry-After and frees the URL when the claim keeps conflicting', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'write-conflicts-files-secret')
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const path = await ticket(fx)
    faults.claim = CONFLICT_RETRIES + 1
    const res = await post(fx, path)
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBe(String(WRITE_CONFLICT_RETRY_AFTER))
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(res.headers.get('Access-Control-Expose-Headers')).toBe('Retry-After')
    expect(res.json).toEqual({ error: WRITE_CONFLICT_MESSAGE })
    expect(await stored(fx)).toBe(0)
    // sending it again stores the file
    expect(await post(fx, path)).toMatchObject({ status: 200 })
  })

  it('deletes the file, frees the URL and answers 503 when recording it keeps conflicting', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'write-conflicts-files-secret')
    const fx = await setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const path = await ticket(fx)
    faults.finish = CONFLICT_RETRIES + 1
    expect(await post(fx, path)).toMatchObject({
      status: 503,
      json: { error: WRITE_CONFLICT_MESSAGE },
    })
    expect(await stored(fx)).toBe(0)
    expect(await post(fx, path)).toMatchObject({ status: 200 })
    expect(await stored(fx)).toBe(1)
  })

  it('answers the refusal and logs a cleanup that keeps conflicting', async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'write-conflicts-files-secret')
    const fx = await setup()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const path = await ticket(fx)
    // a cleanup that conflicts within the retries still frees the URL
    faults.abandon = CONFLICT_RETRIES
    expect(await post(fx, path, 3)).toMatchObject({
      status: 400,
      json: { error: 'the upload must be exactly the 4 bytes declared' },
    })
    expect(await post(fx, path)).toMatchObject({ status: 200 })
    expect(log).not.toHaveBeenCalled()

    const other = await ticket(fx)
    faults.abandon = CONFLICT_RETRIES + 1
    expect(await post(fx, other, 3)).toMatchObject({ status: 400 })
    // a conflict whose cleanup failed too leaves the URL held, so it does
    // not say to send the POST again
    const third = await ticket(fx)
    faults.finish = CONFLICT_RETRIES + 1
    faults.abandon = CONFLICT_RETRIES + 1
    expect(await post(fx, third)).toMatchObject({
      status: 409,
      json: { error: UPLOAD_URL_USED },
    })
    expect(await post(fx, third)).toMatchObject({ status: 409, json: { error: UPLOAD_URL_USED } })
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ reason: WRITE_CONFLICT }) }),
    )
  })
})
