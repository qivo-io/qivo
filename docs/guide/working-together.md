## Who a person is

Each person has a name and email address. An admin adds them in
**Settings → Organization → Users**, and Qivo emails them an invitation. Their
seat shows **invited** until they sign in with that email address, or
**invitation not sent** or **invitation may not have arrived** when the email
did not go out; hover it for the reason. Admins can
correct the email before sign-in, which sends a new invitation; afterward it
is read-only. An organization can send up to 50 invitation emails an hour.
Beyond that, people can still join by creating an account with the invited
address. Agents use keys instead of email addresses ([Agent users](./administration-guard-rails-and-the-demo.md#agent-users)).

To change your name, open **Settings → Your preferences**, edit **Your name**
and press **Save**. This updates your existing seats and pending invitations
across organizations, including your fallback initials. Each affected
organization records the change. Invitations created afterward use the name
the inviter enters.

An organization admin can rename anyone, including agents, in
**Organization → Users**. This changes only that organization's copy.
Changing your own name again updates all your existing copies.

Your profile picture is a picture you upload, or your initials when there
is none. Click **Picture** under **Settings → Your preferences → Profile**,
then **Upload a picture…** or **Change picture…**. Organization admins can
also change pictures in the Users list. **Remove picture** shows your initials
again, or your sample portrait in the demo.

Uploaded pictures are visible to members and invited guests in that
organization. Qivo uses temporary download links, which you should treat as
private. Your browser may cache pictures for your signed-in account.

Other people's changes appear automatically, also while your own changes are
still saving. Your edits appear immediately. If the server refuses an edit,
Qivo undoes only that edit and shows an error, and your other changes stay.

A task's **Activity** lists comments and changes from oldest to newest. Qivo
keeps every change of a task, and **Show earlier activity** loads older ones.
Changes name the
person or agent responsible and show old and new field values. Description
changes include short excerpts. Departed members appear as **Someone**.
Automated task changes identify **via MCP** or **via the REST API**, with the
key name in parentheses for an agent key. Comments carry the author or agent's
name without a separate API label.

## When someone else changed it first

Two people can open the same task and both change it before either sees the
other's change. Qivo checks each field you change against the value you saw
when you changed it. If someone else changed the same field since, Qivo does
not save your change. A notice stays until you close it and says what
changed and, where Qivo knows, who changed it, such as **Not saved. Emil
Berg changed the status of QN-12. Your change was discarded.** If you made
the other change yourself, in another tab or on another device, the notice
says so.

- Qivo checks only the fields you change. Someone else's change to another
  field, such as the assignee while you edit the title, does not stop yours,
  and two people who choose the same value both save.
- Your own quick edits in a row save, such as several changes to the
  remaining time.
- A refused title, description or comment edit stays in its editor, so you
  can copy your text or save it again on purpose to replace the other
  version.
- A Roadmap change that saves several tasks at once, such as **Auto-move**,
  saves all or nothing. If one of its tasks changed since, none of its
  changes are saved.
- Deleting a comment, milestone, label or team that someone changed since
  you saw it is refused too, so you can check it before you delete it again.
  So is removing a link between two tasks after someone changed its kind.
- New tasks and other new records are not checked, because nobody else can
  have changed them yet.

An edit that was waiting to save when your connection dropped is checked
when it reaches Qivo. If someone changed the same field of a task or a
comment in the meantime, the notice says they changed it **while you were
offline**. For other records Qivo does not know when the change was made,
so the notice says only that it changed.

Agents and scripts can ask for the same check through the REST API and MCP
([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).

## Appearance preferences. Themes and the Canvas background

Choose **Dark** or **Light** under
**Settings → Your preferences → Appearance → UI theme**. Dark is the default.
Your choice saves automatically and follows your account across organizations
and devices. If you had chosen the former Blue theme, Qivo shows Dark.

**Canvas** controls the workspace background independently of the theme:

- **Image of the week** is the default. It changes each Monday at 00:00 UTC,
  or when you return to an inactive tab. If no weekly image is available,
  Qivo uses its configured default.
- **Custom image** uses your uploaded image.
- **No image** uses the theme's solid background without requesting an image.

Over an image, panels, cards, windows and menus are tinted glass that lets
the image show through. With **No image** they are solid.

The settings page shows a preview and any available title, location and
creator information for the weekly image.

To upload a background, select **Custom image → Choose your image**. Use
JPEG, PNG or static WebP with these limits:

- At least **1600 × 800 pixels**.
- Aspect ratio from **1.3:1 to 3:1**.
- At most **32 megapixels** and **8 MiB**.

**Replace your image** changes it. **Remove custom image** returns to
**Image of the week**. Selecting Image of the week or No image keeps your
upload for later use. Personal backgrounds stay within your account and do
not appear in Qivo Admin.

Images fill the workspace with a centered crop. Crop controls are unavailable.
The workspace opens while images load and uses a solid background if no image
is available. Your browser may cache your chosen background and preview for
your account. The public demo does not keep this persistent cache.

## Your inbox

Your **Inbox** collects mentions in task descriptions and comments, plus
updates to tasks you subscribe to. Updates include assignments, reviewer
changes, status, priority, title, dates, remaining hours, pauses, moves,
parent changes, archiving by a person or an agent (which arrives already
read), restoring and comments. The nightly automatic archive sends no
update, but it marks the task's messages read like any archive. A task with
subtasks takes its dates, status and remaining hours from them, so a
subtask change that only shifts those values sends no message to the
parent's subscribers.
Your own actions do not notify you. Updates made through the REST API and MCP
also generate messages. Agents, and assistants acting for you, read the inbox
through the REST API and MCP
([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)).
Clearing it and following tasks need a credential that can make changes, so a
Viewer agent can only read the messages it already holds.
Only you can see your inbox. If you lose access to a task, its updates leave
your inbox and you stop receiving new ones. They and your subscription return
if you regain access.

Archiving a task removes its row from everyone's inbox and, moments later,
marks its messages read, including those of the subtasks archived with it.
Archiving a project does the same for its tasks. Updates that arrive while a
task or its project is archived are marked read too. Like other read
messages, retention removes them after your chosen period, and **Remove all
read notifications** removes them at once. Restoring brings back the rows
that remain, with their messages read. A task restored right after its
archive keeps its messages as they were. Restoring a task also sends its
other subscribers a **Restored** update. Parents restored with it send no
**Restored** update. Deleting a task or a project removes its messages, and
restoring it from [Deleted items](./how-work-is-organized.md#deleted-items)
does not bring them back. A task restored from there on its own sends its
other subscribers a **Restored** update; restoring several at once, or a
project, sends none.

**Subscriptions.** Click the eye button in a task window to open
**Subscribers**, then use the eye beside **Me** to subscribe or unsubscribe.
Anyone with access to the task can see its subscriber list, including viewers.

Organization admins and the named project lead can remove other subscribers
with **×** or use **+ Add** to subscribe an active person or Standard user
agent who can access the task. Viewer agents receive no new messages and
cannot be added. People who later lose access remain listed and can be
removed. Managing subscribers does not give access to anyone's inbox.

Qivo subscribes you when you are assigned or handed a task, mentioned on it,
or comment on it. Creating a task alone does not subscribe you. Removing you
as assignee does not unsubscribe you.

A task has at most 100 subscribers. Once it has 100, **+ Add**, and **Me**
for someone not subscribed yet, are disabled with **This task has 100
followers, the most a task can have**. A subscriber can still unsubscribe,
and a comment or a mention no longer subscribes anyone, though mentioned
people still receive their message. A new assignee or reviewer is still
subscribed, so the people working on a task always hear about it. A comment
or description can mention at most 100 people. Qivo refuses to save one that
mentions more, keeps your draft and says **A text can mention at most 100
people; remove some mentions and save again.** Tasks that had more
subscribers before this limit keep them. On such a task, a comment or a
change reaches the first subscribers at once and the rest a few seconds
later. Changes saved for many tasks at once, from the Roadmap, by
reassigning tasks when someone loses access or by detaching the subtasks of
a deleted task, reach every subscriber a few seconds after the save.

A hand-off happens when a task enters **In Review** with you as reviewer, you
become the reviewer during review, or work returns to you as assignee when it
leaves review or loses its reviewer. Hand-offs subscribe you again even after
you unsubscribe. Reviewers receive **Ready for your review**. Setting a
reviewer before review does not subscribe them yet. Tasks with subtasks stay
with their assignee and do not hand over ([Task ownership](./how-work-is-organized.md#the-task)).

**Reading messages.** Each task has one inbox row showing its title, age,
project and sub-project. New updates refresh that row and increase its unread
counter. Opening the row or the task marks its messages read and leaves only
the latest message in the inbox. Further updates start the unread counter
again on the same row. A row keeps at most 50 unread updates. Beyond that,
Qivo drops the oldest ones but keeps the first unread update and the newest
mention, comment and change, and the row says how many it dropped, such as
**12 earlier updates on this task are not listed**. The task's comments and
history still show what those updates were about. On a task with many subscribers it does so
moments after the update arrives. The Inbox loads up to 500 messages, unread ones
first.

The Inbox badge counts tasks with unread updates and shows **99+** above 99.
Read state follows you across devices. Sort by newest or oldest, or filter for unread,
snoozed, mention, comment or change messages. Desktop search includes the
messages grouped in each row and their project names.

On desktop, selecting a row opens the task's discussion pane. Click
**Description** to expand its collapsed description. The pane shows the
current assignee or reviewer, Activity and comment box. Use the pop-out button
for editable details, attachments and links, or **Open task in board** to
visit its Board. The project breadcrumb also links to the Board.

The address follows the selected task, such as `/app/<org>/inbox/tasks/qn-14`,
so saved links and reloads reopen it. **Esc** closes a pop-out first, then the
selected task, then the inbox. New updates on an open task are marked read as
they arrive. A **New** divider marks unread comments and stays in place while
you read. Unread changes without comments show a note instead.

On phones, use **Unread / Mentions / All** and **Filter**. Tap a row to open
the full task, including **Details**. **Back to inbox** restores your list
position. Each row's actions button provides read, snooze and removal
controls. There is no inbox search field on phones; use global search to find
tasks and projects. A desktop inbox search does not filter the phone list.

**Desktop notifications.** In a browser, choose **Enable notifications** in
Inbox to receive a notification for each new event. Clicking one opens Qivo.
In supported Windows and Linux desktop builds, **Settings → User account →
Desktop app → Show notifications** controls native Inbox and update alerts
and is on by default. Turning it off leaves your Inbox messages available.
Your operating system's notification settings also apply.

**Managing messages.** Right-click a row, or use its phone actions button, for
**Open task in board**, **Mark as read / unread** and **Remove notification**.
Read and removal actions apply to all messages in that row.

The Inbox toolbar and context menu also offer:

- **Mark all as read**, including messages outside the current filters,
  search, displayed list and organization. Updates arriving after the action
  starts remain unread.
- **Remove all read notifications**, with the same scope. It preserves
  unread updates, including those on a task with older read messages.

Each action is available while your inbox shows matching updates. It also
stays available when Qivo could not check all your messages, which can
happen when many of them are about tasks you cannot see. Unchecked messages
that are snoozed do not keep it available, because both actions skip them.
Both actions cover messages you cannot see, about archived tasks or tasks
you lost access to.
These actions leave tasks, comments and open drafts intact. The list's
context menu offers them even when a filter shows no messages.

**Snoozing.** In a row's menu, set the number beside **Hours** or **Days**, then
press that row's **Snooze** button. Hover the button to see the return time.
Snoozing marks the task's messages unread, hides the row across your devices
and removes it from the badge count.

At the chosen time, the row returns unread with a desktop notification if
enabled. A new task update brings it back early. **Show snoozed** displays
hidden rows with their return times. Opening one leaves it unread.
**Unsnooze** brings it back immediately. Mark all as read, Remove all read
notifications and automatic retention leave snoozed rows alone.

**Retention.** In **Settings → Your preferences → Inbox → Remove read messages**,
choose 1, 7, 30 or 90 days, or **Never**. New users start at **7 days**. The
period starts when you read the latest message on a task. A nightly cleanup
removes expired read rows without removing unread messages, tasks or comments.
Agents have no settings page, so an agent's read messages are removed after
7 days.
