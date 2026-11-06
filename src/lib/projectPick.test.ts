import { describe, expect, it } from 'vitest'
import { ARCHIVED_SCOPE } from '../../convex/lib/archivedTasks'
import {
  archivedScopeOf,
  covered,
  deletedScopeOf,
  isFixedPick,
  PICK_MOST,
  type PickedProject,
  type PickRules,
  type ProjectPick,
  pickLabel,
  pickRow,
  refusalOf,
  searchScopeOf,
  unpick,
} from './projectPick'

/* The project picker's selection (lib/projectPick.ts): what each press
   picks under each caller's rules, the scopes the two reads take, and the
   trigger's label. Each rule has a case that must refuse or drop. */

const ORG = 'org-testbed'
const OTHER = 'org-partner'
const luma = { id: 'luma', org_id: ORG, name: 'Luma Sensor', num: 2 }
const top = (id: string, name = id, org = ORG, num = 1): PickedProject => ({
  id,
  org_id: org,
  name,
  num,
  parent: null,
})
const sub = (id: string, name = id, parent = luma): PickedProject => ({
  id,
  org_id: parent.org_id,
  name,
  num: 3,
  parent,
})
const LUMA = top('luma', 'Luma Sensor')
const FIRMWARE = sub('fw', 'Firmware')
const ELECTRONICS = sub('el', 'Electronics')
const PORTAL = top('portal', 'Partner portal', OTHER)

const ONE: PickRules = { many: false, oneOrg: false, all: 'every' }
const MANY: PickRules = { many: true, most: PICK_MOST, oneOrg: true, all: 'org' }

/** The pick after pressing `rows` in turn, failing on a refusal. */
function press(rows: PickedProject[], rules = MANY, from: ProjectPick | null = null) {
  let pick = from
  for (const row of rows) {
    const next = pickRow(pick, row, rules)
    if ('refused' in next) throw new Error(`refused ${row.id}: ${next.refused}`)
    pick = next.pick
  }
  return pick
}
const ids = (pick: ProjectPick | null) =>
  pick?.kind === 'projects' ? pick.projects.map((p) => p.id) : pick?.kind

describe('pickRow', () => {
  it('replaces the pick in one mode, whatever the organization', () => {
    expect(ids(press([FIRMWARE, PORTAL], ONE))).toEqual(['portal'])
    expect(ids(press([LUMA], ONE, { kind: 'every' }))).toEqual(['luma'])
  })

  it('narrows a picked project to one of its sub-projects in one mode', () => {
    // a picked project covers its sub-projects only where picks add up
    expect(refusalOf(press([LUMA], ONE), FIRMWARE, ONE)).toBeNull()
    expect(ids(press([LUMA, FIRMWARE], ONE))).toEqual(['fw'])
  })

  it('adds in pick order in many mode and takes a picked row off again', () => {
    const pick = press([ELECTRONICS, FIRMWARE, top('zulu')])
    expect(ids(pick)).toEqual(['el', 'fw', 'zulu'])
    expect(ids(press([FIRMWARE], MANY, pick))).toEqual(['el', 'zulu'])
    // the last one off leaves no pick
    expect(press([FIRMWARE, FIRMWARE])).toBeNull()
  })

  it('refuses the pick past the cap and takes the last one up to it', () => {
    const rules = { ...MANY, most: 3 }
    const pick = press([top('a'), top('b'), top('c')], rules)
    expect(pickRow(pick, top('d'), rules)).toEqual({ refused: 'most' })
    expect(refusalOf(pick, top('d'), rules)).toBe('most')
    // a picked row is never refused, so it can come off at the cap
    expect(refusalOf(pick, top('a'), rules)).toBeNull()
    expect(ids(press([top('a'), top('d')], rules, pick))).toEqual(['b', 'c', 'd'])
  })

  it('refuses another organization under oneOrg, and takes it without', () => {
    const pick = press([FIRMWARE])
    expect(pickRow(pick, PORTAL, MANY)).toEqual({ refused: 'org' })
    const loose = { ...MANY, oneOrg: false }
    expect(ids(press([PORTAL], loose, pick))).toEqual(['fw', 'portal'])
  })

  it('covers the sub-projects of a picked top-level project and drops their picks', () => {
    const pick = press([FIRMWARE, top('zulu'), LUMA])
    // Firmware's pick went, the project's came last
    expect(ids(pick)).toEqual(['zulu', 'luma'])
    expect(covered(pick, ELECTRONICS)).toBe('included')
    expect(covered(pick, LUMA)).toBe('picked')
    expect(covered(pick, top('other'))).toBeNull()
    expect(pickRow(pick, ELECTRONICS, MANY)).toEqual({ refused: 'covered' })
  })

  it('lets a top-level project in at the cap when its sub-projects free the room', () => {
    const rules = { ...MANY, most: 2 }
    const pick = press([FIRMWARE, ELECTRONICS], rules)
    expect(ids(press([LUMA], rules, pick))).toEqual(['luma'])
    expect(pickRow(pick, top('zulu'), rules)).toEqual({ refused: 'most' })
  })

  it('replaces a fixed row with a project and the reverse', () => {
    expect(ids(press([FIRMWARE], MANY, { kind: 'org', org_id: ORG }))).toEqual(['fw'])
    expect(ids(press([FIRMWARE], ONE, { kind: 'every' }))).toEqual(['fw'])
    expect(isFixedPick({ kind: 'org', org_id: ORG }, { kind: 'org', org_id: ORG })).toBe(true)
    expect(isFixedPick({ kind: 'org', org_id: ORG }, { kind: 'org', org_id: OTHER })).toBe(false)
    expect(isFixedPick(press([FIRMWARE]), { kind: 'every' })).toBe(false)
  })

  it('keeps only the navigation fields of a row it picks', () => {
    const row = { ...FIRMWARE, favorite: true, parent_id: 'luma' } as PickedProject
    const pick = press([row])
    expect(pick?.kind === 'projects' && pick.projects[0]).toEqual(FIRMWARE)
  })

  it('takes one project off with unpick and leaves a fixed pick alone', () => {
    expect(ids(unpick(press([FIRMWARE, ELECTRONICS]), 'fw'))).toEqual(['el'])
    expect(unpick(press([FIRMWARE]), 'fw')).toBeNull()
    expect(unpick({ kind: 'every' }, 'fw')).toEqual({ kind: 'every' })
  })
})

