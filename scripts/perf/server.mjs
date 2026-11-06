// The stand-in server of the browser benchmark (scripts/benchmark-browser.mjs),
// in a Web Worker beside the benchmark page (scripts/perf/transport.mjs). It
// holds a realistic workspace, answers queries, mutations and subscriptions,
// and sends every result as the JSON text Convex's sync protocol carries,
// each after as long as its bytes take at `mbps`, one at a time. Its own work
// runs on the worker's thread, so the page's script time holds only what a
// real client does: decode the text and update the app.
//
// It serves the workspace in live parts (convex/workspace.ts), its tasks
// and projects in the id windows the app asks for, cut from the whole
// workspace it holds
// (convex/lib/workspaceJoin.ts splitWorkspace). After a write it sends every
// part whose JSON changed, and only those, in one transition, as Convex does.
// It also answers snapshot:forMe, the one query apps before the parts read,
// for a baseline build, and the task window's own queries (taskWindow:task,
// links and attachments) from the workspace it holds, which a write sends
// again with the parts it changed. The task window's relation pickers' read
// (taskWindow:relationCandidates), which the app reads once a batch, comes
// from a stand-in (src/store/relationPickerStandIn.setup.ts) before the
// task window's other reads.
//
// Like Convex, a write's results reach the page before its answer does. A
// subscription result that waits for its turn takes the writes made
// meanwhile, as the server sends each result's latest value.
//
// The workspace is realistic by default. Page parameters change it:
//   tasks (100)          visible tasks
//   descriptions (300)   average description length in characters
//   labels (2)           labels per task, at most, as a task carries
//                        each label once
//   orglabels (12)       labels in the organization, with ordinary names,
//                        which the tasks' labels spread over
//   links (0.05)         share of tasks that link to another task
//   attachments (0.1)    share of tasks with an attachment
//   subtasks (0.2)       share of tasks that are subtasks
//   follows (0.1)        share of tasks the signed-in person follows
//   people (50)          people in the organization
//   hidden (4)           projects the signed-in person cannot see, as full
//                        of tasks as the visible ones; they reach the
//                        workspace only as anonymized load rows and the
//                        has_hidden_subtasks and has_hidden_parent flags
//   programs (1)         visible top-level projects, the visible tasks
//                        spread over all their sub-projects, so the first,
//                        which the app opens, holds 1/programs of them
//   subprojects (10)     sub-projects of each visible top-level project
//   board                a state tasks:board answers whatever the tasks say
//                        (over_ceiling, over_budget, unavailable or
//                        access_unchecked), for checks by hand
//   overview             a state the Overview's queries answer whatever the
//                        tasks say, for screenshots of states a seeded
//                        backend cannot reach: counting, counts-budget,
//                        overdue-budget, projected-budget, loads (a guest's
//                        or Viewer's projection), incomplete (each list
//                        batch stops after half a batch), unknown (every
//                        owner's load unreadable, so projected candidates
//                        show as risk unknown), list-over-budget,
//                        over_budget, unavailable or access_unchecked; for
//                        the health table alone health-counting (its counts
//                        counting), health-budget (its rows' delays past the
//                        budget, so it sorts by name), health-loads (its
//                        rows' delays needing a second owner's load),
//                        health-over-budget, health-cap (at most 20 rows,
//                        so the cap note shows) and health-error (its read
//                        fails); several joined by commas
//   projectnav           a state the project picker's navigation reads
//                        (projectNav.page, children, search and resolve)
//                        answer whatever the workspace says, for
//                        screenshots of states a seeded backend cannot
//                        reach: not-ready (every list not ready),
//                        unchecked (every read the access_unchecked
//                        refusal), stopped (an open batch stops after two
//                        projects looked at), small (batches of five, so
//                        programs=45 reaches the eight batches a list
//                        gathers at most), error (every read fails) and
//                        favorites (the first two programs starred);
//                        several joined by commas
//   roadmap              a state the Roadmap's reads (tasks:roadmap and
//                        tasks:roadmapDependencies) answer whatever the
//                        tasks say, for screenshots of states a seeded
//                        backend cannot reach: over_ceiling, over_budget,
//                        unavailable and access_unchecked (both reads),
//                        counting and remaining-budget (the headings'
//                        Remaining), deps-budget (the dependency read past
//                        its budget), automove-budget (Auto-move's inputs
//                        past their size) and error (the Roadmap's read
//                        fails); several joined by commas
//   loads                a state the owner loads (planning:ownerLoads)
//                        answer for screenshots of Team utilization, the
//                        planning panel and the delays: unavailable (every
//                        owner past the reader's bounds) or loading (no
//                        answer)
//   labelpage            a state Settings › Labels' batches answer whatever
//                        the labels say, for screenshots of states a seeded
//                        backend cannot reach: counting (every count being
//                        prepared), uncounted (every third label not
//                        counted yet), stopped (an open batch stops after
//                        ten labels), small (batches of five, so
//                        orglabels=60 reaches the eight batches the page
//                        gathers at most) and error (every batch fails);
//                        several joined by commas. Open it with role=admin
//   teamsettings         a state Settings › Teams, a team's page and its Add
//                        member picker answer whatever the workspace says
//                        (teams:settingsPage, get, members and addable,
//                        src/store/teamSettingsStandIn.setup.ts), for
//                        screenshots of states a seeded backend cannot
//                        reach: stopped (an open batch stops after two
//                        rows looked at), not-ready (the three lists not
//                        ready), error (the three lists fail), get-error
//                        (a team page's own read fails), uncounted (every
//                        third team not counted yet) and batch-N (batches
//                        of N); several joined by commas. Open it with
//                        role=admin, or as a user, who leads the first team
//   userspage            a state Settings › Users' pages answer whatever the
//                        people say (people:settingsPage and people:get,
//                        src/store/peopleSettingsStandIn.setup.ts), for
//                        screenshots of states a seeded backend cannot
//                        reach: stopped (a page stops after ten people
//                        looked at), not-ready (the list not ready), error
//                        (every page fails), small (pages of five) and
//                        last-admin (the server counts one active admin);
//                        several joined by commas. Open it with role=admin,
//                        and people=1000 for the design size
//   agents (0)           Standard user agents in the organization, each with
//                        three keys, the oldest revoked, which
//                        tokens:agentKeys answers
//   agentkeys            a state the agents' key reads answer: error (every
//                        read fails) and capped (two keys an agent, with
//                        more past them)
//   creators             a state Organization › General's creators line
//                        answers (orgs:projectCreators): unavailable (the
//                        server could not count) and error (the read fails)
//   shownload=1          also send the load rows of the tasks the person is
//                        shown, as the server did before the app derived
//                        them from the task rows (an older baseline)
//   done                 the share of the default shape's tasks in Done, from
//                        0 to 1, spread over the numbers; by default a sixth
//   titles               the length of the default shape's task titles in
//                        characters, padded with ordinary words; by default
//                        about 40
//   shape=varied         a Board-shaped mix instead (variedTask): every
//                        status, a parent for every 25 tasks, due dates,
//                        paused, long-titled and unowned tasks
//   latency (100)        ms before every answer
//   mbps (8)             bandwidth every result waits for
//   appearance (dark)    the signed-in person's appearance mode, dark or
//                        light, which the app reads from appearance:get
//   role (user)          the signed-in person's organization role, user,
//                        viewer or admin; a Viewer's Overview reads one
//                        owner's load a query, as a guest's does, and only
//                        an admin opens Settings › Labels
//   unheld (0)           leaves the N highest-numbered visible tasks without
//                        a parent or subtasks out of the workspace's parts
//                        and snapshot:forMe, with their labels, files,
//                        follows and links, while tasks:board, search:page
//                        and the task window's queries still answer them
//                        and writes still change them, so a Board card or
//                        a Search result of one opens its task window from
//                        the window's own answer
//   window               a state the task window's own read of a task
//                        answers, for screenshots of states a seeded
//                        backend reaches only by timing: failed (the read
//                        fails after its first answer, and after Retry
//                        too), incomplete (its subtask list is not whole,
//                        so the window shows the task as a group whose
//                        subtasks it cannot all read), loading (the read
//                        never answers, so a task opened by its address
//                        or a reference shows its loading frame) or error
//                        (the read fails from its first answer on, so
//                        such a task shows that it could not be opened)
//   relations            states the relation pickers' read answers
//                        whatever the workspace says
//                        (src/store/relationPickerStandIn.setup.ts):
//                        stopped (each batch stops after 8 tasks looked
//                        at, so Load more goes on), failed (every read
//                        fails), unavailable, over_budget, blocked (the
//                        opened task's own block, as for subtasks the
//                        window cannot see), and rows-N (N tasks a batch,
//                        for Load more and the held rows); several joined
//                        by commas
//   removal              a state the removal window's reads answer
//                        whatever the workspace says, for screenshots of
//                        states a seeded backend cannot reach inside the
//                        design size (src/store/removalStandIn.setup.ts):
//                        many (40 more tasks than it lists), over
//                        (Reassign refused past LIMITS.reassign.max),
//                        capped (both choices refused past
//                        LIMITS.removalHolders.max), too_large, refused,
//                        leave_only, unsettled (a caller who may make
//                        neither choice, for the notice), slow (both reads
//                        answer after two seconds), and for the Reassign
//                        picker choices-stopped, choices-not-ready and
//                        choices-error; several joined by commas. With the
//                        parameter at all, removal=open for no forced
//                        state, the first team shares each program at
//                        User, so a removal on Settings' team or program
//                        pages opens the window
//   projectsettings      states a project's Settings page reads answer
//                        whatever the workspace says, for screenshots of
//                        states a seeded backend cannot reach inside the
//                        design size (src/store/projectSettingsStandIn.setup.ts):
//                        not-ready (the lists and pickers answer
//                        not_ready), stopped (each open batch stops after
//                        ten rows), error (the lists, pickers and the
//                        invite lookup fail), get-error (the page's own
//                        read fails), loading (the page's own read never
//                        answers), refused (the pickers and the invite
//                        lookup answer with the write's refusal), small
//                        (batches of five) and unheld (once a project's
//                        page has read it, the workspace's parts leave the
//                        project and its grants out while the page's reads
//                        still answer them, as for a project an admin
//                        manages without taking part in it); several
//                        joined by commas. Open it with role=admin
//   projectlists         states Settings' project lists answer whatever the
//                        workspace says (projectSettings:projects,
//                        subProjects, archived and archivedSubProjects,
//                        src/store/projectSettingsListsStandIn.setup.ts):
//                        not-ready (every list not ready), stopped (each
//                        open batch stops after ten projects looked at),
//                        error (every list fails), unchecked (every list
//                        the access_unchecked refusal) and small (batches
//                        of five); several joined by commas. With
//                        role=admin the lists hold the hidden projects the
//                        workspace leaves out, so opening one shows a
//                        project page the workspace does not hold
//   deleted (0)          that many of the visible tasks in Deleted items, by
//                        number after the first sub-project of the first
//                        program, which is deleted whole with its tasks, as
//                        src/store/deletedItemsStandIn.setup.ts
//                        deletedFixtureOf builds them: most deleted by the
//                        signed-in person, every third by another person and
//                        every seventh by an agent through its key; an
//                        admin (role=admin) sees all of them and anyone else
//                        their own. The Deleted items reads and writes answer
//                        from that stand-in. The workspace keeps their tasks,
//                        which only Deleted items treats as deleted, and a
//                        restore takes items out of Deleted items without
//                        bringing anything back into it
//   deletedstate         states the Deleted items reads and writes answer
//                        whatever the items say: too-wide, missing-reads,
//                        missing-matches, legacy, stopped (each page stops
//                        after ten entries), hidden (an admin's task rows
//                        hidden), people-not-ready, people-stopped (each
//                        batch stops after five people), error (every read
//                        fails), slow (each restore or purge waits 1.5 s),
//                        refuse-at-2 (the second write is refused whole),
//                        pause-at-2 (the second meets the pause), deferred
//                        (a task item restored with the project item it
//                        waits for is deferred) and two-orgs (the person
//                        holds a seat in Partner Co too, with a deleted
//                        project there); several joined by commas
//   archivedprojects (0) archives that many of the last programs, keeping
//                        the first live: every other one after its first
//                        sub-project was archived on its own a day before,
//                        the rest of its sub-projects carried with it, for
//                        Archived projects. programs=120&subprojects=3&
//                        archivedprojects=60 lists 60 live and 60 archived
//                        projects, inside the design size
//   milestones           a state the app's milestone reads (milestones:get,
//                        section and between) answer whatever the workspace
//                        says, for screenshots of states a seeded backend
//                        cannot reach (src/store/milestoneStandIn.setup.ts):
//                        for the Milestones window's read of the milestone
//                        it opens on, open-loading (it never answers),
//                        open-error (it fails), open-unavailable (it
//                        answers null) and open-refused (the refusal of a
//                        read too large); for Team sync's opening,
//                        sync-loading, sync-error, sync-partial (both reads
//                        stop after their first row), sync-refused and
//                        sync-too-many (the page lowers the store's cap of
//                        projects one read names to none, scripts/perf/
//                        entry.tsx, so the opening asks nothing); for the
//                        Milestones window's sections, window-loading,
//                        window-error, window-refused and window-partial
//                        (Upcoming stops after its first row),
//                        past-loading and past-error (Past alone), and
//                        more-error (a Load more fails while the read it
//                        grows answers); several joined by commas
//   milestoneweeks (0)   plants that many weekly milestones from this week
//                        on and as many in the weeks before it on the
//                        visible program, instead of four two weeks apart,
//                        for the window's Load more, Past and search
//   milestonecap         the window's sections read batches of that many
//                        and hold at most twice that (the page lowers
//                        src/lib/milestoneSection.ts MILESTONE_SECTION,
//                        scripts/perf/entry.tsx), so milestoneweeks=5&
//                        milestonecap=2 shows Load more and the moved-on
//                        note with few rows
//   sync                 states Team sync's agenda (teamSync:agenda)
//                        answers whatever the workspace says
//                        (src/store/teamSyncStandIn.setup.ts), for the
//                        page's notes and screenshots: over_ceiling,
//                        over_budget, unavailable, access_unchecked,
//                        delays-unknown (every verdict that needs a load),
//                        weeks-unknown (every person's week), viewer (as an
//                        organization Viewer's agenda reads it: no load,
//                        those verdicts unknown), stale (an ok answer that
//                        turns over_ceiling four seconds later), error
//                        (every read fails) and ceiling:<n> (the agenda's
//                        own ceiling rules at a ceiling of n tasks, so a
//                        small workspace reaches over_ceiling or
//                        over_budget without seeding past 1,000); several
//                        joined by commas. Open a Viewer's page with
//                        role=viewer too
//   syncscope=program    the first program saved as the signed-in
//                        person's Team sync scope (prefs:get), under the
//                        key this app reads and the one apps before the
//                        agenda view read, for the benchmark's Team sync
//                        phase
//   grants (0)           User grants on the first program for that many
//                        more people, with more people in the
//                        organization when it needs them, so the Users
//                        list's Load more and its cap show (grants=210 is
//                        past the 200 rows it gathers). With grants or
//                        projectsettings the second person, an admin, leads
//                        the first program, so its sub-projects show an
//                        inherited lead
//   unread (0)           unread messages for the signed-in person at the
//                        start, one per task, a minute apart, so the Inbox
//                        badge counts them (unread=12 shows 12)
//   inbox                a state the Inbox's unread summary and the open
//                        task's inbox item (inbox:summary and inbox:item)
//                        answer whatever the messages say, for screenshots
//                        of the badge's states a seeded backend cannot
//                        reach (src/store/inboxStandIn.setup.ts), one of
//                        loading (neither ever answers), failed (both fail),
//                        incomplete (the count is a lower bound, so unread=12
//                        shows 12+), more (more than 99) or notready (the
//                        seat's items are not complete, so the count is a
//                        lower bound and the item answers building)
//
// Main Search (search:page) is a stand-in too (searchPage): it matches the
// visible tasks and projects with the server's word rules and ranks them
// as the server does, but reads no access, budget or archive. So is the
// Board's query (tasks:board), through the one stand-in the jsdom tests use
// (src/store/boardStandIn.setup.ts): the Board's rules over the workspace
// held here, with no access or read budget, and the ceiling of 1,000 tasks.
// So are the Roadmap's two reads (tasks:roadmap and tasks:roadmapDependencies),
// through the stand-in the jsdom tests use (src/store/roadmapStandIn.setup.ts):
// the Roadmap's rules over the workspace held here, with no access or read
// budget, the ceiling of 1,000 rows and every project editable but for
// role=viewer. So are the owner loads the delays of tasks only a view's
// answer brings and Team utilization read (planning:ownerLoads,
// src/store/ownerLoadsStandIn.setup.ts), from the same workspace, with no
// bounds. So are the Overview's queries
// (overview:summary, risk, attention, paused and health), through the
// stand-in the jsdom tests use (src/store/overviewStandIn.setup.ts), with no
// access or read budget. So are Settings › Labels' batches
// (labels:settingsPage), through the stand-in the jsdom tests use
// (src/store/labelPagesStandIn.setup.ts), which answers an admin only and
// reads no read budget. So are Settings › Teams' batches and a team's page
// with its Add member picker (teams:settingsPage, get, members and
// addable), through src/store/teamSettingsStandIn.setup.ts, which keeps the
// server's audiences and counts by team_counts' rule; the team writes
// those pages send are not answered here. So are
// Settings › Users' pages, a person's page,
// people by id, the agents' keys, the creators line and the invitation rows
// of the seats a page names (people:settingsPage, get and byIds,
// tokens:agentKeys, orgs:projectCreators and invites:deliveries), through
// src/store/peopleSettingsStandIn.setup.ts, which keeps the server's
// audiences, order and search and reads no budget. The profile and key
// writes those pages send get no answer here. So are the project picker's
// navigation reads (projectNav:page, children, search and resolve), through
// src/store/projectNavStandIn.setup.ts, which judges the signed-in person by
// ordinary access, reads no budget and has no favorites unless
// projectnav=favorites asks. Archived tasks' own read (issues:archivedPage) has
// no stand-in, so its page fails once projects are chosen here. So are a
// project's Settings page reads (projectSettings:get, users, teams, candidates,
// leadCandidates and inviteTarget), through the stand-in the jsdom tests use
// (src/store/projectSettingsStandIn.setup.ts), over the whole workspace, with
// the access rules but no read budget. So are Settings' project lists
// (projectSettings:projects, subProjects, archived and archivedSubProjects),
// through src/store/projectSettingsListsStandIn.setup.ts, over the whole
// workspace and, for an admin, the hidden projects. The project writes
// they lead to (projects:update, setAccess, removeAccess and inviteGuest)
// change the workspace, and so does projects:create of the New project and
// New sub-project dialogs, with the caller as lead when it names none, the
// creator's own grant on a top-level project by the server's rule
// (convex/lib/projectGrants.ts creatorGrant) and the server's place, one
// past the siblings' largest; a sub-project of the hidden program joins
// that program, so the workspace never holds it, as for a project an admin
// creates under one they only manage after the admin access split
// (role=admin&hidden=N). So are the removal window's reads
// (accessRemovals:preview and reassignChoices), through
// src/store/removalStandIn.setup.ts, which takes the removed people's open
// tasks in the projects the change reaches as the lost holdings and every
// person who can hold work as the choices, and answers a chosen person's
// holder_eligible by that rule, without the server's rules.
// So are the Inbox's unread summary and the open task's inbox item
// (inbox:summary and inbox:item), through the stand-in the jsdom tests use
// (src/store/inboxStandIn.setup.ts), folded from the messages held here,
// and a write sends them again with the parts it changed. Its read of one
// item (messages:readItem) marks the item's unread messages up to its
// `through` read and prunes the item, as messages:markRead does.
// So is Team sync's agenda (teamSync:agenda), through the stand-in the
// jsdom tests use (src/store/teamSyncStandIn.setup.ts): the agenda's rules
// over the workspace held here, with no access rule or read budget, and the
// ceiling of 1,000 tasks. The task window's read of a task resolves its ref
// as the server does (convex/lib/taskWindow.ts taskByRef): a uuid in any
// case, or a number bare or as QN-12 in the organization asked only.
import { chunkLists } from '../../convex/lib/arrayLimit'
import { idWindows, startWindows } from '../../convex/lib/idWindows'
import { creatorGrant } from '../../convex/lib/projectGrants'
import { matchesTerms, scoreOf, searchTerms } from '../../convex/lib/searchTerms'
import { parseIssueRef } from '../../convex/lib/taskRefs'
import { nextSyncStamp } from '../../convex/lib/teamSync'
import { splitWorkspace } from '../../convex/lib/workspaceJoin'
import { boardStandIn } from '../../src/store/boardStandIn.setup'
import {
  DELETED_READS,
  deletedFixtureOf,
  deletedPurge,
  deletedRestore,
  deletedStandIn,
  isDeletedRead,
} from '../../src/store/deletedItemsStandIn.setup'
import {
  INBOX_NO_ANSWER,
  inboxItemStandIn,
  inboxSummaryStandIn,
} from '../../src/store/inboxStandIn.setup'
import { labelSettingsStandIn } from '../../src/store/labelPagesStandIn.setup'
import { milestoneStandIn } from '../../src/store/milestoneStandIn.setup'
import { overviewStandIn } from '../../src/store/overviewStandIn.setup'
import { ownerLoadsStandIn } from '../../src/store/ownerLoadsStandIn.setup'
import {
  isPeopleSettingsRead,
  peopleSettingsStandIn,
} from '../../src/store/peopleSettingsStandIn.setup'
import { NAV_UNCHECKED, projectNavStandIn } from '../../src/store/projectNavStandIn.setup'
import {
  isProjectListRead,
  LISTS_UNCHECKED,
  projectListsStandIn,
} from '../../src/store/projectSettingsListsStandIn.setup'
import { projectSettingsStandIn } from '../../src/store/projectSettingsStandIn.setup'
import { relationPickerStandIn } from '../../src/store/relationPickerStandIn.setup'
import { reassignChoicesStandIn, removalPreviewStandIn } from '../../src/store/removalStandIn.setup'
import { dependenciesStandIn, roadmapStandIn } from '../../src/store/roadmapStandIn.setup'
import { isTeamSettingsRead, teamSettingsStandIn } from '../../src/store/teamSettingsStandIn.setup'
import { teamSyncStandIn } from '../../src/store/teamSyncStandIn.setup'

