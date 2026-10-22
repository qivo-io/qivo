import { describe, expect, it } from 'vitest'
import { sentence } from '@/lib/fieldLimits'
import { NO_PASSWORD_LOGIN } from '../../convex/lib/email'
import type { PeopleCheck } from './api'
import {
  addressIssue,
  addressMessage,
  cleanAddress,
  conflictMessage,
  createLabel,
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
  it('sends an address as the server stores it, lowercased with a punycode domain', () => {
    const review = reviewPeople(
      [row('Anna Berg', ' Anna@Bücher.DE '), row('Jörn Lie', 'JORN@Example.com')],
      { adminFirst: false, checks: none },
    )
    expect(review.ready).toBe(true)
    expect(review.people.map((p) => p.email)).toEqual(['anna@xn--bcher-kva.de', 'jorn@example.com'])
  })

  it('refuses an address the mail sender cannot send to, and one over 254 characters', () => {
    const long = `${'a'.repeat(64)}@${'b'.repeat(186)}.com`
    expect(long).toHaveLength(255)
    const review = reviewPeople([row('A', 'a@b.c, d@e.f'), row('B', long)], {
      adminFirst: false,
      checks: none,
    })
    expect(review.ready).toBe(false)
    expect(review.issues).toEqual([
      { message: 'Enter a full email address.', field: 'email', incomplete: true },
      {
        message: 'An email address must be at most 254 characters. Use a shorter address.',
        field: 'email',
        incomplete: false,
      },
    ])
  })

  it('refuses an address a password login cannot use, and says why', () => {
    const review = reviewPeople(
      [row('Ivan Petrov', 'ivan@правительство.рф'), row('Jørn Lie', 'jørn@example.no')],
      { adminFirst: false, checks: none },
    )
    expect(review.ready).toBe(false)
    const refused = { message: sentence(NO_PASSWORD_LOGIN), field: 'email', incomplete: true }
    expect(review.issues).toEqual([refused, refused])
  })

  it('refuses a name over 80 characters at once, and keeps it whole', () => {
    const review = reviewPeople([row('n'.repeat(81), 'elin@x.io')], {
      adminFirst: false,
      checks: none,
    })
    expect(review.issues).toEqual([
      {
        message: 'A name must be at most 80 characters. Shorten it.',
        field: 'name',
        incomplete: false,
      },
    ])
    expect(review.people[0].name).toHaveLength(81)
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
  it('lowercases typing and keeps an address over 40 characters, refused with its sentence', () => {
    expect(cleanAddress('Halden-Labs')).toBe('halden-labs')
    expect(cleanAddress('a'.repeat(45))).toHaveLength(45)
    expect(addressIssue('a'.repeat(40))).toBe('')
    expect(addressIssue('a'.repeat(41))).toBe(
      'An organization address must be at most 40 characters of lowercase letters, digits and single hyphens between them. Choose another address.',
    )
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