describe('the scopes', () => {
  it('gives search.page one organization and at most one project', () => {
    expect(searchScopeOf({ kind: 'every' })).toBeNull()
    expect(searchScopeOf({ kind: 'org', org_id: OTHER })).toEqual({ org_id: OTHER })
    expect(searchScopeOf(press([FIRMWARE], ONE) as ProjectPick)).toEqual({
      org_id: ORG,
      project_id: 'fw',
    })
    // several projects are no scope Search takes
    expect(searchScopeOf(press([FIRMWARE, ELECTRONICS]) as ProjectPick)).toBeUndefined()
  })

  it('gives issues.archivedPage the projects in pick order, or All projects of one organization', () => {
    expect(archivedScopeOf(press([ELECTRONICS, FIRMWARE]) as ProjectPick)).toEqual({
      org: ORG,
      projectIds: ['el', 'fw'],
    })
    expect(archivedScopeOf({ kind: 'org', org_id: ORG })).toEqual({ org: ORG, all: true })
    // every organization at once is never an Archived tasks scope
    expect(archivedScopeOf({ kind: 'every' })).toBeUndefined()
  })

  it('gives deletedItems.page the projects in pick order, or All projects of one organization', () => {
    expect(deletedScopeOf(press([ELECTRONICS, FIRMWARE]) as ProjectPick)).toEqual({
      org_id: ORG,
      project_ids: ['el', 'fw'],
    })
    expect(deletedScopeOf({ kind: 'org', org_id: OTHER })).toEqual({ org_id: OTHER, all: true })
    // Deleted items never reads task entries across every organization
    expect(deletedScopeOf({ kind: 'every' })).toBeUndefined()
  })

  it('caps a pick at the server scope’s own number of ids', () => {
    expect(PICK_MOST).toBe(ARCHIVED_SCOPE.ids)
    // top-level projects, so no project holds more than the design size's 30 sub-projects
    const fifty = press(Array.from({ length: PICK_MOST }, (_, n) => top(`p${n}`)))
    expect(ids(fifty)).toHaveLength(PICK_MOST)
    expect(pickRow(fifty, top('p50'), MANY)).toEqual({ refused: 'most' })
  })
})

describe('pickLabel', () => {
  const orgName = (id: string) => (id === OTHER ? 'Partner Co' : null)
  it('names each kind of pick', () => {
    expect(pickLabel(null, orgName)).toBe('Choose projects…')
    expect(pickLabel({ kind: 'every' }, orgName)).toBe('All projects')
    expect(pickLabel({ kind: 'org', org_id: OTHER }, orgName)).toBe('All projects in Partner Co')
    expect(pickLabel({ kind: 'org', org_id: ORG }, orgName)).toBe('All projects')
    expect(pickLabel(press([LUMA]), orgName)).toBe('Luma Sensor')
    expect(pickLabel(press([FIRMWARE]), orgName)).toBe('Luma Sensor › Firmware')
    expect(pickLabel(press([LUMA, top('a'), top('b')]), orgName)).toBe('Luma Sensor and 2 more')
  })
})