// the page passes its parameters as the worker's name (scripts/perf/transport.mjs)
/* The most rows one bulk inbox batch changes, convex/model/messages.ts
   INBOX_BATCH, which this worker cannot import with the server code. */
const INBOX_BATCH = 160
/* The worker port this instance was loaded with. Messages go through it,
   not through the global `self` read at call time, so a timer of an
   instance the tests have replaced (vi.resetModules) posts to its own,
   finished test, never into a later one's messages. */
const port = self
const parameters = new URLSearchParams(port.name)
const option = (name, fallback) => {
  const value = parameters.get(name)
  return value === null ? fallback : Number(value)
}
const count = option('tasks', 100)
const latency = option('latency', 100)
const mbps = option('mbps', 8)
const descriptionLength = option('descriptions', 300)
const labelsPerTask = option('labels', 2)
const orgLabelCount = Math.max(1, option('orglabels', 12))
const linkShare = option('links', 0.05)
const attachmentShare = option('attachments', 0.1)
const subtaskShare = option('subtasks', 0.2)
const followShare = option('follows', 0.1)
const grantCount = Math.max(0, option('grants', 0))
const peopleCount = Math.max(2, option('people', 50), grantCount + 2)
const hiddenCount = option('hidden', 4)
const programCount = Math.max(1, option('programs', 1))
const subprojectCount = Math.max(1, option('subprojects', 10))
// the default shape's share of Done tasks and title length, or null for
// its own mix
const doneShare = parameters.has('done') ? Math.min(1, Math.max(0, option('done', 0))) : null
const titleLength = parameters.has('titles') ? Math.max(1, option('titles', 40)) : null
const forcedBoard = parameters.get('board') ?? undefined
/* The Roadmap's forced states (the `roadmap` parameter): those its
   stand-in's `force` takes, and whether its read fails. */
const roadmapStates = (parameters.get('roadmap') ?? '').split(',').filter(Boolean)
const forcedRoadmap = roadmapStates.filter((state) => state !== 'error')
const roadmapFails = roadmapStates.includes('error')
/* The owner loads' forced state (the `loads` parameter). */
const forcedLoads = parameters.get('loads') ?? null
/* The Overview's forced states (the `overview` parameter), as the
   stand-in's `force` takes them. */
const forcedOverview = (() => {
  const force = {}
  for (const state of (parameters.get('overview') ?? '').split(',').filter(Boolean)) {
    if (state === 'counting') force.counts = 'counting'
    else if (state === 'counts-budget') force.counts = 'budget'
    else if (state === 'overdue-budget') force.overdue = 'budget'
    else if (state === 'projected-budget') force.projected = 'budget'
    else if (state === 'loads') force.projected = 'loads'
    else if (state === 'incomplete') force.list = 'incomplete'
    else if (state === 'list-over-budget') force.list = 'over_budget'
    else if (state === 'unknown') force.unknown = 'everyone'
    else if (['over_budget', 'unavailable', 'access_unchecked'].includes(state)) force.scope = state
    else if (state === 'health-counting') force.health = { ...force.health, counts: 'counting' }
    else if (state === 'health-budget') force.health = { ...force.health, delays: 'budget' }
    else if (state === 'health-loads') force.health = { ...force.health, delays: 'loads' }
    else if (state === 'health-over-budget')
      force.health = { ...force.health, scope: 'over_budget' }
    else if (state === 'health-cap') force.health = { ...force.health, most: 20 }
    else if (state === 'health-error') force.healthError = true
  }
  return force
})()
/* Settings › Users' forced states (the `userspage`, `agentkeys` and
   `creators` parameters), as the stand-in's `force` takes them. */
