Overview comes first in the view switch of every project, sub-project and
My view. It shows what is left to do and what needs attention, and leaves
out what is finished. A project or sub-project's Overview covers everyone's
work there, and My view's covers your own work across your projects
([My view's Overview](#my-views-overview)). It describes current signals,
not a guarantee that deadlines are safe. An
address that once named all projects opens as the Overview's own address
does ([All projects](./finding-your-way-around.md#all-projects)).

## A project or sub-project

The top row states the problem in one sentence, such as "2 tasks are
overdue, 3 more are projected to miss their due date, and 1 is blocked.",
the same sentence Team sync opens with
([Team sync](./planning-against-real-capacity.md#team-sync)). Where nothing
needs attention it says so and how many tasks are left. Beside it are
**Tasks left**, the tasks that are not Done, **Hours left**, their
remaining hours, and the project's **Lead**, or for a sub-project without
a lead of its own its project's, marked "from" that project. Grouping
parents do not add to the task counts. No count, bar or percentage of
finished tasks appears on the page.

Qivo works out every figure on the server, so Overview shows them without
waiting for your browser to load every task. Until the server's answer
arrives the figures show **…**. While Qivo is still counting an
organization's tasks, as right after an update or for a moment after any
project is archived or restored, Tasks left and Hours left read
**Counting…**. A figure Qivo could not work out in one request shows **—**
or **unknown** with a line that says why, never a smaller number or zero
([Limits](./limits.md)).

## Needs attention

**Needs attention** lists every task that needs someone, each once, with
tabs that narrow it to one kind. Each tab shows how many tasks have that
kind:

- **Overdue**: not Done and due before today.
- **Projected to miss**: due today or later, in a sub-project with
  [delay tracking](./will-it-be-ready-in-time-the-delay-status.md), and
  projected to finish after its due week.
- **Behind plan**: with delay tracking, projected to finish after its
  planned end.
- **Blocked**: a To Do, In Progress or In Review task with a blocker you
  can see that is not Done, as Team sync counts it.
- **No reviewer**: In Review with no reviewer.
- **Paused**: on hold.

A sub-project without delay tracking has no Projected to miss or Behind
plan, also when its tasks are past their due date, and a project none of
whose sub-projects tracks delay shows neither tab.

The list is in one order. Overdue tasks come first, the most days overdue
first. Then tasks projected to miss their due date, the furthest past it
first, then those behind plan, the furthest behind first. Then blocked
tasks and paused ones, earliest due date first and those without a due
date last, with tasks without a reviewer between them, the longest waiting
first. Tasks of one kind and date go by task number. A task with several
kinds sits under the first of them and names the others, such as
"blocked by 1 task" or "no reviewer for 5 days". A task that blocks
another one in the list names it, such as "blocks Bring up the first
revision B board". On the right each row says its fact, such as
"4d overdue" over its due date, or "finishes W49" over the week it was
due or planned to end, and shows its owner's portrait: the reviewer while
it waits In Review with one, else the assignee.

Select a row to open its task. A row under the pointer, or with keyboard
focus in it, offers **Reassign**, which changes the owner the portrait
shows, and **Move due date**; on a touch screen they always show as icons.
They use the task window's own controls and rules, and are not there for a
task you may only view. Move due date's calendar takes keyboard focus on
the due date, or today for a task without one; the arrow keys move
between days and **Esc** closes it. After a change the row moves to its
new place, or leaves the list when the task no longer needs attention.
When a row with keyboard focus leaves the list, focus goes to the next
remaining row, then to the one before it if there is no next row, or to the
list's heading if neither remains. These changes have no undo; change
the field back the same way. The list shows its first 20 tasks, and
**Load more** adds 20 more, up to 1,000.

The projected delays depend on the other work of each task's owner. Where
Qivo could not work that out, as when an owner has more open work than it
reads at once, **All**, **Projected to miss** and **Behind plan** show a
dash for an unknown count, never zero, a line says that those tabs may
leave tasks out, and the rows Qivo could judge still show. Such a tab
without rows says that Qivo found none among the tasks it could check,
never that there are none. A guest or organization Viewer sees other
people's work one person at a time, so those counts are usually unknown
for them ([Who sees what](./who-sees-what-the-access-model.md)).

## Sub-projects, load and milestones

A project's **Sub-projects** lists each sub-project with its lead, its
tasks and hours left, and its **Late**, **Behind plan** and **Paused**
counts, each in a place of its own, Late first and then by name. **Late**
counts its overdue and projected-to-miss tasks where delay tracking is on.
Where Qivo could not work out Late and Behind plan, the row says
**unknown** and the list is in name order with a line that says why. It
shows 10 sub-projects, and **Load more** adds 10; where that fails,
**Retry** asks again and the rows already shown stay. Past 200 the list
says how many of how many it shows. Select a row to open that
sub-project's Board. A sub-project's own Overview has no such list.

**Load this week** lists the owners of the open tasks here, with each
person's planned hours this week across every project you can see, as a
line and a percentage of their week, and how many tasks of Needs attention
are theirs. The figure is the one the Roadmap's Team utilization shows for
the week ([Team utilization](./planning-against-real-capacity.md)), so it
counts no work in projects you cannot see. Highest load first; an agent
shows hours only. A person whose load Qivo could not read shows
**unknown**. It shows 8 people, and **Show all** the rest.

**Milestones** lists upcoming milestones with a line under each, such as
"2 late tasks are due before it". Each milestone has one cut-off day, the
first day of its week as the project's organization starts its weeks,
and that day is the same for every reader. The line under the first
milestone shown counts the tasks here whose verdict is **Late** and
whose due date is on or before its cut-off day. The line under each
later milestone counts only those due after the cut-off day of the
milestone shown above it, such as "1 more late task is due before it".
Which milestones are upcoming follows your own weeks. If you work as a
guest in another organization whose weeks start on another day than your
own, its list can start one milestone earlier or later for you than for
its own people, and a line can then count from another milestone above
it, or from none, and give another number. Where Qivo could not work out
every projected delay the line says it could not count them. A project
without delay tracking shows no such line.

## My view's Overview

My view's Overview shows your own work that is left, across every project
you take part in, by the rule My view's Board uses: tasks assigned to you,
and tasks In Review with you as their reviewer
([My view](./finding-your-way-around.md#my-view)). No count, bar or
percentage of finished tasks appears on the page.

**Your work** lists your tasks without subtasks in three groups, each with
how many tasks it holds:

- **In progress**: your In Progress tasks, and your In Review tasks that
  wait for a reviewer, marked **No reviewer**.
- **Waiting on your review**: In Review tasks with you as their reviewer,
  each saying who it is from.
- **Next**: your To Do tasks.

Backlog tasks are not listed, and count in Tasks left and Hours left. A
task with subtasks is no row of its own. Its subtasks are, each naming it,
such as "part of Bring up the first board".

In progress and Waiting on your review put the most urgent task first, in
the order of [Needs attention](#needs-attention): overdue, then projected
to miss, behind plan, blocked, no reviewer and paused. The other tasks
follow, in In progress by due date with undated tasks last, and in Waiting
on your review the longest waiting first. Next goes by planned start, with
planned tasks first and the earliest start first, then by due date with
undated tasks last. Tasks of one date go by task number. Each group shows
its first 10 tasks, and **Load more** adds 10, up to 1,000.

A row shows a flag where its task is overdue, projected to miss, behind
plan, blocked, waiting for a reviewer or paused, with the names and marks
of Needs attention, and otherwise the task's status. Then come its title,
its project and sub-project, and what applies of its fact, such as
"finishes W50, planned W48", its due date, when it starts and who it is
from. Where its sub-project tracks delay and Qivo could not work out its
delay, the row says **Delay unknown**, never that it is on track, and a
line above the groups says so. Every row has its hours left and its
actions in the same place, whatever its title, its group or its actions.

- The task's remaining hours are a field, followed by "left". Type and
  press Enter, or leave the field, to save them by the rules of the task
  window's **Remaining**. An empty field clears them, 0 is a value, and a
  comma works as the decimal point, as in 1,5. The field's border is
  dashed while they save. Hours you save meanwhile are saved after
  them, also when you leave the Overview first, and what you type after
  them stays in the field until you save it too.
  Text that is not a number saves nothing, and the row asks for a
  number. **Esc** puts the saved hours back, except while they save. Where
  a save fails, the row says so and the field keeps what you typed, also
  while the list updates and when the task moves to another group. If
  someone else saved the task's remaining hours after you began typing,
  Qivo does not save yours and says so
  ([When someone else changed it first](./working-together.md#when-someone-else-changed-it-first)).
  What you typed stays in the field, and saving it again replaces their
  value.
- In progress rows have the **Status** control, with every status and
  **Pause** or **Resume**.
- Waiting on your review rows have **Send back**, which moves the task to
  In Progress and so back to its assignee, and **Approve**, which moves it
  to Done.
- Next rows have **Start**, which moves the task to In Progress.

These are the task window's own status changes, with its rules. A row's
actions dim while its change saves, and take no other change until it
answers. A task you may only view shows its hours and no action. After a change the row moves
to its new group, or leaves Your work once the task is no longer yours or
no longer open. Keyboard focus stays on a row that moves, in its hours
field where it was there, and when a row with focus leaves, focus goes to
the next row, then to the one before it, then to the group's heading, and
to Your work itself when no task is left in it. When nothing is assigned
to you any more, focus goes to the note that says so. Select a row to open its task. **Open on the
Board** opens the same work on My view's Board.

Each group says when it holds nothing, such as "Nothing waits for your
review.", and Your work says so when none of the three holds a task.

**Your status** states in one sentence what is overdue, projected to miss
and blocked among those tasks, in the words a project's Overview opens
with, beside **Tasks left** and **Hours left**, which count every task of
yours that is not Done.

**Milestones** lists the upcoming milestones of the projects that hold your
work, each with its project's name. The line under a milestone counts your
**Late** tasks in its project due before it, as a project's Overview counts
them, from the milestone of the same project shown above it. Every task of
yours that is not Done counts, Backlog tasks and tasks with subtasks too.
Where Qivo could not work out the delay of a task of yours due in that
project, or could not load Your work, the line says it could not count
them. A project where none of your tasks is in a sub-project that tracks
delay shows no line.

**Your projects** lists each project that holds work of yours that is left,
with its lead, your tasks and hours left there, and your **Late**,
**Behind plan** and **Paused** counts, Late first and then by name, 10 at a
time with **Load more**. Two projects of the same name show their numbers.
While Qivo cannot count your tasks, which projects hold work of yours is
not known, so it lists none and says why. Select a row to open that
project's Board.

The page has two columns where there is room. On a phone or in a narrow
window it has one, Your work first, and each row puts its hours and its
actions on a second line, in the same place in every row. On a narrow
phone the actions take a third line.

## Hidden pages, milestones and empty scopes

Overview stops updating while its page is hidden behind another one or the
browser tab or desktop window is hidden or minimized. Shown again, it keeps
the figures and rows it had until the server's fresh answer arrives. After
midnight it counts again for the new day.

**Milestones** lists the milestones of a project or sub-project's
top-level project, with names, relative timing, calendar weeks and dates. **Upcoming** lists the milestones of the current week and
later, nearest first, 10 at first and 10 more each time you select
**Load more**. Beyond 100 milestones, **Load more** moves on, and the
section says that earlier milestones are not shown and offers **Show from
the start**. **Past**, collapsed when the Overview opens, lists the earlier
milestones, newest first, once you select it, 25 at a time, and shows a
search box once there are more to load. Past stays as you left it when you
come back to a page Qivo kept, and starts again at its first milestones
when a new week begins. In My view, **Milestones** lists the milestones of
the projects that hold your own tasks, each with its project's name, and
not those of other projects you can see.

The next milestone is highlighted in the list while the list shows it. A
section says when it is loading, and when Qivo could check only
part of the list, in which case **Load more** continues. If loading fails,
it says so with **Retry**, and if Qivo refuses to read the milestones, it
gives the reason. In My view, where your own work spans more than 200
projects ([Limits](./limits.md)), it says that their milestones are not
listed there and asks you to open a project to see its milestones. "No
upcoming milestones." means that the project has past milestones but no
upcoming ones.

Select **+** or a row to open the project's Milestones window. A row opens that milestone from the server,
so the window says "Loading this milestone…" for a moment, then shows it
with its editor, or as a row if you can only view it. It says so instead
when the milestone can't be opened because it was deleted or you no longer
have access, and when it is deleted while the window shows it. If loading
fails, the window says so with **Retry**, and if Qivo refuses to read the
milestone, the window gives the reason; a milestone it already showed stays
with the change you are typing, also while the browser tab is hidden. Add a
name and week, then select **Add** or press Enter. Use **Edit** to change an
existing milestone, then **Save**, **Cancel** or **Delete**. Each change
saves separately; **Done** closes the window. Qivo adds milestones to the
top-level project. People with read-only access to it, including people
whose access covers only a sub-project, can view milestones but cannot add,
move or edit them.

The window lists the project's milestones in two sections. **Upcoming**
lists the milestones of the current week and later, nearest first. It shows
the first 25, and 25 more each time you select **Load more**. **Past**,
which is collapsed whenever the window opens, lists the earlier milestones,
newest first, once you select it, 25 at a time in the same way. A milestone
you add in an earlier week while Past is collapsed goes there, and the
window says so. Once a section holds more than 25 milestones, it shows a
search box, which searches every milestone of that section, not only the
ones shown. Beyond 100 milestones, **Load more** moves on. The section then
says which milestones are no longer shown and offers
**Show from the start**. A section says when it is loading, and when Qivo
could check only part of the list, in which case **Load more** continues. If
loading fails, it says so with **Retry**, and if Qivo refuses to read the
milestones, it gives the reason. A milestone you are editing keeps its place
and your change while it moves, also into the other section. If a milestone
you are editing moves out of every list the window shows, the window loads
it again, and **Save** and **Delete** wait until it has.

A project has at most one milestone in each calendar week, counting the
milestones added from its sub-projects. Weeks begin on the organization's
**Workdays start on** day ([Organization and team
settings](./organization-and-team-settings.md)). Adding or moving a
milestone into a week that already has one is refused with the name of the
milestone there, and the window keeps the name and date you entered. Move
or delete that milestone, or pick another week. Different projects can each
have a milestone in the same week. The weeks are those of the organization
that owns the project. A guest whose own organization starts weeks on
another day sees week labels in their own calendar, so a refusal can name a
week whose dates differ from the ones shown.

When a scope has no task to summarize, for example a project without
sub-projects or My view with nothing assigned to you, Overview says why
once the server has answered. In My view it says so when you can see no
project. Once the project has milestones, upcoming or past, or Qivo cannot
tell, **Milestones** stays below that note. Otherwise the note is the whole
page.
