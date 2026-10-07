import { describe, expect, it } from 'vitest'
import { TODAY_WEEK } from '../../src/lib/dates'
import { delayOf } from '../../src/lib/delay'
import { parseMd } from '../../src/lib/md'
import { astToMd } from '../../src/lib/mdSerialize'
import type { LoadSpan } from '../../src/lib/workload'
import {
  assertMarketingAnchor,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingDate,
  marketingId,
  marketingWeek,
} from '../internal/marketingDemoData'
import { taskOwnerId } from '../lib/review'
import { newOrgDefaults } from '../model/orgs'

const { people, teams, projects, issues, labels, links, milestones, comments } = MARKETING_DEMO
const defaultCapacity = newOrgDefaults('2026-09-07T00:00:00.000Z').default_plannable_hours
// Whose week a task's hours count against: the app's one Reviewer rule.
const ownerOf = (i: (typeof issues)[number]) =>
  taskOwnerId({ status: i.status, assignee_id: i.assignee, reviewer_id: i.reviewer })

describe('the versioned Northstar marketing scenario', () => {
  it('keeps the agreed organization, project mix and sole administrator', () => {
    expect(MARKETING_DEMO_VERSION).toBe(7)
    expect(people).toHaveLength(8)
    expect(people.filter((person) => person.role === 'admin').map((person) => person.key)).toEqual([
      'nora',
    ])
    expect(people.filter((person) => person.kind === 'agent').map((person) => person.key)).toEqual([
      'atlas',
    ])
    for (const person of people) expect(person).not.toHaveProperty('capacity')
    expect(projects.filter((project) => !project.parent).map((project) => project.name)).toEqual([
      'Luma Sensor',
      'Luma Cloud',
      'Pilot & Launch',
    ])
    expect(
      ['sensor', 'cloud', 'launch'].map(
        (key) => projects.filter((project) => project.parent === key).length,
      ),
    ).toEqual([5, 4, 3])
    expect(projects.filter((project) => !project.parent).map((project) => project.icon)).toEqual([
      'zap',
      'cloud',
      'rocket',
    ])
    expect(
      projects
        .filter((project) => project.parent)
        .every((project) => !project.icon && !project.color),
    ).toBe(true)
    expect(issues).toHaveLength(90)
    expect(new Set(issues.map((issue) => issue.status))).toEqual(
      new Set(['backlog', 'todo', 'progress', 'review', 'done']),
    )
  })

  it('stamps most humans with a past Team sync and leaves the demo login and the agent without one', () => {
    expect(people.filter((person) => person.syncDay === undefined).map((p) => p.key)).toEqual([
      'nora',
      'atlas',
    ])
    const days = people.flatMap((person) => (person.syncDay === undefined ? [] : [person.syncDay]))
    // Before the anchor only: the public demo's anchor is today's Monday.
    for (const day of days) {
      expect(Number.isSafeInteger(day)).toBe(true)
      expect(day).toBeLessThan(0)
      expect(day).toBeGreaterThanOrEqual(-7)
    }
    // Spread over the previous week's working days, so the headers differ.
    const weekdays = days.map((day) =>
      new Date(`${marketingDate('2026-09-07', day)}T00:00:00Z`).getUTCDay(),
    )
    expect(weekdays.every((weekday) => weekday >= 1 && weekday <= 5)).toBe(true)
    expect(new Set(days).size).toBeGreaterThanOrEqual(4)
  })

  it('dates every hand-off to review, and only reviewed work, in the week before the anchor', () => {
    const parents = new Set(issues.map((issue) => issue.parent).filter(Boolean))
    for (const issue of issues) {
      const leafReview = issue.status === 'review' && !parents.has(issue.key)
      const reviewedDone = issue.status === 'done' && issue.reviewer !== undefined
      expect(issue.reviewDay !== undefined, issue.key).toBe(leafReview || reviewedDone)
      for (const day of [issue.reviewDay, issue.touchedDay]) {
        if (day === undefined) continue
        expect(Number.isSafeInteger(day), issue.key).toBe(true)
        expect(day, issue.key).toBeLessThan(0)
        expect(day, issue.key).toBeGreaterThanOrEqual(-7)
      }
    }
    // a Done task is handed over before it is finished (the seed's Friday 15:00)
    const reviewedDone = issues.filter((i) => i.status === 'done' && i.reviewer !== undefined)
    expect(reviewedDone.length).toBeGreaterThan(0)
    for (const issue of reviewedDone) {
      expect(issue.reviewer, issue.key).not.toBe(issue.assignee)
      expect(issue.reviewDay!, issue.key).toBeLessThan(-3)
    }
  })

  it('has two independently led teams with shared and exclusive members', () => {
    expect(teams).toHaveLength(2)
    expect(teams.map((team) => team.lead)).toEqual(['leo', 'daniel'])
    expect(teams.map((team) => team.name)).toEqual([
      'Northstar Hardware',
      'Northstar Cloud & Launch',
    ])
    for (const team of teams) {
      expect(team.members).toContain(team.lead)
      expect(new Set(team.members).size).toBe(team.members.length)
      expect(team.members.every((key) => people.some((person) => person.key === key))).toBe(true)
      expect(
        team.members.some((key) => teams.every((candidate) => candidate.members.includes(key))),
      ).toBe(true)
      expect(
        team.members.some(
          (key) => teams.filter((candidate) => candidate.members.includes(key)).length === 1,
        ),
      ).toBe(true)
    }
    expect(people.every((person) => teams.some((team) => team.members.includes(person.key)))).toBe(
      true,
    )
    // Teams are sharing groups, not an owning field on either kind of project.
    // An optional fixture hint may choose which explicit team grant receives
    // the stronger `user` level when the demo is seeded.
  })

  it('archives exactly two completed leaf tasks in each main project', () => {
    const archived = issues.filter((issue) => issue.archived)
    expect(archived).toHaveLength(6)
    for (const main of projects.filter((project) => !project.parent)) {
      const childKeys = projects
        .filter((project) => project.parent === main.key)
        .map((project) => project.key)
      expect(archived.filter((issue) => childKeys.includes(issue.project))).toHaveLength(2)
    }
    for (const issue of archived) {
      expect(issue.status).toBe('done')
      expect(issue.parent).toBeUndefined()
      expect(issues.some((child) => child.parent === issue.key)).toBe(false)
    }
  })

  it('gives every task a one-to-five-comment conversation with stable keys and legitimate authors', () => {
    expect(new Set(comments.map((comment) => comment.key)).size).toBe(comments.length)
    for (const issue of issues) {
      const thread = comments.filter((comment) => comment.issue === issue.key)
      expect(thread.length, issue.key).toBeGreaterThanOrEqual(1)
      expect(thread.length, issue.key).toBeLessThanOrEqual(5)
      const project = projects.find((candidate) => candidate.key === issue.project)!
      const root = projects.find((candidate) => candidate.key === project.parent)!
      const team = root.team ? teams.find((candidate) => candidate.key === root.team) : undefined
      for (const comment of thread) {
        expect(comment.key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
        expect(comment.body.trim(), comment.key).not.toBe('')
        expect(Number.isInteger(comment.day), comment.key).toBe(true)
        expect(comment.day, comment.key).toBeGreaterThanOrEqual(-21)
        expect(comment.day, comment.key).toBeLessThan(0)
        const author = people.find((person) => person.key === comment.author)
        expect(author, comment.key).toBeDefined()
        expect(
          author?.role === 'admin' ||
            root.lead === author?.key ||
            (team
              ? team.members.includes(comment.author)
              : teams.some((candidate) => candidate.members.includes(comment.author))),
          `${comment.key}: author must have write access to this task`,
        ).toBe(true)
      }
    }
    expect(comments.every((comment) => issues.some((issue) => issue.key === comment.issue))).toBe(
      true,
    )
  })

  it('contains complete stable references and valid parent/leaf structure', () => {
    for (const rows of [people, teams, projects, issues, labels, milestones, comments]) {
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    }
    expect(new Set(projects.map((project) => project.code)).size).toBe(projects.length)
    const peopleKeys = new Set(people.map((person) => person.key))
    const projectByKey = new Map(projects.map((project) => [project.key, project]))
    const issueByKey = new Map(issues.map((issue) => [issue.key, issue]))
    const labelKeys = new Set(labels.map((label) => label.key))
    const parents = new Set(issues.map((issue) => issue.parent).filter(Boolean))
    // Edit access to the task's project: admin, the root's lead or its team.
    const canHoldWork = (personKey: string, issue: (typeof issues)[number]) => {
      const person = people.find((candidate) => candidate.key === personKey)!
      const project = projectByKey.get(issue.project)!
      const root = project.parent ? projectByKey.get(project.parent)! : project
      const team = root.team ? teams.find((candidate) => candidate.key === root.team) : undefined
      return (
        person.role === 'admin' ||
        root.lead === person.key ||
        (team
          ? team.members.includes(person.key)
          : teams.some((candidate) => candidate.members.includes(person.key)))
      )
    }
    for (const project of projects) {
      expect(project.code).toMatch(/^[A-Z0-9]{1,5}$/)
      expect(peopleKeys.has(project.lead)).toBe(true)
      if (project.parent) {
        expect(projectByKey.has(project.parent)).toBe(true)
        expect(projectByKey.get(project.parent)?.parent).toBeUndefined()
      }
      if (project.team) expect(teams.some((team) => team.key === project.team)).toBe(true)
    }
    for (const issue of issues) {
      expect(projectByKey.get(issue.project)?.parent).toBeTruthy()
      expect([...issue.title].length).toBeLessThanOrEqual(80)
      expect(issue.description).toContain('Acceptance criteria')
      const criteria = parseMd(issue.description).find((block) => block.t === 'ul')
      expect(criteria?.items.length).toBeGreaterThanOrEqual(2)
      if (issue.assignee) {
        expect(peopleKeys.has(issue.assignee)).toBe(true)
        expect(
          canHoldWork(issue.assignee, issue),
          `${issue.key}: assignee must have edit access through leadership or an explicit team share`,
        ).toBe(true)
      }
      if (issue.reviewer) {
        expect(peopleKeys.has(issue.reviewer), issue.key).toBe(true)
        expect(
          canHoldWork(issue.reviewer, issue),
          `${issue.key}: reviewer must have edit access through leadership or an explicit team share`,
        ).toBe(true)
        expect(issue.reviewer, issue.key).not.toBe(issue.assignee)
        expect(parents.has(issue.key), `${issue.key}: a task with subtasks has no reviewer`).toBe(
          false,
        )
      }
      if (issue.reporter) expect(peopleKeys.has(issue.reporter)).toBe(true)
      expect(issue.labels.every((label) => labelKeys.has(label))).toBe(true)
      if (issue.parent) {
        expect(issueByKey.get(issue.parent)?.project).toBe(issue.project)
        expect(issueByKey.get(issue.parent)?.parent).toBeUndefined()
      }
      if (parents.has(issue.key)) {
        expect(issue.remaining).toBeUndefined()
        const children = issues.filter((child) => child.parent === issue.key)
        expect(children.length, issue.key).toBeGreaterThanOrEqual(2)
        expect(children.length, issue.key).toBeLessThanOrEqual(4)
      } else {
        expect(issue.remaining).toBeGreaterThanOrEqual(0)
      }
      if (issue.status === 'done') expect(issue.remaining).toBe(0)
      expect(issue.startWeek === undefined).toBe(issue.endWeek === undefined)
      if (issue.startWeek !== undefined && issue.endWeek !== undefined) {
        expect(Number.isInteger(issue.startWeek) && Number.isInteger(issue.endWeek)).toBe(true)
        expect(issue.startWeek).toBeLessThanOrEqual(issue.endWeek)
        expect(issue.startWeek).toBeGreaterThanOrEqual(-3)
        expect(issue.endWeek).toBeLessThanOrEqual(6)
        if (issue.status === 'done') expect(issue.endWeek).toBeLessThan(0)
      }
      if (issue.status === 'backlog') expect(issue.startWeek).toBeUndefined()
      if (issue.dueDay !== undefined) {
        expect(Number.isInteger(issue.dueDay)).toBe(true)
        if (issue.endWeek !== undefined) {
          expect(issue.endWeek * 7 + 4, issue.key).toBeLessThanOrEqual(issue.dueDay)
        }
      }
    }
    // Review work shows both an owning reviewer and the assignee fallback, and
    // a reviewer outside Review stays in the task window only.
    const inReview = issues.filter((issue) => issue.status === 'review')
    expect(inReview.some((issue) => issue.reviewer)).toBe(true)
    expect(inReview.some((issue) => !issue.reviewer)).toBe(true)
    expect(issues.some((issue) => issue.status !== 'review' && issue.reviewer)).toBe(true)
    for (const milestone of milestones) {
      expect(projectByKey.has(milestone.project)).toBe(true)
      expect(projectByKey.get(milestone.project)?.parent).toBeUndefined()
    }
    for (const comment of comments) {
      expect(issueByKey.has(comment.issue)).toBe(true)
      expect(peopleKeys.has(comment.author)).toBe(true)
      expect(comment.day).toBeLessThan(0)
    }
  })

  it('has acyclic dependencies, unique link pairs and cross-project handoffs', () => {
    const issueByKey = new Map(issues.map((issue) => [issue.key, issue]))
    const pairs = new Set<string>()
    const outgoing = new Map<string, string[]>()
    const blockingOverlaps: string[] = []
    let crossProjectBlocks = 0
    for (const link of links) {
      expect(issueByKey.has(link.source) && issueByKey.has(link.target)).toBe(true)
      expect(link.source).not.toBe(link.target)
      const pair = [link.source, link.target].sort().join(':')
      expect(pairs.has(pair)).toBe(false)
      pairs.add(pair)
      if (link.type !== 'blocks') continue
      outgoing.set(link.source, [...(outgoing.get(link.source) ?? []), link.target])
      const source = issueByKey.get(link.source)!
      const target = issueByKey.get(link.target)!
      const sourceMeta = projects.find((project) => project.key === source.project)?.parent
      const targetMeta = projects.find((project) => project.key === target.project)?.parent
      if (sourceMeta !== targetMeta) crossProjectBlocks++
      if (source.endWeek !== undefined && target.startWeek !== undefined) {
        if (source.endWeek >= target.startWeek) {
          blockingOverlaps.push(`${source.key} -> ${target.key}`)
        }
      }
    }
    expect(crossProjectBlocks).toBeGreaterThanOrEqual(4)
    // End dates include Friday, so dependent work starts in a later week.
    expect(blockingOverlaps).toEqual([])
    const visit = (key: string, path: Set<string>): void => {
      expect(path.has(key), `Dependency cycle at ${key}`).toBe(false)
      const next = new Set([...path, key])
      for (const target of outgoing.get(key) ?? []) visit(target, next)
    }
    for (const issue of issues) visit(issue.key, new Set())
  })

  it('keeps the planned work within each person’s weekly capacity', () => {
    const hoursAt = (person: string, week: number) =>
      issues.reduce((hours, issue) => {
        const { startWeek: start, endWeek: end } = issue
        if (
          ownerOf(issue) !== person ||
          issue.status === 'done' ||
          start === undefined ||
          end === undefined ||
          week < start ||
          week > end
        )
          return hours
        return hours + (issue.remaining ?? 0) / (end - start + 1)
      }, 0)
    const scene = MARKETING_DEMO.demo.capacity
    expect(hoursAt(scene.person, scene.week)).toBe(scene.hours)
    expect(hoursAt(scene.person, scene.followupWeek)).toBe(scene.followupHours)
    const artwork = issues.find((issue) => issue.key === scene.followupIssue)!
    expect(artwork.startWeek).toBe(scene.followupWeek)
    expect(artwork.endWeek).toBe(scene.followupWeek)
    for (const person of people.filter((person) => person.kind === 'person')) {
      for (let week = 0; week <= 6; week++) {
        expect(hoursAt(person.key, week)).toBeLessThanOrEqual(defaultCapacity)
      }
    }
  })

  it('shows no projected delays for the planned work', () => {
    // The production preview starts next Monday. Use the actual application
    // projection with that same relationship between recording time and anchor.
    const anchor = TODAY_WEEK + 1
    const delayed = () => {
      const scenario = issues
      const loadByOwner = new Map<string, LoadSpan[]>()
      for (const issue of scenario) {
        const owner = ownerOf(issue)
        if (
          !owner ||
          issue.status === 'done' ||
          issue.startWeek === undefined ||
          issue.endWeek === undefined
        )
          continue
        const load = loadByOwner.get(owner) ?? []
        load.push({
          issueUuid: issue.key,
          start: anchor + issue.startWeek,
          end: anchor + issue.endWeek,
          remaining: issue.remaining ?? 0,
          remainingSet: TODAY_WEEK,
        })
        loadByOwner.set(owner, load)
      }
      return scenario
        .filter((issue) => {
          const owner = ownerOf(issue)
          const person = people.find((candidate) => candidate.key === owner)
          const result = delayOf(
            {
              uuid: issue.key,
              status: issue.status,
              owner: owner ?? null,
              start: issue.startWeek === undefined ? null : anchor + issue.startWeek,
              end: issue.endWeek === undefined ? null : anchor + issue.endWeek,
              dueWeek: issue.dueDay === undefined ? null : anchor + Math.floor(issue.dueDay / 7),
              duePast: false,
              remaining: issue.remaining,
              remainingSet: TODAY_WEEK,
              capacity: person?.kind === 'agent' ? Infinity : defaultCapacity,
            },
            owner ? (loadByOwner.get(owner) ?? []) : [],
          )
          return result !== null && result.status !== 'ok'
        })
        .map((issue) => issue.key)
    }
    expect(delayed()).toEqual([])
  })
})

describe('marketing text uses the application Markdown dialect', () => {
  it('renders the reported task as paragraphs, bold criteria and a bullet list', () => {
    const description = issues.find((issue) => issue.key === 'standby-power')!.description
    expect(parseMd(description)).toEqual([
      {
        t: 'p',
        children: [
          {
            t: 'text',
            text: 'The radio sleep transition leaves the sensor rail enabled. Isolate the source and compare the revised power sequence.',
          },
        ],
      },
      {
        t: 'p',
        children: [{ t: 'bold', children: [{ t: 'text', text: 'Acceptance criteria' }] }],
      },
      {
        t: 'ul',
        items: [
          [{ t: 'text', text: 'Measure the same firmware build before and after the change.' }],
          [
            {
              t: 'text',
              text: 'Meet the agreed standby budget without losing stored samples.',
            },
          ],
        ],
      },
    ])
  })

  it('keeps every description and comment readable through an editor round trip', () => {
    for (const issue of issues) {
      const blocks = parseMd(issue.description)
      expect(
        blocks.map((block) => block.t),
        issue.key,
      ).toEqual(['p', 'p', 'ul'])
      expect(blocks[1], issue.key).toEqual({
        t: 'p',
        children: [{ t: 'bold', children: [{ t: 'text', text: 'Acceptance criteria' }] }],
      })
      expect(astToMd(blocks), issue.key).toBe(issue.description)
      expect(issue.description, issue.key).not.toMatch(/<\/?(?:p|strong|ul|li)>|&(?:amp|lt|gt);/)
    }
    for (const text of [
      ...projects.map((project) => project.description),
      ...comments.map((comment) => comment.body),
    ]) {
      const blocks = parseMd(text)
      expect(blocks).toEqual([{ t: 'p', children: [{ t: 'text', text }] }])
      expect(astToMd(blocks)).toBe(text)
      expect(text).not.toMatch(/<\/?p>/)
    }
  })
})

describe('marketing replay identifiers and dates', () => {
  it('shifts the complete roadmap exactly across leap days and year boundaries', () => {
    expect(marketingDate('2028-02-28', 1)).toBe('2028-02-29')
    expect(marketingWeek('2028-02-28', 1)).toBe('2028-03-06')
    expect(marketingWeek('2027-01-04', -1)).toBe('2026-12-28')
    for (const issue of issues) {
      if (issue.startWeek === undefined) continue
      const original = marketingWeek('2026-09-07', issue.startWeek)
      const refreshed = marketingWeek('2027-03-08', issue.startWeek)
      expect((Date.parse(refreshed) - Date.parse(original)) / 86_400_000).toBe(182)
      expect(new Date(`${refreshed}T00:00:00Z`).getUTCDay()).toBe(1)
    }
  })

  it('rejects impossible or ambiguous anchors and fractional offsets', () => {
    for (const anchor of [
      '2026-09-08',
      '2026-02-30',
      '2026-2-02',
      '2026-09-07T00:00:00Z',
      '2026-13-01',
      '',
    ]) {
      expect(() => assertMarketingAnchor(anchor)).toThrow(/real Monday/)
    }
    expect(() => marketingDate('2026-09-07', 0.5)).toThrow(/safe integers/)
    expect(() => marketingDate('2026-09-07', Number.NaN)).toThrow(/safe integers/)
    expect(() => marketingWeek('2026-09-07', 0.5)).toThrow(/safe integers/)
  })

  it('derives repeatable UUIDs independent of dates, ordering and dataset edits', async () => {
    const original = await marketingId('northstar-labs-demo', 'issue:pcb-review')
    expect(original).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(await marketingId('northstar-labs-demo', 'issue:pcb-review')).toBe(original)
    expect(await marketingId('another-demo', 'issue:pcb-review')).not.toBe(original)
    expect(await marketingId('northstar-labs-demo', 'issue:pcb-bringup')).not.toBe(original)
    expect(await marketingId('a:b', 'c')).not.toBe(await marketingId('a', 'b:c'))
    const all = await Promise.all(
      issues.map((issue) => marketingId('northstar-labs-demo', `issue:${issue.key}`)),
    )
    expect(new Set(all).size).toBe(issues.length)
    await expect(marketingId('', 'issue:pcb-review')).rejects.toThrow(/namespace and key/)
  })
})