const forcedPeople = (() => {
  const force = {}
  const fail = []
  const states = (name) => (parameters.get(name) ?? '').split(',').filter(Boolean)
  for (const state of states('userspage')) {
    if (state === 'stopped') force.stop = 10
    else if (state === 'not-ready') force.notReady = true
    else if (state === 'error') fail.push('settingsPage', 'get')
    else if (state === 'small') force.batch = 5
    else if (state === 'last-admin') force.admins = 1
  }
  for (const state of states('agentkeys')) {
    if (state === 'error') fail.push('agentKeys')
    else if (state === 'capped') force.keysMost = 2
  }
  for (const state of states('creators')) {
    if (state === 'unavailable') force.creatorsUnavailable = true
    else if (state === 'error') fail.push('projectCreators')
  }
  if (fail.length) force.fail = fail
  return force
})()
/* Settings › Labels' forced states (the `labelpage` parameter), as the
   stand-in's `force` takes them; `uncounted` names its labels once they
   exist. */
const forcedLabels = (() => {
  const force = {}
  for (const state of (parameters.get('labelpage') ?? '').split(',').filter(Boolean)) {
    if (state === 'counting') force.counting = true
    else if (state === 'stopped') force.stop = 10
    else if (state === 'small') force.batch = 5
    else if (state === 'error') force.fail = true
    else if (state === 'uncounted') force.uncounted = true
  }
  return force
})()
/* Settings › Teams' and a team page's forced states (the `teamsettings`
   parameter), as the stand-in's `force` takes them; `uncounted` names its
   teams when the page reads them (readTeams). */
const forcedTeams = (() => {
  const force = {}
  const fail = []
  for (const state of (parameters.get('teamsettings') ?? '').split(',').filter(Boolean)) {
    if (state === 'stopped') force.stop = 2
    else if (state === 'not-ready') force.notReady = true
    else if (state === 'error') fail.push('settingsPage', 'members', 'addable')
    else if (state === 'get-error') fail.push('get')
    else if (state === 'uncounted') force.uncounted = true
    else if (/^batch-\d+$/.test(state)) force.batch = Math.max(1, Number(state.slice(6)))
  }
  if (fail.length) force.fail = fail
  return force
})()
/* The navigation reads' forced states (the `projectnav` parameter), as the
   stand-in's `force` takes them; `favorites` names its programs once they
   exist (projectNavForce). */
const forcedProjectNav = (() => {
  const force = {}
  for (const state of (parameters.get('projectnav') ?? '').split(',').filter(Boolean)) {
    if (state === 'not-ready') force.notReady = true
    else if (state === 'unchecked') force.unchecked = NAV_UNCHECKED
    else if (state === 'stopped') force.stop = 2
    else if (state === 'small') force.batch = 5
    else if (state === 'error') force.fail = true
    else if (state === 'favorites') force.favorites = true
  }
  return force
})()
const varied = parameters.get('shape') === 'varied'
const shownLoad = parameters.get('shownload') === '1'
const appearance = parameters.get('appearance') === 'light' ? 'light' : 'dark'
const viewer = parameters.get('role') === 'viewer'
const admin = parameters.get('role') === 'admin'
const unheldCount = option('unheld', 0)
const forcedWindow = parameters.get('window') ?? undefined
/* The inbox reads' forced state (the `inbox` parameter), as the stand-in's
   `force` takes it. */
const forcedInbox = (() => {
  const state = parameters.get('inbox')
  if (state === 'notready') return 'notReady'
  return ['loading', 'failed', 'incomplete', 'more'].includes(state) ? state : undefined
})()
/* The milestone reads' forced states (the `milestones` parameter), as the
   stand-in's `force` takes them; sync-too-many is the page's
   (scripts/perf/entry.tsx). */
const forcedMilestones = (() => {
  const force = {}
  const sync = { 'sync-loading': 'loading', 'sync-error': 'error', 'sync-partial': 'stopped' }
  // the window's sections: Upcoming, Past and a Load more, each alone
  const sections = {
    'window-loading': ['upcoming', 'loading'],
    'window-error': ['upcoming', 'error'],
    'window-refused': ['upcoming', 'refused'],
    'window-partial': ['upcoming', 'stopped'],
    'past-loading': ['past', 'loading'],
    'past-error': ['past', 'error'],
    'more-error': ['more', 'error'],
  }
  for (const state of (parameters.get('milestones') ?? '').split(',').filter(Boolean)) {
    if (state === 'open-loading') force.get = 'loading'
    else if (state === 'open-error') force.get = 'error'
    else if (state === 'open-unavailable') force.get = 'unavailable'
    else if (state === 'open-refused') force.get = 'refused'
    else if (state === 'sync-refused') force.section = force.between = 'refused'
    else if (state in sync) force.section = force.between = sync[state]
    else if (state in sections) force[sections[state][0]] = sections[state][1]
  }
  // a Load more is an ask above the page's first batch (milestonecap)
  const cap = option('milestonecap', 0)
  if (cap > 0) force.firstBatch = cap
  return force
})()
/* Team sync's forced states (the `sync` parameter). */
const forcedSync = new Set((parameters.get('sync') ?? '').split(',').filter(Boolean))
/* Team sync's lowered ceiling (sync=ceiling:<n>), or undefined. */
const syncCeiling = (() => {
  const value = [...forcedSync].find((s) => s.startsWith('ceiling:'))?.slice(8)
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) throw new Error(`sync=ceiling:${value} is not a task count`)
  return n
})()
/* How long an agenda read answers ok before sync=stale turns it, in ms. */
const SYNC_STALE_MS = 4000
/* When the first agenda read was asked, for sync=stale, or null, and
   whether the meeting has stopped fitting. The first read's timer sets it,
   then sends the watched agenda again in a transition. */
let syncAskedAt = null
let syncTurned = false
/* The relation pickers' forced states (the `relations` parameter), as the
   stand-in's `force` takes them. */
const forcedRelations = (() => {
  const force = {}
  for (const state of (parameters.get('relations') ?? '').split(',').filter(Boolean)) {
    if (state === 'stopped') force.stop = 8
    else if (state === 'failed') force.fail = true
    else if (state === 'unavailable') force.unavailable = true
    else if (state === 'over_budget') force.over = true
    else if (state === 'blocked') force.blocked = true
    else if (/^rows-\d+$/.test(state)) force.rows = Math.max(1, Number(state.slice(5)))
  }
  return force
})()
/* A project's Settings page forced states (the `projectsettings`
   parameter), as the stand-in's `force` takes them, and the two the
   server handles itself: `loading`, a page read that never answers, and
   `unheld`. */
const settingsStates = new Set((parameters.get('projectsettings') ?? '').split(',').filter(Boolean))
const forcedSettings = (() => {
  const force = {}
  if (settingsStates.has('not-ready')) force.notReady = true
  if (settingsStates.has('stopped')) force.stop = 10
  if (settingsStates.has('refused')) force.refused = true
  if (settingsStates.has('small')) force.batch = 5
  const fail = []
  if (settingsStates.has('error'))
    fail.push('users', 'teams', 'candidates', 'leadCandidates', 'inviteTarget')
  if (settingsStates.has('get-error')) fail.push('get')
  if (fail.length) force.fail = fail
  return force
})()
/* Settings' project lists' forced states (the `projectlists` parameter),
   as the stand-in's `force` takes them. */
const forcedLists = (() => {
  const force = {}
  for (const state of (parameters.get('projectlists') ?? '').split(',').filter(Boolean)) {
    if (state === 'not-ready') force.notReady = true
    else if (state === 'stopped') force.stop = 10
    else if (state === 'error')
      force.fail = ['projects', 'subProjects', 'archived', 'archivedSubProjects']
    else if (state === 'unchecked') force.unchecked = LISTS_UNCHECKED
    else if (state === 'small') force.batch = 5
  }
  return force
})()
/* Deleted items' forced states (the `deletedstate` parameter), as the
   stand-in's `force` takes them, and whether the person holds a second
   seat there. */
const deletedStates = new Set((parameters.get('deletedstate') ?? '').split(',').filter(Boolean))
const forcedDeleted = (() => {
  const force = {}
  if (deletedStates.has('too-wide')) force.tooWide = true
  if (deletedStates.has('missing-reads')) force.missing = 'reads'
  if (deletedStates.has('missing-matches')) force.missing = 'matches'
  if (deletedStates.has('legacy')) force.legacy = true
  if (deletedStates.has('stopped')) force.stopped = 10
  if (deletedStates.has('hidden')) force.hidden = true
  if (deletedStates.has('people-not-ready')) force.peopleNotReady = true
  if (deletedStates.has('people-stopped')) force.peopleStopped = 5
  if (deletedStates.has('error'))
    force.fail = DELETED_READS.map((n) => n.slice('deletedItems:'.length))
  if (deletedStates.has('slow')) force.slow = 1500
  if (deletedStates.has('refuse-at-2')) force.refuseAt = 2
  if (deletedStates.has('pause-at-2')) force.pauseAt = 2
  if (deletedStates.has('deferred')) force.deferred = true
  return force
})()
const deletedCount = option('deleted', 0)
/* The removal window's forced states (the `removal` parameter). */
const forcedRemoval = new Set((parameters.get('removal') ?? '').split(',').filter(Boolean))
const fixtureTime = new Date()
const now = fixtureTime.toISOString()
const day = (offset) => {
  const date = new Date(fixtureTime)
  date.setDate(date.getDate() + offset)
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
}
/* The same pseudo-random numbers on every page, from [0, 1). */
let seed = 7
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const org = '00000000-0000-4000-8000-000000000001'
/* A row id of kind `kind`, the `n`th: a UUID whose first part is a hash,
   spread like the random ids the app makes (convex/lib/idWindows.ts). */
export const id = (kind, n) => {
  let hash = 0x811c9dc5
  for (const ch of `${kind}:${n}`) hash = Math.imul(hash ^ ch.charCodeAt(0), 0x01000193) >>> 0
  return `${hash.toString(16).padStart(8, '0')}-000${kind}-4000-8000-${String(n).padStart(12, '0')}`
}
const storageId = (n) => `kg2${String(n).padStart(29, '0')}`
const WORDS =
  'the firmware build signs every image before the bootloader checks it against the key in fuse memory so a field update can never run code nobody approved and the test rig repeats this on each board revision during the prüfstand översikt naïve'.split(
    ' ',
  )
/** Markdown prose of about `length` characters. */
const prose = (length) => {
  let text = ''
  while (text.length < length) text += `${WORDS[Math.floor(random() * WORDS.length)]} `
  return text.slice(0, length).trim()
}
const profiles = Array.from({ length: peopleCount }, (_, n) => ({
  id: id('1', n),
  org_id: org,
  auth_user_id: n ? `account-${n}` : 'perf-account',
  email: `planner${n + 1}@testbed.example`,
  // some names in letters past ASCII, as real people's are
  name: `${['Planner', 'Åsa', 'Jörg', 'Zoë'][n % 4]} ${n + 1}`,
  initials: `P${n + 1}`,
  color: '#335577',
  // staff, so hidden projects show as anonymized load like a real member's,
  // unless the page asks for a Viewer
  org_role: n === 0 && viewer ? 'viewer' : (n === 0 && admin) || n === 1 ? 'admin' : 'user',
  active: true,
  kind: 'person',
  plannable_hours: 40,
  message_retention_days: 7,
  accepted_at: now,
  created_at: now,
}))
const me = profiles[0]
const teams = Array.from({ length: Math.ceil(peopleCount / 10) }, (_, n) => ({
  id: id('7', n),
  org_id: org,
  name: `Testbed team ${n + 1}`,
  stale_days: 14,
  archive_days: 30,
  track_delay_default: false,
  created_at: now,
}))
const teamMembers = profiles.map((profile, n) => ({
  team_id: teams[Math.floor(n / 10)].id,
  profile_id: profile.id,
  is_leader: n % 10 === 0,
}))
/* The `agents` option's Standard user agents, in no team, after the
   people. */
const agentRows = Array.from({ length: Math.max(0, option('agents', 0)) }, (_, n) => ({
  id: id('c', n),
  org_id: org,
  name: `Agent ${n + 1}`,
  initials: 'AG',
  color: '#475569',
  org_role: 'user',
  active: true,
  kind: 'agent',
  created_at: now,
}))
profiles.push(...agentRows)
/* Each agent's three keys as tokens:agentKeys lists them, the oldest
   revoked, which the server holds outside the workspace. */
const agentKeys = agentRows.flatMap((agent, n) =>
  [1, 2, 3].map((k) => ({
    id: id('d', n * 3 + k),
    agentId: agent.id,
    name: k === 1 ? 'Old key' : `Key ${k}`,
    prefix: `qva_${String(n % 1000).padStart(3, '0')}...a${String(k).padStart(4, '0')}`,
    createdAt: `2026-0${k}-01T08:00:00.000Z`,
    lastUsedAt: null,
    revokedAt: k === 1 ? '2026-04-01T08:00:00.000Z' : null,
  })),
)
/** The key of project number `num`: unique, as no two projects share a
    number, and at most five characters, as the schema asks. */
