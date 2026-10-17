import { describe, expect, it } from 'vitest'
import type { Row } from '../store/rows'
import { shapeUser } from '../store/viewModels'
import { creatorName, creatorPhrase, projectCreatorsIn, projectRightBox } from './projectCreators'

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

const names = (users: { name: string }[]) => users.map((user) => user.name)
const roster3 = [member('Leo'), member('Nora', { org_role: 'admin' }), member('Atlas', agent())]
const phrase = (users: Parameters<typeof creatorPhrase>[0]) =>
  creatorPhrase(users)
    .map((part) => part.text)
    .join('')
/* Creators by name, each a person unless it names a known agent. */
const AGENTS = new Set(['Atlas', 'Relay', 'Ledger'])
const creators = (...list: string[]) =>
  list.map((name) => member(name, AGENTS.has(name) ? agent() : {}))

describe('projectCreatorsIn', () => {
  const roster = [
    member('Leo'),
    member('Nora', { org_role: 'admin' }),
    member('Aisha', { can_create_projects: true }),
    member('Mira', { auth_user_id: undefined, can_create_projects: true }),
    member('Emil', { active: false, can_create_projects: true }),
    member('Ingrid', { org_role: 'viewer', can_create_projects: true }),
    member('Atlas', agent({ can_create_projects: true })),
    member('Relay', agent()),
    member('Ledger', agent({ org_role: 'viewer', can_create_projects: true })),
    member('Gus', { org_role: 'guest' }),
    member('Ola', { org_role: 'admin' }),
  ]

  it('names org admins first, then every active standard user, people and agents alike', () => {
    expect(names(projectCreatorsIn(roster, 'users'))).toEqual([
      'Nora',
      'Ola',
      'Leo',
      'Aisha',
      'Mira',
      'Atlas',
      'Relay',
    ])
  })

  it('names only the selected standard users beside the admins, pending invitations included', () => {
    expect(names(projectCreatorsIn(roster, 'selected'))).toEqual([
      'Nora',
      'Ola',
      'Aisha',
      'Mira',
      'Atlas',
    ])
  })

  it('names only org admins under admins', () => {
    expect(names(projectCreatorsIn(roster, 'admins'))).toEqual(['Nora', 'Ola'])
  })

  it('never names inactive members, viewers, Viewer agents or guests', () => {
    for (const setting of ['users', 'selected'] as const) {
      const left = names(projectCreatorsIn(roster, setting))
      for (const name of ['Emil', 'Ingrid', 'Ledger', 'Gus']) expect(left).not.toContain(name)
    }
  })
})

describe('creatorName', () => {
  it('marks agents and leaves people as they are', () => {
    expect(creatorName(member('Atlas', agent()))).toBe('Atlas (agent)')
    expect(creatorName(member('Leo'))).toBe('Leo')
  })
})

describe('creatorPhrase', () => {
  it('writes up to three creators in full, agents marked', () => {
    expect(phrase(creators('Nora'))).toBe('Nora')
    expect(phrase(creators('Nora', 'Leo'))).toBe('Nora and Leo')
    expect(phrase(creators('Nora', 'Leo', 'Aisha'))).toBe('Nora, Leo and Aisha')
    expect(phrase(projectCreatorsIn(roster3, 'users'))).toBe('Nora, Leo and Atlas (agent)')
  })

  it('cuts four or more to the first two and a count of people', () => {
    expect(phrase(creators('Nora', 'Leo', 'Aisha', 'Mira'))).toBe('Nora, Leo and 2 more')
    expect(phrase(creators('Nora', 'Leo', 'Aisha', 'Mira', 'Daniel', 'Ben'))).toBe(
      'Nora, Leo and 4 more',
    )
  })

  it('says how many of the counted creators are agents', () => {
    expect(phrase(creators('Nora', 'Leo', 'Aisha', 'Atlas'))).toBe(
      'Nora, Leo and 2 more, including 1 agent,',
    )
    expect(phrase(creators('Nora', 'Leo', 'Atlas', 'Aisha', 'Relay'))).toBe(
      'Nora, Leo and 3 more, including 2 agents,',
    )
    expect(phrase(creators('Nora', 'Leo', 'Atlas', 'Relay'))).toBe('Nora, Leo and 2 agents')
  })

  it('counts only the creators it does not name', () => {
    expect(phrase(creators('Atlas', 'Leo', 'Aisha', 'Mira'))).toBe('Atlas (agent), Leo and 2 more')
    expect(phrase(creators('Nora', 'Atlas', 'Relay', 'Aisha'))).toBe(
      'Nora, Atlas (agent) and 2 more, including 1 agent,',
    )
  })

  it('keeps the names apart from the joining words', () => {
    expect(creatorPhrase(creators('Nora', 'Leo', 'Aisha', 'Atlas'))).toEqual([
      { text: 'Nora', name: true },
      { text: ', ', name: false },
      { text: 'Leo', name: true },
      { text: ' and 2 more, including 1 agent,', name: false },
    ])
    expect(creatorPhrase(creators('Nora', 'Atlas')).filter((part) => part.name)).toEqual([
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
