import { describe, expect, it } from 'vitest'
import {
  bulkName,
  bulkNoticeText,
  bulkStopText,
  bulkUncheckedText,
  type InboxBulk,
} from './inboxBulk'

/* The sentences of a bulk Inbox action (store/inboxBulk.ts): the notice
   names why the action runs in steps, and every sentence names the action
   as its button does. */

const bulk = (over: Partial<InboxBulk>): InboxBulk => ({
  action: 'read',
  state: 'notice',
  long: true,
  why: 'many',
  done: 0,
  seats: 2,
  seatsDone: 0,
  stops: [],
  ...over,
})

const KEEP =
  'Keep Qivo open until it finishes. Closing or reloading Qivo stops it, and the steps already done stay done.'

describe('the keep-open notice', () => {
  it('says why the action runs in steps', () => {
    expect(bulkNoticeText(bulk({ why: 'many' }))).toBe(
      `Mark all as read covers many messages and runs in steps. ${KEEP}`,
    )
    expect(bulkNoticeText(bulk({ why: 'seats', seats: 3 }))).toBe(
      `Mark all as read covers messages in 3 organizations and runs in steps. ${KEEP}`,
    )
    expect(bulkNoticeText(bulk({ action: 'remove', why: 'many' }))).toBe(
      `Remove all read notifications covers many read notifications and runs in steps. ${KEEP}`,
    )
  })

  it('says a press changed nothing when it could not learn how much there is', () => {
    expect(bulkUncheckedText('read')).toBe(
      "Couldn't check how many messages Mark all as read covers, so nothing changed. Try again.",
    )
  })

  it('names each action as its button does', () => {
    expect(bulkName('read')).toBe('Mark all as read')
    expect(bulkName('remove')).toBe('Remove all read notifications')
  })
})

describe('the stop toast', () => {
  it('names the one organization a refusal stopped, with or without work done', () => {
    expect(bulkStopText('read', [{ orgName: 'Northstar', done: 512 }], 'It is read-only.')).toBe(
      'Mark all as read stopped after 512 messages in Northstar. The rest stay unread. It is read-only.',
    )
    expect(bulkStopText('remove', [{ orgName: 'Northstar', done: 0 }], 'It is read-only.')).toBe(
      'Remove all read notifications stopped in Northstar before it removed any notification. They stay in the Inbox. It is read-only.',
    )
  })

  it('lists, for the pause, the organizations where something was done', () => {
    const parts = [
      { orgName: 'Northstar', done: 1200 },
      { orgName: 'Acme', done: 0 },
      { orgName: 'Guest', done: 1 },
    ]
    expect(bulkStopText('read', parts, 'Qivo is offline.')).toBe(
      'Mark all as read stopped after 1,200 messages in Northstar and 1 message in Guest. The rest stay unread. Qivo is offline.',
    )
    expect(
      bulkStopText(
        'read',
        [
          { orgName: 'Northstar', done: 0 },
          { orgName: 'Acme', done: 0 },
        ],
        'Qivo is offline.',
      ),
    ).toBe(
      'Mark all as read stopped before it marked any message. They stay unread. Qivo is offline.',
    )
  })
})