const projectKey = (num) => `P${num.toString(36).toUpperCase()}`
/** A top-level program and its `size` sub-projects, numbered from `num`.
    A sub-project's id comes from its number too, so no two share one. */
const program = (n, name, size, num) => {
  const meta = {
    id: id('2', n),
    org_id: org,
    type: 'meta',
    key: projectKey(num),
    num,
    name,
    description: prose(120),
    sort_order: n,
    track_delay: varied,
    created_at: now,
  }
  const children = Array.from({ length: size }, (_, c) => ({
    ...meta,
    id: id('3', num + c + 1),
    type: 'project',
    parent_id: meta.id,
    key: projectKey(num + c + 1),
    num: num + c + 1,
    name: `${name.replace('program', 'project')} ${c + 1}`,
    sort_order: c,
  }))
  return { meta, children }
}
/* The visible programs, the first of which the app opens, numbered one
   after another, and the hidden one after them. */
const programs = Array.from({ length: programCount }, (_, n) =>
  program(
    n,
    n ? `Testbed program ${n + 1}` : 'Testbed program',
    subprojectCount,
    1 + n * (subprojectCount + 1),
  ),
)
const visible = programs[0]
/* With projectsettings or grants, the second person, an admin, leads the
   first program, and its sub-projects, which name no lead of their own,
   are led by that lead, so their Settings pages show an inherited lead. */
if (parameters.has('projectsettings') || grantCount) visible.meta.lead_id = profiles[1].id
const hiddenNum = Math.max(20, 1 + programCount * (subprojectCount + 1))
const hidden = program(programCount, 'Hidden program', hiddenCount, hiddenNum)
/* `archivedprojects`: the last programs archived an hour apart, newest
   first, every other one after its first sub-project was archived on its
   own a day before; the first program stays live. Their tasks are not in
   the workspace, as an archive takes them out of it. */
const archivedCount = Math.min(Math.max(0, option('archivedprojects', 0)), programCount - 1)
const archivedPrograms = programs.slice(programCount - archivedCount)
archivedPrograms.forEach((p, i) => {
  const at = new Date(fixtureTime.getTime() - (i + 1) * 3_600_000).toISOString()
  const alone = new Date(fixtureTime.getTime() - (i + 1) * 3_600_000 - 86_400_000).toISOString()
  p.meta.archived_at = at
  p.children.forEach((child, c) => {
    child.archived_at = i % 2 === 0 && c === 0 ? alone : at
  })
})
const liveProgramCount = programCount - archivedCount
const projects = programs.slice(0, liveProgramCount).flatMap((p) => p.children)
// a grant on each program reaches its sub-projects; the hidden one has none
const access = [
  ...programs.map((p) => ({ project_id: p.meta.id, profile_id: me.id, level: 'user' })),
  // `grants`: more people's User grants on the first program
  ...profiles
    .slice(2, 2 + grantCount)
    .map((p) => ({ project_id: visible.meta.id, profile_id: p.id, level: 'user' })),
]
/* With the `removal` parameter, the first team shares each program at
   User, so a member's removal on its team page, or the team's own on a
   program's page, takes its members' tasks out of their sight and opens
   the removal window (src/store/removalStandIn.setup.ts). Without it there
   are no shares, as the benchmark measures. */
const removalShares = parameters.has('removal')
  ? programs.map((p) => ({ project_id: p.meta.id, team_id: teams[0].id, level: 'user' }))
  : []
/* What the labels past the first twelve are about, as a team names its
   labels; each is numbered, so no two share a name. */
const LABEL_TOPICS = [
  'Field test',
  'Supplier review',
  'Bench rig',
  'Enclosure fit',
  'Calibration',
  'Certification',
  'Packaging',
  'Pilot site',
  'Power budget',
  'Release notes',
]
/** The name of label `n`: Label A to Label L, then a topic and a number. */
const labelName = (n) =>
  n < 12
    ? `Label ${String.fromCharCode(65 + n)}`
    : `${LABEL_TOPICS[(n - 12) % LABEL_TOPICS.length]} ${String(Math.floor((n - 12) / LABEL_TOPICS.length) + 1).padStart(2, '0')}`
const labels = Array.from({ length: orgLabelCount }, (_, n) => ({
  id: id('8', n),
  org_id: org,
  name: labelName(n),
  name_lower: labelName(n).toLowerCase(),
  color: '#557733',
  created_at: now,
}))
/* What the planted weekly milestones are called, by turns. */
const MILESTONE_NAMES = ['Design review', 'Prototype build', 'Field test', 'Supplier audit']
const milestoneWeeks = option('milestoneweeks', 0)
const milestones =
  milestoneWeeks > 0
    ? Array.from({ length: 2 * milestoneWeeks }, (_, n) => {
        // from this week on, then back from last week
        const k = n % milestoneWeeks
        const upcoming = n < milestoneWeeks
        return {
          id: id('9', n),
          project_id: visible.meta.id,
          name: `${MILESTONE_NAMES[k % MILESTONE_NAMES.length]} ${Math.floor(k / MILESTONE_NAMES.length) + 1}${upcoming ? '' : ' signed off'}`,
          week: day(upcoming ? 7 * k : -7 * (k + 1)),
          created_at: now,
        }
      })
    : Array.from({ length: 4 }, (_, n) => ({
        id: id('9', n),
        project_id: visible.meta.id,
        name: `Milestone ${n + 1}`,
        week: day(n * 14),
        created_at: now,
      }))
// no Backlog: the Roadmap leaves some of those out, and every phase wants them all
const STATUSES = ['todo', 'todo', 'progress', 'progress', 'review', 'done']
/* Ten tasks a block in one project. Inside a block the task at 5 is a
   parent of up to the next `subtaskShare × 10` ones, so the first task,
   which the drag phase moves, is always a plain one. */
const subtasksPerBlock = Math.min(4, Math.round(subtaskShare * 10))
const parentOf = (n) => {
  const at = n % 10
  return at > 5 && at <= 5 + subtasksPerBlock ? id('4', n - at + 5) : undefined
}
/* The open statuses a task takes where the `done` parameter sets the share
   of Done tasks. */
const OPEN_STATUSES = STATUSES.filter((status) => status !== 'done')
/** Whether task `n` is Done under the `done` parameter: the golden ratio's
    steps spread the share over the numbers, so every block of tasks holds
    about it. */
const doneAt = (n, share) => (n * 0.6180339887498949) % 1 < share
/* The words a title the `titles` parameter sets is padded with. */
const TITLE_WORDS = ' for the next release of the sensor board and its enclosure'
/** The title of task `n`, `titleLength` characters long where the
    parameter sets it. */
const titleOf = (n) => {
  const title = `Testbed ${n % 2 ? 'firmware signed' : 'signed firmware'} task ${n + 1}`
  if (titleLength === null) return title
  let long = title
  while (long.length < titleLength) long += TITLE_WORDS
  return long.slice(0, titleLength).trimEnd()
}
/** Task `n`, visible or not, in `project`, with every optional field a
    working task tends to have. */
const taskRow = (n, uid, project, parent) => {
  const status =
    doneShare === null
      ? STATUSES[n % STATUSES.length]
      : doneAt(n, doneShare)
        ? 'done'
        : OPEN_STATUSES[n % OPEN_STATUSES.length]
  const owner = profiles[n % peopleCount].id
  const reviewer = profiles[(n + 1) % peopleCount].id
  const length = Math.round(descriptionLength * (0.2 + 1.6 * random()))
  const row = {
    id: uid,
    org_id: org,
    project_id: project.id,
    num: n + 1,
    title: titleOf(n),
    description: length ? prose(length) : '',
    status,
    priority: ['urgent', 'high', 'medium', 'low'][n % 4],
    assignee_id: owner,
    reviewer_id: n % 3 ? reviewer : undefined,
    parent_id: parent,
    start_week: day(n % 21),
    end_week: day((n % 21) + 7),
    due_date: n % 5 ? undefined : day((n % 21) + 10),
    remaining_hours: 4 + (n % 9),
    remaining_set_at: now,
    paused: n % 23 === 22 && status !== 'done' && status !== 'backlog',
    created_by: owner,
    reporter_id: profiles[(n + 2) % peopleCount].id,
    done_at: status === 'done' ? now : undefined,
    review_at: status === 'review' || status === 'done' ? now : undefined,
    status_at: now,
    created_at: now,
    updated_at: now,
  }
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key]
  return row
}
/* The server's tasks: `count` visible ones, then the hidden projects' as
   many a project. Every 20th hidden task is a subtask of a visible parent,
   and every 20th visible plain task one of a hidden parent. */
const perProject = Math.max(1, Math.ceil(count / projects.length))
/** Task `n` of the varied workspace. Every 25th task is a parent of the
    three after it, every 7th has a due date (every other one past), every
    31st is paused unless it is in Backlog or Done, every 13th has an
    80-character title (TITLE_MAX, the longest the server keeps) and every
    11th has no owner. As the server keeps them, parents have no remaining
    hours and no task in Backlog or Done is paused. */
const variedTask = (n) => {
  const parent = n - (n % 25)
  const child = n % 25 > 0 && n % 25 <= 3
  const project = projects[Math.floor((child ? parent : n) / 10) % projects.length]
  const row = taskRow(n, id('4', n), project, child ? id('4', parent) : undefined)
  row.status = ['backlog', 'todo', 'progress', 'review', 'done'][n % 5]
  row.paused = n % 31 === 0 && !['backlog', 'done'].includes(row.status)
  if (row.status === 'done') row.done_at = now
  else delete row.done_at
  if (row.status === 'review' || row.status === 'done') row.review_at = now
  else delete row.review_at
  if (n % 25 === 0) {
    delete row.remaining_hours
    delete row.remaining_set_at
  }
  delete row.due_date
  if (n % 7 === 0) row.due_date = day((n / 7) % 2 ? -((n % 40) + 1) : (n % 40) + 1)
  if (n % 13 === 0)
    row.title =
      `${row.title} ${'with a longer description of the work it covers '.repeat(2)}`.slice(0, 80)
  if (n % 11 === 0) delete row.assignee_id
  return row
}
const tasks = Array.from({ length: count }, (_, n) =>
  varied
    ? variedTask(n)
    : taskRow(n, id('4', n), projects[Math.floor(n / 10) % projects.length], parentOf(n)),
)
const hiddenTasks = Array.from({ length: perProject * hiddenCount }, (_, h) =>
  taskRow(
    count + h,
    id('5', h),
    hidden.children[Math.floor(h / 10) % hiddenCount],
    h % 20 === 1 && count > 5 ? id('4', 5 + 10 * (h % Math.floor(count / 10 || 1))) : undefined,
  ),
)
if (hiddenTasks.length)
  for (const row of tasks)
    if (!row.parent_id && row.num % 20 === 13) row.parent_id = hiddenTasks[0].id
const shown = new Set(tasks.map((row) => row.id))
const allTasks = [...tasks, ...hiddenTasks]
// visible tasks with a hidden subtask (workingSetOf's hidden subtask parents)
const hiddenSubtaskParents = new Set(hiddenTasks.map((row) => row.parent_id).filter(Boolean))
/** The tasks with a subtask, among every live task (lib/liveTasks.ts
    countsAsSubtask; every project here is active). */
const parentsOf = () => new Set(allTasks.filter((row) => row.parent_id).map((row) => row.parent_id))
let parents = parentsOf()
/** Task `row` as the workspace sends it (convex/lib/workspaceParts.ts
    readTasks), and as forMe sent it to baseline builds. */
const wireTask = (row) => {
  const { parent_id: parent, ...rest } = row
  const out = parent && shown.has(parent) ? { ...rest, parent_id: parent } : rest
  out.has_hidden_parent = !!parent && !shown.has(parent)
  out.has_hidden_subtasks = hiddenSubtaskParents.has(row.id)
  return out
}
/** The load row the snapshot sends for task `row`, or null:
    convex/lib/loadRows.ts loadRowFor's fence for a staff reader, every owner in
    the organization, kept for tasks the reader is not shown only, as the
    tasks part sends them (the app derives the shown tasks' load from their
    rows), or
    for every task with shownload=1. */
const loadRow = (row) => {
  if (parents.has(row.id) || (!shownLoad && shown.has(row.id))) return null
  const owner = row.status === 'review' && row.reviewer_id ? row.reviewer_id : row.assignee_id
  if (owner === undefined || row.start_week === undefined || row.end_week === undefined) return null
  if (row.status === 'done' || row.paused || !((row.remaining_hours ?? 0) > 0)) return null
  return {
    issue_id: shown.has(row.id) ? row.id : null,
    owner_id: owner,
    start_week: row.start_week,
    end_week: row.end_week,
    remaining: row.remaining_hours,
    remaining_set_at: row.remaining_set_at ?? null,
  }
}
const wireRows = new Map(tasks.map((row) => [row.id, wireTask(row)]))
const loadRows = new Map(allTasks.map((row) => [row.id, loadRow(row)]))
// each label once a task, also where the stride of 5 meets a label again,
// as it does for every task with orglabels=1 or orglabels=5
const issueLabels = tasks.flatMap((row, n) =>
  [
    ...new Set(
      Array.from({ length: labelsPerTask }, (_, k) => labels[(n + k * 5) % labels.length].id),
    ),
  ].map((label_id) => ({ issue_id: row.id, label_id })),
)
/** Whether task `n` is among a `share` of the tasks, spread evenly. Each
    relation takes another `offset`, so they fall on different tasks. */
