## Sidebar

The sidebar shows your organization, **Search**, **My view**, **All
projects**, **Team sync**, the **Projects** tree and **Settings**. The
organization name is not a switcher. If you only have a guest identity,
**Create your organization…** opens the organization-creation dialog.

Select a project to reveal its sub-projects. One project stays expanded at a
time. Projects shared by another organization appear in the same tree under
that organization's name. The project tree scrolls while navigation and
Settings stay visible.

A project row's **…** menu opens settings, **Archived tasks** and, for leads,
**New sub-project…**. Sub-project rows have settings and **Archived tasks**.
Eligible organization staff can create projects with the Projects header's
**+**.

**Settings** opens **Your preferences** ([Your preferences](./working-together.md#who-a-person-is)). Its navigation also contains
Organization settings, **Projects → All projects** and **Archived projects**.
Organization settings require admin access, except **Teams**, which team
leaders can open. The project list groups projects by organization and
expands one project at a time. Use a row or its **…** menu to open settings
and archived tasks. Archive has no separate sidebar entry.

## Top bar

Use **Inbox** and its unread count to open notifications ([Your inbox](./working-together.md#your-inbox)). Select
**Overview**, **Board** or **Roadmap** to return to that view in the current
scope. Team sync is a separate page ([Team sync](./planning-against-real-capacity.md#team-sync)).

Board filters and its layout switcher sit below the view selector. Roadmap
has filters and planning controls; Overview uses only the selected scope.
Create tasks from the Board controls described in [Creating a task](./how-work-is-organized.md#creating-a-task).

## All projects

**All projects** shows Overview, Board and Roadmap across every project you
can access, including projects shared by other organizations ([Guest access](./who-sees-what-the-access-model.md#people-outside-your-organization)).

Board lanes, Roadmap tracks and Overview health rows represent projects.
Cards show their sub-project, and Roadmap tracks contain collapsible
sub-project bands. Select an Overview health row to open its project's Board.

To create a task, use a project's **+** in Swimlanes by project or
Side-by-side boards, or open that project first. Shared status columns and
empty states have no create action. The Team strip omits **This project
only** because the scope already includes all projects.

If you hold a guest identity in another organization, the Team strip lists
it separately from your home identity. Their capacity is not combined.

## My view

**My view** includes tasks assigned to you and tasks **In Review** with you
as reviewer, across all organizations you can access. A task assigned to you
leaves My view while another reviewer owns it and returns when it leaves
In Review.

Projects, sub-project bands and health rows with none of your tasks are
hidden. Completion counts and remaining-hour totals cover only your work.

**My tasks** and **Assignee** filters are absent because this scope already
selects your work. Text and Priority filters remain on desktop Board and
Roadmap; Stale and Focus remain Board-only.

Task creation works as in All projects. A new task starts unassigned, so Qivo
opens its sub-project where you can see and assign it.

## The three views

Qivo saves your last view, scope and Roadmap window per user on the server.
They follow you across devices and reloads.

## Filters (Board and Roadmap)

Desktop Board has a text filter, **My tasks**, **Assignee**, **Priority**,
**Stale** and **Focus**. Roadmap has text, Assignee and Priority filters. Use
**Assignee → Me only** there for your own tasks. Text, people and priority
filters carry between Board and Roadmap; Stale and Focus affect only Board.
Phone lists and Roadmap ignore desktop text queries.

**Filter tasks…** matches case-insensitive word fragments in any order.
Every fragment must occur in the task's key, title, description, status,
priority, assignee name or labels. For example, “to do cable” finds a To Do
task with “cable” in its title. Wildcard characters are not needed.

**Assignee** supports multiple people and stays open while you choose.
**Me only** applies the same filter as **My tasks**; **Anyone** removes the
people restriction. My tasks and selected assignees are mutually exclusive.
Both match the reviewer while a task is In Review with one ([Task ownership](./how-work-is-organized.md#the-task)).
**Priority** selects one level. **Stale** selects unfinished tasks untouched
for more than 120 days.

Press **My tasks**, **Stale** or **Focus** again to turn it off. Use the
**×** on Assignee, Priority or the text field to clear that filter.

Filtering hides lanes, tracks and sub-project bands with no matches. Status
columns, the Roadmap grid and milestones remain. When nothing matches, use
**Clear filters** in the empty-state message. This keeps your scope and
**Focus** setting.

**Focus** hides Board's Backlog and Done columns. It starts off, stays as you
set it across devices and reloads, and does not affect Roadmap. A **Plan on
roadmap** session bypasses filters for its task; move a Backlog task to
another status before starting one.

## Search palette

Open **Search** in the sidebar or use the phone header's search icon. Typing
searches visible projects and task keys and titles. The task section shows
up to nine results. An empty search shows no suggestions. Use Up/Down and
Enter to open a result, or select it directly.

Search matches case-insensitive word fragments in any order. For example,
“signed firm” finds “Add signed firmware updates and rollback”. A matching
phrase ranks above separated or reordered fragments, and earlier phrase
matches rank higher. Task filters, Archive, Inbox and searchable pickers
use the same fragment-matching rule.

**Close**, **esc** or Escape closes search. On phones, browser Back also
closes it. After opening a result, Back returns to the page where the search
began. Home and End move to the start and end of the query; Shift selects
text to that position.

## Links you can share

Task and project URLs include the organization's address ([Organization address](./organization-and-team-settings.md#organization-address)), which
distinguishes numbers that different organizations reuse. For example:

- Task, `qivo.io/app/acme/tasks/qn-482`.
- Project Board, `qivo.io/app/acme/board/p/3`.
- Team sync, `qivo.io/app/acme/sync/all`.

Pages spanning organizations, including Inbox, Archive, My view, All
projects and your account, use `~` instead of an organization name. For
example, `qivo.io/app/~/inbox`.

Task links accept any case, a bare number or a full key. Project URLs use a
stable number that survives renaming. All projects and My view have their
own paths, `…/board/all` and `…/board/mine`. Opening a task adds
`/tasks/qn-482`, so a reload preserves both task and scope.

Copying a task link uses its short permanent address. Opening that link
keeps a saved My view scope if the task is yours; otherwise, it opens the
task's project. Recipients still need access. Restore archived tasks from
Archive before opening their links ([Archiving](./the-task-window.md#archiving)).

## Keyboard, in brief

- **Esc** closes the topmost popover, dialog or task window.
- **Enter** submits single-line fields.
- **L** opens the label picker in a task window.
- **Ctrl/Cmd+S** saves a description or comment draft.
- **Ctrl/Cmd+K** links the selected editor text.

There are no app-level shortcuts for switching views or opening Search.
