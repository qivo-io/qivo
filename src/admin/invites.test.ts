import { describe, expect, it } from 'vitest'
import { EMAIL_SHAPE as SERVER_EMAIL_SHAPE } from '../../convex/model/people'
import type { PeopleCheck } from './api'
import {
  addressMessage,
  cleanAddress,
  conflictMessage,
  createLabel,
  EMAIL_SHAPE,
  freeUntil,
  isCompleteRow,
  type PersonDraft,
  reviewPeople,
  sendLabel,
} from './invites'

let nextId = 0
const row = (name: string, email: string, role: PersonDraft['role'] = 'user'): PersonDraft => ({
  id: nextId++,
  name,
  email,
  role,
})
const none = new Map<string, PeopleCheck>()
const messages = (rows: PersonDraft[], adminFirst = false, checks = none) =>
  reviewPeople(rows, { adminFirst, checks }).issues.map((issue) => issue?.message ?? null)

describe('person rows', () => {
  it('uses the server email shape', () => {
    expect(EMAIL_SHAPE.source).toBe(SERVER_EMAIL_SHAPE.source)
    expect(EMAIL_SHAPE.flags).toBe(SERVER_EMAIL_SHAPE.flags)
  })

  it('accepts complete rows and sends them cleaned, ignoring blank rows', () => {
    const review = reviewPeople(
      [
        row('  Elin   Strand ', ' Elin@Brightwater.Studio ', 'admin'),
        row('', '   '),
        row('Tomas Lind', 'tomas@brightwater.studio', 'viewer'),
      ],
      { adminFirst: true, checks: none },
    )
    expect(review.ready).toBe(true)
    expect(review.issues).toEqual([null, null, null])
    expect(review.people).toEqual([
      { name: 'Elin Strand', email: 'elin@brightwater.studio', role: 'admin' },
      { name: 'Tomas Lind', email: 'tomas@brightwater.studio', role: 'viewer' },
    ])
  })

  it('reports half-filled rows as incomplete', () => {
    const review = reviewPeople(
      [row('Elin Strand', ''), row('', 'tomas@brightwater.studio'), row('Aisha', 'aisha@')],
      { adminFirst: false, checks: none },
    )
    expect(review.ready).toBe(false)
    expect(review.issues).toEqual([
      { message: 'Add an email address.', field: 'email', incomplete: true },
      { message: 'Add a name.', field: 'name', incomplete: true },
      { message: 'Enter a full email address.', field: 'email', incomplete: true },
    ])
  })

  it('reports a repeated address on the later row only', () => {
    expect(messages([row('Elin', 'elin@x.io'), row('Elin again', ' ELIN@x.io')])).toEqual([
      null,
      'This address is listed twice.',
    ])
  })

  it('reports addresses that belong elsewhere or already have a seat', () => {
    const checks = new Map<string, PeopleCheck>([
      [
        'tomas@brightwater.studio',
        { email: 'tomas@brightwater.studio', home_org_name: 'Brightwater Studio', in_org: false },
      ],
      ['noah@deadline.co', { email: 'noah@deadline.co', home_org_name: null, in_org: true }],
      ['new@deadline.co', { email: 'new@deadline.co', home_org_name: null, in_org: false }],
    ])
    expect(
      messages(
        [
          row('Tomas', 'tomas@brightwater.studio'),
          row('Noah', 'noah@deadline.co'),
          row('New', 'new@deadline.co'),
        ],
        false,
        checks,
      ),
    ).toEqual([
      'Already belongs to Brightwater Studio, so they can only join as a guest. An org admin can invite them from project settings.',
      'Already has a seat in this organization.',
      null,
    ])
  })

  it('words one checked address for the edit dialog, a seat here first', () => {
    expect(conflictMessage(undefined)).toBe('')
    expect(conflictMessage({ email: 'a@x.io', home_org_name: null, in_org: false })).toBe('')
    expect(conflictMessage({ email: 'a@x.io', home_org_name: 'Halden Labs', in_org: true })).toBe(
      'Already has a seat in this organization.',
    )
    expect(conflictMessage({ email: 'a@x.io', home_org_name: 'Halden Labs', in_org: false })).toBe(
      'Already belongs to Halden Labs, so they can only join as a guest. An org admin can invite them from project settings.',
    )
  })

  it('needs the org admin row filled first when the organization has no admin', () => {
    const rows = [row('', '', 'admin'), row('Tomas', 'tomas@x.io', 'user')]
    expect(messages(rows, true)).toEqual(['Fill in the org admin first.', null])
    expect(messages(rows, false)).toEqual([null, null])
    expect(messages([row('', '', 'admin'), row('Aisha', 'aisha@x.io', 'admin')], true)).toEqual([
      null,
      null,
    ])
  })

  it('lets row 1 unlock Add person only when it has a name and a full address', () => {
    expect(isCompleteRow(row('Elin', 'elin@x.io'))).toBe(true)
    expect(isCompleteRow(row(' ', 'elin@x.io'))).toBe(false)
    expect(isCompleteRow(row('Elin', 'elin@x'))).toBe(false)
  })
})

describe('organization address', () => {
  it('lowercases typing and stops at 40 characters', () => {
    expect(cleanAddress('Halden-Labs')).toBe('halden-labs')
    expect(cleanAddress('a'.repeat(45))).toHaveLength(40)
  })

  it('maps every refusal reason to a sentence', () => {
    expect(addressMessage('slug_taken')).toBe('That address is taken. Choose another.')
    expect(addressMessage('slug_reserved')).toBe('That address is reserved. Choose another.')
    expect(addressMessage('slug_shape')).toBe('Use lowercase letters, digits and single hyphens.')
  })
})

describe('labels and dates', () => {
  it('counts invites in the submit labels', () => {
    expect(createLabel(0)).toBe('Create organization')
    expect(createLabel(1)).toBe('Create and send 1 invite')
    expect(createLabel(3)).toBe('Create and send 3 invites')
    expect(sendLabel(0)).toBe('Send invites')
    expect(sendLabel(1)).toBe('Send 1 invite')
    expect(sendLabel(2)).toBe('Send 2 invites')
  })

  it('ends six months free on the same calendar day, or the month end', () => {
    expect(freeUntil(new Date('2026-10-14T09:30:00.000Z'))).toBe('2027-04-14T09:30:00.000Z')
    expect(freeUntil(new Date('2026-08-31T12:00:00.000Z'))).toBe('2027-02-28T12:00:00.000Z')
    expect(freeUntil(new Date('2026-10-14T09:30:00.000Z'))).not.toBe('2027-04-13T09:30:00.000Z')
  })
})
