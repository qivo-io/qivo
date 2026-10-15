Connect an assistant through MCP or use REST for scripts. Both act as a Qivo
user with that user's project permissions ([User roles](./administration-guard-rails-and-the-demo.md#four-ways-to-be-a-user)). External connections require
a regular account; the private demo is browser-only.

MCP offers `list_tasks`, `get_task`, `create_task`, `update_task`,
`delete_task`, `set_task_link`, `list_labels`, `set_label`,
`delete_attachment`, `list_task_activity` and `get_workload`. REST uses
`/v1/tasks`, `/v1/tasks/{ref}`, `/v1/tasks/{ref}/links`,
`/v1/tasks/{ref}/attachments`, `/v1/tasks/{ref}/activity`, `/v1/labels` and
`/v1/workload`. Both work with the same tasks and permanent `QN-<number>`
IDs, and both can create subtasks, move tasks between sub-projects, link
tasks, add or remove labels, list and delete attachments, read a task's
history and read planned hours per person by the same rules as the app.
Uploading attachments uses REST. Images inside descriptions stay in the app.

Both can also edit and delete comments, follow tasks and work through the
inbox ([Your inbox](./working-together.md#your-inbox)). MCP uses
`update_comment`, `delete_comment`, `set_following`, `list_inbox` and
`update_inbox`. REST uses `/v1/comments/{id}`, `/v1/tasks/{ref}/following`
and `/v1/inbox`. A Standard user agent reads and clears its own inbox this
way. A Viewer agent gets no new inbox messages and cannot follow tasks or
clear its inbox, but it can still read messages it received before. An
Inactive agent can neither read nor clear its inbox.

For projects, MCP offers `get_project`, `create_project`, `update_project`,
`set_project_access`, `set_milestone` and `delete_milestone`, and REST uses
`/v1/projects`, `/v1/projects/{ref}/access` and
`/v1/projects/{ref}/milestones`. Both create projects and sub-projects,
change their settings, archive and restore them, add and change milestones
and change sharing one user or team at a time, by the same rules as the app
([Creating projects and sub-projects](./who-sees-what-the-access-model.md#creating-projects-and-sub-projects)).
A **Standard user** agent creates top-level projects like a standard user
when [Who can create projects](./organization-and-team-settings.md#who-can-create-projects)
allows it, and a **Viewer** agent never does. Only a person can change
sharing or hand over a lead; an agent cannot, even for a project it leads. Removing someone's access takes a choice for the
open tasks they would lose sight of, like the app's removal window.

For teams, MCP offers `list_teams`, `set_team` and `set_team_member`, and
REST uses `/v1/teams` and `/v1/teams/{id}/members`. Both list teams with their
members and leaders, create and rename teams, and add or remove members and
leaders by the same rules as the app
([Planning hours and teams](./organization-and-team-settings.md#planning-hours-and-teams)).
Only a person changes a team's members. Removing a member takes the same
choice for their open tasks.

Both APIs support `reviewer_id` with the same eligibility rules as
`assignee_id`. Moving a task into `review` sets its remaining hours to the
project's review time unless the request supplies hours ([Review time](./will-it-be-ready-in-time-the-delay-status.md#review-time)). Assignee filters
still match the assigned person while a reviewer owns the work.

## Guides for agents

Give your assistant one of these public guides:

- [llms.txt](https://qivo.io/llms.txt) lists the available documentation.
- [skill.md](https://qivo.io/skill.md) covers finding, changing and verifying
  tasks through MCP, REST or the browser.
- [auth.md](https://qivo.io/auth.md) covers OAuth, personal tokens and agent
  keys, including setup and revocation.

The website footer's **For agents** link opens the operating guide. Reading a
guide does not sign the assistant in or grant access.

## REST API. For scripts and automation

REST requests use an agent's `qva_` key, or a person's `qvt_` personal access
token from **MCP access** to act as that person. Viewer access permits
reading; User and Lead access permit changes, subject to the user's
organization role. Access can come from an individual or team grant. A Viewer
agent's key can only read, so every change returns `403` with
`this agent is a Viewer and can only read`. A personal token can make
changes only if it was created with **Allow changes** and has not expired. A
token without change access gets `this credential can only read` for every
change, and an expired token is refused like a revoked one. Both kinds of
read-only credential can still create, list and remove their own task event
subscriptions.

`GET /v1/me` says who the credential acts as, the organization's calendar
settings and whether the credential can make changes. The API lists projects,
users and teams, manages projects, their sharing and milestones and teams,
and supports task search, creation, updates, moves, subtasks, links, labels,
attachments, task history, workload, deletion, archive/restore, comments,
following and the inbox. With an organization admin's or team leader's token
it also sets a person's plannable weekly hours. It checks field values,
including the 80-character title limit and paired planning dates. An
unreadable task returns 404, as does a nonexistent one. Changes name the agent
or person in the activity feed with **via the REST API** attribution, plus the
key name for an agent key; comments use them as their author.

Project listings show active projects by default. Request `?archived=true`
for archived projects. Task listings omit their tasks unless you name the project;
archived tasks also need an explicit request. Restore a project before
creating tasks in it.

## Automatic task events

Integrations can receive task creation, field changes, deletion and new-comment
events through signed webhooks. Register through REST or an MCP client that
supports the draft MCP Events extension. A regular MCP tool connection does
not receive events automatically.

Subscribe to one task, one exact sub-project or readable projects across the
organization. Parent-project filters are refused. Qivo
checks access when the task changes and again before delivery. Revoking an
owning key or OAuth connection, deactivating its account or removing access
stops further attempts; a request already in flight may still arrive. OAuth
subscriptions belong to the connection, so rotating or expiring its access
token does not cancel them.

REST subscriptions have no expiry by default. MCP subscriptions default to
seven days and can request no expiry. Renew finite subscriptions before expiry
to preserve pending retries. Recreating an expired or deleted subscription
does not restore old events.

An event gets at most eight delivery attempts. After seven days of failures
without an acknowledgment, another failure disables the subscription. An
acknowledgment clears that streak. Renewing an active subscription preserves
its health history and streak. `410 Gone` rejects only that event without
changing subscription health. Qivo does not probe idle receivers.

Use the owning credential to inspect subscriptions through REST, fix a disabled
receiver and register again. Organization administrators can inspect and remove
subscriptions across owners through the organization webhook routes. Receivers
must handle duplicates, out-of-order delivery and events from their own writes.
Qivo does not replay lost events.

There is no webhook settings page. Follow the
[event workflow](https://qivo.io/skill.md#receive-task-events) and
[receiver setup](https://qivo.io/auth.md#configure-a-task-event-receiver).
Automatic agent work depends on the receiving app's support.

## MCP server. For AI assistants

Use **OAuth** when your assistant supports it:

1. Add `https://api.qivo.io/mcp` as a remote MCP server in the assistant.
2. Start the connection and sign in to Qivo.
3. Check the app, organization and requested access. Turn off **Allow changes**
   for read-only access.
4. Choose **Connect** to approve or **Cancel** to refuse.

The default request includes reading, changes and automatic renewal. Approve
only a connection you started in the intended assistant; the client supplies
its displayed app name.

Manage connections in **Settings → Your preferences → MCP access → Connected
apps**. **Delete** asks for confirmation, stops further access and renewal,
and removes that connection. Reconnecting requires new approval.
OAuth clients need authorization code with PKCE and dynamic client
registration. Client ID Metadata Documents and device-code flows are not
supported.

For manual setup, use **Personal access tokens** on the same page. Your client
must accept a custom Authorization header. **New token** asks for a name,
whether to **Allow changes** (on by default) and when the token expires:
**Never**, or **On** a date that is the last day it works. You cannot change
access or expiry after you create the token; create another one instead. Copy
the token when it is created; it cannot be shown again. Qivo also supplies a
`claude mcp add …` command.

The list shows each token's access, expiry and last use. An expired token is
refused like a revoked one and stays in the list until you delete it. Revoke a
token when you no longer need it. Tokens created before you could choose keep
what they had: they never expire, and the list shows their access. The same
token also works with the REST API. Organization admins can instead create an
agent user with its own key
([Agent users](./administration-guard-rails-and-the-demo.md#agent-users)).

MCP tools say who the connection acts as and whether it can make changes;
list teams, projects, users, project users and tasks; read and change tasks
and projects, their sharing and milestones; manage teams and their members;
read, add, edit and delete comments; follow tasks; read and clear your inbox;
delete attachments; read a task's history and the planned hours per person;
and set plannable weekly hours. Request
`archived: true` to list archived projects. Name an archived project to list
its tasks, and restore it before creating new ones.

A personal connection acts with your permissions, restricted further by its
approved OAuth access. A connection approved without **Allow changes** can
still read and manage its own task event subscriptions, but every change is
refused. It belongs to **one organization**. Settings uses your
home account, or your first guest account if you have no home organization.
OAuth displays that organization during approval and keeps it even if your
home account changes. A home-organization connection cannot reach projects
shared with you by another organization. Use the browser for that work, or ask
the other organization's admin for an agent with access.

Task changes appear under your name with **via MCP** attribution. Comments
use your name. Manual tokens and agent keys show creation and last-used dates
and can be revoked individually. OAuth access tokens expire and can renew
when you approve offline access. Deactivating the account stops all its
credentials.