const picked = (n, share, offset) =>
  share > 0 && Math.floor((n + offset + 1) * share) > Math.floor((n + offset) * share)
const links = tasks.flatMap((row, n) => {
  if (!picked(n, linkShare, 1) || n + 3 >= count) return []
  const target = tasks[n + 3].id
  return [
    {
      id: id('a', n),
      source_id: row.id,
      target_id: target,
      type: n % 2 ? 'blocks' : 'relates',
      pair_key: [row.id, target].sort().join(':'),
      created_at: now,
    },
  ]
})
const attachments = tasks.flatMap((row, n) => {
  if (!picked(n, attachmentShare, 2)) return []
  return [
    {
      id: id('b', n),
      issue_id: row.id,
      name: `measurement-${n}.pdf`,
      size_bytes: 20_000 + n,
      mime: 'application/pdf',
      storage_id: storageId(n),
      inline: n % 3 === 0,
      uploaded_by: row.assignee_id,
      created_at: now,
    },
  ]
})
const issueSubs = tasks.flatMap((row, n) => {
  return picked(n, followShare, 3) ? [{ issue_id: row.id, profile_id: me.id, created_at: now }] : []
})
const snapshot = {
  auth_user_id: 'perf-account',
  myProfileIds: [me.id],
  orgs: [
    {
      id: org,
      name: 'Testbed Labs',
      slug: 'testbed',
      created_at: now,
      next_issue_num: count + hiddenTasks.length + 1,
      next_project_num: hiddenNum + hiddenCount + 1,
      // every task is active, and every program and its projects are live
      // but those archivedprojects archives
      active_tasks: count + hiddenTasks.length,
      live_projects: liveProgramCount * (subprojectCount + 1) + 1 + hiddenCount,
      date_format: 'iso',
      week_start: 1,
      week_one_rule: 'first4day',
      default_plannable_hours: 40,
      max_attachment_mb: 20,
    },
  ],
  profiles,
  projects: programs.flatMap((p) => [p.meta, ...p.children]),
  issues: [...wireRows.values()],
  teams,
  teamMembers,
  access,
  teamAccess: removalShares,
  links,
  milestones,
  labels,
  issueLabels,
  issueSubs,
  attachments,
  orgLoad: [],
  messages: [],
  readMessageCount: 0,
  unreadTruncated: false,
  readTruncated: false,
  delivered_at: now,
}
/* The Deleted items the page reads (`deleted`), built once from the
   workspace as it stands when first asked, with a second organization
   for deletedstate=two-orgs. */
let deletedItems = null
function deletedWorld() {
  if (deletedItems !== null) return deletedItems
  const partner = 'perf-partner-org'
  const seat = 'perf-partner-seat'
  const top = {
    ...snapshot.projects[0],
    id: 'perf-partner-top',
    org_id: partner,
    name: 'Partner launch',
    key: 'PL',
    parent_id: undefined,
    type: 'meta',
  }
  const two = deletedStates.has('two-orgs')
    ? {
        ...snapshot,
        orgs: [...snapshot.orgs, { ...snapshot.orgs[0], id: partner, name: 'Partner Co' }],
        myProfileIds: [...snapshot.myProfileIds, seat],
        profiles: [...snapshot.profiles, { ...me, id: seat, org_id: partner, org_role: 'user' }],
        projects: [
          ...snapshot.projects,
          top,
          {
            ...top,
            id: 'perf-partner-web',
            name: 'Partner web',
            key: 'PW',
            parent_id: top.id,
            type: 'project',
          },
        ],
      }
    : snapshot
  // the deleted sub-project comes with the tasks, none of either by default
  deletedItems = deletedFixtureOf(two, {
    tasks: deletedCount,
    at: now,
    projectItem: deletedCount > 0,
  })
  return deletedItems
}
/* How many cards the Board shows: every visible task but the parents,
   whose subtasks are their cards, and of those how many the first program
   holds, the Board the app opens, and its tasks, the rows of the phone's
   list. settleTasks keeps them. */
let cards = 0
let boardCards = 0
let boardRows = 0
const firstProgram = new Set(visible.children.map((p) => p.id))
/* Rebuilds the derived lists after a write: the task rows in creation
   order and the load rows. A write replaces the row objects it changes, so
   the rows it did not touch keep their cached JSON. */
function settleTasks() {
  parents = parentsOf()
  snapshot.issues = [...wireRows.values()]
  snapshot.orgLoad = [...loadRows.values()].filter((row) => row !== null)
  cards = tasks.filter((row) => !parents.has(row.id)).length
  const selected = tasks.filter((row) => firstProgram.has(row.project_id))
  boardRows = selected.length
  boardCards = selected.filter((row) => !parents.has(row.id)).length
}
settleTasks()

/* The visible tasks the workspace's parts and forMe leave out (`unheld`):
   the highest-numbered ones without a parent or subtasks, so no task the
   workspace holds names one as its parent or child. */
const unheld = new Set(
  tasks
    .filter((row) => !row.parent_id && !parents.has(row.id))
    .sort((a, b) => b.num - a.num)
    .slice(0, unheldCount)
    .map((row) => row.id),
)
/* The projects whose Settings page read them while
   projectsettings=unheld, which the workspace's parts then leave out. */
const settingsUnheld = new Set()
/** The workspace as its parts and forMe send it: without the unheld tasks
    and the rows hung on them, and without the projects a Settings page read
    under projectsettings=unheld, with their grants. */
function heldWorkspace() {
  if (unheld.size === 0 && settingsUnheld.size === 0) return snapshot
  const held = (row) => !unheld.has(row.issue_id)
  const shown = (row) => !settingsUnheld.has(row.project_id)
  return {
    ...snapshot,
    projects: snapshot.projects.filter((p) => !settingsUnheld.has(p.id)),
    access: snapshot.access.filter(shown),
    teamAccess: snapshot.teamAccess.filter(shown),
    issues: snapshot.issues.filter((row) => !unheld.has(row.id)),
    issueLabels: snapshot.issueLabels.filter(held),
    attachments: snapshot.attachments.filter(held),
    issueSubs: snapshot.issueSubs.filter(held),
    links: snapshot.links.filter(
      (link) => !unheld.has(link.source_id) && !unheld.has(link.target_id),
    ),
  }
}

/** The snapshot as forMe sends it: its long lists past 8,192 values in
    parts (convex/lib/arrayLimit.ts). */
function wireSnapshot() {
  const { auth_user_id, myProfileIds, orgs, messages, ...rest } = heldWorkspace()
  const { readMessageCount, unreadTruncated, readTruncated, delivered_at, ...lists } = rest
  return {
    auth_user_id,
    myProfileIds,
    orgs,
    ...chunkLists(lists),
    messages,
    readMessageCount,
    unreadTruncated,
    readTruncated,
    delivered_at,
  }
}

/* --- the wire ------------------------------------------------------------- */
const rowText = new WeakMap()
/** UTF-8 length of `text`. */
export const utf8 = (text) => {
  let bytes = text.length
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    // a surrogate pair is two units and four bytes, so the high one adds two
    if (code >= 0xd800 && code <= 0xdfff) bytes += code <= 0xdbff ? 2 : 0
    else if (code >= 0x800) bytes += 2
    else if (code >= 0x80) bytes += 1
  }
  return bytes
}
/** The JSON text of `value` and its bytes. Objects and lists hold rows
    serialized once each (rowText): a row a write changes is a new object. */
function encode(value) {
  if (Array.isArray(value)) {
    const parts = value.map(encode)
    return {
      text: `[${parts.map((part) => part.text).join(',')}]`,
      bytes: parts.reduce((sum, part) => sum + part.bytes, 1 + Math.max(0, parts.length - 1) + 1),
    }
  }
  if (value && typeof value === 'object') {
    let known = rowText.get(value)
    if (known) return known
    const flat = Object.values(value).every((inner) => inner === null || typeof inner !== 'object')
    if (flat) {
      const text = JSON.stringify(value)
      known = { text, bytes: utf8(text) }
      rowText.set(value, known)
      return known
    }
    const parts = Object.entries(value)
      .filter(([, inner]) => inner !== undefined)
      .map(([key, inner]) => {
        const name = JSON.stringify(key)
        const part = encode(inner)
        return { text: `${name}:${part.text}`, bytes: utf8(name) + 1 + part.bytes }
      })
    return {
      text: `{${parts.map((part) => part.text).join(',')}}`,
      bytes: parts.reduce((sum, part) => sum + part.bytes, 2 + Math.max(0, parts.length - 1)),
    }
  }
  const text = JSON.stringify(value ?? null)
  return { text, bytes: utf8(text) }
}
/** Waits as long as `bytes` take at `mbps`. */
const transfer = (bytes) => new Promise((resolve) => setTimeout(resolve, bytes / (mbps * 125)))
/* Results leave one at a time, in order, as on one socket. */
let lastDelivery = Promise.resolve()
/** Sends the value `result` answers when its turn comes, to `to` (a
    subscription or a query call), and resolves once it is sent. */
function deliver(to, result) {
  const sent = lastDelivery.then(async () => {
    let encoded
    try {
      const value = result()
      // a read that never answers (window=loading) sends nothing
      if (value === NO_ANSWER) return
      encoded = encode(value)
    } catch (error) {
      // a read the server cannot answer fails only its own caller, with a
      // refusal's data, as Convex sends a ConvexError's
      post({ type: 'result', to, error: String(error?.message ?? error), ...refusalOf(error) })
      return
    }
    await transfer(encoded.bytes)
    post({ type: 'result', to, ...encoded })
  })
  lastDelivery = sent
  return sent
}
/** Posts `message` to the page with the counters it mirrors. */
const post = (message) =>
  port.postMessage({
    ...message,
    writes,
    held: held.length,
    made: tasks.length,
    cards,
    boardCards,
    boardRows,
  })
let writes = 0
const listeners = new Map()
const delay = () => new Promise((resolve) => setTimeout(resolve, latency))
const comments = []
let messageCount = 0
/* The unread messages the `unread` parameter asks for at the start, one
   per task, a minute apart, each telling of a change. */
{
  const start = Date.now() - 60 * 60_000
  const unread = Math.min(option('unread', 0), count)
  snapshot.messages = Array.from({ length: unread }, (_, n) => ({
    id: id('6', messageCount++),
    org_id: org,
    recipient_id: me.id,
    issue_id: id('4', n),
    issue_title: `Testbed task ${n + 1}`,
    kind: 'change',
    actor_id: profiles[1].id,
    detail: 'Status changed',
    created_at: new Date(start + n * 60_000).toISOString(),
  }))
}
const roadmapCounts = new Map()
/* The windows of the workspace's parts, as the app chooses them from the
   counts (src/store/liveParts.ts), kept from the first read, so a window
   keeps its bounds while rows come and go. */
let windowsOf = null
/* The parts cut from the workspace as it is now, until the next change. */
let partsCache = null
/** The parts of the workspace as convex/workspace.ts answers them. */
function partsNow() {
  if (partsCache) return partsCache
  const [row] = snapshot.orgs
  const start = startWindows(row)
  windowsOf ??= {
    tasks: idWindows(start.tasks),
    people: idWindows(1),
    projects: idWindows(start.projects),
  }
  partsCache = splitWorkspace(heldWorkspace(), (_org, kind) => windowsOf[kind])[0]
  return partsCache
}
const PART_KINDS = {
  'workspace:tasks': 'tasks',
  'workspace:people': 'people',
  'workspace:projects': 'projects',
}
/** What workspace part `name` answers for `args`. */
function readPart(name, args) {
  const part = partsNow()
  if (name === 'workspace:root')
    return {
      auth_user_id: snapshot.auth_user_id,
      myProfileIds: snapshot.myProfileIds,
      orgs: snapshot.orgs,
      // when the login may create an organization, which the app reads as
      // 'now' when absent (convex/lib/workspaceParts.ts readRoot)
      ...(snapshot.create === undefined ? {} : { create: snapshot.create }),
    }
  if (name === 'workspace:catalog') return { state: 'ok', ...chunkLists(part.catalog) }
  if (name === 'workspace:inbox') return { state: 'ok', ...part.inbox }
  const kind = PART_KINDS[name]
  const at = windowsOf[kind].findIndex((w) => w.from === args.from)
  return { state: 'ok', ...chunkLists(part[kind][at]) }
}
/* -1, 0 or 1 as `a` sorts before, with or after `b` in code unit order. */
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
/* The reads of a task, by their organization and ref, that answered
   once, for window=failed, which fails every later answer of that read.
   Keyed by the read, not the task, so a task opened by its number reads
   it once by number and once by uuid, as the app does, and each answers
   first. */
