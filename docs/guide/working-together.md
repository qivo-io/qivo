## Who a person is

Each person has a name and email address. An admin adds them in
**Settings → Organization → Users**. Their seat shows **invited** until they
sign in with that email address. Admins can correct the email before sign-in;
afterward it is read-only. Agents use keys instead of email addresses ([Agent users](./administration-guard-rails-and-the-demo.md#agent-users)).

To change your name, open **Settings → Your preferences**, edit **Your name**
and press **Save**. This updates your existing seats and pending invitations
across organizations, including your fallback initials. Each affected
organization records the change. Invitations created afterward use the name
the inviter enters.

An organization admin can rename anyone, including agents, in
**Organization → Users**. This changes only that organization's copy.
Changing your own name again updates all your existing copies.

Your profile picture uses the first available source:

1. **An uploaded picture.** Click **Picture** under
   **Settings → Your preferences → Profile**, then **Upload a picture…** or
   **Change picture…**. Organization admins can also change pictures in the
   Users list. **Remove picture** restores the fallback below.
2. **[Gravatar](https://gravatar.com).** Qivo looks up the picture linked to
   your email using a hash, without sending the email itself. Gravatar
   pictures are public.
3. **Your initials** when no picture is available.

Uploaded pictures are visible to members and invited guests in that
organization. Qivo uses temporary download links, which you should treat as
private. Your browser may cache pictures for your signed-in account.

**Profile pictures from Gravatar** in **Organization → General** is on by
default. Turning it off stops Gravatar lookups for that organization and
leaves uploaded pictures intact.

Other people's changes appear automatically. Your edits appear immediately;
if the server refuses an edit, Qivo restores the previous value and shows an
error.

A task's **Activity** lists comments and changes from oldest to newest.
Changes name the person or agent responsible and show old and new field
values. Description changes include short excerpts. Departed members appear
as **Someone**. Automated task changes identify **via the REST API (key name)**
or **via MCP**. Comments carry the author or agent's name without a separate
API label.

## Appearance preferences. Themes and the Canvas background

Choose **Blue**, **Dark** or **Light** under
**Settings → Your preferences → Appearance → UI theme**. Blue is the default.
Your choice saves automatically and follows your account across organizations
and devices.

**Canvas** controls the workspace background independently of the theme:

- **Image of the week** is the default. It changes each Monday at 00:00 UTC,
  or when you return to an inactive tab. If no weekly image is available,
  Qivo uses its configured default.
- **Custom image** uses your uploaded image.
- **No image** uses the theme's solid background without requesting an image.

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
parent changes, archiving, restoring and comments. Your own actions do not
notify you. Updates made through the REST API and MCP also generate messages.
Only you can see your inbox.

**Subscriptions.** Click the eye button in a task window to open
**Subscribers**, then use the eye beside **Me** to subscribe or unsubscribe.
Anyone with access to the task can see its subscriber list, including viewers.

Organization admins and the named project lead can remove other subscribers
with **×** or use **+ Add** to subscribe an active user or agent who can access
the task. People who later lose access remain listed and can be removed.
Managing subscribers does not give access to anyone's inbox.

Qivo subscribes you when you are assigned or handed a task, mentioned on it,
or comment on it. Creating a task alone does not subscribe you. Removing you
as assignee does not unsubscribe you.

A hand-off happens when a task enters **In Review** with you as reviewer, you
become the reviewer during review, or work returns to you as assignee when it
leaves review or loses its reviewer. Hand-offs subscribe you again even after
you unsubscribe. Reviewers receive **Ready for your review**. Setting a
reviewer before review does not subscribe them yet. Tasks with subtasks stay
with their assignee and do not hand over ([Task ownership](./how-work-is-organized.md#the-task)).

**Reading messages.** Each task has one inbox row showing its title, age,
project and sub-project. New updates refresh that row and increase its unread
counter. Opening the row or the task marks its messages read and leaves only
the latest message in the inbox. The task's Activity keeps the history.
Further updates start the unread counter again on the same row.

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

**Desktop notifications.** Choose **Enable notifications** in Inbox to
receive a notification for each new event. Clicking one opens Qivo. The
Windows/Linux desktop app uses operating-system notifications, with its own
permission controls.

**Managing messages.** Right-click a row, or use its phone actions button, for
**Open task in board**, **Mark as read / unread** and **Remove notification**.
Read and removal actions apply to all messages in that row.

The Inbox toolbar and context menu also offer:

- **Mark all as read**, including messages outside the current filters,
  search, displayed list and organization. Updates arriving after the action
  starts remain unread.
- **Remove all read notifications**, with the same scope. It preserves
  unread updates, including those on a task with older read messages.

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
