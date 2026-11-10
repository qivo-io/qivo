// The combined load benchmark's plan (scripts/benchmark-load.mjs): the
// organization setup grows and the people.json it writes, the views'
// addresses, which replayed client acts as whom on which recorded set and
// the check that refuses a client another organization's ids, kept here so
// a test can check them without a backend.
import { createHash } from 'node:crypto'
import { PERSONAL_VIEWS, personQueries, stringsOf, withoutLeaderReads } from './frames.mjs'

/** The three teams person number `n` that setup adds joins: one of
    `baseTeams`, which are shared with every top-level project, and two of
    `addedTeams`, each shared with one sub-project. */
export const teamsOfPerson = (n, baseTeams, addedTeams) => [
  ...new Set(
    [
      baseTeams[n % baseTeams.length],
      addedTeams[n % addedTeams.length],
      addedTeams[(n + 3) % addedTeams.length],
    ].filter(Boolean),
  ),
]

/**
 * Where each person of `people` setup added may hold tasks, as a Map from
 * its profile id to sub-project ids: the sub-projects of each top-level
 * project of `projects` one of its teams (`teamsOf(person)`) holds Edit or
 * more on (`editors`, a Map from a top-level project's id to those teams),
 * and the sub-project each of its teams is shared with at Edit (`sharedBy`,
 * a Map from a team to its sub-project's id).
 */
export function holdPlaces(people, { projects, editors, sharedBy, teamsOf }) {
  return new Map(
    people.map((person) => {
      const teams = teamsOf(person)
      const places = new Set()
      for (const top of projects)
        if (teams.some((team) => editors.get(top.id)?.has(team)))
          for (const child of top.children) places.add(child.id)
      for (const team of teams) if (sharedBy.has(team)) places.add(sharedBy.get(team))
      return [person.profile_id, [...places]]
    }),
  )
}

/** The statuses of a task that an assignment hands to its new assignee
    with an Inbox message (convex/model/messages.ts notifyIssueUpdate): open
    and not in Review, whose owner is the reviewer (lib/review.ts). */
const ASSIGNABLE = new Set(['backlog', 'todo', 'progress'])

/**
 * The assignments that give each owner of `places` (a Map from a profile id
 * to the sub-projects it may hold tasks in) `each` open tasks of `tasks`
 * (Board rows), so the people setup adds hold tasks and, from each
 * assignment's "Assigned to you" message, Inbox items as an everyday person
 * does. An assignee needs Edit on the task's project (convex/model/issues.ts
 * assertAssigneeRule), which holdPlaces works out. A task is taken only when it is in one of its
 * owner's places, open outside Review, has no subtasks and no parent, and
 * is not `keep`'s (Nora's, whose views the recorded sets show), in id
 * order. A task an owner already holds counts toward its `each`, so a
 * second run adds only what is missing. Answers [task id, owner] pairs and
 * the owners left short.
 */
export function everydayAssignments(places, tasks, each, keep) {
  const owners = [...places.keys()]
  const mine = new Set(owners)
  const held = new Map(owners.map((owner) => [owner, 0]))
  for (const task of tasks)
    if (mine.has(task.assignee_id)) held.set(task.assignee_id, held.get(task.assignee_id) + 1)
  const free = tasks
    .filter(
      (task) =>
        ASSIGNABLE.has(task.status) &&
        !task.has_subtasks &&
        !task.parent_id &&
        task.assignee_id !== keep &&
        !mine.has(task.assignee_id),
    )
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const pairs = []
  const short = []
  for (const owner of owners) {
    const where = new Set(places.get(owner))
    for (let n = held.get(owner); n < each; n++) {
      const at = free.findIndex((task) => where.has(task.project_id))
      if (at < 0) break
      const [task] = free.splice(at, 1)
      pairs.push([task.id, owner])
      held.set(owner, n + 1)
    }
    if (held.get(owner) < each) short.push(owner)
  }
  return { pairs, short }
}