const windowAnswered = new Set()
/** What a read answers when it never answers (window=loading): nothing is
    sent for it. */
const NO_ANSWER = Symbol('no answer')
/** The data of a refusal a read threw (a ConvexError's), for the page to
    throw again as one, or nothing for any other failure. */
const refusalOf = (error) =>
  error && typeof error === 'object' && error.data && typeof error.data === 'object'
    ? { data: error.data }
    : {}
/** The task `ref` names in organization `orgId` as convex/lib/taskWindow.ts
    taskByRef reads it: a uuid in any case, or a number bare or as QN-12 in
    that organization only. */
function taskByRef(byId, orgId, ref) {
  const named = typeof ref === 'string' ? parseIssueRef(ref) : null
  if (!named) return undefined
  if ('uuid' in named) {
    const task = byId.get(named.uuid)
    return task?.org_id === orgId ? task : undefined
  }
  return snapshot.issues.find((row) => row.org_id === orgId && row.num === named.num)
}
/** What the task window's query `name` answers for `args`, in the shapes
    of convex/lib/taskWindow.ts: the open task with its parent and its
    subtasks as short rows, its links with their other ends, or its
    attachment rows. The signed-in person is shown every visible task, the
    unheld ones too, so every list is complete unless window=incomplete
    says otherwise, and a task it does not hold answers unavailable. With
    window=failed, each read of the task, by its arguments, fails after its
    first answer, which a transition soon after brings; with window=error
    it fails from the first, and with window=loading it never answers. */
function readTaskWindow(name, args) {
  const byId = new Map(snapshot.issues.map((row) => [row.id, row]))
  if (name === 'taskWindow:task' && forcedWindow === 'loading') return NO_ANSWER
  if (name === 'taskWindow:task' && forcedWindow === 'error')
    throw new Error("the task window's read fails, as window=error asks")
  const task =
    name === 'taskWindow:task'
      ? taskByRef(byId, args.org_id ?? org, args.ref)
      : byId.get(args.issue_id)
  if (!task) return { state: 'unavailable' }
  if (name === 'taskWindow:task' && forcedWindow === 'failed') {
    const read = JSON.stringify([args.org_id ?? org, args.ref])
    if (windowAnswered.has(read))
      throw new Error("the task window's read fails, as window=failed asks")
    windowAnswered.add(read)
    setTimeout(() => void transition(), 2 * latency + 500)
  }
  // the person's grant on the visible program
  const level = access[0].level
  const short = (row) => {
    const {
      description: _text,
      parent_id: _parent,
      has_hidden_parent: _hiddenParent,
      has_hidden_subtasks: _hidden,
      ...rest
    } = row
    return { ...rest, has_subtasks: parents.has(row.id), level }
  }
  const byCreation = (a, b) => order(a.created_at, b.created_at) || order(a.id, b.id)
  if (name === 'taskWindow:task') {
    const kids = snapshot.issues
      .filter((row) => row.parent_id === task.id)
      .sort((a, b) => a.num - b.num || order(a.id, b.id))
    const parent = task.parent_id ? byId.get(task.parent_id) : undefined
    // a list that is not whole says it holds hidden subtasks, as the
    // server's does (convex/lib/taskWindow.ts windowTask)
    const incomplete = forcedWindow === 'incomplete'
    return {
      state: 'ok',
      task: {
        ...task,
        has_subtasks: parents.has(task.id),
        ...(incomplete ? { has_hidden_subtasks: true } : {}),
      },
      level,
      labels: snapshot.issueLabels.filter((row) => row.issue_id === task.id),
      follow:
        snapshot.issueSubs.find((row) => row.issue_id === task.id && row.profile_id === me.id) ??
        null,
      parent: parent ? short(parent) : null,
      subtasks: {
        rows: (incomplete ? kids.slice(0, Math.floor(kids.length / 2)) : kids).map(short),
        complete: !incomplete,
      },
    }
  }
  if (name === 'taskWindow:links') {
    const other = (link) => (link.source_id === task.id ? link.target_id : link.source_id)
    const links = snapshot.links
      .filter(
        (link) =>
          (link.source_id === task.id || link.target_id === task.id) && byId.has(other(link)),
      )
      .sort(byCreation)
    const ends = [...new Set(links.map(other))]
    return { state: 'ok', links, tasks: ends.map((id) => short(byId.get(id))), complete: true }
  }
  const rows = snapshot.attachments.filter((row) => row.issue_id === task.id).sort(byCreation)
  return {
    state: 'ok',
    rows,
    count: rows.filter((row) => row.dropped_at === undefined).length,
    complete: true,
  }
}
/* The rows of a page of main Search. */
const SEARCH_ROWS = 25
/**
 * A stand-in for main Search (convex/search.ts page): one page for `text`
 * over the visible tasks' numbers, titles and descriptions and the visible
 * projects' names, matched and scored with the server's own word rules
 * (convex/lib/searchTerms.ts), in the server's order: by score, then tasks
 * before projects, then the newest number. 25 rows a page, an opaque
 * cursor that holds the search and where the next page starts, and always
 * complete coverage. A narrower scope keeps the tasks and projects of its
 * project. It reads no access, budget or archive, holds no archived task,
 * and refuses a cursor of another search only as an error.
 */
function searchPage({ text, include_archived, scope, cursor }) {
  const terms = searchTerms(text)
  const key = JSON.stringify([text, include_archived, scope ?? null])
  let from = 0
  if (cursor !== undefined) {
    const [of, at] = JSON.parse(cursor)
    if (of !== key) throw new Error('cursor must be the next_cursor of an earlier page')
    from = at
  }
  const metas = new Map(programs.map((p) => [p.meta.id, p.meta]))
  /** The top-level project above `project`, as a result names it. */
  const parentOf = (project) => {
    const meta = metas.get(project.parent_id)
    return meta ? { id: meta.id, name: meta.name } : null
  }
  const inScope = (project) =>
    !scope?.project_id || project.id === scope.project_id || project.parent_id === scope.project_id
  const matches = []
  if (terms.length > 0) {
    for (const row of tasks) {
      const project = projects.find((p) => p.id === row.project_id)
      if (!project || !inScope(project)) continue
      const fields = { num: row.num, title: row.title, description: row.description ?? '' }
      if (!matchesTerms(terms, fields)) continue
      const group = parents.has(row.id)
      matches.push({
        score: scoreOf(terms, fields),
        kind: 0,
        num: row.num,
        row: {
          kind: 'task',
          org_id: org,
          id: row.id,
          num: row.num,
          title: row.title,
          status: group ? null : row.status,
          is_group: group,
          archived: false,
          project: { id: project.id, name: project.name },
          parent: parentOf(project),
        },
      })
    }
    for (const project of snapshot.projects) {
      const fields = { title: project.name, description: '' }
      if (!inScope(project) || !matchesTerms(terms, fields)) continue
      matches.push({
        score: scoreOf(terms, fields),
        kind: 1,
        num: project.num,
        row: {
          kind: 'project',
          org_id: org,
          id: project.id,
          name: project.name,
          parent: parentOf(project),
        },
      })
    }
  }
  matches.sort((a, b) => b.score - a.score || a.kind - b.kind || b.num - a.num)
  const next = from + SEARCH_ROWS < matches.length ? from + SEARCH_ROWS : null
  return {
    rows: matches.slice(from, from + SEARCH_ROWS).map((match) => match.row),
    next_cursor: next === null ? null : JSON.stringify([key, next]),
    coverage: { complete: true },
  }
}
/** The navigation reads' `force`, with the first two programs as the
    favorites projectnav=favorites asks for. */
const projectNavForce = () =>
  forcedProjectNav.favorites
    ? { ...forcedProjectNav, favorites: programs.slice(0, 2).map((p) => p.meta.id) }
    : { ...forcedProjectNav, favorites: [] }
const read = (name, args = {}) => {
  if (name.startsWith('workspace:')) return readPart(name, args)
  // the project picker's reads (src/store/projectNavStandIn.setup.ts)
  if (name.startsWith('projectNav:'))
    return projectNavStandIn(snapshot, name, args, { force: projectNavForce() })
  // Deleted items (src/store/deletedItemsStandIn.setup.ts)
  if (isDeletedRead(name)) return deletedStandIn(deletedWorld(), name, args, forcedDeleted)
  // Settings' project lists (src/store/projectSettingsListsStandIn.setup.ts)
  if (isProjectListRead(name))
    return projectListsStandIn(serverWorld(), name, { org_id: org, ...args }, forcedLists)
  if (name.startsWith('projectSettings:')) return readSettings(name, args)
  if (isTeamSettingsRead(name)) return readTeams(name, args)
  // Settings › Users and the creators line (src/store/peopleSettingsStandIn.setup.ts)
  if (isPeopleSettingsRead(name))
    return peopleSettingsStandIn(snapshot, name, { org_id: org, ...args }, forcedPeople, {
      keys: agentKeys,
    })
  // the milestone reads (src/store/milestoneStandIn.setup.ts), which answer
  // nothing where a forced state holds them back
  if (name.startsWith('milestones:')) {
    const answer = milestoneStandIn(
      snapshot,
      name.slice('milestones:'.length),
      args,
      forcedMilestones,
    )
    return answer === undefined ? NO_ANSWER : answer
  }
  // the relation pickers' read, before the task window's other reads
  if (name === 'taskWindow:relationCandidates')
    return relationPickerStandIn(
      snapshot,
      { ...args, org_id: args.org_id ?? org },
      {
        level: access[0].level,
        force: forcedRelations,
      },
    )
  if (name.startsWith('taskWindow:')) return readTaskWindow(name, args)
  // the Inbox's unread summary and the open task's item
  // (src/store/inboxStandIn.setup.ts), which answer nothing under
  // inbox=loading
  if (name === 'inbox:summary' || name === 'inbox:item') {
    const answer =
      name === 'inbox:summary'
        ? inboxSummaryStandIn(snapshot, forcedInbox)
        : inboxItemStandIn(
            snapshot,
            { org_id: args.org_id ?? org, issue_id: args.issue_id },
            forcedInbox,
          )
    return answer === INBOX_NO_ANSWER ? NO_ANSWER : answer
  }
  switch (name) {
    case 'snapshot:forMe':
      snapshot.delivered_at = new Date().toISOString()
      return wireSnapshot()
    case 'prefs:get': {
      // syncscope=program: the first program saved as Team sync's scope
      if (parameters.get('syncscope') !== 'program') return null
      const program = snapshot.projects.find((p) => p.type === 'meta')
      const scope = program ? `project:${program.id}` : ''
      return {
        profile_id: snapshot.myProfileIds[0],
        prefs: { syncScope: scope, teamSyncScope: scope },
        updated_at: new Date().toISOString(),
      }
    }
    case 'appearance:get':
      return { mode: appearance, image_source: 'none', custom_image: null }
    case 'appearance:dailyImage':
      return null
    case 'billing:status':
      return {
        enabled: false,
        writable: true,
        status: 'active',
        complimentary_until: null,
        current_period_end: null,
      }
    case 'snapshot:threadComments':
      return {
        comments: comments.filter((comment) => comment.issue_id === args.issue_id),
        earlier: false,
      }
    case 'snapshot:threadHistory':
      return { events: [], earlier: false, next: null }
    case 'teamSync:lastComments':
      return { rows: [], complete: true }
    case 'teamSync:agenda':
      return syncAgenda(args)
    case 'admin:isOperator':
      return false
    case 'search:page':
      return searchPage(args)
    case 'tasks:board':
      return boardStandIn(snapshot, args, { force: forcedBoard })
    // the Roadmap's reads (src/store/roadmapStandIn.setup.ts)
    case 'tasks:roadmap':
      if (roadmapFails) throw new Error("the Roadmap's read fails, as roadmap=error asks")
      return roadmapStandIn(snapshot, args, { force: forcedRoadmap })
    case 'tasks:roadmapDependencies':
      return dependenciesStandIn(snapshot, args, {
        force: forcedRoadmap,
        canEdit: () => !viewer,
      })
    case 'labels:settingsPage': {
      const { uncounted, ...force } = forcedLabels
      return labelSettingsStandIn(snapshot, args, {
        force: uncounted
          ? {
              ...force,
              counts: Object.fromEntries(
                snapshot.labels.filter((_, n) => n % 3 === 0).map((l) => [l.id, null]),
              ),
            }
          : force,
      })
    }
    case 'overview:summary':
    case 'overview:risk':
    case 'overview:attention':
    case 'overview:paused':
    case 'overview:health':
      if (name === 'overview:health' && forcedOverview.healthError)
        throw new Error('the health table fails, as overview=health-error asks')
      return overviewStandIn(snapshot, name.slice('overview:'.length), args, {
        force:
          forcedOverview.unknown === 'everyone'
            ? { ...forcedOverview, unknown: snapshot.profiles.map((p) => p.id) }
            : forcedOverview,
      })
    // the owner loads the delays of tasks only the Board's answer brings
    // read (src/store/ownerLoadsStandIn.setup.ts)
    case 'planning:ownerLoads':
      // loads=loading never answers
      if (forcedLoads === 'loading') return NO_ANSWER
      return ownerLoadsStandIn(snapshot, args, {
        unavailable: forcedLoads === 'unavailable' ? args.owner_ids : [],
      })
    // the removal window's reads (src/store/removalStandIn.setup.ts)
    case 'accessRemovals:preview':
      return removalPreviewStandIn(snapshot, args.change, forcedRemoval, args.reassign_to)
    case 'accessRemovals:reassignChoices':
      return reassignChoicesStandIn(snapshot, args, forcedRemoval)
    case 'messages:bulkReach':
      // as convex/model/messages.ts readBulkReach does, per seat
      return {
        seats: snapshot.orgs.map((org) => {
          const mine = snapshot.messages.filter((m) => m.org_id === org.id)
          const unread = mine.filter((m) => !m.read_at)
          const walked = mine.filter(
            (m) => !m.snoozed_until && !!m.read_at === (args.action === 'remove'),
          )
          const reach = walked.length === 0 ? 'none' : walked.length > INBOX_BATCH ? 'many' : 'one'
          return args.action === 'remove'
            ? { org_id: org.id, reach }
            : {
                org_id: org.id,
                reach,
                before: Math.max(0, ...unread.map((m) => Date.parse(m.created_at))),
              }
        }),
      }
    default:
      throw new Error(`Unimplemented benchmark query: ${name}`)
  }
}
/** What a project's Settings page read `name` answers for `args`, through
    the stand-in over the whole workspace, so a project the parts leave
    out still answers (projectsettings=unheld). */
