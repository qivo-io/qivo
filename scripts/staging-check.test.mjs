import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HISTORY_PAGE_MAX, WINDOW_HISTORY_PAGE } from '../convex/lib/activityVisibility'
import { LIMITS } from '../convex/lib/limits'
import { CURSOR_REFUSAL, offsetRefusal } from '../convex/lib/listCursor'
import { FOCUS_STATUSES } from '../convex/lib/viewReads'
import {
  ACCESS_PUT_FIELDS,
  HELD_TASKS_FIELDS,
  MEMBER_PUT_FIELDS,
} from '../convex/machine/bodyFields'
import { COMMENT_PAGE_MAX } from '../convex/model/comments'
import { billingBytes, CALLS_COUNTING, STORAGE_COUNTING } from '../src/lib/billingDisplay'
import { endText } from '../src/lib/deletedItems'
import { LABEL_COLORS } from '../src/lib/labelColors'
import { creatorPhrase } from '../src/lib/projectCreators'
import {
  ADMIN_MANAGEMENT_CLEANUP,
  ADMIN_MANAGEMENT_MARKS,
  ADMIN_MANAGEMENT_STEP,
  AGENDA_QUERY,
  APP_BATCHES_MAX,
  ASSIGNEE_LOAD_QUERY,
  addDays,
  addedArgs,
  addsQuery,
  addsQueryFor,
  answeredNum,
  answersMutation,
  appBatches,
  atProject,
  authCorsProblems,
  authRoutesStep,
  BILLING_ACCOUNTS_MARKS,
  BILLING_ACCOUNTS_STEP,
  BILLING_STORAGE_EXPECTED,
  BILLING_STORAGE_STEP,
  BROWSERS,
  byIdsProblems,
  CREATE_ANSWER_STEP,
  CREATE_MUTATION,
  createOrder,
  creatorsLine,
  DELETED_ITEMS_EXPECTED,
  DELETED_ITEMS_MARKS,
  DELETED_ITEMS_STEP,
  DESCRIPTION_IMAGES_STEP,
  deletedPageProblem,
  deletedRowsOf,
  deleteOutcome,
  directoryGroups,
  evaluate,
  exportItemOf,
  exportOfLink,
  exportWayOf,
  FIXTURE_STATUS,
  FORMERLY_BARE,
  failedShot,
  freeMilestoneWeek,
  freePastMilestoneWeek,
  HIDDEN_TASK_WINDOW_STEP,
  HIDDEN_WINDOW_READS,
  hasTag,
  historyRows,
  IMAGE_ANSWER_DELAY_MS,
  IMAGE_DOWNLOADS,
  IMAGE_SPACER,
  INBOX_BADGE_STEP,
  INBOX_FEED_MARKS,
  INBOX_FEED_QUERY,
  INBOX_FEED_STEP,
  INBOX_LIST_MARKS,
  INBOX_LIST_STEP,
  INBOX_PAGE_QUERY,
  INBOX_PAGES_MAX,
  INBOX_PART_QUERY,
  INBOX_REFUSALS,
  imageDownloads,
  inboxPagesMax,
  inboxWhole,
  inDefaultWindow,
  isSiteOf,
  LABEL_MENTION_NAMES,
  LABEL_MENTION_STEP,
  LABELS_EXPECTED,
  LABELS_STEP,
  LIST_REFUSALS,
  listAnswers,
  MCP_ACCESS_EXPECTED,
  MCP_ACCESS_LISTS_STEP,
  MCP_ACCESS_MARKS,
  MENTION_GONE,
  MILESTONE_STEP,
  MILESTONES_BETWEEN_QUERY,
  MILESTONES_SECTION_QUERY,
  mcpListSettled,
  mutationRequest,
  NEW_TASK_READS,
  NOTIFICATION_DELIVERY_MARKS,
  NOTIFICATION_DELIVERY_STEP,
  newerWalk,
  notificationCall,
  notificationPermission,
  OLD_PATHS_CLEANUP,
  OLD_PATHS_MARKS,
  OLD_PATHS_STEP,
  ORG_EXPORT_DOWNLOAD_MS,
  ORG_EXPORT_FILE,
  ORG_EXPORT_MARKS,
  ORG_EXPORT_PICKER,
  ORG_EXPORT_PICKER_FLAG,
  ORG_EXPORT_READY_MS,
  ORG_EXPORT_STEP,
  OVERVIEW_EXPECTED,
  OVERVIEW_HEALTH_EXPECTED,
  OVERVIEW_MILESTONES_STEP,
  OVERVIEW_OVERDUE_DAYS,
  OWN_READS_STEP,
  OWNER_PICKERS_NAMES,
  OWNER_PICKERS_PERSON,
  OWNER_PICKERS_STEP,
  PEOPLE_PAGE,
  PEOPLE_REFUSALS,
  PHONE_SELECTS_STEP,
  PICKER_EXPECTED,
  PICKER_STEP,
  PROJECT_BY_IDS_STEP,
  PROJECT_DETAIL_REFUSALS,
  PROJECT_DIALOGS_EXPECTED,
  PROJECT_DIALOGS_STEP,
  PROJECT_DIRECTORY_MARKS,
  PROJECT_DIRECTORY_STEP,
  PROJECT_LISTS,
  PROJECT_REFUSALS,
  PROJECT_SETTINGS_EXPECTED,
  PROJECT_SETTINGS_STEP,
  PROJECTS_MAX,
  PROJECTS_PART,
  PROJECTS_PART_MARKS,
  PROJECTS_PART_STEP,
  PURGE_DELETED_STEP,
  pace,
  parseArgs,
  peoplePagesMax,
  phoneSelectPages,
  pressSettled,
  projectDeleteRoute,
  projectPagesMax,
  projectsPartProblems,
  purgeAnswerOf,
  querySetChanges,
  RATE_BUDGET,
  REGROUP_WAIT,
  RELATION_EXPECTED,
  RELATION_STEP,
  REMOVAL_EXPECTED,
  REMOVAL_STEP,
  REMOVED_PARTS,
  REST_BODY_FIELDS,
  ROADMAP_MILESTONES_STEP,
  ROADMAP_QUERY,
  ROSTER_PARTS_STEP,
  ROSTER_READS,
  rateLimitWait,
  redact,
  request,
  resolveConfig,
  results,
  SEARCH_LOST,
  SETTINGS_PROJECTS_MARKS,
  SETTINGS_PROJECTS_STEP,
  SETTINGS_USERS_EXPECTED,
  SETTINGS_USERS_STEP,
  SIDEBAR_PROJECTS_MARKS,
  SIDEBAR_PROJECTS_STEP,
  STARTUP_LOST_NOTE,
  STARTUP_SELECTION_MARKS,
  STARTUP_SELECTION_STEP,
  searchOf,
  selectedCreatorsStarts,
  selectProblems,
  send,
  sentMutation,
  syncsWith,
  TAG_ANY,
  TAG_PREFIX,
  TASK_LINK_STEP,
  TASK_LINK_UNKNOWN,
  TASK_LIST_REFUSALS,
  TASK_LISTS,
  TASK_PAGES_MAX,
  TEAM_SYNC_STEP,
  TEAMS_EXPECTED,
  TEAMS_STEP,
  THREAD_PAGE,
  TOAST_HOST,
  taskPages,
  threadFitsBudget,
  typeSearch,
  UPLOAD_STEP,
  WAITS,
  WORKLOAD_PAGE,
  WORKLOAD_PAGES_MAX,
  WORKLOAD_PEOPLE,
  WORKLOAD_REFUSALS,
  WRITE_CONFLICT,
  waitedFor,
  weekOf,
  wholeBatchNames,
  within,
  withQuery,
  workloadPeople,
} from './staging-check.mjs'

