## Sidebar

The sidebar shows your organization, **Search**, **My view**, **All
projects**, **Team sync**, the **Projects** tree and **Settings**. The
organization name is not a switcher. If you only have a guest identity,
**Create your organization…** opens the organization-creation dialog. It does
not show while an organization that deactivated you, or one being deleted,
still holds your member seat.

Select a project to reveal its sub-projects. One project stays expanded at a
time. Projects shared by another organization appear in the same tree under
that organization's name. The project tree scrolls while navigation and
Settings stay visible.

A project row's **…** menu opens settings, **Archived tasks** and, for leads,
**New sub-project…**. Sub-project rows have settings and **Archived tasks**.
The Projects header's **+** creates a project. It appears for organization
admins, and for standard users when
[Who can create projects](./organization-and-team-settings.md#who-can-create-projects)
allows it.

**Settings** opens **Your preferences** ([Your preferences](./working-together.md#who-a-person-is)). Its navigation also contains
Organization settings and **Projects**, with **All projects**, **Archived
projects**, **Archived tasks** ([Archiving](./the-task-window.md#archiving)) and
**Deleted items** ([Deleted items](./how-work-is-organized.md#deleted-items)).
In supported Windows and Linux desktop builds, **Desktop app** appears below
**Your preferences** for startup, tray and notification settings
([Desktop app](./qivo-in-one-minute.md#desktop-app)).
Organization settings are **General**, **Billing**, **Users**,
[**API access**](./administration-guard-rails-and-the-demo.md#api-access),
**Teams** and **Labels**. They require admin access, except **Teams**, which
team leaders can open. The project list groups projects by organization and
expands one project at a time. Use a row or its **…** menu to open settings
or that project's archived tasks.

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

Roadmap tracks and Overview health rows represent projects, and Roadmap
tracks contain collapsible sub-project bands. Select an Overview health row
to open its project's Board. The Board shows one project at a time
([Which tasks a Board shows](./the-board.md#which-tasks-a-board-shows)), so in
All projects it lists your top-level projects, and choosing one opens its
Board. A task link that names no project, such as `…/tasks/qn-12`, opens
the Board of the task's sub-project instead when it would open on the All
projects Board. A link that names All projects, such as
`…/board/all/tasks/qn-12`, keeps it, with the task's window over the list.

To create a task, open its project first. On a desktop, the Board's project
list and empty states offer no way to create a task; on a phone, **New
task** in the task list lets you choose its project. The Team strip omits
**This project only** because the scope already includes all projects.

When you can see no active project, Qivo opens All projects. Its pages, Team
sync and the Inbox then say that no active projects are shared with you, and
that an organization admin or a project lead can give you access. An
organization admin sees every project, so for an admin they say that the
organization has no active projects. **New project** appears there if you can
create projects ([Who can create projects](./organization-and-team-settings.md#who-can-create-projects)).
Team sync covers your home organization only, so it says the same when you can
see none of that organization's projects, and names the organization if you
belong to more than one ([Team sync](./planning-against-real-capacity.md#team-sync)).
Once a project is shared with you, Qivo opens it, at once and on your next
visit, unless you chose All projects yourself.

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

To create a task, use a project's **+** in Swimlanes by project or
Side-by-side boards, or open that project first. A new task starts
unassigned, so Qivo opens its sub-project where you can see and assign it.

## The three views

Qivo saves your last view, scope and Roadmap window per user on the server.
They follow you across devices and reloads.

## Pages stay as you left them

Each page you open stays loaded while you use Qivo: the Overview, the Board,
the Roadmap, the Inbox, Team sync and Projects. Going back to one shows it at
once, scrolled where you left it, and changes made while it was out of sight
follow right after. The Board checks which tasks it shows again when it
shows. It does the same when you return to a browser tab or desktop window
you had hidden or minimized, where it stops updating meanwhile. The Overview,
the Board and the Roadmap belong to the
sidebar choice, such as a project or All projects. Choosing another one loads
them again for it. Settings loads each time you open it.

Some parts of a page close when you leave it:

- The Inbox closes the task in its pane and comes back to its list.
- Team sync's last **Done** ends the meeting, so the next one starts on its
  first step ([Team sync](./planning-against-real-capacity.md#team-sync)).
- The phone's landscape Roadmap timeline closes, and the Roadmap comes back
  on its agenda.

After 30 minutes without using Qivo (no pointer, key, touch or scroll wheel
input in it), only the page on screen stays loaded. The others load again
when you open them.

## Filters (Board and Roadmap)

Desktop Board has a text filter, **My tasks**, **Assignee**, **Priority**,
**Stale** and **Focus**. Roadmap has text, Assignee and Priority filters. Use
**Assignee → Me only** there for your own tasks. Text, people and priority
filters carry between Board and Roadmap; Stale and Focus affect only Board.
Phone lists and Roadmap ignore desktop text queries.

**Filter tasks…** matches case-insensitive word fragments in any order.
Every fragment must occur in the task's key, title, description, status,
priority, assignee name or labels. For example, “to do cable” finds a To Do
task with “cable” in its title. Wildcard characters are not needed. Spaces
around the text do not count. The Board narrows its cards as you type and
asks the server once you pause; a text filter longer than 200 characters
shows its limit in place of the Board until you shorten it.

Task filters, Archived tasks, Inbox and searchable pickers use the same
fragment-matching rule. Search matches whole words instead ([Search palette](#search-palette)).

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

Open **Search** in the sidebar or use the phone header's search icon. Search
covers every project you can open in every organization you belong to,
whatever page you are on, and **Search in** shows that as **All projects**.
**Search this sub-project**, which a Board offers when it cannot load a
sub-project's tasks, opens Search with **Search in** set to that
sub-project. To narrow it, choose an organization, a project with its
sub-projects, or one sub-project there. The choice lasts while Search stays
open. An empty search shows nothing.

Search finds a task by its ID (`QN-12` or `12`), the words of its title and
the text its description shows, not link addresses or the hidden part of a
mention. It finds a project by its own name. A project's name does not find
its tasks, and a task is not found by its project's name. A number on its
own is read as a task ID and matches only whole, as a task's number or a
whole word, so `12` finds QN-12 but not QN-120, and “roadmap 20” does not
find “Roadmap 2026”.

Search matches whole words in any order. Every word must match, and case
does not matter. The last word also matches the start of a longer word, so
“signed firm” finds “Add signed firmware updates and rollback”, but “firm
signed” does not, because only the last word may be the start of a longer
one. Parts inside a word are not found, so “abl” does not find “cable”.
Accents are not folded, so “cafe” does not find “café”, and å, ä and ö must
be typed exactly. Words of 32 bytes or more in UTF-8, about 30 letters,
are not searched. In scripts written without spaces, such as Japanese, a
run of text counts as one word, so a run of more than about 10 characters
is not searched. A search holds at most 200 characters ([Limits](./limits.md#text)).

Results come in one list, best matches first, and each row says whether it
is a **Task** or a **Project**. A row from another organization names that
organization. Each page holds up to 25 results, with **Previous** and
**Next**. **Include archived tasks** adds archived tasks, marked
**Archived**. Opening one shows the task read-only, with its description and
comments, and **Restore** for someone who can edit its project
([Archiving](./the-task-window.md#archiving)).
Search never finds archived projects or the tasks in them.

When Search could not cover everything, it says that some results might be
missing and offers to choose a project to search in. Choosing a project
searches every task there that you can open, but a very common word can
still leave some results out, and then the note asks for more words
instead. Someone who is not an organization admin and can open many
projects sees the note on every search of a whole organization.

Use Up/Down and Enter to open a result, or select it directly. Enter does
nothing until the results of what you typed have arrived. A task picked while the
Board is open also shows its card behind the task window ([Showing a task on the Board](./the-board.md#showing-a-task-on-the-board)).

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

Pages spanning organizations, including Inbox, My view, All projects and
your account, use `~` instead of an organization name. For example,
`qivo.io/app/~/inbox`. The former Archive address, `qivo.io/app/~/archive`,
opens Archived tasks.

Task links accept any case, a bare number or a full key. Project URLs use a
stable number that survives renaming. All projects and My view have their
own paths, `…/board/all` and `…/board/mine`. Opening a task adds
`/tasks/qn-482`, so a reload preserves both task and scope.

Copying a task link uses its short permanent address. Opening that link
keeps a saved My view scope if the task is yours; otherwise, it opens the
task's project. Recipients still need access. Restore archived tasks from
Archived tasks before opening their links ([Archiving](./the-task-window.md#archiving)),
and deleted ones from Deleted items.

## Keyboard, in brief

- **Esc** closes the topmost popover, dialog or task window. In a description or
  comment editor it first leaves the text, asking before it discards changes.
- **Enter** submits single-line fields.
- **Ctrl/Cmd+K** links the selected editor text. The editor's other formatting
  and line-break keys are in [The discussion column](./the-task-window.md#the-discussion-column).

Qivo has no other shortcuts. Saving a draft, sending a note, adding a label
and every other action use their buttons.
