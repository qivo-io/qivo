The Roadmap shows scheduled tasks as bars on a weekly timeline, for one
project, one sub-project or **My view**. In a project, tasks sit under their
sub-projects. **My view** groups your own tasks by project, then sub-project.
An address that once named all projects opens as the Roadmap's own address
does ([All projects](./finding-your-way-around.md#all-projects)). Undated tasks appear below the scheduled tasks
with an **unplanned** marker and their due date, if set. Click one to open it
and set its plan. Tasks with subtasks take their dates from them instead.

Project and sub-project headings show their unfinished tasks' total remaining
hours and stay visible while you scroll their rows. While Qivo is still
counting those hours, a heading reads **Counting…**, and where it could not
count them within its limits, a muted **unknown**. Neither means zero hours. Use a heading's arrow to
collapse it. The double chevron in the **Task** header collapses or expands
all groups, including groups inside collapsed projects. Filters hide groups
with no matching tasks; clearing a filter restores their previous collapsed state.

**Backlog tasks are hidden**, even when scheduled. **Done tasks are hidden**
too while **Hide Done in Roadmap** is on (below). With it off, **Done tasks
appear only when their planned period overlaps the visible window**, including
its first and last weeks. Undated Done tasks are hidden. To Do, In Progress
and In Review tasks outside the window remain available through edge badges
or unplanned rows. Filters cannot bring hidden Backlog or Done tasks back. A task with
subtasks follows its subtasks instead of its own hidden status: it is never
hidden as Backlog, and it counts as Done only when all its subtask work is
Done. These rules also apply to the phone's landscape timeline and **Task
schedule**, which uses the current roadmap window.

**Hide Done in Roadmap**, under **Settings → Your preferences → Appearance**,
is on until you turn it off. While it is on, Done tasks take no row, so they
take no space between your unfinished work. That includes a task with
subtasks once all its subtask work is Done, and a Done subtask under an
unfinished parent. Project and sub-project headings stay, with their
unfinished tasks' remaining hours. Dependency arrows to and from a hidden task
are not drawn. **Team utilization** still counts the people who own the hidden
tasks, so it shows the same figures with the setting on and off. Where every
task the Roadmap would show is Done, it says **Done tasks are hidden** and
where to turn the setting off, with **Clear filters** while a filter is on.
**Plan on roadmap** or **Show on roadmap** for a hidden Done task says so
instead of showing it, and the Roadmap keeps its window where it was. A Team
sync jump to a task that has become Done since its row was drawn says so
too, where the Roadmap can tell that the task is Done. A planning session ends when its task becomes Done. The setting follows your account across
organizations and devices, and applies in every project, in My view and on the
phone.

The Roadmap shows at most 1,000 tasks at a time, counting each task with
subtasks and each subtask, across the project or sub-project with its filters
and window, or My view. Done tasks that Hide Done in Roadmap hides count
too. A selection past that, or one Qivo could not read within the Roadmap's
limits, shows no tasks and says so instead of showing part of it. Choose one of the sub-projects it offers or narrow your filters,
such as Priority or the text filter. A shorter window rarely helps, as
unfinished tasks show whatever their dates and only Done tasks follow the
window ([Limits](./limits.md)). When you move the window or type more of the
text filter, the Roadmap keeps its timeline until the new answer arrives;
another filter shows **Loading tasks…** until its tasks arrive.

## A window you control

The starting range is two weeks before today through six weeks after today.
Use the controls on the timeline to change it:

- The arrows before and after the week header move the view by 20% of its span.
- The calendar button in the **Task** header offers a month, two months, a
  quarter, half a year or a year. **Custom range…** lets you set each end
  separately as **Relative weeks**, which move with today, or an **Exact date**.
  The Roadmap shows at most 260 weeks, about five years. **Custom range…**
  refuses a wider range and says so. A range that grows wider later, such as
  an exact start with a relative end as the weeks pass, shows its first 260
  weeks, and the header says **First 260 of N weeks**.
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
adjacent badges match the bar where it meets the window's edge: gray for
planned time before the current week, otherwise the bar's color. More distant
badges are outlined, neutral unless delay tracking marks them yellow or red
([Delay status](./will-it-be-ready-in-time-the-delay-status.md)). Badges
count planned weeks only. A run-on or projected finish (below) that reaches
past the window is cut at its edge.

## Weeks that match *your* calendar

Week numbers and first-workday dates follow your organization's calendar
settings ([Organization settings](./organization-and-team-settings.md)). Month boundaries have solid gridlines; other weeks use dashed
lines. Narrow columns shorten the labels.

Plans use whole weeks. Bars snap to weeks, while due-date markers retain
exact dates.

The one-milestone-a-week rule counts each project's weeks in the calendar of
the organization that owns the project. If you work as a guest in another
organization whose weeks start on another day than your own, the Roadmap
still shows your organization's weeks. A week that looks free there can then
hold one of the project's milestones in its owner's calendar, and Qivo
refuses a milestone moved into it, naming that week in the owner's dates.

## Scheduling by hand

With edit access, drag a bar to move it or drag either edge to resize it.
Release to save. Click a bar or task name to open its details. Read-only bars
and the bars of tasks with subtasks open but cannot move or resize.

Click the portrait beside a task to change or clear its assignee. Its list
shows the people who can take the task, 25 at a time with a search and
**Load more**, as the task window's **Assignee** does
([The details column](./the-task-window.md#the-details-column)). For a task
**In Review** with a reviewer, the portrait and picker show the reviewer instead.

Bars fill the whole planned period; their length does not show completion.
The part of an unfinished task's bar before the today line is a quiet gray.
From the today line on, a bar has the color of its status on the Board: To Do
a stronger gray, In Progress blue and In Review violet. A task with subtasks
has no status of its own, so its bar is In Progress blue once one of its
subtasks has started, and To Do gray before. Where the project tracks delay,
a **Behind plan** task is yellow and a **Late** task red from the today line
on, whatever its status ([Delay status](./will-it-be-ready-in-time-the-delay-status.md)). The hover
text names the status and the delay. A bar is gray with a dashed outline, and its hover
text says **Delay unknown**, when Qivo could not read its owner's workload to
judge it.

An unfinished task whose plan ended before the current week runs on from its
planned end to the end of the current week, in its yellow or red. Where the
project does not track delay, the run-on is a faint dashed stretch in the
status color. The run-on is not part of the plan: it follows the bar, a drag
on it moves nothing, and the plan still ends where the gray ends.

**Projected delay** in the toolbar draws diagonal stripes in the same yellow
or red from the end of a Behind plan or Late bar, or its run-on, to the end of
the task's projected finish week, which the hover text names
([How the projection works](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works)).
It is on by default. Switching it off hides the stripes and the projected
finish week in the hover text, and nothing else, for your account, in every
project, in My view and on the phone's landscape timeline.

With Hide Done in Roadmap off, **Done bars are dim gray**, including groups
whose descendant work is all Done. A finished bar in the past never has a
run-on, which tells it apart from unfinished work. A **paused** task's planned bar keeps its color under diagonal
lines and, where it is wide enough, shows a pause sign at its start. A run-on
and stripes after it have no lines. Its connected and adjacent edge badges get
the lines too.

A task with subtasks takes its dates from them. Its bar runs from the
earliest start to the latest end of its active scheduled subtasks, at any
depth and in any status. To change the bar, move its subtasks.
A task with subtasks but none scheduled shows as unplanned. While you drag a
subtask, its parent's bar follows it.

Milestones appear as violet diamonds. In a project or sub-project they sit in
the header under the week numbers, and each one's dashed line runs down
through every row. In My view each milestone sits on its own project's row
with its name, and its dashed line runs through that project's rows only, so
two projects' milestones of the same week sit on their two rows. Drag one to
move it or click it to open the Milestones window, which reads that milestone
from the server as an Overview row does ([Overview milestones](./the-overview-project-health-at-a-glance.md)). In a project, the toolbar's **Milestone** button creates one.
A diamond of a project Qivo is still loading can be opened but not dragged
until it loads, and a Viewer's never moves.
A project has at most one milestone a week, so a diamond dropped on a week
that already has one of the project's milestones goes back, and Qivo names
the milestone there.
Each name stays on one line and runs from its diamond to the next milestone
in its row, or to the left near the end of the timeline. In the header,
milestones of the same week, or close together, take rows of their own, and the header grows
when one week holds more than two milestones or the names need more room, as
far as the screen leaves room for your tasks. Where a name is still cut short,
hover the milestone or move to it with Tab to read it in full, and press Enter
to open it. When one week holds more milestones than the header shows, scroll
the milestone rows to reach the others. Beside the rows, **+N more** says how
many milestones are out of sight above or below them. A project's row in My
view holds two rows of milestones and cuts names short where they meet.
The Roadmap loads the milestones of the weeks it shows, and moving or
resizing the window loads those of the new weeks; meanwhile the milestones of
the weeks both windows share stay. A line under the toolbar says when the
milestones are still loading, could not load (**Retry** loads them again),
are not all shown because the window held more than Qivo reads at once (it
says from which day, and that a shorter window, or in My view opening a
project, can help), or belong to more projects than the app reads at once
([Limits](./limits.md)). Unlike for tasks, a shorter window reads fewer
milestones. On a phone, the Roadmap's agenda lists milestones as the
Overview does ([Overview
milestones](./the-overview-project-health-at-a-glance.md)), not by the
timeline's weeks.
When a scope has nothing to schedule, for example a project without
sub-projects or My view with nothing assigned to you, the Roadmap says why.
In a project or sub-project, and in My view, the timeline stays behind that
note with its window controls, and in a project with the milestones of its
window. My view with no project shows only its note.

## Undo this Roadmap visit's changes

**Undo** reverses your latest planning change, then earlier changes from the
same Roadmap visit. Changes save immediately, including restored values.
One Auto-move action counts as one undo step for all the tasks it moves.

History includes task dates and milestone additions, edits and deletions.
Display preferences, filters and the visible date window are unaffected.

Changing projects or filters within Roadmap keeps history. On a phone,
switching between the agenda and timeline also keeps it; Undo sits below
**Timeline & team**, beside **Auto-move**. Opening a task to read it keeps
history, but saving a change there or changing an owner through a roadmap
portrait clears history and stops recording until you leave Roadmap and
return.

Leaving Roadmap or reloading clears history without reverting saved changes.
History expires after 24 hours and holds up to 1,000 steps per visit. If an
intervening change conflicts with an undo, Qivo refuses the entire restoration
and clears history until your next visit. A milestone that took a week since
the change you undo counts as such a change, when the undo would bring a
milestone of the same project back into that week.
Followers of the tasks a change or an undo touches get the update in their
inbox a few seconds after it saves. A change that touches too many tasks to
save in one go is refused, and nothing changes. An undo that large is refused
the same way, and history stays.

## Dependencies you can see and safely fix

**Blocks** links appear as finish-to-start arrows between two bars on the
timeline. A gray arrow means the blocker ends before the blocked task starts.
A red arrow means it ends in or after the blocked task's start week, and the
blocked task's bar gets a red ring. Arrows update while
you drag. A task you have just scheduled shows its arrows once its dates are
saved. When Qivo cannot read the selection's links within the Roadmap's
limits, no arrow shows, and a line above the timeline says why. A link to or
from a Done task that Hide Done in Roadmap hides has no arrow.

**Auto-move** shifts blocked tasks to start after their blockers, including
chains of dependent tasks. It works on the tasks linked to this Roadmap's
tasks, here or in other projects, and leaves chains with no task on this
Roadmap alone. It moves a task with subtasks by moving its
subtasks. It never moves Done or Backlog tasks, or tasks you cannot edit,
though they still count as blockers. A conflict stays red when fixing it
would mean moving one of them. Cycles remain unresolved with red arrows, so you must remove or change
those links. When the selection's dependency chains are too long to read at
once, Auto-move is unavailable and says so, and the arrows still show. It
also waits until your changes, on the Roadmap or elsewhere, are saved.
Auto-move saves its moves as one undo step, so while this visit's undo
history is cleared it is unavailable too: leave Roadmap and return to use
it again. It says how many tasks it moved once they are saved, and if the
save is refused it says why and no task moves.

## Refresh remaining hours before you plan

Workload figures and delay projections use each task's Remaining hours. Update
them in the task window's details ([The task window](./the-task-window.md#the-details-column)), or one person at a time in
**Team sync** ([Team sync](./planning-against-real-capacity.md#team-sync)). Team sync lists your own
organization's projects, so if you only have guest access, or the project is
shared from another organization, use the task window. Each saved Remaining
starts a new measurement for delay projections ([Delay projections](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works)).