/** A lowercase UUID made from `text`, so a rerun of setup names the same
    rows and adds only what is missing. */
export function stableId(text) {
  const hex = createHash('sha256').update(`qivo-load:${text}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** The signed-in login's seat in organization `which` (its slug, or a test
    of its row) from the root part's answer: the profile, its organization
    with its slug and the teams the profile is in, found by shape so a
    change to the answer's layout fails here and not later. */
export function findSeat(root, which) {
  const matches = typeof which === 'function' ? which : (row) => row.slug === which
  const orgs = []
  const profiles = []
  const memberships = []
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (value === null || typeof value !== 'object') return
    if (typeof value.slug === 'string' && typeof value.id === 'string') orgs.push(value)
    if (typeof value.org_id === 'string' && typeof value.org_role === 'string') profiles.push(value)
    if (typeof value.team_id === 'string' && typeof value.profile_id === 'string')
      memberships.push(value)
    Object.values(value).forEach(walk)
  }
  walk(root)
  const org = orgs.find(matches)
  const profile = org && profiles.find((row) => row.org_id === org.id)
  if (!profile) return null
  return {
    org_id: org.id,
    slug: org.slug,
    profile_id: profile.id,
    team_ids: [
      ...new Set(
        memberships.filter((row) => row.profile_id === profile.id).map((row) => row.team_id),
      ),
    ],
  }
}

/** The addresses of the views the record part opens, from the projects
    setup listed: the Board of Luma Sensor's Firmware sub-project, or of
    the whole Luma Sensor project with `boardTop` (--board-top), and the
    Overview, the Roadmap and Team sync of Luma Sensor, the Inbox and My
    view. */
export function viewUrls(plan, boardTop = false) {
  const sensor = plan.projects.find((project) => project.name === 'Luma Sensor') ?? plan.projects[0]
  const board = sensor.children.find((child) => child.name === 'Firmware') ?? sensor.children[0]
  const base = `/app/${plan.org_slug}`
  return {
    board: `${base}/board/p/${boardTop ? sensor.num : board.num}`,
    overview: `${base}/overview/p/${sensor.num}`,
    roadmap: `${base}/roadmap/p/${sensor.num}`,
    sync: `${base}/sync/p/${sensor.num}`,
    inbox: `${base}/inbox`,
    mine: `${base}/board/mine`,
  }
}

/** The organizations of people.json: Northstar first, then those setup
    added with --orgs. */
export const orgsOf = (plan) => plan.orgs ?? [{ k: 0, ...plan }]

/**
 * The client specs of a replay: client i acts as one person and subscribes
 * one recorded set of that person's organization (`orgSets[k]`, the sets
 * Nora recorded there). The clients are dealt to the organizations in
 * turn. In each, the first is the recorder, Nora's seat there, on its
 * Board as recorded (her one login holds a tab in each organization), and
 * the others are its people, person j on the organization's set j modulo
 * the views other than PERSONAL_VIEWS, with Nora's other seats' reads left
 * out (frames.mjs personQueries). One login leads its desktop alerts once
 * (one browser profile), so only Nora's Northstar tab leads among hers; a
 * tab that does not lead holds no leader reads. Throws where an
 * organization holds too few planted sessions, where its first set was
 * recorded by someone other than its first person, and where it holds no
 * set another person can replay.
 */
export function clientSpecs(options, plan, orgSets) {
  const orgs = orgsOf(plan).slice(0, options.orgs)
  const viewSet = (sets, view) => sets.find((set) => set.view === view)
  const bytesOf = (set) => set.queries.reduce((all, query) => all + (query.bytes ?? 0), 0)
  const hasFeed = (set) => set.queries.some((query) => query.udfPath === 'inbox:feed')
  return Array.from({ length: options.clients }, (_, index) => {
    const k = index % orgs.length
    const planOrg = orgs[k]
    const sets = orgSets[k]
    const j = Math.floor(index / orgs.length)
    const person = planOrg.people[j]
    if (!person)
      throw new Error(
        `${planOrg.org_slug} holds ${planOrg.people.length} planted sessions, fewer than its share of --clients`,
      )
    let set
    let queries
    if (j === 0) {
      set = viewSet(sets, 'board') ?? sets[0]
      if (set.person.profile_id !== person.profile_id)
        throw new Error(
          `the ${set.view} set of ${planOrg.org_slug} was recorded by another profile than ${person.key}; run the record part again`,
        )
      queries = set.queries
    } else {
      const shared = sets.filter((one) => !PERSONAL_VIEWS.includes(one.view))
      if (shared.length === 0)
        throw new Error(
          `${planOrg.org_slug} holds no recorded set another person can replay; record a view other than ${PERSONAL_VIEWS.join(', ')}`,
        )
      set = shared[j % shared.length]
      queries = personQueries(set, person, { ownOrg: true })
    }
    // Nora's tabs beside her Northstar tab, in one browser profile, do not lead
    const lead = hasFeed(set) && !(orgs.length > 1 && j === 0 && k > 0)
    return {
      index,
      org: planOrg.org_slug,
      view: set.view,
      person,
      recorder: j === 0,
      queries: lead ? queries : withoutLeaderReads(queries),
      lead,
      watch: j === 0 ? `${person.key}` : null,
      recorded_answer_bytes: bytesOf(set),
    }
  })
}

/** The ids people.json holds for organization `planOrg`: the
    organization's, its profiles' (`profile_ids`, else the planted
    people's and the owner's), its projects' and sub-projects' and its
    teams'. */
export function idsOfOrg(planOrg) {
  return new Set(
    [
      planOrg.org_id,
      ...(planOrg.profile_ids ?? []),
      ...planOrg.people.map((person) => person.profile_id),
      planOrg.owner?.profile_id,
      ...(planOrg.projects ?? []).flatMap((project) => [
        project.id,
        ...project.children.map((child) => child.id),
      ]),
      ...(planOrg.teams ?? []),
    ].filter((id) => typeof id === 'string'),
  )
}

/**
 * Refuses `specs` (clientSpecs') a replay must not run, before any client
 * starts: a client other than its organization's recorder whose queries
 * name an id of another organization of `orgs` (people.json's, idsOfOrg),
 * such as a person of Northstar in another organization's set, and one
 * whose queries hold an id list naming one id twice. The recorder's own
 * clients replay her tabs as recorded, her other seats' reads included.
 * Throws an Error that names the client, the function and the id.
 */
export function checkSpecs(specs, orgs) {
  const idsBySlug = new Map(orgs.map((planOrg) => [planOrg.org_slug, idsOfOrg(planOrg)]))
  for (const spec of specs) {
    if (spec.recorder) continue
    const foreign = new Map()
    for (const [slug, ids] of idsBySlug)
      if (slug !== spec.org) for (const id of ids) foreign.set(id, slug)
    const name = `client ${spec.index} (${spec.person.key}, ${spec.view})`
    for (const query of spec.queries) {
      for (const text of stringsOf(query.args))
        if (foreign.has(text))
          throw new Error(
            `${name} would read ${query.udfPath} with ${text}, an id of ${foreign.get(text)}, not of ${spec.org}`,
          )
      const lists = [query.args]
      while (lists.length > 0) {
        const value = lists.pop()
        if (value === null || typeof value !== 'object') continue
        if (Array.isArray(value)) {
          const texts = value.filter((item) => typeof item === 'string')
          const twice = texts.find((text, at) => texts.indexOf(text) !== at)
          if (twice !== undefined)
            throw new Error(`${name} would read ${query.udfPath} with ${twice} twice in one list`)
        }
        lists.push(...Object.values(value))
      }
    }
  }
  return specs
}
