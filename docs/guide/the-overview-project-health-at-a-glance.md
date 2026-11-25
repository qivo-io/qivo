Overview is the first view of every project, sub-project and My view. In a
project or sub-project it shows what is left to do and what needs
attention, and leaves out what is finished. My view keeps the summary of
your own tasks described under [My view's Overview](#my-views-overview).
It describes current signals, not a guarantee that deadlines are safe. An
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
new place, or leaves the list when the task no longer needs attention and
keyboard focus goes to the next row. These changes have no undo; change
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
"2 late tasks are due before it": the tasks here whose verdict is
**Late** and whose due date is on or before the first day of the
milestone's week, as the project's organization starts its weeks, so
every reader counts the same tasks, and under each later milestone the
ones due since the milestone above it. Where Qivo could not work out
every projected delay the line says it could not count them. A project
without delay tracking shows no such line.

## My view's Overview

My view's Overview summarizes your own tasks. Its opening sentence reports
overdue tasks, projected missed deadlines, paused work, completion or
remaining work. The status strip shows **Completion**, **In progress**,
**Paused** and **Next milestone**; completion and status totals count
tasks without active subtasks. A figure Qivo could not count in one
request shows **—** with a line that says why. Overdue reads every task due
before today, including Done tasks the nightly archive has not taken yet,
30 days after they were done, so it can show as not available. Open a
project to see its figures then.

**Project health** shows one row per project that holds tasks of yours,
with only your tasks counted: lead, progress, Done count, remaining hours,
**Late**, **Behind plan** and **Paused**. It shows the first 10 projects in
the chosen order, and **Load more** adds the next 10. Select a heading to
sort the whole table by it and select it again to reverse the order. The
default is Late, highest first, then by name. Once the table holds more
than 10 projects, a **Search projects** box finds any of them by name.
Select a row to open that project's Board, which keeps the restriction to
your tasks. Late, Behind plan and Paused show "—" when zero. Narrow
desktop windows scroll horizontally; phones show sortable cards, 10 at a
time, where a zero count reads 0. Past 200 projects the table shows the
first 200 and asks you to search for the others. Where Qivo could not work
out Late and Behind plan, the cell reads **unknown**, never zero, and a
table sorted by them sorts by name and says why. **Load more** can turn a
row's Late count into **unknown**, as Qivo then works out more rows in one
request.

**Overdue & at risk** lists your unfinished tasks past their due date and,
for projects with delay tracking, those projected to miss it. Hover
"projected to miss" for the projected finish week. **Paused tasks** lists
work on hold. Each list shows its first 10 tasks, earliest due date first
and tasks without a due date last, and **Load more** adds the next 10. When
a task changes while you read, its row moves to its new place in the
order, or leaves the list when the task no longer belongs in it. No row
shows twice or is skipped. Where Qivo checked only part of a list in one
request, the list says so and **Load more** continues from there. A task
marked **risk unknown** needs another person's work that Qivo could not
read, so it may not be late. After many **Load more** presses the list
keeps the latest rows and says that earlier tasks are not shown; **Show
from the start** goes back to the first ones. Select a row to open its
task.

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

In My view, **Next milestone** is the first upcoming milestone,
highlighted in the list; a project's list highlights it too. While it loads it shows "…", "None scheduled" where no upcoming
milestone exists, and "Unavailable" where Qivo cannot tell, as when loading
fails. Once **Load more** has moved past the first milestones, Next
milestone loads on its own, and if that fails, it says "Couldn't load" with
**Retry**. A section says when it is loading, and when Qivo could check only
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
