Connect an assistant through MCP or use REST for scripts. Both act as a Qivo
user with that user's project permissions ([User roles](./administration-guard-rails-and-the-demo.md#four-ways-to-be-a-user)). External connections require
a regular account; the private demo is browser-only.

MCP offers `list_tasks`, `get_task`, `create_task`, `update_task` and
`delete_task`. REST uses `/v1/tasks` and `/v1/tasks/{ref}`. Both work with the
same tasks and permanent `QN-<number>` IDs.

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

REST requests use an agent's `qva_` key. Viewer access permits reading; User
and Lead access permit changes, subject to the agent's organization role.
Access can come from an individual or team grant.

The API lists projects and users and supports task search, creation, updates,
deletion, archive/restore and comments. It checks field values, including the
80-character title limit and paired planning dates. An unreadable task returns
404, as does a nonexistent one. Changes name the agent in the activity feed;
comments use the agent as their author.

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
must accept a custom Authorization header. Copy the token when created; it
cannot be shown again. Qivo also supplies a `claude mcp add …` command. These
tokens do not expire automatically, so revoke them when no longer needed.
Organization admins can instead create an agent user with its own key ([Agent users](./administration-guard-rails-and-the-demo.md#agent-users)).

MCP tools list teams, projects, users, project users and tasks; read and change
tasks; read and add comments; and set plannable weekly hours. Request
`archived: true` to list archived projects. Name an archived project to list
its tasks, and restore it before creating new ones.

A personal connection acts with your permissions, restricted further by its
approved OAuth access. It belongs to **one organization**. Settings uses your
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
