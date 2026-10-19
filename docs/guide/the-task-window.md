Open a task to read its discussion and details. The breadcrumb links to its
project and sub-project Boards. Click the title to edit it. The header also
contains the subscription control ([Following tasks](./working-together.md#your-inbox)), permanent ID, **Close**, and an
**…** menu with **Copy task ID**, **Copy link**, **Move to sub-project…** and
**Archive or delete…**. With edit access, **Archive or delete…** opens one
window for [archiving](#archiving) and [deleting](#deleting) the task.

Desktop shows discussion and details side by side when space allows, or
stacked in a narrower window. On phones, **Activity / Details** tabs sit below
Status and Assignee. Details holds the description, other properties,
attachments and relationships. Switching tabs preserves unsent drafts.

In the desktop Inbox, the task's discussion fills the right pane. Use
**Open task in board** in its menu for the full task window ([Your inbox](./working-together.md#your-inbox)).

## The discussion column

The **description** supports formatted text, headings, lists, quotes, links
and code. Use the formatting row or type Markdown shortcuts. Keyboard
shortcuts include Ctrl/Cmd+B/I/U/E, Ctrl/Cmd+Shift+X and Ctrl/Cmd+K for links.
Click a link to open, edit or remove it.

Type **@** to mention someone. Search by partial name, initials or email
fragments, in any order, and choose with arrow keys and Enter or a click.
Mentions in descriptions and comments notify other people in Inbox and
subscribe them to the task.

Paste or drag images into descriptions. Hover for Copy or Download, or
double-click for full size. Inline images cannot be pasted across tasks.
**Save / Discard** appears when the draft changes. Press **Save** or
Ctrl/Cmd+S to save. The formatting row and save controls remain visible while
long drafts scroll. Descriptions and comments can hold up to 20,000
characters, including formatting. A longer draft cannot be saved until you
shorten it. Older text over this limit can be read but not edited.

**Comments** use the same editor but accept text only. Add images as
attachments. The composer sits below the newest message, or below the scrolling
Activity feed on phones. Comments and activity run oldest to newest. A long
discussion opens at its newest 50 comments, and fewer when they are very long.
**Show earlier comments** above the oldest one loads up to 50 more and keeps
your place in the thread. It disappears once the first comment is loaded. If
loading fails, **Retry** asks again. Comments that arrive while the task is
open add to the end, and the earlier ones stay loaded. Edits and deletions
that other people, or your other tabs, make to comments older than the newest
50 show the next time you open the task. A task holds at most 400 comments.
Once it has 400, Qivo refuses new ones, so start a new task to continue. An
archive reason is still posted.
The composer keeps your comment until Qivo saves it, and the text cannot
change meanwhile. If Qivo refuses it, for example on a task with 400 comments,
the text stays for another try. A refused edit stays open with your text too.
If you close the task while Qivo saves a comment and Qivo then refuses it,
Qivo says the comment was discarded. If the comments cannot load, for example
after you are signed out or lose access to the organization, the thread says
so with **Retry** instead of looking empty, and the comments already on screen
stay. A task that was deleted or hidden from you shows an empty thread
instead. The changes under **All** load with the comments and behave the same
way.
**Comments** is the default filter; **All** adds changes such as assignments,
status moves, dates, labels and attachments. Until the first comment is
loaded, **All** shows only the changes since the oldest loaded comment. Each
task keeps its newest 500 changes, and changes to other tasks never remove
them. Field-change entries show before and after
values, including short description excerpts. A **New** line marks unread
activity, and sits at the top of the loaded comments when the first unread one
is earlier ([Your inbox](./working-together.md#your-inbox)).

You can edit or delete your own comments. Project leads can moderate other
people's comments. The edit indicator shows when and by whom a comment changed,
including a **(project lead)** label when someone other than the author edited it.

Use the pop-out beside **Description** or **Activity** to read that section
in a separate window. It keeps the task's breadcrumb, title and ID. The same
draft and All / Comments filter follow you, so there is only one editor for
each section. Close it with **X** or **Esc** to return to the task.

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
to add or change them. **L** opens the label picker. Relationship pickers can
create a task if no existing task matches. Attachments support drag-and-drop
and follow the organization's per-file size limit ([Attachment limits](./organization-and-team-settings.md)).

Linked tasks show **Blocks**, **Blocked by** or **Relates to**. When the linked
task is Done, the dependency labels become **Previously blocked** or
**Was blocked by**. Cards show the task's title, project, status and owner;
groups omit status, and unowned tasks omit the portrait.

The **×** button removes a relationship without deleting the task.
**Remove subtask** clears the child's parent and keeps the task.

A task has one level of subtasks: a subtask cannot have subtasks of its own,
and a task has at most 100 subtasks, archived ones included. On a subtask,
the **Subtasks** button is disabled with **A subtask cannot have subtasks**,
and when the window lists 100 subtasks with **This task has 100 subtasks,
the most a task can have**. A task with subtasks cannot become a subtask, so
when the window lists any, its **Parent** button is disabled with **A task
with subtasks cannot become a subtask**. The window does not list archived
subtasks, so Qivo refuses those choices when you make them, with the same
sentence. Tasks nested deeper, or with more subtasks, before these limits
keep their shape, and you can still detach them: **Remove parent** also
appears when the parent is outside this view.

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
activity, links and subtasks.

A move between sub-projects of the same project moves only the task. A move
to a sub-project of another project also moves the task's subtasks, at any
depth and archived ones included, unless they are already in that project.
A subtask moved to another project stops being a subtask of its parent,
because a subtask stays in its parent's project. The dialog says both before
you move. Qivo refuses the move if a subtask that would move is in a
sub-project you cannot edit (an organization admin can move it), or if the
task has more than 200 subtasks at any depth, archived ones included. A
move or a new parent is also refused when the task and its subtasks are too
large to change at once, such as with thousands of subtasks or attachments.
While a subtask that would move is in a project being moved to Deleted
items, Qivo refuses the move for everyone until that move finishes.

The assignee and, for a task without subtasks, reviewer must be active and
have User or Lead access at the destination. Otherwise, clear or change them
before moving. The same holds for each active subtask that moves with the
task. Moving a group clears an ineligible reviewer instead of refusing the
move for that reviewer. Everyone assigned to or reviewing a subtask that
stays where it is, at any depth, needs at least View access at the
destination, so they can still see the task. The dialog names each person
who would lose access and keeps **Move** disabled until you give them access
or reassign their subtask. A subtask in a project you cannot see is checked when you
move, and Qivo refuses the move without naming the person. Switched-off
people are not checked on the subtasks that stay.

## Archiving

Archiving hides tasks from the Board, Roadmap, Overview, filters and workload
calculations without deleting them or changing their workflow status.

**Automatic archiving** runs nightly. A task archives once it has been Done
for 30 days. An older project that kept a team archive setting uses that
setting's number of days instead. It sends no inbox update. The task's
messages are marked read as with any archive.

The sweep archives subtasks before their parents. Once a group's active
subtasks are gone, its saved status applies again. A saved Done task can
archive on a later sweep when its original Done age meets the threshold;
a saved To Do task returns to To Do.

**Manual archiving** uses **Archive or delete…** in the task's **…** menu,
which needs edit access. **Archive** is selected first. For a task with
subtasks, the window lists them, and a box such as **Also archive the 3
subtasks**, selected first, archives the whole subtask tree, including
subtasks in other sub-projects. Qivo refuses that when one of them is in a
project you cannot edit, and an organization admin can archive the whole tree
instead. While one of them is in a project being moved to Deleted items, Qivo
refuses it for everyone until that move finishes. Qivo also refuses the
archive when the task and its subtasks are too large to archive at once,
which only a task with very many subtasks from before the subtask limits
can be. Clear the box to archive only the task. Its subtasks stay in their
projects, those directly under it become top-level tasks, and restoring the
task later does not bring them back under it.

Archiving unfinished work requires a reason, which becomes a task comment. A
Done task with no unfinished work going with it needs none. REST and MCP
archiving always include the subtasks. They accept the same optional reason,
which also becomes a comment, but do not require one
([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).

Open **Archived tasks** from a project or sub-project's **…** menu, or from
**Settings → Projects → Archived tasks**. The page works with one project at
a time, optionally narrowed to a sub-project. Its search, on desktop and
phones, looks through every archived task of that project by task ID, title,
description, status, priority, assignee and label, with words in any order.
A search reads a large archive in steps. When a step stops before the end,
the page says how many archived tasks it has searched, and **Search older
tasks** continues. Without a search, the newest archived tasks come first,
and **Show 100 older tasks** loads the next 100.

**Restore** returns a task to its Board and restores archived parents when
needed. If that would change a parent task in a project you cannot edit, Qivo
refuses the restore, and an organization admin can restore it instead.
While the parent's project is being moved to Deleted items, Qivo refuses
the restore for everyone until the move finishes.
Parents restored this way send no **Restored** update. Restoring a Done task
restarts its auto-archive clock. Archived tasks do not appear in other views,
and shared task links work again only after restoration.

## Deleting

Choose **Archive or delete…** in the task's **…** menu, then **Delete**. It
moves the task to [Deleted items](./how-work-is-organized.md#deleted-items)
with its comments, attachments, links and labels, and you can restore it from
there. It needs edit access to the task's project. An optional reason is
shown in Deleted items. The button names what goes, such as **Delete QN-142**
or **Delete 4 tasks**.

For a task with subtasks, the window lists them first. A box such as **Also
delete the 3 subtasks**, selected first, deletes the listed subtasks you can
edit, at any depth. Subtasks marked **View only**, in projects where you can read but not
edit, are not deleted. Neither are subtasks in projects you cannot open,
because you have no access or the project is archived, nor archived subtasks.
Clear the box to delete only the task. A subtask whose parent is deleted, and
that is not deleted itself, stays in its project, becomes a top-level task and
keeps its own subtasks. Restoring the parent does not bring it back under it.
People following it are told its parent was removed.

If the subtasks change while the window is open, it shows the new list and
asks again. The window stays open until Qivo has saved the archive or delete,
and a refusal leaves it open. Deleting a task removes its
inbox messages ([Your inbox](./working-together.md#your-inbox)). REST and MCP
deletes also go to Deleted items and keep the subtasks
([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).
