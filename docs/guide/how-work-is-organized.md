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
  completion come from descendants without active subtasks. Removing or
  archiving the last active subtask, or giving it another parent, restores
  the parent's previous status. To Do, In Progress and In Review tasks can
  also be paused.
- **Priority**. Urgent, High, Medium or Low.
- **Assignee**. One active person or agent, or **Unassigned**. New selections
  need **User** or **Lead** project access, including inherited access.
  Organization Viewers ([User roles](./administration-guard-rails-and-the-demo.md#four-ways-to-be-a-user)), people with only Viewer access and switched-off
  users cannot be selected. Reducing access to Viewer keeps existing
  assignments but prevents new ones.
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
- **Remaining**. Nonnegative hours of work left, saved to one decimal place.
  Qivo uses the time of the estimate, or the planned start if later, to
  project progress ([Delay status](./will-it-be-ready-in-time-the-delay-status.md)). Empty means unestimated and displays “—”; **0**
  means no work remains. Gaining a first subtask clears the parent's own
  estimate. The parent then shows its descendants' total, marked **Σ**,
  excluding linked tasks. After the last active subtask leaves, the field
  becomes editable and starts empty. Entering **In Review** replaces
  Remaining with the project's review time, 2 h by default. A REST or MCP
  update that supplies remaining hours with that status change keeps the
  supplied value. Leaving In Review keeps the current estimate.
- **Due date**. The latest day the task should finish. Qivo accepts only real
  calendar dates. The today marker and overdue checks refresh at local
  midnight and when you return to a sleeping tab, without changing plan dates.
- **Planned period**. Start and end weeks on the Roadmap. Planning uses whole
  weeks ([The Roadmap](./the-roadmap.md)).
- **Paused**. Choose **Pause** in the Status menu to hold work without
  changing its status. Choose **Resume** there, or use the adjacent play
  button on wider screens, to resume it. Paused tasks show an amber mark and
  a hatched Roadmap bar. Their hours do not count toward the owner's load,
  auto-fit or other tasks' delay projections until they resume ([Delay projections](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works), [Planning against capacity](./planning-against-real-capacity.md)).
  Add a comment to explain the pause. Backlog and Done cannot be paused;
  moving a paused task to either status resumes it. REST and MCP use the
  same `paused` flag.
- **Labels**, a rich-text **description**, **attachments**, **comments**, a
  **parent**, **subtasks** and task **links**. Links can mean “blocks”, “is
  blocked by” or “relates to” and may span projects and teams. Description
  edits appear in the activity feed with before/after excerpts.

Moving a task requires its assignee and reviewer to be eligible in the
destination. Clear or change either person first if they cannot edit that
project or are switched off. For a grouping parent, an ineligible reviewer
saved before it gained subtasks is cleared instead of preventing the move.
Removing a person from the organization clears their assignments and reviewer
roles.

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
access to the task, and archived tasks must be restored before they open.

## Archiving a project. Putting a finished one away

Use **Project settings → Danger zone → Archive project** to remove a
finished project and its sub-projects from active views and capacity
planning. Tasks, comments, attachments, estimates and history remain stored.
The planner stops loading the archived work. Restore the project before
adding tasks.

**Settings → Projects → Archived projects** lists archived projects, newest
first. **Restore** returns them to active views; **Delete** permanently
removes them after confirmation. Archiving and restoring require Lead
access, which organization admins and project leads have.

Sub-projects archived with a project return with it. A sub-project archived
separately stays archived when its project returns and then has its own row
in the archived list.
