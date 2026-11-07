Overview summarizes the selected project, sub-project or My view. Its
opening sentence reports overdue tasks, projected missed deadlines, paused
work, completion or remaining work. It describes current signals, not a
guarantee that deadlines are safe. Over all projects, at an address that
ends in `/all` ([All projects](./finding-your-way-around.md#all-projects)),
Overview asks you to choose a project and lists your top-level projects, as
the Board does.

The status strip shows **Lead**, **Completion**, **In progress**, **Paused**
and **Next milestone**. Grouping parents do not add to task counts;
completion and status totals count tasks without active subtasks. My view
omits Lead because it has no one lead.

Qivo counts these figures on the server, so Overview shows them without
waiting for your browser to load every task. Until the server's answer
arrives the figures show **…**, which can take a moment or two in a busy
organization. While Qivo is still counting an organization's tasks, as
right after an update or for a moment after any project is archived or
restored, each count reads **Counting…** and a line under the figures says
so. A figure Qivo could not count in one request shows **—** with
a line that says why, never a smaller number or zero
([Limits](./limits.md)). Overdue reads every task due before today,
including Done tasks the nightly archive has not taken yet, 30 days after
they were done, so a scope with very many of them can show Overdue as not
available. Open a sub-project to see its figures then. When Overdue or the
projected delays are not available, the opening sentence names only the
overdue tasks Qivo counted, or says that Qivo could not check every
deadline, and it never says that nothing is late.

**Sub-project health** lists each sub-project's lead, progress, Done count,
remaining hours, Delayed, Slipping and Paused counts. It shows the first 10
sub-projects in the chosen order, and **Load more** adds the next 10. Select
a heading to sort the whole table by it and select it again to reverse the
order. The default is Delayed, highest first, then by name. Once the table
holds more than 10 sub-projects, a search box above it finds any of them by
name, not only the rows shown. Qivo works out every row on the server, so
the table no longer waits for your browser to load every task. Select a row
to open that sub-project's Board. Delayed, Slipping and Paused show “—” when
zero. Narrow desktop windows scroll horizontally; phones show sortable
cards, 10 at a time. Past 200 sub-projects the table shows the first 200
and asks you to search for the others.

Delayed and Slipping depend on the other work of each task's owner. Where
Qivo could not work that out, as when the owners have more open work than
it reads at once, the cell reads **unknown**, never zero, and a line under
the table says so. A table sorted by Delayed or Slipping then sorts by name
and says why. **Load more** can turn a row's Delayed into **unknown**, as
Qivo then works out more rows in one request. While Qivo is counting an
organization's tasks, Progress reads **Counting…** and the other counts
**…**, a line under the table says so, and a sort by Progress, Done, Left
or Paused sorts by name until the counts are whole. Where Qivo could not
count the table's tasks in one request, the counts read **unknown** with a
line that says why, and those sorts sort by name as well.

In My view, **Project health** shows one row per project that holds tasks
of yours, with only your tasks counted, and keeps that restriction when you
open a project from its health row. Its search box says **Search
projects**. A single sub-project shows **Status distribution** instead of
the table.

**Overdue & at risk** lists unfinished tasks past their due date and, for
projects with delay tracking, tasks projected to miss it. Hover “projected
to miss” for the projected finish week. **Paused tasks** lists work on hold.
Each list shows its first 10 tasks, earliest due date first and tasks
without a due date last, and **Load more** adds the next 10. When a task
changes while you read, its row moves to its new place in the order, which
can be past the rows loaded so far, or leaves the list when the task no
longer belongs in it. No row shows twice or is skipped. Where Qivo
checked only part of a list in one request, the list says so and **Load
more** continues from there. A task marked **risk unknown** needs another
person's work that Qivo could not read, so it may not be late. After many
**Load more** presses the list keeps the latest rows and says that earlier
tasks are not shown; **Show from the start** goes back to the first ones.
Select a row to open its task. Portraits show the reviewer while a task
waits In Review with one.

A guest or organization Viewer sees other people's work one person at a
time, so where the projected delays of a scope need more than one person's
work, Overview says they are not available, and where the health table's
rows need more than one person's work, Delayed and Slipping read
**unknown** on each row that needs anyone but the one person Qivo reads
for you. A guest's or Viewer's health table sorted by Delayed therefore
often shows its rows by name
([Who sees what](./who-sees-what-the-access-model.md)).

Overview stops updating while its page is hidden behind another one or the
browser tab or desktop window is hidden or minimized. Shown again, it keeps
the figures and rows it had until the server's fresh answer arrives. After
midnight it counts again for the new day.

**Milestones** lists the milestones of a project or sub-project's
top-level project in two sections, with names, calendar weeks, dates and
relative timing. **Upcoming** lists the milestones of the current week and
later, nearest first, 10 at first and 10 more each time you select
**Load more**. Beyond 100 milestones, **Load more** moves on, and the
section says that earlier milestones are not shown and offers **Show from
the start**. **Past**, collapsed when the Overview opens, lists the earlier
milestones, newest first, once you select it, 25 at a time, and shows a
search box once there are more to load. Past stays as you left it when you
come back to a page Qivo kept, and starts again at its first milestones
when a new week begins. In My view, **Milestones** lists the milestones of
the projects that hold your own tasks, each with its project's name, and
not those of other projects you can see. All projects shows no
milestones; open a project to see its milestones.

**Next milestone** is the first upcoming milestone, highlighted in the
list. While it loads it shows "…", "None scheduled" where no upcoming
milestone exists, and "Unavailable" where Qivo cannot tell, as when loading
fails. A section says when it is loading, and when Qivo could check only
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
and your change while it moves, also into the other section.

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
once the server has answered. Over all projects it says so when you can
see no project. Once the project has milestones, upcoming or past, or Qivo
cannot tell, **Milestones** stays below that note. Otherwise, and over all
projects, the note or the list of projects is the whole page.
