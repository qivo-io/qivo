import { makeFunctionReference } from 'convex/server'
import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { LIMITS } from './limits.mjs'
import {
  authFetcher,
  parseArgs,
  partName,
  probeTitleOf,
  renameAndBack,
  SUFFIX,
  verdict,
  watching,
  within,
} from './rename-resend-probe.mjs'

describe('rename-resend-probe arguments', () => {
  it('takes a target, a fixture person and a task number', () => {
    expect(parseArgs(['--staging'])).toEqual({ target: 'staging', as: 'nora' })
    expect(
      parseArgs(['--local', '--as', 'leo', '--task', '42', '--app-url', 'http://localhost:5252']),
    ).toEqual({
      target: 'local',
      as: 'leo',
      task: 42,
      appUrl: 'http://localhost:5252',
    })
  })

  it('refuses no target, two targets, an unknown person or task and anything else, without repeating a value', () => {
    expect(() => parseArgs([])).toThrow('Choose --staging or --local.')
    expect(() => parseArgs(['--staging', '--local'])).toThrow('Choose either')
    expect(() => parseArgs(['--staging', '--as', 'mallory'])).toThrow('--as takes one of')
    expect(() => parseArgs(['--staging', '--task', '0'])).toThrow('--task takes a task number.')
    expect(() => parseArgs(['--staging', '--task'])).toThrow('--task needs a value.')
    expect(() => parseArgs(['--staging', 'qvt_1111111111'])).toThrow(
      'Unknown argument (not shown, in case it is a secret).',
    )
  })
})

describe('rename-resend-probe verdict', () => {
  it('passes only when the window that holds the task alone sent a new answer', () => {
    expect(verdict(new Map([['w', 10]]), 'w')).toMatchObject({ ok: true })
    expect(verdict(new Map(), 'w')).toMatchObject({
      ok: false,
      line: 'the window that holds the task sent no new answer',
    })
    expect(
      verdict(
        new Map([
          ['w', 10],
          ['inbox', 3],
        ]),
        'w',
      ),
    ).toMatchObject({
      ok: false,
      line: '1 part(s) besides the window that holds the task sent a new answer',
    })
    expect(verdict(new Map([['other', 10]]), 'w')).toMatchObject({ ok: false })
  })

  it('names a window by its bounds and a whole part by its name', () => {
    expect(
      partName({ name: 'workspace:tasks', args: { org_id: 'o', from: '', to: '80000000' } }),
    ).toBe('workspace:tasks [(start), 80000000)')
    expect(
      partName({ name: 'workspace:tasks', args: { org_id: 'o', from: '80000000', to: null } }),
    ).toBe('workspace:tasks [80000000, (end))')
    expect(partName({ name: 'workspace:inbox', args: { org_id: 'o' } })).toBe('workspace:inbox')
  })
})

describe('rename-resend-probe waits', () => {
  it('ends a wait at its deadline or at a signal, and passes what settles in time', async () => {
    await expect(within(Promise.resolve(7), 50, 'late')).resolves.toBe(7)
    await expect(within(new Promise(() => {}), 10, 'late')).rejects.toThrow('late')
    const signal = Promise.reject(new Error('stopped by SIGTERM'))
    signal.catch(() => {})
    await expect(within(new Promise(() => {}), 10_000, 'late', signal)).rejects.toThrow(
      'stopped by SIGTERM',
    )
  })

  it('counts the workspace answered only once every part watched now holds an answer', () => {
    const answers = new Map()
    const base = {
      watch: (_ref, args) => ({ token: args.from, stop: () => {} }),
      read: (token) => {
        if (answers.get(token) === 'error') throw new Error('failed')
        return answers.get(token)
      },
    }
    const { live, named, watched, answered } = watching(base)
    const ref = makeFunctionReference('workspace:tasks')
    const window = live.watch(ref, { from: '' })
    answers.set('', { state: 'ok', split: true })
    expect(answered()).toBe(true)
    // the window's pieces load while it serves
    live.watch(ref, { from: 'a' })
    live.watch(ref, { from: 'b' })
    expect(answered()).toBe(false)
    answers.set('a', { state: 'ok' })
    expect(answered()).toBe(false)
    answers.set('b', 'error')
    expect(answered()).toBe(true)
    // a part no longer watched waits for nothing
    window.stop()
    answers.delete('')
    expect(answered()).toBe(true)
    live.watch(ref, { from: 'c' }).stop()
    expect(answered()).toBe(true)
    expect(named.get('a')).toEqual({ name: 'workspace:tasks', args: { from: 'a' } })
    // the window cut in two is no longer counted
    expect(watched()).toEqual(['a', 'b'])
  })

  it('answers no token where the token request fails, and never prints a token', async () => {
    const secrets = []
    const lost = []
    expect(
      await authFetcher(
        async () => 'qvt_1111111111',
        secrets,
        (e) => lost.push(e),
      )(),
    ).toBe('qvt_1111111111')
    expect(secrets).toEqual(['qvt_1111111111'])
    const failing = authFetcher(
      async () => {
        throw new Error('The token request answered 503.')
      },
      secrets,
      (e) => lost.push(e.message),
    )
    await expect(failing()).resolves.toBeNull()
    expect(lost).toEqual(['The token request answered 503.'])
  })
})

