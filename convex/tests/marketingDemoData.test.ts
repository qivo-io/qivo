import { describe, expect, it } from 'vitest'
import { TODAY_WEEK } from '../../src/lib/dates'
import { delayOf } from '../../src/lib/delay'
import { parseMd } from '../../src/lib/md'
import { astToMd } from '../../src/lib/mdSerialize'
import type { LoadSpan } from '../../src/lib/workload'
import {
  assertMarketingAnchor,
  DEMO_DONE_DAY,
  DEMO_DONE_TIME,
  DEMO_EVENT_TIME,
  type DemoChange,
  MARKETING_DEMO,
  MARKETING_DEMO_VERSION,
  marketingDate,
  marketingId,
  marketingInstant,
  marketingWeek,
  northstarTaskTimes,
} from '../internal/marketingDemoData'
import { taskOwnerId } from '../lib/review'
import { FOLLOWER_MAX, SUBTASK_MAX } from '../lib/taskLimits'
import { nameTooLong, TEXT_MAX } from '../lib/textLimits'
import { isLabelColor } from '../model/labels'
import { newOrgDefaults } from '../model/orgs'
import { avatarColor } from '../model/people'

const { people, teams, projects, issues, labels, links, milestones, comments, history } =
  MARKETING_DEMO
const defaultCapacity = newOrgDefaults('2026-09-07T00:00:00.000Z').default_plannable_hours
// Whose week a task's hours count against: the app's one Reviewer rule.
const ownerOf = (i: (typeof issues)[number]) =>
  taskOwnerId({ status: i.status, assignee_id: i.assignee, reviewer_id: i.reviewer })
// A task's plan weeks as the app shows them. A group's run from the earliest
// start to the latest end of its scheduled, unarchived leaves at any depth; a
// leaf without an end counts as its start week.
const subtasksOf = (i: (typeof issues)[number]) =>
  issues.filter((child) => child.parent === i.key && !child.archived)
function weeksOf(i: (typeof issues)[number]): { start?: number; end?: number } {
  const kids = subtasksOf(i)
  if (!kids.length) return { start: i.startWeek, end: i.endWeek ?? i.startWeek }
  let start: number | undefined
  let end: number | undefined
  for (const kid of kids) {
    const weeks = weeksOf(kid)
    if (weeks.start === undefined || weeks.end === undefined) continue
    start = start === undefined ? weeks.start : Math.min(start, weeks.start)
    end = end === undefined ? weeks.end : Math.max(end, weeks.end)
  }
  return { start, end }
}

