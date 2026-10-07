The Roadmap shows scheduled tasks as bars on a weekly timeline. In a project,
tasks sit under their sub-projects. **All projects** and **My view** group them
by project, then sub-project. Undated tasks appear below the scheduled tasks
with an **unplanned** marker and their due date, if set. Click one to schedule it.

Project and sub-project headings show their unfinished tasks' total remaining
hours and stay visible while you scroll their rows. Use a heading's arrow to
collapse it. The double chevron in the **Task** header collapses or expands
all groups, including groups inside collapsed projects. Filters hide groups
with no matching tasks; clearing a filter restores their previous collapsed state.

**Backlog tasks are hidden**, even when scheduled. **Done tasks appear only
when their planned period overlaps the visible window**, including its first
and last weeks. Undated Done tasks are hidden. To Do, In Progress and In Review
tasks outside the window remain available through edge badges or unplanned
rows. Filters cannot bring hidden Backlog or Done tasks back. These rules also
apply to the phone's landscape timeline and **Task schedule**, which uses the
current roadmap window.

## A window you control

The starting range is two weeks before today through six weeks after today.
Use the controls on the timeline to change it:

- The arrows before and after the week header move the view by 20% of its span.
- The calendar button in the **Task** header offers a month, two months, a
  quarter, half a year or a year. **Custom range…** lets you set each end
  separately as **Relative weeks**, which move with today, or an **Exact date**.
- **Save this as my default** saves the current range for your account. The
  Roadmap opens on it, and **Default window** or the reset button returns to it.
  The reset button appears only when the view differs from your default.
- At your saved default, **Forget my default** restores the standard range.

Arrow badges at either edge describe tasks whose planned periods extend
beyond the window. A badge joined to a bar means the task continues beyond
that edge. A detached badge means the whole task lies outside the window.
It is filled for an adjacent week and outlined when at least one full week
separates the task from the window.

Hover or keyboard-focus a badge to read its endpoint week. Click it to bring
that endpoint into view without changing the number of visible weeks.
**Ended W37** describes the plan, not whether the task is Done. Connected and
adjacent badges match the bar's color. More distant badges stay neutral unless
delay tracking marks them yellow or red ([Delay status](./will-it-be-ready-in-time-the-delay-status.md)).

## Weeks that match *your* calendar

Week numbers and first-workday dates follow your organization's calendar
settings ([Organization settings](./organization-and-team-settings.md)). Month boundaries have solid gridlines; other weeks use dashed
lines. Narrow columns shorten the labels.

Plans use whole weeks. Bars snap to weeks, while due-date markers retain
exact dates.

## Scheduling by hand

With edit access, drag a bar to move it or drag either edge to resize it.
Release to save. Click a bar or task name to open its details. Read-only bars
open but cannot move or resize.

Click the portrait beside a task to change or clear its assignee. For a task
**In Review** with a reviewer, the portrait and picker show the reviewer instead.

Bars fill the whole planned period; their length does not show completion.
**Done bars are green**, including groups whose descendant work is all Done.
Other bars are blue unless delay tracking marks unfinished work yellow or red
([Delay status](./will-it-be-ready-in-time-the-delay-status.md)). A **paused** task keeps its color and gains diagonal lines, including on
its connected and adjacent edge badges.

A scheduled parent's dates must cover its active scheduled subtasks. Qivo
widens the parent when needed, including changes through the API. Unscheduled
parents stay unscheduled.

Milestones appear as violet diamonds. Drag one to move it or click it to open
the Milestones window ([Overview milestones](./the-overview-project-health-at-a-glance.md)). The toolbar's **Milestone** button creates one.
Hover a truncated milestone name to read it in full.

## Undo this Roadmap visit's changes

**Undo** reverses your latest planning change, then earlier changes from the
same Roadmap visit. Changes save immediately, including restored values.
One Auto-move action counts as one undo step for all the tasks it moves.

History includes task dates, parent dates widened by a subtask, milestone
additions, edits and deletions, and Remaining edits in **Estimates**.
Restoring an estimate also restores its measurement time. Display preferences,
filters and the visible date window are unaffected.

Changing projects or filters within Roadmap keeps history. On a phone,
switching between the agenda and timeline also keeps it; Undo sits below
**Timeline & team**. Opening a task to read it keeps history, but saving a
change there or changing an owner through a roadmap portrait clears history
and stops recording until you leave Roadmap and return.

Leaving Roadmap or reloading clears history without reverting saved changes.
History expires after 24 hours and holds up to 1,000 steps per visit. If an
intervening change conflicts with an undo, Qivo refuses the entire restoration
and clears history until your next visit.

## Dependencies you can see and safely fix

**Blocks** links appear as finish-to-start arrows. Green means the blocker
ends before the blocked task starts. Red means it ends in or after the blocked
task's start week. Arrows update while you drag.

**Auto-move** shifts blocked tasks to start after their blockers, including
chains of dependent tasks. It moves parent and child tasks together. Cycles
remain unresolved with red arrows, so you must remove or change those links.

## Estimates. Refresh the numbers before you plan

Open **Estimates** to update Remaining hours one person at a time. The window
includes all visible projects, regardless of the Roadmap's current project.
It lists To Do, In Progress and In Review tasks with an owner, including tasks
with no estimate. The owner is the assignee, or the reviewer while a task is
In Review with one ([Task ownership](./how-work-is-organized.md#the-task)). Groups with subtasks and tasks without owners are
excluded.

Rows show project, status, plan or due date, and Remaining. Scheduled tasks
sort by start week, followed by unscheduled tasks by due date. Rows do not
open the task window.

Edit Remaining and press Enter or leave the field to save. Closing also saves
the focused field. Each save refreshes the task's measurement time for delay
projections ([Delay projections](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works)) and clears its stale mark. Workload figures and heading totals
update from the saved estimate.

Editing or pressing a row's review tick marks it reviewed. The footer counts
reviewed tasks, and a person gets a checkmark when all their rows are reviewed.
Use **Previous**, **Next** or a portrait to change people. The last button is
**Done**. Checkmarks last only while this window is open.

**Team sync** ([Team sync](./planning-against-real-capacity.md#team-sync)) adds status and owner changes, delay warnings, completed
work and a team summary.