describe('staging check REST contract', () => {
  it('expects the body fields the access and member routes take', () => {
    expect(REST_BODY_FIELDS).toEqual({
      accessPut: [...ACCESS_PUT_FIELDS],
      heldTasks: [...HELD_TASKS_FIELDS],
      memberPut: [...MEMBER_PUT_FIELDS],
    })
  })
  it('makes its fixture tasks in a status Focus keeps, so the Board shows them either way', () => {
    expect(FOCUS_STATUSES).toContain(FIXTURE_STATUS)
  })
  it("checks its own sub-project's Overview on what its two tasks give, in the page's words", () => {
    // overdue on every client's day, whatever its time zone
    expect(Number.isInteger(OVERVIEW_OVERDUE_DAYS)).toBe(true)
    expect(OVERVIEW_OVERDUE_DAYS).toBeGreaterThan(1)
    const page = readFileSync(new URL('../src/views/Overview.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/`\$\{done\} of \$\{leaves\} tasks done`/)
    expect(page).toContain("{late === 1 ? 'is' : 'are'} overdue")
    expect(OVERVIEW_EXPECTED).toEqual({
      completion: '0 of 2 tasks done',
      paused: '1',
      sentence: '1 task is overdue.',
    })
  })
  it("checks its own label in Settings › Labels on its one task, in the page's words", () => {
    const page = readFileSync(
      new URL('../src/panels/settings/LabelsSettings.tsx', import.meta.url),
      'utf8',
    )
    expect(page).toMatch(/`\$\{grouped\(n\)\} active task\$\{n === 1 \? '' : 's'\}`/)
    expect(page).toMatch(/`Used by \$\{activeTasks\(count\)\}\. `/)
    expect(page).toContain(
      'Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.',
    )
    expect(LABELS_STEP).toBe('ui/settings-labels')
    expect(LABELS_EXPECTED).toEqual({
      count: '1 active task',
      confirm:
        'Used by 1 active task. Deleting this label removes it from all tasks, including archived tasks. This cannot be undone.',
      taken: 'A label with that name already exists',
      palette: LABEL_COLORS.map((c) => c.color),
    })
    // New label's check of a typed name, by the page's own marks and words
    expect(page).toContain("export const NAME_TAKEN = 'A label with that name already exists'")
    expect(page).toContain('data-label-name-check={checked}')
    expect(page).toContain('data-label-add=""')
    expect(page).toContain('placeholder="New label name"')
  })
  it("checks its own team in Settings › Teams and on its page, by the pages' own marks and words", () => {
    const page = readFileSync(
      new URL('../src/panels/settings/TeamSettings.tsx', import.meta.url),
      'utf8',
    )
    expect(page).toMatch(/`\$\{grouped\(count\)\} member\$\{count === 1 \? '' : 's'\}`/)
    for (const mark of [
      'data-org-teams=""',
      'data-teams-state={state}',
      'data-teams-search=""',
      'data-team-row={id}',
      'data-team-open',
      'data-team-count=""',
      'data-team-kept=""',
      'data-team-delete',
      "'Click again to delete this team'",
      'data-team-settings-state={read.state}',
      'data-team-members-state={state}',
      'data-team-member-count=""',
      'data-team-member-picker=""',
      'probe="data-team-member-picker-search"',
      'data-team-member-choice={person.id}',
      'data-team-member-add=""',
      'data-settings-team-member={id}',
      'data-team-member-remove',
      "'Click again to confirm'",
      'aria-label="Team name"',
    ])
      expect(page, mark).toContain(mark)
    expect(TEAMS_STEP).toBe('ui/settings-teams')
    expect(TEAMS_EXPECTED).toEqual({ none: '0 members', one: '1 member' })
  })
  it("checks the workspace without its people and catalog parts, and the menus that read the roster's rows, by the pages' own marks", () => {
    const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')
    const workspace = read('../convex/workspace.ts')
    // the parts the step expects no page to subscribe are gone from the server
    for (const part of REMOVED_PARTS) {
      expect(part.startsWith('workspace:')).toBe(true)
      expect(workspace).not.toContain(`export const ${part.slice('workspace:'.length)} =`)
    }
    expect(workspace).toContain('export const root =')
    expect(REMOVED_PARTS).toEqual(['workspace:people', 'workspace:catalog'])
    // the reads the menus take their rows from
    expect(read('../convex/teams.ts')).toContain('export const picker =')
    expect(read('../convex/pickers.ts')).toContain('export const viewOwners =')
    expect(read('../convex/pickers.ts')).toContain('export const taskFollowers =')
    expect(ROSTER_READS).toEqual({
      teams: 'teams:picker',
      people: 'pickers:viewOwners',
      followers: 'pickers:taskFollowers',
      board: 'tasks:board',
    })
    const filters = read('../src/components/viewFilters.tsx')
    for (const mark of [
      'data-filter-assignee-menu',
      'probe="data-filter-assignee-search"',
      'data-filter-assignee={row.id}',
      'data-filter-x={kind}',
    ])
      expect(filters, mark).toContain(mark)
    const scope = read('../src/views/teamSync/SyncScopeMenu.tsx')
    for (const mark of [
      'data-sync-scope-trigger={shown.label}',
      "const SCOPE_SEARCH = 'data-sync-scope-search'",
      'data-sync-scope-choice={key}',
    ])
      expect(scope, mark).toContain(mark)
    const followers = read('../src/components/IssueSubscribers.tsx')
    for (const mark of [
      'data-task-subscribe',
      'data-task-subscriber-add-open',
      'data-task-subscriber-search',
      'data-task-subscriber-add={row.id}',
    ])
      expect(followers, mark).toContain(mark)
    expect(ROSTER_PARTS_STEP).toBe('ui/roster-parts')
    const check = read('./staging-check.mjs')
    const step = check.slice(
      check.indexOf('async function rosterPartsCheck()'),
      check.indexOf('/** Whether frame `text` the page sent is a one-shot read'),
    )
    // run.t0's window opens at the address the router parses, its key in
    // lower case, and the step waits for it before the eye
    expect(read('../src/lib/router.ts')).toContain(
      "if (seg[i] === 'tasks') {\n    r.issue = issue(seg[i + 1])",
    )
    const opens = step.indexOf(
      `\`\${cfg.appOrigin}/app/\${ORG_SLUG}/tasks/\${run.t0.key.toLowerCase()}\``,
    )
    expect(opens).toBeGreaterThan(-1)
    const title = step.indexOf(`'[role="dialog"] [data-task-title]'`)
    expect(title).toBeGreaterThan(opens)
    expect(title).toBeLessThan(step.indexOf(`'[data-task-subscribe]'`))
    // no step opens a task at /task/, which the router does not parse
    expect(check).not.toContain(`/app/\${ORG_SLUG}/task/`)
    // the Assignee menu lists the owners of the Board's tasks alone: the
    // step gives Nora a task there, picks her, and checks that Leo, who
    // holds none, is not offered
    expect(step).toContain('assignee_id: run.nora.id,')
    expect(step).toContain('run.created.push(held)')
    expect(step).toContain("app.getByText('No matching people.')")
    expect(step).toContain('addsQueryFor(f, ROSTER_READS.board, holder.id)')
    // the Add list offers only people who see the task's project, so Leo
    // gets Viewer on Alpha before the search. The grant goes once the
    // follower half is done, a refusal failing the step, and again in the
    // step's finally after a failure
    const grant = step.indexOf(`\`/projects/\${A.id}/access/users/\${leo.id}\`, {`)
    expect(grant).toBeGreaterThan(-1)
    expect(grant).toBeLessThan(step.indexOf(`'[data-task-subscriber-search]'`))
    expect(step.slice(grant, grant + 120)).toContain("level: 'viewer'")
    // no read gives the run his address, so the Add list's search is
    // given his name
    expect(step).not.toContain('leo.email')
    expect(step).not.toContain('mentionChoices')
    expect(step).toContain(`.fill(leo.name)`)
    // the removal duty starts before the PUT, so the finally removes a
    // grant the server committed whose answer was lost
    const duty = step.indexOf('granted = true')
    expect(duty).toBeGreaterThan(step.indexOf(`'[data-filter-x="assignee"]'`))
    expect(duty).toBeLessThan(grant)
    expect(step.indexOf('granted = true', duty + 1)).toBe(-1)
    const removal = step.indexOf(
      `await restOk(w, 'DELETE', \`/projects/\${A.id}/access/users/\${leo.id}\`)\n      granted = false`,
    )
    expect(removal).toBeGreaterThan(step.indexOf(`'[data-task-subscriber-search]'`))
    expect(removal).toBeLessThan(step.indexOf(`'[data-sync-scope-trigger]'`))
    // after a failure the finally removes the grant as a check of its own,
    // so the run counts a removal refused there too among its failures
    // instead of swallowing it
    const cleanup = step.slice(step.indexOf('} finally {'))
    expect(cleanup).toContain(
      [
        'if (granted)',
        `        await check(\`\${ROSTER_PARTS_STEP}/revoke\`, async () => {`,
        `          const r = await restOk(w, 'DELETE', \`/projects/\${A.id}/access/users/\${leo.id}\`)`,
      ].join('\n'),
    )
    expect(cleanup).not.toMatch(/\brest\(w, 'DELETE'/)
  })
  it("opens its own milestone in the Milestones window by the window's own marks, in a free week, and a past one in Past", () => {
    // the window and its section part, which the Overview and the phone
    // agenda share (src/components/MilestoneSectionPart.tsx)
    const modals = ['../src/panels/Modals.tsx', '../src/components/MilestoneSectionPart.tsx']
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')
    for (const mark of [
      'data-milestone-window',
      'data-milestone-editor={m.id}',
      'data-milestone-row={m.id}',
      'aria-label="Name"',
      "armDel ? 'Confirm delete' : 'Delete'",
      // the sections the step waits on and the disclosure it expands
      'data-milestone-section={side}',
      'data-milestone-section-state={open ? view.state : undefined}',
      'data-milestone-past-toggle',
      'aria-expanded={pastOpen}',
    ])
      expect(modals).toContain(mark)
    expect(modals).toMatch(/aria-label=\{`Edit \$\{m\.name\}`\}/)
    const overview = readFileSync(
      new URL('../src/views/overview/OverviewMilestones.tsx', import.meta.url),
      'utf8',
    )
    expect(overview).toContain('data-overview-milestone={m.id}')
    expect(MILESTONE_STEP).toBe('ui/milestones')
    // three weeks after the run's own Monday, past the weeks M holds
    expect(freeMilestoneWeek([], '2026-11-06', 1)).toBe('2026-11-23')
    expect(freeMilestoneWeek(['2026-11-24', '2026-11-30'], '2026-11-06', 1)).toBe('2026-12-07')
    // a week starting on Sunday
    expect(freeMilestoneWeek([], '2026-11-06', 0)).toBe('2026-11-22')
    // a past milestone goes in the first free week from the week before
    // last back, which no runner's local day can place in its current week
    expect(freePastMilestoneWeek([], '2026-11-06', 1)).toBe('2026-10-19')
    expect(freePastMilestoneWeek(['2026-10-20', '2026-10-14'], '2026-11-06', 1)).toBe('2026-10-05')
    expect(freePastMilestoneWeek([], '2026-11-06', 0)).toBe('2026-10-18')
    // must fail: the run's own week is not in the past
    expect(freePastMilestoneWeek([], '2026-11-06', 1)).not.toBe('2026-11-02')
  })
  it("checks the Roadmap's flags on the deployment's range read, in the header and on My view's rows", () => {
    expect(ROADMAP_MILESTONES_STEP).toBe('ui/roadmap-milestones')
    expect(MILESTONES_BETWEEN_QUERY).toBe('milestones:between')
    // the marks the step waits on
    const roadmap = readFileSync(new URL('../src/views/Roadmap.tsx', import.meta.url), 'utf8')
    for (const mark of ['data-roadmap-milestones={milestones}', 'data-msrow={track}'])
      expect(roadmap).toContain(mark)
    const marks = readFileSync(
      new URL('../src/views/roadmap/TimelineMarks.tsx', import.meta.url),
      'utf8',
    )
    for (const mark of ['data-msband', 'data-msflag={m.id}', 'data-msflag-side={place.side}'])
      expect(marks).toContain(mark)
    const row = readFileSync(
      new URL('../src/views/roadmap/TimelineRow.tsx', import.meta.url),
      'utf8',
    )
    expect(row).toContain('data-track={isTrack ? row.pid : undefined}')
    // it runs after ui/milestones in the run's order
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const main = script.slice(script.indexOf('await milestoneWindowCheck()\n'))
    expect(main.indexOf('await roadmapMilestonesCheck()')).toBeGreaterThan(0)
    expect(main.indexOf('await roadmapMilestonesCheck()')).toBeLessThan(
      main.indexOf('await teamSyncCheck()'),
    )
    // the window is two weeks back to six on, with a week to spare at each end
    expect(inDefaultWindow('2026-11-23', '2026-11-06', 1)).toBe(true)
    expect(inDefaultWindow('2026-12-07', '2026-11-06', 1)).toBe(true)
    expect(inDefaultWindow('2026-10-26', '2026-11-06', 1)).toBe(true)
    // must fail: past the window's last week less the spare one, or before it
    expect(inDefaultWindow('2026-12-14', '2026-11-06', 1)).toBe(false)
    expect(inDefaultWindow('2026-10-19', '2026-11-06', 1)).toBe(false)
    // a week starting on Sunday
    expect(inDefaultWindow('2026-12-06', '2026-11-06', 0)).toBe(true)
    expect(inDefaultWindow('2026-12-13', '2026-11-06', 0)).toBe(false)
    // the flag's move goes to the next week M leaves free, still in the
    // window, through the store's flag move
    const moved = freeMilestoneWeek(['2026-11-23'], '2026-11-06', 1)
    expect(moved).toBe('2026-11-30')
    expect(inDefaultWindow(moved, '2026-11-06', 1)).toBe(true)
    expect(script).toContain('window.PLANNER.setMilestone(id, window.PLANNER.isoToWeek(day))')
    const planner = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    for (const mark of ['setMilestone: (id: string, week: number', 'isoToWeek'])
      expect(planner).toContain(mark)
  })
  it("checks the Overview's Upcoming and collapsed Past on the deployment's section read, and My view's with mine", () => {
    expect(OVERVIEW_MILESTONES_STEP).toBe('ui/overview-milestones')
    expect(MILESTONES_SECTION_QUERY).toBe('milestones:section')
    // the marks the step waits on and presses
    const source = [
      '../src/views/overview/OverviewMilestones.tsx',
      '../src/components/MilestoneSectionPart.tsx',
    ]
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')
    for (const mark of [
      'data-overview-milestones',
      'data-overview-milestone={m.id}',
      'data-milestone-past-toggle',
      'aria-expanded={ms.pastOpen}',
      'data-milestone-section={side}',
      'data-milestone-section-state={open ? view.state : undefined}',
      'data-milestone-more',
      "aria-busy={view.more === 'loading' || undefined}",
    ])
      expect(source, mark).toContain(mark)
    // it runs after ui/roadmap-milestones and before ui/team-sync
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const main = script.slice(script.indexOf('await roadmapMilestonesCheck()\n'))
    expect(main.indexOf('await overviewMilestonesCheck()')).toBeGreaterThan(0)
    expect(main.indexOf('await overviewMilestonesCheck()')).toBeLessThan(
      main.indexOf('await teamSyncCheck()'),
    )
    // the arguments of each subscription a frame adds
    const add = (udfPath, args) =>
      JSON.stringify({
        type: 'ModifyQuerySet',
        modifications: [{ type: 'Add', queryId: 1, udfPath, args: [args] }],
      })
    const mine = { projects: [], mine: true, from: '2026-11-02', side: 'upcoming', limit: 10 }
    expect(addedArgs(add(MILESTONES_SECTION_QUERY, mine), MILESTONES_SECTION_QUERY)).toEqual([mine])
    // must fail: another query, a removal and text that is no JSON add none
    expect(addedArgs(add(MILESTONES_BETWEEN_QUERY, mine), MILESTONES_SECTION_QUERY)).toEqual([])
    expect(
      addedArgs(
        JSON.stringify({
          type: 'ModifyQuerySet',
          modifications: [{ type: 'Remove', queryId: 1 }],
        }),
        MILESTONES_SECTION_QUERY,
      ),
    ).toEqual([])
    expect(addedArgs('not json', MILESTONES_SECTION_QUERY)).toEqual([])
  })

  it("checks the removal window on a sub-project of its own, in the window's words", () => {
    const modals = readFileSync(new URL('../src/panels/Modals.tsx', import.meta.url), 'utf8')
    expect(modals).toContain("'Reassign and remove'")
    expect(modals).toMatch(/aria-label=\{`New assignee: \$\{label\}`\}/)
    expect(modals).toContain('data-access-removal-task={i.task_id}')
    expect(REMOVAL_STEP).toBe('ui/removal-window')
    expect(REMOVAL_EXPECTED.submit).toBe('Reassign and remove')
    expect(REMOVAL_EXPECTED.chosen('Nora Berg')).toBe('New assignee: Nora Berg')
  })
  it("checks a project's Settings page on the page's own selectors, after the removal window", () => {
    const page = readFileSync(
      new URL('../src/components/ProjectAccessEditor.tsx', import.meta.url),
      'utf8',
    )
    for (const mark of [
      'data-project-team-role={row.id}',
      'data-project-access-picker=""',
      'probe="data-project-access-picker-search"',
      'data-project-access-choice={row.id}',
      'data-project-access-new-role',
      'data-add-project-user',
      'data-project-access-user={row.id}',
    ])
      expect(page).toContain(mark)
    const settings = readFileSync(
      new URL('../src/panels/settings/ProjectSettings.tsx', import.meta.url),
      'utf8',
    )
    expect(settings).toContain('data-project-review-hours')
    expect(PROJECT_SETTINGS_STEP).toBe('ui/project-settings')
    expect(PROJECT_SETTINGS_EXPECTED).toEqual({ team: 'viewer', nora: 'user', reviewHours: 3 })
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await projectSettingsCheck()')).toBeGreaterThan(
      check.indexOf('await removalWindowCheck()'),
    )
  })
  it("checks the New project and New sub-project dialogs on their own marks, after a project's Settings page", () => {
    const source = [
      '../src/panels/Modals.tsx',
      '../src/components/ProjectAccessSelect.tsx',
      '../src/components/ProjectAccessEditor.tsx',
    ]
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')
    for (const mark of [
      'data-project-lead-picker',
      'probe="data-lead-picker-search"',
      'data-lead-choice={person.id}',
      'data-new-project-access',
      'data-new-project-access-popup',
      'probe="data-project-access-search"',
      "'data-project-access-team-option': row.id",
      "'data-project-team-role'",
      "'data-project-access-user-option': row.id",
      "'data-project-role'",
      "{ 'data-project-access-selected-option': `user:",
      "'data-project-access-selected-role'",
      'data-new-subproject-parent=',
      'probe="data-new-subproject-parent-search"',
      'data-new-subproject-parent-choice={row.id}',
      'id="subproject-starter"',
    ])
      expect(source).toContain(mark)
    expect(PROJECT_DIALOGS_STEP).toBe('ui/project-dialogs')
    expect(PROJECT_DIALOGS_EXPECTED).toEqual({ team: 'viewer', nora: 'user' })
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await projectDialogsCheck()')).toBeGreaterThan(
      check.indexOf('await projectSettingsCheck()'),
    )
    // New sub-project opens on the run's project M and picks the step's
    // own project from the list, so only a pick that changes the parent
    // passes
    const step = check.slice(
      check.indexOf('async function projectDialogsCheck()'),
      check.indexOf('export const BILLING_STORAGE_STEP'),
    )
    expect(step).toContain(`app.locator(\`aside [data-project-row="\${M.id}"]\`)`)
    // M's address first, so the sidebar's tree reads on to M's row
    // wherever it sorts
    expect(step.indexOf(`/board/p/\${M.num}`)).toBeGreaterThan(-1)
    expect(step.indexOf(`/board/p/\${M.num}`)).toBeLessThan(
      step.indexOf(`app.locator(\`aside [data-project-row="\${M.id}"]\`)`),
    )
    expect(step).toContain(`sub.locator(\`[data-new-subproject-parent="\${M.id}"]\`)`)
    expect(step.indexOf(`[data-new-subproject-parent-choice="\${project.id}"]`)).toBeLessThan(
      step.indexOf(`.locator(\`[data-new-subproject-parent="\${project.id}"]\`)`),
    )
    expect(step).toContain(`eq(madeSub.parent_id, project.id, "the sub-project's parent")`)
    // Nora's automatic entry is checked as it is, never clicked, once the
    // popover opened with its search cleared and before the team's search,
    // since Selected shows only while the search is empty
    const mine = `app.locator(\`[data-project-access-selected-option="user:\${run.nora.id}"]\`)`
    expect(step).toContain(mine)
    expect(step).not.toContain(`[data-project-access-user-option="\${run.nora.id}"]`)
    expect(source).toContain("const selected = typed === '' &&")
    expect(step.indexOf("await dialog.locator('[data-new-project-access]').click()")).toBeLessThan(
      step.indexOf(mine),
    )
    const teamSearch = step.indexOf('await pressSearched(\n      search,\n      team.name,')
    expect(teamSearch).toBeGreaterThan(-1)
    expect(step.indexOf(mine)).toBeLessThan(teamSearch)
    // its project goes in the cleanup
    expect(check).toContain(
      'if (run.projects.D) await deleteProjectInApp(c.writeToken, run.projects.D)',
    )
  })

  it("checks an admin's management of a project she takes no part in, after the dialogs step, and deletes that project itself", () => {
    const pages = [
      '../src/panels/settings/ProjectLists.tsx',
      '../src/panels/settings/ArchivedTasks.tsx',
    ]
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
      .join('\n')
    for (const mark of [
      ADMIN_MANAGEMENT_MARKS.search,
      ADMIN_MANAGEMENT_MARKS.list,
      ADMIN_MANAGEMENT_MARKS.row,
      ADMIN_MANAGEMENT_MARKS.subRow,
      ADMIN_MANAGEMENT_MARKS.archived,
    ])
      expect(pages).toContain(mark)
    expect(pages).toContain(ADMIN_MANAGEMENT_MARKS.unavailable)
    expect(ADMIN_MANAGEMENT_STEP).toBe('ui/admin-management')
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await adminManagementCheck()')).toBeGreaterThan(
      check.indexOf('await projectDialogsCheck()'),
    )
    expect(check.indexOf('await adminManagementCheck()')).toBeLessThan(
      check.indexOf('await archiveChecks()'),
    )
    const step = check.slice(
      check.indexOf('async function adminManagementCheck()'),
      check.indexOf('export const BILLING_STORAGE_STEP'),
    )
    // the row menu opens only once the search has answered, as the list
    // before it goes with any menu opened on it
    expect(step.indexOf('names.every((name) => name.includes(run.tag))')).toBeLessThan(
      step.indexOf("getByRole('button', { name: 'Project actions', exact: true })"),
    )
    // Nora takes no part in the project before anything is checked
    expect(step.indexOf('/access/users/')).toBeLessThan(step.indexOf('eq(read.access?.read, false'))
    // Search must hold its control row before the managed task's absence counts
    expect(step.indexOf('(await item(control.key).count()) === 1')).toBeLessThan(
      step.indexOf("eq(await item(managed.key).count(), 0, 'the managed task in Search')"),
    )
    // the row menu's Archived tasks, apart from the Settings navigation's
    // item of the same name, which shows beside the non-modal menu
    expect(step).toContain(
      `.locator('[data-slot="popover-content"]')\n      .getByRole('button', { name: 'Archived tasks', exact: true })`,
    )
    expect(step).not.toContain("app.getByRole('button', { name: 'Archived tasks', exact: true })")
    // the step deletes its project itself, also after a failure, under its
    // own id, so a failed delete never replaces the step's own failure
    expect(ADMIN_MANAGEMENT_CLEANUP).toBe('cleanup/admin-management')
    expect(step).not.toContain('} finally {')
    const cleanup =
      'if (project) await check(ADMIN_MANAGEMENT_CLEANUP, () => deleteProjectInApp(w, project))'
    expect(step.indexOf(cleanup)).toBeGreaterThan(
      step.indexOf('await check(ADMIN_MANAGEMENT_STEP, async () => {'),
    )
    expect(step.indexOf(cleanup)).toBeGreaterThan(step.lastIndexOf('  })\n'))
  })

  it('archives first only a project the server says the caller reads, and deletes any other as it is', () => {
    const read = (json) => projectDeleteRoute({ status: 200, json })
    expect(read({ access: { read: true, write: true }, archived: false })).toBe('archive')
    expect(read({ access: { read: true, write: false }, archived: true })).toBe('archive')
    // a project Nora only manages, live or archived
    expect(read({ access: { read: false, write: false }, archived: false })).toBe('direct')
    expect(read({ access: { read: false, write: false }, archived: true })).toBe('direct')
    // an answer that says nothing of reading never archives
    expect(read({ archived: false })).toBe('direct')
    expect(projectDeleteRoute({ status: 500, json: null })).toBe('direct')
    expect(projectDeleteRoute(undefined)).toBe('direct')
  })

  it("deletes a project by the server's answer through the store, and sweeps the projects Nora only manages, live and archived", () => {
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const remove = check.slice(
      check.indexOf('async function deleteProjectInApp('),
      check.indexOf('async function appMessages('),
    )
    // the server's answer decides, never the store's copy
    expect(remove).not.toContain('window.PLANNER.project(id)')
    // an archive first, which REST confirms, since the app holds no project
    const route = remove.indexOf("if (projectDeleteRoute(current) === 'archive') {")
    const confirmed = remove.indexOf('expect(archived.json?.archived === true')
    const removed = remove.indexOf('window.PLANNER.removeProject(id, undefined, {')
    expect(route).toBeGreaterThan(-1)
    expect(confirmed).toBeGreaterThan(route)
    expect(removed).toBeGreaterThan(confirmed)
    expect(remove).not.toContain('archivedProjects')
    const sweep = check.slice(
      check.indexOf('async function sweep('),
      check.indexOf('async function removeTokenInApp('),
    )
    expect(sweep).toContain(
      'window.PLANNER.subProjectParents(window.PLANNER.homeOrg, search, after)',
    )
    expect(sweep).toContain(
      'window.PLANNER.settingsArchivedProjects(window.PLANNER.homeOrg, search, after)',
    )
    // an archived entry alone, as a row beneath an archived parent goes
    // with it
    expect(sweep).toContain('.filter((p) => !p.under && matches(p.name))')
    for (const pass of ["step('managed projects'", "step('managed archived projects'"])
      expect(sweep.indexOf(pass)).toBeLessThan(sweep.indexOf("step('tasks'"))
    // and the check for leftovers in the app reads both
    const left = sweep.slice(sweep.indexOf("step('the check for leftovers in the app'"))
    expect(left).toContain('[...(await managedLive()), ...(await managedArchived())]')
  })
  it("checks Settings › Projects and Archived projects on the pages' own marks, after a project's Settings page", () => {
    const pages = readFileSync(
      new URL('../src/panels/settings/ProjectLists.tsx', import.meta.url),
      'utf8',
    )
    expect(SETTINGS_PROJECTS_STEP).toBe('ui/settings-projects')
    for (const mark of Object.values(SETTINGS_PROJECTS_MARKS)) expect(pages).toContain(mark)
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await settingsProjectsCheck()')).toBeGreaterThan(
      check.indexOf('await projectSettingsCheck()'),
    )
    // its project goes in the cleanup with its sub-projects
    expect(check).toContain(
      'if (run.projects.L) await deleteProjectInApp(c.writeToken, run.projects.L)',
    )
  })
  it("reads the run's projects by id while M is active, and finds what a wrong answer gets wrong", () => {
    expect(PROJECT_BY_IDS_STEP).toBe('ui/project-by-ids')
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    // after the last UI step before the archive, and through the store's read
    expect(check.indexOf('await projectByIdsCheck()')).toBeGreaterThan(
      check.indexOf('await inboxListCheck()'),
    )
    expect(check.indexOf('await projectByIdsCheck()')).toBeLessThan(
      check.indexOf('await archiveChecks()'),
    )
    expect(check).toContain('window.PLANNER.projectsByIds(asked)')
    const ids = { M: 'm', A: 'a', Z: 'z', unknown: 'u', archived: 'x' }
    const row = (id, parent_id, level = 'user') => ({ id, parent_id, level })
    const right = { rows: [row('m', null, 'lead'), row('a', 'm'), row('z', 'm')], unchecked: [] }
    expect(byIdsProblems(right, ids)).toEqual([])
    // each kind of wrong answer is named
    expect(byIdsProblems(null, ids)).toHaveLength(1)
    expect(byIdsProblems({ ...right, rows: right.rows.slice(1) }, ids)).toEqual([
      'M answered 0 times',
    ])
    expect(
      byIdsProblems({ ...right, rows: [row('m', null, 'user'), ...right.rows.slice(1)] }, ids),
    ).toHaveLength(1)
    expect(byIdsProblems({ ...right, rows: [...right.rows, row('m', null, 'lead')] }, ids)).toEqual(
      ['M answered 2 times'],
    )
    expect(
      byIdsProblems({ ...right, rows: [right.rows[0], row('a', 'z'), right.rows[2]] }, ids),
    ).toEqual(['Alpha answered parent z'])
    expect(byIdsProblems({ ...right, rows: [...right.rows, row('x', null)] }, ids)).toEqual([
      'the archived project answered',
    ])
    expect(byIdsProblems({ ...right, rows: [...right.rows, row('u', null)] }, ids)).toEqual([
      'the unknown id answered',
    ])
    expect(byIdsProblems({ ...right, unchecked: ['z'] }, ids)).toEqual(['listed apart ["z"]'])
  })
  it('checks the boot, the New task picker and the scope menu with no projects part, and finds what wrong frames get wrong', () => {
    expect(PROJECTS_PART_STEP).toBe('ui/projects-part')
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    // after the reads by id, while M is active, before the archive
    expect(check.indexOf('await projectsPartCheck()')).toBeGreaterThan(
      check.indexOf('await projectByIdsCheck()'),
    )
    expect(check.indexOf('await projectsPartCheck()')).toBeLessThan(
      check.indexOf('await archiveChecks()'),
    )
    // the searches type the run's tag, so the run's rows show on staging
    expect(check).toContain('.fill(run.tag)')
    const picker = readFileSync(
      new URL('../src/components/TargetPicker.tsx', import.meta.url),
      'utf8',
    )
    const menu = readFileSync(
      new URL('../src/views/teamSync/SyncScopeMenu.tsx', import.meta.url),
      'utf8',
    )
    for (const mark of Object.values(PROJECTS_PART_MARKS))
      expect(picker.includes(mark) || menu.includes(mark)).toBe(true)
    expect(PROJECTS_PART).toBe('workspace:projects')
    const frame = (udfPath, args) =>
      JSON.stringify({
        type: 'ModifyQuerySet',
        modifications: [{ type: 'Add', udfPath, args: [args] }],
      })
    const boot = [frame('workspace:root', {}), frame('projectNav:byIds', { ids: ['m', 'a'] })]
    expect(projectsPartProblems(boot, { byIdsOf: 'm' })).toEqual([])
    // the removed part, a byIds read that names another project, none
    expect(
      projectsPartProblems([...boot, frame('workspace:projects', {})], { byIdsOf: 'm' }),
    ).toEqual(['subscribed workspace:projects'])
    expect(projectsPartProblems(boot, { byIdsOf: 'z' })).toEqual([
      'no projectNav:byIds frame named z',
    ])
    expect(projectsPartProblems([frame('workspace:root', {})], { byIdsOf: 'm' })).toHaveLength(1)
    // the scope menu's list in the home organization, not every seat's
    expect(
      projectsPartProblems([frame('projectNav:page', { org_id: 'h' })], { pageOf: 'h' }),
    ).toEqual([])
    expect(projectsPartProblems([frame('projectNav:page', {})], { pageOf: 'h' })).toEqual([
      'no projectNav:page frame with organization h',
    ])
    // the Roadmap's fresh loads hold the same clause
    const clause = (view) => `\`${view}'s Roadmap subscribed $\{PROJECTS_PART}\``
    expect(check).toContain(clause('M'))
    expect(check).toContain(clause('My view'))
  })
  it('checks the All projects directory on its own marks and words, after Settings › Projects', () => {
    const page = readFileSync(
      new URL('../src/components/ProjectDirectory.tsx', import.meta.url),
      'utf8',
    )
    expect(PROJECT_DIRECTORY_STEP).toBe('ui/project-directory')
    for (const mark of Object.values(PROJECT_DIRECTORY_MARKS)) expect(page).toContain(mark)
    // the open rule the directory shares (projectNavRows.tsx), which opens
    // a row's project at once, so the step presses once
    expect(page).toContain('nav.open(row)')
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await projectDirectoryCheck()')).toBeGreaterThan(
      check.indexOf('await settingsProjectsCheck()'),
    )
    // on the run's own project, while it is active, adding no project the
    // later tag searches would list
    expect(check.indexOf('await projectDirectoryCheck()')).toBeLessThan(
      check.indexOf('await archiveChecks()'),
    )
    const step = check.slice(
      check.indexOf('async function projectDirectoryCheck()'),
      check.indexOf('/** The step that checks Settings › Projects › Deleted items'),
    )
    expect(step).toContain('const { M, A, Z } = run.projects')
    expect(step).not.toContain("'POST', '/projects'")
    // it waits for Zulu's own address and name, not any page but the
    // directory
    expect(step).toContain('atProject(path(), Z.num)')
    expect(step.indexOf('await child(Z).click()')).toBeLessThan(
      step.indexOf('atProject(path(), Z.num)'),
    )
    expect(step.split('await child(Z).click()')).toHaveLength(2)
    expect(step).toContain("app.locator('[data-scope-crumb] h1')")
    // the browse list answered with a row before any search, and the star
    // puts M ahead of Alpha, which sorts before it by name
    const browse = /\[\$\{m\.page\}\]\[\$\{m\.state\}="ok"\] \[\$\{m\.row\}\]/
    expect(step).toMatch(browse)
    expect(step.search(browse)).toBeLessThan(step.indexOf('await search(run.tag)'))
    expect(step).toContain('order.indexOf(M.id) < order.indexOf(A.id)')
  })
  it("checks the sidebar's project tree on its own marks, after the directory and before the archive", () => {
    const tree = readFileSync(
      new URL('../src/components/SidebarProjects.tsx', import.meta.url),
      'utf8',
    )
    expect(SIDEBAR_PROJECTS_STEP).toBe('ui/sidebar-projects')
    for (const mark of Object.values(SIDEBAR_PROJECTS_MARKS)) expect(tree).toContain(mark)
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await sidebarProjectsCheck()')).toBeGreaterThan(
      check.indexOf('await projectDirectoryCheck()'),
    )
    expect(check.indexOf('await sidebarProjectsCheck()')).toBeLessThan(
      check.indexOf('await archiveChecks()'),
    )
    const step = check.slice(
      check.indexOf('async function sidebarProjectsCheck()'),
      check.indexOf('/** The step that checks Settings › Projects › Deleted items'),
    )
    // on the run's own M, Alpha and Zulu, adding no project
    expect(step).toContain('const { M, A, Z } = run.projects')
    expect(step).not.toContain("'POST', '/projects'")
    // M's address first, then the tree's answered list and M's lit row
    const address = step.indexOf(`/board/p/\${M.num}`)
    const ok = step.indexOf(`[\${m.state}="ok"]`)
    const lit = step.indexOf(`[\${m.row}="\${M.id}"][data-on]`)
    expect(address).toBeGreaterThan(-1)
    expect(ok).toBeGreaterThan(address)
    expect(lit).toBeGreaterThan(ok)
    // the star and the unstar go through the store, also after a failure
    expect(step).toContain(
      'window.PLANNER.setFavorite({ id, org_id: window.PLANNER.homeOrg }, want)',
    )
    expect(step).toContain('if (starred) await setStar(false)')
    // Zulu's own address after one press, which opens it at once, its lit
    // row, and no scrollbar
    expect(step).toContain('atProject(path(), Z.num)')
    expect(step.split("await child(Z).locator('button').first().click()")).toHaveLength(2)
    expect(step).toContain(`[\${m.child}="\${Z.id}"][data-on]`)
    expect(step).toContain('getComputedStyle(el).scrollbarWidth')
  })
  it('checks the old All projects address and a numbered project page on their own marks, after startup selection and before the archive', () => {
    const sources = [
      '../src/App.tsx',
      '../src/components/ProjectChooser.tsx',
      '../src/panels/settings/ProjectSettings.tsx',
      '../src/panels/Settings.tsx',
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
      .join('\n')
    for (const mark of Object.values(OLD_PATHS_MARKS)) expect(sources).toContain(mark)
    expect(OLD_PATHS_STEP).toBe('ui/old-paths')
    expect(OLD_PATHS_CLEANUP).toBe('cleanup/old-paths')
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const at = check.indexOf('await oldPathsCheck()')
    expect(at).toBeGreaterThan(check.indexOf('await startupSelectionCheck()'))
    expect(at).toBeGreaterThan(check.indexOf('await adminManagementCheck()'))
    expect(at).toBeLessThan(check.indexOf('await archiveChecks()'))
    const step = check.slice(
      check.indexOf('async function oldPathsCheck()'),
      check.indexOf('/** The step that checks startup selection (startupSelectionCheck). */'),
    )
    // the old address first, then the managed project by its number, a
    // reload of it, and a number no project holds
    const old = step.indexOf('/board/all`')
    const managed = step.indexOf(`/access/users/\${run.nora.id}`)
    const numbered = step.indexOf(`/settings/project/\${project.num}`)
    const reload = step.indexOf('app.reload(')
    const free = step.indexOf('+ 100_000')
    expect(old).toBeGreaterThan(-1)
    expect(managed).toBeGreaterThan(old)
    expect(numbered).toBeGreaterThan(managed)
    expect(reload).toBeGreaterThan(numbered)
    expect(free).toBeGreaterThan(reload)
    expect(step).toContain("!path().endsWith('/all')")
    expect(step).toContain("'/app/~/settings/account'")
    // its own project goes at its end, also after a failure, under its own id
    const cleanup =
      'if (project) await check(OLD_PATHS_CLEANUP, () => deleteProjectInApp(w, project))'
    expect(step.indexOf(cleanup)).toBeGreaterThan(step.indexOf('await check(OLD_PATHS_STEP'))
    // no step opens an address that names all projects but this one: the
    // sign-in, the thread pages' leave and both Searches open the directory
    const rest = check.replace(step, '')
    expect(rest).not.toMatch(/goto\(`[^`]*\/(board|overview|roadmap)\/all\b/)
    expect(check).toContain(`app.goto(\`\${cfg.appOrigin}/app/~/projects\``)
  })

  it('checks startup selection on its own marks and note, after the tree and before the deleted items and the archive', () => {
    const chooser = readFileSync(
      new URL('../src/components/ProjectChooser.tsx', import.meta.url),
      'utf8',
    )
    const picker = readFileSync(
      new URL('../src/components/ProjectPicker.tsx', import.meta.url),
      'utf8',
    )
    expect(STARTUP_SELECTION_STEP).toBe('ui/startup-selection')
    for (const mark of Object.values(STARTUP_SELECTION_MARKS))
      expect(chooser + picker).toContain(mark)
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain(`'${STARTUP_LOST_NOTE}'`)
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const at = check.indexOf('await startupSelectionCheck()')
    expect(at).toBeGreaterThan(check.indexOf('await sidebarProjectsCheck()'))
    expect(at).toBeLessThan(check.indexOf('await deletedItemsCheck()'))
    expect(at).toBeLessThan(check.indexOf('await archiveChecks()'))
    // its own project goes in the cleanup
    expect(check).toContain(
      'if (run.projects.S) await deleteProjectInApp(c.writeToken, run.projects.S)',
    )
    const step = check.slice(
      check.indexOf('async function startupSelectionCheck()'),
      check.indexOf('/** The step that chooses projects through the shared project picker'),
    )
    // S1 by its address and remembered, then the bare address read from the
    // server's copy once the browser's is gone, with no chooser but its check
    const address = step.indexOf(`/board/p/\${S1.num}`)
    const cleared = step.indexOf("key.startsWith('planner.ui.v1:')")
    const bare = step.indexOf(`\`\${cfg.appOrigin}/app/\${ORG_SLUG}\``)
    expect(address).toBeGreaterThan(-1)
    expect(address).toBeLessThan(step.indexOf("app.locator('aside [data-mine-nav]').click()"))
    expect(cleared).toBeGreaterThan(step.indexOf("app.locator('aside [data-all-nav]').click()"))
    expect(bare).toBeGreaterThan(cleared)
    expect(step).toContain("states.every((state) => state === 'checking')")
    // archived over REST, then the lost chooser, a search and M
    const archived = step.indexOf(`\`/projects/\${S.id}\`, { archived: true }`)
    expect(archived).toBeGreaterThan(bare)
    expect(step.indexOf(`[\${m.state}="lost"]`)).toBeGreaterThan(archived)
    expect(step).toContain('.fill(run.tag)')
    expect(step).toContain('await opens(M)')
  })
  it('reads the directory’s groups, and refuses a page that breaks favorites first', () => {
    const fav = { group: 'favorites' }
    const rest = { group: 'rest' }
    const on = (row) => ({ row, starred: true })
    const off = (row) => ({ row, starred: false })
    expect(directoryGroups([fav, on('m'), rest, off('alpha'), off('n')])).toEqual({
      m: 'favorites',
      alpha: 'rest',
      n: 'rest',
    })
    // a page with no favorite has no headings
    expect(directoryGroups([off('alpha'), off('m')])).toEqual({ alpha: null, m: null })
    expect(directoryGroups([fav, on('m'), on('k')])).toEqual({ m: 'favorites', k: 'favorites' })
    // Other projects before Favorites, a heading twice, a starred row under
    // Other projects and an unstarred one under Favorites
    for (const broken of [
      [rest, off('alpha'), fav, on('m')],
      [fav, on('m'), fav, on('k')],
      [fav, on('m'), rest, off('alpha'), on('k')],
      [fav, on('m'), off('alpha'), rest, off('n')],
    ])
      expect(directoryGroups(broken), JSON.stringify(broken)).toBeNull()
  })
  it("tells Zulu's own project address from every other the directory could open", () => {
    expect(atProject('/app/acme/board/p/12', 12)).toBe(true)
    expect(atProject('/app/acme/roadmap/p/12/tasks/AC-4', 12)).toBe(true)
    // another project, a number that starts or ends the same, the views
    // over all projects and the directory itself are not Zulu's
    for (const other of [
      '/app/acme/board/p/1',
      '/app/acme/board/p/123',
      '/app/acme/board/p/112',
      '/app/acme/overview/all',
      '/app/~/projects',
    ])
      expect(atProject(other, 12), other).toBe(false)
  })
  it("checks Settings › Users and the creators line in the pages' own words", () => {
    const users = readFileSync(
      new URL('../src/panels/settings/UsersSettings.tsx', import.meta.url),
      'utf8',
    )
    const general = readFileSync(
      new URL('../src/panels/settings/OrganizationSettings.tsx', import.meta.url),
      'utf8',
    )
    expect(SETTINGS_USERS_STEP).toBe('ui/settings-users')
    expect(SETTINGS_USERS_EXPECTED).toEqual({
      none: 'No people match.',
      creators: ' can create projects.',
    })
    expect(users).toContain(`none: '${SETTINGS_USERS_EXPECTED.none}'`)
    for (const mark of ['data-users-search', 'data-users-state', 'data-users-page-row'])
      expect(users).toContain(mark)
    expect(general).toContain('data-creators-state')
    expect(general).toMatch(/\{' '\}\s*can create projects\./)
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await settingsUsersCheck()')).toBeGreaterThan(
      check.indexOf('await settingsLabelsCheck()'),
    )
    // the app's key list is read per organization, never the deprecated query
    expect(check).not.toContain('listAgentKeys')
  })
  describe('the creators line', () => {
    /* `n` creators named `word` and a number, every `agentEvery`th an
       agent, as REST lists them. */
    const people = (n, agentEvery = 0, word = 'Person') =>
      Array.from({ length: n }, (_, i) => ({
        id: `${word}${i}`,
        name: `${word} ${i}`,
        kind: agentEvery && i % agentEvery === agentEvery - 1 ? 'agent' : 'person',
      }))
    /* The page's phrase for the server's answer over `creators`. */
    const page = (creators) => {
      const counted = creators.slice(2, 102)
      const answer =
        creators.length <= 3
          ? { creators, others: 0, more: false, agents: 0 }
          : {
              creators: creators.slice(0, 2),
              others: counted.length,
              more: creators.length > 102,
              agents: counted.filter((c) => c.kind === 'agent').length,
            }
      return creatorPhrase({
        ...answer,
        creators: answer.creators.map((c) => ({
          id: c.id,
          name: c.name,
          agent: c.kind === 'agent',
        })),
      })
        .map((part) => part.text)
        .join('')
    }
    it('words it as the page does, exact to 100 and past it', () => {
      for (const [n, every] of [
        [1, 0],
        [3, 3],
        [4, 0],
        [39, 0],
        [39, 10],
        [102, 0],
        [103, 0],
        [400, 7],
      ])
        expect(creatorsLine(people(n, every)), `${n} creators`).toBe(page(people(n, every)))
      expect(creatorsLine(people(39, 10))).toBe(
        'Person 0, Person 1 and 37 more, including 3 agents,',
      )
      expect(creatorsLine(people(400))).toBe('Person 0, Person 1 and more than 100 others')
    })
    it('checks the admins it names under Selected users, whoever else was chosen', () => {
      /* Whether the page's line over `creators` starts as the check
         expects for `admins`. */
      const holds = (admins, creators) => {
        const line = `${page(creators)}${SETTINGS_USERS_EXPECTED.creators}`
        return selectedCreatorsStarts(admins).some((start) => line.startsWith(start))
      }
      for (const a of [1, 2, 3, 5])
        for (const c of [0, 1, 2, 3, 150]) {
          const admins = people(a, 0, 'Admin')
          const chosen = people(c, 3, 'Chosen')
          expect(holds(admins, [...admins, ...chosen]), `${a} admins, ${c} chosen`).toBe(true)
          // a line that names someone else first fails, and so do two
          // admins the other way round
          expect(holds(admins, [...people(1, 0, 'Other'), ...admins, ...chosen])).toBe(false)
          if (a > 1)
            expect(holds(admins, [admins[1], admins[0], ...admins.slice(2), ...chosen])).toBe(false)
        }
      expect(selectedCreatorsStarts([])).toEqual([])
    })
  })
  it("checks the organization export on the panel's own marks, after Deleted items, with the picker's stand-in scoped to its session flag", async () => {
    expect(ORG_EXPORT_STEP).toBe('ui/org-export')
    const panel = readFileSync(
      new URL('../src/panels/OrganizationExport.tsx', import.meta.url),
      'utf8',
    )
    for (const mark of Object.values(ORG_EXPORT_MARKS)) expect(panel, mark).toContain(mark)
    expect(ORG_EXPORT_READY_MS).toBe(5 * 60_000)
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    // it runs after Deleted items' step
    const at = ['await deletedItemsCheck()', 'await orgExportCheck()'].map((call) =>
      script.indexOf(call),
    )
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const step = script.slice(
      script.indexOf('async function orgExportCheck()'),
      script.indexOf('/** The Settings page Archived tasks opens'),
    )
    // the stand-in goes in before the navigation, the flag and the file go
    // in its finally, and so does the run's Deleted item
    expect(step.indexOf('context.addInitScript(ORG_EXPORT_PICKER)')).toBeLessThan(
      step.indexOf('settings/org-general'),
    )
    // it waits for its own job, collecting or under a new id, before it
    // waits for ready, so an earlier ready archive never passes for it
    const own = step.indexOf("=== 'collecting' ||")
    expect(own).toBeGreaterThan(step.indexOf('m.start}]`).click()'))
    expect(step.indexOf('!== earlier')).toBeGreaterThan(own)
    const ready = step.indexOf('const ready = await until(')
    expect(ready).toBeGreaterThan(own)
    // the step awaits its own job, as an expectation, before the ready wait
    const awaited = step.indexOf('await until(own, ORG_EXPORT_READY_MS)')
    expect(awaited).toBeGreaterThan(own)
    expect(awaited).toBeLessThan(ready)
    expect(step.slice(step.lastIndexOf('expect(', awaited), awaited)).toMatch(/^expect\(\s*$/)
    expect(step.slice(ready, step.indexOf("=== 'ready'", ready))).toContain('!== earlier')
    const after = step.slice(step.indexOf('} finally {'))
    for (const part of [
      'sessionStorage.removeItem(flag)',
      'removeEntry(name)',
      'await purgeExportItem(itemId, gone, title)',
    ])
      expect(after, part).toContain(part)
    // the purge also runs without the archive's item id, finding the item
    // by the task's key and tagged title, and says a NOTE when it is not
    // done. It purges only the archive's item or the one the search
    // verified, and nothing when the search verified none.
    const purge = script.slice(
      script.indexOf('async function purgeExportItem('),
      script.indexOf('export function exportItemOf('),
    )
    expect(purge).toContain(
      'itemId === null ? await deletedTaskItem({ key: gone.key, title }) : { id: itemId }',
    )
    expect(purge.indexOf('if (found.id === null) {')).toBeGreaterThan(-1)
    expect(purge.indexOf('if (found.id === null) {')).toBeLessThan(
      purge.indexOf('purgeDeletedItems'),
    )
    expect(purge).toContain('const id = found.id')
    expect(purge.match(/say\(\s*'NOTE'/g)).toHaveLength(3)
    expect(purge).not.toContain('.catch(() => {})')
    // the search finds the item only once the search answered, from every
    // row's key and title, never the first row it sees
    const finder = script.slice(
      script.indexOf('async function deletedTaskItem('),
      script.indexOf('/** The Settings page Archived tasks opens'),
    )
    const typed = finder.indexOf('.fill(own.title)')
    expect(typed).toBeGreaterThan(-1)
    const settled = finder.indexOf('m.state}="ok"]`).count()) === 0) return false')
    expect(settled).toBeGreaterThan(typed)
    expect(finder.indexOf('const mine = exportItemOf(rows, own)')).toBeGreaterThan(settled)
    expect(finder).toContain('[m.row, m.key, m.title]')
    expect(finder).not.toContain('.first()')
    expect(finder).not.toContain('getAttribute(m.row)')
    // the stand-in answers a file only under its flag, else the browser's
    // own picker stays
    const stand = (flag, native = true) => {
      const picker = native ? () => 'native' : undefined
      const page = {
        sessionStorage: { getItem: (name) => (name === ORG_EXPORT_PICKER_FLAG ? flag : null) },
        navigator: {
          storage: {
            getDirectory: async () => ({
              getFileHandle: async (name, options) => ({ name, options }),
            }),
          },
        },
        window: { showSaveFilePicker: picker },
      }
      new Function('sessionStorage', 'navigator', 'window', ORG_EXPORT_PICKER)(
        page.sessionStorage,
        page.navigator,
        page.window,
      )
      return page.window.showSaveFilePicker
    }
    expect(stand(null)()).toBe('native')
    expect(await stand('1')()).toEqual({ name: ORG_EXPORT_FILE, options: { create: true } })
    // a browser without a save picker gets none, so its page keeps the link
    expect(stand('1', false)).toBeUndefined()
    // by the link the step reads the browser's download, which nothing records
    const from = step.indexOf("      if (way === 'link') {\n        expect(")
    expect(from).toBeGreaterThan(-1)
    const link = step.slice(from, step.indexOf('\n      } else {', from))
    expect(link).toContain('m.sent')
    // the download's file is waited for with a bound and cancelled past it
    expect(link).toMatch(/await within\(\s*download\.path\(\),\s*ORG_EXPORT_DOWNLOAD_MS,/)
    expect(link).toContain('await download.cancel()')
    // every download the page started is stopped before its file goes
    const cleanup = step.slice(step.lastIndexOf('} finally {'))
    expect(cleanup.indexOf('await download.cancel()')).toBeGreaterThan(-1)
    expect(cleanup.indexOf('await download.cancel()')).toBeLessThan(
      cleanup.indexOf('within(download.delete(),'),
    )
    // nothing may record a save the app could not confirm
    for (const none of [
      "m.recorded}]`).count(), 0, 'record marks after a download')",
      "m.saved}]`).count(), 0, 'saved lines after a download')",
      "eq(await lastExport(), recordedBefore, 'the record line after a download')",
    ])
      expect(link, none).toContain(none)
    // Chromium never passes over the file way
    expect(step).toContain("if (cfg.browser === 'chromium') eq(way, 'file',")
    // the download is this job's, by the export's id in its address
    expect(link).toContain('exportOfLink(each.url()) === ownId')
    expect(link).not.toContain('downloads[downloads.length - 1]')
    expect(exportOfLink('http://127.0.0.1:3237/exports/k57abc?e=1&m=2&t=3')).toBe('k57abc')
    expect(exportOfLink('https://x.convex.site/api/exports/k57abc?t=3')).toBe('k57abc')
    for (const other of [
      'http://127.0.0.1:3237/files/k57abc',
      'http://127.0.0.1:3237/exports/',
      'http://127.0.0.1:3237/exports/k57abc/part',
      'not an address',
    ])
      expect(exportOfLink(other), other).toBeNull()
    // the record line is waited for before its text is the baseline
    expect(step).toMatch(
      /const lastExport = async \(\) => \{\s+const line = [^\n]+\s+await line\.waitFor\(/,
    )
    expect(exportWayOf({ secure: true, picker: true })).toBe('file')
    expect(exportWayOf({ secure: true, picker: false })).toBe('link')
    expect(exportWayOf({ secure: false, picker: true })).toBe('link')
    expect(ORG_EXPORT_DOWNLOAD_MS).toBe(2 * 60_000)
  })

  it("takes the export step's Deleted item only from an answered search, as the one row of the task's key and title", () => {
    const own = { key: 'QN-41', title: 'stgchk-1 Exported deleted' }
    const mine = { id: 'item-own', ...own }
    const other = { id: 'item-other', key: 'QN-7', title: 'stgchk-1 Deleted 3' }
    // while the search is pending the page shows its earlier rows, an
    // unrelated deleted task first, and nothing is taken
    expect(exportItemOf([other], own)).toBeUndefined()
    expect(exportItemOf([other, mine], own)).toBeUndefined()
    expect(exportItemOf([], own)).toBeUndefined()
    // a hidden row has no title mark
    expect(exportItemOf([{ ...mine, title: null }], own)).toBeUndefined()
    // the answered search takes the one row of the task
    expect(exportItemOf([mine], own)).toEqual({ id: 'item-own' })
    // a row of the title but another key, or two of the key, take nothing
    expect(exportItemOf([{ ...other, title: own.title }], own)).toEqual({
      id: null,
      why: 'Deleted items lists no row of QN-41 titled “stgchk-1 Exported deleted”',
    })
    expect(exportItemOf([mine, { ...mine, id: 'item-twin' }], own)).toEqual({
      id: null,
      why: 'Deleted items lists 2 rows of QN-41 titled “stgchk-1 Exported deleted”',
    })
  })

  it("checks Deleted items on the page's own marks, after Settings › Projects, restoring 26 tasks in two calls", () => {
    const page = readFileSync(
      new URL('../src/panels/settings/DeletedItems.tsx', import.meta.url),
      'utf8',
    )
    expect(DELETED_ITEMS_STEP).toBe('ui/deleted-items')
    // the page's end line names its marks after the page's hook
    // (src/components/pageFold.tsx)
    const fromHook = [
      DELETED_ITEMS_MARKS.next,
      DELETED_ITEMS_MARKS.previous,
      DELETED_ITEMS_MARKS.end,
    ]
    // and its Retry is the end line's own
    const fold = readFileSync(new URL('../src/components/pageFold.tsx', import.meta.url), 'utf8')
    for (const mark of Object.values(DELETED_ITEMS_MARKS))
      if (fromHook.includes(mark)) expect(page).toContain('hook="deleted-page"')
      else if (mark === DELETED_ITEMS_MARKS.retry) expect(fold).toContain(`${mark}=""`)
      else expect(page).toContain(mark)
    expect(DELETED_ITEMS_MARKS.next).toBe('data-deleted-page-next')
    expect(DELETED_ITEMS_MARKS.end).toBe('data-deleted-page-end')
    expect(DELETED_ITEMS_MARKS.previous).toBe('data-deleted-page-previous')
    // the step waits for the page's own sentence for a search that matches
    // nothing
    const [before, after] = DELETED_ITEMS_EXPECTED.none('WORDS').split('WORDS')
    expect(page).toContain(`none: \`${before}\${search.settled}${after}\``)
    // the window's paragraph is the shared runner's keep-open sentence
    const runner = readFileSync(new URL('../src/lib/batchRunner.ts', import.meta.url), 'utf8')
    expect(DELETED_ITEMS_EXPECTED.keepOpen).toBe(
      `Restoring them runs in steps. ${/KEEP_OPEN =\s*'([^']+)'/.exec(runner)?.[1]}`,
    )
    // 26 tasks are one more than a call takes, so the restore takes two
    expect(DELETED_ITEMS_EXPECTED.tasks).toBe(LIMITS.restoreBatch.max + 1)
    expect(DELETED_ITEMS_EXPECTED.selected).toBe('26 selected, 25 on other pages')
    // the end toast the store words, also with tasks that finish in the
    // background, and never one that counts a refusal
    const tasks = Array.from({ length: 26 }, (_, n) => ({ id: `t${n}`, org_id: 'o', kind: 'task' }))
    const tally = { kind: 'restore', asked: tasks, following: [], unsent: [] }
    for (const stepping of [0, 1, 3])
      expect(endText({ ...tally, done: 26, stepping, refused: 0 }).text).toMatch(
        DELETED_ITEMS_EXPECTED.toast,
      )
    expect(endText({ ...tally, done: 25, stepping: 0, refused: 1 }).text).not.toMatch(
      DELETED_ITEMS_EXPECTED.toast,
    )
    // the step reads the visible toast, never the screen reader's copy
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain(`<div className="${TOAST_HOST}">`)
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await deletedItemsCheck()')).toBeGreaterThan(
      check.indexOf('await settingsProjectsCheck()'),
    )
    const step = check.slice(
      check.indexOf('async function deletedItemsCheck()'),
      check.indexOf('/** The Settings page Archived tasks opens'),
    )
    // the tasks go in the cleanup, and the sub-project is deleted for good
    // only after the restore, so the restore never takes it along
    expect(step).toContain('run.created.push(...made)')
    expect(step.indexOf('DELETED_ITEMS_EXPECTED.toast')).toBeLessThan(
      step.indexOf('await deleteProjectInApp(w, sub)'),
    )
    expect(step).toContain("getByRole('radio', { name: 'Tasks', exact: true })")
    // the 26 deletes are one folded run, opened before the first page counts
    const opened = step.indexOf('await showAll.first().click()')
    expect(opened).toBeGreaterThan(-1)
    expect(opened).toBeLessThan(step.indexOf('(await rows.count()) === 25'))
    // the search is answered before the scope and the selection, since a
    // changed search clears the selection
    const answered = step.indexOf('=== none')
    const typed = step.indexOf('await typeSearch(app.locator(`[')
    expect(typed).toBeGreaterThan(-1)
    expect(answered).toBeGreaterThan(typed)
    // the scope goes through pickProject, which waits until the picker has
    // closed, since the open picker lies over the kinds
    const scoped = step.indexOf('await pickProject(app.locator(')
    expect(answered).toBeLessThan(scoped)
    expect(scoped).toBeLessThan(step.indexOf("getByRole('radio', { name: 'Tasks', exact: true })"))
    expect(step.slice(scoped, scoped + 80)).toContain('m.scope}]`), run.tag, M.id)')
    expect(step).not.toContain('[data-project-picker-search]')
    expect(answered).toBeLessThan(step.indexOf('m.selectAll}]`).click()'))
    expect(step).toMatch(
      /\.locator\(`\.\$\{TOAST_HOST\}`\)\s*\.getByText\(DELETED_ITEMS_EXPECTED\.toast\)/,
    )
    // the sub-project's menu shows only once its tasks moved, which can
    // take longer than a click's own wait
    expect(step).toMatch(/locator\(`\[\$\{m\.menu\}\]`\)\.click\(\{ timeout: 60_000 \}\)/)
    // the sub-project's menu opens only once the search is answered, which
    // lists it alone
    const alone = step.indexOf('(await listed.count()) === 1')
    expect(alone).toBeGreaterThan(step.indexOf('Deleted sub`)'))
    expect(alone).toBeLessThan(step.indexOf('m.menu}]`).click('))
  })
  it("opens task links in the window's own words, with the unknown number past every organization's", () => {
    const window = readFileSync(new URL('../src/panels/IssueDetail.tsx', import.meta.url), 'utf8')
    expect(window).toContain(
      " can't be opened. It may not exist, or you may not have access to it.`",
    )
    expect(window).toContain(' was archived. Restore it to bring it back to the board.`')
    expect(TASK_LINK_STEP).toBe('ui/task-link')
    expect(TASK_LINK_UNKNOWN).toEqual({
      ref: 'qn-99999999',
      note: "QN-99999999 can't be opened. It may not exist, or you may not have access to it.",
    })
    // a number the server's ref grammar reads, which no organization reaches
    expect(Number(TASK_LINK_UNKNOWN.ref.slice(3))).toBeLessThanOrEqual(2147483647)
  })
  it("names Team sync's step and the agenda query its app subscribes", () => {
    expect(TEAM_SYNC_STEP).toBe('ui/team-sync')
    expect(AGENDA_QUERY).toBe('teamSync:agenda')
    // the store reads the agenda by that name, and the page names its state
    const store = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    expect(store).toContain('ref: api.teamSync.agenda')
    const page = readFileSync(new URL('../src/views/TeamSync.tsx', import.meta.url), 'utf8')
    expect(page).toContain('data-sync-state={meeting.state}')
    const add = (udfPath) => ({ type: 'ModifyQuerySet', modifications: [{ type: 'Add', udfPath }] })
    expect(addsQuery(JSON.stringify(add(AGENDA_QUERY)), AGENDA_QUERY)).toBe(true)
    expect(addsQuery(JSON.stringify(add('teamSync:lastComments')), AGENDA_QUERY)).toBe(false)
  })
  it('drives the owner lists and the Mention window through their own marks, and posts nothing', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    expect(OWNER_PICKERS_STEP).toBe('ui/owner-pickers')
    expect(OWNER_PICKERS_PERSON).toBe('Leo Martins')
    expect(OWNER_PICKERS_NAMES).toEqual({ project: 'Owners', task: 'owner pickers' })
    // the marks the step finds, in the app
    const owners = read('../src/components/AssigneeAvatar.tsx')
    for (const mark of [
      'data-owner-list={shown}',
      "const OWNER_SEARCH = 'data-owner-search'",
      'data-owner-choice={person.id}',
      'data-fieldselect',
      'data-owner-field={field}',
    ])
      expect(owners).toContain(mark)
    const card = read('../src/views/teamSync/SyncCard.tsx')
    for (const mark of [
      "const MENTION_SEARCH = 'data-sync-mention-search'",
      'data-sync-mention-person={person.id}',
      'data-sync-mention-line=""',
      'data-sync-mention-window={it.id}',
      'data-sync-mention-send',
    ])
      expect(card).toContain(mark)
    // the line Send shows for a person who lost sight of the task
    expect(card).toContain(`can no longer be mentioned on this task. Pick someone else.`)
    expect(card).toContain(MENTION_GONE)
    const check = read('./staging-check.mjs')
    // it runs after Team sync's step and before the Inbox badge's, while M
    // is active
    const at = check.indexOf('await ownerPickersCheck()')
    expect(at).toBeGreaterThan(check.indexOf('await teamSyncCheck()'))
    expect(at).toBeLessThan(check.indexOf('await inboxBadgeCheck()'))
    const step = check.slice(
      check.indexOf('async function ownerPickersCheck()'),
      check.indexOf('export const INBOX_BADGE_STEP'),
    )
    // Leo loses sight over REST before Send, which must post nothing
    const lost = step.indexOf('await until(async () => !(await reaches()))')
    expect(lost).toBeGreaterThan(0)
    expect(step).toContain("/users`, 'users')).some((u) => u.id === leo.id)")
    // a handover leaves the outgoing lead a User grant, which goes too
    expect(step.indexOf("'DELETE', `/projects/")).toBeGreaterThan(0)
    expect(step.indexOf("'DELETE', `/projects/")).toBeLessThan(lost)
    expect(lost).toBeLessThan(step.indexOf("'[data-sync-mention-send]'"))
    expect(step).toContain('eq(await comments(), before')
    // it assigns only the run's agent and Nora, and posts no comment
    expect(step).not.toMatch(/'POST', `\/tasks\/[^`]*\/comments`/)
    expect(step).toContain("pick(field('Assignee'), std.name, std.id)")
  })

  it("names the Inbox badge's step, and reads the store's summary and item the app keeps", () => {
    expect(INBOX_BADGE_STEP).toBe('ui/inbox-badge')
    // the step reads these from the page, and the top bar's hooks
    const store = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    expect(store).toContain('inboxSummary: {')
    expect(store).toContain('inboxItem: null as InboxItemVM | null')
    const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('data-inbox-badge-state={badge.state ?? undefined}')
    // it runs after Team sync and before the archive, while t0 is active
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const order = ['await teamSyncCheck()', 'await inboxBadgeCheck()', 'await archiveChecks()']
    const at = order.map((call) => script.indexOf(call))
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
  it("names the hidden task window's step and reads, and names a Remove by its Add", () => {
    expect(HIDDEN_TASK_WINDOW_STEP).toBe('ui/hidden-task-window')
    expect(HIDDEN_WINDOW_READS).toEqual([
      'snapshot:threadComments',
      'inbox:item',
      'taskWindow:task',
    ])
    // the store reads them by those names, and the window marks its reads
    const store = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    for (const read of ['api.snapshot.threadComments', 'api.inbox.item', 'api.taskWindow.task'])
      expect(store).toContain(read)
    const window = readFileSync(new URL('../src/panels/IssueDetail.tsx', import.meta.url), 'utf8')
    expect(window).toContain('data-task-window-reads=')
    // it runs after the badge's step and before the Inbox list's, while t0 is active
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const order = [
      'await inboxBadgeCheck()',
      'await hiddenTaskWindowCheck()',
      'await inboxListCheck()',
    ]
    const at = order.map((call) => script.indexOf(call))
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const step = script.slice(
      script.indexOf('async function hiddenTaskWindowCheck()'),
      script.indexOf('export const INBOX_LIST_STEP'),
    )
    // it hides the page as a background tab is, waits 15 s for no read, and
    // removes t0's notification in its cleanup
    expect(step).toContain("document.dispatchEvent(new Event('visibilitychange'))")
    expect(step).toContain('await sleep(15_000)')
    expect(step.indexOf('finally')).toBeLessThan(step.indexOf('Remove notification'))
    // a Remove carries its queryId alone, named per socket by its Add
    const frame = (socket, modifications) => ({
      socket,
      text: JSON.stringify({
        type: 'ModifyQuerySet',
        baseVersion: 1,
        newVersion: 2,
        modifications,
      }),
    })
    const changes = querySetChanges([
      frame(1, [
        { type: 'Add', queryId: 4, udfPath: 'inbox:item', args: [{}] },
        { type: 'Add', queryId: 5, udfPath: 'taskWindow:task', args: [{}] },
      ]),
      { socket: 1, text: 'not json' },
      { socket: 1, text: JSON.stringify({ type: 'Mutation', udfPath: 'messages:readItem' }) },
      frame(1, [{ type: 'Remove', queryId: 4 }]),
      // the same id on another connection is another query
      frame(2, [{ type: 'Remove', queryId: 5 }]),
      frame(2, [{ type: 'Add', queryId: 5, udfPath: 'snapshot:threadComments', args: [{}] }]),
      frame(2, [{ type: 'Remove', queryId: 5 }]),
    ])
    expect(changes).toEqual([
      { change: 'add', query: 'inbox:item' },
      { change: 'add', query: 'taskWindow:task' },
      { change: 'remove', query: 'inbox:item' },
      { change: 'remove', query: null },
      { change: 'add', query: 'snapshot:threadComments' },
      { change: 'remove', query: 'snapshot:threadComments' },
    ])
  })

  it("names the Inbox list's step, its read and marks, and reads its frames", () => {
    expect(INBOX_LIST_STEP).toBe('ui/inbox-list')
    expect(INBOX_PAGE_QUERY).toBe('inbox:page')
    // the list reads its pages by that name, and its marks are the Inbox's
    const inbox = readFileSync(new URL('../src/panels/Inbox.tsx', import.meta.url), 'utf8')
    expect(inbox).toContain('query: api.inbox.page')
    expect(inbox).toContain('hook="inbox-page"')
    const fromHook = [INBOX_LIST_MARKS.next, INBOX_LIST_MARKS.previous]
    for (const mark of Object.values(INBOX_LIST_MARKS))
      if (!fromHook.includes(mark)) expect(inbox).toContain(mark)
    expect(fromHook).toEqual(['data-inbox-page-next', 'data-inbox-page-previous'])
    // it runs after the badge's step and before the archive, while t0 is active
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const order = ['await inboxBadgeCheck()', 'await inboxListCheck()', 'await archiveChecks()']
    const at = order.map((call) => script.indexOf(call))
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // a mutation frame's arguments, and a page's arguments from its Add
    const mutation = (udfPath, args) =>
      JSON.stringify({ type: 'Mutation', requestId: 3, udfPath, args: [args] })
    const read = { org_id: 'o', issue_id: 't', through: 12.5 }
    expect(sentMutation(mutation('messages:readItem', read), 'messages:readItem')).toEqual(read)
    expect(sentMutation(mutation('messages:unreadItem', read), 'messages:readItem')).toBeNull()
    expect(sentMutation('not json', 'messages:readItem')).toBeNull()
    const add = (udfPath, args) => ({ type: 'Add', queryId: 1, udfPath, args: [args] })
    const frame = JSON.stringify({
      type: 'ModifyQuerySet',
      modifications: [add(INBOX_PAGE_QUERY, { search: 'QN-1' }), add('workspace:root', {})],
    })
    expect(addedArgs(frame, INBOX_PAGE_QUERY)).toEqual([{ search: 'QN-1' }])
    expect(addedArgs(frame, 'taskWindow:task')).toEqual([])
  })
  it("names the delivery step and its marks, runs it after the feed's, and puts back what it changed", () => {
    expect(NOTIFICATION_DELIVERY_STEP).toBe('ui/notification-delivery')
    expect(NOTIFICATION_DELIVERY_MARKS).toEqual({
      mirror: '__qivoNotify',
      notes: '__qivoNotes',
      control: 'data-notification-delivery',
      state: 'data-notification-delivery-state',
      summaryTag: 'qivo:catch-up',
    })
    // the store mirrors the leader by that name, and the field carries the
    // control's marks
    const store = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    expect(store).toContain(`page.${NOTIFICATION_DELIVERY_MARKS.mirror} = state`)
    const field = readFileSync(
      new URL('../src/panels/settings/NotificationDeliveryField.tsx', import.meta.url),
      'utf8',
    )
    expect(field).toContain(`${NOTIFICATION_DELIVERY_MARKS.control}={shown}`)
    expect(field).toContain(`${NOTIFICATION_DELIVERY_MARKS.state}=`)
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const order = [
      'await inboxFeedCheck()',
      'await notificationDeliveryCheck()',
      'await archiveChecks()',
    ]
    const at = order.map((call) => script.indexOf(call))
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    const step = script.slice(
      script.indexOf('async function notificationDeliveryCheck()'),
      script.indexOf("/** What the Overview of the run's own sub-project shows"),
    )
    // its own context with the run's bypass, signed in, and signed out,
    // with the mode put back, t0's item removed and the context closed
    expect(step).toContain('await routeBypass(own)')
    expect(step).toContain('signInBrowser(first, cfg.nora)')
    expect(step).toContain("getByRole('button', { name: 'Sign out', exact: true })")
    // a sign-in counts once it went through, before the app shows, so a
    // session whose app never loads is signed out too, by the account
    // page or the app's own sign-out request
    const signedIn = step.indexOf('authenticated = true')
    expect(signedIn).toBeGreaterThan(step.indexOf('signInBrowser(first, cfg.nora)'))
    expect(signedIn).toBeLessThan(step.indexOf("waitForSelector('[data-all-nav]'"))
    expect(step).toContain('const page = !authenticated')
    expect(step).toContain('window.PLANNER?.signOut?.()')
    expect(step).toContain('restoreDelivery(control, noted)')
    expect(step).toContain('removeInboxRow(page, t0)')
    expect(step).toContain('await own.close()')
    expect(step.indexOf('} finally {')).toBeLessThan(
      step.indexOf('restoreDelivery(control, noted)'),
    )
    // the mode put back is the one the control shows ready from the server,
    // and a cleanup that could not do its part fails a step that passed
    const restore = script.slice(
      script.indexOf('async function restoreDelivery('),
      script.indexOf('/** The leader tab of a browser profile and the Notification delivery'),
    )
    expect(restore).toContain('selectOption(mode)')
    expect(restore).toContain('(await deliveryShown(page)) === mode')
    expect(step).toContain('expect(left.length === 0')
    // the leader closes so its beforeunload runs, as a person's close does
    expect(step).toContain('leader.close({ runBeforeUnload: true })')
  })

  it("names the Inbox feed's step, its reads and marks, and reads the notification calls", () => {
    expect(INBOX_FEED_STEP).toBe('ui/inbox-feed')
    expect(INBOX_FEED_QUERY).toBe('inbox:feed')
    expect(INBOX_PART_QUERY).toBe('workspace:inbox')
    // the store watches the feed by that name, and the client tags its
    // summary and mirrors its alerts by these
    const store = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    expect(store).toContain("watchSide('feed', api.inbox.feed, { after })")
    const client = readFileSync(new URL('../src/lib/notificationFeed.ts', import.meta.url), 'utf8')
    expect(client).toContain(`SUMMARY_TAG = '${INBOX_FEED_MARKS.summaryTag}'`)
    const notify = readFileSync(new URL('../src/lib/notify.ts', import.meta.url), 'utf8')
    expect(notify).toContain(`window.${INBOX_FEED_MARKS.notes}.push`)
    // it runs after the list's step and before the archive, while t0 is active
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const order = ['await inboxListCheck()', 'await inboxFeedCheck()', 'await archiveChecks()']
    const at = order.map((call) => script.indexOf(call))
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // the route is set before the page loads, and the step gives the
    // permission back
    const step = script.slice(
      script.indexOf('async function inboxFeedCheck()'),
      script.indexOf("/** Removes task `task`'s item from the Inbox page"),
    )
    expect(step.indexOf('page.routeWebSocket(')).toBeGreaterThan(0)
    expect(step.indexOf('page.routeWebSocket(')).toBeLessThan(step.indexOf('page.goto('))
    expect(step).toContain('context.clearPermissions()')
    // the app page comes back to the app for the steps and the cleanup after
    expect(step.indexOf('await showApp()')).toBeGreaterThan(
      step.indexOf('context.clearPermissions()'),
    )
    // a notification call's name and arguments, and nothing for any other frame
    const frame = (udfPath, args) =>
      JSON.stringify({ type: 'Mutation', requestId: 4, udfPath, args: [args] })
    expect(notificationCall(frame('notifications:claimAlerts', { events: [] }))).toEqual({
      name: 'notifications:claimAlerts',
      args: { events: [] },
    })
    expect(notificationCall(frame('messages:readItem', {}))).toBeNull()
    expect(notificationCall('not json')).toBeNull()
  })
  it('names the own reads step, keeps its checks in order, and tells a frame that subscribes a query from every other frame', () => {
    expect(OWN_READS_STEP).toBe('ui/own-reads')
    expect(ROADMAP_QUERY).toBe('tasks:roadmap')
    expect(ASSIGNEE_LOAD_QUERY).toBe('planning:assigneeLoad')
    // the registry subscribes the root part alone and no task window, so
    // no step checks for one
    const parts = readFileSync(new URL('../src/store/liveParts.ts', import.meta.url), 'utf8')
    expect(parts).not.toContain('api.workspace.tasks')
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(script).not.toContain('workspace:tasks')
    expect(script).not.toContain('ui/tasks-on-demand')
    // the step keeps the Board's, the task address's and the Roadmap's
    // checks, once each, in that order
    const step = script.slice(
      script.indexOf('async function ownReadsCheck()'),
      script.indexOf('/** The step that creates a task through the Board'),
    )
    const order = [
      '/board/p/',
      '/tasks/',
      '/roadmap/p/',
      'adds(ROADMAP_QUERY) > 0',
      'eq(adds(ASSIGNEE_LOAD_QUERY), 0',
    ].map((text) => step.indexOf(text))
    expect(order.every((n) => n > 0)).toBe(true)
    expect([...order].sort((x, y) => x - y)).toEqual(order)
    const add = (udfPath) => ({ type: 'Add', queryId: 1, udfPath, args: [{}] })
    const frame = (...modifications) =>
      JSON.stringify({ type: 'ModifyQuerySet', baseVersion: 0, newVersion: 1, modifications })
    expect(addsQuery(frame(add(ROADMAP_QUERY)), ROADMAP_QUERY)).toBe(true)
    expect(addsQuery(frame(add('workspace:root'), add(ROADMAP_QUERY)), ROADMAP_QUERY)).toBe(true)
    // another query, a removal, another message and no JSON are not one
    expect(addsQuery(frame(add('workspace:root')), ROADMAP_QUERY)).toBe(false)
    expect(
      addsQuery(frame({ type: 'Remove', queryId: 1, udfPath: ROADMAP_QUERY }), ROADMAP_QUERY),
    ).toBe(false)
    expect(
      addsQuery(JSON.stringify({ type: 'Mutation', udfPath: ROADMAP_QUERY }), ROADMAP_QUERY),
    ).toBe(false)
    expect(addsQuery('not json', ROADMAP_QUERY)).toBe(false)
  })

  it("tells a create's request, its answer and the reads of the new task that went out before it", () => {
    expect(CREATE_ANSWER_STEP).toBe('ui/create-answer')
    expect(CREATE_MUTATION).toBe('issues:create')
    expect(NEW_TASK_READS).toEqual(['taskWindow:task', 'snapshot:threadComments', 'inbox:item'])
    // the app's names for them
    const store = readFileSync(new URL('../src/store/planner.ts', import.meta.url), 'utf8')
    expect(store).toContain('api.issues.create,')
    const parts = readFileSync(new URL('../src/store/liveParts.ts', import.meta.url), 'utf8')
    for (const name of ['api.taskWindow.task', 'api.snapshot.threadComments', 'api.inbox.item'])
      expect(store + parts).toContain(name)
    const uuid = '0f6e2c7a-1111-4222-8333-444455556666'
    const out = (text) => ({ out: true, text: JSON.stringify(text) })
    const back = (text) => ({ out: false, text: JSON.stringify(text) })
    const create = out({
      type: 'Mutation',
      requestId: 7,
      udfPath: 'issues:create',
      args: [{ id: uuid }],
    })
    const rename = out({
      type: 'Mutation',
      requestId: 8,
      udfPath: 'issues:update',
      args: [{ id: uuid }],
    })
    const answer = back({
      type: 'MutationResponse',
      requestId: 7,
      success: true,
      result: { num: 41 },
    })
    const read = (udfPath, args) =>
      out({
        type: 'ModifyQuerySet',
        baseVersion: 3,
        newVersion: 4,
        modifications: [{ type: 'Add', queryId: 9, udfPath, args: [args] }],
      })
    const windowRead = read('taskWindow:task', { org_id: 'org', ref: uuid })
    // a correct app: the create, a change behind it, the answer, then the reads
    const good = createOrder([
      create,
      rename,
      back({ type: 'Transition', startVersion: {}, endVersion: {}, modifications: [] }),
      answer,
      windowRead,
      read('snapshot:threadComments', { org_id: 'org', issue_id: uuid }),
      read('inbox:item', { issue_id: uuid }),
    ])
    expect(good).toEqual({ uuid, answered: true, num: 41, early: [] })
    // a read of the task sent before the answer is caught
    const early = createOrder([create, windowRead, answer])
    expect(early?.early).toEqual([windowRead.text])
    // a read of another task, or an answer to another write, is no answer
    expect(createOrder([create, read('taskWindow:task', { ref: 'other' }), answer])?.early).toEqual(
      [],
    )
    expect(createOrder([create, back({ type: 'MutationResponse', requestId: 8 })])?.answered).toBe(
      false,
    )
    // the number the server stored the task with, which a refusal names not
    const refused = back({ type: 'MutationResponse', requestId: 7, success: false, result: 'no' })
    expect(createOrder([create, refused])).toMatchObject({ answered: true, num: null })
    expect(answeredNum('not json')).toBeNull()
    expect(createOrder([rename, answer])).toBeNull()
    expect(mutationRequest('not json', CREATE_MUTATION)).toBeNull()
    expect(answersMutation('not json', 7)).toBe(false)
    expect(addsQueryFor('not json', 'taskWindow:task', uuid)).toBe(false)
    // the step runs after ui/own-reads and before the run archives M
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const at = ['await ownReadsCheck()', 'await createAnswerCheck()', 'await archiveChecks()'].map(
      (call) => script.indexOf(call),
    )
    expect(at.every((n) => n > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // in a sub-project of its own, with the run's tag
    const step = script.slice(
      script.indexOf('async function createAnswerCheck()'),
      script.indexOf('export const UPLOAD_STEP'),
    )
    expect(step).toContain("restOk(w, 'POST', '/projects', {")
    expect(step).toContain('`$' + '{run.tag} create answer`')
    expect(step).toContain("'framereceived'")
    // it knows the task by the uuid its create sent and its key by the
    // number the create's answer stored, never by the key the window
    // showed first, which another create meanwhile moves
    expect(step).toContain('`/tasks/$' + '{order.uuid}`')
    expect(step).toContain('const key = `QN-$' + '{order.num}`')
    expect(step.indexOf('createOrder(frames)')).toBeLessThan(step.indexOf('[data-card="'))
    // the marks it presses and reads
    const board = readFileSync(new URL('../src/views/Kanban.tsx', import.meta.url), 'utf8')
    expect(board).toContain('aria-label={`New task in $' + '{s.name}`}')
    const window = readFileSync(new URL('../src/panels/IssueDetail.tsx', import.meta.url), 'utf8')
    for (const mark of ['aria-label="Task title"', 'data-task-title', 'data-issue-key'])
      expect(window).toContain(mark)
  })

  it("checks Billing's storage on a file of its own, in the page's words", () => {
    const list = readFileSync(new URL('../src/panels/BillingStorage.tsx', import.meta.url), 'utf8')
    const usage = readFileSync(new URL('../src/panels/BillingUsage.tsx', import.meta.url), 'utf8')
    // the step compares the size span's text exactly, so the mark is on the
    // span that holds the size and file count alone
    expect(list).toMatch(
      /data-billing-storage-size=""[^>]*>\s*\{billingBytes\(row\.bytes\)\} · \{row\.files === 1 \? '1 file'/,
    )
    for (const mark of [
      'data-billing-storage=""',
      'data-billing-storage-search=""',
      'data-billing-storage-row={storageRowId(row)}',
    ])
      expect(list).toContain(mark)
    expect(usage).toContain('data-billing-storage-bytes=""')
    expect(usage).toContain('STORAGE_COUNTING')
    expect(BILLING_STORAGE_STEP).toBe('ui/billing-storage')
    expect(BILLING_STORAGE_EXPECTED).toEqual({
      bytes: 2048,
      row: `${billingBytes(2048)} · 1 file`,
      counting: STORAGE_COUNTING,
    })
  })

  it("checks Billing's API calls by account and Who counts toward your bill on the run's agents, after the storage step", () => {
    const sources = [
      '../src/panels/BillingUsage.tsx',
      '../src/panels/BillingApiAccounts.tsx',
      '../src/panels/BillingAccountNames.tsx',
      '../src/panels/BillingOverview.tsx',
      '../src/panels/settings/ApiAccessSettings.tsx',
    ]
      .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
      .join('\n')
    // every mark the step reads is on the page
    for (const mark of Object.values(BILLING_ACCOUNTS_MARKS)) expect(sources).toContain(mark)
    expect(BILLING_ACCOUNTS_STEP).toBe('ui/billing-accounts')
    // the step tells a counted figure from the counting sentence
    expect(BILLING_STORAGE_EXPECTED.counting).toBe(CALLS_COUNTING)
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(check.indexOf('await billingAccountsCheck()')).toBeGreaterThan(
      check.indexOf('await billingStorageCheck()'),
    )
    const step = check.slice(
      check.indexOf('async function billingAccountsCheck()'),
      check.indexOf('export const SETTINGS_PROJECTS_STEP'),
    )
    // one call with each agent key still in use, before Billing opens
    expect(step).toContain(
      "for (const cred of [c.stdKey, c.viewerKey]) await restOk(cred, 'GET', '/me')",
    )
    expect(step.indexOf("restOk(cred, 'GET', '/me')")).toBeLessThan(
      step.indexOf('app.goto(billing'),
    )
    // it reads; the only write is the usage those calls make
    expect(step).not.toMatch(/restOk\([^)]*'(POST|PUT|PATCH|DELETE)'/)
    expect(step).toContain(`await app.locator(\`[\${m.search}]\`).fill(run.tag)`)
    expect(step).toContain(`await app.locator(\`[\${m.namesSearch}="billable"]\`).fill(run.tag)`)
    expect(step).toContain(`eq(await app.locator(\`[\${m.accessPeriod}]\`).inputValue(), period`)
  })

  it("checks MCP access's two lists on the run's connections and tokens, after the Billing accounts step", () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const sources = [
      read('../src/panels/ConnectedApps.tsx'),
      read('../src/panels/settings/PersonalTokens.tsx'),
    ].join('\n')
    // every mark the step and the credential helpers read is on the page
    for (const mark of Object.values(MCP_ACCESS_MARKS)) expect(sources).toContain(mark)
    expect(sources).toContain(`line('${MCP_ACCESS_EXPECTED.none}')`)
    expect(MCP_ACCESS_LISTS_STEP).toBe('ui/mcp-access-lists')
    const check = read('./staging-check.mjs')
    const at = check.indexOf('await mcpAccessListsCheck()')
    expect(at).toBeGreaterThan(check.indexOf('await billingAccountsCheck()'))
    // while the run's tokens and connections are still live
    expect(at).toBeLessThan(check.indexOf("check('read-token/ui/revoke'"))
    expect(at).toBeLessThan(check.indexOf("check('oauth-read/ui/delete'"))
    // every read of the app's two lists names its search and its cursor,
    // a batch at a time, and the sweep and its check for leftovers go on
    // from each batch's cursor
    const listReads =
      check.match(/window\.PLANNER\.(?:connectedApps|personalTokens)\([^)]*\)/g) ?? []
    for (const read of listReads) expect(read).toMatch(/\(search, (?:cursor|null)\)$/)
    for (const list of ['connectedApps', 'personalTokens'])
      expect(
        listReads.filter((read) => read === `window.PLANNER.${list}(search, cursor)`),
      ).toHaveLength(2)
    const step = check.slice(
      check.indexOf('async function mcpAccessListsCheck()'),
      check.indexOf('export const SETTINGS_PROJECTS_STEP'),
    )
    // it writes nothing, and falls back to the store's read without the box
    expect(step).not.toMatch(/restOk\(|\.mutation\(|\.click\(/)
    expect(step).toContain('window.PLANNER.personalTokens(search, null)')
    // a list without its box is also searched for the run tag through the
    // store, which must answer the run's two rows alone
    expect(step).toMatch(
      /if \(!appsSearched\)\s+same\(\s+wholeBatchNames\(\s+await evaluate\(app, \(search\) => window\.PLANNER\.connectedApps\(search, null\), tag\),\s+\(row\) => row\.clientName,\s+\),\s+appNames,/,
    )
    expect(step).toMatch(
      /if \(!tokensSearched\)\s+same\(\s+wholeBatchNames\(\s+await evaluate\(app, \(search\) => window\.PLANNER\.personalTokens\(search, null\), tag\),\s+\(row\) => row\.name,\s+\),\s+tokenNames,/,
    )
    const rows = [{ name: 'a' }, { name: 'b' }]
    expect(wholeBatchNames({ rows, next: null, stopped: false }, (row) => row.name)).toEqual([
      'a',
      'b',
    ])
    // a batch that does not end the list, or a failed read, names nothing
    expect(wholeBatchNames({ rows, next: 'more', stopped: true }, (row) => row.name)).toBeNull()
    expect(wholeBatchNames(null, (row) => row.name)).toBeNull()
  })

  it("waits for an MCP access list to answer the typed search, never the earlier list's end", () => {
    expect(mcpListSettled('end', 'tag', 'tag')).toBe(true)
    expect(mcpListSettled('none', '', '')).toBe(true)
    expect(mcpListSettled('more', 'tag', ' tag ')).toBe(true)
    // the search is on its way
    expect(mcpListSettled('loading', 'tag', 'tag')).toBe(false)
    // typing has not rested, so the end line still answers the earlier search
    expect(mcpListSettled('end', '', 'tag')).toBe(false)
    expect(mcpListSettled('none', 'tag', 'tag no such token')).toBe(false)
    expect(mcpListSettled(null, null, '')).toBe(false)
    // the helper waits on that, not on a fixed time
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const helpers = check.slice(
      check.indexOf('async function listSettled('),
      check.indexOf('/** Creates a personal token through the New token dialog'),
    )
    expect(helpers).toContain('mcpListSettled(end, settled, text)')
    expect(helpers).toContain('await listSettled(list, text)')
    expect(helpers).not.toMatch(/sleep\(/)
  })

  it('reads every batch of an app list, going on after a stopped one and failing on a failed read', async () => {
    const batches = [
      { rows: ['a', 'b'], next: 'first', stopped: false },
      { rows: [], next: 'second', stopped: true },
      { rows: ['c'], next: null, stopped: false },
    ]
    const asked = []
    const rows = await appBatches('personal tokens', async (cursor) => {
      asked.push(cursor)
      return batches[asked.length - 1]
    })
    expect(rows).toEqual(['a', 'b', 'c'])
    expect(asked).toEqual([null, 'first', 'second'])
    // a failed read fails the list, never reads as an empty one
    await expect(
      appBatches('OAuth connections', async (cursor) => (cursor === null ? batches[0] : null)),
    ).rejects.toThrow('the app could not list OAuth connections')
    // it stops at the cap rather than reading without end
    let reads = 0
    await expect(
      appBatches('personal tokens', async () => {
        reads++
        return { rows: [], next: 'again', stopped: true }
      }),
    ).rejects.toThrow(`more than ${APP_BATCHES_MAX} batches`)
    expect(reads).toBe(APP_BATCHES_MAX)
  })

  it("loads a description's images near view at phone size, after the upload step", () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const check = read('./staging-check.mjs')
    expect(DESCRIPTION_IMAGES_STEP).toBe('ui/description-images')
    const at = check.indexOf('await descriptionImagesCheck()')
    expect(at).toBeGreaterThan(check.indexOf('await attachmentUploadCheck()'))
    expect(at).toBeLessThan(check.indexOf('await settingsProjectsCheck()'))
    // both image views mark their wrapper with the attachment, around its img
    expect(read('../src/components/markdown.tsx')).toContain("'data-att': attId")
    expect(read('../src/components/descEditor.tsx')).toContain('data-att={attId || undefined}')
    expect(read('../src/components/inlineImage.tsx')).toContain('className="mdimg"')
    // about 600 characters of text between the images, so the last lies more
    // than two phone screens below the first
    expect(IMAGE_SPACER.length).toBeGreaterThan(500)
    const step = check.slice(
      check.indexOf('async function descriptionImagesCheck()'),
      check.indexOf('export const PHONE_SELECTS_STEP'),
    )
    expect(step.length).toBeGreaterThan(1000)
    expect(step).not.toContain('async function phoneSelectsCheck()')
    expect(step).toContain('setViewportSize({ width: 390, height: 844 })')
    // a phone's window shows the description under Details
    expect(step).toContain("getByText('Details', { exact: true })")
    expect(read('../src/panels/IssueDetail.tsx')).toContain(
      "{ value: 'details', label: 'Details' }",
    )
    expect(step).toContain("img.naturalWidth > 0 && img.src.startsWith('blob:')")
    expect(step).toContain('the last image was asked for before it came near view')
    // the gateway's answers wait, and in a window tall enough for all six
    // the cap must be reached, not only kept
    expect(step).toContain("app.route('**/files/**', hold)")
    expect(step).toContain('sleep(IMAGE_ANSWER_DELAY_MS)')
    expect(step).toContain('setViewportSize({ width: 1440, height: 8000 })')
    expect(step).toContain(
      "eq(downloads.most(), IMAGE_DOWNLOADS, 'description image downloads at once, the cap')",
    )
    expect(IMAGE_ANSWER_DELAY_MS).toBeGreaterThanOrEqual(1000)
    expect(read('../src/lib/inlineImages.ts')).toContain(`downloads: ${IMAGE_DOWNLOADS},`)
    expect(step).toContain(`restOk(w, 'DELETE', \`/tasks/\${task.key}\`)`)
    expect(step).toContain(`\`\${run.tag} description images\``)
  })

  it('counts the most downloads of the step’s files in flight at once, and no other request', () => {
    const downloads = imageDownloads(['a', 'b', 'c', 'd', 'e'])
    for (const id of ['a', 'b', 'c', null, 'other']) downloads.start(id)
    expect(downloads.most()).toBe(3)
    downloads.end('a')
    downloads.end(null)
    downloads.start('d')
    expect(downloads.most()).toBe(3)
    downloads.start('e')
    expect(downloads.most()).toBe(4)
    // a file that ended and starts again counts once at a time
    for (const id of ['b', 'c', 'd', 'e']) downloads.end(id)
    downloads.start('b')
    downloads.start('b')
    expect(downloads.most()).toBe(4)
  })

  it("uploads through the task window's file input and finds the file by its row", () => {
    const window = readFileSync(new URL('../src/panels/IssueDetail.tsx', import.meta.url), 'utf8')
    expect(UPLOAD_STEP).toBe('ui/attachment-upload')
    expect(window).toContain('data-attachment-open={att.name}')
    expect(window).toMatch(/type="file"\s+multiple/)
  })
  it("checks the relation pickers in the picker's own words", () => {
    const picker = readFileSync(
      new URL('../src/panels/RelationPicker.tsx', import.meta.url),
      'utf8',
    )
    expect(RELATION_STEP).toBe('ui/relation-pickers')
    for (const text of Object.values(RELATION_EXPECTED)) expect(picker).toContain(text)
    for (const mark of ['data-picker-row', 'data-picker-all', 'data-picker-current'])
      expect(picker).toContain(mark)
  })
  it('checks the label picker and the mention popup through their own marks', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const picker = read('../src/panels/LabelPicker.tsx')
    const popup = read('../src/components/mentionSuggestion.ts')
    const window = read('../src/panels/IssueDetail.tsx')
    expect(LABEL_MENTION_STEP).toBe('ui/label-mention-pickers')
    expect(LABEL_MENTION_NAMES).toEqual({ found: 'Found in picker', made: 'Made in picker' })
    // ui/settings-labels searches for `<tag> Label` later and must find its
    // own label alone, so neither name holds that word, and the step
    // deletes both of its labels before it returns
    for (const name of Object.values(LABEL_MENTION_NAMES))
      expect(name.toLowerCase()).not.toContain('label')
    const check = read('./staging-check.mjs')
    expect(check.indexOf('await settingsLabelsCheck()')).toBeGreaterThan(
      check.indexOf('await labelMentionPickersCheck()'),
    )
    const step = check.slice(
      check.indexOf('async function labelMentionPickersCheck()'),
      check.indexOf('export const OWN_READS_STEP'),
    )
    expect(step).toContain('const names = [found.name, madeName]')
    // the app deletes each label as the REST row shows it, in the home
    // organization, without waiting for the store, which holds no label
    expect(step).toContain('evaluate(app, removeLabelInApp, {')
    expect(step).not.toContain('orgLabels')
    expect(check).toContain('function removeLabelInApp(label) {')
    expect(check).toContain('orgId: window.PLANNER.homeOrg,')
    expect(step).toMatch(/\} finally \{\s+await dropLabels\(\)/)
    for (const mark of [
      'data-label-picker',
      'data-label-option',
      'data-label-create',
      'aria-label="Search labels"',
    ])
      expect(picker).toContain(mark)
    for (const mark of ['data-mention-popup', 'data-mention-id']) expect(popup).toContain(mark)
    // the chip's × the step presses, named by its label
    expect(window).toContain('`Remove label “$' + '{label.name}”`')
    expect(window).toContain('ariaLabel="Leave a comment"')
  })
  it("chooses projects in Archived tasks and Search through the picker's own marks", () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const picker = read('../src/components/ProjectPicker.tsx')
    const page = read('../src/panels/settings/ArchivedTasks.tsx')
    const pick = read('../src/lib/projectPick.ts')
    expect(PICKER_STEP).toBe('ui/project-picker')
    for (const mark of ['data-project-picker-search', 'data-project-pick', PICKER_EXPECTED.expand])
      expect(picker).toContain(mark)
    // the trigger's own attribute, not a comment that names it
    expect(picker).toContain(`${PICKER_EXPECTED.busy}={`)
    // the separator of a search's sub-project row, which the step reads
    expect(picker).toContain(`{'${PICKER_EXPECTED.place}'}`)
    for (const mark of [PICKER_EXPECTED.open, PICKER_EXPECTED.chip]) expect(page).toContain(mark)
    expect(pick).toContain(`\`\${p.parent.name}${PICKER_EXPECTED.place}\${p.name}\``)
  })
  it("checks its sub-project's health row on what its two tasks give, in the table's words", () => {
    const table = readFileSync(
      new URL('../src/views/overview/HealthTable.tsx', import.meta.url),
      'utf8',
    )
    expect(table).toMatch(/`\$\{f\.pct\}%`/)
    expect(table).toMatch(/`\$\{f\.done\}\/\$\{f\.total\}`/)
    // a blank where a trouble column or Left counts nothing
    expect(table).toContain("n > 0 ? n : '—'")
    expect(OVERVIEW_HEALTH_EXPECTED).toEqual({
      progress: '0%',
      done: '0/2',
      left: '—',
      behind: '—',
      paused: '1',
    })
  })
  it('fills a task to the page sizes of its thread', () => {
    expect(THREAD_PAGE).toEqual({
      comments: COMMENT_PAGE_MAX,
      history: HISTORY_PAGE_MAX,
      windowHistory: WINDOW_HISTORY_PAGE,
    })
  })
  it("expects the server's sentences for a task list's offset and cursor", () => {
    expect(LIST_REFUSALS).toEqual({
      activeOffset: offsetRefusal('active tasks'),
      cursor: CURSOR_REFUSAL,
    })
  })
  it("expects the server's sentences for a workload page's offset, limit and cursor", () => {
    expect(WORKLOAD_REFUSALS).toEqual({
      offset: offsetRefusal('workload'),
      limit: LIMITS.listWorkload.refusal,
      cursor: CURSOR_REFUSAL,
    })
    // pages small enough to follow a cursor, within the server's range
    for (const limit of Object.values(WORKLOAD_PAGE)) {
      expect(limit).toBeGreaterThanOrEqual(LIMITS.listWorkload.min)
      expect(limit).toBeLessThan(10)
    }
    expect(WORKLOAD_PAGE.rest).toBeGreaterThanOrEqual(2)
    // a regroup's steps run in moments; the wait outlasts a busy deployment's
    expect(REGROUP_WAIT).toBe(30_000)
  })
  it("expects the server's sentences for a users page's offset, limit and cursor", () => {
    expect(PEOPLE_REFUSALS).toEqual({
      offset: offsetRefusal('users'),
      limit: LIMITS.listUsers.refusal,
      cursor: CURSOR_REFUSAL,
    })
    // pages small enough to follow a cursor, within the server's ranges
    for (const limit of [PEOPLE_PAGE.rest, PEOPLE_PAGE.mcp])
      expect(limit).toBeGreaterThanOrEqual(LIMITS.listUsers.min)
    expect(PEOPLE_PAGE.rest).toBeLessThan(10)
    expect(PEOPLE_PAGE.mcp).toBeLessThan(PEOPLE_PAGE.rest)
    // the run's team holds two members for the step, so one a page pages
    expect(PEOPLE_PAGE.members).toBe(LIMITS.listTeamMembers.min)
  })
  it("expects the server's sentences and lists for a task's related lists", () => {
    expect(TASK_LIST_REFUSALS).toEqual({
      offset: offsetRefusal('subtasks'),
      limit: LIMITS.listSubtasks.refusal,
      cursor: CURSOR_REFUSAL,
    })
    // the lists MCP list_task_related takes, in the details' order
    const records = readFileSync(new URL('../convex/machine/records.ts', import.meta.url), 'utf8')
    expect(records).toContain(`enum: [...TASK_RELATED_LISTS]`)
    const core = readFileSync(new URL('../convex/lib/core.ts', import.meta.url), 'utf8')
    const lists = core.match(/export const TASK_RELATED_LISTS = \[([^\]]*)\] as const/)
    expect(lists?.[1].split(',').map((name) => name.trim().replaceAll("'", ''))).toEqual(TASK_LISTS)
  })
  it("expects the server's sentences for a projects page's offset, limit, cursor and unknown parameter", () => {
    expect(PROJECT_REFUSALS).toEqual({
      offset: offsetRefusal('projects'),
      limit: LIMITS.listProjects.refusal,
      cursor: CURSOR_REFUSAL,
      unknown:
        'unknown query parameter "page"; this request takes archived, search, limit, cursor, offset',
    })
    // the REST route's query parameters, in the order its refusal names them
    const rest = readFileSync(new URL('../convex/machine/rest.ts', import.meta.url), 'utf8')
    expect(rest).toContain("query: ['archived', 'search', 'limit', 'cursor', 'offset'],")
    // the design size's projects, and two pages more at any limit
    expect(PROJECTS_MAX).toBe(2000)
    expect(projectPagesMax(200)).toBe(12)
    expect(projectPagesMax(1)).toBe(2002)
  })
  it("expects the server's sentences and lists for a project's details", () => {
    expect(PROJECT_DETAIL_REFUSALS).toEqual({
      offset: offsetRefusal('milestones'),
      limit: LIMITS.listMilestones.refusal,
      usersOffset: offsetRefusal('project users'),
      usersLimit: LIMITS.listProjectUsers.refusal,
      cursor: CURSOR_REFUSAL,
      unknown: 'unknown query parameter "page"; this request takes limit, cursor, offset',
    })
    // the lists MCP list_project_related takes, in the details' order, with
    // the REST routes that page them
    const projects = readFileSync(new URL('../convex/machine/projects.ts', import.meta.url), 'utf8')
    const lists = projects.match(/export const PROJECT_RELATED_LISTS = \[([^\]]*)\] as const/)
    expect(lists?.[1].split(',').map((name) => name.trim().replaceAll("'", ''))).toEqual(
      PROJECT_LISTS.map((l) => l.list),
    )
    for (const { path } of PROJECT_LISTS)
      expect(projects).toContain(`path: 'projects/:ref/${path}',`)
  })
  it("expects the server's sentences for the Inbox's pages", () => {
    expect(INBOX_REFUSALS).toEqual({
      offset: offsetRefusal('inbox items'),
      limit: LIMITS.listInbox.refusal,
      cursor: CURSOR_REFUSAL,
      unknown:
        'unknown query parameter "page"; this request takes unread_only, include_snoozed, limit, cursor, offset',
    })
    // the REST route's query parameters, in the order its refusal names them
    const discussion = readFileSync(
      new URL('../convex/machine/discussion.ts', import.meta.url),
      'utf8',
    )
    expect(discussion).toContain(
      "query: ['unread_only', 'include_snoozed', 'limit', 'cursor', 'offset'],",
    )
  })
  it('names the tools that answer a placeholder sent alone as the server does', () => {
    const mcp = readFileSync(new URL('../convex/machine/mcp.ts', import.meta.url), 'utf8')
    const set = mcp.match(/const FORMERLY_BARE: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)
    expect(set?.[1].split(',').map((name) => name.trim().replaceAll("'", ''))).toEqual(
      FORMERLY_BARE,
    )
  })
})

