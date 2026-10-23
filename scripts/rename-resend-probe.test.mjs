import { describe, expect, it } from 'vitest'
import { parseArgs, partName, verdict } from './rename-resend-probe.mjs'

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
