import { describe, expect, it } from 'vitest'
import type { Row } from '../store/rows'
import { shapeUser } from '../store/viewModels'
import { type CreatorCount, creatorName, creatorPhrase, projectRightBox } from './projectCreators'

/* A home-org member as the roster holds it; a standard user who is an active
   person unless `extra` says otherwise. An agent has no login or email. */
const member = (name: string, extra: Partial<Row<'profiles'>> = {}) =>
  shapeUser(
    {
      id: name.toLowerCase(),
      org_id: 'org',
      name,
      initials: name.slice(0, 2).toUpperCase(),
      color: '#335577',
      org_role: 'user',
      active: true,
      kind: 'person',
      auth_user_id: `account-${name}`,
      created_at: '2026-09-14T08:00:00.000Z',
      ...extra,
    },
    [],
    [],
    null,
    false,
  )

/* The extra fields of an agent row: no login, no email. */
const agent = (extra: Partial<Row<'profiles'>> = {}): Partial<Row<'profiles'>> => ({
  kind: 'agent',
  auth_user_id: undefined,
  email: undefined,
  ...extra,
})

/* An answer's line (orgs.projectCreators) for the creators the server
   names, each a person unless it names a known agent, and the others it
   counted. */
const AGENTS = new Set(['Atlas', 'Relay', 'Ledger'])
const answer = (
  named: string[],
  counted: { others?: number; more?: boolean; agents?: number } = {},
): CreatorCount => ({
  creators: named.map((name) => ({ id: name.toLowerCase(), name, agent: AGENTS.has(name) })),
  others: counted.others ?? 0,
  more: counted.more ?? false,
  agents: counted.agents ?? 0,
})
const phrase = (count: CreatorCount) =>
  creatorPhrase(count)
    .map((part) => part.text)
    .join('')

describe('creatorName', () => {
  it('marks agents and leaves people as they are', () => {
    expect(creatorName({ name: 'Atlas', agent: true })).toBe('Atlas (agent)')
    expect(creatorName({ name: 'Leo', agent: false })).toBe('Leo')
  })
})

describe('creatorPhrase', () => {
  it('writes up to three creators in full, agents marked', () => {
    expect(phrase(answer(['Nora']))).toBe('Nora')
    expect(phrase(answer(['Nora', 'Leo']))).toBe('Nora and Leo')
    expect(phrase(answer(['Nora', 'Leo', 'Aisha']))).toBe('Nora, Leo and Aisha')
    expect(phrase(answer(['Nora', 'Leo', 'Atlas']))).toBe('Nora, Leo and Atlas (agent)')
  })

  it('names two and counts the others exactly up to 100', () => {
    expect(phrase(answer(['Nora', 'Leo'], { others: 2 }))).toBe('Nora, Leo and 2 more')
    expect(phrase(answer(['Nora', 'Leo'], { others: 37 }))).toBe('Nora, Leo and 37 more')
    expect(phrase(answer(['Nora', 'Leo'], { others: 100 }))).toBe('Nora, Leo and 100 more')
    // a count is never written as names, nor names as a count
    expect(phrase(answer(['Nora', 'Leo'], { others: 2 }))).not.toBe('Nora and Leo')
  })

  it('says how many of the counted creators are agents', () => {
    expect(phrase(answer(['Nora', 'Leo'], { others: 37, agents: 2 }))).toBe(
      'Nora, Leo and 37 more, including 2 agents,',
    )
    expect(phrase(answer(['Nora', 'Leo'], { others: 2, agents: 1 }))).toBe(
      'Nora, Leo and 2 more, including 1 agent,',
    )
    expect(phrase(answer(['Nora', 'Leo'], { others: 2, agents: 2 }))).toBe('Nora, Leo and 2 agents')
    expect(phrase(answer(['Nora', 'Leo'], { others: 3, agents: 0 }))).not.toContain('agent')
  })

  it('says more than 100 others past the count, never a short count as exact', () => {
    expect(phrase(answer(['Nora', 'Leo'], { others: 100, more: true }))).toBe(
      'Nora, Leo and more than 100 others',
    )
    expect(phrase(answer(['Nora', 'Leo'], { others: 100, more: true, agents: 3 }))).toBe(
      'Nora, Leo and more than 100 others, including at least 3 agents,',
    )
    expect(phrase(answer(['Nora', 'Leo'], { others: 100, more: true, agents: 1 }))).toBe(
      'Nora, Leo and more than 100 others, including at least 1 agent,',
    )
    expect(phrase(answer(['Nora', 'Leo'], { others: 100, more: true }))).not.toContain('100 more')
  })

  it('counts only the creators it does not name', () => {
    expect(phrase(answer(['Atlas', 'Leo'], { others: 2 }))).toBe('Atlas (agent), Leo and 2 more')
    expect(phrase(answer(['Nora', 'Atlas'], { others: 2, agents: 1 }))).toBe(
      'Nora, Atlas (agent) and 2 more, including 1 agent,',
    )
  })

  it('keeps the names apart from the joining words', () => {
    expect(creatorPhrase(answer(['Nora', 'Leo'], { others: 2, agents: 1 }))).toEqual([
      { text: 'Nora', name: true },
      { text: ', ', name: false },
      { text: 'Leo', name: true },
      { text: ' and 2 more, including 1 agent,', name: false },
    ])
    expect(creatorPhrase(answer(['Nora', 'Atlas'])).filter((part) => part.name)).toEqual([
      { text: 'Nora', name: true },
      { text: 'Atlas (agent)', name: true },
    ])
  })
})

describe('projectRightBox', () => {
  it('gives active standard users, people and agents, a checkbox under Selected users', () => {
    expect(projectRightBox(member('Leo'), 'selected')).toBe('editable')
    expect(projectRightBox(member('Mira', { auth_user_id: undefined }), 'selected')).toBe(
      'editable',
    )
    expect(projectRightBox(member('Atlas', agent()), 'selected')).toBe('editable')
  })

  it('gives active org admins a locked one, pending invitations included', () => {
    expect(projectRightBox(member('Nora', { org_role: 'admin' }), 'selected')).toBe('locked')
    const invited = member('Elin', { org_role: 'admin', auth_user_id: undefined })
    expect(projectRightBox(invited, 'selected')).toBe('locked')
  })

  it('gives nobody one under the other settings', () => {
    for (const setting of ['users', 'admins', undefined] as const) {
      expect(projectRightBox(member('Leo'), setting)).toBeNull()
      expect(projectRightBox(member('Nora', { org_role: 'admin' }), setting)).toBeNull()
    }
  })

  it('gives no viewer, Viewer agent, guest or inactive member one', () => {
    for (const extra of [
      { org_role: 'viewer' },
      agent({ org_role: 'viewer' }),
      { org_role: 'guest' },
      { active: false },
      agent({ active: false }),
      { org_role: 'admin', active: false },
    ] as const) {
      expect(projectRightBox(member('Leo', extra), 'selected')).toBeNull()
    }
  })
})
