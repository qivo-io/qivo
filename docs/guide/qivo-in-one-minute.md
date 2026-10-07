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

## Private demo

The homepage's **Demo** button opens `demo.qivo.io`. Select **Create demo
workspace** for a private copy of Northstar Labs with sample projects, tasks
and teammates. Qivo signs you in as Nora without an email address or
password. Opening the welcome page alone creates nothing. Other visitors
receive separate copies, and sharing a task link does not give them access
to yours.

You can edit the sample work, scheduling and team. Demos start with the Blue
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
50 MiB storage allowance. Profile pictures have a 2 MiB limit. **Sign up for
Qivo** opens regular signup without transferring the demo's contents.

## App updates

Qivo announces new versions and reloads after a short pause. It waits while
you have an open draft, pending save or upload, active planning session, or
one-time key or recovery link to copy. It also waits while you use an input
field or the tab is in the background.

**Reload now** becomes available when it is safe to reload and keeps the
current address. **Hide notice** dismisses the notice while you edit; it
returns when your work is finished.

If a view or dialog fails to load, close its recovery message or reload to
retry. A failed dialog leaves the page and other drafts open. Reload stays
disabled while a draft or save needs to finish.

## Desktop app

The optional Windows and Linux apps use your existing account and the hosted
planner. Enable native Inbox notifications in the desktop notification
settings. Selecting one opens the relevant Inbox view.

The app downloads updates in the background and asks before restarting to
install them. Updates wait for active drafts and saves. If you start editing
after the notice appears, it returns when you finish. **Later** defers the
update.

Linux packages include `.deb` for Ubuntu, `.rpm` for Fedora/RHEL and a
portable AppImage.

## Using Qivo on a phone

The bottom navigation has **Inbox**, **My tasks**, **Projects** and **Sync**.
Opening the app without a page link starts in Inbox. Direct links still open
their named page. **Sync** opens Team sync ([Team sync](./planning-against-real-capacity.md#team-sync)), starting on your page when
you own work in its scope. It appears when you belong to an organization.

Use the search icon in the header to find tasks and projects. Phone pages
have no separate text filter and ignore desktop text queries, including in
the landscape Roadmap. Status and other filters remain available, as do
searches inside people, label and relationship pickers.

**My tasks** lists active work before backlog and completed tasks. Choose a
status or open **Filters** to narrow the list. Use **+** to create a task
with the project and sub-project pickers. Project pages also list tasks;
tap one to edit it.

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
