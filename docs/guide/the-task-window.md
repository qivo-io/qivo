Open a task to read its discussion and details. The breadcrumb links to its
project and sub-project Boards. Click the title to edit it. The header also
contains the subscription control ([Following tasks](./working-together.md#your-inbox)), permanent ID, **Close**, and an
**…** menu with **Copy task ID**, **Copy link**, **Move to sub-project…**,
**Archive** and **Delete**. Delete requires a second click to confirm.

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
long drafts scroll.

**Comments** use the same editor but accept text only. Add images as
attachments. The composer sits below the newest message, or below the scrolling
Activity feed on phones. Comments and activity run oldest to newest.
**Comments** is the default filter; **All** adds changes such as assignments,
status moves, dates, labels and attachments. Field-change entries show before
and after values, including short description excerpts. A **New** line marks
unread activity ([Your inbox](./working-together.md#your-inbox)).

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

## Moving a task

Choose **Move to sub-project…** to move within the task's organization to a
sub-project you can edit. The task keeps its ID, comments, attachments, labels,
activity and relationships.

The assignee and, for a task without subtasks, reviewer must be active and
have User or Lead access at the destination. Otherwise, clear or change them
before moving. Moving a group clears an ineligible reviewer instead of
refusing the move for that reviewer.

## Archiving

Archiving hides tasks from the Board, Roadmap, Overview, filters and workload
calculations without deleting them or changing their workflow status.

**Automatic archiving** runs nightly for tasks that retain a legacy team
archive setting. Done tasks archive after that threshold, 30 days by default.
New projects without a legacy team setting do not auto-archive yet.

The sweep archives subtasks before their parents. Once a group's active
subtasks are gone, its saved status applies again. A saved Done task can
archive on a later sweep when its original Done age meets the threshold;
a saved To Do task returns to To Do.

**Manual archiving** is available in the task's **…** menu with edit access.
It includes the whole subtask tree. If all descendant work is Done, it archives
immediately. Otherwise, the dialog lists the affected tasks and requires a
reason, which becomes a task comment. REST and MCP archiving do not collect
a reason ([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).

Open **Archived tasks** from a project or sub-project's **…** menu. The Archive
page works with one project at a time, optionally narrowed to a sub-project.
Desktop offers a multi-word search; phones omit it and ignore its text query.

**Restore** returns a task to its Board and restores archived parents when
needed. Restoring a Done task restarts its auto-archive clock where automatic
archiving applies. Archived tasks do not appear in other views, and shared
task links work again only after restoration.