function readSettings(name, args) {
  if (name === 'projectSettings:get' && settingsStates.has('loading')) return NO_ANSWER
  if (
    name === 'projectSettings:get' &&
    settingsStates.has('unheld') &&
    !settingsUnheld.has(args.id)
  ) {
    // the parts leave the project out from the next transition on
    settingsUnheld.add(args.id)
    setTimeout(() => void emitWorkspace(), 0)
  }
  return projectSettingsStandIn(serverWorld(), name, { org_id: org, ...args }, forcedSettings)
}
/** What a team settings read `name` answers for `args`, through the
    stand-in over the workspace, with every third team uncounted under
    teamsettings=uncounted. */
function readTeams(name, args) {
  const { uncounted, ...force } = forcedTeams
  const counts = uncounted
    ? Object.fromEntries(snapshot.teams.filter((_, n) => n % 3 === 0).map((t) => [t.id, null]))
    : undefined
  return teamSettingsStandIn(
    snapshot,
    name,
    { org_id: org, ...args },
    counts ? { ...force, counts } : force,
  )
}
/** The projects the server holds: the workspace's, and for an admin the
    hidden program too, which an admin manages though the workspace leaves
    it out, so Settings' project lists list it and its page answers. */
function serverWorld() {
  return admin
    ? { ...snapshot, projects: [...snapshot.projects, hidden.meta, ...hidden.children] }
    : snapshot
}
/** Delivers query `name`'s new result to its listeners, and resolves once
    it reached them. */
function emit(name) {
  return Promise.all([...(listeners.get(name) || [])].map((subscription) => subscription.send()))
}

/* The watched parts by id, each with its query, args and the JSON it last
   sent, and the parts watched since the last transition. */
const watchedParts = new Map()
/* Whether a timer will answer the parts watched since it was set. */
let watchPending = false
/* The transition waiting for its turn, which takes every part that changed
   by the time it is sent. */
let nextTransition = null
/** Sends one transition with every watched part whose JSON changed, those
    `fresh` first answered among them, when its turn comes. Resolves once
    it is sent. */
function transition() {
  nextTransition ??= lastDelivery.then(async () => {
    nextTransition = null
    const results = []
    let bytes = 0
    for (const [to, part] of watchedParts) {
      let encoded
      try {
        const value = read(part.name, part.args)
        // a read that never answers (window=loading) sends nothing
        if (value === NO_ANSWER) continue
        encoded = encode(value)
      } catch (error) {
        results.push({ to, error: String(error?.message ?? error), ...refusalOf(error) })
        continue
      }
      if (encoded.text === part.sent) continue
      part.sent = encoded.text
      results.push({ to, ...encoded })
      bytes += encoded.bytes
    }
    await transfer(bytes)
    post({ type: 'transition', at: Date.now(), results })
  })
  lastDelivery = nextTransition
  return nextTransition
}
/** Sends the workspace's changes: to an app before the parts its one
    query, else the parts that changed. */
function emitWorkspace() {
  partsCache = null
  return Promise.all([emit('snapshot:forMe'), watchedParts.size ? transition() : null])
}
/* The server's prune of one inbox item after a read (convex/model/messages.ts
   pruneStampedItem): it keeps the newest unread row or, with none, the
   newest read row, and deletes the other read rows. */
function pruneItem(issueId) {
  const rows = snapshot.messages.filter((m) => m.issue_id === issueId)
  const newer = (a, b) =>
    b.created_at > a.created_at || (b.created_at === a.created_at && b.id > a.id) ? b : a
  const unread = rows.filter((m) => !m.read_at)
  const keep = unread.length ? unread.reduce(newer) : rows.reduce(newer)
  snapshot.messages = snapshot.messages.filter(
    (m) => m.issue_id !== issueId || !m.read_at || m === keep,
  )
}
/* Marks the messages in `marked` read at `at`, as new rows. */
function markRead(marked, at) {
  const ids = new Set(marked.map((m) => m.id))
  snapshot.messages = snapshot.messages.map((m) => (ids.has(m.id) ? { ...m, read_at: at } : m))
}
/* Counts the read rows and delivers the inbox's new state. */
function settleInbox() {
  snapshot.readMessageCount = snapshot.messages.filter((m) => m.read_at).length
  return emitWorkspace()
}
/* Writes the scenarios hold until they release them, in order. */
const held = []
let holding = false
/** Changes task `taskId` by `patch`, as a new row, and answers whether
    anything changed. */
function patchTask(taskId, patch) {
  const at = tasks.findIndex((issue) => issue.id === taskId)
  if (at < 0) throw new Error('Unknown benchmark task')
  const old = tasks[at]
  const changed = Object.entries(patch).some(([field, value]) => (old[field] ?? null) !== value)
  if (!changed) return false
  const row = { ...old }
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete row[field]
    else row[field] = value
  }
  row.updated_at = new Date().toISOString()
  if ('remaining_hours' in patch) {
    if (row.remaining_hours === undefined) delete row.remaining_set_at
    else row.remaining_set_at = row.updated_at
  }
  tasks[at] = row
  allTasks[allTasks.indexOf(old)] = row
  wireRows.set(row.id, wireTask(row))
  loadRows.set(row.id, loadRow(row))
  settleTasks()
  return true
}
/* The subscriptions by id, each with its query and args. */
const subscriptions = new Map()

/** Team sync's agenda for `args` from the workspace (the stand-in), with
    the forced states of the `sync` parameter. */
function syncAgenda(args) {
  if (forcedSync.has('error')) throw new Error("Team sync's agenda fails, as sync=error asks")
  // sync=stale: the meeting stops fitting while it is open, which the app,
  // watching the agenda as a view read, hears in the next transition
  if (forcedSync.has('stale') && syncAskedAt === null)
    setTimeout(() => {
      syncTurned = true
      void transition()
    }, SYNC_STALE_MS)
  syncAskedAt ??= Date.now()
  const turned =
    forcedSync.has('stale') && (syncTurned || Date.now() - syncAskedAt >= SYNC_STALE_MS)
  const state = ['over_ceiling', 'over_budget', 'unavailable', 'access_unchecked'].find((s) =>
    forcedSync.has(s),
  )
  const force = {
    ...(turned ? { state: 'over_ceiling' } : state ? { state } : {}),
    ...(forcedSync.has('delays-unknown') ? { delays: 'unknown' } : {}),
    ...(forcedSync.has('weeks-unknown') ? { weeks: 'loads' } : {}),
    ...(syncCeiling === undefined ? {} : { ceiling: syncCeiling }),
  }
  // as an organization Viewer's agenda reads it, whatever the role
  const workspace = forcedSync.has('viewer')
    ? {
        ...snapshot,
        profiles: snapshot.profiles.map((p) =>
          snapshot.myProfileIds.includes(p.id) ? { ...p, org_role: 'viewer' } : p,
        ),
      }
    : snapshot
  return teamSyncStandIn(workspace, args, { force })
}