describe('staging check auth routes', () => {
  const APP = 'https://preview.qivo.io'
  // the answers the router gives the app (convex/tests/authHttp.test.ts)
  const preflight = (headers = {}) =>
    new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': APP,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type, Better-Auth-Cookie, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST',
        'Access-Control-Expose-Headers': 'Set-Better-Auth-Cookie',
        Vary: 'Origin',
        ...headers,
      },
    })
  const session = (headers = {}) =>
    new Response('null', {
      headers: {
        'Access-Control-Allow-Origin': APP,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Expose-Headers': 'Set-Better-Auth-Cookie',
        'Content-Type': 'application/json',
        ...headers,
      },
    })
  /* `response` without the header `name`. */
  const without = (response, name) => {
    response.headers.delete(name)
    return response
  }

  it('accepts the sign-in preflight and session read the app relies on', () => {
    expect(authCorsProblems(preflight(), session(), APP)).toEqual([])
    // header names are case-insensitive
    expect(
      authCorsProblems(
        preflight({ 'Access-Control-Allow-Headers': 'content-type,better-auth-cookie' }),
        session({ 'Access-Control-Expose-Headers': 'set-better-auth-cookie, Content-Range' }),
        APP,
      ),
    ).toEqual([])
  })

  it.each([
    [
      'a preflight without the echo',
      () => [without(preflight(), 'Access-Control-Allow-Origin'), session()],
      'the sign-in preflight does not echo the app origin',
    ],
    [
      'a preflight echoing another origin',
      () => [preflight({ 'Access-Control-Allow-Origin': 'https://other.example' }), session()],
      'the sign-in preflight does not echo the app origin',
    ],
    [
      'a preflight without the credentials header',
      () => [without(preflight(), 'Access-Control-Allow-Credentials'), session()],
      'the sign-in preflight does not allow credentials',
    ],
    [
      'a preflight that does not allow Better-Auth-Cookie',
      () => [
        preflight({ 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }),
        session(),
      ],
      'the sign-in preflight does not allow better-auth-cookie',
    ],
    [
      'a refused preflight',
      () => [new Response(null, { status: 404 }), session()],
      'the sign-in preflight answered 404, not 204',
    ],
    [
      'a session read without the echo',
      () => [preflight(), without(session(), 'Access-Control-Allow-Origin')],
      'the session read does not echo the app origin',
    ],
    [
      'a session read that does not expose Set-Better-Auth-Cookie',
      () => [preflight(), without(session(), 'Access-Control-Expose-Headers')],
      'the session read does not expose Set-Better-Auth-Cookie',
    ],
  ])('refuses %s', (_name, answers, problem) => {
    const [sentPreflight, sentSession] = answers()
    expect(authCorsProblems(sentPreflight, sentSession, APP)).toContain(problem)
  })

  describe('the step after setup/target', () => {
    beforeEach(() => {
      results.fail.length = 0
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
      results.fail.length = 0
      vi.restoreAllMocks()
    })
    /** A loopback deployment whose auth routes answer as `handle` does. It
     *  closes each connection after its answer, so fetch keeps no idle
     *  connection whose keep-alive timer a later test's fake timers count. */
    const deployment = async (handle) => {
      const server = createServer((req, res) => {
        res.setHeader('Connection', 'close')
        req.resume()
        req.on('end', () => handle(req, res))
      })
      await new Promise((done) => server.listen(0, '127.0.0.1', done))
      return { server, origin: `http://127.0.0.1:${server.address().port}` }
    }
    /** The answers of a deployment whose auth routes and CORS work, as the
     *  router gives them (convex/tests/authHttp.test.ts). `credentials`
     *  false leaves Access-Control-Allow-Credentials out of the preflight. */
    const working =
      ({ credentials = true } = {}) =>
      (req, res) => {
        if (req.method === 'OPTIONS' && req.url === '/api/auth/sign-in/email') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': APP,
            ...(credentials && { 'Access-Control-Allow-Credentials': 'true' }),
            'Access-Control-Allow-Headers': 'Content-Type, Better-Auth-Cookie, Authorization',
            'Access-Control-Allow-Methods': 'GET, POST',
          })
          res.end()
        } else if (req.url === '/api/auth/get-session') {
          res.writeHead(200, {
            'Access-Control-Allow-Origin': APP,
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Expose-Headers': 'Set-Better-Auth-Cookie',
            'Content-Type': 'application/json',
          })
          res.end('null')
        } else if (req.url === '/api/auth/oauth2/token') {
          res.writeHead(400, {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
          })
          res.end('{"error":"invalid_request"}')
        } else if (req.url === '/.well-known/oauth-authorization-server') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end('{"token_endpoint_auth_methods_supported":["none"]}')
        } else res.writeHead(404).end()
      }
    // the bare name.convex.site host, which answers 404 on every route
    const bare = () => deployment((_req, res) => res.writeHead(404).end())
    const logged = () => console.log.mock.calls.map(([line]) => line)

    it('passes at the host setup/target found and drops the failure at the first one', async () => {
      const first = await bare()
      const named = await deployment(working())
      try {
        const earlier = await authRoutesStep(first.origin, { appOrigin: APP, local: true })
        expect(earlier).toEqual({ origin: first.origin, passed: false })
        expect(results.fail).toEqual(['auth/routes'])
        const again = await authRoutesStep(named.origin, { appOrigin: APP, local: true, earlier })
        expect(again).toEqual({ origin: named.origin, passed: true })
        expect(results.fail).toEqual([])
        expect(logged()).toContain(
          `NOTE auth/routes  its failure at ${first.origin} no longer counts, because setup/target found the API at ${named.origin}, where the step passed`,
        )
      } finally {
        first.server.close()
        named.server.close()
      }
    })

    it('counts one failure when the step fails at both hosts', async () => {
      const first = await bare()
      const named = await deployment(working({ credentials: false }))
      try {
        const earlier = await authRoutesStep(first.origin, { appOrigin: APP, local: true })
        const again = await authRoutesStep(named.origin, { appOrigin: APP, local: true, earlier })
        expect(again).toEqual({ origin: named.origin, passed: false })
        expect(results.fail).toEqual(['auth/routes'])
        expect(logged()).toContain(
          `FAIL auth/routes  at ${named.origin}: the sign-in preflight does not allow credentials`,
        )
        expect(logged().some((line) => line.includes('no longer counts'))).toBe(false)
      } finally {
        first.server.close()
        named.server.close()
      }
    })
  })
})

