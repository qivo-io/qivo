Overview summarizes the selected project, sub-project or My view. Its
opening sentence reports overdue tasks, projected missed deadlines, paused
work, completion or remaining work. It describes current signals, not a
guarantee that deadlines are safe. In **All projects**, Overview asks you to
choose a project and lists your top-level projects, as the Board does.

The status strip shows **Lead**, **Completion**, **In progress**, **Paused**
and **Next milestone**. Grouping parents do not add to task counts;
completion and status totals count tasks without active subtasks. My view
omits Lead because it has no one lead.

Qivo counts these figures on the server, so Overview shows them without
waiting for your browser to load every task. Until the server's answer
arrives the figures show **…**, which can take a moment or two in a busy
organization. While Qivo is still counting an organization's tasks, as
right after an update, each count reads **Counting…** and a line under the
figures says so. A figure Qivo could not count in one request shows **—** with
a line that says why, never a smaller number or zero
([Limits](./limits.md)). Overdue reads every task due before today,
including Done tasks the nightly archive has not taken yet, 30 days after
they were done, so a scope with very many of them can show Overdue as not
available. Open a sub-project to see its figures then. When Overdue or the
projected delays are not available, the opening sentence names only the
overdue tasks Qivo counted, or says that Qivo could not check every
deadline, and it never says that nothing is late.

**Sub-project health** lists each sub-project's lead, progress, Done count,
remaining hours, Delayed, Slipping and Paused counts. Select a heading to sort
and select it again to reverse the order. The default is Delayed, highest
first. Select a row to open that sub-project's Board. Delayed, Slipping and
Paused show “—” when zero. Narrow desktop windows scroll horizontally;
phones show sortable cards. The table still reads every task of the scope,
so while a large workspace loads it says that it opens once every task has
loaded.

In My view, **Project health** shows one row per project. My view counts
only your tasks and keeps that restriction when you open a project from its
health row. A single sub-project shows **Status distribution** instead of
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
work, Overview says they are not available ([Who sees what](./who-sees-what-the-access-model.md)).

Overview stops updating while its page is hidden behind another one or the
browser tab or desktop window is hidden or minimized. Shown again, it keeps
the figures and rows it had until the server's fresh answer arrives. After
midnight it counts again for the new day.

**Milestones** shows names, projects, calendar weeks, dates and relative
timing, with the next milestone highlighted. Select **+** or a row to open
the project's Milestones window. Add a name and week, then select **Add** or
press Enter. Use **Edit** to change an existing milestone, then **Save**,
**Cancel** or **Delete**. Each change saves separately; **Done** closes the
window. Qivo adds milestones to the top-level project. People with read-only
access to it, including people whose access covers only a sub-project, can
view milestones but cannot add, move or edit them.

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
once the server has answered. If the scope has milestones, **Milestones**
stays below that note, and below the All projects list too.