describe('rename-resend-probe title', () => {
  it('adds the suffix within the title limit and never splits an emoji', () => {
    expect(probeTitleOf('Ship it')).toBe(`Ship it${SUFFIX}`)
    const max = LIMITS.title.max - SUFFIX.length
    const long = `${'a'.repeat(max - 1)}😀 and more`
    const probe = probeTitleOf(long)
    expect(probe).toBe(`${'a'.repeat(max - 1)}${SUFFIX}`)
    expect(probe.length).toBeLessThanOrEqual(LIMITS.title.max)
    expect(probeTitleOf('b'.repeat(max + 5))).toBe(`${'b'.repeat(max)}${SUFFIX}`)
  })
})

describe('rename-resend-probe put-back', () => {
  const original = 'Ship it'
  const probeTitle = 'Ship it (rename probe)'
  const refused = (reason) => new ConvexError({ code: 'conflict', message: 'Refused.', reason })
  const theirs = (error) => error?.data?.reason === 'field_changed'
  /* renameAndBack over `steps`, one for each change: what the change does
     after `landed` or instead of it. Answers the writes, what was left to
     put back after each write was sent, and what is left at the end. */
  async function run(steps) {
    const left = { write: null }
    const writes = []
    const leftWhileSent = []
    const reports = []
    const result = await renameAndBack({
      original,
      probeTitle,
      left,
      theirs,
      report: (label) => reports.push(label),
      change: async (title, seen, landed) => {
        writes.push({ title, seen })
        leftWhileSent.push(left.write)
        const step = steps[writes.length - 1]
        if (step.before) throw step.before
        landed()
        if (step.after) throw step.after
        return { resent: new Map(), ms: 1 }
      },
    }).then(
      () => null,
      (error) => error,
    )
    return { error: result, writes, leftWhileSent, reports, left: left.write }
  }
  const back = { title: original, seen: probeTitle }

  it('writes over the title it replaces, owes the put-back from before the first write, and owes nothing once the rename back landed', async () => {
    const r = await run([{}, {}])
    expect(r.error).toBeNull()
    expect(r.writes).toEqual([{ title: probeTitle, seen: original }, back])
    expect(r.leftWhileSent).toEqual([back, back])
    expect(r.reports).toEqual(['Rename', 'Rename back'])
    expect(r.left).toBeNull()
    // a signal while the rename back settles: it landed, nothing to put back
    expect((await run([{}, { after: new Error('stopped by SIGINT') }])).left).toBeNull()
  })

  it('still owes the put-back where a write may have landed', async () => {
    // the first rename timed out, or stopped while it settled
    for (const step of [
      { before: new Error('The rename was not confirmed in time.') },
      { after: new Error('stopped by SIGTERM') },
    ]) {
      const r = await run([step])
      expect(r.error).toBeInstanceOf(Error)
      expect(r.left).toEqual(back)
    }
    // the rename back timed out, or was refused for another reason
    for (const before of [new Error('The rename was not confirmed in time.'), refused()])
      expect((await run([{}, { before }])).left).toEqual(back)
  })

  it('owes nothing where a refusal shows the title is not the probe’s, and says the title was not changed', async () => {
    const forbidden = await run([{ before: refused() }])
    expect(forbidden.left).toBeNull()
    expect(forbidden.writes).toHaveLength(1)
    expect(forbidden.error.message).toBe(
      'the rename was refused (Refused.); the title was not changed',
    )
    const first = await run([{ before: refused('field_changed') }])
    expect(first.left).toBeNull()
    expect(first.error.message).toMatch(/^someone else renamed the task meanwhile/)
    // their rename landed between the probe's two
    const second = await run([{}, { before: refused('field_changed') }])
    expect(second.left).toBeNull()
    expect(theirs(second.error)).toBe(true)
  })
})