describe('staging check arguments', () => {
  it('takes the target and the cleanup options', () => {
    expect(parseArgs(['--staging']).target).toBe('staging')
    expect(parseArgs(['--staging', '--cleanup', '--run', 'a1b2c3']).run).toBe('a1b2c3')
    expect([...parseArgs(['--local', '--require', 'all']).require]).toEqual(['billing-pause-leave'])
  })
  it('drives Chromium unless a local run names another browser', () => {
    expect(parseArgs(['--staging']).browser).toBe('chromium')
    expect(parseArgs(['--local']).browser).toBe('chromium')
    for (const browser of BROWSERS)
      expect(parseArgs(['--local', '--browser', browser]).browser).toBe(browser)
    expect(BROWSERS).toEqual(['chromium', 'firefox', 'webkit'])
  })
  it('refuses unknown arguments, values that could be secrets and odd combinations', () => {
    for (const argv of [
      [],
      ['--staging', '--local'],
      ['--staging', '--token', 'qvt_0000'],
      ['--staging', '--run', 'a1b2c3'],
      ['--staging', '--cleanup', '--run', 'xyz'],
      // the 400-comment run went with the comment cap
      ['--staging', '--comment-cap'],
      ['--staging', '--require', 'text-caps'],
      // merged features are checked for real, not behind a probe
      ['--staging', '--require', 'task-delay'],
      ['--staging', '--force', 'billing-pause-leave'],
      ['--staging', '--invert', 'everything'],
      // staging is checked in Chromium alone
      ['--staging', '--browser', 'webkit'],
      ['--local', '--browser', 'safari'],
      ['--local', '--browser'],
    ])
      expect(() => parseArgs(argv)).toThrow()
  })
  it('never repeats a value it refuses, which could be a secret', () => {
    const secret = 'qvt_1111111111111111111111111'
    for (const argv of [
      ['--staging', secret],
      ['--staging', '--require', secret],
      ['--staging', '--invert', `read-token,${secret}`],
      ['--local', '--browser', secret],
    ])
      expect(() => parseArgs(argv)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(secret.slice(4)),
        }),
      )
    expect(() => parseArgs(['--staging', '--tokn'])).toThrow('Unknown argument --tokn.')
  })
})

