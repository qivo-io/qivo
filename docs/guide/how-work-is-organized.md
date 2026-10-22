**Organization → Project → Sub-project → Task**.

- An **organization** owns its users, seats, labels and shared settings,
  including date format, calendar-week rules and attachment size limits.
- A **team** groups people for project sharing. Adding or removing a member
  updates their inherited access. A team **leader** manages membership.
  Share teams with projects or individual sub-projects ([Project access](./who-sees-what-the-access-model.md)). Weekly
  capacity belongs to each person ([Planning hours](./organization-and-team-settings.md#planning-hours-and-teams)); delay tracking and archiving belong
  to projects.
- A **project** combines sub-projects in one Board and Roadmap. It has a
  **lead** and can be shared with teams and individuals. Its sub-projects
  inherit that access.
- A **sub-project** has its own lead and Board and contains tasks. Add a
  sub-project before creating tasks in a new project.

## The task

Tasks have these fields:

- **Status**. Backlog, To Do, In Progress, In Review or Done. A task with
  active subtasks acts as a group. Its own status is hidden; progress and
  completion come from descendants without active subtasks. Subtasks in an
  archived sub-project do not count. Removing or archiving the last active
  subtask, giving it another parent, or archiving its sub-project restores
  the parent's previous status. To Do, In Progress and In Review tasks can
  also be paused.
- **Priority**. Urgent, High, Medium or Low.
- **Assignee**. One active person or agent, or **Unassigned**. New selections
  need **User** or **Lead** project access, including inherited access.
  Organization Viewers ([User roles](./administration-guard-rails-and-the-demo.md#four-ways-to-be-a-user)), people with only Viewer access and switched-off
  users cannot be selected. Reducing access to Viewer keeps existing
  assignments but prevents new ones. Removing someone's access while they
  hold open tasks asks whether to keep them as Viewer or reassign the tasks
  ([Project access](./who-sees-what-the-access-model.md)). A subtask can only go to someone who
  can see every task above it, because the parent holds its context.
- **Reviewer**. An optional person or agent who meets the Assignee rules and
  may also be the assignee. While a task is **In Review** with a reviewer,
  that reviewer owns its work for My view, filters, assignee lanes, workload,
  planning, delay projections and **Update Estimate**. Task portraits show
  the reviewer, who also starts following the task ([Your inbox](./working-together.md#your-inbox)). Otherwise, the
  assignee owns it. Grouping parents have no reviewer of their own; set
  reviewers on their subtasks.
- **Reporter**. The person or agent credited with reporting the task. The
  app sets this to the signed-in user. REST and MCP creation can name another
  user in the task's organization who can see its project, including a
  Viewer or switched-off user. Reporting grants no access and sends no
  notification. The reporter cannot be changed or cleared afterward, except
  when their profile is removed from the organization. Moving the task or
  losing project access does not change it.
- **Remaining**. Hours of work left, from 0 to 99,999.9, saved to one decimal
  place.
  Qivo uses the time of the estimate, or the planned start if later, to
  project progress ([Delay status](./will-it-be-ready-in-time-the-delay-status.md)). Empty means unestimated and displays “—”; **0**
  means no work remains. Gaining a first subtask clears the parent's own
  estimate. The parent then shows the total of its unfinished subtasks at any
  depth, marked **Σ**. Done subtasks and linked tasks do not count. After the last active subtask leaves, the field
  becomes editable and starts empty. Entering **In Review** replaces
  Remaining with the project's review time, 2 h by default. A REST or MCP
  update that supplies remaining hours with that status change keeps the
  supplied value. Leaving In Review keeps the current estimate.
- **Due date**. The latest day the task should finish. Qivo accepts only real
  calendar dates. The today marker and overdue checks refresh at local
  midnight and when you return to a sleeping tab, without changing plan dates.
- **Planned period**. Start and end weeks on the Roadmap. Planning uses whole
  weeks ([The Roadmap](./the-roadmap.md)). A task with active subtasks takes
  its planned period from them, from the earliest start to the latest end of
  the scheduled subtasks you can access. A subtask you cannot access hides
  the subtasks below it. Its own saved dates are hidden and
  cannot be edited. Removing or archiving the last active subtask, or giving
  it another parent, restores them.
- **Paused**. Choose **Pause** in the Status menu to hold work without
  changing its status. Choose **Resume** there, or use the adjacent play
  button on wider screens, to resume it. Paused tasks show an amber mark and
  a hatched Roadmap bar. Their hours do not count toward the owner's load,
  auto-fit or other tasks' delay projections until they resume ([Delay projections](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works), [Planning against capacity](./planning-against-real-capacity.md)).
  Add a comment to explain the pause. Backlog and Done cannot be paused;
  moving a paused task to either status resumes it. A task with active
  subtasks shows no pause of its own; pause its subtasks instead. REST and
  MCP use the same `paused` flag.
- **Labels**, a rich-text **description**, **attachments**, **comments**, a
  **parent**, **subtasks** and task **links**. A subtask stays in its
  parent's project, in any of its sub-projects. A task has one level of
  subtasks, at most 100 active ones, and archived subtasks do not count
  ([The details column](./the-task-window.md#the-details-column)). Links can mean “blocks”, “is
  blocked by” or “relates to” and may span projects and teams. You see a link
  only if you can access both tasks. Description
  edits appear in the activity feed with before/after excerpts.

Moving a task requires its assignee and reviewer to be eligible in the
destination. Clear or change either person first if they cannot edit that
project or are switched off. For a grouping parent, an ineligible reviewer
saved before it gained subtasks is cleared instead of preventing the move.
A move to another project takes the task's subtasks along, and a subtask
moved there stops being a subtask of its parent ([Moving a task](./the-task-window.md#moving-a-task)).
Removing a person from the organization clears their assignments and reviewer
roles. Qivo clears open tasks at once, or shortly after for someone with
hundreds of them, and archived tasks within a few minutes.

## Creating a task

Use a Board column's **+**, a project or sub-project heading's **+**, or
**New task** on an empty Board. Choose **Project** and **Sub-project**, enter
a required **Title**, then select **Create** or press Enter. Qivo opens the
new task so you can add its other details.

The dialog starts in the project or sub-project you opened it from. Its
pickers show only writable destinations and omit projects without
sub-projects. Creating outside the current scope opens the task's
sub-project. A confirmation shows the new task ID, and the task window has a
shareable URL.

New tasks start unassigned with Low priority. A column's **+** uses that
status; other entry points start in Backlog. Creating in **In Review** sets
Remaining to the project's review time ([Review time](./will-it-be-ready-in-time-the-delay-status.md#review-time)).

**All projects** and **My view** columns have no **+**. Use a project
heading's **+** in Swimlanes by project or Side-by-side boards, or open the
project first. Phones use the same project/sub-project picker. Relationship
pickers keep their separate quick-create flow for subtasks, linked tasks and
parents. Use **Move** to relocate an existing task while keeping its ID.

## Permanent task IDs

Qivo assigns `QN-1`, `QN-2`, … from one counter per organization. Numbers do
not change or get reused. Moving a task between projects or sub-projects in
the organization keeps its number and labels. Task links still require
access to the task, and archived or deleted tasks must be restored before
they open.

## Archiving a project. Putting a finished one away

In the project's settings, choose **Archive or delete…** in the **Archive or
delete** section at the end, then **Archive**, to remove a finished project
and its sub-projects from active views and capacity planning. Tasks,
comments, attachments, estimates and history remain stored. The planner stops
loading the archived work. Restore the project before adding tasks.

**Settings → Projects → Archived projects** lists archived projects, newest
first. **Restore** returns them to active views; **Delete** moves them to
[Deleted items](#deleted-items). Archiving, restoring and deleting require Lead
access, which organization admins and project leads have.

Sub-projects archived with a project return with it. A sub-project archived
separately stays archived when its project returns and then has its own row
in the archived list.

A task in another sub-project whose subtasks were all in the archived one
becomes an ordinary task again, with its own status, dates and estimate.
When the sub-project is restored, the task becomes a group again and loses
its own estimate, as when it gains a subtask.

If you can access only a sub-project, the archived list shows its archived
project too, with that sub-project under it. Restoring a sub-project also
restores its archived project, so it needs Lead access to that project.
Otherwise, ask the project's lead to restore the project.

## Deleting a project

In the same **Archive or delete…** window, **Delete** moves the project, its
sub-projects and all their tasks, archived tasks included, to
[Deleted items](#deleted-items). A sub-project always goes with its project.
The window first counts the work, for example **Field trial Q3 has 2
sub-projects and 48 tasks, including 9 archived tasks.** Its button names the
count, such as **Delete project and 48 tasks**. An optional reason is shown
in Deleted items. **Delete** on the Archived projects page opens the same
window without the Archive choice. Deleting a project removes the inbox
messages about its tasks. A project with more than 200 sub-projects, archived
ones included, cannot be deleted at once. Delete some of its sub-projects
first, then the project.

## Deleted items

Deleting a task or a project moves it to **Settings → Projects → Deleted
items**, newest first. A nightly job deletes each item for good 30 days after
it was deleted, also while the organization is read-only.

Who sees an item:

- **Organization admins** see everything deleted in the organization.
- **Project leads** see what they deleted, and everything deleted in projects
  they lead, including the sub-projects of a project they lead.
- **Everyone else** sees what they deleted.

Except for organization admins, you see an item only while you can still open
the project it was in. If you can now only view that project, your own delete
shows without **Restore**, with a line such as **You can only view Luma
Sensor now. Ask its lead, Mira Holm, to restore it.** A subtask deleted with
a task in a project you cannot open shows only its key and title, without
**Restore**. Items from every organization you belong to appear together,
grouped by organization when there is more than one.

Each row shows who deleted the item and when, where it was, and the reason
when one was given. A delete through the REST API or MCP also names the
credential, such as **Daniel Berg via Cursor, personal token**. Everyone who
sees the item sees an agent key's name. The name of a personal token or a
connected app shows only to organization admins and to the person who
deleted, so a project lead reads **Daniel Berg via a personal token**. When
eleven or more tasks in a row were deleted by the same person in the same
way, each within 10 minutes of the next, the list shows seven and folds the
rest into one line with **Show all**.

Filter the list by kind, by text and, for admins and leads, by **Deleted
by**. The page shows up to the newest 2,000 items, and fewer when the trash
is very large. The text filter also finds deleted tasks by key or title,
including tasks inside deleted projects and items the list does not show. It
lists up to 50 such tasks; when it finds more, the page says so, and typing
more of the title or key narrows the search. A very broad search in a large
trash can show fewer than it would find with a longer text. A
task inside a deleted project can only come back with its project, and a
subtask deleted with its task only with that task and its other subtasks.
When the filter shows such a task on a line of its own, its **Restore** first
says what comes back with it. **Deleted by** offers an admin everyone in the
organization, so choosing a person reaches their older deletes too.

**Restore** on a row brings the item back at once, where it was, with its
comments, attachments, links and labels. To restore several, select their
rows and choose a button such as **Restore 3 selected**. A window lists where
they go before anything changes. Restored work keeps its keys, such as
`QN-142`, because Qivo never reuses a number
([Permanent task IDs](#permanent-task-ids)). A task saved before the current
length limits whose text was too large to keep in Deleted items, about 1 MB,
comes back with its title cut to 255 characters and its description to
20,000 ([Limits](./limits.md)). Labels deleted since then are
gone, and so are links to work deleted for good and links to a task that has
reached 100 links since. A subtask deleted on its own
returns under its parent when the parent still exists, is not a subtask
itself and has fewer than 100 active subtasks, the restored task has no subtasks,
you can edit the parent, and everyone assigned to or reviewing the subtask
can still see the parent's project. An archived subtask does not count
toward the 100. Otherwise, or when the parent's
subtasks are too large to count during the restore, it returns as a
top-level task and keeps its people and its subtasks, as a subtask restored
from the archive under a full parent does. Work that was archived when it was
deleted returns archived. A restored Done task restarts its auto-archive
clock. A restored project shows first to its leads and organization admins,
and to the people and teams it is shared with moments later, once their
access is back. A task restored on its own sends its followers a **Restored** update.
Restoring several items at once, or a project, sends none, and inbox
messages removed by the delete do not come back
([Your inbox](./working-together.md#your-inbox)).

You can restore what you see when you can still edit where it goes back:

- A task needs edit access to its project and to the projects of the
  subtasks deleted with it. If its project is archived, restore that project
  from Archived projects first.
- A project needs its lead or an organization admin. A sub-project also
  needs its project to be active.
- A task or sub-project deleted before its project can only come back with
  that project. Only organization admins see it, and its **Restore** brings
  the project back first.
- While the organization is read-only, restoring is paused.

**Delete now…** in a row's menu deletes an item for good at once, with its
comments, attachments and the change history of its tasks. Only organization admins have it, and only while
the organization can make changes. It cannot be undone. Deleting a project
for good also deletes the tasks and sub-projects that were deleted from it
before it, and its window says so. An item that could not finish moving shows
**Couldn't finish moving this item.** to admins. It does not expire, so delete it with **Delete now…** or contact
support.

Deleted items do not count toward the organization's storage
([Billing and free access](./administration-guard-rails-and-the-demo.md#billing-and-free-access)),
and the organization export leaves them out
([Export data](./organization-and-team-settings.md#export-data)).