/** Runs mutation `name` with `args` and answers its result. */
async function mutate(name, args) {
  if (name === 'identity:claimMySeats' || name === 'prefs:save') return null
  // a restore or Delete now answers from the stand-in, after its reads
  if (name === 'deletedItems:restore' || name === 'deletedItems:purge') {
    if (forcedDeleted.slow) await new Promise((resolve) => setTimeout(resolve, forcedDeleted.slow))
    const write = name === 'deletedItems:restore' ? deletedRestore : deletedPurge
    const answer = write(deletedWorld(), args, forcedDeleted)
    writes++
    await Promise.all(DELETED_READS.map((read) => emit(read)))
    return answer
  }
  if (name === 'messages:markRead') {
    const ids = new Set(args.ids)
    const at = new Date().toISOString()
    const marked = snapshot.messages.filter((m) => ids.has(m.id) && !m.read_at)
    markRead(marked, at)
    for (const issue of new Set(marked.map((m) => m.issue_id))) pruneItem(issue)
    await settleInbox()
    return null
  }
  if (name === 'messages:readItem') {
    // as convex/messages.ts readItem does, it marks the unread messages of
    // the caller's item stored up to `through` read, then prunes. The rows
    // held here carry no _creationTime, so their created_at stands for it,
    // as the stand-in's `through` takes it
    const at = new Date().toISOString()
    const through = args.through ?? Number.POSITIVE_INFINITY
    const marked = snapshot.messages.filter(
      (m) =>
        m.issue_id === args.issue_id &&
        m.org_id === args.org_id &&
        !m.read_at &&
        Date.parse(m.created_at) <= through,
    )
    markRead(marked, at)
    if (marked.length) {
      pruneItem(args.issue_id)
      await settleInbox()
    }
    writes++
    return null
  }
  if (name === 'messages:markAllRead') {
    // as convex/model/messages.ts markAllMessagesRead does: at most
    // INBOX_BATCH unsnoozed unread rows a batch, created no later than the
    // first batch's cutoff, the newest unread row's creation, then the prune
    const unread = snapshot.messages.filter(
      (m) => !m.read_at && !m.snoozed_until && m.org_id === args.org_id,
    )
    const before = args.before ?? Math.max(0, ...unread.map((m) => Date.parse(m.created_at)))
    const due = unread.filter((m) => Date.parse(m.created_at) <= before)
    const batch = due.slice(0, INBOX_BATCH)
    const at = new Date().toISOString()
    markRead(batch, at)
    for (const issue of new Set(batch.map((m) => m.issue_id))) pruneItem(issue)
    if (batch.length) await settleInbox()
    writes++
    const ids = batch.map((m) => m.id)
    return { marked: ids.length, ids, hasMore: due.length > batch.length, before }
  }
  if (name === 'issues:update') {
    if (patchTask(args.id, args.patch)) await emitWorkspace()
    writes++
    return null
  }
  // the writes the task window sends from its own answer besides an edit
  if (name === 'labels:toggle') {
    const has = snapshot.issueLabels.some(
      (row) => row.issue_id === args.issue_id && row.label_id === args.label_id,
    )
    if (has !== args.on) {
      snapshot.issueLabels = args.on
        ? [...snapshot.issueLabels, { issue_id: args.issue_id, label_id: args.label_id }]
        : snapshot.issueLabels.filter(
            (row) => !(row.issue_id === args.issue_id && row.label_id === args.label_id),
          )
      await emitWorkspace()
    }
    writes++
    return null
  }
  if (name === 'issues:subscribe' || name === 'issues:unsubscribe') {
    const on = name === 'issues:subscribe'
    const mine = (row) => row.issue_id === args.issue_id && row.profile_id === me.id
    if (snapshot.issueSubs.some(mine) !== on) {
      snapshot.issueSubs = on
        ? [
            ...snapshot.issueSubs,
            { issue_id: args.issue_id, profile_id: me.id, created_at: new Date().toISOString() },
          ]
        : snapshot.issueSubs.filter((row) => !mine(row))
      await emitWorkspace()
    }
    writes++
    return null
  }
  // a project's Settings page writes, applied as the server stores them
  if (name === 'projects:update') {
    const at = snapshot.projects.findIndex((p) => p.id === args.id)
    if (at < 0) throw new Error('Unknown benchmark project')
    const row = { ...snapshot.projects[at] }
    for (const [field, value] of Object.entries(args.patch)) {
      if (value === null) delete row[field]
      else row[field] = value
    }
    const lead = args.patch.lead_id
    if (lead && lead !== snapshot.projects[at].lead_id) {
      // the outgoing lead keeps User, the incoming one's own grant goes
      const was = snapshot.projects[at].lead_id
      snapshot.access = [
        ...snapshot.access.filter((a) => a.project_id !== args.id || a.profile_id !== lead),
        ...(was ? [{ project_id: args.id, profile_id: was, level: 'user' }] : []),
      ]
    }
    snapshot.projects = snapshot.projects.map((p, n) => (n === at ? row : p))
    await emitWorkspace()
    writes++
    return null
  }
  if (name === 'projects:setAccess' || name === 'projects:removeAccess') {
    const team = args.team_id !== undefined
    const list = team ? 'teamAccess' : 'access'
    const holder = team ? 'team_id' : 'profile_id'
    const who = team ? args.team_id : args.user_id
    const others = snapshot[list].filter((a) => a.project_id !== args.id || a[holder] !== who)
    snapshot[list] =
      name === 'projects:removeAccess'
        ? others
        : [...others, { project_id: args.id, [holder]: who, level: args.level }]
    await emitWorkspace()
    writes++
    return null
  }
  // New project and New sub-project, stored as the server stores them
  if (name === 'projects:create') {
    const parent = args.parent_id ?? undefined
    const unseen = parent !== undefined && parent === hidden.meta.id
    const siblings = [...snapshot.projects, hidden.meta, ...hidden.children].filter((p) =>
      parent === undefined
        ? p.type === 'meta' && p.parent_id === undefined
        : p.type === 'project' && p.parent_id === parent,
    )
    const [orgRow] = snapshot.orgs
    const num = orgRow.next_project_num
    const row = {
      id: args.id,
      org_id: args.org_id,
      type: args.type,
      ...(parent === undefined ? {} : { parent_id: parent }),
      key: args.key,
      num,
      name: args.name,
      lead_id: args.lead_id ?? me.id,
      description: args.description ?? '',
      // one past the largest place (convex/model/projects.ts nextSiblingPlace)
      sort_order:
        args.sort_order ?? siblings.reduce((place, p) => Math.max(place, p.sort_order + 1), 0),
      track_delay: args.track_delay ?? true,
      created_at: new Date().toISOString(),
    }
    snapshot.orgs = [{ ...orgRow, next_project_num: num + 1 }]
    if (unseen) hidden.children.push(row)
    else {
      snapshot.projects = [...snapshot.projects, row]
      const grants = new Map(
        Object.entries(args.access ?? {}).filter(([, level]) => level && level !== 'lead'),
      )
      // the creator's own grant on a top-level project, as the server gives
      // it (convex/model/projects.ts createProjectCore): User for a creator
      // who is not an admin and names someone else as lead, unless the
      // request names their own entry, a level or null for none
      if (row.type === 'meta') {
        const own = args.access?.[me.id]
        const mine = creatorGrant({
          admin: me.org_role === 'admin',
          creator: me.id,
          lead: row.lead_id,
          own: own === 'lead' ? undefined : own,
        })
        if (mine === null) grants.delete(me.id)
        else grants.set(me.id, mine)
      }
      snapshot.access = [
        ...snapshot.access,
        ...[...grants].map(([profile_id, level]) => ({ project_id: row.id, profile_id, level })),
      ]
      snapshot.teamAccess = [
        ...snapshot.teamAccess,
        ...Object.entries(args.team_access ?? {}).map(([team_id, level]) => ({
          project_id: row.id,
          team_id,
          level,
        })),
      ]
    }
    await emitWorkspace()
    writes++
    return { id: row.id, num, key: row.key }
  }
  if (name === 'projects:inviteGuest') {
    const seat = snapshot.profiles.find((p) => p.email === args.email.trim().toLowerCase())
    if (!seat) throw new Error('the benchmark invites only seats it holds')
    snapshot.access = [
      ...snapshot.access.filter(
        (a) => a.project_id !== args.project_id || a.profile_id !== seat.id,
      ),
      { project_id: args.project_id, profile_id: seat.id, level: args.level },
    ]
    await emitWorkspace()
    writes++
    return { id: seat.id, emailed: false }
  }
  if (name === 'teamSync:stamp') {
    // a Team sync card's change stamps the page owner (convex/teamSync.ts
    // stamp), which the workspace's profile and the agenda then carry
    const at = new Date().toISOString()
    snapshot.profiles = snapshot.profiles.map((profile) => {
      if (profile.id !== args.profile_id) return profile
      const prev =
        profile.sync_at === undefined ? null : { at: profile.sync_at, since: profile.sync_since }
      const { at: sync_at, since: sync_since } = nextSyncStamp(prev, at, args.first_since)
      return { ...profile, sync_at, sync_since }
    })
    await emitWorkspace()
    writes++
    return null
  }
  if (name === 'roadmap:change') {
    // Only dates change here, so no task becomes or stops being a group.
    let changed = false
    for (const operation of args.operations) {
      if (operation.kind !== 'task')
        throw new Error(`Unimplemented benchmark roadmap operation: ${operation.kind}`)
      changed = patchTask(operation.id, operation.patch) || changed
    }
    const count = (roadmapCounts.get(args.session_id) || 0) + Number(changed)
    roadmapCounts.set(args.session_id, count)
    if (changed) await emitWorkspace()
    writes++
    return { count }
  }
  throw new Error(`Unimplemented benchmark mutation: ${name}`)
}

/* What the benchmark asks the server to do, each answering once its
   results are sent. */
/* The ids of the tasks deliverCreate made, oldest first. */
const created = []
const scenarios = {
  /* Delivers `n` new unread messages for the signed-in person, one per task,
     for the bulk-read scenario. */
  seedMessages(n) {
    const created = new Date().toISOString()
    for (let i = 0; i < n; i++) scenarios.addMessage(i % count, created)
    return emitWorkspace()
  },
  /* Adds one unread message about task `n`, created at `created`. */
  addMessage(n, created = new Date().toISOString()) {
    snapshot.messages = [
      ...snapshot.messages,
      {
        id: id('6', messageCount++),
        org_id: org,
        recipient_id: me.id,
        issue_id: id('4', n),
        issue_title: `Testbed task ${n + 1}`,
        kind: 'change',
        actor_id: profiles[1].id,
        detail: 'Status changed',
        created_at: created,
      },
    ]
  },
  /* Another person renames task `n`, which every listener receives. */
  /* Another person moves task `n` to `status`, for checks by hand. */
  moveRemote(n, status) {
    patchTask(tasks[n].id, { status })
    return emitWorkspace()
  },
  deliverRemote(n) {
    patchTask(tasks[n].id, { title: `Renamed elsewhere ${Date.now()}` })
    return emitWorkspace()
  },
  /* Another person creates a task in the first project. */
  deliverCreate() {
    const n = tasks.length + hiddenTasks.length
    const row = taskRow(n, id('4', 900000 + n), projects[0], undefined)
    created.push(row.id)
    tasks.push(row)
    allTasks.push(row)
    shown.add(row.id)
    wireRows.set(row.id, wireTask(row))
    loadRows.set(row.id, loadRow(row))
    const [org] = snapshot.orgs
    snapshot.orgs = [
      { ...org, next_issue_num: org.next_issue_num + 1, active_tasks: org.active_tasks + 1 },
    ]
    settleTasks()
    return emitWorkspace()
  },
  /* That person deletes the task deliverCreate made last, so the
     top-level project the app opens holds the tasks it held before. At
     whole thousands the create takes that project past the Roadmap's
     1,000 tasks, the design size, where the Roadmap shows its ceiling
     note instead of rows. */
  deliverDelete() {
    const gone = created.pop()
    if (gone === undefined) return null
    tasks.splice(
      tasks.findIndex((row) => row.id === gone),
      1,
    )
    allTasks.splice(
      allTasks.findIndex((row) => row.id === gone),
      1,
    )
    shown.delete(gone)
    wireRows.delete(gone)
    loadRows.delete(gone)
    const [org] = snapshot.orgs
    snapshot.orgs = [{ ...org, active_tasks: org.active_tasks - 1 }]
    settleTasks()
    return emitWorkspace()
  },
  /* Another person renames the first project. */
  deliverProjectRename() {
    snapshot.projects = snapshot.projects.map((project) =>
      project.id === projects[0].id
        ? { ...project, name: `Renamed project ${Date.now()}` }
        : project,
    )
    return emitWorkspace()
  },
  /* One new message for the signed-in person arrives. */
  deliverMessage() {
    scenarios.addMessage(4)
    return emitWorkspace()
  },
  /* A Team sync sitting stamps another person (convex/teamSync.ts stamp). */
  deliverStamp() {
    const at = new Date().toISOString()
    snapshot.profiles = snapshot.profiles.map((profile, n) =>
      n === 2 ? { ...profile, sync_at: at, sync_since: profile.sync_at ?? day(-7) } : profile,
    )
    return emitWorkspace()
  },
  deliverComments() {
    const active = [
      ...(listeners.get('snapshot:threadComments') || []),
      ...[...watchedParts.values()].filter((part) => part.name === 'snapshot:threadComments'),
    ]
    if (active.length !== 1) throw new Error('Benchmark requires one open comment thread')
    const body = `Benchmark delivered comment ${comments.length + 1}`
    comments.push({
      id: id('5', 800000 + comments.length),
      issue_id: active[0].args.issue_id,
      author: profiles[1].id,
      body,
      created_at: new Date().toISOString(),
    })
    void emit('snapshot:threadComments')
    if (watchedParts.size) void transition()
    return body
  },
}

/* The answer of the write before, which the next one waits for. */
let lastAnswer = Promise.resolve()

/** Runs write `data` and answers it once `turn`, the answer of the write
    before it, is sent. */
async function write(data, turn) {
  if (holding && data.name !== 'identity:claimMySeats' && data.name !== 'prefs:save') {
    const refused = await new Promise((resolve) => {
      held.push(resolve)
      post({ type: 'state' })
    })
    if (refused) {
      await turn
      post({
        type: 'answer',
        id: data.id,
        error: { code: 'forbidden', message: 'no write access' },
      })
      return
    }
  }
  try {
    const result = mutate(data.name, data.args)
    // as Convex answers a write once the results that hold it are in: the
    // ones it queued and those before it, which a write that changed
    // nothing waits for too, but not those of later writes
    const barrier = lastDelivery
    const value = await result
    await turn
    await barrier
    post({ type: 'answer', id: data.id, value })
  } catch (error) {
    await turn
    // a Deleted items refusal comes with its data, as Convex sends a
    // ConvexError's, so the app words it as the server's
    const refusal = data.name.startsWith('deletedItems:') ? refusalOf(error).data : undefined
    post(
      refusal
        ? { type: 'answer', id: data.id, error: refusal }
        : { type: 'answer', id: data.id, failure: String(error?.message ?? error) },
    )
  }
}

port.onmessage = async ({ data }) => {
  switch (data.type) {
    case 'subscribe': {
      const { id: sub, name, args } = data
      let next = null
      const subscription = {
        args,
        send() {
          next ??= deliver(sub, () => {
            next = null
            return read(name, args)
          })
          return next
        },
      }
      subscriptions.set(sub, { name, subscription })
      const group = listeners.get(name) || new Set()
      listeners.set(name, group)
      group.add(subscription)
      setTimeout(() => {
        if (subscriptions.has(sub)) void subscription.send()
      }, latency)
      return
    }
    case 'watch': {
      watchedParts.set(data.id, { name: data.name, args: data.args, sent: null })
      // the parts watched in one task are answered in one transition
      if (!watchPending) {
        watchPending = true
        setTimeout(() => {
          watchPending = false
          void transition()
        }, latency)
      }
      return
    }
    case 'unwatch':
      watchedParts.delete(data.id)
      return
    case 'unsubscribe': {
      const entry = subscriptions.get(data.id)
      subscriptions.delete(data.id)
      listeners.get(entry?.name)?.delete(entry?.subscription)
      return
    }
    case 'query':
      await delay()
      // removal=slow holds the removal window's reads for two seconds
      if (forcedRemoval.has('slow') && data.name.startsWith('accessRemovals:'))
        await new Promise((resolve) => setTimeout(resolve, 2000))
      await deliver(data.id, () => read(data.name, data.args))
      return
    case 'mutation': {
      // writes are answered in the order they came, as Convex answers them
      const turn = lastAnswer
      let answered = () => {}
      lastAnswer = new Promise((resolve) => {
        answered = resolve
      })
      try {
        await delay()
        await write(data, turn)
      } finally {
        answered()
      }
      return
    }
    case 'scenario':
      try {
        post({ type: 'answer', id: data.id, value: await scenarios[data.name](...data.args) })
      } catch (error) {
        post({ type: 'answer', id: data.id, failure: String(error?.message ?? error) })
      }
      return
    case 'hold':
      holding = true
      return
    case 'releaseOne':
      held.shift()?.(data.refuse)
      post({ type: 'state' })
      return
    case 'releaseAll':
      holding = false
      while (held.length) held.shift()(false)
      post({ type: 'state' })
      return
  }
}