describe('what a timeout waited for', () => {
  const timeout = (message) => Object.assign(new Error(message), { name: 'TimeoutError' })

  it('names the element and the last reason it could not be used', () => {
    const error = timeout(
      [
        'locator.click: Timeout 30000ms exceeded.',
        'Call log:',
        "  - waiting for locator('[data-deleted-select-all]')",
        '    - locator resolved to <button data-deleted-select-all>Select all</button>',
        '  - attempting click action',
        '    - element is not stable',
        '    - retrying click action',
        '    - <div data-floating-surface>…</div> intercepts pointer events',
      ].join('\n'),
    )
    expect(waitedFor(error)).toBe(
      "waiting for locator('[data-deleted-select-all]'), another element intercepts pointer events",
    )
    expect(
      waitedFor(
        timeout(
          "locator.click: Timeout\n  - waiting for getByRole('button')\n    - element is not enabled",
        ),
      ),
    ).toBe("waiting for getByRole('button'), element is not enabled")
  })
  it('takes nothing from a navigation, whose address can hold a secret, or from another error', () => {
    expect(
      waitedFor(
        timeout(
          'page.goto: Timeout\n  - navigating to "https://x.test/cb?code=abc", waiting until "load"',
        ),
      ),
    ).toBe('')
    expect(waitedFor(new Error("x\n  - waiting for locator('a')"))).toBe('')
    expect(waitedFor(undefined)).toBe('')
  })
})

