## Plan on roadmap

**Plan on roadmap** opens the timeline and highlights the task. Unscheduled
tasks receive a starter bar. A Backlog task must first move to another status;
trying to plan it leaves its dates unchanged. Done tasks can still be planned.

The planning panel offers:

- **Auto-fit end to workload**, on by default for tasks without subtasks, with
  an owner and positive Remaining hours. After each drag, Qivo computes the end
  from the owner's free weekly capacity, starting no earlier than the estimate
  measurement week. It uses the reviewer while a task is In Review with one
  and follows ownership changes during the session.
- The owner's committed hours by project, excluding paused work. Hidden
  projects appear as anonymous **Other projects** hours where your role allows
  it ([Delay projections](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works)). The free-hours summary uses that person's plannable week.
- **Confirm** to keep the dates or **Cancel** to restore the original dates,
  including an unscheduled state.

Agents have no weekly capacity limit. Auto-fit ends in the start or measurement
week, whichever is later, and shows **No weekly capacity limit for auto-fit**.
If workload data is unavailable, auto-fit pauses.

## The Team strip

**Team utilization** sits below the Roadmap on the same weekly grid. People
and agents appear alphabetically. Each person's cells show their scheduled
load as a percentage of their own plannable hours, with **0%** for empty weeks.
Their weekly capacity appears beside their name. New people start with the
organization default, initially 32 hours ([Planning hours](./organization-and-team-settings.md#planning-hours-and-teams)).

Blue shows ordinary load, yellow marks **90–100%**, and red marks **over 100%**.
**100%** fills that person's planning time, which already excludes time
reserved for meetings and other overhead. Accessible cell descriptions include
the underlying hours and capacity, such as **16 / 30 h**.

A task counts toward its owner's load. In Review tasks with reviewers count
toward the reviewer. **Paused** tasks contribute no hours but give their
planned weeks a dashed border. Resuming restores their hours. Agent rows show
hours only, with no percentage or over-capacity warning.

**All projects / This project** chooses which visible projects contribute
hours. The toggle is absent in All projects and My view. Use the three layout
buttons to expand Team, show it with the Roadmap, or collapse it. Expanded
Team keeps the timeline's dates, milestones and window controls.

Click a person or weekly cell to highlight their tasks. Hover or keyboard-focus
a cell to highlight its person and week. Clicking locks the week highlight;
click another week to move it. Click the selected person's name again, press
**Esc**, or click outside Team to clear the selection and week lock.

Roadmap filter controls let you keep the selection while adjusting filters.
If a filter hides the person, their highlights disappear. Changing scope,
date window or layout clears the week lock.

Qivo spreads each task's remaining hours evenly from its measurement week,
or planned start if later, through its planned end. An estimate saved after
the planned end counts in the save week. These figures update while you drag
bars; there is no separate allocation to enter.

## Team sync

**Team sync** reviews open work one person at a time. Update estimates,
status and owners, check delays, and see what each person finished since their
last sync. Changes save on the tasks. Use task comments for meeting notes.

Open **Team sync** in the sidebar or **Sync** in the phone's bottom navigation.
The page belongs to your current organization. Its scope and each step have
shareable addresses. Browser Back leaves the page; it does not step through
the meeting. Escape does not close the page. Task windows open over it.

Rows update live as participants make changes. On a phone, **Sync** or a plain
`…/sync` link opens your own page if you own work in scope. A link naming a
step opens that step; a scoped link without a step opens the team summary.

**Scope.** Your selection is saved with your account:

- **All projects** includes visible projects in your organization, excluding
  projects shared from another organization.
- **A team** includes projects shared with that team and only its members.
- **A project** includes the project and its sub-projects. A link can also
  select one sub-project.

A deleted or inaccessible team or project falls back to All projects.

The people list starts with the team summary, then people by name, then agents.
It includes owners of To Do, In Progress or In Review tasks without subtasks.
The owner is the assignee, or the reviewer for In Review tasks with one.
Inactive people remain listed while they own open work. Backlog tasks are
excluded from people's pages.

**The team summary** shows overdue, projected-to-miss, slipping, blocked and
paused tasks, plus upcoming milestones. Projected misses and slipping counts
include only projects with delay tracking. It also lists people at **90% or
more** capacity this week and milestones for this week and next.

Two lists help complete assignments:

- **Needs an owner** includes unassigned To Do, In Progress or In Review
  tasks that are Urgent or High priority, or planned to start this week or
  earlier. It also includes unassigned tasks due within two weeks or overdue,
  including Backlog but excluding Done. Tasks with subtasks are excluded.
  Use **Assign** to choose an eligible owner.
- **Needs a reviewer** includes In Review tasks without a reviewer, longest
  waiting first. Use **Reviewer** to assign one.

Assigning someone removes the task from the list and places open work on the
new owner's page. Task titles open the task window.

**A person's page** shows this week's load across the organization, regardless
of sync scope. For organization admins and users, this includes hidden-project
hours and can exceed the Team strip's visible-project total. Organization
viewers see load from visible projects and tasks they own.

The page has three columns, which stack on phones:

- **Done since** lists tasks without subtasks completed since the person's last
  sync, newest first. It includes their own tasks and tasks they reviewed
  from In Review to Done, marked **reviewed**. Being named reviewer without
  that status transition does not give review credit.
- **On it** lists In Progress, then In Review. Reviews appear under the
  reviewer, marked with the assignee's name. Tasks awaiting an unnamed
  reviewer stay with the assignee and show **no reviewer**. **Waiting on
  review** lists the person's tasks held by other reviewers, longest waiting
  first. These rows are read-only apart from the **@** comment action and
  do not count toward the reviewed total.
- **Next** lists To Do tasks planned to start this week or earlier, or
  unplanned and due by this week's end. **Later**, closed by default, holds
  the remaining To Do tasks.

Within groups, tasks without estimates come first, then planned tasks by
start week, then due date, then task number. Undated tasks come last for each
date sort.

Rows show the title, task ID, sub-project, plan and due date, with delay or
pause marks when applicable. They also flag **no estimate**, **no reviewer**
and visible unfinished blockers.

Time marks use the person's last sync. **untouched since** means an In Progress
task has had no change, activity or comment. Review rows show **handed to you**
for a new hand-off, or **waiting since** for an older untouched one. Entering
In Review or changing the reviewer starts a hand-off; changing Remaining does
not. Other rows can show the latest status change or comment.

Older reviews with no recorded hand-off show no hand-off age and sort last in
Waiting on review and Needs a reviewer. Time marks appear after the task's
latest comment loads.

Use the row controls to change tasks without opening them:

- **Remaining** saves on Enter or leaving the field. Changing steps or
  leaving the page also saves the focused field and refreshes the projection.
- **Status** includes all five statuses and **Pause / Resume**. Done moves
  the task to Done since; Backlog removes it from the review. Entering In
  Review applies review time ([Review time](./will-it-be-ready-in-time-the-delay-status.md#review-time)) and transfers ownership to a named reviewer.
  If none is assigned, the reviewer picker opens; you can dismiss it without
  choosing. Leaving In Review returns ownership to the assignee.
- **Owner** changes the assignee, or the reviewer for an In Review task with
  one. Choose an active person with User or Lead access. The task moves to
  their page and workload figures update.
- **@** posts a comment mentioning an active person who can see the task.
  Pick someone, write a note and press **Send** or Ctrl/Cmd+Enter. It starts
  with the assignee selected on a reviewer's row, or the reviewer on a
  Waiting on review row. The recipient gets an Inbox notification ([Your inbox](./working-together.md#your-inbox)).
- **Board / Roadmap** opens the task there. Board opens its task window;
  Roadmap finds its bar or unplanned row without starting a planning session.
- The **review tick** marks the task reviewed without changing it.

Board and Roadmap links use All projects for an all-project sync, or the
task's sub-project otherwise. The links beside a person's name filter to that
person, using the selected project when applicable. Other filters clear so
tasks remain visible; Focus stays unchanged.

Read-only projects disable edits and mentions. On phones, Back closes an open
menu or picker before leaving Team sync.

**Review progress.** Row changes also mark a task reviewed. The footer counts
reviewed rows across people and agents, excluding Done since and Waiting on
review. A portrait gets a checkmark when all its rows are reviewed. Use
**Previous**, **Next** or the people list to navigate. The last **Done** button
returns to where you opened Team sync. Review ticks last only while it is open.

**Agents** share a final page. Each summary shows this week's scheduled hours,
current and next tasks, and delay counts. Expand an agent for the same task
columns and controls. Selecting an agent in the people list expands it.

**Last sync.** Each person has one shared sync time per organization. Changing
Remaining, status, pause, owner or a mention from their page updates it for
that person, regardless of who makes the change. Review ticks and assignments
from the team summary do not update it.

The time reference for Done since and other marks follows these rules:

- Before a person's first sync, it is the start of the previous working day.
  Working days are the five days from the organization's week start ([Organization settings](./organization-and-team-settings.md)).
  With Monday-start weeks, Monday and weekends refer to Friday; Tuesday
  refers to Monday. The first sync keeps this reference even past midnight.
- Changes less than six hours apart belong to the same sync. Its time
  reference stays fixed during the meeting on every participant's screen.
- After six hours without a change to that person, the next sync refers to
  their previous sync's final change.

**Last sync** in the header shows the latest completed sync. It stays absent
until the person has completed one.

Use the Roadmap to reschedule tasks. Team sync has no dragging or auto-fit.
