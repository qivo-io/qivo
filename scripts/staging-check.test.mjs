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
import { creatorPhrase } from '../src/lib/projectCreators'
import {
  AGENDA_QUERY,
  ASSIGNEE_LOAD_QUERY,
  addDays,
  addsQuery,
  BILLING_ACCOUNTS_MARKS,
  BILLING_ACCOUNTS_STEP,
  BILLING_STORAGE_EXPECTED,
  BILLING_STORAGE_STEP,
  creatorsLine,
  deleteOutcome,
  evaluate,
  FIXTURE_STATUS,
  FORMERLY_BARE,
  freeMilestoneWeek,
  freePastMilestoneWeek,
  hasTag,
  historyRows,
  isSiteOf,
  LABELS_EXPECTED,
  LABELS_STEP,
  LIST_REFUSALS,
  MILESTONE_STEP,
  ON_DEMAND_STEP,
  OVERVIEW_EXPECTED,
  OVERVIEW_HEALTH_EXPECTED,
  OVERVIEW_OVERDUE_DAYS,
  PEOPLE_PAGE,
  PEOPLE_REFUSALS,
  PICKER_EXPECTED,
  PICKER_STEP,
  PROJECT_DIALOGS_EXPECTED,
  PROJECT_DIALOGS_STEP,
  PROJECT_SETTINGS_EXPECTED,
  PROJECT_SETTINGS_STEP,
  pace,
  parseArgs,
  peoplePagesMax,
  RATE_BUDGET,
  REGROUP_WAIT,
  RELATION_EXPECTED,
  RELATION_STEP,
  REMOVAL_EXPECTED,
  REMOVAL_STEP,
  REST_BODY_FIELDS,
  ROADMAP_QUERY,
  rateLimitWait,
  redact,
  request,
  resolveConfig,
  SETTINGS_PROJECTS_MARKS,
  SETTINGS_PROJECTS_STEP,
  SETTINGS_USERS_EXPECTED,
  SETTINGS_USERS_STEP,
  searchOf,
  send,
  syncsWith,
  TAG_ANY,
  TAG_PREFIX,
  TASK_LINK_STEP,
  TASK_LINK_UNKNOWN,
  TASK_LIST_REFUSALS,
  TASK_LISTS,
  TASK_PAGES_MAX,
  TASK_WINDOWS_QUERY,
  TEAM_SYNC_STEP,
  TEAMS_EXPECTED,
  TEAMS_STEP,
  THREAD_PAGE,
  taskPages,
  UPLOAD_STEP,
  WAITS,
  WORKLOAD_PAGE,
  WORKLOAD_PAGES_MAX,
  WORKLOAD_PEOPLE,
  WORKLOAD_REFUSALS,
  WRITE_CONFLICT,
  weekOf,
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
    })
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
  it("opens its own milestone in the Milestones window by the window's own marks, in a free week, and a past one in Past", () => {
    const modals = readFileSync(new URL('../src/panels/Modals.tsx', import.meta.url), 'utf8')
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
    const overview = readFileSync(new URL('../src/views/Overview.tsx', import.meta.url), 'utf8')
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
    expect(step).toContain(`sub.locator(\`[data-new-subproject-parent="\${M.id}"]\`)`)
    expect(step.indexOf(`[data-new-subproject-parent-choice="\${project.id}"]`)).toBeLessThan(
      step.indexOf(`.locator(\`[data-new-subproject-parent="\${project.id}"]\`)`),
    )
    expect(step).toContain(`eq(madeSub.parent_id, project.id, "the sub-project's parent")`)
    // its project goes in the cleanup
    expect(check).toContain(
      'if (run.projects.D) await deleteProjectInApp(c.writeToken, run.projects.D)',
    )
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
  it('words the creators line as the page does, exact to 100 and past it', () => {
    /* `n` creators, every `agentEvery`th an agent, as REST lists them. */
    const people = (n, agentEvery = 0) =>
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        name: `Person ${i}`,
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
    expect(creatorsLine(people(39, 10))).toBe('Person 0, Person 1 and 37 more, including 3 agents,')
    expect(creatorsLine(people(400))).toBe('Person 0, Person 1 and more than 100 others')
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
  it('tells a frame that subscribes the task windows from every other frame', () => {
    expect(ON_DEMAND_STEP).toBe('ui/tasks-on-demand')
    expect(TASK_WINDOWS_QUERY).toBe('workspace:tasks')
    expect(ROADMAP_QUERY).toBe('tasks:roadmap')
    expect(ASSIGNEE_LOAD_QUERY).toBe('planning:assigneeLoad')
    // the registry subscribes the workspace's task windows by that name
    const parts = readFileSync(new URL('../src/store/liveParts.ts', import.meta.url), 'utf8')
    expect(parts).toContain('tasks: api.workspace.tasks')
    const add = (udfPath) => ({ type: 'Add', queryId: 1, udfPath, args: [{}] })
    const frame = (...modifications) =>
      JSON.stringify({ type: 'ModifyQuerySet', baseVersion: 0, newVersion: 1, modifications })
    expect(addsQuery(frame(add('workspace:tasks')), TASK_WINDOWS_QUERY)).toBe(true)
    expect(
      addsQuery(frame(add('workspace:root'), add('workspace:tasks')), TASK_WINDOWS_QUERY),
    ).toBe(true)
    // the other parts, a removal, another message and no JSON are not one
    expect(addsQuery(frame(add('workspace:projects')), TASK_WINDOWS_QUERY)).toBe(false)
    expect(
      addsQuery(
        frame({ type: 'Remove', queryId: 1, udfPath: 'workspace:tasks' }),
        TASK_WINDOWS_QUERY,
      ),
    ).toBe(false)
    expect(
      addsQuery(
        JSON.stringify({ type: 'Mutation', udfPath: 'workspace:tasks' }),
        TASK_WINDOWS_QUERY,
      ),
    ).toBe(false)
    expect(addsQuery('not json', TASK_WINDOWS_QUERY)).toBe(false)
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
  it('names the tools that answer a placeholder sent alone as the server does', () => {
    const mcp = readFileSync(new URL('../convex/machine/mcp.ts', import.meta.url), 'utf8')
    const set = mcp.match(/const FORMERLY_BARE: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/)
    expect(set?.[1].split(',').map((name) => name.trim().replaceAll("'", ''))).toEqual(
      FORMERLY_BARE,
    )
  })
})

describe('staging check arguments', () => {
  it('takes the target and the cleanup options', () => {
    expect(parseArgs(['--staging']).target).toBe('staging')
    expect(parseArgs(['--staging', '--cleanup', '--run', 'a1b2c3']).run).toBe('a1b2c3')
    expect([...parseArgs(['--local', '--require', 'all']).require]).toEqual(['billing-pause-leave'])
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
    ])
      expect(() => parseArgs(argv)).toThrow()
  })
  it('never repeats a value it refuses, which could be a secret', () => {
    const secret = 'qvt_1111111111111111111111111'
    for (const argv of [
      ['--staging', secret],
      ['--staging', '--require', secret],
      ['--staging', '--invert', `read-token,${secret}`],
    ])
      expect(() => parseArgs(argv)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining(secret.slice(4)),
        }),
      )
    expect(() => parseArgs(['--staging', '--tokn'])).toThrow('Unknown argument --tokn.')
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
  it('searches a sweep by the run tag, or by the prefix every run tag shares', () => {
    expect(searchOf('stgchk-0a1b2c')).toBe('stgchk-0a1b2c')
    expect(searchOf(TAG_ANY)).toBe(TAG_PREFIX)
    // every tagged name holds the search, which the server matches as a
    // word fragment
    for (const name of ['stgchk-0a1b2c team', 'stgchk-ffffff Standard agent'])
      expect(name.toLowerCase().includes(searchOf(TAG_ANY))).toBe(true)
  })
})