describe('a search that lost its typed text', () => {
  /** A stand-in field, whose `page` can replace or empty it. */
  const fieldOf = () => {
    const page = { el: { value: '' }, fills: 0 }
    return {
      page,
      fill: async (text) => {
        page.fills++
        page.el.value = text
      },
      evaluate: async (fn) => fn(page.el),
    }
  }
  const notes = () => {
    const lines = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)))
    return { lines, done: () => spy.mockRestore() }
  }

  it('holds while the field keeps the text, without a NOTE', async () => {
    const seen = notes()
    try {
      const field = fieldOf()
      const holds = await typeSearch(field, 'Nora Berg', 'the Users search')
      expect(field.page.el.value).toBe('Nora Berg')
      expect(await holds()).toBe(true)
      expect(await holds()).toBe(true)
      expect(field.page.fills).toBe(1)
      expect(seen.lines).toEqual([])
    } finally {
      seen.done()
    }
  })
  it('types again once, says whether the field is the same, and fails a second loss', async () => {
    const seen = notes()
    try {
      const field = fieldOf()
      const holds = await typeSearch(field, 'Nora Berg', "a picker's search")
      // emptied in place
      field.page.el.value = ''
      expect(await holds()).toBe(false)
      expect(field.page.fills).toBe(2)
      expect(await holds()).toBe(true)
      expect(seen.lines).toEqual([
        `NOTE ${SEARCH_LOST}  a picker's search lost its text, in the same field, and the step typed it again`,
      ])
      field.page.el.value = ''
      await expect(holds()).rejects.toThrow("a picker's search lost its typed text twice")
      // made anew by the page
      const other = fieldOf()
      const again = await typeSearch(other, 'Nora Berg', "Deleted items' search")
      other.page.el = { value: '' }
      expect(await again()).toBe(false)
      expect(seen.lines[1]).toBe(
        `NOTE ${SEARCH_LOST}  Deleted items' search lost its text, in a field the page made anew, and the step typed it again`,
      )
    } finally {
      seen.done()
    }
  })
  it('guards the Users search, the searched pickers and the Deleted items search, and the workflow lists its NOTE', () => {
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(SEARCH_LOST).toBe('search-lost')
    // Deleted items types twice, each time right after the page opened
    expect(script.match(/await typeSearch\(/g)).toHaveLength(4)
    expect(script).toContain('(await subHolds()) && (await listed.count()) === 1')
    for (const use of [
      "typeSearch(app.locator('[data-users-search]'), text, 'the Users search')",
      'typeSearch(search, text, "a picker\'s search")',
      'words, "Deleted items\' search")',
    ])
      expect(script, use).toContain(use)
    const workflow = readFileSync(
      new URL('../.github/workflows/webkit-check.yml', import.meta.url),
      'utf8',
    )
    expect(workflow).toContain(`^NOTE +(browser|${SEARCH_LOST})`)
  })
})

describe('a wait with a bound', () => {
  it('answers a promise that settles in time and fails one that does not', async () => {
    await expect(within(Promise.resolve('file'), 1000, 'too late')).resolves.toBe('file')
    await expect(within(new Promise(() => {}), 10, 'the download did not finish')).rejects.toThrow(
      'the download did not finish',
    )
    await expect(within(Promise.reject(new Error('cancelled')), 1000, 'too late')).rejects.toThrow(
      'cancelled',
    )
  })
})