describe('the versioned Northstar marketing scenario', () => {
  it('keeps the agreed organization, project mix and sole administrator', () => {
    expect(MARKETING_DEMO_VERSION).toBe(8)
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

  it("keeps every subtask in its parent task's top-level project", () => {
    const topOf = (projectKey: string) => {
      const project = projects.find((candidate) => candidate.key === projectKey)!
      return project.parent ?? project.key
    }
    const subtasks = issues.filter((issue) => issue.parent !== undefined)
    expect(subtasks.length).toBeGreaterThan(0)
    for (const issue of subtasks) {
      const parent = issues.find((candidate) => candidate.key === issue.parent)!
      expect(topOf(issue.project), issue.key).toBe(topOf(parent.project))
    }
  })

  it('follows the task limits: one level of subtasks, and few enough subtasks and followers', () => {
    const subtasks = issues.filter((issue) => issue.parent !== undefined)
    for (const issue of subtasks) {
      const parent = issues.find((candidate) => candidate.key === issue.parent)!
      expect(parent.parent, issue.key).toBeUndefined()
    }
    // archived subtasks count too
    for (const issue of issues)
      expect(subtasks.filter((kid) => kid.parent === issue.key).length).toBeLessThanOrEqual(
        SUBTASK_MAX,
      )
    // a task's followers are people of the organization
    expect(people.length).toBeLessThanOrEqual(FOLLOWER_MAX)
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
    for (const rows of [people, teams, projects, issues, labels, milestones, comments, history]) {
      expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    }
    expect(new Set(projects.map((project) => project.code)).size).toBe(projects.length)
    const peopleKeys = new Set(people.map((person) => person.key))
    const projectByKey = new Map(projects.map((project) => [project.key, project]))
    const issueByKey = new Map(issues.map((issue) => [issue.key, issue]))
    const labelKeys = new Set(labels.map((label) => label.key))
    // the seed writes straight to the table, so it must keep the stored color rules
    expect(labels.filter((label) => !isLabelColor(label.color))).toEqual([])
    expect(people.map((person) => avatarColor(person.color))).toEqual(
      people.map((person) => person.color),
    )
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
        // a group's hours and plan weeks both come from its subtasks
        expect(issue.remaining).toBeUndefined()
        expect(issue.startWeek, issue.key).toBeUndefined()
        expect(issue.endWeek, issue.key).toBeUndefined()
        const children = issues.filter((child) => child.parent === issue.key)
        expect(children.length, issue.key).toBeGreaterThanOrEqual(2)
        expect(children.length, issue.key).toBeLessThanOrEqual(4)
      } else {
        expect(issue.remaining).toBeGreaterThanOrEqual(0)
      }
      if (issue.status === 'done') expect(issue.remaining).toBe(0)
      expect(issue.startWeek === undefined).toBe(issue.endWeek === undefined)
      // the realism checks read the weeks the app shows, calculated for groups
      const weeks = weeksOf(issue)
      if (weeks.start !== undefined && weeks.end !== undefined) {
        expect(Number.isInteger(weeks.start) && Number.isInteger(weeks.end)).toBe(true)
        expect(weeks.start).toBeLessThanOrEqual(weeks.end)
        expect(weeks.start).toBeGreaterThanOrEqual(-3)
        expect(weeks.end).toBeLessThanOrEqual(6)
        if (issue.status === 'done') expect(weeks.end).toBeLessThan(0)
      }
      if (issue.status === 'backlog') expect(weeks.start).toBeUndefined()
      if (issue.dueDay !== undefined) {
        expect(Number.isInteger(issue.dueDay)).toBe(true)
        if (weeks.end !== undefined) {
          expect(weeks.end * 7 + 4, issue.key).toBeLessThanOrEqual(issue.dueDay)
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
      const sourceEnd = weeksOf(source).end
      const targetStart = weeksOf(target).start
      if (sourceEnd !== undefined && targetStart !== undefined && sourceEnd >= targetStart) {
        blockingOverlaps.push(`${source.key} -> ${target.key}`)
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
          // a group is judged by its calculated end and its leaves' completion
          const kids = subtasksOf(issue)
          const weeks = weeksOf(issue)
          const result = delayOf(
            {
              uuid: issue.key,
              status: issue.status,
              isGroup: kids.length > 0,
              isDone: kids.length > 0 ? kids.every((kid) => kid.status === 'done') : undefined,
              owner: owner ?? null,
              start: weeks.start === undefined ? null : anchor + weeks.start,
              end: weeks.end === undefined ? null : anchor + weeks.end,
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

type Dataset = Pick<
  typeof MARKETING_DEMO,
  'people' | 'teams' | 'projects' | 'issues' | 'links' | 'history'
>
const ANCHOR = '2026-09-28'

/** What is wrong with a dataset's change history, one line per problem:
 * each task's status moves chain and end at its status, its moves into Done
 * and Review agree with its stamps, nothing is dated after its last write,
 * Atlas writes only through MCP, and every actor may edit the task. */
function historyProblems(data: Dataset): string[] {
  const out: string[] = []
  const at = (c: DemoChange) => marketingInstant(ANCHOR, c.day, c.time)
  for (const issue of data.issues) {
    const own = data.history.filter((c) => c.issue === issue.key)
    if (own.length === 0) continue
    const project = data.projects.find((p) => p.key === issue.project)!
    const root = data.projects.find((p) => p.key === (project.parent ?? project.key))!
    const team = data.teams.find((candidate) => candidate.key === root.team)
    const touched =
      issue.touchedDay === undefined
        ? undefined
        : marketingInstant(ANCHOR, issue.touchedDay, DEMO_EVENT_TIME)
    let status: string | undefined
    let last = ''
    for (const c of own) {
      const where = `${c.key}:`
      if (at(c) < last) out.push(`${where} out of time order`)
      last = at(c)
      if (touched !== undefined && at(c) > touched) out.push(`${where} after the last write`)
      const person = data.people.find((p) => p.key === c.actor)
      if (person === undefined) {
        out.push(`${where} unknown actor`)
        continue
      }
      const mcp = c.kind === 'status' && c.via === 'mcp'
      if (mcp !== (person.kind === 'agent')) out.push(`${where} Atlas writes only through MCP`)
      const canWrite =
        person.role === 'admin' ||
        root.lead === person.key ||
        (team ? team.members : data.teams.flatMap((x) => x.members)).includes(person.key)
      if (!canWrite) out.push(`${where} the actor cannot edit the task`)
      if (c.kind === 'label' && !issue.labels.includes(c.label))
        out.push(`${where} the task lacks the label`)
      if (
        c.kind === 'link' &&
        !data.links.some(
          (l) => l.source === issue.key && l.target === c.target && l.type === 'blocks',
        )
      )
        out.push(`${where} no such link`)
      if (c.kind !== 'status') continue
      if (status !== undefined && c.from !== status) out.push(`${where} a broken chain`)
      status = c.to
      if (c.to === 'done' && (c.day !== DEMO_DONE_DAY || c.time !== DEMO_DONE_TIME))
        out.push(`${where} Done away from the seeded completion`)
    }
    const moves = own.filter((c) => c.kind === 'status')
    if (moves.length > 0 && status !== issue.status)
      out.push(`${issue.key}: ends away from its status`)
    const handed = moves.filter((c) => c.to === 'review').at(-1)
    const reviewed = issue.status === 'review' || (issue.status === 'done' && !!issue.reviewer)
    if (
      handed &&
      reviewed &&
      (issue.reviewDay === undefined ||
        at(handed) !== marketingInstant(ANCHOR, issue.reviewDay, DEMO_EVENT_TIME))
    )
      out.push(`${issue.key}: handed over away from its reviewDay`)
  }
  return out
}

describe('the Northstar change history', () => {
  /* The dataset with one change replaced. */
  const withChange = (key: string, edit: Partial<DemoChange>): Dataset => ({
    ...MARKETING_DEMO,
    history: history.map((c) => (c.key === key ? ({ ...c, ...edit } as DemoChange) : c)),
  })

  it('agrees with every task it touches', () => {
    expect(historyProblems(MARKETING_DEMO)).toEqual([])
  })

  it('reports each kind of disagreement', () => {
    const cases: [Dataset, RegExp][] = [
      [withChange('pcb-review-handed', { from: 'todo' } as Partial<DemoChange>), /broken chain/],
      [withChange('pcb-review-handed', { to: 'done' } as Partial<DemoChange>), /ends away/],
      [withChange('telemetry-contract-done', { time: '16:00:00.000Z' }), /seeded completion/],
      [withChange('pcb-review-handed', { day: -5 }), /away from its reviewDay/],
      [withChange('design-tokens-handed', { time: '15:00:00.000Z' }), /away from its reviewDay/],
      [withChange('room-cards-started', { day: -3 }), /after the last write/],
      [withChange('offline-buffer-reliability', { day: -7, time: '09:00:00.000Z' }), /time order/],
      [withChange('accessibility-audit-started', { actor: 'daniel' }), /only through MCP/],
      [withChange('room-cards-started', { actor: 'atlas' }), /only through MCP/],
      [
        withChange('offline-buffer-reliability', { label: 'launch' } as Partial<DemoChange>),
        /lacks the label/,
      ],
      [
        withChange('telemetry-contract-blocks-ingestion', {
          target: 'pcb-review',
        } as Partial<DemoChange>),
        /no such link/,
      ],
      [withChange('room-cards-started', { actor: 'leo' }), /cannot edit/],
    ]
    for (const [data, problem] of cases) {
      expect(historyProblems(data)).toContainEqual(expect.stringMatching(problem))
    }
  })

  it('covers a few tasks with every kind of change, on weekdays before the anchor', () => {
    const tasks = new Set(history.map((c) => c.issue))
    expect(tasks.size).toBeGreaterThanOrEqual(7)
    expect(tasks.size).toBeLessThanOrEqual(9)
    expect(new Set(history.map((c) => c.kind))).toEqual(new Set(['status', 'label', 'link']))
    const moves = history.flatMap((c) => (c.kind === 'status' ? [c] : []))
    expect(moves.some((c) => c.to === 'review')).toBe(true)
    expect(moves.some((c) => c.to === 'done')).toBe(true)
    expect(moves.filter((c) => c.via === 'mcp')).toHaveLength(1)
    for (const c of history) {
      expect(c.day, c.key).toBeGreaterThanOrEqual(-7)
      expect(c.day, c.key).toBeLessThanOrEqual(-1)
      const weekday = new Date(`${marketingDate(ANCHOR, c.day)}T00:00:00Z`).getUTCDay()
      expect(weekday >= 1 && weekday <= 5, c.key).toBe(true)
    }
  })

  it('gives every task stamps in the order the app writes them', () => {
    const seed = marketingInstant(ANCHOR, 0, '08:00:00.000Z')
    // an anchor two weeks after the seed runs
    const later = marketingDate(ANCHOR, 14)
    for (const issue of issues) {
      const times = northstarTaskTimes(ANCHOR, seed, issue)
      expect(times.created <= times.status && times.status <= times.updated, issue.key).toBe(true)
      // the last write is the seed's rule: the dated touch, else the seed instant
      const touched =
        issue.touchedDay === undefined
          ? seed
          : marketingInstant(ANCHOR, issue.touchedDay, DEMO_EVENT_TIME)
      expect(times.updated, issue.key).toBe(touched)
      // a seed run before a future anchor never writes the status after the last write
      const future = northstarTaskTimes(later, seed, issue)
      expect(future.status <= future.updated, issue.key).toBe(true)
      const moves = history.filter((c) => c.issue === issue.key && c.kind === 'status')
      const lastMove = moves.at(-1)
      if (lastMove) {
        expect(times.status, issue.key).toBe(marketingInstant(ANCHOR, lastMove.day, lastMove.time))
      }
      if (issue.status === 'done') expect(times.status, issue.key).toBe(times.done)
      else if (issue.status === 'review' && times.review !== undefined) {
        expect(times.status, issue.key).toBe(times.review)
      } else if (!lastMove) expect(times.status, issue.key).toBe(times.created)
    }
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

  it('keeps every description and comment within the text limit', () => {
    for (const issue of issues)
      expect(issue.description.length, issue.key).toBeLessThanOrEqual(TEXT_MAX)
    for (const comment of comments)
      expect(comment.body.length, comment.key).toBeLessThanOrEqual(TEXT_MAX)
  })

  it('keeps the organization, team, project and milestone names trimmed and within the name limit', () => {
    const names = [
      MARKETING_DEMO.organization.name,
      ...teams.map((t) => t.name),
      ...projects.map((p) => p.name),
      ...milestones.map((m) => m.name),
    ]
    for (const name of names) {
      expect(name, name).toBe(name.trim())
      expect(nameTooLong(name), name).toBe(false)
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
