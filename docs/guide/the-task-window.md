Open a task to read its discussion and details. The breadcrumb links to its
project and sub-project Boards. Selecting one keeps the window open over that
Board and shows the task's card behind it; on a phone it closes the window
and shows the task's row ([Showing a task on the Board](./the-board.md#showing-a-task-on-the-board)). Click the title to edit it. The header also
contains the subscription control ([Following tasks](./working-together.md#your-inbox)), permanent ID, **Close**, and an
**…** menu with **Copy task ID**, **Copy link**, **Move to sub-project…** and
**Archive or delete…**. With edit access, **Archive or delete…** opens one
window for [archiving](#archiving) and [deleting](#deleting) the task.

Desktop shows discussion and details side by side when space allows, or
stacked in a narrower window. On phones, **Activity / Details** tabs sit below
Status and Assignee. Details holds the description, other properties,
attachments and relationships. Switching tabs preserves unsent drafts.

In the desktop Inbox, the task's discussion fills the right pane. Use
**Open task in board** in its menu for the full task window over the Board,
with the task's card shown behind it ([Your inbox](./working-together.md#your-inbox)).

## The discussion column

The **description** supports formatted text, headings, lists, quotes, links
and code. Use the formatting row or type Markdown shortcuts. Formatting
keys include Ctrl/Cmd+B/I/U/E, Ctrl/Cmd+Shift+X and Ctrl/Cmd+K for links.
Shift+Enter or Ctrl/Cmd+Enter starts a new line within a paragraph. Click a
link to open, edit or remove it.

Type **@** to mention someone. Search by partial name, initials or email
fragments, in any order, and choose with arrow keys and Enter or a click.
Mentions in descriptions and comments notify other people in Inbox and
subscribe them to the task.

Paste or drag images into descriptions. Hover for Copy or Download, or
double-click for full size. Inline images cannot be pasted across tasks.
**Save / Discard** appears when the draft changes. Press **Save** to save.
The formatting row and save controls remain visible while long drafts
scroll. Descriptions and comments can hold up to 20,000 characters,
including formatting. Near the limit the editor shows how many
characters the draft holds, and a longer draft cannot be saved until you
shorten it. Older text saved over this limit can be read but not edited.

**Comments** use the same editor but accept text only. Add images as
attachments. The composer sits below the newest message, or below the scrolling
Activity feed on phones. Comments and activity run oldest to newest. A long
discussion opens at its newest 50 comments, and fewer when they are very long.
**Show earlier comments** above the oldest one loads up to 50 more and keeps
your place in the thread. It disappears once the first comment is loaded. If
loading fails, **Retry** asks again. Comments that arrive while the task is
open add to the end, and the earlier ones stay loaded. Edits and deletions
that other people, or your other tabs, make to comments older than the newest
50 show the next time you open the task.

A task holds at most 1,000 comments, counted across everyone who comments
and every way of posting, archive reasons included. At 1,000 Qivo refuses a
new comment and says so. Deleting a comment makes room for one more, and
editing one changes nothing. Only a comment's author or a lead of the task's
project can delete it, so ask a project lead when the comments are not
yours. A task that had more than 1,000 comments before this limit keeps them
all, but takes no new comment until it has fewer than 1,000. You can post at
most 10 comments on one task in any minute, wherever you post them from.
Past that, Qivo says how many seconds to wait before you can post there
again. Deleting a comment does not give that post back, and other people,
and your comments on other tasks, are not affected. On a task created before
Qivo counted comments, a very long discussion can make Qivo ask you to try
again in a minute while it counts them; the count starts at once, so the
next try after that usually works.
The composer keeps your comment until Qivo saves it, and the text cannot
change meanwhile. If Qivo refuses it, for example after you lose edit access,
the text stays for another try. A refused edit stays open with your text too.
If you close the task while Qivo saves a comment and Qivo then refuses it,
Qivo says the comment was discarded. Closing the task, or opening another task
in its window, while a comment, a description edit or a title edit is still
unsent asks first ([App updates](./qivo-in-one-minute.md#app-updates)). If the comments cannot load, for example
after you are signed out or lose access to the organization, the thread says
so with **Retry** instead of looking empty, and the comments already on screen
stay. A task that was deleted or hidden from you shows an empty thread
instead.
**Comments** is the default filter, and loads no changes. **All** adds changes
such as assignments, status moves, dates, labels and attachments, which Qivo
loads when you choose **All**, starting with the newest 50. Until they arrive
the thread says **Loading activity…**, and if they cannot load it says so with
**Retry** instead of showing the comments alone. Going back to **Comments**
stops loading changes. A task keeps all its changes. **Show earlier activity**
above the oldest row loads what comes before it: earlier comments or up to 50
earlier changes, whichever the oldest row needs, or both. Until the first
comment and the first change are loaded, **All** shows only the rows since the
later of the oldest loaded comment and the oldest loaded change, so it never
shows comments beside a gap in the changes, or changes beside a gap in the
comments. A comment you are editing stays on screen either way. Field-change
entries show before and after values, including short description excerpts. A
**New** line marks unread activity, and sits at the top of the loaded comments
when the first unread one is earlier ([Your inbox](./working-together.md#your-inbox)).
When nothing unread is on screen, such as a change under **Comments** or a
comment that was deleted, a note at the end of the thread says there is new
activity. Under **Comments** it adds that changes show only under **All** when
your unread inbox updates include a change or a mention in the description.

You can edit or delete your own comments. Project leads can moderate other
people's comments. The edit indicator shows when and by whom a comment changed,
including a **(project lead)** label when someone other than the author edited it.

Use the pop-out beside **Description** or **Activity** to read that section
in a separate window. It keeps the task's breadcrumb, title and ID, and the
All / Comments filter follows you. A draft does not move between the column
and the window, so opening or closing the window while that section holds
unsent text asks before the text is discarded. Close it with **X** or **Esc**
to return to the task.

## The details column

Details contains priority, reporter, assignee, Remaining, Due and Plan.
Status and reviewer appear only on tasks without active subtasks. Reporter
is read-only. **Remaining** is editable on a task without subtasks and a
read-only **Σ** total on a group ([Task groups](./how-work-is-organized.md#the-task)).

**Plan** always shows its date pickers. Setting a date on an unscheduled task
schedules it. These pickers reject an end later than the due week. Plan also
shows duration and **Plan on roadmap** ([Plan on roadmap](./planning-against-real-capacity.md#plan-on-roadmap)).
On a group, the pickers show the dates from its subtasks and are disabled
with the hint **Dates come from subtasks**. Its button reads
**Show on roadmap**.

Read-only access shows the values but disables editing ([Project access](./who-sees-what-the-access-model.md)).
**Reviewer** uses the same eligible people as Assignee; choose **No reviewer**
to clear it.

Use the buttons beside **Labels**, **Parent**, **Subtasks** and **Linked tasks**
to add or change them. Relationship pickers can create a task if no existing
task matches. Attachments support drag-and-drop and follow the
organization's per-file size limit ([Attachment limits](./organization-and-team-settings.md)).

A task has at most 20 labels, 100 links and 100 attachments, with images in
its description counted as attachments while the description shows them.
Taking an image out of the description and saving frees its place at once,
and an undo that brings the image back within a day keeps it. A task keeps
the 100 images most recently taken out this way. At a limit the control is
disabled with a sentence such as **This task already has 20 labels, the most
a task can have. Remove one first.**,
and the label picker only takes labels off. A file you drop or paste on a
full task is refused before it uploads. A link also needs room on the other
task, so picking a task that has 100 links is refused with a sentence that
names it. The window counts only the links whose other task you can see, so
Qivo can also refuse a link when you make it, naming the task that is full.
A new task you create from the **Linked tasks** picker is then not created
either.

Linked tasks show **Blocks**, **Blocked by** or **Relates to**. When the linked
task is Done, the dependency labels become **Previously blocked** or
**Was blocked by**. Cards show the task's title, project, status and owner;
groups omit status, and unowned tasks omit the portrait.

The **×** button removes a relationship without deleting the task.
**Remove subtask** clears the child's parent and keeps the task.

A task has one level of subtasks: a subtask cannot have subtasks of its own,
and a task has at most 100 active subtasks. Archived subtasks do not count,
so a task whose Done subtasks archive keeps taking new ones. On a subtask,
the **Subtasks** button is disabled with **A subtask cannot have subtasks**,
and when the window lists 100 subtasks with **This task has 100 active
subtasks, the most a task can have. Archive or remove one of them first.** A task with subtasks cannot become a
subtask, so when the window lists any, its **Parent** button is disabled with
**A task with subtasks cannot become a subtask**. The window does not list
archived subtasks, or subtasks you cannot see, so Qivo refuses those choices
when you make them, with the same sentence. **Remove parent** also appears
when the parent is outside this view.

A subtask stays in its parent's project, in any of that project's
sub-projects. Setting a parent changes both tasks, so it needs edit access to
the subtask and to the parent. The parent and subtask pickers offer only
tasks of the same project that you can edit, and leave out tasks the limits
above refuse. The current parent stays listed
so you can remove it, and so does each current subtask you can edit.
Everyone assigned to or reviewing the task or its subtasks must be able to
see the new parent and every task above it; otherwise Qivo refuses the parent and names the person
and the subtask to reassign. The assignee and
reviewer pickers on a subtask offer only people who can see every task above
it. Removing a parent needs edit access to the subtask only. Adding or
removing a link needs edit access to one of the two tasks and access to the
other. If a task's parent is in an archived project or
a project you cannot access, **Parent** says the parent task is outside this
view. Choosing another parent replaces it, and **Remove parent** removes it.

## Moving a task

Choose **Move to sub-project…** to move within the task's organization to a
sub-project you can edit. The task keeps its ID, comments, attachments, labels,
activity, links and subtasks. Its review hand-off and the time it became Done
start again at the move, for the task and each subtask that moves with it.
A Remaining estimate that stays with the task keeps its measurement time, so
the move does not restart its
[delay projection](./will-it-be-ready-in-time-the-delay-status.md#how-the-projection-works).

A move between sub-projects of the same project moves only the task. A move
to a sub-project of another project also moves the task's subtasks,
archived ones included, unless they are already in that project.
A subtask moved to another project stops being a subtask of its parent,
because a subtask stays in its parent's project. The dialog says both before
you move. Qivo refuses the move if a subtask that would move is in a
sub-project you cannot edit (an organization admin can move it), or if the
task has more than 200 subtasks, archived ones included. Restore some
archived subtasks from **Archived tasks** and remove them from the task
first, or move the task within its project. A move or a new parent is also refused in
the rare case that the task and its subtasks are too large to change at
once.
While a subtask that would move is in a project being moved to Deleted
items, Qivo refuses the move for everyone until that move finishes.

The assignee and, for a task without subtasks, reviewer must be active and
have User or Lead access at the destination. Otherwise, clear or change them
before moving. The same holds for each active subtask that moves with the
task. Moving a group clears an ineligible reviewer instead of refusing the
move for that reviewer. Everyone assigned to or reviewing a subtask that
stays where it is needs at least View access at the
destination, so they can still see the task. The dialog names each person
who would lose access and keeps **Move** disabled until you give them access
or reassign their subtask. A subtask in a project you cannot see is checked when you
move, and Qivo refuses the move without naming the person. Switched-off
people are not checked on the subtasks that stay.

## Archiving

Archiving hides tasks from the Board, Roadmap, Overview, filters and workload
calculations without deleting them or changing their workflow status.

**Automatic archiving** runs nightly. A task archives once it has been Done
for 30 days. Moving a Done task to another sub-project
starts this count again, for the task and each subtask that moves with it.
It sends no inbox update. The task's messages are marked read as with any
archive.

The sweep archives subtasks before their parents. A Done subtask moved to
another sub-project of the same project starts its count again, so its Done
parent archives no earlier than the night after that subtask archives, even
if the parent itself did not move. Once a group's active subtasks are gone, its saved status
applies again. A saved Done task can archive on a later sweep when its Done
age meets the threshold; a saved To Do task returns to To Do.

**Manual archiving** uses **Archive or delete…** in the task's **…** menu,
which needs edit access. **Archive** is selected first. For a task with
subtasks, the window lists them, and a box such as **Also archive the 3
subtasks**, selected first, archives the whole subtask tree, including
subtasks in other sub-projects. Qivo refuses that when one of them is in a
project you cannot edit, and an organization admin can archive the whole tree
instead. While one of them is in a project being moved to Deleted items, Qivo
refuses it for everyone until that move finishes. Qivo also refuses the whole
tree when the task and its subtasks are too large to change at once, such as
dozens of subtasks with very long descriptions. Clear the box to archive
only the task. Its subtasks stay in their
projects, those directly under it become top-level tasks, and restoring the
task later does not bring them back under it.

Archiving unfinished work requires a reason, which becomes a task comment.
Because it is a comment, it follows the comment limits above. On a task with
1,000 comments, or after you posted 10 comments there within a minute, Qivo
archives nothing and says why, and the window keeps your reason and choices
for another try. Archiving without a reason, where that is allowed, still
works, so at 1,000 comments you can mark the work Done and archive it without
a reason, or ask a project lead to delete comments.
The reason, for an archive or a delete, holds at most 500 characters. A
Done task with no unfinished work going with it needs none. REST and MCP
archiving always include the subtasks. They accept the same optional reason,
which also becomes a comment, but do not require one
([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).

Open **Archived tasks** from a project or sub-project's **…** menu, or from
**Settings → Projects → Archived tasks**. The page lists one project with its
sub-projects, or one sub-project. To see every project of an organization,
choose **All projects** in the project list; the page never starts there.
It lists the projects you can see that are not archived. A sub-project
archived on its own, and an archived project, show their tasks again once
they are restored. The page shows 25 tasks at a time, newest archived
first, and **Next** and **Previous** move between pages. The line above the
list says which tasks the page shows, such as **Archived tasks 26 to 50**,
and the last page says these are the oldest.

The search, on desktop and phones, looks through every archived task of
that choice by task ID, title, description, status, priority, assignee and
label, with words in any order. A search reads a large archive in steps,
and each page shows the matches found in its step. When a step stops before
the end, the page says how many archived tasks it has searched, and
**Search older tasks** continues from there. Only a search that has read
every archived task says that nothing matches. To find your tasks, a step
may read the whole organization's archive, as for **All projects** when you
can see very many projects, and for a project with very many sub-projects.
Such a step can stop before it finds one of yours, and the page then shows
no tasks and still offers **Next**.

**Restore** returns a task to its Board and restores archived parents when
needed. The task leaves the list at once, and the page asks for its tasks
again, so the next archived task moves up into it. A task someone else
restores leaves the list too. A subtask whose parent already has 100 active subtasks comes back as
a top-level task, and Qivo says so. Its followers are told it left its
parent, and you can give it a parent again once there is room, as a restore
from Deleted items does. If a restore would change a parent task in a
project you cannot edit, Qivo
refuses the restore, and an organization admin can restore it instead.
While the parent's project is being moved to Deleted items, Qivo refuses
the restore for everyone until the move finishes.
Parents restored this way send no **Restored** update. Restoring a Done task
restarts its auto-archive clock. Archived tasks do not appear in other views,
and shared task links work again only after restoration.

When someone else archives a task you have open, its window stays and says
the task was archived. If you can edit its project, **Restore** in the
window brings the task back into it. Otherwise the window says that someone
who can edit the project can restore it from Archived tasks. A task that is
deleted while you have it open, or that you can no longer open, says it is
no longer here. If Qivo cannot check the archive, the window says so, and
**Retry** checks again. Text you typed in the window and did not send, such
as a comment, a new title or remaining hours, is discarded then, and Qivo
says so. A reason you typed in **Archive or delete…** stays in the window,
which says it was not used, and **Copy reason** copies it. Once the task is
back, the next **Archive or delete…** starts with that reason. If the task
was already archived when you chose **Archive**, Qivo says that your reason
was not used. While the board still shows the task, **Archive or delete…**
stays open with your reason, and once the task leaves the board, the window
keeps the reason the same way.

## Deleting

Choose **Archive or delete…** in the task's **…** menu, then **Delete**. It
moves the task to [Deleted items](./how-work-is-organized.md#deleted-items)
with its comments, attachments, links and labels, and you can restore it from
there. It needs edit access to the task's project. An optional reason is
shown in Deleted items. The button names what goes, such as **Delete QN-142**
or **Delete 4 tasks**.

For a task with subtasks, the window lists them first. A box such as **Also
delete the 3 subtasks**, selected first, deletes the listed subtasks you can
edit. Subtasks marked **View only**, in projects where you can read but not
edit, are not deleted. Neither are subtasks in projects you cannot open,
because you have no access or the project is archived, nor archived subtasks.
Clear the box to delete only the task. A subtask whose parent is deleted, and
that is not deleted itself, stays in its project and becomes a top-level
task; archived subtasks follow a moment after the delete. Restoring the
parent does not bring it back under it. People following it are told
moments later that its parent was removed.

If the subtasks change while the window is open, it shows the new list and
asks again. The window stays open until Qivo has saved the archive or delete,
and a refusal leaves it open. Deleting a task removes its
inbox messages ([Your inbox](./working-together.md#your-inbox)). REST and MCP
deletes also go to Deleted items and keep the subtasks
([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).