describe("a failed step's picture", () => {
  it("ends with Playwright's own timeout, so none is taken of a later page", () => {
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const shot = script.slice(
      script.indexOf('async function shot(page, name) {'),
      script.indexOf('async function signIn('),
    )
    expect(shot).toContain('timeout: SHOT_MS }).catch(() => {})')
    expect(shot).not.toContain('within(\n    page.screenshot(')
    expect(shot).toContain('page.isClosed()')
  })
  it('is named after the step, with each / as -', () => {
    expect(failedShot('ui/org-export')).toBe('failed-ui-org-export')
    expect(failedShot('standard-agent/ui/remove')).toBe('failed-standard-agent-ui-remove')
    expect(failedShot('run')).toBe('failed-run')
  })
})

describe("a browser's notification permission", () => {
  /** A stand-in browser whose one context answers as `over` says. */
  const browserOf = (over = {}) => {
    const seen = { closed: 0, visited: null, granted: null }
    const page = {
      goto: async (url) => {
        if (over.goto) throw over.goto
        seen.visited = url
      },
      evaluate: async () => over.permission ?? true,
    }
    const context = {
      grantPermissions: async (names, options) => {
        if (over.grant) throw over.grant
        seen.granted = [names, options]
      },
      newPage: async () => page,
      close: async () => {
        seen.closed++
      },
    }
    return {
      seen,
      newContext: async () => {
        if (over.context) throw over.context
        return context
      },
    }
  }
  const origin = 'http://localhost:5241'

  it('is what a page of the app reads once the context granted it', async () => {
    const browser = browserOf()
    expect(await notificationPermission(browser, origin)).toBe(true)
    expect(browser.seen.granted).toEqual([['notifications'], { origin }])
    expect(browser.seen.visited).toBe(`${origin}/app`)
    expect(browser.seen.closed).toBe(1)
    expect(await notificationPermission(browserOf({ permission: false }), origin)).toBe(false)
  })
  it('is none in a browser that knows no such permission', async () => {
    const browser = browserOf({ grant: new Error('Unknown permission: notifications') })
    expect(await notificationPermission(browser, origin)).toBe(false)
    expect(browser.seen.closed).toBe(1)
  })
  it('is unknown, and thrown, when the context, the grant or the page fails otherwise', async () => {
    for (const over of [
      { context: new Error('browser has been closed') },
      { grant: new Error('Target closed') },
      { goto: new Error('net::ERR_CONNECTION_RESET') },
    ]) {
      const browser = browserOf(over)
      await expect(notificationPermission(browser, origin)).rejects.toThrow(
        Object.values(over)[0].message,
      )
      expect(browser.seen.closed).toBe(over.context ? 0 : 1)
    }
  })
  it('skips an alert step only for a known lack of it, and fails it when unknown', () => {
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const can = script.slice(
      script.indexOf('async function alertsCan(id) {'),
      script.indexOf('/** The step that checks a desktop alert'),
    )
    expect(can).toContain("if (cfg.browser === 'chromium') return true")
    expect(can.indexOf('results.fail.push(id)')).toBeGreaterThan(can.indexOf('} catch (error) {'))
    expect(can).toContain('if (!notifications) skip(id, NO_NOTIFICATIONS)')
    // an unread permission stays unset, so the next alert step asks again
    expect(can.slice(can.indexOf('} catch (error) {'))).not.toContain('notifications = ')
    for (const step of ['INBOX_FEED_STEP', 'NOTIFICATION_DELIVERY_STEP'])
      expect(script).toContain(`if (!(await alertsCan(${step}))) return`)
  })
})

describe('a picker list that shows its search', () => {
  it('holds rows that all name every word of the search, in any order, whatever the case and the accents', () => {
    expect(listAnswers(['Nora Berg'], 'nora berg')).toBe(true)
    expect(listAnswers(['Berg, Nóra'], 'Nora  Berg')).toBe(true)
    expect(listAnswers(['Nora Lindberg'], 'Nora Berg')).toBe(true)
    expect(listAnswers(['Nora Lind'], 'Nora Berg')).toBe(false)
    expect(
      listAnswers(
        ['stgchk-1 Standard agentagent', 'stgchk-1 Standard agent 2'],
        'stgchk-1 Standard agent',
      ),
    ).toBe(true)
  })
  it('is not the list a picker opened with, nor an empty one', () => {
    expect(listAnswers(['Aisha Rahman', 'Nora Berg'], 'Nora Berg')).toBe(false)
    expect(listAnswers([], 'Nora Berg')).toBe(false)
  })
  it('is what the searched presses of these pickers wait for, each on its own rows', () => {
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    for (const search of [
      'data-team-member-picker-search',
      'data-reassign-search',
      'data-project-access-picker-search',
      'data-lead-picker-search',
      'data-new-subproject-parent-search',
    ])
      expect(script, search).not.toContain(`[${search}]').fill(`)
    expect(script).not.toContain('await search.fill(team.name)')
    const calls = script.split('await pressSearched(').slice(1)
    expect(calls).toHaveLength(7)
    const rows = calls.map(
      (call) => /app\.locator\('([^']+)'\),\n\s+app\.locator\(`/.exec(call)?.[1],
    )
    expect(rows).toEqual([
      '[data-team-member-choice]',
      // the people; the row that names no one stays whatever the search
      '[data-reassign-choice]:not([data-reassign-choice=""])',
      '[data-project-access-choice]',
      '[data-lead-choice]',
      // each team's label, since the option is a checkbox without text
      'label:has([data-project-access-team-option])',
      '[data-new-subproject-parent-choice]',
      '[data-lead-choice]',
    ])
  })
})

describe('the phone dropdowns step', () => {
  const row = (over = {}) => ({
    label: 'Sort by',
    text: 'Name',
    shown: null,
    paints: true,
    ...over,
  })

  it('passes dropdowns that show their chosen text', () => {
    expect(PHONE_SELECTS_STEP).toBe('ui/phone-selects')
    expect(selectProblems('the Board', [row(), row({ shown: ' Name ' })])).toEqual([])
    // nothing chosen to show
    expect(selectProblems('the Board', [row({ text: '', paints: false })])).toEqual([])
  })
  it('reports a field that paints no text, a label with another text and a page without a dropdown', () => {
    expect(selectProblems('the Board', [row({ paints: false })])).toEqual([
      'the Board\'s dropdown Sort by shows no text for "Name"',
    ])
    expect(selectProblems('the Board', [row({ label: '', shown: '' })])).toEqual([
      'the Board\'s dropdown (unnamed) shows "" for "Name"',
    ])
    expect(selectProblems('the Board', [])).toEqual(['the Board shows no dropdown'])
  })
  it("reads the run project's pages", () => {
    const pages = phoneSelectPages(12)
    expect(pages.map((page) => page.path)).toEqual([
      'board/p/12',
      'overview/mine',
      'overview/p/12',
      'roadmap/p/12',
      'settings/org-users',
      'settings/org-general',
    ])
    expect(pages.every((page) => page.name.length > 0)).toBe(true)
  })
})

describe('staging check weeks', () => {
  it('finds the first day of the planning week for any week start', () => {
    // 2026-10-18 is a Sunday
    expect(weekOf('2026-10-18', 1)).toBe('2026-10-12')
    expect(weekOf('2026-10-18', 0)).toBe('2026-10-18')
    expect(weekOf('2026-10-19', 1)).toBe('2026-10-19')
    expect(weekOf('2026-10-17', 6)).toBe('2026-10-17')
    expect(weekOf('2026-01-01', 1)).toBe('2025-12-29')
    expect(weekOf('2026-10-18', 1)).not.toBe('2026-10-19')
  })
  it('moves a day across months and years', () => {
    expect(addDays('2026-10-12', 35)).toBe('2026-11-16')
    expect(addDays('2026-01-05', -70)).toBe('2025-10-27')
  })
})

describe('staging check target', () => {
  const staging = {
    QIVO_ENVIRONMENT: 'staging',
    CONVEX_DEPLOY_KEY: 'prod:striped-snake-649|test-only',
    SITE_URL: 'https://preview.qivo.io',
  }
  const resolve = (env, extra = []) => resolveConfig(parseArgs(['--staging', ...extra]), env)

  it('accepts the staging app with its own deployment, with or without a region', () => {
    expect(resolve(staging)).toMatchObject({
      appOrigin: 'https://preview.qivo.io',
      apiOrigin: 'https://striped-snake-649.convex.site',
    })
    const regional = {
      ...staging,
      VITE_CONVEX_URL: 'https://striped-snake-649.eu-west-1.convex.cloud',
    }
    expect(resolve(regional).apiOrigin).toBe('https://striped-snake-649.eu-west-1.convex.site')
  })
  it('refuses production, another app and another deployment', () => {
    for (const change of [
      { QIVO_ENVIRONMENT: undefined },
      { QIVO_ENVIRONMENT: 'production' },
      { SITE_URL: 'https://qivo.io' },
      { SITE_URL: 'https://demo.qivo.io' },
      { SITE_URL: 'https://qivo-staging.vercel.app' },
      { SITE_URL: 'http://preview.qivo.io' },
      { CONVEX_DEPLOY_KEY: 'dev:striped-snake-649|test-only' },
      { CONVEX_DEPLOY_KEY: 'prod:striped-snake-649' },
    ])
      expect(() => resolve({ ...staging, ...change })).toThrow()
    expect(() =>
      resolve(staging, ['--api-url', 'https://determined-dachshund-357.convex.site']),
    ).toThrow()
    expect(() => resolve(staging, ['--api-url', 'https://api.qivo.io'])).toThrow()
  })
  it('takes a Convex site URL of the deployment only', () => {
    const deployment = 'striped-snake-649'
    for (const url of [
      'https://striped-snake-649.convex.site',
      'https://striped-snake-649.eu-west-1.convex.site',
    ])
      expect(isSiteOf(new URL(url), deployment)).toBe(true)
    for (const url of [
      'http://striped-snake-649.convex.site',
      'https://determined-dachshund-357.convex.site',
      'https://striped-snake-649.convex.site.evil.example',
      'https://striped-snake-649.convex.cloud',
    ])
      expect(isSiteOf(new URL(url), deployment)).toBe(false)
  })
  it('takes loopback origins only for a local run, outside a hosted helper', () => {
    const local = [
      '--local',
      '--app-url',
      'http://localhost:5241',
      '--convex-url',
      'http://127.0.0.1:3236',
      '--api-url',
      'http://127.0.0.1:3237',
      '--deployment',
      'local-name-3236',
    ]
    expect(resolveConfig(parseArgs(local), {}).apiOrigin).toBe('http://127.0.0.1:3237')
    expect(() => resolveConfig(parseArgs(local), { QIVO_ENVIRONMENT: 'staging' })).toThrow()
    expect(() => resolveConfig(parseArgs(local), { QIVO_ENVIRONMENT: 'production' })).toThrow()
    const remote = local.map((a) => (a === 'http://127.0.0.1:3237' ? 'https://api.qivo.io' : a))
    expect(() => resolveConfig(parseArgs(remote), {})).toThrow()
    expect(() => resolveConfig(parseArgs(local), { QIVO_ENVIRONMENT: 'demo' })).toThrow()
    for (const [from, to] of [
      ['http://127.0.0.1:3236', 'http://192.168.1.20:3236'],
      ['http://localhost:5241', 'https://localhost:5241'],
    ])
      expect(() => resolveConfig(parseArgs(local.map((a) => (a === from ? to : a))), {})).toThrow()
  })
  it('refuses debug output that would print secrets past redaction', () => {
    for (const env of [
      { DEBUG: 'pw:api' },
      { PWDEBUG: '1' },
      { DEBUG_FILE: '/tmp/x' },
      { NODE_DEBUG: 'http' },
    ])
      expect(() => resolve({ ...staging, ...env })).toThrow(/debug output/)
  })
})

describe('local backend proof', () => {
  const backend = 'http://127.0.0.1:3236'
  it("accepts the Convex client's sync socket to the backend", () => {
    expect(
      syncsWith(['ws://localhost:5241/?token=hmr', 'ws://127.0.0.1:3236/api/1.31.0/sync'], backend),
    ).toBe(true)
    expect(
      syncsWith(
        ['wss://striped-snake-649.convex.cloud/api/1.31.0/sync'],
        'https://striped-snake-649.convex.cloud',
      ),
    ).toBe(true)
  })
  it('refuses a socket to another host, port, protocol or path', () => {
    for (const socket of [
      'ws://127.0.0.1:3210/api/1.31.0/sync',
      'ws://localhost:3236/api/1.31.0/sync',
      'wss://127.0.0.1:3236/api/1.31.0/sync',
      'ws://127.0.0.1:3236/',
      'ws://127.0.0.1:5241/api/1.31.0/sync',
      'not a URL',
    ])
      expect(syncsWith([socket], backend)).toBe(false)
    expect(syncsWith([], backend)).toBe(false)
  })
})

describe('page calls', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('gives up on a page call that never settles and leaves no timer', async () => {
    vi.useFakeTimers()
    const hung = { evaluate: () => new Promise(() => {}) }
    const failed = expect(evaluate(hung, () => 1, undefined, 1000)).rejects.toThrow(
      'a call in the page gave no answer in 1 s',
    )
    await vi.advanceTimersByTimeAsync(1000)
    await failed
    expect(vi.getTimerCount()).toBe(0)
  })
  it('answers what the page answers and leaves no timer', async () => {
    vi.useFakeTimers()
    const page = { evaluate: async (fn, arg) => fn(arg) }
    expect(await evaluate(page, (n) => n * 2, 21)).toBe(42)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('request pacing', () => {
  afterEach(() => {
    vi.useRealTimers()
  })
  it('lets RATE_BUDGET calls of a profile through at once, then waits for the oldest to age', async () => {
    vi.useFakeTimers()
    const profile = `pace-${randomUUID()}`
    let through = 0
    for (let i = 0; i < RATE_BUDGET; i++) pace(profile).then(() => through++)
    await vi.advanceTimersByTimeAsync(0)
    expect(through).toBe(RATE_BUDGET)
    let next = false
    pace(profile).then(() => {
      next = true
    })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(next).toBe(false)
    // a call just inside the minute waits too, and another profile has its own window
    let late = false
    pace(profile).then(() => {
      late = true
    })
    let other = false
    pace(`pace-${randomUUID()}`).then(() => {
      other = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(other).toBe(true)
    expect(next || late).toBe(false)
    // the oldest call is 60 seconds old, plus the 100 ms margin
    await vi.advanceTimersByTimeAsync(101)
    expect(next && late).toBe(true)
  })
})

describe('run tags', () => {
  it('matches a name that starts with the tag and a space, and nothing else', () => {
    expect(hasTag('stgchk-1a2b3c', 'stgchk-1a2b3c project')).toBe(true)
    for (const name of [
      'stgchk-1a2b3cd project',
      'stgchk-1a2b3c',
      'my stgchk-1a2b3c project',
      'Stgchk-1a2b3c project',
      undefined,
    ])
      expect(hasTag('stgchk-1a2b3c', name)).toBe(false)
    expect(hasTag(TAG_ANY, 'stgchk-00ff99 cleanup token')).toBe(true)
    for (const name of ['stgchk-00ff9 x', 'stgchk-00ff99x', 'stgchk-00FF99 x', 'x stgchk-00ff99 y'])
      expect(hasTag(TAG_ANY, name)).toBe(false)
  })
})

describe("the cleanup's Deleted items", () => {
  const row = (over = {}) => ({
    id: 'item-1',
    hit: false,
    kind: 'project',
    key: 'SC',
    title: 'stgchk-1a2b3c Project',
    state: 'ready',
    menu: true,
    ...over,
  })
  const ids = (rows) => rows.map((r) => r.id)

  it("takes only the tag's own rows by their shown name, ready or stuck, once each", () => {
    const rows = [
      row(),
      row({ id: 'item-2', kind: 'task', key: 'QN-7', title: 'stgchk-1a2b3c Deleted 1' }),
      row({ id: 'item-3', state: 'stuck' }),
      // the same item twice goes once
      row(),
    ]
    expect(ids(deletedRowsOf(rows, 'stgchk-1a2b3c').purge)).toEqual(['item-1', 'item-2', 'item-3'])
    expect(ids(deletedRowsOf(rows, TAG_ANY).purge)).toEqual(['item-1', 'item-2', 'item-3'])
  })

  it('never takes a row whose shown name lacks the tag, whatever the search listed', () => {
    for (const title of [
      'Northstar Launch',
      'Notes on stgchk-1a2b3c Project',
      'stgchk-1a2b3cd Project',
      'stgchk-1a2b3c',
      'Stgchk-1a2b3c Project',
    ]) {
      const out = deletedRowsOf([row({ title })], 'stgchk-1a2b3c')
      expect(Object.values(out).flat(), title).toEqual([])
    }
    // another run's row is not this run's, but is every run's
    const other = row({ title: 'stgchk-00ff99 Project' })
    expect(deletedRowsOf([other], 'stgchk-1a2b3c').purge).toEqual([])
    expect(ids(deletedRowsOf([other], TAG_ANY).purge)).toEqual(['item-1'])
    expect(deletedRowsOf([row({ title: 'x stgchk-00ff99 y' })], TAG_ANY).purge).toEqual([])
  })

  it('leaves a row that shows no name, and says so, rather than tell it apart by its search', () => {
    // a task whose project the admin cannot read, and an app without the
    // title mark
    const hidden = row({ kind: 'task', key: 'QN-9', title: null })
    const unmarked = row({ id: 'item-4', title: null })
    const out = deletedRowsOf([hidden, unmarked, row({ id: null })], TAG_ANY)
    expect(out.purge).toEqual([])
    expect(out.unnamed).toHaveLength(3)
  })

  it('waits for a row that moves or restores, and names one Delete now is not offered for', () => {
    const out = deletedRowsOf(
      [
        row({ id: 'm', state: 'moving', menu: false }),
        row({ id: 'r', state: 'restoring', menu: false }),
        row({ id: 'p', menu: false }),
      ],
      'stgchk-1a2b3c',
    )
    expect(ids(out.waiting)).toEqual(['m', 'r'])
    expect(ids(out.blocked)).toEqual(['p'])
    expect(out.purge).toEqual([])
  })

  it('takes no line found inside another item, only counts a tagged one', () => {
    const inside = row({ id: null, hit: true, kind: 'task', key: 'QN-3' })
    const out = deletedRowsOf([inside, { ...inside, title: 'Plain task' }], 'stgchk-1a2b3c')
    expect(out.purge).toEqual([])
    expect(out.inside).toEqual([inside])
  })

  it('reads a page whose move failed as a problem, never as the end of the list', () => {
    const page = (over) => ({ rows: [], end: 'end', next: false, retry: false, ...over })
    // a page that answered: the last one, and one with more to read
    expect(deletedPageProblem(page({}))).toBeNull()
    expect(deletedPageProblem(page({ end: 'more', next: true }))).toBeNull()
    // after a failed Next the page keeps its rows and its end, shows Retry
    // and takes Next away
    expect(deletedPageProblem(page({ end: 'more', retry: true }))).toBe(
      'Deleted items could not load another page',
    )
    expect(deletedPageProblem(page({ end: 'more' }))).toBe(
      'Deleted items could not load another page',
    )
    // after a failed Previous on the last page too
    expect(deletedPageProblem(page({ retry: true }))).toBe(
      'Deleted items could not load another page',
    )
    expect(deletedPageProblem(page({ end: 'failed', retry: true }))).toBe(
      'Deleted items could not load',
    )
    expect(deletedPageProblem(page({ end: 'held' }))).toBe(
      'Deleted items could not list this scope',
    )
    expect(deletedPageProblem(page({ end: 'stuck', retry: true }))).toBe(
      'Deleted items could not check part of the list',
    )
  })

  it("reads Delete now's answer: deleted, sent again once ready, gone, or a problem", () => {
    const answer = (over) => ({
      done: [],
      stepping: [],
      refused: [],
      deferred: [],
      failed: [],
      unsent: [],
      unknown: [],
      error: null,
      paused: false,
      ...over,
    })
    expect(
      purgeAnswerOf(
        answer({
          done: ['a'],
          refused: [
            { id: 'b', reason: 'moving' },
            { id: 'c', reason: 'restoring' },
            { id: 'd', reason: 'not_found' },
          ],
        }),
        ['a', 'b', 'c', 'd'],
      ),
    ).toEqual({ done: ['a'], again: ['b', 'c'], gone: ['d'], problem: null })
    // a refusal for another reason, an error, an id left unanswered and no
    // answer at all are problems
    expect(
      purgeAnswerOf(answer({ refused: [{ id: 'a', reason: 'read_only' }] }), ['a']).problem,
    ).toBe('Delete now refused 1 item(s): read_only')
    expect(purgeAnswerOf(answer({ failed: ['a'], error: 'Qivo is busy.' }), ['a']).problem).toBe(
      'Delete now answered “Qivo is busy.”',
    )
    expect(purgeAnswerOf(answer({ done: ['a'] }), ['a', 'b']).problem).toBe(
      'Delete now did not answer for 1 item(s)',
    )
    expect(purgeAnswerOf(null, ['a'])).toEqual({
      done: [],
      again: [],
      gone: [],
      problem: 'the app gave no answer to Delete now',
    })
    // an id the answer names that was never sent is not counted as done
    expect(purgeAnswerOf(answer({ done: ['a', 'z'] }), ['a']).done).toEqual(['a'])
  })

  it("deletes the run's Deleted items after its projects went, and the sweep after its own deletes", () => {
    const script = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    expect(PURGE_DELETED_STEP).toBe('cleanup/app/purge-deleted')
    const main = script.slice(script.indexOf('async function main() {'))
    expect(main.indexOf('await purgeDeletedCheck()')).toBeGreaterThan(
      main.indexOf("check('cleanup/app/delete-project'"),
    )
    // before the credentials go, as it needs only the signed-in app
    expect(main.indexOf('await purgeDeletedCheck()')).toBeLessThan(
      main.indexOf("check('read-token/ui/revoke'"),
    )
    const sweep = script.slice(
      script.indexOf('async function sweep('),
      script.indexOf('async function removeTokenInApp('),
    )
    const purge = sweep.indexOf('await purgeDeleted(tag, note)')
    for (const before of ["step('projects'", "step('tasks'", "step('labels'"])
      expect(purge, before).toBeGreaterThan(sweep.indexOf(before))
    // the last look reads Deleted items afresh, and no NOTE says they stay
    expect(sweep.indexOf('await deletedLeft(tag)')).toBeGreaterThan(
      sweep.indexOf("step('the check for leftovers in the app'"),
    )
    expect(script).not.toContain('Deleted items for 30 days')
  })
})

describe('staging check output', () => {
  it('removes credentials, codes, signed link values and known secrets', () => {
    const line = redact(
      [
        'qvt_aaaaaaaaaaaaaaaaaaaa qva_bbbbbbbbbbbbbbbbbbbb qvo_cccccccccccc',
        'Bearer something',
        'https://x.convex.cloud/api/storage/upload?token=abc123',
        'https://x.convex.site/files/1?e=1&m=a&t=def456',
        '/callback?code=ghi789&state=jkl',
        'the fixture password hunter2-long',
      ].join(' '),
      new Set(['hunter2-long']),
    )
    for (const secret of [
      'aaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbb',
      'cccccccccccc',
      'something',
      'abc123',
      'def456',
      'ghi789',
      'hunter2-long',
    ])
      expect(line).not.toContain(secret)
    expect(line).toContain('qvt_[redacted]')
    expect(line).toContain('t=[redacted]')
  })
  it('leaves ordinary status text alone', () => {
    const text = 'PASS uploads/delete  7 files deleted in 12 s'
    expect(redact(text, new Set())).toBe(text)
  })
})

describe('staging check requests', () => {
  /** A loopback server; `handle` answers each request after its body arrived. */
  const serve = async (handle) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => handle(req, res, body))
    })
    await new Promise((done) => server.listen(0, '127.0.0.1', done))
    return { server, origin: `http://127.0.0.1:${server.address().port}` }
  }

  it('refuses a redirect, so a body never reaches another origin', async () => {
    const seen = []
    const other = await serve((_req, res, body) => {
      seen.push(body)
      res.end('{}')
    })
    const first = await serve((_req, res) => {
      res.writeHead(307, { Location: `${other.origin}/token` }).end()
    })
    try {
      await expect(
        request(`${first.origin}/token`, { method: 'POST', body: 'refresh_token=secret-value' }),
      ).rejects.toThrow('a request was answered with a redirect, which this check never follows')
      expect(seen).toEqual([])
      const direct = await request(`${other.origin}/token`, { method: 'POST', body: 'ok' })
      expect(direct.status).toBe(200)
      expect(seen).toEqual(['ok'])
    } finally {
      first.server.close()
      other.server.close()
    }
  })

  it('gives up on a request that gets no answer', async () => {
    const stalled = await serve(() => {})
    try {
      await expect(request(`${stalled.origin}/me`, {}, 200)).rejects.toThrow(
        'network error: no answer in 0.2 s',
      )
    } finally {
      stalled.server.closeAllConnections()
      stalled.server.close()
    }
  })

  describe('send', () => {
    const waits = { ...WAITS }
    beforeEach(() => {
      Object.assign(WAITS, { rateLimit: 20, readRetry: 5, conflictRetry: 5 })
      vi.spyOn(console, 'log').mockImplementation(() => {})
    })
    afterEach(() => {
      Object.assign(WAITS, waits)
      vi.restoreAllMocks()
    })
    /** Sends one request to a server that gives `answers` ([status, body])
     *  in turn and then the last one again, and answers the status send()
     *  returned and how many requests the server got. */
    const exchange = async (answers, read) => {
      let hits = 0
      const target = await serve((_req, res) => {
        const [status, body = {}] = answers[Math.min(hits++, answers.length - 1)]
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
      })
      try {
        const init = read ? { method: 'GET' } : { method: 'POST', body: '{}' }
        const r = await send(`send-${randomUUID()}`, `${target.origin}/v1/tasks`, init, { read })
        await r.arrayBuffer()
        return { status: r.status, hits }
      } finally {
        target.server.closeAllConnections()
        target.server.close()
      }
    }

    it('waits out one 429 and answers what comes next', async () => {
      expect(await exchange([[429], [200]], true)).toEqual({ status: 200, hits: 2 })
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('waiting 0.02 seconds'))
    })
    it("waits a 429's Retry-After seconds and one more, else the most it waits", () => {
      Object.assign(WAITS, { rateLimit: 61_000 })
      expect(rateLimitWait('17')).toBe(18_000)
      expect(rateLimitWait('1')).toBe(2_000)
      expect(rateLimitWait('60')).toBe(61_000)
      for (const header of [null, '', '0', '61', '2.5', 'soon', '-3'])
        expect(rateLimitWait(header), String(header)).toBe(61_000)
    })
    it('returns a second 429 as it is', async () => {
      expect(await exchange([[429]], true)).toEqual({ status: 429, hits: 2 })
    })
    it('sends a read once more after a server error', async () => {
      expect(await exchange([[502], [200]], true)).toEqual({ status: 200, hits: 2 })
      expect(await exchange([[503]], true)).toEqual({ status: 503, hits: 2 })
    })
    it('never sends a write again after a server error', async () => {
      expect(await exchange([[500]], false)).toEqual({ status: 500, hits: 1 })
      expect(await exchange([[503, { error: 'internal error' }]], false)).toEqual({
        status: 503,
        hits: 1,
      })
    })
    it('sends a write once more after a write conflict', async () => {
      const conflict = [503, { error: WRITE_CONFLICT }]
      expect(await exchange([conflict, [201]], false)).toEqual({ status: 201, hits: 2 })
      expect(await exchange([conflict], false)).toEqual({ status: 503, hits: 2 })
    })
  })
})

