Your organization contains projects, each with sub-projects where tasks live.
Select a project in the sidebar, **All projects** for everything you can
access, or **My view** for your own tasks ([My view](./finding-your-way-around.md#my-view)). Each scope has three views:

- **Overview** summarizes progress, risks and milestones.
- **Board** groups tasks by status.
- **Roadmap** schedules tasks by week and shows each person's workload in
  the **Team** strip.

To plan work, create a task, add an assignee, remaining hours and a due date,
then drag its bar on the Roadmap. The assignee can be a person or an agent
user connected through REST or MCP ([Automation and AI](./automation-ai-the-rest-api-and-the-mcp-server.md)). Qivo updates the plan as you edit
and flags projected delays. Other users see saved changes live.

Views and dialogs may show **Loading…** the first time you open them.

If your organization uses Microsoft and sign-in asks for admin approval, see
[Microsoft sign-in and administrator approval](./microsoft-sign-in-and-administrator-approval.md).

## Private demo

The homepage's **Demo** button opens `demo.qivo.io`. Select **Create demo
workspace** for a private copy of Northstar Labs with sample projects, tasks
and teammates. Qivo signs you in as Nora without an email address or
password. Opening the welcome page alone creates nothing. Other visitors
receive separate copies, and sharing a task link does not give them access
to yours.

You can edit the sample work, scheduling and team. Demos start with the Dark
theme and **Image of the week** as the Canvas background, using the default
photo if no weekly image is assigned. Change these in **Settings → Your
preferences**.

The banner shows the time left in your 24-hour demo. Returning in the same
browser resumes it without extending the deadline. At expiry, access ends
and the server removes the workspace and temporary login, even if the
browser is closed. Cleanup may take additional time. **Try again** creates a
fresh copy. Clearing browser storage loses the login, which cannot be
recovered by email.

If the demo takes more than 30 seconds to open, use **Retry** on the
connection message. This keeps the current login and deadline.

Sample people are fictional and cannot sign in. Agent connections, API
credentials and additional workspaces require a regular account. Demo
attachments and background images have a 5 MiB file limit and share a
50 MiB storage allowance. Files of deleted tasks count toward it until you
delete them for good in **Settings → Projects → Deleted items**
([Deleted items](./how-work-is-organized.md#deleted-items)). Profile pictures
have a 2 MiB limit. **Sign up for
Qivo** opens regular signup without transferring the demo's contents.

## App updates

Qivo announces new versions and reloads after a short pause. It waits while
you have an open draft, pending save or upload, active planning session, or
one-time key or recovery link to copy. It also waits while you use an input
field or the tab is in the background.

**Reload now** becomes available when it is safe to reload and keeps the
current address. **Hide notice** dismisses the notice while you edit; it
returns when your work is finished.

Shortly after your workspace opens, Qivo downloads every view and dialog, so
they still open if the connection drops later. One you open while the
connection is down, before it has downloaded, says you're offline and opens
once the connection is back. If a view or dialog fails to download, it offers
**Reload**, the only way to retry it. Closing its message takes you back and
leaves the page and other drafts open. Reload stays disabled while a draft or
save needs to finish.

If Qivo can't load the latest changes, a notice says so and shows when your
view was last current. Editing pauses until the changes load again, and Qivo
keeps trying. **Try again** asks right away, and **Details** shows the error
to pass on to support. Text you were typing stays in its field. A change
Qivo had already sent when the notice appeared still saves and stays on
screen, unless the notice says you were signed out or lost access. An upload
still under way stops and says why. Marking
messages read and your own preferences still save. You can still revoke keys
and tokens, and admins can still deactivate or remove people. If you were
signed out, the notice offers **Reload** to sign in again. Until then nothing
in the workspace saves, and a change you try says you are signed out instead of
appearing. View preferences still change on this device. Losing your internet
connection does not sign you out, unless your sign-in expires meanwhile. If an
admin removes or deactivates you and you belong to no other organization, the notice says you
no longer have access and offers **Reload**. Your view stays as it was, but
comments and images that were not already on screen no longer load, and
attached files no longer download. Nothing in the workspace saves, read marks
and preferences included. You can still change your appearance and delete
connected apps.

If you lose your internet connection, or saving takes much longer than usual, a
notice says so and editing pauses, read marks included. A change you try says why
instead of appearing, and text you were typing stays in its field. Qivo saves
nothing on your device to send later, because others may change the same tasks
meanwhile. Changes you made just before the connection dropped still save once
Qivo reconnects, and the notice counts them until then. When the connection is
back and those changes are saved, Qivo says so and editing continues. View
preferences still change on this device and save once the connection is back.

If you close or reload Qivo while a change is not saved yet, or while a field
holds text you haven't saved, your browser asks before it leaves. The desktop app
asks with **Leave** or **Stay**. Qivo does not sign you out while a change is not
saved yet. If Qivo closes before it can ask, after a crash for example, the next start
names the tasks with changes it could not confirm, so you can check them. For
that, your browser keeps a note of each change until the server answers. The note
holds the task's number and what kind of change it was, never what you typed.
Signing out clears it. Qivo reports a note however old it is, unless it
belongs to an organization you no longer belong to; such a note is dropped
after 30 days, because Qivo can no longer show you those tasks.

Closing a window or dialog that holds text you haven't sent, such as a comment,
a description edit or a new task's title, asks first. So does opening another
task in the task window, moving elsewhere in Qivo or going back in your browser.
**Keep editing** returns to the text, and **Discard** closes the window and the
text is gone. **Esc** on a description or comment editor's buttons asks the same,
and there **Discard** clears only that text. A dialog's **Cancel** and an editor's
**Discard changes** throw the text away without asking. A field that saves when
you leave it, such as a task's title or remaining hours, saves first, so Qivo
asks about it only when that save could not happen, for example while editing
pauses.

## Desktop app

Windows and Linux desktop apps are in development and not available to
download yet. Use Qivo in a browser at https://qivo.io/app in the meantime.

In supported desktop test builds, **Settings → User account → Desktop app**
appears below **Your preferences**. **Start Qivo at logon**, **Close to tray**
and **Show notifications** start enabled. **Minimize to tray** starts disabled:

- **Start Qivo at logon** starts Qivo in the system tray when you sign in to
  your computer. Opening Qivo yourself shows its window.
- **Close to tray** keeps Qivo running when you close its window. Turn it off
  to quit on close. Use **Quit Qivo** in the tray menu to quit at any time.
- **Minimize to tray** hides Qivo in the tray when you minimize its window.
  When it is off, minimizing keeps Qivo in the taskbar.
- **Show notifications** controls desktop alerts for Inbox messages and app
  updates. It does not remove Inbox messages or in-app update notices.

These settings apply to this computer. The desktop window has no application
menu row. Linux requires a desktop environment with tray support to show the
tray icon. The Linux app does not check spelling.

## Using Qivo on a phone

The bottom navigation has **Inbox**, **My tasks**, **Projects** and **Sync**.
Opening the app without a page link starts in Inbox. Direct links still open
their named page. **Sync** opens Team sync ([Team sync](./planning-against-real-capacity.md#team-sync)), starting on your page when
you own work in its scope. It appears when you belong to an organization.

Use the search icon in the header to find tasks and projects. Phone pages
have no separate text filter and ignore desktop text queries, including in
the landscape Roadmap. The exceptions are **Archived tasks** and **Deleted
items** in Settings, which keep their search boxes. Status and other filters
remain available, as do searches inside people, label and relationship
pickers.

**My tasks** lists active work before backlog and completed tasks. Choose a
status or open **Filters** to narrow the list. In a very long list, rows
below the first screen appear in the first moments after it opens, in shaded
space; searching the page or printing loads them all first. Use **+** to
create a task with the project and sub-project pickers. Project pages also
list tasks; tap one to edit it.

**Projects** lists projects, sub-projects and **People & settings**. In
project settings, **Manage people** opens user, team and email invitation
controls. Project actions also include sub-project creation and archived
tasks. Your permissions determine which actions are available.

**Overview** shows sortable health cards. **Roadmap** starts on milestones;
**Task schedule** lists planned and unplanned work. Backlog is hidden, and
Done appears only when its planned period overlaps the Roadmap window ([The Roadmap](./the-roadmap.md)).
**Timeline & team** opens a full-screen landscape view, turned sideways
while the phone is upright. Rotate the phone to read it upright; you do not
need to unlock screen rotation. Planning, dependencies, date-window controls
and team utilization remain available.

**Back to agenda** or browser Back returns to the same agenda section and
planned/unplanned filter. Back cancels an active **Plan on roadmap** session
and restores its original dates. Confirm the plan first to keep your changes.

Tap your portrait for **Settings**. Preferences, organization settings,
project settings and user profiles open as pages with **Back** controls.
Under **Your preferences**, Profile, Appearance, Inbox and MCP access have
separate pages.
