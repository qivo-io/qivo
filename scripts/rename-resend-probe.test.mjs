import { makeFunctionReference } from 'convex/server'
import { describe, expect, it } from 'vitest'
import { parseArgs, partName, verdict, watching, within } from './rename-resend-probe.mjs'

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
    const { live, named, answered } = watching(base)
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
  })
})