describe('attachment delete answers', () => {
  const id = '11111111-1111-4111-8111-111111111111'
  const outcome = (r, surface) => deleteOutcome(r, surface, id, 'QN-7')
  it('counts a success only when it says deleted: true', () => {
    expect(outcome({ status: 200, json: { deleted: true } }, 'rest')).toBe('deleted')
    expect(outcome({ status: 200, isError: false, data: { deleted: true } }, 'mcp')).toBe('deleted')
    expect(outcome({ status: 200, json: { deleted: false } }, 'rest')).toBe('deleted is false')
    expect(outcome({ status: 200, isError: false, data: {} }, 'mcp')).toBe('deleted is undefined')
  })
  it('leaves a lost answer, a server error and a not-found answer to a read', () => {
    for (const [r, surface] of [
      [{ status: 0, error: 'network error' }, 'rest'],
      [{ status: 502, json: null }, 'rest'],
      [{ status: 500, json: { error: 'internal error' } }, 'rest'],
      [{ status: 404, json: { error: 'attachment not found' } }, 'rest'],
      [{ status: 200, isError: true, text: 'internal error' }, 'mcp'],
      [{ status: 200, isError: true, text: `attachment "${id}" not found on QN-7` }, 'mcp'],
      [{ status: 503, json: null }, 'mcp'],
    ])
      expect(outcome(r, surface)).toBe('unsure')
  })
  it('fails a refusal or another not-found answer as it is', () => {
    for (const [r, surface] of [
      [{ status: 403, json: { error: 'this credential can only read' } }, 'rest'],
      [{ status: 404, json: { error: 'task not found' } }, 'rest'],
      [
        { status: 200, isError: true, text: 'your account has no write access to that project' },
        'mcp',
      ],
      [{ status: 200, isError: true, text: `attachment "${id}" not found on QN-8` }, 'mcp'],
    ])
      expect(outcome(r, surface)).toMatch(/^HTTP /)
  })
})

describe('thread pages', () => {
  // 511 rows, oldest first, one second apart, paged newest first like REST
  const all = Array.from({ length: 511 }, (_, i) => ({
    id: `r${i}`,
    verb: i === 0 ? 'created' : 'labeled',
    created_at: new Date(Date.UTC(2026, 9, 21, 12, 0, i)).toISOString(),
  }))
  const pages = (rows) => [rows.slice(-500), rows.slice(0, -500)]
  it('takes the whole history in a full page and the rest', () => {
    expect(historyRows(pages(all), 511).map((r) => r.id)).toEqual(all.map((r) => r.id))
  })
  it('refuses a history with rows missing, repeated or out of order', () => {
    // the earlier page holds only the created row
    expect(() => historyRows([all.slice(-500), all.slice(0, 1)], 511)).toThrow(
      /^rows across pages:/,
    )
    expect(() => historyRows([all.slice(-500), all.slice(0, 12)], 511)).toThrow(
      /^distinct rows across pages:/,
    )
    // a short newest page, though every row comes once
    expect(() => historyRows([all.slice(-499), all.slice(0, 12)], 511)).toThrow(/^the newest page:/)
    expect(() => historyRows(pages(all.slice(1)), 510)).toThrow(/^the first row:/)
    expect(() => historyRows([all.slice(-500)], 500)).toThrow(/^pages before the empty one:/)
    const swapped = [...all.slice(0, 10), all[20], ...all.slice(10, 20), ...all.slice(21)]
    expect(() => historyRows(pages(swapped), 511)).toThrow(/^pages overlap or skip/)
  })
})

describe("the task window's budget in the thread step", () => {
  it('checks Show newer activity only when the thread passes the budget', () => {
    // the staging task: 60 comments and about 510 changes
    expect(threadFitsBudget(60, 511, 150)).toBe(false)
    expect(threadFitsBudget(60, 511, 1000)).toBe(true)
    expect(threadFitsBudget(60, 90, 150)).toBe(true)
    expect(threadFitsBudget(60, 91, 150)).toBe(false)
  })

  it('counts a press once its loading row went and its place moved or its control went', () => {
    // the loading row stands in for the control's button, so not yet
    expect(pressSettled({ state: 'loading', place: 'c1' }, 'c1')).toBe('wait')
    expect(pressSettled({ state: 'loading', place: 'c0' }, 'c1')).toBe('wait')
    // back, but nothing moved, so the press loaded nothing so far
    expect(pressSettled({ state: 'more', place: 'c1' }, 'c1')).toBe('wait')
    expect(pressSettled({ state: 'unread', place: null }, 'c1')).toBe('wait')
    // the place moved, or the control went for good
    expect(pressSettled({ state: 'more', place: 'c0' }, 'c1')).toBe('done')
    expect(pressSettled({ state: null, place: null }, 'c1')).toBe('done')
    expect(pressSettled({ state: 'failed', place: 'c1' }, 'c1')).toBe('failed')
  })

  it('checks that Show newer brought back every change after its first place, once and in order', () => {
    const ids = Array.from({ length: 8 }, (_, n) => `e${n}`)
    expect(() => newerWalk('e3', ['e4', 'e5', 'e6', 'e7'], ids)).not.toThrow()
    // a change missing, one twice, two swapped, short of the newest
    const wrong = [
      ['e4', 'e6', 'e7'],
      ['e4', 'e5', 'e5', 'e6', 'e7'],
      ['e4', 'e6', 'e5', 'e7'],
      ['e4', 'e5', 'e6'],
    ]
    for (const met of wrong)
      expect(() => newerWalk('e3', met, ids)).toThrow(
        /^the changes Show newer activity brought back:/,
      )
    expect(() => newerWalk('c9', ['e4'], ids)).toThrow(/is not in the history$/)
  })
})

describe('task list pages', () => {
  /** A reader of `pages`, `{next_cursor, tasks}` each, that records the
   *  cursor of every read. */
  const reader = (pages) => {
    const cursors = []
    const read = async (cursor) => {
      cursors.push(cursor)
      return pages[cursors.length - 1]
    }
    return { read, cursors }
  }
  it('reads on through short and empty pages until next_cursor is null', async () => {
    const { read, cursors } = reader([
      { next_cursor: 'c1', tasks: [{ id: 'a' }] },
      { next_cursor: 'c2', tasks: [] },
      { next_cursor: null, tasks: [{ id: 'b' }, { id: 'c' }] },
    ])
    expect((await taskPages(read, 'the list')).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(cursors).toEqual([null, 'c1', 'c2'])
  })
  it('refuses an answer that is no page, such as the array active lists answered before', async () => {
    await expect(taskPages(reader([[{ id: 'a' }]]).read, 'the list')).rejects.toThrow(
      'the list answered no {next_cursor, tasks} page',
    )
    await expect(taskPages(reader([{ tasks: [] }]).read, 'the list')).rejects.toThrow(
      'the list answered no {next_cursor, tasks} page',
    )
  })
  it('takes in a whole Inbox through short and empty pages, and sizes the walks at a smaller limit from it', async () => {
    const { read, cursors } = reader([
      { next_cursor: 'i1', items: [{ id: 'a' }, { id: 'b' }] },
      { next_cursor: 'i2', items: [] },
      { next_cursor: null, items: [{ id: 'c' }] },
    ])
    const whole = await inboxWhole(read, 'the Inbox')
    expect(whole.items.map((i) => i.id)).toEqual(['a', 'b', 'c'])
    expect(whole.pages).toBe(3)
    expect(cursors).toEqual([null, 'i1', 'i2'])
    // an item a page, a page for each short or empty one, and two more
    expect(inboxPagesMax(whole)).toBe(3 + 3 + 2)
    const endless = async (cursor) => ({ next_cursor: `${cursor ?? ''}x`, items: [] })
    await expect(inboxWhole(endless, 'the Inbox')).rejects.toThrow(
      `the Inbox still had a next_cursor after ${INBOX_PAGES_MAX} pages`,
    )
    expect(INBOX_PAGES_MAX).toBe(TASK_PAGES_MAX)
  })
  it('gives up on a next_cursor that never ends', async () => {
    const endless = async () => ({ next_cursor: 'again', tasks: [] })
    await expect(taskPages(endless, 'the list')).rejects.toThrow(
      `the list still had a next_cursor after ${TASK_PAGES_MAX} pages`,
    )
  })
  it('reads the workload’s people page by page, and refuses the array it answered before', async () => {
    const pages = [
      { next_cursor: 'p1', week_starts: [], people: [{ id: 'a' }] },
      { next_cursor: 'p2', week_starts: [], people: [] },
      { next_cursor: null, week_starts: [], people: [{ id: 'b' }] },
    ]
    const cursors = []
    let at = 0
    const read = async (cursor) => {
      cursors.push(cursor)
      return pages[at++]
    }
    expect((await workloadPeople(read, 'the workload')).map((p) => p.id)).toEqual(['a', 'b'])
    expect(cursors).toEqual([null, 'p1', 'p2'])
    await expect(
      workloadPeople(async () => ({ week_starts: [], project: null, people: [] }), 'the workload'),
    ).rejects.toThrow('the workload answered no {next_cursor, people} page')
  })
  it('reads every person of an organization at the design size at the pages each surface asks for', async () => {
    expect(WORKLOAD_PEOPLE).toBe(1000)
    for (const limit of Object.values(WORKLOAD_PAGE)) {
      // a full organization in pages of `limit`, the last one short
      const people = Array.from({ length: WORKLOAD_PEOPLE }, (_, i) => ({ id: `p${i}` }))
      let at = 0
      const read = async () => {
        const page = people.slice(at, at + limit)
        at += limit
        return { next_cursor: at < people.length ? `c${at}` : null, people: page }
      }
      expect(await workloadPeople(read, 'the workload'), `limit ${limit}`).toHaveLength(
        WORKLOAD_PEOPLE,
      )
    }
  })
  it('reads the design size when busy people end every page after one person, or none', async () => {
    // whatever `limit` asks for, each page reads one person, as a page whose
    // first person spends the call's room does, and every third page lists
    // nobody, as a page whose one person read is inactive without hours does
    const people = Array.from({ length: WORKLOAD_PEOPLE }, (_, i) => ({ id: `p${i}` }))
    let at = 0
    const read = async () => {
      const person = people[at++]
      return {
        next_cursor: at < people.length ? `c${at}` : null,
        people: at % 3 === 0 ? [] : [person],
      }
    }
    const listed = await workloadPeople(read, 'the workload')
    expect(at).toBe(WORKLOAD_PEOPLE)
    expect(listed).toHaveLength(WORKLOAD_PEOPLE - Math.floor(WORKLOAD_PEOPLE / 3))
  })
  it('fails a workload next_cursor that never moves at once, and one that never ends after the bound', async () => {
    let pages = 0
    const stuck = async () => {
      pages += 1
      return { next_cursor: 'again', people: [] }
    }
    await expect(workloadPeople(stuck, 'the workload')).rejects.toThrow(
      'the workload answered the cursor it was read with as its next_cursor',
    )
    expect(pages).toBe(2)
    // a cursor that moves on each page, but past the design size forever
    let n = 0
    const endless = async () => ({ next_cursor: `c${++n}`, people: [] })
    await expect(workloadPeople(endless, 'the workload')).rejects.toThrow(
      `the workload still had a next_cursor after ${WORKLOAD_PEOPLE + 2} pages`,
    )
    expect(WORKLOAD_PAGES_MAX).toBe(1002)
    expect(n).toBe(WORKLOAD_PAGES_MAX)
  })
  it('bounds a user, label, team or member list by the pages of the design size’s people', () => {
    expect(peoplePagesMax(1)).toBe(WORKLOAD_PEOPLE + 2)
    expect(peoplePagesMax(PEOPLE_PAGE.rest)).toBe(202)
    expect(peoplePagesMax(200)).toBe(7)
    expect(peoplePagesMax(50)).toBe(22)
  })
  it('writes a list query with the parameters that are set, URL-encoded', () => {
    expect(withQuery('/users', {})).toBe('/users')
    expect(withQuery('/users', { search: 'stgchk-0a1b2c Étiquette', limit: 2, cursor: null })).toBe(
      '/users?search=stgchk-0a1b2c%20%C3%89tiquette&limit=2',
    )
    expect(withQuery('/labels?limit=20', { cursor: 'a+b/c' })).toBe(
      '/labels?limit=20&cursor=a%2Bb%2Fc',
    )
  })
  it("finds each tagged agent and label of a sweep through the app's own pickers, and removes it in the home organization", () => {
    const check = readFileSync(new URL('./staging-check.mjs', import.meta.url), 'utf8')
    const sweep = check.slice(
      check.indexOf('async function sweep(tag, label)'),
      check.indexOf('async function removeTokenInApp('),
    )
    // the store holds nobody but Nora and no label, so the agents come from
    // API access's person filter, an admin's read whose rows tell an agent
    // from a person, and the labels from the label picker's, both without
    // the cleanup token
    expect(sweep).toContain('window.PLANNER.apiAccessPeople(search, after)')
    expect(sweep).toContain('.filter((p) => p.agent && matches(p.name))')
    expect(sweep).toContain(
      'window.PLANNER.labelChoices({ org: window.PLANNER.homeOrg, search, cursor: after })',
    )
    expect(sweep).toContain('window.PLANNER.removeUser(a.id, { orgId: a.org })')
    expect(sweep).toContain('evaluate(app, removeLabelInApp, {')
    // a removed agent is confirmed over REST, else by a search that no
    // longer lists it, never by the store's people
    expect(sweep).toContain('!(await taggedAgents()).some((a) => a.id === agent.id)')
    for (const gone of ['window.PLANNER.users', 'orgLabels', 'canDeleteTeam'])
      expect(sweep).not.toContain(gone)
  })
  it('searches a sweep by the run tag, or by the prefix every run tag shares', () => {
    expect(searchOf('stgchk-0a1b2c')).toBe('stgchk-0a1b2c')
    expect(searchOf(TAG_ANY)).toBe(TAG_PREFIX)
    // every tagged name holds the search, which the server matches as a
    // word fragment
    for (const name of ['stgchk-0a1b2c team', 'stgchk-ffffff Standard agent'])
      expect(name.toLowerCase().includes(searchOf(TAG_ANY))).toBe(true)
  })
})
