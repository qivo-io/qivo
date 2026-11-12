## Sidebar

The sidebar shows your organization, **Search**, **My view**, **All
projects**, **Team sync**, the **Projects** tree and **Settings**. **All
projects** opens the project directory ([All projects](#all-projects)). The
organization name is not a switcher. If you only have a guest identity,
**Create your organization…** opens the organization-creation dialog. It does
not show while an organization that deactivated you, or one being deleted,
still holds your member seat.

The **Projects** tree lists the projects you can access through your own
access: the projects you lead, those you hold a grant or a team share on,
and the projects above the sub-projects you can open, including projects
shared by other organizations. Your favorites come first, each with a star,
and then the rest, each group by name. A project of another organization
shows that organization's name under its own. You set stars in
[All projects](#all-projects); the star in the tree is a mark, not a button.

The tree loads 25 projects at first and more as you scroll to its end or
press **Load more**, up to 200. Past that it says that more projects are in
**All projects**, with a button that opens it. Select a project to reveal
its sub-projects, 25 at first and more as you scroll or press **Load more**,
up to 100, after which it asks you to search. One project stays expanded at
a time, the one you are in. When you open a project from elsewhere, such as
**All projects**, Search or a link, the tree loads on until it shows that
project and brings its row into view. A project opens at once. Where Qivo
has not yet checked a project you open from a link or the one you had
open last time, the page says it is opening the project, with its name
where Qivo knows it, until it has checked it. It then says so if you can no
longer open it, or that Qivo couldn't open it, with **Retry**. The tree
loads no tasks.

The tree says so when its list is not ready yet, when Qivo could not finish
checking which projects you can see, with **Retry**, and when it checked
only part of them, in which case **Load more** goes on. It says you have no
active projects only once the list has ended empty.

The tree scrolls while navigation and Settings stay visible, without a
scrollbar: use the mouse wheel, a trackpad, touch or the keyboard. A row
that takes focus scrolls into view. Coming back from **Settings**, the tree
shows the projects it held, where you left it.

An organization admin's tree holds the projects they take part in, as
anyone else's, and the Board, the Overview and the Roadmap show them the
same projects as the tree. **Settings › Projects › All projects** lists
every project of the organization, and a project they only manage opens
from there, on its settings page.

A project row's **…** menu opens settings, **Archived tasks** and, for its
lead and organization admins, **New sub-project…**. Sub-project rows have settings and **Archived tasks**.
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

**All projects** in the sidebar, and **Projects** on a phone, open the
project directory. It lists every project you can access through your own
access: the projects you lead, those you hold a grant or a team share on,
and the projects above the sub-projects you can open, including projects
shared by other organizations ([Guest access](./who-sees-what-the-access-model.md#people-outside-your-organization)).
Your favorites come first and then the rest, each by name, 25 top-level
projects a page, with **Previous** and **Next**. A project of another
organization shows that organization's name. The directory loads no tasks;
opening a project loads what its view needs.

The star on a project adds it to your favorites or removes it. Your
favorites are yours alone, in that organization alone. A star changes no
one's access and sends no notification, and it cannot change while the
organization is read-only. The project then moves between the two groups,
here and in the sidebar's **Projects** tree ([Sidebar](#sidebar)).
An archived project, one in Deleted items and one you lost access to leave
the directory and keep their star, which shows again when the project is
restored or your access returns. Removing your seat removes its stars.

**Sub-projects** under a project lists its sub-projects, 25 at first and
more as you scroll or press **Load more**, up to 100, and then asks you to
search. One project's list is open at a time. Selecting a project or a
sub-project opens it at once, as the sidebar does. A project's **…** menu
opens its
**Archived tasks** and, for those who may add one, **New sub-project…**.

The field at the top finds projects and sub-projects by their own names,
every word in any order, ignoring case and accents, so “cafe” finds “Café”.
It asks once you pause typing, 25 results a page with **Previous** and
**Next**, your matching favorites first. Each sub-project shows with its
project, such as “Luma Sensor › Firmware”, and the organization's name is
not searched. Clearing the field lists your projects again from the first
page.

The directory says so when its list is not ready yet, when Qivo could not
finish checking which projects you can see, and when it checked only part of
them, in which case **Next** or **Load more** goes on. It never shows an
empty list for any of these.

An organization admin's directory holds the projects they take part in, as
anyone else's, and so does their sidebar's **Projects** tree. **Settings ›
Projects › All projects** lists every project of the organization.

The Board, the Overview and the Roadmap show one project, one sub-project or
My view ([Which tasks a Board shows](./the-board.md#which-tasks-a-board-shows),
[The Overview](./the-overview-project-health-at-a-glance.md),
[The Roadmap](./the-roadmap.md)). **My view** shows your own tasks across
every project on all three views. An address that once named all projects,
such as `…/board/all`, opens like the view's own address: the project you
opened last once Qivo has checked you can still open it, else the project
list, and a task after it opens nothing. **All projects** in the sidebar
lights only for this directory. A person's **Board** or **Roadmap** button
on Team sync across all projects or a team opens the project list with that
person's filter kept and a line saying whose tasks a pick will show; the
project you choose opens filtered to them
([Team sync](./planning-against-real-capacity.md#team-sync)). A task link
that names no project, such as `…/tasks/qn-12`, keeps the project you are
on or opened last when that project holds the task, and otherwise opens the
task's sub-project ([Links you can share](#links-you-can-share)).

To create a task, open its project first. On a phone, **New task** in the
task list lets you choose its project.

When you can see no active project, Qivo opens on the project list. It says
that you have no active projects and that an organization admin or a
project lead can give you access, as the directory does. **New project**
appears there if you can create projects ([Who can create projects](./organization-and-team-settings.md#who-can-create-projects)).
A project shared with you shows in the list as soon as it is, and opens
when you choose it; Qivo never opens it by itself. Team sync and the Inbox
say that no active projects are shared with you, and that an organization
admin or a project lead can give you access. An organization admin sees,
like anyone, only the projects they take part in, so for an admin the
project list, the directory, Team sync and the Inbox say that they take
part in no active projects and that Settings › Projects › All projects
lists every project of the organization.
Team sync covers your home organization only, so it says the same when you can
see none of that organization's projects, and names the organization if you
belong to more than one ([Team sync](./planning-against-real-capacity.md#team-sync)).

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
Roadmap; Stale and Focus remain Board-only. The Team strip has no **All
projects / This project** toggle here, because My view already spans every
project.

To create a task, use a project's **+** in Swimlanes by project or
Side-by-side boards, or open that project first. A new task starts
unassigned, so Qivo opens its sub-project where you can see and assign it.

## The three views

Qivo saves your last view, the last project or sub-project you opened, your
Focus and your Roadmap window per user on the server. They follow you
across devices and reloads.

Opening Qivo without a page in its address, such as `qivo.io/app`, opens
that project if you can still open it, after a quick check with the server,
and shows nothing of it before that check. Otherwise Qivo asks you to choose
a project from a list of your projects, your favorites first, and when you
can no longer open the project you opened last, it says that the project
is no longer available to you. It never opens another project, **My view**
or all projects by itself. If you switch views before the check answers,
the project opens on the view you chose; if you open another project or My
view, that one opens instead. Opening **My
view**, **All projects** or Team sync does not change the project Qivo
remembers, and neither does reading a task in the Inbox or opening one by
its link. A jump from Team sync or the Inbox to a project's Board or
Roadmap, such as **Open task in board**, remembers that project, as opening
it yourself does. If Qivo could not finish the check, it says so with
**Retry**, which checks again. The top bar stays meanwhile, so the Inbox
and the view you will open are one click away. On a phone, Qivo opens the
Inbox.

## Pages stay as you left them

Each page you open stays loaded while you use Qivo: the Overview, the Board,
the Roadmap, the Inbox, Team sync and the All projects directory. Going back to one shows it
at once, scrolled where you left it, and changes made while it was out of
sight follow right after. All projects shows the page it was on and asks
for it again. The Board checks which tasks it shows again when it
shows, the Overview asks for its figures and lists again, showing the
ones it had meanwhile, and Team sync asks for its meeting again, showing
the one it had meanwhile. All three do the same when you return to a
browser tab or desktop window you had hidden or minimized, where they stop
updating meanwhile. An open task window also stops updating its discussion,
history and details while the tab or window is hidden, and catches up when
you return, keeping what you were writing. Settings pages that update by
themselves, Billing's details among them, do the same. The Overview,
the Board and the Roadmap belong to the
sidebar choice, such as a project or My view. Choosing another one loads
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

Task filters, the Archived tasks search, Inbox and searchable pickers use
the same fragment-matching rule. The project list of **Search in** and
**Archived tasks** matches every word anywhere in a project's own name and
also ignores accents, so “cafe” finds “Café”. Search matches whole words
instead ([Search palette](#search-palette)).

**Assignee** supports multiple people and stays open while you choose. It
lists the people who hold a task in the project you selected, the reviewer
of a task In Review and otherwise its assignee, and nobody else of the
organization, with a search over names and initials and the people you
chose first. It shows and searches no email address.
**Me only** applies the same filter as **My tasks**; **Anyone** removes the
people restriction. My tasks and selected assignees are mutually exclusive.
Both match the reviewer while a task is In Review with one ([Task ownership](./how-work-is-organized.md#the-task)).
**Priority** selects one level. **Stale** selects unfinished tasks untouched
for more than 120 days.

Press **My tasks**, **Stale** or **Focus** again to turn it off. Use the
**×** on Assignee, Priority or the text field to clear that filter.

Filtering hides lanes, tracks and sub-project bands with no matches. Status
columns, the Roadmap grid and a project's milestones remain. In My view a
track the filters hide takes its milestones with it. When nothing matches, use
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
sub-project. An empty search shows nothing.

**Search in** opens a list of your projects, your favorites first and then
the rest, each by name, 25 at a time with **Load more**. Type in it to find any project or sub-project you can open
by its own name, words in any order, ignoring case and accents; each
sub-project shows with its project. A project's arrow shows its
sub-projects. Choose **All projects**, an
organization's **All projects** when you belong to more than one
organization, a project with its sub-projects, or one sub-project, and
Search asks again at once. The choice lasts while Search stays open. The
list shows up to 200 projects and then asks you to search for the rest.
Escape clears the list's search first, then closes the list. An
organization admin's list holds the projects they lead or hold a grant or
team share on, and **All projects** searches those projects, as anyone's.
**Search this sub-project** on a sub-project they cannot open opens Search
on **All projects**.

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
instead. Someone who can open many projects, an organization admin as
anyone, sees the note on every search of a whole organization.

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
stable number that survives renaming. A project link opens once the server
confirms that you can open the project. If you switch views or go elsewhere
before that, Qivo does not open it. A project link you cannot open shows the
project list and says that the project is not available to you. All
projects is `…/projects`, and My view has its own paths, such as
`…/board/mine`. Opening a
task adds `/tasks/qn-482`, so a reload preserves both task and scope.

Copying a task link uses its short permanent address. Opening that link
shows the task at once, read from the server, also before every task has
loaded, and the same goes for a bookmark, a reload and Back or Forward to a
task. A link opens the task in the organization its address names, never
another organization's task with the same number. Opening it keeps the
project you opened last if that project holds the task; otherwise, once the
task has loaded, it opens the task's project. Recipients still need access. A link to an
archived task opens it read-only, with **Restore** for someone who can edit
its project ([Archiving](./the-task-window.md#archiving)). A link to a task
you cannot open says that it can't be opened, the same whether it does not
exist or you have no access to it; if Qivo cannot reach the server, the
window says it couldn't open the task, with **Retry**. Restore deleted tasks
from Deleted items before opening their links.

## Keyboard, in brief

- **Esc** closes the topmost popover, dialog or task window. In a description or
  comment editor it first leaves the text, asking before it discards changes.
- **Enter** submits single-line fields.
- **Ctrl/Cmd+K** links the selected editor text. The editor's other formatting
  and line-break keys are in [The discussion column](./the-task-window.md#the-discussion-column).

Qivo has no other shortcuts. Saving a draft, sending a note, adding a label
and every other action use their buttons.
